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

  describe('uploadImage', () => {
    it('アップロードした画像のURLが画像用コンテナのユニークなファイル名を指す', async () => {
      const imageBuffer = Buffer.from('test image data');

      const result = await service.uploadImage(imageBuffer, 'test.jpg', 'image/jpeg');

      expect(result).toMatch(/^https:\/\/test\.blob\.core\.windows\.net\/test-images\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/);
    });

    it('アップロードした内容とcontent-typeが保存される', async () => {
      const imageBuffer = Buffer.from('test image data');

      const result = await service.uploadImage(imageBuffer, 'test.jpg', 'image/jpeg');

      expect(blobStore.get(keyFromUrl(result))).toEqual({
        content: imageBuffer,
        contentType: 'image/jpeg'
      });
    });

    it('2回アップロードすると異なるURLが返る', async () => {
      const imageBuffer = Buffer.from('test image data');

      const result1 = await service.uploadImage(imageBuffer, 'test.jpg', 'image/jpeg');
      const result2 = await service.uploadImage(imageBuffer, 'test.jpg', 'image/jpeg');

      expect(result1).not.toBe(result2);
    });

    it('アップロードエラーの場合、エラーをスローする', async () => {
      const imageBuffer = Buffer.from('test image data');
      backend.forcedUploadError = new Error('Upload failed');

      await expect(service.uploadImage(imageBuffer, 'test.jpg', 'image/jpeg'))
        .rejects.toThrow(/^画像のアップロードに失敗しました: Upload failed$/);
    });
  });

  describe('uploadImageToTemp', () => {
    it('一時コンテナに画像をアップロードできる', async () => {
      const imageBuffer = Buffer.from('temp image data');

      const result = await service.uploadImageToTemp(imageBuffer, 'temp.jpg', 'image/jpeg');

      // 一時保存はSASトークン付きURLを返す（非公開コンテナのため、
      // 生のURLではAzure OpenAIが画像を取得できない）
      const match = result.match(/^(https:\/\/test\.blob\.core\.windows\.net\/test-temp\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg)\?(.+)$/);
      expect(match).not.toBeNull();
      expect(match![2]).toBe(TEST_SAS_TOKEN);
    });

    it('アップロードした内容とcontent-typeが一時コンテナに保存される', async () => {
      const imageBuffer = Buffer.from('temp image data');

      const result = await service.uploadImageToTemp(imageBuffer, 'temp.jpg', 'image/jpeg');

      expect(blobStore.get(keyFromUrl(result))).toEqual({
        content: imageBuffer,
        contentType: 'image/jpeg'
      });
    });

    it('読み取り専用のSAS権限で署名する', async () => {
      const imageBuffer = Buffer.from('temp image data');

      await service.uploadImageToTemp(imageBuffer, 'temp.jpg', 'image/jpeg');

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
      await expect(service.uploadImageToTemp(imageBuffer, 'temp.jpg', 'image/jpeg'))
        .rejects.toThrow(
          /^一時画像のアップロードに失敗しました: SAS URLの生成に失敗しました: credential unavailable$/
        );
    });

    it('SAS生成に失敗した場合は一時ファイルを残さない', async () => {
      const imageBuffer = Buffer.from('temp image data');

      mockedGenerateSas.mockImplementation(() => {
        throw new Error('credential unavailable');
      });

      await expect(service.uploadImageToTemp(imageBuffer, 'temp.jpg', 'image/jpeg'))
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
      const fileName = '33333333-3333-3333-3333-333333333333.jpg';
      blobStore.set(`test-images/${fileName}`, { content: Buffer.from('data'), contentType: 'image/jpeg' });
      // ホスト名（ストレージアカウント名）に一時コンテナ名 "test-temp" を含むURL。
      // コンテナ判定が文字列包含だと、パス上は永続コンテナ(test-images)の画像でも
      // ホスト名の "test-temp-account" にひっかけて一時コンテナ側だと誤認してしまう
      const imageUrl = `https://test-temp-account.blob.core.windows.net/test-images/${fileName}`;

      await service.deleteImage(imageUrl);

      expect(blobStore.has(`test-images/${fileName}`)).toBe(false);
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
});
