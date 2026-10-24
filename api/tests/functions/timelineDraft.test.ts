import { HttpRequest, InvocationContext } from '@azure/functions';
import { CosmosClient } from '@azure/cosmos';
import { BlobServiceClient, generateBlobSASQueryParameters } from '@azure/storage-blob';
import { deleteTimelineDraftHandler, getTimelineDraftHandler } from '../../src/functions/timelineDraft';
import { FakeCosmosBackend, FakeCosmosDocument, createFakeContainer } from '../fakes/cosmos';
import { FakeBlobBackend, TEST_BLOB_HOST, createFakeBlobServiceClient } from '../fakes/blob';
import { photoDocument, tripDocument } from '../helpers/albumDocuments';
import { databaseFailureCases } from '../helpers/databaseFailures';

// タイムラインの下書き（段階5。docs/05_api_design.md §5.15、文書は 04 §1.6）。
// 外部依存のみモック。Cosmos DB は状態持ちの偽物。SAS の署名は固定のトークンを返す形に差し替える
jest.mock('@azure/cosmos');
jest.mock('@azure/storage-blob', () => ({
  BlobServiceClient: { fromConnectionString: jest.fn() },
  BlobSASPermissions: jest.fn().mockImplementation(() => ({})),
  StorageSharedKeyCredential: jest.fn().mockImplementation(() => ({})),
  generateBlobSASQueryParameters: jest.fn()
}));

const MockedCosmosClient = CosmosClient as jest.MockedClass<typeof CosmosClient>;
const MockedBlobServiceClient = BlobServiceClient as jest.MockedClass<typeof BlobServiceClient>;
const mockedGenerateSas = generateBlobSASQueryParameters as jest.MockedFunction<typeof generateBlobSASQueryParameters>;

const TRIP_ID = '123e4567-e89b-42d3-a456-426614174000';
const TIMELINE_ID = `timeline-${TRIP_ID}`;
const SNAPSHOT_ID = `timeline-photos-${TRIP_ID}-22222222-2222-4222-8222-222222222222`;
const DRAFT_ID = '33333333-3333-4333-8333-333333333333';
const NOW = '2026-10-25T09:00:00.000Z';
const SAS = 'sig=test';

// 写真の id（SHA-256 の16進）。取り違えを見分けられるよう、先頭の文字だけ変える
const photoId = (head: string): string => head.repeat(64);

/** 控えの1枚。撮影日時と、確かめに使う項目だけを指定する */
const snap = (head: string, takenAt: string | null, overrides: Record<string, unknown> = {}) => ({
  id: photoId(head),
  takenAt,
  category: 'landscape',
  name: null,
  placeName: null,
  comment: null,
  blobName: `${photoId(head)}.jpg`,
  thumbnailBlobName: `${photoId(head)}.thumb.jpg`,
  ...overrides
});

/** 控えの1枚の、応答での形 */
const shown = (head: string, takenAt: string | null, overrides: Record<string, unknown> = {}) => {
  const { comment: _comment, blobName: _blobName, thumbnailBlobName, ...fields } = snap(head, takenAt, overrides) as any;
  const thumbnail = thumbnailBlobName ?? `${photoId(head)}.jpg`;
  return { ...fields, thumbnailUrl: `https://${TEST_BLOB_HOST}/photos/${thumbnail}?${SAS}` };
};

const draftOf = (overrides: Record<string, unknown> = {}) => ({
  id: DRAFT_ID,
  reason: 'create',
  phase: 'reviewing',
  job: null,
  snapshotId: SNAPSHOT_ID,
  dayStartHour: 4,
  proposedStarts: [],
  sceneStarts: [],
  startedAt: '2026-10-25T08:50:00.000Z',
  ...overrides
});

const timelineWith = (draft: unknown, current: unknown = null) => ({
  id: TIMELINE_ID,
  type: 'timeline',
  tripId: TRIP_ID,
  current,
  draft,
  droppedEdits: [],
  createdAt: '2026-10-25T08:50:00.000Z',
  updatedAt: '2026-10-25T08:55:00.000Z'
});

const createRequest = (tripId: string, method = 'GET'): HttpRequest =>
  ({
    method,
    url: `https://func-snaplant.azurewebsites.net/api/trips/${tripId}/timeline/draft?code=test-key`,
    query: new Map([['code', 'test-key']]),
    headers: new Map(),
    params: { tripId }
  }) as any as HttpRequest;

