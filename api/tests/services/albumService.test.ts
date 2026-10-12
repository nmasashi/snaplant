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
    jest.useRealTimers();
    jest.clearAllMocks();
    delete process.env.COSMOS_DB_ENDPOINT;
    delete process.env.COSMOS_DB_KEY;
    delete process.env.COSMOS_DB_DATABASE;
    delete process.env.COSMOS_DB_ALBUM_CONTAINER;
  });

  describe('createTrip', () => {
    it('旅行を作ると、前後の空白を除いた名前・タグ空・作成日時と更新日時が同じ値で、旅行として保存される', async () => {
      // 時刻だけを固定する。他のタイマーまで偽物にすると非同期処理が止まりうる
      jest.useFakeTimers({
        now: new Date('2026-10-12T03:04:05.000Z'),
        doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'setTimeout', 'setInterval']
      });
      const service = new AlbumService();

      const trip = await service.createTrip({ name: '  北海道 2026秋  ', description: null });

      // id は uuid が乱数で作るため、形式だけを確かめる（uuid パッケージはモックしても効かない）
      const uuid = expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(trip).toEqual({
        id: uuid,
        name: '北海道 2026秋',
        description: null,
        tags: [],
        createdAt: '2026-10-12T03:04:05.000Z',
        updatedAt: '2026-10-12T03:04:05.000Z',
      });
      expect(Array.from(cosmosBackend.documents.values())).toEqual([
        {
          id: uuid,
          type: 'trip',
          name: '北海道 2026秋',
          description: null,
          tags: [],
          createdAt: '2026-10-12T03:04:05.000Z',
          updatedAt: '2026-10-12T03:04:05.000Z',
        },
      ]);
      // 戻り値の id で保存されていること
      expect(Array.from(cosmosBackend.documents.keys())).toEqual([trip.id]);
    });
  });

  describe('updateTrip', () => {
    it('旅行を更新すると、名前・説明・更新日時だけが変わり、タグと作成日時は変わらない', async () => {
      const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      cosmosBackend.documents.set(id, {
        id,
        type: 'trip',
        name: '京都旅行',
        description: null,
        tags: ['国内'],
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      });
      // 時刻だけを固定する。他のタイマーまで偽物にすると非同期処理が止まりうる
      jest.useFakeTimers({
        now: new Date('2026-10-12T03:04:05.000Z'),
        doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'setTimeout', 'setInterval']
      });
      const service = new AlbumService();

      const trip = await service.updateTrip(id, { name: '  新しい名前  ', description: 'メモ' });

      expect(cosmosBackend.documents.get(id)).toEqual({
        id,
        type: 'trip',
        name: '新しい名前',
        description: 'メモ',
        tags: ['国内'],
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-12T03:04:05.000Z',
      });
      expect(trip).toEqual({
        id,
        name: '新しい名前',
        description: 'メモ',
        tags: ['国内'],
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-12T03:04:05.000Z',
      });
    });
  });

  describe('listTrips', () => {
    it('旅行の一覧は旅行だけを返し、写真のドキュメントは混ざらない', async () => {
      const base = { type: 'trip' as const, description: null, tags: [], createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' };
      cosmosBackend.documents.set('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', { ...base, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: '京都旅行' });
      cosmosBackend.documents.set('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', { ...base, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: '札幌旅行' });
      // 写真は旅行ではないので、他の項目は最小限にする
      cosmosBackend.documents.set('p1', { id: 'p1', type: 'photo', tripId: null } as unknown as TripDocument);
      const service = new AlbumService();

      const result = await service.listTrips();

      // 並び順は ORDER BY によるもので偽物では見られないため、順序に依存せず比べる
      expect(result.trips.map((t) => ({ id: t.id, name: t.name }))).toEqual(
        expect.arrayContaining([
          { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: '京都旅行' },
          { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: '札幌旅行' },
        ])
      );
      expect(result.trips).toHaveLength(2);
    });
  });

  describe('更新した旅行の項目', () => {
    it('更新した旅行に、データベースの内部の項目と種別が含まれない', async () => {
      const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      // Cosmos DB が保存時に付けるシステム項目も含めて置く
      cosmosBackend.documents.set(id, {
        id,
        type: 'trip',
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
      } as TripDocument);
      const service = new AlbumService();

      const trip = await service.updateTrip(id, { name: '新しい名前', description: null });

      expect(Object.keys(trip!).sort()).toEqual(['createdAt', 'description', 'id', 'name', 'tags', 'updatedAt']);
    });
  });

  describe('取り出した旅行の項目', () => {
    it.each([
      ['getTrip', async (service: AlbumService) => [await service.getTrip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')]],
      ['listTrips', async (service: AlbumService) => (await service.listTrips()).trips],
    ])('%sで取り出した旅行に、データベースの内部の項目と種別が含まれない', async (_name, fetchTrips) => {
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

      const trips = await fetchTrips(service);

      expect(Object.keys(trips[0]!).sort()).toEqual([
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
      ]);
    });
  });
});
