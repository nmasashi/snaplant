import { HttpRequest, InvocationContext } from '@azure/functions';
import { checkDuplicateHandler } from '../../src/functions/checkDuplicate';
import { CosmosClient, Database, Container } from '@azure/cosmos';

// 外部依存のみモック
jest.mock('@azure/cosmos');
const MockedCosmosClient = CosmosClient as jest.MockedClass<typeof CosmosClient>;

describe('植物重複チェックAPI', () => {
  let mockContext: InvocationContext;
  let mockClient: jest.Mocked<CosmosClient>;
  let mockDatabase: jest.Mocked<Database>;
  let mockContainer: jest.Mocked<Container>;
  let mockItems: any;

  beforeEach(() => {
    // InvocationContextのモック
    mockContext = {
      log: Object.assign(jest.fn(), { error: jest.fn() }),
      error: jest.fn()
    } as any;

    // Cosmos DB SDKのモック
    mockItems = {
      query: jest.fn()
    };

    mockContainer = {
      items: mockItems
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
    it('重複する植物が存在する場合', async () => {
      // 既存植物のモック
      const existingPlant = {
        id: '123e4567-e89b-12d3-a456-426614174000',
        name: '桜',
        imagePath: 'https://example.com/sakura.jpg',
        confidence: 85.0,
        createdAt: '2024-01-15T10:30:00Z'
      };

      const mockQuery = {
        fetchAll: jest.fn().mockResolvedValue({ resources: [existingPlant] })
      };
      mockItems.query.mockReturnValue(mockQuery);

      // リクエストの作成
      const request = {
        method: 'GET',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/check-duplicate?name=桜&code=test-key',
        query: new Map([
          ['name', '桜'],
          ['code', 'test-key']
        ]),
        headers: new Map()
      } as any as HttpRequest;

      // 実行
      const response = await checkDuplicateHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(200);
      expect(response.jsonBody).toEqual({
        success: true,
        data: {
          exists: true,
          plant: {
            id: '123e4567-e89b-12d3-a456-426614174000',
            name: '桜',
            imagePath: 'https://example.com/sakura.jpg',
            confidence: 85.0,
            createdAt: '2024-01-15T10:30:00Z'
          }
        }
      });

      // クエリが正しく呼ばれることを確認
      expect(mockItems.query).toHaveBeenCalledWith({
        query: expect.stringContaining('WHERE c.name = @name'),
        parameters: [{ name: '@name', value: '桜' }]
      });
    });

    it('重複する植物が存在しない場合', async () => {
      // 空の結果のモック
      const mockQuery = {
        fetchAll: jest.fn().mockResolvedValue({ resources: [] })
      };
      mockItems.query.mockReturnValue(mockQuery);

      // リクエストの作成
      const request = {
        method: 'GET',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/check-duplicate?name=存在しない植物&code=test-key',
        query: new Map([
          ['name', '存在しない植物'],
          ['code', 'test-key']
        ]),
        headers: new Map()
      } as any as HttpRequest;

      // 実行
      const response = await checkDuplicateHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(200);
      expect(response.jsonBody).toEqual({
        success: true,
        data: {
          exists: false
        }
      });
    });


    it('前後の空白を削除してチェックする', async () => {
      // 空の結果のモック
      const mockQuery = {
        fetchAll: jest.fn().mockResolvedValue({ resources: [] })
      };
      mockItems.query.mockReturnValue(mockQuery);

      // リクエストの作成（前後に空白）
      const request = {
        method: 'GET',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/check-duplicate?name=%20%20桜%20%20&code=test-key',
        query: new Map([
          ['name', '  桜  '],
          ['code', 'test-key']
        ]),
        headers: new Map()
      } as any as HttpRequest;

      // 実行
      const response = await checkDuplicateHandler(request, mockContext);

      // 検証
      expect(mockItems.query).toHaveBeenCalledWith({
        query: expect.any(String),
        parameters: [{ name: '@name', value: '桜' }] // 空白が削除されている
      });
    });
  });

  describe('バリデーションエラー', () => {
    it('nameパラメータが未指定の場合は400エラー', async () => {
      // リクエストの作成（nameなし）
      const request = {
        method: 'GET',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/check-duplicate?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map()
      } as any as HttpRequest;

      // 実行
      const response = await checkDuplicateHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(400);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: '植物名が指定されていません',
          details: 'nameクエリパラメータは必須です'
        }
      });
      expect(mockItems.query).not.toHaveBeenCalled();
    });

    it('nameパラメータが空文字の場合は400エラー', async () => {
      // リクエストの作成（空文字）
      const request = {
        method: 'GET',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/check-duplicate?name=&code=test-key',
        query: new Map([
          ['name', ''],
          ['code', 'test-key']
        ]),
        headers: new Map()
      } as any as HttpRequest;

      // 実行
      const response = await checkDuplicateHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(400);
      expect(response.jsonBody.success).toBe(false);
      expect(response.jsonBody.error.code).toBe('INVALID_REQUEST');
      expect(response.jsonBody.error.message).toBe('植物名が指定されていません');
      expect(mockItems.query).not.toHaveBeenCalled();
    });

    it('nameパラメータが空白のみの場合は400エラー', async () => {
      // リクエストの作成（空白のみ）
      const request = {
        method: 'GET',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/check-duplicate?name=%20%20%20&code=test-key',
        query: new Map([
          ['name', '   '],
          ['code', 'test-key']
        ]),
        headers: new Map()
      } as any as HttpRequest;

      // 実行
      const response = await checkDuplicateHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(400);
      expect(response.jsonBody.success).toBe(false);
      expect(response.jsonBody.error.code).toBe('INVALID_REQUEST');
      expect(response.jsonBody.error.message).toBe('植物名が指定されていません');
      expect(mockItems.query).not.toHaveBeenCalled();
    });
  });

  describe('Cosmos DB エラー', () => {
    it('DB接続エラーの場合は500エラー', async () => {
      // DB接続エラーのモック
      const dbError = new Error('Connection timeout');
      (dbError as any).code = 'ENOTFOUND';
      mockItems.query.mockImplementation(() => {
        throw dbError;
      });

      // リクエストの作成
      const request = {
        method: 'GET',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/check-duplicate?name=桜&code=test-key',
        query: new Map([
          ['name', '桜'],
          ['code', 'test-key']
        ]),
        headers: new Map()
      } as any as HttpRequest;

      // 実行
      const response = await checkDuplicateHandler(request, mockContext);

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

    it('DBクエリエラーの場合は500エラー', async () => {
      // DBクエリエラーのモック
      const queryError = new Error('Query failed');
      const mockQuery = {
        fetchAll: jest.fn().mockRejectedValue(queryError)
      };
      mockItems.query.mockReturnValue(mockQuery);

      // リクエストの作成
      const request = {
        method: 'GET',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/check-duplicate?name=桜&code=test-key',
        query: new Map([
          ['name', '桜'],
          ['code', 'test-key']
        ]),
        headers: new Map()
      } as any as HttpRequest;

      // 実行
      const response = await checkDuplicateHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(500);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: '重複チェックに失敗しました',
          details: 'Query failed'
        }
      });
    });

    it('予期しないエラーの場合は500エラー', async () => {
      // 予期しないエラーのモック（環境変数不足など）
      delete process.env.COSMOS_DB_ENDPOINT;

      // リクエストの作成
      const request = {
        method: 'GET',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/check-duplicate?name=桜&code=test-key',
        query: new Map([
          ['name', '桜'],
          ['code', 'test-key']
        ]),
        headers: new Map()
      } as any as HttpRequest;

      // 実行
      const response = await checkDuplicateHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(500);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: '重複チェックに失敗しました',
          details: expect.any(String)
        }
      });
    });
  });
});