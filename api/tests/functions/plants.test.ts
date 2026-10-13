import { InvocationContext, HttpRequest } from '@azure/functions';
import { getPlantsHandler } from '../../src/functions/plants';
import { PlantSummary } from '../../src/types/plant';
import { CosmosClient } from '@azure/cosmos';
import { FakeCosmosBackend, createFakeContainer } from '../fakes/cosmos';

// 外部依存のみモック
jest.mock('@azure/cosmos');
const MockedCosmosClient = CosmosClient as jest.MockedClass<typeof CosmosClient>;

// CosmosServiceが内部でStorageServiceを構築するために必要な自ストレージ設定。
// tests/setup.ts のグローバル値に暗黙依存せず、このファイル内で完結させる
const TEST_STORAGE_CONNECTION_STRING = 'DefaultEndpointsProtocol=https;AccountName=test;AccountKey=testkey==;EndpointSuffix=core.windows.net';
const TEST_STORAGE_CONTAINER_NAME = 'test-images';

describe('植物一覧取得API', () => {
  let mockContext: InvocationContext;
  let cosmosBackend: FakeCosmosBackend<PlantSummary>;

  beforeEach(() => {
    // Contextのモック
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

      mockPlants.forEach((p) => cosmosBackend.documents.set(p.id, p));

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
      // ドキュメントを1件も入れない（偽物は空配列を返す）

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
    it('DB接続エラー（ENOTFOUND）の場合は503エラー', async () => {
      // ENOTFOUND はCosmos DB関連エラーの分岐に該当し、503として扱われる
      const dbError = new Error('getaddrinfo ENOTFOUND');
      (dbError as any).code = 'ENOTFOUND';
      cosmosBackend.forcedQueryError = dbError;

      // リクエストの作成
      const request = {
        method: 'GET',
        url: 'https://func-snaplant.azurewebsites.net/api/plants?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map()
      } as any as HttpRequest;

      // 実行
      const response = await getPlantsHandler(request, mockContext);

      // 検証（detailsは契約外なので固定しない）
      expect(response.status).toBe(503);
      expect(response.jsonBody).toMatchObject({
        success: false,
        error: {
          code: 'DATABASE_ERROR',
          message: 'データベースに接続できません'
        }
      });
    });

    it('DB クエリエラーの場合は500エラー', async () => {
      // DB クエリエラーのモック
      const queryError = new Error('Query failed');
      cosmosBackend.forcedQueryError = queryError;

      // リクエストの作成
      const request = {
        method: 'GET',
        url: 'https://func-snaplant.azurewebsites.net/api/plants?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map()
      } as any as HttpRequest;

      // 実行
      const response = await getPlantsHandler(request, mockContext);

      // 検証（detailsは契約外なので固定しない）
      expect(response.status).toBe(500);
      expect(response.jsonBody).toMatchObject({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: '植物一覧の取得に失敗しました'
        }
      });
    });
  });
});