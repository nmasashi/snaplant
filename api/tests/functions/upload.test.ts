import { HttpRequest, InvocationContext } from '@azure/functions';
import { uploadImageHandler } from '../../src/functions/upload';
import { BlobServiceClient, ContainerClient, BlockBlobClient } from '@azure/storage-blob';

// 外部依存のみモック
jest.mock('@azure/storage-blob');
jest.mock('openai');

const MockedBlobServiceClient = BlobServiceClient as jest.MockedClass<typeof BlobServiceClient>;

describe('画像アップロード・植物判定統合API', () => {
  let mockContext: InvocationContext;
  let mockBlobServiceClient: jest.Mocked<BlobServiceClient>;
  let mockTempContainerClient: jest.Mocked<ContainerClient>;
  let mockImagesContainerClient: jest.Mocked<ContainerClient>;
  let mockTempBlockBlobClient: jest.Mocked<BlockBlobClient>;
  let mockImagesBlockBlobClient: jest.Mocked<BlockBlobClient>;
  let mockOpenAI: any;

  beforeEach(() => {
    // InvocationContextのモック
    mockContext = {
      log: Object.assign(jest.fn(), { error: jest.fn() }),
      error: jest.fn()
    } as any;

    // Azure Storage SDKのモック
    mockTempBlockBlobClient = {
      upload: jest.fn().mockResolvedValue({}),
      download: jest.fn().mockResolvedValue({
        readableStreamBody: {
          on: jest.fn((event, callback) => {
            if (event === 'data') callback(Buffer.from('test-image-data'));
            if (event === 'end') callback();
          })
        }
      }),
      getProperties: jest.fn().mockResolvedValue({ contentType: 'image/jpeg' }),
      delete: jest.fn().mockResolvedValue({}),
      url: 'https://test.blob.core.windows.net/temp/test-uuid.jpg'
    } as any;

    mockImagesBlockBlobClient = {
      upload: jest.fn().mockResolvedValue({}),
      url: 'https://test.blob.core.windows.net/images/test-uuid.jpg'
    } as any;

    mockTempContainerClient = {
      getBlockBlobClient: jest.fn().mockReturnValue(mockTempBlockBlobClient)
    } as any;

    mockImagesContainerClient = {
      getBlockBlobClient: jest.fn().mockReturnValue(mockImagesBlockBlobClient)
    } as any;

    mockBlobServiceClient = {
      getContainerClient: jest.fn().mockImplementation((containerName: string) => {
        if (containerName === 'temp') return mockTempContainerClient;
        return mockImagesContainerClient;
      })
    } as any;

    MockedBlobServiceClient.fromConnectionString = jest.fn().mockReturnValue(mockBlobServiceClient);

    // OpenAI SDKのモック
    mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [{
              message: {
                content: JSON.stringify({
                  isPlant: true,
                  confidence: 95.5,
                  reason: '画像に桜の花が写っており、植物と判定しました',
                  plantAnalysis: {
                    candidates: [
                      {
                        name: '桜',
                        scientificName: 'Prunus serrulata',
                        familyName: 'バラ科',
                        description: '日本を代表する花木',
                        characteristics: '春に美しいピンクの花を咲かせる',
                        confidence: 95.5
                      }
                    ]
                  }
                })
              }
            }]
          })
        }
      }
    };
    
    const MockedOpenAI = jest.requireMock('openai');
    if (MockedOpenAI && typeof MockedOpenAI.mockImplementation === 'function') {
      MockedOpenAI.mockImplementation(() => mockOpenAI);
    }

    // 環境変数設定
    process.env.STORAGE_CONNECTION_STRING = 'DefaultEndpointsProtocol=https;AccountName=test;AccountKey=key;EndpointSuffix=core.windows.net';
    process.env.STORAGE_CONTAINER_NAME = 'images';
    process.env.TEMP_STORAGE_CONTAINER_NAME = 'temp';
    process.env.OPENAI_API_KEY = 'test-api-key';
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete process.env.STORAGE_CONNECTION_STRING;
    delete process.env.STORAGE_CONTAINER_NAME;
    delete process.env.TEMP_STORAGE_CONTAINER_NAME;
    delete process.env.OPENAI_API_KEY;
  });

  describe('正常系', () => {
    it('画像を正常にアップロードできる', async () => {
      // 統合処理は beforeEach でモック済み

      // ファイルオブジェクトのモック
      const mockFile = {
        name: 'test.jpg',
        type: 'image/jpeg',
        size: 1024,
        arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(1024))
      } as any;

      const mockFormData = {
        get: jest.fn().mockReturnValue(mockFile)
      };

      // リクエストの作成
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/images/upload?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'multipart/form-data; boundary=---test']]),
        formData: jest.fn().mockResolvedValue(mockFormData)
      } as any as HttpRequest;

      // 実行
      const response = await uploadImageHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(201);
      expect(response.jsonBody).toEqual({
        success: true,
        data: {
          imagePath: 'https://test.blob.core.windows.net/images/test-uuid.jpg',
          fileName: 'test.jpg',
          contentType: 'image/jpeg',
          fileSize: 1024,
          identificationResult: {
            isPlant: true,
            confidence: 95.5,
            candidates: [
              {
                name: '桜',
                scientificName: 'Prunus serrulata',
                familyName: 'バラ科',
                description: '日本を代表する花木',
                characteristics: '春に美しいピンクの花を咲かせる',
                confidence: 95.5
              }
            ]
          }
        }
      });

      // 統合処理の検証
      expect(mockBlobServiceClient.getContainerClient).toHaveBeenCalledWith('temp');
      expect(mockTempBlockBlobClient.upload).toHaveBeenCalled();
      expect(mockOpenAI.chat.completions.create).toHaveBeenCalled();
      expect(mockBlobServiceClient.getContainerClient).toHaveBeenCalledWith('images');
      expect(mockImagesBlockBlobClient.upload).toHaveBeenCalled();
      expect(mockTempBlockBlobClient.delete).toHaveBeenCalled();
    });

    it('PNG画像も正常にアップロードできる', async () => {
      // 統合処理は beforeEach でモック済み

      // ファイルオブジェクトのモック
      const mockFile = {
        name: 'test.png',
        type: 'image/png',
        size: 2048,
        arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(2048))
      } as any;

      const mockFormData = {
        get: jest.fn().mockReturnValue(mockFile)
      };

      // リクエストの作成
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/images/upload?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'multipart/form-data; boundary=---test']]),
        formData: jest.fn().mockResolvedValue(mockFormData)
      } as any as HttpRequest;

      // 実行
      const response = await uploadImageHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(201);
      expect(mockTempBlockBlobClient.upload).toHaveBeenCalled();
      expect(mockImagesBlockBlobClient.upload).toHaveBeenCalled();
    });
  });

  describe('バリデーションエラー', () => {
    it('Content-Typeがmultipart/form-dataでない場合は400エラー', async () => {
      // リクエストの作成（無効なContent-Type）
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/images/upload?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        formData: jest.fn()
      } as any as HttpRequest;

      // 実行
      const response = await uploadImageHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(400);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'Content-Typeがmultipart/form-dataではありません',
          details: 'multipart/form-dataでファイルを送信してください'
        }
      });
      expect(mockTempBlockBlobClient.upload).not.toHaveBeenCalled();
    });

    it('ファイルが指定されていない場合は400エラー', async () => {
      // ファイルなしのモック
      const mockFormData = {
        get: jest.fn().mockReturnValue(null)
      };

      // リクエストの作成
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/images/upload?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'multipart/form-data; boundary=---test']]),
        formData: jest.fn().mockResolvedValue(mockFormData)
      } as any as HttpRequest;

      // 実行
      const response = await uploadImageHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(400);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: '画像ファイルが指定されていません',
          details: 'imageフィールドでファイルを送信してください'
        }
      });
      expect(mockTempBlockBlobClient.upload).not.toHaveBeenCalled();
    });

    it('サポートされていないファイル形式の場合は400エラー', async () => {
      // ファイルオブジェクトのモック（無効なコンテンツタイプ）
      const mockFile = {
        name: 'test.txt',
        type: 'text/plain',
        size: 1024,
        arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(1024))
      } as any;

      const mockFormData = {
        get: jest.fn().mockReturnValue(mockFile)
      };

      // リクエストの作成
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/images/upload?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'multipart/form-data; boundary=---test']]),
        formData: jest.fn().mockResolvedValue(mockFormData)
      } as any as HttpRequest;

      // 実行
      const response = await uploadImageHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(400);
      expect(response.jsonBody.success).toBe(false);
      expect(response.jsonBody.error.code).toBe('INVALID_REQUEST');
      expect(response.jsonBody.error.message).toBe('サポートされていない画像形式です');
      expect(mockTempBlockBlobClient.upload).not.toHaveBeenCalled();
    });

    it('ファイルサイズが上限を超える場合は400エラー', async () => {
      // 大きなファイルオブジェクトのモック（11MB）
      const mockFile = {
        name: 'large.jpg',
        type: 'image/jpeg',
        size: 11 * 1024 * 1024, // 11MB
        arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(11 * 1024 * 1024))
      } as any;

      const mockFormData = {
        get: jest.fn().mockReturnValue(mockFile)
      };

      // リクエストの作成
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/images/upload?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'multipart/form-data; boundary=---test']]),
        formData: jest.fn().mockResolvedValue(mockFormData)
      } as any as HttpRequest;

      // 実行
      const response = await uploadImageHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(400);
      expect(response.jsonBody.success).toBe(false);
      expect(response.jsonBody.error.code).toBe('INVALID_REQUEST');
      expect(response.jsonBody.error.message).toBe('ファイルサイズが大きすぎます');
      expect(mockTempBlockBlobClient.upload).not.toHaveBeenCalled();
    });

    it('フォームデータパースエラーの場合は400エラー', async () => {
      // リクエストの作成（フォームデータパースエラー）
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/images/upload?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'multipart/form-data; boundary=---test']]),
        formData: jest.fn().mockRejectedValue(new TypeError('Failed to parse formData'))
      } as any as HttpRequest;

      // 実行
      const response = await uploadImageHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(400);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'ファイルの読み取りに失敗しました',
          details: '有効なmultipart/form-dataを送信してください'
        }
      });
    });
  });

  describe('Azure Storage エラー', () => {
    it('Storageエラーの場合は502エラー', async () => {
      // Azure Storage エラーのモック
      const storageError = new Error('Storage service error');
      mockTempBlockBlobClient.upload.mockRejectedValue(storageError);

      // ファイルオブジェクトのモック
      const mockFile = {
        name: 'test.jpg',
        type: 'image/jpeg',
        size: 1024,
        arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(1024))
      } as any;

      const mockFormData = {
        get: jest.fn().mockReturnValue(mockFile)
      };

      // リクエストの作成
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/images/upload?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'multipart/form-data; boundary=---test']]),
        formData: jest.fn().mockResolvedValue(mockFormData)
      } as any as HttpRequest;

      // 実行
      const response = await uploadImageHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(502);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'STORAGE_ERROR',
          message: 'ストレージサービスでエラーが発生しました',
          details: '一時画像のアップロードに失敗しました: Storage service error'
        }
      });
    });

    it('ネットワークエラーの場合は500エラー', async () => {
      // ネットワークエラーのモック
      const networkError = new Error('Connection timeout');
      (networkError as any).code = 'ETIMEDOUT';
      mockTempBlockBlobClient.upload.mockRejectedValue(networkError);

      // ファイルオブジェクトのモック
      const mockFile = {
        name: 'test.jpg',
        type: 'image/jpeg',
        size: 1024,
        arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(1024))
      } as any;

      const mockFormData = {
        get: jest.fn().mockReturnValue(mockFile)
      };

      // リクエストの作成
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/images/upload?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'multipart/form-data; boundary=---test']]),
        formData: jest.fn().mockResolvedValue(mockFormData)
      } as any as HttpRequest;

      // 実行
      const response = await uploadImageHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(500);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: '画像アップロード・植物判定に失敗しました',
          details: '一時画像のアップロードに失敗しました: Connection timeout'
        }
      });
    });
  });
});