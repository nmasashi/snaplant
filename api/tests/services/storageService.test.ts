import { StorageService } from '../../src/services/storageService';
import { BlobServiceClient, generateBlobSASQueryParameters } from '@azure/storage-blob';
import {
  BlobEntry,
  FakeBlobBackend,
  createFakeBlobServiceClient,
  keyFromUrl
} from '../fakes/blob';

// 外部依存のみモック
// tests/setup.ts のファクトリモックは BlobServiceClient しか定義していないため、
// SAS生成に必要なエクスポートを含めてこのファイルで上書きする
// （不足するとSAS生成が例外になり、本番コードのフォールバックに落ちる）
jest.mock('@azure/storage-blob', () => ({
  BlobServiceClient: { fromConnectionString: jest.fn() },
  BlobSASPermissions: jest.fn().mockImplementation(() => ({})),
  StorageSharedKeyCredential: jest.fn().mockImplementation(() => ({})),
  generateBlobSASQueryParameters: jest.fn()
}));

const MockedBlobServiceClient = BlobServiceClient as jest.MockedClass<typeof BlobServiceClient>;
const mockedGenerateSas = generateBlobSASQueryParameters as jest.MockedFunction<
  typeof generateBlobSASQueryParameters
>;

// SASトークンの固定値（SAS生成が実際に実行されたことを検証するため）
const TEST_SAS_TOKEN = 'sv=2024-01-01&se=2030-01-01T00%3A00%3A00Z&sp=r&sig=testsignature';

// Blob名のUUID部分（正規表現の断片）
const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

