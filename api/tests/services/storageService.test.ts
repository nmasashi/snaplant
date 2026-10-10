import { StorageService } from '../../src/services/storageService';
import { BlobServiceClient, BlockBlobClient, generateBlobSASQueryParameters } from '@azure/storage-blob';
import { Readable } from 'stream';

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

/**
 * 偽物のBlobバックエンド。
 *
 * コンテナ名とBlob名のキーごとに内容を Map に保持する。これにより
 * 「移動先・削除先のコンテナを取り違える」不具合を検出できる
 * （単一の共有モックだとどの引数で呼ばれても同じ値を返すため、
 * 宛先の取り違えがテストを通過してしまう）。
 */
interface BlobEntry {
  content: Buffer;
  contentType?: string;
  failWith?: Error;
  /**
   * download() 自体は成功させるが、返したストリームを読み取っている最中に
   * 'error' を発火させる。failWith（呼び出し自体の失敗）とは別経路で、
   * streamToBuffer() の 'error' リスナーを検証するためのもの
   */
  streamErrorWith?: Error;
}

interface FakeBlobBackend {
  store: Map<string, BlobEntry>;
  forcedUploadError: Error | null;
}

function notFoundError(): any {
  const err: any = new Error('BlobNotFound');
  err.statusCode = 404;
  return err;
}

function createFakeBlockBlobClient(backend: FakeBlobBackend, containerName: string, blobName: string): BlockBlobClient {
  const key = `${containerName}/${blobName}`;
  const url = `https://test.blob.core.windows.net/${key}`;

  return {
    url,
    upload: async (content: Buffer, _length: number, options?: any) => {
      if (backend.forcedUploadError) {
        throw backend.forcedUploadError;
      }
      backend.store.set(key, {
        content,
        contentType: options?.blobHTTPHeaders?.blobContentType
      });
      return {};
    },
    download: async () => {
      const entry = backend.store.get(key);
      if (!entry) throw notFoundError();
      if (entry.failWith) throw entry.failWith;
      const stream = new Readable({
        read() {
          if (entry.streamErrorWith) {
            this.emit('error', entry.streamErrorWith);
            return;
          }
          this.push(entry.content);
          this.push(null);
        }
      });
      return { readableStreamBody: stream };
    },
    getProperties: async () => {
      const entry = backend.store.get(key);
      if (!entry) throw notFoundError();
      if (entry.failWith) throw entry.failWith;
      return { contentType: entry.contentType };
    },
    delete: async () => {
      const entry = backend.store.get(key);
      if (!entry) throw notFoundError();
      if (entry.failWith) throw entry.failWith;
      backend.store.delete(key);
      return {};
    }
  } as unknown as BlockBlobClient;
}

function createFakeBlobServiceClient(backend: FakeBlobBackend): BlobServiceClient {
  return {
    getContainerClient: (containerName: string) => ({
      getBlockBlobClient: (blobName: string) => createFakeBlockBlobClient(backend, containerName, blobName)
    })
  } as unknown as BlobServiceClient;
}

