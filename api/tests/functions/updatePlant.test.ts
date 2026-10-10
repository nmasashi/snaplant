import { HttpRequest, InvocationContext } from '@azure/functions';
import { updatePlantHandler } from '../../src/functions/updatePlant';
import { CosmosClient, Container } from '@azure/cosmos';
import { BlobServiceClient, BlockBlobClient } from '@azure/storage-blob';
import { Plant } from '../../src/types/plant';

// 外部依存のみモック
jest.mock('@azure/cosmos');
const MockedCosmosClient = CosmosClient as jest.MockedClass<typeof CosmosClient>;

// updatePlant() が内部で構築するStorageServiceが使うBlob SDKもこのファイル内でモックする。
// tests/setup.ts のグローバルモックの getBlockBlobClient() には delete が無く、
// それに頼ると旧画像削除がTypeErrorになってCosmosService内のcatchに飲み込まれてしまう
// （console.warnも抑制されるため気づけない）。削除が実際に成功・失敗する経路を
// どちらも通せるよう、delete を持つ偽物に差し替える
jest.mock('@azure/storage-blob', () => ({
  BlobServiceClient: { fromConnectionString: jest.fn() },
  BlobSASPermissions: jest.fn().mockImplementation(() => ({})),
  StorageSharedKeyCredential: jest.fn().mockImplementation(() => ({})),
  generateBlobSASQueryParameters: jest.fn()
}));
const MockedBlobServiceClient = BlobServiceClient as jest.MockedClass<typeof BlobServiceClient>;

// StorageService.isValidImagePath() が有効と判定するために必要な自ストレージ設定。
// tests/setup.ts のグローバル値と偶然一致させるのではなく、このファイル内で
// 完結させる（beforeEach で process.env に設定する）
const TEST_STORAGE_CONNECTION_STRING = 'DefaultEndpointsProtocol=https;AccountName=test;AccountKey=testkey==;EndpointSuffix=core.windows.net';
const TEST_STORAGE_CONTAINER_NAME = 'test-images';
const TEST_IMAGE_BASE_URL = `https://test.blob.core.windows.net/${TEST_STORAGE_CONTAINER_NAME}`;

/**
 * 偽物のCosmos DBバックエンド（cosmosService.test.ts の FakeCosmosBackend と同型）。
 *
 * updatePlantHandler が実際に使うのは container.item(id, id) の read と replace だけ
 * （一覧取得や作成は無関係）なので、この2つだけを持つ最小構成にする。
 *
 * read だけは実SDKに合わせてNotFoundを例外にしない。@azure/cosmos の
 * Item.read() はNotFoundを内部で飲み込み、resourceが無いレスポンスを返す
 * （cosmosService.test.ts の同種コメント参照）。replace はそのまま例外を投げる。
 */
interface FakeCosmosBackend {
  documents: Map<string, Plant>;
  forcedReadError: Error | null;
}

function notFoundError(): any {
  const err: any = new Error('NotFound');
  err.code = 404;
  return err;
}

function createFakeContainer(backend: FakeCosmosBackend): Container {
  return {
    item: (id: string, partitionKey: string) => ({
      read: async () => {
        if (backend.forcedReadError) throw backend.forcedReadError;
        if (id !== partitionKey || !backend.documents.has(id)) {
          return { resource: undefined };
        }
        return { resource: backend.documents.get(id) };
      },
      replace: async (doc: Plant) => {
        if (id !== partitionKey || !backend.documents.has(id)) throw notFoundError();
        backend.documents.set(id, doc);
        return { resource: doc };
      }
    })
  } as unknown as Container;
}

/** 偽物のBlobバックエンド（cosmosService.test.ts の FakeBlobBackend と同型） */
interface BlobEntry {
  content: Buffer;
  failWith?: Error;
}

interface FakeBlobBackend {
  store: Map<string, BlobEntry>;
}

function notFoundBlobError(): any {
  const err: any = new Error('BlobNotFound');
  err.statusCode = 404;
  return err;
}

function createFakeBlockBlobClient(backend: FakeBlobBackend, containerName: string, blobName: string): BlockBlobClient {
  const key = `${containerName}/${blobName}`;

  return {
    delete: async () => {
      const entry = backend.store.get(key);
      if (!entry) throw notFoundBlobError();
      if (entry.failWith) throw entry.failWith;
      backend.store.delete(key);
      return {};
    }
  } as unknown as BlockBlobClient;
}

function createFakeBlobServiceClient(backend: FakeBlobBackend): BlobServiceClient {
  return {
    getContainerClient: (containerName: string) => ({
      getBlockBlobClient: (blobName: string) => createFakeBlockBlobClient(backend, containerName, blobName)
    })
  } as unknown as BlobServiceClient;
}

