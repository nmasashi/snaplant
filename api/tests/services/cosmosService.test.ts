import { CosmosService } from '../../src/services/cosmosService';
import { Plant } from '../../src/types/plant';
import { CosmosClient } from '@azure/cosmos';
import { BlobServiceClient } from '@azure/storage-blob';
import { FakeCosmosBackend, createFakeContainer } from '../fakes/cosmos';
import { BlobEntry, createFakeBlobServiceClient } from '../fakes/blob';

// 外部依存のみモック。
// StorageServiceはCosmosServiceと同じプロセスで動く自前のクラスなのでモックしない
// （CosmosServiceが内部でnewするため、実物のStorageServiceを使い、その先の
// Blob SDKだけを偽物に差し替える。storageService.test.tsと同じ構成）
jest.mock('@azure/cosmos');
jest.mock('@azure/storage-blob', () => ({
  BlobServiceClient: { fromConnectionString: jest.fn() },
  BlobSASPermissions: jest.fn().mockImplementation(() => ({})),
  StorageSharedKeyCredential: jest.fn().mockImplementation(() => ({})),
  generateBlobSASQueryParameters: jest.fn()
}));

const MockedCosmosClient = jest.mocked(CosmosClient);
const MockedBlobServiceClient = BlobServiceClient as jest.MockedClass<typeof BlobServiceClient>;

// CosmosService の大半（委譲・詰め替え・エラーの伝播・旧画像の削除の発火）は、
// ハンドラのテスト（save / updatePlant / plantDetail / checkDuplicate / plants）が
// 同じ偽物を通して見ている。ここに残っているのは、ハンドラのテストからは見えない
// 更新を許す項目の絞り込み（ハンドラ側でも絞っているので、ハンドラのテストではサービス側の絞り込みが見えない）だけ
describe('CosmosService', () => {
  let service: CosmosService;
  let cosmosBackend: FakeCosmosBackend;
  let blobStore: Map<string, BlobEntry>;

  beforeEach(() => {
    cosmosBackend = {
      documents: new Map(),
      forcedCreateError: null,
      forcedReadError: null,
      forcedReplaceError: null,
      forcedDeleteError: null,
      forcedQueryError: null
    };
    const fakeContainer = createFakeContainer(cosmosBackend);
    MockedCosmosClient.mockImplementation(() => ({
      database: () => ({
        container: () => fakeContainer
      })
    } as unknown as CosmosClient));

    blobStore = new Map();
    MockedBlobServiceClient.fromConnectionString = jest.fn().mockReturnValue(
      createFakeBlobServiceClient({ store: blobStore })
    );

    // 環境変数設定（Cosmos用 + StorageService実物を構築するためのBlob用）
    process.env.COSMOS_DB_ENDPOINT = 'https://test.documents.azure.com:443/';
    process.env.COSMOS_DB_KEY = 'test-key';
    process.env.COSMOS_DB_DATABASE = 'test-db';
    process.env.COSMOS_DB_CONTAINER = 'test-container';
    process.env.STORAGE_CONNECTION_STRING = 'DefaultEndpointsProtocol=https;AccountName=test;AccountKey=testkey==;EndpointSuffix=core.windows.net';
    process.env.STORAGE_CONTAINER_NAME = 'test-images';
    process.env.TEMP_STORAGE_CONTAINER_NAME = 'test-temp';

    service = new CosmosService();
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete process.env.COSMOS_DB_ENDPOINT;
    delete process.env.COSMOS_DB_KEY;
    delete process.env.COSMOS_DB_DATABASE;
    delete process.env.COSMOS_DB_CONTAINER;
    delete process.env.STORAGE_CONNECTION_STRING;
    delete process.env.STORAGE_CONTAINER_NAME;
    delete process.env.TEMP_STORAGE_CONTAINER_NAME;
  });

  describe('updatePlant', () => {
    const plantId = '123e4567-e89b-12d3-a456-426614174000';
    const existingPlant: Plant = {
      id: plantId,
      name: '桜',
      scientificName: 'Prunus serrulata',
      familyName: 'バラ科',
      characteristics: '春に美しい花を咲かせる',
      confidence: 95.5,
      imagePath: 'https://test.blob.core.windows.net/test-images/old-sakura.jpg',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z'
    };

    it('更新対象の2項目以外（nameやcreatedAt）が渡されても、保存済みのnameとcreatedAtは変わらない', async () => {
      // 型は実行時に何も保証しない。HTTPのボディ由来の余分な項目が紛れ込んだ状況を、
      // 変数経由で渡すことで再現する
      cosmosBackend.documents.set(plantId, existingPlant);
      const bodyWithExtraFields = {
        imagePath: 'https://test.blob.core.windows.net/test-images/old-sakura.jpg',
        confidence: 98.0,
        name: '乗っ取られた名前',
        createdAt: '1999-12-31T00:00:00.000Z'
      };

      await service.updatePlant(plantId, bodyWithExtraFields);

      expect(cosmosBackend.documents.get(plantId)).toMatchObject({
        name: '桜',
        createdAt: '2024-01-01T00:00:00.000Z',
        confidence: 98.0
      });
    });
  });
});
