import { InvocationContext, HttpRequest } from '@azure/functions';
import { getPlantsHandler } from '../../src/functions/plants';
import { PlantSummary } from '../../src/types/plant';
import { CosmosClient, Database, Container } from '@azure/cosmos';

// 外部依存のみモック
jest.mock('@azure/cosmos');
const MockedCosmosClient = CosmosClient as jest.MockedClass<typeof CosmosClient>;

describe('植物一覧取得API', () => {
  let mockContext: InvocationContext;
  let mockClient: jest.Mocked<CosmosClient>;
  let mockDatabase: jest.Mocked<Database>;
  let mockContainer: jest.Mocked<Container>;
  let mockItems: any;

  beforeEach(() => {
    // Contextのモック
    mockContext = {
      log: Object.assign(jest.fn(), { error: jest.fn() }),
      res: {}
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
    it('植物一覧を正常に取得できる', async () => {
      // テストデータ
      const mockPlants: PlantSummary[] = [
        {
          id: '123e4567-e89b-12d3-a456-426614174000',
          name: '桜',
          characteristics: '春に美しいピンクの花を咲かせる',
          imagePath: 'https://example.com/sakura.jpg',
          confidence: 95.5,
          createdAt: '2024-01-15T10:30:00Z'
        },
        {
          id: '987fcdeb-51d2-43a8-b456-426614174001',
          name: '梅',
          characteristics: '冬〜早春に芳香のある花を咲かせる',
          imagePath: 'https://example.com/ume.jpg',
          confidence: 89.2,
          createdAt: '2024-01-14T09:15:00Z'
        }
      ];

      // Cosmos DB クエリ成功のモック
      const mockQuery = {
        fetchAll: jest.fn().mockResolvedValue({ resources: mockPlants })
      };
      mockItems.query.mockReturnValue(mockQuery);

      // リクエストの作成
      const request = {
        method: 'GET',
        url: 'https://func-snaplant.azurewebsites.net/api/plants?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map()
      } as any as HttpRequest;

      // 実行
      const response = await getPlantsHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(200);
      expect(response.jsonBody).toEqual({
        success: true,
        data: {
          plants: mockPlants,
          total: 2
        }
      });

      // 並び順（ORDER BY）は検証していない。偽物はSQL文字列を解釈せず
      // fetchAll() の戻り値をそのまま返すだけなので、クエリ文字列を
      // 固定する以外の方法でここから並び順を確認する手段がない。
      // CLAUDE.md の「Cosmosのクエリを変更したら手で確認する」手順に委ねる
    });

    it('植物が存在しない場合は空配列を返す', async () => {
      // Cosmos DB クエリ成功（空の結果）のモック
      const mockQuery = {
        fetchAll: jest.fn().mockResolvedValue({ resources: [] })
      };
      mockItems.query.mockReturnValue(mockQuery);

      // リクエストの作成
      const request = {
        method: 'GET',
        url: 'https://func-snaplant.azurewebsites.net/api/plants?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map()
      } as any as HttpRequest;

      // 実行
      const response = await getPlantsHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(200);
      expect(response.jsonBody).toEqual({
        success: true,
        data: {
          plants: [],
          total: 0
        }
      });
    });
  });

  describe('Cosmos DB エラー', () => {
    it('クエリが同期的に例外を投げ、かつコードを持たない場合は500エラー', async () => {
      // code を持たないエラー。ENOTFOUND・ECONNREFUSEDのいずれにも分類されず、
      // createInternalErrorのフォールバックに落ちる
      // （DB接続エラー自体の経路はENOTFOUND/ECONNREFUSEDで503になる。下のテストで検証する）
      const dbError = new Error('Connection timeout');
      mockItems.query.mockImplementation(() => {
        throw dbError;
      });

      // リクエストの作成
      const request = {
        method: 'GET',
        url: 'https://func-snaplant.azurewebsites.net/api/plants?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map()
      } as any as HttpRequest;

      // 実行
      const response = await getPlantsHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(500);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: '植物一覧の取得に失敗しました',
          details: 'Connection timeout'
        }
      });
    });

    it('DB接続エラー（ENOTFOUND）の場合は503エラー', async () => {
      // ENOTFOUND はCosmos DB関連エラーの分岐に該当し、503として扱われる
      const dbError = new Error('getaddrinfo ENOTFOUND');
      (dbError as any).code = 'ENOTFOUND';
      mockItems.query.mockImplementation(() => {
        throw dbError;
      });

      // リクエストの作成
      const request = {
        method: 'GET',
        url: 'https://func-snaplant.azurewebsites.net/api/plants?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map()
      } as any as HttpRequest;

      // 実行
      const response = await getPlantsHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(503);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'DATABASE_ERROR',
          message: 'データベースに接続できません',
          details: 'getaddrinfo ENOTFOUND'
        }
      });
    });

    it('DB クエリエラーの場合は500エラー', async () => {
      // DB クエリエラーのモック
      const queryError = new Error('Query failed');
      const mockQuery = {
        fetchAll: jest.fn().mockRejectedValue(queryError)
      };
      mockItems.query.mockReturnValue(mockQuery);

      // リクエストの作成
      const request = {
        method: 'GET',
        url: 'https://func-snaplant.azurewebsites.net/api/plants?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map()
      } as any as HttpRequest;

      // 実行
      const response = await getPlantsHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(500);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: '植物一覧の取得に失敗しました',
          details: 'Query failed'
        }
      });
    });

    it('予期しないエラーの場合は500エラー', async () => {
      // 環境変数不足のシミュレーション
      delete process.env.COSMOS_DB_ENDPOINT;

      // リクエストの作成
      const request = {
        method: 'GET',
        url: 'https://func-snaplant.azurewebsites.net/api/plants?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map()
      } as any as HttpRequest;

      // 実行
      const response = await getPlantsHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(500);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: '植物一覧の取得に失敗しました',
          details: expect.any(String)
        }
      });
    });
  });
});