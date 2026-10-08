import { StorageService } from '../../src/services/storageService';
import { BlobServiceClient, ContainerClient, BlockBlobClient, generateBlobSASQueryParameters } from '@azure/storage-blob';
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

describe('StorageService', () => {
  let service: StorageService;
  let mockBlobServiceClient: jest.Mocked<BlobServiceClient>;
  let mockContainerClient: jest.Mocked<ContainerClient>;
  let mockBlockBlobClient: jest.Mocked<BlockBlobClient>;

  beforeEach(() => {
    // Azure Storage SDK のモック設定
    mockBlockBlobClient = {
      upload: jest.fn(),
      download: jest.fn(),
      delete: jest.fn(),
      getProperties: jest.fn(),
      url: 'https://test.blob.core.windows.net/test-images/test.jpg'
    } as any;

    mockContainerClient = {
      getBlockBlobClient: jest.fn().mockReturnValue(mockBlockBlobClient)
    } as any;

    mockBlobServiceClient = {
      getContainerClient: jest.fn().mockReturnValue(mockContainerClient)
    } as any;

    MockedBlobServiceClient.fromConnectionString = jest.fn().mockReturnValue(mockBlobServiceClient);

    // SAS生成を成功させる（自動モックのままだとundefinedを返し、
    // 本番コードのフォールバックに落ちてSAS生成本体が実行されない）
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
    it('画像を正常にアップロードできる', async () => {
      const imageBuffer = Buffer.from('test image data');
      const fileName = 'test.jpg';
      const contentType = 'image/jpeg';

      mockBlockBlobClient.upload.mockResolvedValue({} as any);

      const result = await service.uploadImage(imageBuffer, fileName, contentType);

      expect(result).toBe(mockBlockBlobClient.url);
      expect(mockBlobServiceClient.getContainerClient).toHaveBeenCalledWith('test-images');
      expect(mockContainerClient.getBlockBlobClient).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/));
      expect(mockBlockBlobClient.upload).toHaveBeenCalledWith(imageBuffer, imageBuffer.length, {
        blobHTTPHeaders: { blobContentType: contentType }
      });
    });

    it('ファイル名にユニークIDが追加される', async () => {
      const imageBuffer = Buffer.from('test image data');
      const fileName = 'sakura.png';
      const contentType = 'image/png';

      mockBlockBlobClient.upload.mockResolvedValue({} as any);

      await service.uploadImage(imageBuffer, fileName, contentType);

      // UUID形式のファイル名が含まれているかチェック
      const uploadCall = mockContainerClient.getBlockBlobClient.mock.calls[0][0];
      expect(uploadCall).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/);
    });

    it('アップロードエラーの場合、エラーをスローする', async () => {
      const imageBuffer = Buffer.from('test image data');
      const fileName = 'test.jpg';
      const contentType = 'image/jpeg';

      const uploadError = new Error('Upload failed');
      mockBlockBlobClient.upload.mockRejectedValue(uploadError);

      await expect(service.uploadImage(imageBuffer, fileName, contentType))
        .rejects.toThrow('画像のアップロードに失敗しました: Upload failed');
    });
  });

  describe('uploadImageToTemp', () => {
    it('一時コンテナに画像をアップロードできる', async () => {
      const imageBuffer = Buffer.from('temp image data');
      const fileName = 'temp.jpg';
      const contentType = 'image/jpeg';

      mockBlockBlobClient.upload.mockResolvedValue({} as any);

      const result = await service.uploadImageToTemp(imageBuffer, fileName, contentType);

      // 一時保存はSASトークン付きURLを返す（非公開コンテナのため、
      // 生のURLではAzure OpenAIが画像を取得できない）
      expect(result).toBe(`${mockBlockBlobClient.url}?${TEST_SAS_TOKEN}`);
      expect(mockBlobServiceClient.getContainerClient).toHaveBeenCalledWith('test-temp');
      expect(mockBlockBlobClient.upload).toHaveBeenCalledWith(imageBuffer, imageBuffer.length, {
        blobHTTPHeaders: { blobContentType: contentType }
      });
    });

    it('読み取り専用のSAS権限で署名する', async () => {
      const imageBuffer = Buffer.from('temp image data');

      mockBlockBlobClient.upload.mockResolvedValue({} as any);

      await service.uploadImageToTemp(imageBuffer, 'temp.jpg', 'image/jpeg');

      const [options] = mockedGenerateSas.mock.calls[0];
      expect(options.containerName).toBe('test-temp');
      expect(options.permissions).toMatchObject({ read: true });
      expect(options.expiresOn!.getTime()).toBeGreaterThan(Date.now());
    });

    it('SAS生成に失敗した場合はエラーをスローする', async () => {
      const imageBuffer = Buffer.from('temp image data');

      mockBlockBlobClient.upload.mockResolvedValue({} as any);
      mockedGenerateSas.mockImplementation(() => {
        throw new Error('credential unavailable');
      });

      // 生のURLを返すと静かに403になるため、失敗は伝播させる
      await expect(service.uploadImageToTemp(imageBuffer, 'temp.jpg', 'image/jpeg'))
        .rejects.toThrow('SAS URLの生成に失敗しました: credential unavailable');
    });

    it('一時ファイル名にUUIDが追加される', async () => {
      const imageBuffer = Buffer.from('temp image data');
      const fileName = 'test.jpg';
      const contentType = 'image/jpeg';

      mockBlockBlobClient.upload.mockResolvedValue({} as any);

      await service.uploadImageToTemp(imageBuffer, fileName, contentType);

      const uploadCall = mockContainerClient.getBlockBlobClient.mock.calls[0][0];
      expect(uploadCall).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/);
    });
  });

  describe('moveFromTempToPermanent', () => {
    it('一時ファイルを永続保存に移動できる', async () => {
      const tempUrl = 'https://test.blob.core.windows.net/test-temp/12345678-1234-1234-1234-123456789012.jpg';
      
      // ダウンロード用のモック設定
      const mockStream = new Readable({
        read() {
          this.push('image data');
          this.push(null);
        }
      });
      
      mockBlockBlobClient.download.mockResolvedValue({
        readableStreamBody: mockStream
      } as any);

      mockBlockBlobClient.getProperties.mockResolvedValue({
        contentType: 'image/jpeg'
      } as any);

      mockBlockBlobClient.upload.mockResolvedValue({} as any);
      mockBlockBlobClient.delete.mockResolvedValue({} as any);

      const result = await service.moveFromTempToPermanent(tempUrl);

      // 永続コンテナの URL が返される
      expect(result).toBe(mockBlockBlobClient.url);
      
      // 一時ファイルからダウンロード
      expect(mockBlobServiceClient.getContainerClient).toHaveBeenCalledWith('test-temp');
      expect(mockContainerClient.getBlockBlobClient).toHaveBeenCalledWith('12345678-1234-1234-1234-123456789012.jpg');
      expect(mockBlockBlobClient.download).toHaveBeenCalled();
      
      // 永続コンテナにアップロード
      expect(mockBlobServiceClient.getContainerClient).toHaveBeenCalledWith('test-images');
      expect(mockBlockBlobClient.upload).toHaveBeenCalled();
      
      // 一時ファイル削除
      expect(mockBlockBlobClient.delete).toHaveBeenCalled();
    });

    it('無効な一時URL形式の場合、エラーをスローする', async () => {
      const invalidUrl = 'https://invalid.com/wrong/path.jpg';

      await expect(service.moveFromTempToPermanent(invalidUrl))
        .rejects.toThrow('画像の永続保存への移動に失敗しました');
    });

    it('ダウンロードエラーの場合、エラーをスローする', async () => {
      const tempUrl = 'https://test.blob.core.windows.net/test-temp/12345678-1234-1234-1234-123456789012.jpg';
      
      const downloadError = new Error('Download failed');
      mockBlockBlobClient.download.mockRejectedValue(downloadError);

      await expect(service.moveFromTempToPermanent(tempUrl))
        .rejects.toThrow('画像の永続保存への移動に失敗しました: Download failed');
    });
  });

  describe('deleteImage', () => {
    it('画像を正常に削除できる', async () => {
      const imageUrl = 'https://test.blob.core.windows.net/test-images/12345678-1234-1234-1234-123456789012.jpg';

      mockBlockBlobClient.delete.mockResolvedValue({} as any);

      const result = await service.deleteImage(imageUrl);

      expect(result).toBe(true);
      expect(mockBlobServiceClient.getContainerClient).toHaveBeenCalledWith('test-images');
      expect(mockContainerClient.getBlockBlobClient).toHaveBeenCalledWith('12345678-1234-1234-1234-123456789012.jpg');
      expect(mockBlockBlobClient.delete).toHaveBeenCalled();
    });

    it('一時コンテナの画像も削除できる', async () => {
      const tempImageUrl = 'https://test.blob.core.windows.net/test-temp/12345678-1234-1234-1234-123456789012.jpg';

      mockBlockBlobClient.delete.mockResolvedValue({} as any);

      const result = await service.deleteImage(tempImageUrl);

      expect(result).toBe(true);
      expect(mockBlobServiceClient.getContainerClient).toHaveBeenCalledWith('test-temp');
      expect(mockContainerClient.getBlockBlobClient).toHaveBeenCalledWith('12345678-1234-1234-1234-123456789012.jpg');
      expect(mockBlockBlobClient.delete).toHaveBeenCalled();
    });

    it('削除エラーの場合、エラーをスローする', async () => {
      const imageUrl = 'https://test.blob.core.windows.net/test-images/test.jpg';

      const deleteError = new Error('Delete failed');
      mockBlockBlobClient.delete.mockRejectedValue(deleteError);

      await expect(service.deleteImage(imageUrl))
        .rejects.toThrow('画像の削除に失敗しました: Delete failed');
    });

    it('無効なURL形式の場合、エラーをスローする', async () => {
      const invalidUrl = 'invalid-url';

      const result = await service.deleteImage(invalidUrl);
      expect(result).toBe(false);
    });
  });

  describe('isValidImageContentType - 静的メソッド', () => {
    it('有効な画像タイプの場合、trueを返す', () => {
      expect(StorageService.isValidImageContentType('image/jpeg')).toBe(true);
      expect(StorageService.isValidImageContentType('image/png')).toBe(true);
      expect(StorageService.isValidImageContentType('image/webp')).toBe(true);
      expect(StorageService.isValidImageContentType('image/gif')).toBe(true);
    });

    it('無効な画像タイプの場合、falseを返す', () => {
      expect(StorageService.isValidImageContentType('text/plain')).toBe(false);
      expect(StorageService.isValidImageContentType('application/json')).toBe(false);
      expect(StorageService.isValidImageContentType('video/mp4')).toBe(false);
      expect(StorageService.isValidImageContentType('')).toBe(false);
      // nullの場合はエラーをスローする
      expect(() => StorageService.isValidImageContentType(null as any)).toThrow();
    });
  });

  describe('isValidFileSize - 静的メソッド', () => {
    it('有効なファイルサイズの場合、trueを返す', () => {
      expect(StorageService.isValidFileSize(1024)).toBe(true);        // 1KB
      expect(StorageService.isValidFileSize(1024 * 1024)).toBe(true); // 1MB
      expect(StorageService.isValidFileSize(5 * 1024 * 1024)).toBe(true); // 5MB
    });

    it('無効なファイルサイズの場合、falseを返す', () => {
      expect(StorageService.isValidFileSize(0)).toBe(false);
      expect(StorageService.isValidFileSize(-1)).toBe(false);
      expect(StorageService.isValidFileSize(11 * 1024 * 1024)).toBe(false); // 11MB (上限超過)
    });
  });

  describe('streamToBuffer - 内部メソッド', () => {
    it('ストリームを正常にBufferに変換できる', async () => {
      const testData = 'test stream data';
      const mockStream = new Readable({
        read() {
          this.push(testData);
          this.push(null);
        }
      });

      // privateメソッドへのアクセス（テスト用）
      const streamToBufferMethod = (service as any).streamToBuffer.bind(service);
      const result = await streamToBufferMethod(mockStream);

      expect(result).toBeInstanceOf(Buffer);
      expect(result.toString()).toBe(testData);
    });

    it('ストリームエラーの場合、エラーをスローする', async () => {
      const mockStream = new Readable({
        read() {
          this.emit('error', new Error('Stream error'));
        }
      });

      const streamToBufferMethod = (service as any).streamToBuffer.bind(service);
      
      await expect(streamToBufferMethod(mockStream))
        .rejects.toThrow('Stream error');
    });
  });

  describe('generateUniqueFileName - 内部メソッド', () => {
    it('ユニークなファイル名を生成する', () => {
      const fileName = 'test.jpg';
      
      // privateメソッドへのアクセス（テスト用）
      const generateUniqueFileNameMethod = (service as any).generateUniqueFileName.bind(service);
      const result = generateUniqueFileNameMethod(fileName);

      // UUID.jpg 形式かチェック
      expect(result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/);
    });

    it('拡張子を保持する', () => {
      const fileName = 'test.png';
      
      const generateUniqueFileNameMethod = (service as any).generateUniqueFileName.bind(service);
      const result = generateUniqueFileNameMethod(fileName);

      expect(result).toMatch(/\.png$/);
    });

    it('異なる呼び出しで異なるUUIDを生成する', () => {
      const fileName = 'test.jpg';
      
      const generateUniqueFileNameMethod = (service as any).generateUniqueFileName.bind(service);
      const result1 = generateUniqueFileNameMethod(fileName);
      const result2 = generateUniqueFileNameMethod(fileName);

      expect(result1).not.toBe(result2);
    });
  });

  describe('extractFileNameFromUrl - 内部メソッド', () => {
    it('正常なURL形式からファイル名を抽出できる', () => {
      const url = 'https://test.blob.core.windows.net/test-images/12345678-1234-1234-1234-123456789012.jpg';
      
      const extractFileNameFromUrlMethod = (service as any).extractFileNameFromUrl.bind(service);
      const result = extractFileNameFromUrlMethod(url);

      expect(result).toBe('12345678-1234-1234-1234-123456789012.jpg');
    });

    it('一時コンテナのURLからファイル名を抽出できる', () => {
      const url = 'https://test.blob.core.windows.net/test-temp/87654321-4321-4321-4321-210987654321.jpg';
      
      const extractFileNameFromUrlMethod = (service as any).extractFileNameFromUrl.bind(service);
      const result = extractFileNameFromUrlMethod(url);

      expect(result).toBe('87654321-4321-4321-4321-210987654321.jpg');
    });

    it('無効なURL形式の場合、nullを返す', () => {
      const invalidUrl = 'invalid-url';
      
      const extractFileNameFromUrlMethod = (service as any).extractFileNameFromUrl.bind(service);
      const result = extractFileNameFromUrlMethod(invalidUrl);

      expect(result).toBeNull();
    });
  });
});