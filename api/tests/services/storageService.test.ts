import { StorageService } from '../../src/services/storageService';
import { UpstreamError } from '../../src/utils/errors';
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

// StorageService の大半は、アップロード・移動・削除の正常系を upload / updatePlant / plantDetail の
// ハンドラのテストが同じ偽物の Blob Storage を通して見ている。
// ここに残すのは、ハンドラのテストからは見えないものだけ:
// 一時 URL の期限、後片付け、既定値、URL の検証（入口と出口の二層で守る境界）、
// ストリームの配線、Blob 名の一意性
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

  describe('constructor', () => {
    it('接続文字列にBlobEndpointが指定されている場合、例外をスローする', () => {
      // BlobEndpoint=がある接続文字列は、SDK(BlobServiceClient.fromConnectionString())
      // がそのエンドポイントを使う一方、resolveBlobEndpointHost()はAccountNameと
      // EndpointSuffixから自分でホストを組み立てるため両者が食い違う。
      // 食い違うと自分が生成したURLを自分のisValidImagePath()/deleteImage()が
      // 拒否するようになり、保存時400・旧画像の孤児化という静かな誤動作になる。
      // 現時点では未対応のため、コンストラクタで例外を投げて大きな失敗に変える
      process.env.STORAGE_CONNECTION_STRING =
        'DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=testkey==;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;';

      expect(() => new StorageService()).toThrow(/^BlobEndpointを明示した接続文字列は未対応です$/);
    });
  });

  describe('uploadImageToTemp', () => {
    // 3行とも同じ手順で、Content-Type と Blob 名の拡張子の対応だけが違う。
    // 大文字の Content-Type は upload.test が見ている。
    // 3列目は Blob 名に当てる正規表現の断片で、テスト名には2列目を使う
    it.each([
      ['image/jpeg', '.jpg', '\\.jpg'],
      ['image/png', '.png', '\\.png'],
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

    // ハンドラのテストは1回しかアップロードしないので、毎回違うBlob名になること
    // （固定だと別の利用者のアップロードを上書きする）はここでだけ見られる
    it('2回アップロードすると異なるURLが返る', async () => {
      const imageBuffer = Buffer.from('temp image data');

      const result1 = await service.uploadImageToTemp(imageBuffer, 'image/jpeg');
      const result2 = await service.uploadImageToTemp(imageBuffer, 'image/jpeg');

      expect(result1).not.toBe(result2);
    });

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

    it('SAS生成に失敗した場合は、エラーをスローし、一時ファイルを残さない', async () => {
      const imageBuffer = Buffer.from('temp image data');

      mockedGenerateSas.mockImplementation(() => {
        throw new Error('credential unavailable');
      });

      // 生のURLを返すと静かに403になるため、失敗は伝播させる。
      // エラーの文言は契約外なので固定しない
      await expect(service.uploadImageToTemp(imageBuffer, 'image/jpeg'))
        .rejects.toThrow();

      // アップロードはSAS生成より先に完了しているため、
      // 後片付けしないと孤児Blobが残る（一時コンテナにライフサイクル
      // ポリシーがないため永久に残る）
      expect(blobStore.size).toBe(0);
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

    it('一時ファイルのダウンロード中にストリームがエラーを発火した場合、エラーをスローする', async () => {
      // 'error' を reject につなぐ配線が無いと、例外ではなく応答が返らなくなる
      // （このテストはタイムアウトで失敗する）。エラーの文言は契約外なので、
      // ストリームの原因が引き継がれていることだけを見る
      const fileName = '55555555-5555-5555-5555-555555555555.jpg';
      blobStore.set(`test-temp/${fileName}`, {
        content: Buffer.from('image data'),
        contentType: 'image/jpeg',
        streamErrorWith: new Error('stream read error')
      });
      const tempUrl = `https://test.blob.core.windows.net/test-temp/${fileName}`;

      await expect(service.moveFromTempToPermanent(tempUrl))
        .rejects.toMatchObject({ cause: { message: 'stream read error' } });
    });
  });

  describe('deleteImage', () => {
    it('ストレージアカウント名に一時コンテナ名が含まれる場合でも永続コンテナの画像を削除できる', async () => {
      // 自ストレージアカウント名自体が一時コンテナ名 "test-temp" を含む
      // ("test-temp-account") ケース。ホスト検証はアカウント名が自アカウントと
      // 一致するかで判定するので、このURLは正当に自アカウントのものとして通過する。
      // その上でコンテナ判定が文字列包含（imageUrl.includes(tempContainerName)）
      // だと、ホスト名に含まれる "test-temp" にひっかかり、パス上は永続コンテナ
      // (test-images) の画像でも一時コンテナ側だと誤認してしまう
      process.env.STORAGE_CONNECTION_STRING =
        'DefaultEndpointsProtocol=https;AccountName=test-temp-account;AccountKey=testkey==;EndpointSuffix=core.windows.net';
      const accountService = new StorageService();

      const fileName = '33333333-3333-3333-3333-333333333333.jpg';
      blobStore.set(`test-images/${fileName}`, { content: Buffer.from('data'), contentType: 'image/jpeg' });
      const imageUrl = `https://test-temp-account.blob.core.windows.net/test-images/${fileName}`;

      const result = await accountService.deleteImage(imageUrl);

      expect(result).toBe(true);
      expect(blobStore.has(`test-images/${fileName}`)).toBe(false);
    });

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

    it('一時コンテナ名で始まるだけの別コンテナなど、未知のコンテナを指すURLは、どちらのコンテナからも削除しない', async () => {
      const fileName = '44444444-4444-4444-4444-444444444444.jpg';
      // コンテナ名が一時コンテナ名 "test-temp" で始まるだけの別コンテナ
      // "test-temp-archive"（偶然の命名一致）。プレフィックス一致で判定すると
      // 一時コンテナと誤認する。永続・一時のどちらでもない未知のコンテナ名でもあり、
      // 未知のコンテナを永続側へフォールバックさせる実装でも、下の永続コンテナの
      // 同名Blobが巻き込まれて消える
      blobStore.set(`test-temp-archive/${fileName}`, { content: Buffer.from('archive data'), contentType: 'image/jpeg' });
      blobStore.set(`test-images/${fileName}`, { content: Buffer.from('data'), contentType: 'image/jpeg' });
      const imageUrl = `https://test.blob.core.windows.net/test-temp-archive/${fileName}`;

      const result = await service.deleteImage(imageUrl);

      expect(result).toBe(false);
      expect(blobStore.has(`test-temp-archive/${fileName}`)).toBe(true);
      expect(blobStore.has(`test-images/${fileName}`)).toBe(true);
    });

    it('コンテナ名の直後に余分なパスセグメントを挟んだURLを渡した場合、無関係な同名ファイルの画像は削除されない', async () => {
      const fileName = '77777777-7777-7777-7777-777777777777.jpg';
      // 永続コンテナに実在する、このテストが守る対象のBlob。
      // URL解釈を誤るとこれが削除対象として一致してしまう
      blobStore.set(`test-images/${fileName}`, { content: Buffer.from('data'), contentType: 'image/jpeg' });
      // コンテナ名(test-images)とファイル名の間に余分なセグメント "x" を挟んだURL。
      // extractContainerNameFromUrl() は最初のセグメントだけを見て、
      // extractFileNameFromUrl() は最後のセグメントだけを見るため、間の "x" が
      // 両方から無視されると「test-images/<fileName>」という無関係な実在Blobを
      // 指してしまう（本来この階層のBlob名は "x/<fileName>" であり存在しないはず）
      const imageUrl = `https://test.blob.core.windows.net/test-images/x/${fileName}`;

      await service.deleteImage(imageUrl);

      expect(blobStore.has(`test-images/${fileName}`)).toBe(true);
    });

    it('自ストレージアカウント以外のホストを指すURLを渡した場合、falseを返し永続コンテナの画像は削除されない', async () => {
      const fileName = '66666666-6666-6666-6666-666666666666.jpg';
      blobStore.set(`test-images/${fileName}`, { content: Buffer.from('data'), contentType: 'image/jpeg' });
      // 攻撃経路: deleteImage()がホストを見ずコンテナ名とファイル名だけで削除先を決めると、
      // 外部ホストのURLを imagePath に保存してから更新（updatePlant）で旧画像の削除を
      // 発火させるだけで、ファイル名さえ一致すれば自アカウントの永続コンテナにある
      // 「別レコードの」Blobを消せてしまう。入口（isValidImagePath）と出口（ここ）の二層で守っている。
      // ホストが自ストレージアカウント（test.blob.core.windows.net）ではないURLで、
      // コンテナ名はあえて永続コンテナ（test-images）と一致させている。
      // 未知のコンテナ名（例: foo）のままだとコンテナ名の不一致だけで
      // falseになり、ホスト検証を削除してもこのテストは落ちない
      // （何を検証しているか誤認させる）。コンテナ名を一致させることで
      // ホスト不一致が唯一の棄却理由になる
      const imageUrl = `https://example.com/test-images/${fileName}`;

      const result = await service.deleteImage(imageUrl);

      expect(result).toBe(false);
      expect(blobStore.has(`test-images/${fileName}`)).toBe(true);
    });

    it('存在しない画像を削除した場合は成功として扱う', async () => {
      const imageUrl = 'https://test.blob.core.windows.net/test-images/00000000-0000-0000-0000-000000000000.jpg';

      const result = await service.deleteImage(imageUrl);

      expect(result).toBe(true);
    });

    it('削除エラーの場合、エラーをスローする', async () => {
      // 呼び出し側（旧画像の削除は握りつぶし、upload の一時ファイルの後片付けは 502 にする）が
      // 失敗を例外として受け取れることを守る。エラーの文言は契約外なので固定しない
      const fileName = 'broken.jpg';
      blobStore.set(`test-images/${fileName}`, {
        content: Buffer.from('data'),
        failWith: new Error('Delete failed')
      });
      const imageUrl = `https://test.blob.core.windows.net/test-images/${fileName}`;

      await expect(service.deleteImage(imageUrl))
        .rejects.toBeInstanceOf(UpstreamError);
    });
  });

  describe('isValidImagePath - 静的メソッド', () => {
    // beforeEach で設定した環境変数（ホスト test.blob.core.windows.net、
    // 永続コンテナ test-images）を基準に、自アカウントの永続コンテナを指す
    // URLだけを受理することを検証する。
    //
    // 拒否の各行は入力の種類が違い、常に一緒に落ちる組はない。
    // 4つの条件（スキーム・ホスト・2セグメント・生の文字列の完全一致）は
    // 独立に効くようにしてあり、どれか1つが緩んでも他が残るのが設計
    // （CLAUDE.md「バリデーション定数」）。行の並びは条件の順

    it('自アカウントの永続コンテナを指すURLの場合、trueを返す', () => {
      expect(StorageService.isValidImagePath(
        'https://test.blob.core.windows.net/test-images/123e4567-e89b-12d3-a456-426614174000.jpg'
      )).toBe(true);
    });

    it.each([
      // コンテナ名はあえて永続コンテナ（test-images）と一致させている。
      // 一致しない値だとコンテナ名の不一致だけでfalseになり、
      // ホスト検証を削除してもこのテストは落ちなくなる
      ['自アカウント以外のホストを指す', 'https://example.com/test-images/123e4567-e89b-12d3-a456-426614174000.jpg'],
      // isValidImagePath() は一時コンテナ名を一切参照せず、永続コンテナ名と一致するかしか見ない。
      // 値そのものに意味はなく、永続コンテナ以外はすべて拒否するという性質を守る
      ['永続コンテナ以外のコンテナ名を指す', 'https://test.blob.core.windows.net/some-other-container/123e4567-e89b-12d3-a456-426614174000.jpg'],
      // アップロードAPIが返す形は常に「/コンテナ名/Blob名」の2セグメント。
      // 余分なセグメント（x）を挟むと存在しないBlobを指す壊れた参照になる
      ['永続コンテナ名の後に余分なセグメントを挟む', 'https://test.blob.core.windows.net/test-images/x/123e4567-e89b-12d3-a456-426614174000.jpg'],
      // 末尾がスラッシュでBlob名のセグメントが空。空文字列のBlob名を許すと、Blobを指さないURLが保存されてしまう
      ['コンテナまでしか指していない', 'https://test.blob.core.windows.net/test-images/'],
      // ホストと永続コンテナの形は正当だが、スキームがhttpsでない
      ['スキームがhttpsでない', 'http://test.blob.core.windows.net/test-images/123e4567-e89b-12d3-a456-426614174000.jpg'],
      // 以下の4つは new URL() のパース結果では正当なURLと区別できず（クエリ・フラグメント・認証情報は
      // pathname に出ず、ホストの大文字小文字と先頭の空白は正規化される）、生の文字列同士の
      // 完全一致だけが検出する。保存されるのは生の文字列なので、通すと save の重複チェック
      // （文字列の完全一致）を素通りでき、updatePlant の旧画像削除の判定（文字列比較）も誤作動する
      ['クエリ文字列が付いている', 'https://test.blob.core.windows.net/test-images/123e4567-e89b-12d3-a456-426614174000.jpg?x=1'],
      ['フラグメントが付いている', 'https://test.blob.core.windows.net/test-images/123e4567-e89b-12d3-a456-426614174000.jpg#f'],
      // 認証情報は、そのまま保存されると資格情報が平文でデータベースに残る点でも害がある
      ['認証情報が付いている', 'https://u:p@test.blob.core.windows.net/test-images/123e4567-e89b-12d3-a456-426614174000.jpg'],
      ['ホストが大文字', 'https://TEST.blob.core.windows.net/test-images/123e4567-e89b-12d3-a456-426614174000.jpg'],
      ['先頭に空白がある', ' https://test.blob.core.windows.net/test-images/123e4567-e89b-12d3-a456-426614174000.jpg']
    ])('%sURLの場合、falseを返す', (_name, imagePath) => {
      expect(StorageService.isValidImagePath(imagePath)).toBe(false);
    });
  });
});
