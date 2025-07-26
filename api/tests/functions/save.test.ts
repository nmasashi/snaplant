import { HttpRequest, InvocationContext } from '@azure/functions';
import { savePlantHandler } from '../../src/functions/save';
import { Plant } from '../../src/types/plant';
import { CosmosClient, Database, Container } from '@azure/cosmos';

// 外部依存のみモック
jest.mock('@azure/cosmos');
const MockedCosmosClient = CosmosClient as jest.MockedClass<typeof CosmosClient>;

// UUID生成のモック
jest.mock('uuid', () => ({
  v4: jest.fn(() => '123e4567-e89b-12d3-a456-426614174000')
}));

describe('植物保存API', () => {
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
      read: jest.fn()
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
    it('植物を正常に保存できる', async () => {
      // 重複チェックで既存植物なしのモック
      const mockQuery = {
        fetchAll: jest.fn().mockResolvedValue({ resources: [] })
      };
      mockItems.query.mockReturnValue(mockQuery);

      // 植物作成成功のモック
      const mockCreatedPlant: Plant = {
        id: '123e4567-e89b-12d3-a456-426614174000',
        name: '桜',
        scientificName: 'Prunus serrulata',
        familyName: 'バラ科',
        description: '日本を代表する花木で、春に美しい花を咲かせる。',
        characteristics: '春に美しいピンクの花を咲かせる',
        confidence: 95.5,
        imagePath: 'https://example.com/sakura.jpg',
        createdAt: '2024-01-15T10:30:00Z',
        updatedAt: '2024-01-15T10:30:00Z'
      };

      mockItems.create.mockResolvedValue({ resource: mockCreatedPlant });

      // リクエストの作成
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/save?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        json: jest.fn().mockResolvedValue({
          name: '桜',
          scientificName: 'Prunus serrulata',
          familyName: 'バラ科',
          description: '日本を代表する花木で、春に美しい花を咲かせる。',
          characteristics: '春に美しいピンクの花を咲かせる',
          confidence: 95.5,
          imagePath: 'https://example.com/sakura.jpg'
        })
      } as any as HttpRequest;

      // 実行
      const response = await savePlantHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(201);
      expect(response.jsonBody).toEqual({
        success: true,
        data: {
          plant: mockCreatedPlant
        }
      });

      // 植物作成が呼ばれることを確認（重複チェックはない）

      // 植物作成が呼ばれることを確認
      expect(mockItems.create).toHaveBeenCalledWith(
        expect.objectContaining({
          id: '123e4567-e89b-12d3-a456-426614174000',
          name: '桜',
          scientificName: 'Prunus serrulata',
          familyName: 'バラ科',
          description: '日本を代表する花木で、春に美しい花を咲かせる。',
          characteristics: '春に美しいピンクの花を咲かせる',
          confidence: 95.5,
          imagePath: 'https://example.com/sakura.jpg',
          createdAt: expect.any(String),
          updatedAt: expect.any(String)
        })
      );
    });

    it('最小限のフィールドで植物を保存できる', async () => {
      // 重複チェックで既存植物なしのモック
      const mockQuery = {
        fetchAll: jest.fn().mockResolvedValue({ resources: [] })
      };
      mockItems.query.mockReturnValue(mockQuery);

      // 植物作成成功のモック
      const mockCreatedPlant: Plant = {
        id: '123e4567-e89b-12d3-a456-426614174000',
        name: 'テスト植物',
        characteristics: '基本的な特徴',
        confidence: 80.0,
        imagePath: 'https://example.com/test.jpg',
        createdAt: '2024-01-15T10:30:00Z',
        updatedAt: '2024-01-15T10:30:00Z'
      };

      mockItems.create.mockResolvedValue({ resource: mockCreatedPlant });

      // リクエストの作成（必須フィールドのみ）
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/save?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        json: jest.fn().mockResolvedValue({
          name: 'テスト植物',
          characteristics: '基本的な特徴',
          confidence: 80.0,
          imagePath: 'https://example.com/test.jpg'
        })
      } as any as HttpRequest;

      // 実行
      const response = await savePlantHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(201);
      expect(response.jsonBody.success).toBe(true);
      expect(response.jsonBody.data.plant.name).toBe('テスト植物');
    });
  });

  describe('バリデーションエラー', () => {
    it('必須フィールドが未指定の場合は400エラー', async () => {
      // リクエストの作成（nameなし）
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/save?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        json: jest.fn().mockResolvedValue({
          characteristics: '特徴',
          confidence: 80.0,
          imagePath: 'https://example.com/test.jpg'
        })
      } as any as HttpRequest;

      // 実行
      const response = await savePlantHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(400);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: '植物名が指定されていません',
          details: undefined
        }
      });
      expect(mockItems.create).not.toHaveBeenCalled();
    });

    it('植物名が長すぎる場合は400エラー', async () => {
      // リクエストの作成（長すぎる植物名）
      const longName = 'あ'.repeat(101); // 101文字
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/save?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        json: jest.fn().mockResolvedValue({
          name: longName,
          characteristics: '特徴',
          confidence: 80.0,
          imagePath: 'https://example.com/test.jpg'
        })
      } as any as HttpRequest;

      // 実行
      const response = await savePlantHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(400);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: '植物名は100文字以内で指定してください',
          details: undefined
        }
      });
      expect(mockItems.create).not.toHaveBeenCalled();
    });

    it('信頼度が範囲外の場合は400エラー', async () => {
      // リクエストの作成（信頼度が範囲外）
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/save?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        json: jest.fn().mockResolvedValue({
          name: 'テスト植物',
          characteristics: '特徴',
          confidence: 150.0, // 範囲外
          imagePath: 'https://example.com/test.jpg'
        })
      } as any as HttpRequest;

      // 実行
      const response = await savePlantHandler(request, mockContext);

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
      expect(mockItems.create).not.toHaveBeenCalled();
    });

    // 重複チェックは別途実装されるcheckDuplicate APIで行うため、ここではテストしない

    it('JSONパースエラーの場合は400エラー', async () => {
      // リクエストの作成（JSONパースエラー）
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/save?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        json: jest.fn().mockRejectedValue(new SyntaxError('Unexpected token'))
      } as any as HttpRequest;

      // 実行
      const response = await savePlantHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(400);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'リクエストボディの形式が無効です',
          details: 'JSON形式で送信してください'
        }
      });
    });
  });

  describe('Cosmos DB エラー', () => {
    it('DB接続エラーの場合は503エラー', async () => {
      // DB接続エラーのモック
      const connectionError = new Error('ENOTFOUND');
      (connectionError as any).code = 'ENOTFOUND';
      mockItems.create.mockRejectedValue(connectionError);

      // リクエストの作成
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/save?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        json: jest.fn().mockResolvedValue({
          name: 'テスト植物',
          characteristics: '特徴',
          confidence: 80.0,
          imagePath: 'https://example.com/test.jpg'
        })
      } as any as HttpRequest;

      // 実行
      const response = await savePlantHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(503);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'DATABASE_ERROR',
          message: 'データベースに接続できません',
          details: 'ENOTFOUND'
        }
      });
    });

    it('Cosmos DB制約エラーの場合は409エラー', async () => {
      // Cosmos DB制約エラーのモック
      const conflictError = new Error('Conflict');
      (conflictError as any).code = 409;
      mockItems.create.mockRejectedValue(conflictError);

      // リクエストの作成
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/save?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        json: jest.fn().mockResolvedValue({
          name: 'テスト植物',
          characteristics: '特徴',
          confidence: 80.0,
          imagePath: 'https://example.com/test.jpg'
        })
      } as any as HttpRequest;

      // 実行
      const response = await savePlantHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(409);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'DATABASE_ERROR',
          message: '植物の保存に失敗しました',
          details: 'Conflict'
        }
      });
    });

    it('予期しないエラーの場合は500エラー', async () => {
      // 予期しないエラーのモック（環境変数不足など）
      delete process.env.COSMOS_DB_ENDPOINT;

      // リクエストの作成
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/save?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        json: jest.fn().mockResolvedValue({
          name: 'テスト植物',
          characteristics: '特徴',
          confidence: 80.0,
          imagePath: 'https://example.com/test.jpg'
        })
      } as any as HttpRequest;

      // 実行
      const response = await savePlantHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(500);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: '植物の保存に失敗しました',
          details: expect.any(String)
        }
      });
    });
  });
});