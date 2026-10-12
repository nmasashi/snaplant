import { CosmosClient } from '@azure/cosmos';
import { TripDocument } from '../../src/types/album';
import { AlbumService } from '../../src/services/albumService';
import { FakeCosmosBackend, createFakeContainer } from '../fakes/cosmos';

// 外部依存のみモック
jest.mock('@azure/cosmos');
const MockedCosmosClient = CosmosClient as jest.MockedClass<typeof CosmosClient>;

describe('AlbumService', () => {
  let cosmosBackend: FakeCosmosBackend<TripDocument>;

  beforeEach(() => {
    cosmosBackend = { documents: new Map() };
    const container = createFakeContainer(cosmosBackend);
    MockedCosmosClient.mockImplementation(() => ({
      database: () => ({ container: () => container })
    }) as any);

    process.env.COSMOS_DB_ENDPOINT = 'https://test.documents.azure.com:443/';
    process.env.COSMOS_DB_KEY = 'test-key';
    process.env.COSMOS_DB_DATABASE = 'test-db';
    process.env.COSMOS_DB_ALBUM_CONTAINER = 'test-album';
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete process.env.COSMOS_DB_ENDPOINT;
    delete process.env.COSMOS_DB_KEY;
    delete process.env.COSMOS_DB_DATABASE;
    delete process.env.COSMOS_DB_ALBUM_CONTAINER;
  });

  // Cosmos DB が保存時に付けるシステム項目（_rid など）と種別（type）が応答に漏れないことは、
  // ハンドラのテストの偽物が付けない項目なので、ここでだけ見られる。
  // 名前の trim・更新日時・一覧が旅行だけを返すことは、ハンドラのテスト（trips / tripDetail）が見ている
  const tripKeys = ['createdAt', 'description', 'id', 'name', 'tags', 'updatedAt'];
  const tripSummaryKeys = [
    'coverThumbnailUrl',
    'createdAt',
    'description',
    'firstTakenAt',
    'id',
    'lastTakenAt',
    'name',
    'photoCount',
    'tags',
    'updatedAt',
  ];

  it.each([
    [
      'updateTrip',
      async (service: AlbumService) => (await service.updateTrip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', { name: '新しい名前', description: null }))!,
      tripKeys,
    ],
    [
      'getTrip',
      async (service: AlbumService) => (await service.getTrip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'))!,
      tripSummaryKeys,
    ],
    [
      'listTrips',
      async (service: AlbumService) => (await service.listTrips()).trips[0]!,
      tripSummaryKeys,
    ],
  ])('%sで返した旅行に、データベースの内部の項目と種別が含まれない', async (_name, fetchTrip, expectedKeys) => {
    // Cosmos DB が保存時に付けるシステム項目も含めて置く
    const stored = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      type: 'trip' as const,
      name: '京都旅行',
      description: null,
      tags: [],
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      _rid: 'rid',
      _self: 'dbs/x/colls/y/docs/z/',
      _etag: '"0000"',
      _attachments: 'attachments/',
      _ts: 1760000000,
    };
    cosmosBackend.documents.set(stored.id, stored);
    const service = new AlbumService();

    const trip = await fetchTrip(service);

    expect(Object.keys(trip).sort()).toEqual(expectedKeys);
  });
});
