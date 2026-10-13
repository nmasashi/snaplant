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

// StorageService の振る舞いは、upload / save / updatePlant / plantDetail のハンドラのテスト（入口）が
// 同じ偽物の Blob Storage を通して見ている。
// ここに残すのは、一時 URL の SAS の引数検証（署名の対象と有効期限）だけ。CLAUDE.md の名簿にある、
// 外部との契約を担うもの（SAS トークンは署名済みで復号できず、一時 URL は応答に出ない）
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
});
