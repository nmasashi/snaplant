import { HttpRequest, InvocationContext } from '@azure/functions';
import { checkDuplicateHandler } from '../../src/functions/checkDuplicate';
import { CosmosClient } from '@azure/cosmos';
import { FakeCosmosBackend, FakeCosmosDocument, createFakeContainer } from '../fakes/cosmos';

// 外部依存のみモック
jest.mock('@azure/cosmos');
const MockedCosmosClient = CosmosClient as jest.MockedClass<typeof CosmosClient>;

// CosmosServiceが内部でStorageServiceを構築するために必要な自ストレージ設定。
// tests/setup.ts のグローバル値に暗黙依存せず、このファイル内で完結させる
const TEST_STORAGE_CONNECTION_STRING = 'DefaultEndpointsProtocol=https;AccountName=test;AccountKey=testkey==;EndpointSuffix=core.windows.net';
const TEST_STORAGE_CONTAINER_NAME = 'test-images';

/**
 * このAPIが返すのは一覧表示用の射影（SELECTの列指定）なので、保存済みのドキュメントがPlant全体でも、
 * 応答に出るのはこの5項目だけ。偽物はSELECTの射影を解釈しないため、保存済みのドキュメントに
 * 余分な項目（scientificName・updatedAt）を持たせたテストで、サービスが5項目に詰め替えていることを見る
 */
interface DuplicateCheckDocument extends FakeCosmosDocument {
  confidence: number;
  createdAt: string;
  scientificName?: string;
  updatedAt?: string;
}


describe('植物重複チェックAPI', () => {
  let mockContext: InvocationContext;
  let cosmosBackend: FakeCosmosBackend<DuplicateCheckDocument>;

  beforeEach(() => {
    // InvocationContextのモック
    mockContext = {
      log: jest.fn()
    } as any;

    // Cosmos DB SDKを引数を見分ける偽物に差し替える
    cosmosBackend = {
      documents: new Map(),
      forcedQueryError: null
    };
    const container = createFakeContainer(cosmosBackend);
    MockedCosmosClient.mockImplementation(() => ({
      database: () => ({ container: () => container })
    }) as any);

    // 環境変数設定
    process.env.COSMOS_DB_ENDPOINT = 'https://test.documents.azure.com:443/';
    process.env.COSMOS_DB_KEY = 'test-key';
    process.env.COSMOS_DB_DATABASE = 'test-db';
    process.env.COSMOS_DB_CONTAINER = 'test-container';
    // CosmosServiceが内部で構築するStorageServiceに使う
    process.env.STORAGE_CONNECTION_STRING = TEST_STORAGE_CONNECTION_STRING;
    process.env.STORAGE_CONTAINER_NAME = TEST_STORAGE_CONTAINER_NAME;
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete process.env.COSMOS_DB_ENDPOINT;
    delete process.env.COSMOS_DB_KEY;
    delete process.env.COSMOS_DB_DATABASE;
    delete process.env.COSMOS_DB_CONTAINER;
    delete process.env.STORAGE_CONNECTION_STRING;
    delete process.env.STORAGE_CONTAINER_NAME;
  });

  describe('正常系', () => {
    it('重複する植物が存在する場合', async () => {
      // 既存植物のモック。別名の植物も登録しておき、
      // 検索対象（桜）だけが絞り込まれて返ることをレスポンスで確認する。
      // 保存済みのドキュメントは応答にない項目（scientificName・updatedAt）も持つ
      const existingPlant = {
        id: '123e4567-e89b-12d3-a456-426614174000',
        name: '桜',
        scientificName: 'Prunus serrulata',
        imagePath: 'https://example.com/sakura.jpg',
        confidence: 85.0,
        createdAt: '2024-01-15T10:30:00Z',
        updatedAt: '2024-01-16T08:00:00Z'
      };
      const otherPlant = {
        id: '987fcdeb-51d2-43a8-b456-426614174001',
        name: '梅',
        imagePath: 'https://example.com/ume.jpg',
        confidence: 90.0,
        createdAt: '2024-01-14T09:15:00Z'
      };

      [existingPlant, otherPlant].forEach((d) => cosmosBackend.documents.set(d.id, d));

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
      [
        { id: 'id-1', name: '桜', imagePath: 'https://example.com/sakura.jpg', confidence: 85.0, createdAt: '2024-01-15T10:30:00Z' },
        { id: 'id-2', name: '梅', imagePath: 'https://example.com/ume.jpg', confidence: 90.0, createdAt: '2024-01-14T09:15:00Z' }
      ].forEach((d) => cosmosBackend.documents.set(d.id, d));

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
      [
        { id: 'id-1', name: '桜', imagePath: 'https://example.com/sakura.jpg', confidence: 85.0, createdAt: '2024-01-15T10:30:00Z' },
        { id: 'id-2', name: '梅', imagePath: 'https://example.com/ume.jpg', confidence: 90.0, createdAt: '2024-01-14T09:15:00Z' }
      ].forEach((d) => cosmosBackend.documents.set(d.id, d));

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
    it('DB接続エラーの場合は503エラー', async () => {
      // DB接続エラーのモック
      const dbError = new Error('Connection timeout');
      (dbError as any).code = 'ENOTFOUND';
      cosmosBackend.forcedQueryError = dbError;

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
      cosmosBackend.forcedQueryError = queryError;

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
  });
});