/** 返ってきたURL（SASクエリ付きの場合あり）から、偽物バックエンドのMapキーを導く */
function keyFromUrl(url: string): string {
  return url.replace('https://test.blob.core.windows.net/', '').split('?')[0];
}

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

  describe('uploadImage', () => {
    it('アップロードした画像のURLが画像用コンテナのユニークなファイル名を指す', async () => {
      const imageBuffer = Buffer.from('test image data');

      const result = await service.uploadImage(imageBuffer, 'image/jpeg');

      expect(result).toMatch(/^https:\/\/test\.blob\.core\.windows\.net\/test-images\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/);
    });

    it('Blob名の拡張子はContent-Typeから決まる', async () => {
      const imageBuffer = Buffer.from('test image data');

      const result = await service.uploadImage(imageBuffer, 'image/png');

      expect(result).toMatch(/^https:\/\/test\.blob\.core\.windows\.net\/test-images\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/);
    });

    it('Content-Typeが大文字でも拡張子が付く', async () => {
      const imageBuffer = Buffer.from('test image data');

      // isValidImageContentType は大文字を受け付けるため、
      // 拡張子の引き当ても同じ正規化をしないと拡張子なしのBlob名になる
      const result = await service.uploadImage(imageBuffer, 'IMAGE/PNG');

      expect(result).toMatch(/^https:\/\/test\.blob\.core\.windows\.net\/test-images\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/);
    });

    it('サポート外のContent-Typeの場合は拡張子なしのBlob名になる', async () => {
      const imageBuffer = Buffer.from('test image data');

      const result = await service.uploadImage(imageBuffer, 'application/octet-stream');

      expect(result).toMatch(/^https:\/\/test\.blob\.core\.windows\.net\/test-images\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('アップロードした内容とcontent-typeが保存される', async () => {
      const imageBuffer = Buffer.from('test image data');

      const result = await service.uploadImage(imageBuffer, 'image/jpeg');

      expect(blobStore.get(keyFromUrl(result))).toEqual({
        content: imageBuffer,
        contentType: 'image/jpeg'
      });
    });

    it('2回アップロードすると異なるURLが返る', async () => {
      const imageBuffer = Buffer.from('test image data');

      const result1 = await service.uploadImage(imageBuffer, 'image/jpeg');
      const result2 = await service.uploadImage(imageBuffer, 'image/jpeg');

      expect(result1).not.toBe(result2);
    });

    it('アップロードエラーの場合、エラーをスローする', async () => {
      const imageBuffer = Buffer.from('test image data');
      backend.forcedUploadError = new Error('Upload failed');

      await expect(service.uploadImage(imageBuffer, 'image/jpeg'))
        .rejects.toThrow(/^画像のアップロードに失敗しました: Upload failed$/);
    });
  });

  describe('uploadImageToTemp', () => {
    it('一時コンテナに画像をアップロードできる', async () => {
      const imageBuffer = Buffer.from('temp image data');

      const result = await service.uploadImageToTemp(imageBuffer, 'image/jpeg');

      // 一時保存はSASトークン付きURLを返す（非公開コンテナのため、
      // 生のURLではAzure OpenAIが画像を取得できない）
      const match = result.match(/^(https:\/\/test\.blob\.core\.windows\.net\/test-temp\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg)\?(.+)$/);
      expect(match).not.toBeNull();
      expect(match![2]).toBe(TEST_SAS_TOKEN);
    });

    it('アップロードした内容とcontent-typeが一時コンテナに保存される', async () => {
      const imageBuffer = Buffer.from('temp image data');

      const result = await service.uploadImageToTemp(imageBuffer, 'image/jpeg');

      expect(blobStore.get(keyFromUrl(result))).toEqual({
        content: imageBuffer,
        contentType: 'image/jpeg'
      });
    });

    it('読み取り専用のSAS権限で署名する', async () => {
      const imageBuffer = Buffer.from('temp image data');

      await service.uploadImageToTemp(imageBuffer, 'image/jpeg');

      // SASトークンは署名済みの不透明な文字列で、テストから権限や有効期限を
      // 復号できない。一方この2つはAzure Storageが検証する外部との契約であり、
      // read のはずが write になる退行は検出しなければならない。
      // 引数の検証は原則3の例外として許容する（他に検証手段がないため）
      const [options] = mockedGenerateSas.mock.calls[0];
      expect(options.containerName).toBe('test-temp');
      expect(options.permissions).toMatchObject({ read: true });
      expect(options.expiresOn!.getTime()).toBeGreaterThan(Date.now());
    });

    it('SAS生成に失敗した場合はエラーをスローする', async () => {
      const imageBuffer = Buffer.from('temp image data');

      mockedGenerateSas.mockImplementation(() => {
        throw new Error('credential unavailable');
      });

      // 生のURLを返すと静かに403になるため、失敗は伝播させる
      await expect(service.uploadImageToTemp(imageBuffer, 'image/jpeg'))
        .rejects.toThrow(
          /^一時画像のアップロードに失敗しました: SAS URLの生成に失敗しました: credential unavailable$/
        );
    });

    it('SAS生成に失敗した場合は一時ファイルを残さない', async () => {
      const imageBuffer = Buffer.from('temp image data');

      mockedGenerateSas.mockImplementation(() => {
        throw new Error('credential unavailable');
      });

      await expect(service.uploadImageToTemp(imageBuffer, 'image/jpeg'))
        .rejects.toThrow();

      // アップロードはSAS生成より先に完了しているため、
      // 後片付けしないと孤児Blobが残る（一時コンテナにライフサイクル
      // ポリシーがないため永久に残る）
      expect(blobStore.size).toBe(0);
    });
  });

  describe('moveFromTempToPermanent', () => {
    it('一時ファイルを永続保存に移動できる', async () => {
      const fileName = '12345678-1234-1234-1234-123456789012.jpg';
      const originalContent = Buffer.from('image data');
      blobStore.set(`test-temp/${fileName}`, {
        content: originalContent,
        contentType: 'image/jpeg'
      });
      const tempUrl = `https://test.blob.core.windows.net/test-temp/${fileName}`;

      const result = await service.moveFromTempToPermanent(tempUrl);

      // 移動後は永続コンテナに中身がコピーされ、一時コンテナからは消えている
      expect(result).toBe(`https://test.blob.core.windows.net/test-images/${fileName}`);
      expect(blobStore.get(`test-images/${fileName}`)).toEqual({
        content: originalContent,
        contentType: 'image/jpeg'
      });
      expect(blobStore.has(`test-temp/${fileName}`)).toBe(false);
    });

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

    it('無効な一時URL形式の場合、エラーをスローする', async () => {
      await expect(service.moveFromTempToPermanent('invalid-url'))
        .rejects.toThrow(/^画像の永続保存への移動に失敗しました: 一時画像URLからファイル名を抽出できません$/);
    });

    it('一時ファイルが存在しない場合、エラーをスローする', async () => {
      const tempUrl = 'https://test.blob.core.windows.net/test-temp/99999999-9999-9999-9999-999999999999.jpg';

      await expect(service.moveFromTempToPermanent(tempUrl))
        .rejects.toThrow(/^画像の永続保存への移動に失敗しました: BlobNotFound$/);
    });

    it('一時ファイルのダウンロード中にストリームがエラーを発火した場合、エラーをスローする', async () => {
      const fileName = '55555555-5555-5555-5555-555555555555.jpg';
      blobStore.set(`test-temp/${fileName}`, {
        content: Buffer.from('image data'),
        contentType: 'image/jpeg',
        streamErrorWith: new Error('stream read error')
      });
      const tempUrl = `https://test.blob.core.windows.net/test-temp/${fileName}`;

      await expect(service.moveFromTempToPermanent(tempUrl))
        .rejects.toThrow(/^画像の永続保存への移動に失敗しました: stream read error$/);
    });
  });

  describe('deleteImage', () => {
    it('画像を正常に削除できる', async () => {
      const fileName = '12345678-1234-1234-1234-123456789012.jpg';
      blobStore.set(`test-images/${fileName}`, { content: Buffer.from('data'), contentType: 'image/jpeg' });
      const imageUrl = `https://test.blob.core.windows.net/test-images/${fileName}`;

      const result = await service.deleteImage(imageUrl);

      expect(result).toBe(true);
      expect(blobStore.has(`test-images/${fileName}`)).toBe(false);
    });

    it('一時コンテナの画像も削除できる', async () => {
      const fileName = '12345678-1234-1234-1234-123456789012.jpg';
      blobStore.set(`test-temp/${fileName}`, { content: Buffer.from('data'), contentType: 'image/jpeg' });
      // 同名ファイルが永続コンテナ側にもある状態を作り、宛先を取り違えて
      // 永続側を削除していないことも合わせて確認する
      blobStore.set(`test-images/${fileName}`, { content: Buffer.from('other data'), contentType: 'image/jpeg' });
      const tempImageUrl = `https://test.blob.core.windows.net/test-temp/${fileName}`;

      const result = await service.deleteImage(tempImageUrl);

      expect(result).toBe(true);
      expect(blobStore.has(`test-temp/${fileName}`)).toBe(false);
      expect(blobStore.has(`test-images/${fileName}`)).toBe(true);
    });

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

    it('一時コンテナ名で始まるだけの別コンテナを指すURLは、どちらのコンテナからも削除しない', async () => {
      const fileName = '44444444-4444-4444-4444-444444444444.jpg';
      // コンテナ名が一時コンテナ名 "test-temp" で始まるだけの別コンテナ
      // "test-temp-archive"（偶然の命名一致）。プレフィックス一致で判定すると
      // 一時コンテナと誤認する
      blobStore.set(`test-temp-archive/${fileName}`, { content: Buffer.from('archive data'), contentType: 'image/jpeg' });
      // 永続コンテナ側の同名ファイル。未知のコンテナを永続側へフォールバック
      // させる実装だと、これが巻き込まれて消える
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
      // ホストが自ストレージアカウント（test.blob.core.windows.net）ではないURL。
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

    it('永続コンテナでも一時コンテナでもない未知のコンテナ名を指すURLを渡した場合、falseを返し永続コンテナの同名画像は削除されない', async () => {
      const fileName = '88888888-8888-8888-8888-888888888888.jpg';
      blobStore.set(`test-images/${fileName}`, { content: Buffer.from('data'), contentType: 'image/jpeg' });
      // ホストは自ストレージアカウント（test.blob.core.windows.net）だが、
      // コンテナ名"foo"は永続(test-images)・一時(test-temp)のどちらでもない。
      // 現状の実装はコンテナ名が一時コンテナ名と一致しない場合すべて永続コンテナに
      // フォールバックするため、このURLでも永続コンテナの同名Blobが削除されてしまう
      const imageUrl = `https://test.blob.core.windows.net/foo/${fileName}`;

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
      const fileName = 'broken.jpg';
      blobStore.set(`test-images/${fileName}`, {
        content: Buffer.from('data'),
        failWith: new Error('Delete failed')
      });
      const imageUrl = `https://test.blob.core.windows.net/test-images/${fileName}`;

      await expect(service.deleteImage(imageUrl))
        .rejects.toThrow(/^画像の削除に失敗しました: Delete failed$/);
    });

    it('無効なURL形式の場合、falseを返す', async () => {
      const result = await service.deleteImage('invalid-url');
      expect(result).toBe(false);
    });
  });

  describe('isValidImageContentType - 静的メソッド', () => {
    it('有効な画像タイプの場合、trueを返す', () => {
      expect(StorageService.isValidImageContentType('image/jpeg')).toBe(true);
      expect(StorageService.isValidImageContentType('image/jpg')).toBe(true);
      expect(StorageService.isValidImageContentType('image/png')).toBe(true);
      expect(StorageService.isValidImageContentType('image/webp')).toBe(true);
      expect(StorageService.isValidImageContentType('image/gif')).toBe(true);
    });

    it('大文字で指定した場合も有効と判定される', () => {
      expect(StorageService.isValidImageContentType('IMAGE/JPEG')).toBe(true);
    });

    it('無効な画像タイプの場合、falseを返す', () => {
      expect(StorageService.isValidImageContentType('text/plain')).toBe(false);
      expect(StorageService.isValidImageContentType('application/json')).toBe(false);
      expect(StorageService.isValidImageContentType('video/mp4')).toBe(false);
      expect(StorageService.isValidImageContentType('')).toBe(false);
    });
  });

  describe('isValidFileSize - 静的メソッド', () => {
    it('有効なファイルサイズの場合、trueを返す', () => {
      expect(StorageService.isValidFileSize(1024)).toBe(true);        // 1KB
      expect(StorageService.isValidFileSize(1024 * 1024)).toBe(true); // 1MB
      expect(StorageService.isValidFileSize(5 * 1024 * 1024)).toBe(true); // 5MB
      expect(StorageService.isValidFileSize(10485760)).toBe(true);    // 上限ちょうど
    });

    it('無効なファイルサイズの場合、falseを返す', () => {
      expect(StorageService.isValidFileSize(0)).toBe(false);
      expect(StorageService.isValidFileSize(-1)).toBe(false);
      expect(StorageService.isValidFileSize(10485761)).toBe(false); // 上限を1バイト超過
    });
  });

  describe('isValidImagePath - 静的メソッド', () => {
    // beforeEach で設定した環境変数（ホスト test.blob.core.windows.net、
    // 永続コンテナ test-images）を基準に、自アカウントの永続コンテナを指す
    // URLだけを受理することを検証する

    it('自アカウント以外のホストを指すURLの場合、falseを返す', () => {
      // コンテナ名はあえて永続コンテナ（test-images）と一致させている。
      // 一致しない値だとコンテナ名の不一致だけでfalseになり、
      // ホスト検証を削除してもこのテストは落ちなくなる
      expect(StorageService.isValidImagePath(
        'https://example.com/test-images/123e4567-e89b-12d3-a456-426614174000.jpg'
      )).toBe(false);
    });

    it('永続コンテナ以外のコンテナ名を指すURLの場合、falseを返す', () => {
      // ここで使う "some-other-container" という値そのものに意味はない。
      // isValidImagePath() は一時コンテナ名を一切参照しておらず、
      // 永続コンテナ名と一致するかしか見ていない。このテストが守っているのは
      // 「永続コンテナ以外のコンテナ名はすべて拒否する」という性質であり、
      // 一時コンテナ固有のルールがあるわけではない
      expect(StorageService.isValidImagePath(
        'https://test.blob.core.windows.net/some-other-container/123e4567-e89b-12d3-a456-426614174000.jpg'
      )).toBe(false);
    });

    it('永続コンテナ名の後に余分なセグメントを挟むURLの場合、falseを返す', () => {
      // アップロードAPIが返す形は常に「/コンテナ名/Blob名」の2セグメント。
      // 余分なセグメント（x）を挟むと存在しないBlobを指す壊れた参照になる
      expect(StorageService.isValidImagePath(
        'https://test.blob.core.windows.net/test-images/x/123e4567-e89b-12d3-a456-426614174000.jpg'
      )).toBe(false);
    });

    it('コンテナまでしか指していないURLの場合、falseを返す', () => {
      // 末尾がスラッシュでBlob名のセグメントが空。
      // 空文字列のBlob名を許すと、Blobを指さないURLが保存されてしまう
      expect(StorageService.isValidImagePath(
        'https://test.blob.core.windows.net/test-images/'
      )).toBe(false);
    });

    it('スキームがhttpsでないURLの場合、falseを返す', () => {
      // ホストと永続コンテナの形は正当だが、スキームがhttpsでない。
      // ホストとパスの一致だけを見る実装ではスキームを素通りさせてしまう
      expect(StorageService.isValidImagePath(
        'http://test.blob.core.windows.net/test-images/123e4567-e89b-12d3-a456-426614174000.jpg'
      )).toBe(false);
    });

    it('自アカウントの永続コンテナを指すURLの場合、trueを返す', () => {
      expect(StorageService.isValidImagePath(
        'https://test.blob.core.windows.net/test-images/123e4567-e89b-12d3-a456-426614174000.jpg'
      )).toBe(true);
    });

    it('クエリ文字列が付いたURLの場合、falseを返す', () => {
      // ホスト・コンテナ・Blob名は正当な形だが、クエリ文字列が付いている。
      // URLを正規化せずにセグメントだけを見る実装は、クエリ文字列の有無を
      // 区別できずこのURLも受理してしまう。保存されるimagePathが
      // 文字列として素のURLと食い違うため、重複チェック（文字列完全一致）を
      // 素通りできたり、更新時の旧画像削除判定（文字列比較）を誤作動させたりする
      expect(StorageService.isValidImagePath(
        'https://test.blob.core.windows.net/test-images/123e4567-e89b-12d3-a456-426614174000.jpg?x=1'
      )).toBe(false);
    });

    it('フラグメントが付いたURLの場合、falseを返す', () => {
      // ホスト・コンテナ・Blob名は正当な形だが、フラグメントが付いている。
      // new URL().pathname にはフラグメントが出ないため、ここまでの検証は
      // すべて通過してしまう。クエリ文字列のケースと同じく、生の文字列が
      // フラグメント付きのまま保存されると、文字列完全一致に頼るsaveの
      // 重複チェックやupdatePlantの旧画像削除判定を誤作動させる
      expect(StorageService.isValidImagePath(
        'https://test.blob.core.windows.net/test-images/123e4567-e89b-12d3-a456-426614174000.jpg#f'
      )).toBe(false);
    });

    it('認証情報が付いたURLの場合、falseを返す', () => {
      // ホスト・コンテナ・Blob名は正当な形だが、ユーザー名とパスワードが
      // 埋め込まれている。new URL().host はuserinfoを含まないため、
      // ホスト検証はここでも通過してしまう。この文字列がそのままCosmosに
      // 保存されると資格情報が平文でデータベースに残ってしまうため、
      // 他のケース（文字列比較の誤作動）とは異なる害を持つ
      expect(StorageService.isValidImagePath(
        'https://u:p@test.blob.core.windows.net/test-images/123e4567-e89b-12d3-a456-426614174000.jpg'
      )).toBe(false);
    });

    it('ホストが大文字のURLの場合、falseを返す', () => {
      // ホスト名の大文字小文字はDNS上は区別されないため、new URL().host は
      // 自動的に小文字化される。パース結果だけを見るホスト検証はここで
      // 一致してしまい、後続のセグメント検証も通過する。生の文字列同士の
      // 完全一致だけがこの違いを検出する
      expect(StorageService.isValidImagePath(
        'https://TEST.blob.core.windows.net/test-images/123e4567-e89b-12d3-a456-426614174000.jpg'
      )).toBe(false);
    });

    it('先頭に空白があるURLの場合、falseを返す', () => {
      // new URL() はWHATWGの仕様で先頭の空白を解析前に取り除くため、
      // 空白付きの文字列でもパース結果のホスト・パスには影響が出ず、
      // ここまでの検証をすべて通過してしまう。生の文字列同士の完全一致だけが
      // 先頭の空白を検出する
      expect(StorageService.isValidImagePath(
        ' https://test.blob.core.windows.net/test-images/123e4567-e89b-12d3-a456-426614174000.jpg'
      )).toBe(false);
    });
  });
});