describe('タイムラインの下書きAPI', () => {
  let mockContext: InvocationContext;
  let cosmosBackend: FakeCosmosBackend<FakeCosmosDocument>;

  /** 控えを置き、控えの写真のうち、まだある写真を写真の文書として置く */
  const placeSnapshot = (photos: ReturnType<typeof snap>[], removed: string[] = []) => {
    cosmosBackend.documents.set(SNAPSHOT_ID, {
      id: SNAPSHOT_ID,
      type: 'timelinePhotos',
      tripId: TRIP_ID,
      photos,
      createdAt: '2026-10-25T08:50:00.000Z'
    } as any);
    for (const photo of photos) {
      if (!removed.includes(photo.id)) {
        cosmosBackend.documents.set(photo.id, photoDocument(photo.id, { tripId: TRIP_ID, takenAt: photo.takenAt }));
      }
    }
  };

  beforeEach(() => {
    jest.useFakeTimers({
      now: new Date(NOW),
      doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'setTimeout', 'setInterval']
    });
    mockContext = { log: jest.fn() } as any;

    cosmosBackend = { documents: new Map() };
    const fakeContainer = createFakeContainer(cosmosBackend);
    MockedCosmosClient.mockImplementation(() => ({
      database: () => ({ container: () => fakeContainer })
    }) as unknown as CosmosClient);

    const blobBackend: FakeBlobBackend = { store: new Map() };
    MockedBlobServiceClient.fromConnectionString = jest.fn().mockReturnValue(createFakeBlobServiceClient(blobBackend));
    mockedGenerateSas.mockReturnValue({ toString: () => SAS } as any);

    process.env.COSMOS_DB_ENDPOINT = 'https://test.documents.azure.com:443/';
    process.env.COSMOS_DB_KEY = 'test-key';
    process.env.COSMOS_DB_DATABASE = 'test-db';
    process.env.COSMOS_DB_ALBUM_CONTAINER = 'test-album';
    process.env.STORAGE_CONNECTION_STRING =
      'DefaultEndpointsProtocol=https;AccountName=test;AccountKey=testkey==;EndpointSuffix=core.windows.net';
    process.env.PHOTO_STORAGE_CONTAINER_NAME = 'photos';
    process.env.PHOTO_SAS_EXPIRY_MINUTES = '60';

    cosmosBackend.documents.set(TRIP_ID, tripDocument(TRIP_ID, '北海道 2026秋'));
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  describe('下書きを読む（GET）', () => {
    it('タイムラインが無ければ、下書きは null', async () => {
      const response = await getTimelineDraftHandler(createRequest(TRIP_ID), mockContext);

      expect(response.status).toBe(200);
      expect(response.jsonBody).toEqual({ success: true, data: { draft: null, urlExpiresAt: '2026-10-25T10:00:00.000Z' } });
    });

    it('完成版だけで下書きが無ければ、下書きは null', async () => {
      cosmosBackend.documents.set(TIMELINE_ID, timelineWith(null, { snapshotId: SNAPSHOT_ID }) as any);

      const response = await getTimelineDraftHandler(createRequest(TRIP_ID), mockContext);

      expect((response.jsonBody as any).data.draft).toBeNull();
    });

    it('区切り案を作っている下書きは、状態だけを返す（日と場面は返さない）', async () => {
      placeSnapshot([snap('a', '2026-10-05T07:50:00')]);
      cosmosBackend.documents.set(
        TIMELINE_ID,
        timelineWith(
          draftOf({
            phase: 'proposing',
            job: { step: 'propose', state: 'running', attempts: 1, lastError: 'ai', updatedAt: '2026-10-25T08:59:00.000Z' }
          })
        ) as any
      );

      const response = await getTimelineDraftHandler(createRequest(TRIP_ID), mockContext);

      expect(response.status).toBe(200);
      expect((response.jsonBody as any).data.draft).toEqual({
        id: DRAFT_ID,
        reason: 'create',
        phase: 'proposing',
        job: { step: 'propose', state: 'running', lastError: 'ai' },
        startedAt: '2026-10-25T08:50:00.000Z'
      });
    });

    it('確かめ中の下書きは、日ごと・場面ごとに写真を並べて返す（日付の切り替えは朝4時、日時なしは最後）', async () => {
      placeSnapshot([
        // 1日目: 朝ごはん（AI の区切り）と午前（利用者が足した区切り）。深夜 2:30 の写真は前の日（1日目）に入る
        snap('a', '2026-10-05T07:50:00', { category: 'food', name: '海鮮丼', placeName: '北海道千歳市' }),
        snap('b', '2026-10-05T07:58:00', { category: 'food', name: '海鮮丼', placeName: '北海道千歳市', thumbnailBlobName: null }),
        snap('c', '2026-10-05T10:10:00', { name: '小樽運河', placeName: '北海道小樽市' }),
        snap('d', '2026-10-06T02:30:00', { name: 'すすきの', placeName: '北海道札幌市' }),
        // 3日目（写真の無い日を挟む）: 日の最初の写真は、区切りの一覧に無くても場面の始まり
        snap('e', '2026-10-07T09:10:00', { category: 'food', name: '醤油ラーメン', placeName: '北海道旭川市' }),
        snap('f', null, { category: 'other' })
      ]);
      cosmosBackend.documents.set(
        TIMELINE_ID,
        timelineWith(draftOf({ proposedStarts: [photoId('a')], sceneStarts: [photoId('a'), photoId('c')] })) as any
      );

      const response = await getTimelineDraftHandler(createRequest(TRIP_ID), mockContext);

      expect(response.status).toBe(200);
      expect((response.jsonBody as any).data.draft).toEqual({
        id: DRAFT_ID,
        reason: 'create',
        phase: 'reviewing',
        job: null,
        startedAt: '2026-10-25T08:50:00.000Z',
        days: [
          {
            date: '2026-10-05',
            dayNumber: 1,
            scenes: [
              {
                startPhotoId: photoId('a'),
                startedBy: 'day',
                hasFood: true,
                firstTakenAt: '2026-10-05T07:50:00',
                lastTakenAt: '2026-10-05T07:58:00',
                placeNames: ['北海道千歳市'],
                names: ['海鮮丼'],
                photos: [
                  shown('a', '2026-10-05T07:50:00', { category: 'food', name: '海鮮丼', placeName: '北海道千歳市' }),
                  shown('b', '2026-10-05T07:58:00', { category: 'food', name: '海鮮丼', placeName: '北海道千歳市', thumbnailBlobName: null })
                ]
              },
              {
                startPhotoId: photoId('c'),
                startedBy: 'user',
                hasFood: false,
                firstTakenAt: '2026-10-05T10:10:00',
                lastTakenAt: '2026-10-06T02:30:00',
                placeNames: ['北海道小樽市', '北海道札幌市'],
                names: ['小樽運河', 'すすきの'],
                photos: [
                  shown('c', '2026-10-05T10:10:00', { name: '小樽運河', placeName: '北海道小樽市' }),
                  shown('d', '2026-10-06T02:30:00', { name: 'すすきの', placeName: '北海道札幌市' })
                ]
              }
            ]
          },
          {
            date: '2026-10-07',
            dayNumber: 3,
            scenes: [
              {
                startPhotoId: photoId('e'),
                startedBy: 'day',
                hasFood: true,
                firstTakenAt: '2026-10-07T09:10:00',
                lastTakenAt: '2026-10-07T09:10:00',
                placeNames: ['北海道旭川市'],
                names: ['醤油ラーメン'],
                photos: [shown('e', '2026-10-07T09:10:00', { category: 'food', name: '醤油ラーメン', placeName: '北海道旭川市' })]
              }
            ]
          }
        ],
        undatedPhotos: [shown('f', null, { category: 'other' })]
      });
    });

    it('控えを取った後に消えた写真は出さず、写真が全部消えた場面と日も出さない', async () => {
      placeSnapshot(
        [
          snap('a', '2026-10-05T07:50:00'),
          snap('b', '2026-10-05T10:00:00'),
          snap('c', '2026-10-05T10:30:00'),
          snap('d', '2026-10-06T09:00:00'),
          snap('e', null)
        ],
        [photoId('a'), photoId('c'), photoId('d'), photoId('e')]
      );
      cosmosBackend.documents.set(
        TIMELINE_ID,
        timelineWith(draftOf({ proposedStarts: [photoId('a'), photoId('b')], sceneStarts: [photoId('a'), photoId('b')] })) as any
      );

      const response = await getTimelineDraftHandler(createRequest(TRIP_ID), mockContext);

      const draft = (response.jsonBody as any).data.draft;
      expect(draft.days).toHaveLength(1);
      expect(draft.days[0].scenes.map((scene: any) => [scene.startPhotoId, scene.startedBy, scene.photos.map((p: any) => p.id)])).toEqual([
        [photoId('b'), 'ai', [photoId('b')]]
      ]);
      expect(draft.undatedPhotos).toEqual([]);
    });

    it('日付の切り替えの時刻は、下書きに書いた値を使う（0 なら日付どおり）', async () => {
      placeSnapshot([snap('a', '2026-10-05T22:00:00'), snap('b', '2026-10-06T02:30:00')]);
      cosmosBackend.documents.set(TIMELINE_ID, timelineWith(draftOf({ dayStartHour: 0 })) as any);

      const response = await getTimelineDraftHandler(createRequest(TRIP_ID), mockContext);

      const days = (response.jsonBody as any).data.draft.days;
      expect(days.map((day: any) => [day.date, day.dayNumber, day.scenes[0].startPhotoId])).toEqual([
        ['2026-10-05', 1, photoId('a')],
        ['2026-10-06', 2, photoId('b')]
      ]);
    });

    it('旅行が無ければ、404（TRIP_NOT_FOUND）を返す', async () => {
      cosmosBackend.documents.delete(TRIP_ID);

      const response = await getTimelineDraftHandler(createRequest(TRIP_ID), mockContext);

      expect(response.status).toBe(404);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'TRIP_NOT_FOUND', message: '指定された旅行が見つかりません' } });
    });

    it('旅行IDがUUIDの形でなければ、400を返す', async () => {
      const response = await getTimelineDraftHandler(createRequest('not-a-uuid'), mockContext);

      expect(response.status).toBe(400);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'INVALID_REQUEST', message: '旅行IDの形式が無効です' } });
    });

    it.each(databaseFailureCases('タイムラインの取得に失敗しました'))('タイムラインを読むときに%s', async (_case, error, status, code, message) => {
      cosmosBackend.forcedReadError = error;

      const response = await getTimelineDraftHandler(createRequest(TRIP_ID), mockContext);

      expect(response.status).toBe(status);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code, message } });
    });
  });
  describe('下書きをやめる（DELETE）', () => {
    const CURRENT_SNAPSHOT_ID = `timeline-photos-${TRIP_ID}-11111111-1111-4111-8111-111111111111`;
    const currentVersion = {
      snapshotId: CURRENT_SNAPSHOT_ID,
      dayStartHour: 4,
      proposedStarts: [],
      sceneStarts: [],
      sceneTexts: {},
      dayTexts: {},
      writtenAt: '2026-10-08T12:14:00.000Z'
    };
    const snapshotDocument = (id: string) => ({ id, type: 'timelinePhotos', tripId: TRIP_ID, photos: [], createdAt: '2026-10-08T12:10:00.000Z' });
    const storedSnapshotIds = () =>
      [...cosmosBackend.documents.values()].filter((doc) => doc.type === 'timelinePhotos').map((doc) => doc.id).sort();

    it('完成版の無い下書きをやめると、タイムラインの文書ごと消え、下書きの控えも消える', async () => {
      cosmosBackend.documents.set(SNAPSHOT_ID, snapshotDocument(SNAPSHOT_ID) as any);
      cosmosBackend.documents.set(TIMELINE_ID, timelineWith(draftOf()) as any);

      const response = await deleteTimelineDraftHandler(createRequest(TRIP_ID, 'DELETE'), mockContext);

      expect(response.status).toBe(200);
      expect(response.jsonBody).toEqual({ success: true, data: { draft: null } });
      expect(cosmosBackend.documents.has(TIMELINE_ID)).toBe(false);
      expect(storedSnapshotIds()).toEqual([]);
    });

    it('作り直しの下書きをやめると、下書きだけが消え、完成版とその控えは残る', async () => {
      cosmosBackend.documents.set(SNAPSHOT_ID, snapshotDocument(SNAPSHOT_ID) as any);
      cosmosBackend.documents.set(CURRENT_SNAPSHOT_ID, snapshotDocument(CURRENT_SNAPSHOT_ID) as any);
      cosmosBackend.documents.set(TIMELINE_ID, timelineWith(draftOf({ reason: 'rebuild' }), currentVersion) as any);

      const response = await deleteTimelineDraftHandler(createRequest(TRIP_ID, 'DELETE'), mockContext);

      expect(response.status).toBe(200);
      expect(cosmosBackend.documents.get(TIMELINE_ID)).toEqual({ ...timelineWith(null, currentVersion), updatedAt: NOW });
      expect(storedSnapshotIds()).toEqual([CURRENT_SNAPSHOT_ID]);
    });

    it('完成版の区切りを直している途中（recut）の下書きをやめても、完成版と同じ控えは消さない', async () => {
      cosmosBackend.documents.set(CURRENT_SNAPSHOT_ID, snapshotDocument(CURRENT_SNAPSHOT_ID) as any);
      cosmosBackend.documents.set(
        TIMELINE_ID,
        timelineWith(draftOf({ reason: 'recut', snapshotId: CURRENT_SNAPSHOT_ID }), currentVersion) as any
      );

      await deleteTimelineDraftHandler(createRequest(TRIP_ID, 'DELETE'), mockContext);

      expect(cosmosBackend.documents.get(TIMELINE_ID)).toMatchObject({ draft: null, current: currentVersion });
      expect(storedSnapshotIds()).toEqual([CURRENT_SNAPSHOT_ID]);
    });

    it('作っている途中の下書きでもやめられる', async () => {
      cosmosBackend.documents.set(SNAPSHOT_ID, snapshotDocument(SNAPSHOT_ID) as any);
      cosmosBackend.documents.set(
        TIMELINE_ID,
        timelineWith(
          draftOf({ phase: 'proposing', job: { step: 'propose', state: 'running', attempts: 1, lastError: null, updatedAt: '2026-10-25T08:59:00.000Z' } })
        ) as any
      );

      const response = await deleteTimelineDraftHandler(createRequest(TRIP_ID, 'DELETE'), mockContext);

      expect(response.status).toBe(200);
      expect(cosmosBackend.documents.has(TIMELINE_ID)).toBe(false);
    });

    it.each([
      ['タイムラインが無い', null],
      ['完成版だけで下書きが無い', 'current-only']
    ])('%sときは、404（TIMELINE_NOT_FOUND）を返す', async (_label, existing) => {
      if (existing) cosmosBackend.documents.set(TIMELINE_ID, timelineWith(null, currentVersion) as any);

      const response = await deleteTimelineDraftHandler(createRequest(TRIP_ID, 'DELETE'), mockContext);

      expect(response.status).toBe(404);
      expect(response.jsonBody).toMatchObject({
        success: false,
        error: { code: 'TIMELINE_NOT_FOUND', message: 'タイムラインの下書きが見つかりません' }
      });
    });

    it('読んでから書くまでに他の操作がタイムラインを書いたら、409（TIMELINE_STATE_CONFLICT）で、何も消さない', async () => {
      cosmosBackend.documents.set(SNAPSHOT_ID, snapshotDocument(SNAPSHOT_ID) as any);
      cosmosBackend.documents.set(CURRENT_SNAPSHOT_ID, snapshotDocument(CURRENT_SNAPSHOT_ID) as any);
      cosmosBackend.documents.set(TIMELINE_ID, timelineWith(draftOf({ reason: 'rebuild' }), currentVersion) as any);
      const written = timelineWith(draftOf({ reason: 'rebuild', sceneStarts: [photoId('a')] }), currentVersion);
      cosmosBackend.beforeReplace = (id) => {
        if (id === TIMELINE_ID) cosmosBackend.documents.set(TIMELINE_ID, { ...written } as any);
      };

      const response = await deleteTimelineDraftHandler(createRequest(TRIP_ID, 'DELETE'), mockContext);

      expect(response.status).toBe(409);
      expect(response.jsonBody).toMatchObject({
        success: false,
        error: { code: 'TIMELINE_STATE_CONFLICT', message: 'タイムラインが変わったか、作っている途中です。読み直してください' }
      });
      expect(cosmosBackend.documents.get(TIMELINE_ID)).toEqual(written);
      expect(storedSnapshotIds()).toEqual([CURRENT_SNAPSHOT_ID, SNAPSHOT_ID].sort());
    });

    it('旅行が無ければ、404（TRIP_NOT_FOUND）を返す', async () => {
      cosmosBackend.documents.delete(TRIP_ID);

      const response = await deleteTimelineDraftHandler(createRequest(TRIP_ID, 'DELETE'), mockContext);

      expect(response.status).toBe(404);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'TRIP_NOT_FOUND' } });
    });

    it('旅行IDがUUIDの形でなければ、400を返す', async () => {
      const response = await deleteTimelineDraftHandler(createRequest('not-a-uuid', 'DELETE'), mockContext);

      expect(response.status).toBe(400);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'INVALID_REQUEST', message: '旅行IDの形式が無効です' } });
    });

    it.each(databaseFailureCases('タイムラインの更新に失敗しました'))('タイムラインを読むときに%s', async (_case, error, status, code, message) => {
      cosmosBackend.forcedReadError = error;

      const response = await deleteTimelineDraftHandler(createRequest(TRIP_ID, 'DELETE'), mockContext);

      expect(response.status).toBe(status);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code, message } });
    });
  });
});
