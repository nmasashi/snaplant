import { HttpRequest, InvocationContext } from '@azure/functions';
import { getPlantByIdHandler, deletePlantHandler } from '../../src/functions/plantDetail';
import { Plant } from '../../src/types/plant';
import { CosmosClient, Database, Container } from '@azure/cosmos';

// 外部依存のみモック
jest.mock('@azure/cosmos');
const MockedCosmosClient = CosmosClient as jest.MockedClass<typeof CosmosClient>;

describe('植物詳細取得API', () => {
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
    mockItems = {
      query: jest.fn(),
      create: jest.fn()
    };

    mockItem = {
      read: jest.fn(),
      delete: jest.fn()
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

  describe('GET /api/plants/{id} - 植物詳細取得', () => {
    const validPlantId = '123e4567-e89b-12d3-a456-426614174000';
    
    it('植物詳細を正常に取得できる', async () => {
      // テストデータ
      const mockPlant: Plant = {
        id: validPlantId,
        name: '桜',
        scientificName: 'Prunus serrulata',
        familyName: 'バラ科',
        description: '日本を代表する花木',
        characteristics: '春に美しい花を咲かせる',
        confidence: 95.5,
        imagePath: 'https://example.com/sakura.jpg',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z'
      };

      // Cosmos DBアイテム取得成功のモック
      mockItem.read.mockResolvedValue({ resource: mockPlant });

      // リクエストの作成
      const request = {
        method: 'GET',
        url: `https://func-snaplant.azurewebsites.net/api/plants/${validPlantId}?code=test-key`,
        query: new Map([['code', 'test-key']]),
        params: { id: validPlantId },
        headers: new Map()
      } as any as HttpRequest;

      // 実行
      const response = await getPlantByIdHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(200);
      expect(response.jsonBody).toEqual({
        success: true,
        data: {
          plant: mockPlant
        }
      });
      expect(mockContainer.item).toHaveBeenCalledWith(validPlantId, validPlantId);
      expect(mockItem.read).toHaveBeenCalled();
    });

    it('存在しない植物IDの場合は404エラー', async () => {
      // Cosmos DBアイテム未登録のモック
      mockItem.read.mockResolvedValue({ resource: null });

      // リクエストの作成
      const request = {
        method: 'GET',
        url: `https://func-snaplant.azurewebsites.net/api/plants/${validPlantId}?code=test-key`,
        query: new Map([['code', 'test-key']]),
        params: { id: validPlantId },
        headers: new Map()
      } as any as HttpRequest;

      // 実行
      const response = await getPlantByIdHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(404);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'PLANT_NOT_FOUND',
          message: '指定された植物が見つかりません'
        }
      });
    });

    it('無効なUUID形式の場合は400エラー', async () => {
      const invalidId = 'invalid-uuid';

      // リクエストの作成
      const request = {
        method: 'GET',
        url: `https://func-snaplant.azurewebsites.net/api/plants/${invalidId}?code=test-key`,
        query: new Map([['code', 'test-key']]),
        params: { id: invalidId },
        headers: new Map()
      } as any as HttpRequest;

      // 実行
      const response = await getPlantByIdHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(400);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: '植物IDの形式が無効です',
          details: 'UUID形式で指定してください'
        }
      });
      expect(mockContainer.item).not.toHaveBeenCalled();
    });

    it('植物IDが未指定の場合は400エラー', async () => {
      // リクエストの作成
      const request = {
        method: 'GET',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/?code=test-key',
        query: new Map([['code', 'test-key']]),
        params: {},
        headers: new Map()
      } as any as HttpRequest;

      // 実行
      const response = await getPlantByIdHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(400);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: '植物IDが指定されていません'
        }
      });
      expect(mockContainer.item).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /api/plants/{id} - 植物削除', () => {
    const validPlantId = '123e4567-e89b-12d3-a456-426614174000';

    it('植物を正常に削除できる', async () => {
      // Cosmos DBアイテム削除成功のモック
      mockItem.delete.mockResolvedValue({ resource: { id: validPlantId } });

      // リクエストの作成
      const request = {
        method: 'DELETE',
        url: `https://func-snaplant.azurewebsites.net/api/plants/${validPlantId}?code=test-key`,
        query: new Map([['code', 'test-key']]),
        params: { id: validPlantId },
        headers: new Map()
      } as any as HttpRequest;

      // 実行
      const response = await deletePlantHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(200);
      expect(response.jsonBody).toEqual({
        success: true,
        data: {
          message: '植物が正常に削除されました'
        }
      });
      expect(mockContainer.item).toHaveBeenCalledWith(validPlantId, validPlantId);
      expect(mockItem.delete).toHaveBeenCalled();
    });

    it('存在しない植物IDの場合は404エラー', async () => {
      // Cosmos DBアイテム削除失敗のモック
      const notFoundError = new Error('Entity not found');
      (notFoundError as any).code = 404;
      mockItem.delete.mockRejectedValue(notFoundError);

      // リクエストの作成
      const request = {
        method: 'DELETE',
        url: `https://func-snaplant.azurewebsites.net/api/plants/${validPlantId}?code=test-key`,
        query: new Map([['code', 'test-key']]),
        params: { id: validPlantId },
        headers: new Map()
      } as any as HttpRequest;

      // 実行
      const response = await deletePlantHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(404);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'PLANT_NOT_FOUND',
          message: '指定された植物が見つかりません'
        }
      });
    });
  });

});