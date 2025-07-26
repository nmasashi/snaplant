import { HttpRequest, InvocationContext } from '@azure/functions';
import { updatePlantHandler } from '../../src/functions/updatePlant';
import { CosmosClient, Database, Container } from '@azure/cosmos';
import { Plant } from '../../src/types/plant';

// 外部依存のみモック
jest.mock('@azure/cosmos');
jest.mock('@azure/storage-blob');

const MockedCosmosClient = CosmosClient as jest.MockedClass<typeof CosmosClient>;

describe('植物更新API', () => {
  let mockContext: InvocationContext;
  let mockClient: jest.Mocked<CosmosClient>;
  let mockDatabase: jest.Mocked<Database>;
  let mockContainer: jest.Mocked<Container>;
  let mockItems: any;
  let mockItem: any;

  beforeEach(() => {
    // InvocationContextのモック
    mockContext = {
      log: Object.assign(jest.fn(), { error: jest.fn() }),
      error: jest.fn()
    } as any;

    // Cosmos DB SDKのモック
    mockItem = {
      read: jest.fn(),
      replace: jest.fn()
    };

    mockItems = {
      query: jest.fn()
    };

    mockContainer = {
      items: mockItems,
      item: jest.fn().mockReturnValue(mockItem)
    } as any;

    mockDatabase = {
      container: jest.fn().mockReturnValue(mockContainer)
    } as any;

    mockClient = {
      database: jest.fn().mockReturnValue(mockDatabase)
    } as any;

    MockedCosmosClient.mockImplementation(() => mockClient);

    // 環境変数設定
    process.env.COSMOS_DB_ENDPOINT = 'https://test.documents.azure.com:443/';
    process.env.COSMOS_DB_KEY = 'test-key';
    process.env.COSMOS_DB_DATABASE = 'test-db';
    process.env.COSMOS_DB_CONTAINER = 'test-container';
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete process.env.COSMOS_DB_ENDPOINT;
    delete process.env.COSMOS_DB_KEY;
    delete process.env.COSMOS_DB_DATABASE;
    delete process.env.COSMOS_DB_CONTAINER;
  });

  describe('正常系', () => {
    it('植物の更新に成功する', async () => {
      // 既存植物のモック
      const existingPlant: Plant = {
        id: '123e4567-e89b-12d3-a456-426614174000',
        name: '桜',
        scientificName: 'Prunus serrulata',
        familyName: 'バラ科',
        description: '日本を代表する花木',
        characteristics: '春に美しいピンクの花を咲かせる',
        confidence: 85.0,
        imagePath: 'https://example.com/old.jpg',
        createdAt: '2024-01-15T10:30:00Z',
        updatedAt: '2024-01-15T10:30:00Z'
      };

      const updatedPlant: Plant = {
        ...existingPlant,
        imagePath: 'https://example.com/new.jpg',
        confidence: 95.0,
        updatedAt: '2024-01-16T10:30:00Z'
      };

      mockItem.read.mockResolvedValue({ resource: existingPlant });
      mockItem.replace.mockResolvedValue({ resource: updatedPlant });

      // リクエストの作成
      const request = {
        method: 'PUT',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/123e4567-e89b-12d3-a456-426614174000?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        params: { id: '123e4567-e89b-12d3-a456-426614174000' },
        json: jest.fn().mockResolvedValue({
          imagePath: 'https://example.com/new.jpg',
          confidence: 95.0
        })
      } as any as HttpRequest;

      // 実行
      const response = await updatePlantHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(200);
      expect(response.jsonBody).toEqual({
        success: true,
        data: {
          plant: updatedPlant
        }
      });

      expect(mockItem.read).toHaveBeenCalledWith();
      expect(mockItem.replace).toHaveBeenCalledWith(expect.objectContaining({
        ...existingPlant,
        imagePath: 'https://example.com/new.jpg',
        confidence: 95.0,
        updatedAt: expect.any(String)
      }));
    });
  });

  describe('バリデーションエラー', () => {
    it('植物IDが無効な場合は400エラー', async () => {
      // リクエストの作成（無効なID）
      const request = {
        method: 'PUT',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/invalid-id?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        params: { id: 'invalid-id' },
        json: jest.fn().mockResolvedValue({
          imagePath: 'https://example.com/new.jpg',
          confidence: 95.0
        })
      } as any as HttpRequest;

      // 実行
      const response = await updatePlantHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(400);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: '有効な植物IDが指定されていません',
          details: 'IDはUUID形式で指定してください'
        }
      });
      expect(mockItem.read).not.toHaveBeenCalled();
    });

    it('画像パスが未指定の場合は400エラー', async () => {
      // リクエストの作成（画像パスなし）
      const request = {
        method: 'PUT',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/123e4567-e89b-12d3-a456-426614174000?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        params: { id: '123e4567-e89b-12d3-a456-426614174000' },
        json: jest.fn().mockResolvedValue({
          confidence: 95.0
        })
      } as any as HttpRequest;

      // 実行
      const response = await updatePlantHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(400);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: '画像パスが指定されていません',
          details: undefined
        }
      });
      expect(mockItem.read).not.toHaveBeenCalled();
    });

    it('信頼度が範囲外の場合は400エラー', async () => {
      // リクエストの作成（信頼度が範囲外）
      const request = {
        method: 'PUT',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/123e4567-e89b-12d3-a456-426614174000?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        params: { id: '123e4567-e89b-12d3-a456-426614174000' },
        json: jest.fn().mockResolvedValue({
          imagePath: 'https://example.com/new.jpg',
          confidence: 101 // 範囲外
        })
      } as any as HttpRequest;

      // 実行
      const response = await updatePlantHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(400);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: '信頼度は0から100の間の数値で指定してください',
          details: undefined
        }
      });
      expect(mockItem.read).not.toHaveBeenCalled();
    });

    it('画像URLの形式が無効な場合は400エラー', async () => {
      // リクエストの作成（無効なURL）
      const request = {
        method: 'PUT',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/123e4567-e89b-12d3-a456-426614174000?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        params: { id: '123e4567-e89b-12d3-a456-426614174000' },
        json: jest.fn().mockResolvedValue({
          imagePath: 'invalid-url',
          confidence: 95.0
        })
      } as any as HttpRequest;

      // 実行
      const response = await updatePlantHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(400);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: '画像URLの形式が無効です',
          details: '有効なURL形式で指定してください'
        }
      });
      expect(mockItem.read).not.toHaveBeenCalled();
    });
  });

  describe('植物が見つからない場合', () => {
    it('存在しない植物IDの場合は404エラー', async () => {
      // 植物が見つからないモック
      mockItem.read.mockResolvedValue({ resource: null });

      // リクエストの作成
      const request = {
        method: 'PUT',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/123e4567-e89b-12d3-a456-426614174000?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        params: { id: '123e4567-e89b-12d3-a456-426614174000' },
        json: jest.fn().mockResolvedValue({
          imagePath: 'https://example.com/new.jpg',
          confidence: 95.0
        })
      } as any as HttpRequest;

      // 実行
      const response = await updatePlantHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(404);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'PLANT_NOT_FOUND',
          message: '指定された植物が見つかりません',
          details: undefined
        }
      });
    });
  });

  describe('Cosmos DB エラー', () => {
    it('DB接続エラーの場合は503エラー', async () => {
      // DB接続エラーのモック
      const dbError = new Error('Connection timeout');
      (dbError as any).code = 'ENOTFOUND';
      mockItem.read.mockRejectedValue(dbError);

      // リクエストの作成
      const request = {
        method: 'PUT',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/123e4567-e89b-12d3-a456-426614174000?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        params: { id: '123e4567-e89b-12d3-a456-426614174000' },
        json: jest.fn().mockResolvedValue({
          imagePath: 'https://example.com/new.jpg',
          confidence: 95.0
        })
      } as any as HttpRequest;

      // 実行
      const response = await updatePlantHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(503);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'DATABASE_ERROR',
          message: 'データベースに接続できません',
          details: 'Connection timeout'
        }
      });
    });

    it('予期しないエラーの場合は500エラー', async () => {
      // 予期しないエラーのモック
      const unexpectedError = new Error('Unexpected error');
      mockItem.read.mockRejectedValue(unexpectedError);

      // リクエストの作成
      const request = {
        method: 'PUT',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/123e4567-e89b-12d3-a456-426614174000?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        params: { id: '123e4567-e89b-12d3-a456-426614174000' },
        json: jest.fn().mockResolvedValue({
          imagePath: 'https://example.com/new.jpg',
          confidence: 95.0
        })
      } as any as HttpRequest;

      // 実行
      const response = await updatePlantHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(500);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: '植物の更新に失敗しました',
          details: 'Unexpected error'
        }
      });
    });
  });

  describe('旧画像削除処理', () => {
    let mockBlobServiceClient: any;
    let mockContainerClient: any;
    let mockBlockBlobClient: any;

    beforeEach(() => {
      // Azure Storage Blob SDKのモック
      mockBlockBlobClient = {
        delete: jest.fn().mockResolvedValue({})
      };

      mockContainerClient = {
        getBlockBlobClient: jest.fn().mockReturnValue(mockBlockBlobClient)
      };

      mockBlobServiceClient = {
        getContainerClient: jest.fn().mockReturnValue(mockContainerClient)
      };

      const { BlobServiceClient } = jest.requireMock('@azure/storage-blob');
      BlobServiceClient.fromConnectionString = jest.fn().mockReturnValue(mockBlobServiceClient);
    });

    it('画像URLが変更された場合、旧画像を削除する', async () => {
      // 既存植物データのモック
      const existingPlant: Plant = {
        id: '123e4567-e89b-12d3-a456-426614174000',
        name: '桜',
        characteristics: '春に美しいピンクの花を咲かせる',
        imagePath: 'https://example.com/old-image.jpg',
        confidence: 85.0,
        createdAt: '2024-01-10T14:20:00Z',
        updatedAt: '2024-01-10T14:20:00Z'
      };

      const updatedPlant: Plant = {
        ...existingPlant,
        imagePath: 'https://example.com/new-image.jpg',
        confidence: 95.0,
        updatedAt: '2024-01-15T10:30:00Z'
      };

      // Cosmos DB成功のモック
      mockItem.read.mockResolvedValue({ resource: existingPlant });
      mockItem.replace.mockResolvedValue({ resource: updatedPlant });
      
      // Storage削除成功のモック
      mockBlockBlobClient.delete.mockResolvedValue({});

      // リクエストの作成
      const request = {
        method: 'PUT',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/123e4567-e89b-12d3-a456-426614174000?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        params: { id: '123e4567-e89b-12d3-a456-426614174000' },
        json: jest.fn().mockResolvedValue({
          imagePath: 'https://example.com/new-image.jpg',
          confidence: 95.0
        })
      } as any as HttpRequest;

      // 実行
      const response = await updatePlantHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(200);
      expect(response.jsonBody.success).toBe(true);
      expect(response.jsonBody.data.plant.imagePath).toBe('https://example.com/new-image.jpg');
      
      // 旧画像削除が呼び出されることの検証
      expect(mockBlobServiceClient.getContainerClient).toHaveBeenCalled();
      expect(mockBlockBlobClient.delete).toHaveBeenCalled();
    });

    it('画像URLが同じ場合、旧画像削除は実行されない', async () => {
      // 既存植物データのモック（同じ画像URL）
      const existingPlant: Plant = {
        id: '123e4567-e89b-12d3-a456-426614174000',
        name: '桜',
        characteristics: '春に美しいピンクの花を咲かせる',
        imagePath: 'https://example.com/same-image.jpg',
        confidence: 85.0,
        createdAt: '2024-01-10T14:20:00Z',
        updatedAt: '2024-01-10T14:20:00Z'
      };

      const updatedPlant: Plant = {
        ...existingPlant,
        confidence: 95.0,
        updatedAt: '2024-01-15T10:30:00Z'
      };

      // Cosmos DB成功のモック
      mockItem.read.mockResolvedValue({ resource: existingPlant });
      mockItem.replace.mockResolvedValue({ resource: updatedPlant });

      // リクエストの作成（同じ画像URL）
      const request = {
        method: 'PUT',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/123e4567-e89b-12d3-a456-426614174000?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        params: { id: '123e4567-e89b-12d3-a456-426614174000' },
        json: jest.fn().mockResolvedValue({
          imagePath: 'https://example.com/same-image.jpg',
          confidence: 95.0
        })
      } as any as HttpRequest;

      // 実行
      const response = await updatePlantHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(200);
      expect(response.jsonBody.success).toBe(true);
      
      // 旧画像削除が呼び出されないことの検証
      expect(mockBlockBlobClient.delete).not.toHaveBeenCalled();
    });

    it('旧画像削除に失敗してもメイン処理は成功する', async () => {
      // 既存植物データのモック
      const existingPlant: Plant = {
        id: '123e4567-e89b-12d3-a456-426614174000',
        name: '桜',
        characteristics: '春に美しいピンクの花を咲かせる',
        imagePath: 'https://example.com/old-image.jpg',
        confidence: 85.0,
        createdAt: '2024-01-10T14:20:00Z',
        updatedAt: '2024-01-10T14:20:00Z'
      };

      const updatedPlant: Plant = {
        ...existingPlant,
        imagePath: 'https://example.com/new-image.jpg',
        confidence: 95.0,
        updatedAt: '2024-01-15T10:30:00Z'
      };

      // Cosmos DB成功のモック
      mockItem.read.mockResolvedValue({ resource: existingPlant });
      mockItem.replace.mockResolvedValue({ resource: updatedPlant });
      
      // Storage削除失敗のモック
      mockBlockBlobClient.delete.mockRejectedValue(new Error('Storage delete failed'));

      // リクエストの作成
      const request = {
        method: 'PUT',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/123e4567-e89b-12d3-a456-426614174000?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        params: { id: '123e4567-e89b-12d3-a456-426614174000' },
        json: jest.fn().mockResolvedValue({
          imagePath: 'https://example.com/new-image.jpg',
          confidence: 95.0
        })
      } as any as HttpRequest;

      // 実行
      const response = await updatePlantHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(200);
      expect(response.jsonBody.success).toBe(true);
      expect(response.jsonBody.data.plant.imagePath).toBe('https://example.com/new-image.jpg');
      
      // 旧画像削除が試行されることの検証
      expect(mockBlockBlobClient.delete).toHaveBeenCalled();
    });
  });
});