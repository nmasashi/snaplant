import { HttpRequest, InvocationContext } from '@azure/functions';
import { getPlantByIdHandler, deletePlantHandler } from '../../src/functions/plantDetail';
import { Plant } from '../../src/types/plant';
import { CosmosClient, Container } from '@azure/cosmos';
import { BlobServiceClient, BlockBlobClient } from '@azure/storage-blob';

// 外部依存のみモック
jest.mock('@azure/cosmos');
const MockedCosmosClient = CosmosClient as jest.MockedClass<typeof CosmosClient>;

// deletePlant() が内部で構築するStorageServiceが使うBlob SDKもこのファイル内でモックする。
// tests/setup.ts のグローバルモックの getBlockBlobClient() には delete が無く、
// それに頼ると画像削除がTypeErrorになってCosmosService内のcatchに飲み込まれてしまう
// （console.warnも抑制されるため気づけない）。削除が実際に成功する経路を通すため、
// delete を持つ偽物に差し替える
jest.mock('@azure/storage-blob', () => ({
  BlobServiceClient: { fromConnectionString: jest.fn() },
  BlobSASPermissions: jest.fn().mockImplementation(() => ({})),
  StorageSharedKeyCredential: jest.fn().mockImplementation(() => ({})),
  generateBlobSASQueryParameters: jest.fn()
}));
const MockedBlobServiceClient = BlobServiceClient as jest.MockedClass<typeof BlobServiceClient>;

// deletePlant() が内部で構築するStorageServiceの接続文字列解析に必要な自ストレージ設定。
// tests/setup.ts のグローバル値と偶然一致させるのではなく、このファイル内で
// 完結させる（beforeEach で process.env に設定する）
const TEST_STORAGE_CONNECTION_STRING = 'DefaultEndpointsProtocol=https;AccountName=test;AccountKey=testkey==;EndpointSuffix=core.windows.net';
const TEST_STORAGE_CONTAINER_NAME = 'test-images';
const TEST_IMAGE_BASE_URL = `https://test.blob.core.windows.net/${TEST_STORAGE_CONTAINER_NAME}`;

/**
 * 偽物のCosmos DBバックエンド（cosmosService.test.ts の FakeCosmosBackend と同型）。
 *
 * このファイルが使うのは container.item(id, id) の read と delete だけ
 * （一覧取得や作成は無関係）なので、この2つだけを持つ最小構成にする。
 *
 * read だけは実SDKに合わせてNotFoundを例外にしない。@azure/cosmos の
 * Item.read() はNotFoundを内部で飲み込み、resourceが無いレスポンスを返す
 * （cosmosService.test.ts の同種コメント参照）。delete はそのまま例外を投げる。
 */
interface FakeCosmosBackend {
  documents: Map<string, Plant>;
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
        if (id !== partitionKey || !backend.documents.has(id)) {
          return { resource: undefined };
        }
        return { resource: backend.documents.get(id) };
      },
      delete: async () => {
        if (id !== partitionKey || !backend.documents.has(id)) throw notFoundError();
        backend.documents.delete(id);
        return { resource: { id } };
      }
    })
  } as unknown as Container;
}

/** 偽物のBlobバックエンド（updatePlant.test.ts の FakeBlobBackend と同型。delete のみ使う） */
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

describe('植物詳細取得API', () => {
  let mockContext: InvocationContext;
  let cosmosBackend: FakeCosmosBackend;
  let blobStore: Map<string, BlobEntry>;

  beforeEach(() => {
    // InvocationContextのモック
    mockContext = {
      log: Object.assign(jest.fn(), { error: jest.fn() }),
      error: jest.fn()
    } as any;

    // Cosmos DBの偽物バックエンド
    cosmosBackend = { documents: new Map() };
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
    // deletePlant()が内部で構築するStorageServiceに使う
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
      cosmosBackend.documents.set(validPlantId, mockPlant);

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
    });

    it('存在しない植物IDの場合は404エラー', async () => {
      // リクエストの作成（cosmosBackend.documents は空のまま。該当IDが無い状態）
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
    });
  });

  describe('DELETE /api/plants/{id} - 植物削除', () => {
    const validPlantId = '123e4567-e89b-12d3-a456-426614174000';

    it('植物を正常に削除できる', async () => {
      // 削除対象のドキュメントを用意する（imagePathを持つ。deletePlant()は
      // ドキュメント削除前にimagePathを読み、削除後にその画像も削除する）
      const existingPlant: Plant = {
        id: validPlantId,
        name: '桜',
        characteristics: '春に美しい花を咲かせる',
        confidence: 95.5,
        imagePath: `${TEST_IMAGE_BASE_URL}/sakura.jpg`,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z'
      };
      cosmosBackend.documents.set(validPlantId, existingPlant);
      // 画像削除が実際に成功する経路を通すため、対応するBlobも存在させておく
      blobStore.set('test-images/sakura.jpg', { content: Buffer.from('dummy') });

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

      // 検証（レスポンス）
      expect(response.status).toBe(200);
      expect(response.jsonBody).toEqual({
        success: true,
        data: {
          message: '植物が正常に削除されました'
        }
      });
      // 検証（ドキュメントが消えたことの状態検証。delete呼び出しの引数ではなく、
      // 実際にバックエンドから無くなったかどうかを確認する）
      expect(cosmosBackend.documents.has(validPlantId)).toBe(false);
      // 検証（画像も削除されたことの状態検証）
      expect(blobStore.has('test-images/sakura.jpg')).toBe(false);
    });

    it('画像削除に失敗してもドキュメント削除は成功扱いになる', async () => {
      // 削除対象のドキュメントを用意する（imagePathを持つ）
      const existingPlant: Plant = {
        id: validPlantId,
        name: '桜',
        characteristics: '春に美しい花を咲かせる',
        confidence: 95.5,
        imagePath: `${TEST_IMAGE_BASE_URL}/sakura.jpg`,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z'
      };
      cosmosBackend.documents.set(validPlantId, existingPlant);
      // 画像削除が失敗する状態を用意する（updatePlant.test.ts の同種テストと同型）
      blobStore.set('test-images/sakura.jpg', {
        content: Buffer.from('dummy'),
        failWith: new Error('Blob delete failed')
      });

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

      // 検証（画像削除の失敗はログ出力のみで、ドキュメント削除は成功扱いになる）
      expect(response.status).toBe(200);
      expect(response.jsonBody).toEqual({
        success: true,
        data: {
          message: '植物が正常に削除されました'
        }
      });
      // 検証（ドキュメントは削除されている）
      expect(cosmosBackend.documents.has(validPlantId)).toBe(false);
      // 検証（画像削除が失敗しているため、Blobストアには残ったままになる）
      expect(blobStore.has('test-images/sakura.jpg')).toBe(true);
    });

    it('存在しない植物IDの場合は404エラー', async () => {
      // リクエストの作成（cosmosBackend.documents は空のまま。該当IDが無い状態。
      // read はNotFoundを飲み込んでresourceなしを返し、delete は例外を投げる
      // ——どちらも実SDKの挙動に合わせた偽物の既定動作）
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