// StorageService の振る舞いは、upload / save / updatePlant / plantDetail のハンドラのテストが
// 同じ偽物の Blob Storage を通して見ている。
// ここに残すのは、一時 URL の SAS の引数検証（署名の対象と有効期限。CLAUDE.md の名簿にある、
// 外部との契約を担うもの）と、入口から観測できないとしてメインセッションの判断を待っているものだけ
describe('StorageService', () => {
  let service: StorageService;
  let blobStore: Map<string, BlobEntry>;
  let backend: FakeBlobBackend;

  beforeEach(() => {
    blobStore = new Map();
    backend = { store: blobStore, forcedUploadError: null };

    MockedBlobServiceClient.fromConnectionString = jest.fn().mockReturnValue(createFakeBlobServiceClient(backend));

    // SAS生成を成功させる（jest.fn() のままだとundefinedを返し、
    // .toString() で例外になってSAS生成本体が検証されない）
    mockedGenerateSas.mockReturnValue({
      toString: () => TEST_SAS_TOKEN
    } as any);

    // 環境変数設定
    process.env.STORAGE_CONNECTION_STRING = 'DefaultEndpointsProtocol=https;AccountName=test;AccountKey=testkey==;EndpointSuffix=core.windows.net';
    process.env.STORAGE_CONTAINER_NAME = 'test-images';
    process.env.TEMP_STORAGE_CONTAINER_NAME = 'test-temp';

    service = new StorageService();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
    delete process.env.STORAGE_CONNECTION_STRING;
    delete process.env.STORAGE_CONTAINER_NAME;
    delete process.env.TEMP_STORAGE_CONTAINER_NAME;
  });

  describe('uploadImageToTemp', () => {
    // JPEG / PNG の拡張子は upload.test が永続 URL で、AI 識別サービスへ渡す SAS 付き URL も upload.test が見ている。
    // 3列目は Blob 名に当てる正規表現の断片で、テスト名には2列目を使う
    it.each([
      ['application/octet-stream', 'なし', '']
    ])(
      'Content-Typeが%sの画像は、一時コンテナにBlob名の拡張子が「%s」でアップロードされ、SASトークン付きURLが返る',
      async (contentType, _extensionLabel, extensionPattern) => {
        const imageBuffer = Buffer.from('temp image data');

        const result = await service.uploadImageToTemp(imageBuffer, contentType);

        // 一時保存はSASトークンを付けたURLを返す（非公開コンテナのため、
        // 生のURLではAzure OpenAIが画像を取得できない）
        const [blobUrl, sasToken] = result.split('?');
        expect(blobUrl).toMatch(
          new RegExp(`^https://test\\.blob\\.core\\.windows\\.net/test-temp/${UUID_PATTERN}${extensionPattern}$`)
        );
        expect(sasToken).toBe(TEST_SAS_TOKEN);
      }
    );

    it('SASの署名対象は、一時コンテナと、アップロードしたBlobになる', async () => {
      const imageBuffer = Buffer.from('temp image data');

      const result = await service.uploadImageToTemp(imageBuffer, 'image/jpeg');

      // SASトークンは署名済みの不透明な文字列で、テストから署名の対象を復号できない。
      // 一方、どのコンテナのどのBlobを読めるかはAzure Storageが検証する外部との契約であり、
      // 対象を取り違える退行は検出しなければならない。
      // 引数の検証は原則3の例外として許容する（他に検証手段がないため）。
      // 権限は blobSas.ts が決めていて、photos.test.ts が実SDKのトークンで見ている。
      // 有効期限は下の「発行から15分で切れる」が見る
      const [options] = mockedGenerateSas.mock.calls[0];
      expect(options.containerName).toBe('test-temp');
      expect(options.blobName).toBe(keyFromUrl(result).split('/').pop());
    });

    it('一時URLの読み取り許可は発行から15分で切れる', async () => {
      const imageBuffer = Buffer.from('temp image data');
      // 時刻だけを固定する。他のタイマーまで偽物にすると偽のBlobクライアントのawaitが止まりうる
      jest.useFakeTimers({
        now: new Date('2026-10-11T00:00:00.000Z'),
        doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'setTimeout', 'setInterval']
      });

      await service.uploadImageToTemp(imageBuffer, 'image/jpeg');

      // 有効期限もSASトークンの中に署名されていて復号できないため、
      // 署名に渡した引数で確かめる（原則3の例外。上のテストと同じ理由）。
      // 時刻を固定してあるので、期待値は発行時刻の15分後をリテラルで書ける。
      // この期限は StorageService の判断で、upload の応答には一時URLが出ないため上位から見えない
      const [options] = mockedGenerateSas.mock.calls[0];
      expect(options.expiresOn).toEqual(new Date('2026-10-11T00:15:00.000Z'));
      // 開始時刻は渡さない（トークンに st が付かず、発行した時点から有効になる）。
      // 開始時刻を現在時刻で埋めると、サーバ間の時計のずれで発行直後の読み取りが403になりうる。
      // これもトークンに署名されていて復号できないので、引数で確かめる
      expect(options.startsOn).toBeUndefined();
    });
  });

  describe('moveFromTempToPermanent', () => {
    it('一時ファイルにcontent-typeが設定されていない場合、image/jpegとして永続保存される', async () => {
      const fileName = '22222222-2222-2222-2222-222222222222.jpg';
      blobStore.set(`test-temp/${fileName}`, {
        content: Buffer.from('image data')
        // contentType を設定しない（Blob側が返さないケースを模す）
      });
      const tempUrl = `https://test.blob.core.windows.net/test-temp/${fileName}`;

      await service.moveFromTempToPermanent(tempUrl);

      expect(blobStore.get(`test-images/${fileName}`)?.contentType).toBe('image/jpeg');
    });
  });

  describe('deleteImage', () => {
    // 入口へ寄せられずに残っている（メインセッションの判断待ち）。実 SDK（BlobServiceClient.fromConnectionString）は
    // EndpointSuffix の無い接続文字列を "Invalid EndpointSuffix in the provided Connection String" で拒否するので、
    // SDK を偽物にしない入口（save）では StorageService を作る時点で 500 になり、この既定値の経路に届かない。
    // SDK を偽物にした入口なら通るが、それは実 SDK が受け付けない入力を偽物が受け付けているだけになる
    it('接続文字列にEndpointSuffixが無い場合、既定値core.windows.netのホストとして扱う', async () => {
      // EndpointSuffixを省いた接続文字列（Azure公式サンプルや古い構成であり得る形）。
      // resolveBlobEndpointHost()の既定値が壊れると、自アカウントのURLのホストが
      // 期待値と一致しなくなり、保存時のバリデーションも旧画像削除も常に拒否される
      process.env.STORAGE_CONNECTION_STRING =
        'DefaultEndpointsProtocol=https;AccountName=test;AccountKey=testkey==';
      const accountService = new StorageService();

      const fileName = '99999999-9999-9999-9999-999999999999.jpg';
      blobStore.set(`test-images/${fileName}`, { content: Buffer.from('data'), contentType: 'image/jpeg' });
      const imageUrl = `https://test.blob.core.windows.net/test-images/${fileName}`;

      const result = await accountService.deleteImage(imageUrl);

      expect(result).toBe(true);
      expect(blobStore.has(`test-images/${fileName}`)).toBe(false);
    });

    it('存在しない画像を削除した場合は成功として扱う', async () => {
      const imageUrl = 'https://test.blob.core.windows.net/test-images/00000000-0000-0000-0000-000000000000.jpg';

      const result = await service.deleteImage(imageUrl);

      expect(result).toBe(true);
    });
  });
});
