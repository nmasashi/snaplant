import { HttpRequest, InvocationContext } from '@azure/functions';
import { checkDuplicateHandler } from '../../src/functions/checkDuplicate';
import { CosmosClient, Database, Container } from '@azure/cosmos';

// 外部依存のみモック
jest.mock('@azure/cosmos');
const MockedCosmosClient = CosmosClient as jest.MockedClass<typeof CosmosClient>;

/**
 * @name パラメータの値で絞り込む偽のクエリ実装。
 * cosmosService.test.ts の FakeCosmosBackend と同じ考え方で、
 * 渡されたパラメータの値を見て絞り込む。これにより「正しい名前で
 * 絞り込まれていること」を呼び出し検証ではなくレスポンスの内容で確認できる
 * （誤った名前・固定値が渡されると、絞り込み結果が変わってレスポンスの
 * アサーションが失敗する）。
 */
function createFilteringQueryMock(documents: Array<Record<string, any>>) {
  return jest.fn((querySpec: any) => {
    const parameters = typeof querySpec === 'string' ? [] : (querySpec.parameters ?? []);
    const nameParam = parameters.find((p: any) => p.name === '@name')?.value;
    const docs = nameParam !== undefined
      ? documents.filter((d) => d.name === nameParam)
      : documents;
    return {
      fetchAll: async () => ({ resources: docs })
    };
  });
}

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
      // 既存植物のモック。別名の植物も登録しておき、
      // 検索対象（桜）だけが絞り込まれて返ることをレスポンスで確認する
      const existingPlant = {
        id: '123e4567-e89b-12d3-a456-426614174000',
        name: '桜',
        imagePath: 'https://example.com/sakura.jpg',
        confidence: 85.0,
        createdAt: '2024-01-15T10:30:00Z'
      };
      const otherPlant = {
        id: '987fcdeb-51d2-43a8-b456-426614174001',
        name: '梅',
        imagePath: 'https://example.com/ume.jpg',
        confidence: 90.0,
        createdAt: '2024-01-14T09:15:00Z'
      };

      mockItems.query = createFilteringQueryMock([existingPlant, otherPlant]);

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

      // 検証（別名の植物ではなく、検索対象の植物が返ること）
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
    });

    it('重複する植物が存在しない場合', async () => {
      // 他の植物は登録されているが、検索対象と同名の植物は無い状態
      mockItems.query = createFilteringQueryMock([
        { id: 'id-1', name: '桜', imagePath: 'https://example.com/sakura.jpg', confidence: 85.0, createdAt: '2024-01-15T10:30:00Z' },
        { id: 'id-2', name: '梅', imagePath: 'https://example.com/ume.jpg', confidence: 90.0, createdAt: '2024-01-14T09:15:00Z' }
      ]);

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
      // 空白を含まない別名の植物（梅）も登録しておく。前後の空白が
      // 削除されずに渡ると「  梅  」に一致するものがなく exists: false に
      // なるため、絞り込み結果で空白除去を確認できる
      mockItems.query = createFilteringQueryMock([
        { id: 'id-1', name: '桜', imagePath: 'https://example.com/sakura.jpg', confidence: 85.0, createdAt: '2024-01-15T10:30:00Z' },
        { id: 'id-2', name: '梅', imagePath: 'https://example.com/ume.jpg', confidence: 90.0, createdAt: '2024-01-14T09:15:00Z' }
      ]);

      // リクエストの作成（前後に空白）
      const request = {
        method: 'GET',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/check-duplicate?name=%20%20%E6%A2%85%20%20&code=test-key',
        query: new Map([
          ['name', '  梅  '],
          ['code', 'test-key']
        ]),
        headers: new Map()
      } as any as HttpRequest;

      // 実行
      const response = await checkDuplicateHandler(request, mockContext);

      // 検証（空白が削除された上で「梅」に絞り込まれ、一致する植物が返る）
      expect(response.status).toBe(200);
      expect(response.jsonBody).toEqual({
        success: true,
        data: {
          exists: true,
          plant: {
            id: 'id-2',
            name: '梅',
            imagePath: 'https://example.com/ume.jpg',
            confidence: 90.0,
            createdAt: '2024-01-14T09:15:00Z'
          }
        }
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