describe('植物更新API', () => {
  let mockContext: InvocationContext;
  let cosmosBackend: FakeCosmosBackend;
  let blobStore: Map<string, BlobEntry>;

  beforeEach(() => {
    // InvocationContextのモック
    mockContext = {
      log: jest.fn()
    } as any;

    // Cosmos DBの偽物バックエンド
    cosmosBackend = { documents: new Map(), forcedReadError: null };
    const fakeContainer = createFakeContainer(cosmosBackend);
    MockedCosmosClient.mockImplementation(() => ({
      database: () => ({
        container: () => fakeContainer
      })
    } as unknown as CosmosClient));

    // Blobの偽物バックエンド
    blobStore = new Map();
    MockedBlobServiceClient.fromConnectionString = jest.fn().mockReturnValue(
      createFakeBlobServiceClient({ store: blobStore })
    );

    // 環境変数設定
    process.env.COSMOS_DB_ENDPOINT = 'https://test.documents.azure.com:443/';
    process.env.COSMOS_DB_KEY = 'test-key';
    process.env.COSMOS_DB_DATABASE = 'test-db';
    process.env.COSMOS_DB_CONTAINER = 'test-container';
    // imagePathのバリデーション（StorageService.isValidImagePath）と
    // 旧画像削除（StorageService.deleteImage）に使う
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
        imagePath: `${TEST_IMAGE_BASE_URL}/old.jpg`,
        createdAt: '2024-01-15T10:30:00Z',
        updatedAt: '2024-01-15T10:30:00Z'
      };
      cosmosBackend.documents.set(existingPlant.id, existingPlant);

      // リクエストの作成
      const request = {
        method: 'PUT',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/123e4567-e89b-12d3-a456-426614174000?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        params: { id: '123e4567-e89b-12d3-a456-426614174000' },
        json: jest.fn().mockResolvedValue({
          imagePath: `${TEST_IMAGE_BASE_URL}/new.jpg`,
          confidence: 95.0
        })
      } as any as HttpRequest;

      // 実行
      const response = await updatePlantHandler(request, mockContext);

      // 検証（レスポンス。updatedAtは更新処理内で現在時刻から生成されるため形式のみ検証）
      expect(response.status).toBe(200);
      expect(response.jsonBody).toEqual({
        success: true,
        data: {
          plant: {
            ...existingPlant,
            imagePath: `${TEST_IMAGE_BASE_URL}/new.jpg`,
            confidence: 95.0,
            updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
          }
        }
      });

      // 検証（実際に永続化された内容。replace呼び出しの引数ではなく
      // 偽物バックエンドに保存された状態そのものを確認する）
      expect(cosmosBackend.documents.get(existingPlant.id)).toEqual({
        ...existingPlant,
        imagePath: `${TEST_IMAGE_BASE_URL}/new.jpg`,
        confidence: 95.0,
        updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      });
    });

    it('信頼度が上限ちょうど(100)の場合は更新に成功する', async () => {
      // 既存植物のモック
      const existingPlant: Plant = {
        id: '123e4567-e89b-12d3-a456-426614174000',
        name: '桜',
        characteristics: '春に美しいピンクの花を咲かせる',
        confidence: 85.0,
        imagePath: `${TEST_IMAGE_BASE_URL}/old.jpg`,
        createdAt: '2024-01-15T10:30:00Z',
        updatedAt: '2024-01-15T10:30:00Z'
      };
      cosmosBackend.documents.set(existingPlant.id, existingPlant);

      // リクエストの作成（信頼度は上限ちょうど。上限超過ではないので受理される）
      const request = {
        method: 'PUT',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/123e4567-e89b-12d3-a456-426614174000?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        params: { id: '123e4567-e89b-12d3-a456-426614174000' },
        json: jest.fn().mockResolvedValue({
          imagePath: `${TEST_IMAGE_BASE_URL}/new.jpg`,
          confidence: 100
        })
      } as any as HttpRequest;

      // 実行
      const response = await updatePlantHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(200);
      expect(response.jsonBody.success).toBe(true);
      expect(response.jsonBody.data.plant.confidence).toBe(100);
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
          imagePath: `${TEST_IMAGE_BASE_URL}/new.jpg`,
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
          imagePath: `${TEST_IMAGE_BASE_URL}/new.jpg`,
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
    });

    it('画像パスが自ストレージアカウント以外のホストを指す場合は400エラー', async () => {
      // 既存植物のモック（バリデーションが機能していない場合に更新まで
      // 進んでしまうことを明確に判別するため、更新処理が成功しうる状態
      // ——既存ドキュメント——を用意する）
      const existingPlant: Plant = {
        id: '123e4567-e89b-12d3-a456-426614174000',
        name: '桜',
        scientificName: 'Prunus serrulata',
        familyName: 'バラ科',
        description: '日本を代表する花木',
        characteristics: '春に美しいピンクの花を咲かせる',
        confidence: 85.0,
        imagePath: `${TEST_IMAGE_BASE_URL}/old.jpg`,
        createdAt: '2024-01-15T10:30:00Z',
        updatedAt: '2024-01-15T10:30:00Z'
      };
      cosmosBackend.documents.set(existingPlant.id, existingPlant);

      // リクエストの作成（imagePathが自アカウント以外のホストを指す。
      // URLとしては正しくパースできるが、他レコードのBlobを指し得る。
      // コンテナ名はあえて永続コンテナ（test-images）と一致させている。
      // 一致しない値（例: foo）だとコンテナ名の不一致だけで400になり、
      // ホスト検証を削除してもこのテストは落ちなくなる）
      const request = {
        method: 'PUT',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/123e4567-e89b-12d3-a456-426614174000?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        params: { id: '123e4567-e89b-12d3-a456-426614174000' },
        json: jest.fn().mockResolvedValue({
          imagePath: 'https://example.com/test-images/123e4567-e89b-12d3-a456-426614174000.jpg',
          confidence: 90.0
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
          message: '画像アップロードAPIが返したURLを指定してください',
          details: undefined
        }
      });
      // 更新されていないことの状態検証（ドキュメントが変化していない）
      expect(cosmosBackend.documents.get(existingPlant.id)).toEqual(existingPlant);
    });
  });

  describe('植物が見つからない場合', () => {
    it('存在しない植物IDの場合は404エラー', async () => {
      // リクエストの作成（cosmosBackend.documents は空のまま。該当IDが無い状態）
      const request = {
        method: 'PUT',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/123e4567-e89b-12d3-a456-426614174000?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        params: { id: '123e4567-e89b-12d3-a456-426614174000' },
        json: jest.fn().mockResolvedValue({
          imagePath: `${TEST_IMAGE_BASE_URL}/new.jpg`,
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
      cosmosBackend.forcedReadError = dbError;

      // リクエストの作成
      const request = {
        method: 'PUT',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/123e4567-e89b-12d3-a456-426614174000?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        params: { id: '123e4567-e89b-12d3-a456-426614174000' },
        json: jest.fn().mockResolvedValue({
          imagePath: `${TEST_IMAGE_BASE_URL}/new.jpg`,
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
      cosmosBackend.forcedReadError = new Error('Unexpected error');

      // リクエストの作成
      const request = {
        method: 'PUT',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/123e4567-e89b-12d3-a456-426614174000?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        params: { id: '123e4567-e89b-12d3-a456-426614174000' },
        json: jest.fn().mockResolvedValue({
          imagePath: `${TEST_IMAGE_BASE_URL}/new.jpg`,
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
    it('画像URLが変更された場合、旧画像を削除する', async () => {
      // 既存植物データのモック
      const existingPlant: Plant = {
        id: '123e4567-e89b-12d3-a456-426614174000',
        name: '桜',
        characteristics: '春に美しいピンクの花を咲かせる',
        imagePath: `${TEST_IMAGE_BASE_URL}/old-image.jpg`,
        confidence: 85.0,
        createdAt: '2024-01-10T14:20:00Z',
        updatedAt: '2024-01-10T14:20:00Z'
      };
      cosmosBackend.documents.set(existingPlant.id, existingPlant);
      // 旧画像削除が実際に成功する経路を通すため、対応するBlobも存在させておく
      blobStore.set(`${TEST_STORAGE_CONTAINER_NAME}/old-image.jpg`, { content: Buffer.from('old') });

      // リクエストの作成
      const request = {
        method: 'PUT',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/123e4567-e89b-12d3-a456-426614174000?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        params: { id: '123e4567-e89b-12d3-a456-426614174000' },
        json: jest.fn().mockResolvedValue({
          imagePath: `${TEST_IMAGE_BASE_URL}/new-image.jpg`,
          confidence: 95.0
        })
      } as any as HttpRequest;

      // 実行
      const response = await updatePlantHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(200);
      expect(response.jsonBody.success).toBe(true);
      expect(response.jsonBody.data.plant.imagePath).toBe(`${TEST_IMAGE_BASE_URL}/new-image.jpg`);

      // 旧画像がBlobストアから消えたことの状態検証
      expect(blobStore.has(`${TEST_STORAGE_CONTAINER_NAME}/old-image.jpg`)).toBe(false);
    });
  });
});
