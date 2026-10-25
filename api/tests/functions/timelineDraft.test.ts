import { HttpRequest, InvocationContext } from '@azure/functions';
import { CosmosClient } from '@azure/cosmos';
import { BlobServiceClient, generateBlobSASQueryParameters } from '@azure/storage-blob';
import { QueueClient } from '@azure/storage-queue';
import {
  deleteTimelineDraftHandler,
  getTimelineDraftHandler,
  postTimelineDraftWriteHandler,
  putTimelineDraftScenesHandler
} from '../../src/functions/timelineDraft';
import { FakeCosmosBackend, FakeCosmosDocument, createFakeContainer } from '../fakes/cosmos';
import { FakeBlobBackend, TEST_BLOB_HOST, createFakeBlobServiceClient } from '../fakes/blob';
import { FakeQueueBackend, createFakeQueueClient, decodeQueueMessage } from '../fakes/queue';
import {
  photoDocument,
  timelineCurrent,
  timelineDocument,
  timelineDraft,
  timelinePhotosDocument,
  tripDocument
} from '../helpers/albumDocuments';
import { TimelineDocument, TimelineDraft, TimelinePhotoSnapshot } from '../../src/types/timeline';
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
jest.mock('@azure/storage-queue', () => ({ QueueClient: jest.fn() }));

const MockedCosmosClient = CosmosClient as jest.MockedClass<typeof CosmosClient>;
const MockedBlobServiceClient = BlobServiceClient as jest.MockedClass<typeof BlobServiceClient>;
const mockedGenerateSas = generateBlobSASQueryParameters as jest.MockedFunction<typeof generateBlobSASQueryParameters>;
const MockedQueueClient = QueueClient as jest.MockedClass<typeof QueueClient>;

const TRIP_ID = '123e4567-e89b-42d3-a456-426614174000';
const TIMELINE_ID = `timeline-${TRIP_ID}`;
const SNAPSHOT_ID = `timeline-photos-${TRIP_ID}-22222222-2222-4222-8222-222222222222`;
const CURRENT_SNAPSHOT_ID = `timeline-photos-${TRIP_ID}-11111111-1111-4111-8111-111111111111`;
const DRAFT_ID = '33333333-3333-4333-8333-333333333333';
const NOW = '2026-10-25T09:00:00.000Z';
const SAS = 'sig=test';

// 写真の id（SHA-256 の16進）。取り違えを見分けられるよう、先頭の文字だけ変える
const photoId = (head: string): string => head.repeat(64);

/** 控えの1枚。撮影日時と、確かめに使う項目だけを指定する */
const snap = (head: string, takenAt: string | null, overrides: Partial<TimelinePhotoSnapshot> = {}): TimelinePhotoSnapshot => ({
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
const shown = (head: string, takenAt: string | null, overrides: Partial<TimelinePhotoSnapshot> = {}) => {
  const { comment: _comment, blobName: _blobName, thumbnailBlobName, ...fields } = snap(head, takenAt, overrides);
  const thumbnail = thumbnailBlobName ?? `${photoId(head)}.jpg`;
  return { ...fields, thumbnailUrl: `https://${TEST_BLOB_HOST}/photos/${thumbnail}?${SAS}` };
};

/** 下書き（既定は確かめ中で、区切りは無い） */
const draftOf = (overrides: Partial<TimelineDraft> = {}) =>
  timelineDraft(DRAFT_ID, SNAPSHOT_ID, { startedAt: '2026-10-25T08:50:00.000Z', ...overrides });

/** 完成版（文は確かめに使わない形だけ） */
const currentVersion = timelineCurrent(CURRENT_SNAPSHOT_ID);

const timelineWith = (draft: TimelineDraft | null, current: TimelineDocument['current'] = null) =>
  timelineDocument(TRIP_ID, { current, draft });

/** 下書きが無い状態（タイムラインが無いときと、完成版だけのとき）。下書きを読む・やめる・区切りを保存するで同じ扱い（05 §5.15） */
const noDraftCases: [string, TimelineDocument[]][] = [
  ['タイムラインが無い', []],
  ['完成版だけで下書きが無い', [timelineWith(null, currentVersion)]]
];

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
  const placeSnapshot = (photos: TimelinePhotoSnapshot[], removed: string[] = []) => {
    cosmosBackend.documents.set(SNAPSHOT_ID, timelinePhotosDocument(SNAPSHOT_ID, TRIP_ID, photos));
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
    it.each(noDraftCases)('%sときは、下書きは null', async (_label, timelines) => {
      timelines.forEach((doc) => cosmosBackend.documents.set(doc.id, doc));

      const response = await getTimelineDraftHandler(createRequest(TRIP_ID), mockContext);

      expect(response.status).toBe(200);
      expect(response.jsonBody).toEqual({ success: true, data: { draft: null, urlExpiresAt: '2026-10-25T10:00:00.000Z' } });
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
        )
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

    it('文を書いている下書きも、状態だけを返す（日と場面は返さない）', async () => {
      placeSnapshot([snap('a', '2026-10-05T07:50:00')]);
      cosmosBackend.documents.set(
        TIMELINE_ID,
        timelineWith(
          draftOf({
            phase: 'writing',
            sceneStarts: [photoId('a')],
            job: { step: 'write', state: 'pending', attempts: 0, lastError: null, updatedAt: '2026-10-25T08:59:00.000Z' }
          })
        )
      );

      const response = await getTimelineDraftHandler(createRequest(TRIP_ID), mockContext);

      expect((response.jsonBody as any).data.draft).toEqual({
        id: DRAFT_ID,
        reason: 'create',
        phase: 'writing',
        job: { step: 'write', state: 'pending', lastError: null },
        startedAt: '2026-10-25T08:50:00.000Z'
      });
    });

    it('文を書くのに失敗した下書きは、確かめ中と同じく日と場面も返す（区切りの確認の画面で直してから書き直せる）', async () => {
      placeSnapshot([snap('a', '2026-10-05T07:50:00'), snap('b', null, { category: 'other' })]);
      cosmosBackend.documents.set(
        TIMELINE_ID,
        timelineWith(
          draftOf({
            phase: 'writing',
            sceneStarts: [photoId('a')],
            job: { step: 'write', state: 'failed', attempts: 3, lastError: 'ai', updatedAt: '2026-10-25T08:59:00.000Z' }
          })
        )
      );

      const response = await getTimelineDraftHandler(createRequest(TRIP_ID), mockContext);

      expect(response.status).toBe(200);
      expect((response.jsonBody as any).data.draft).toEqual({
        id: DRAFT_ID,
        reason: 'create',
        phase: 'writing',
        job: { step: 'write', state: 'failed', lastError: 'ai' },
        startedAt: '2026-10-25T08:50:00.000Z',
        days: [
          {
            date: '2026-10-05',
            dayNumber: 1,
            scenes: [
              {
                startPhotoId: photoId('a'),
                startedBy: 'day',
                hasFood: false,
                firstTakenAt: '2026-10-05T07:50:00',
                lastTakenAt: '2026-10-05T07:50:00',
                placeNames: [],
                names: [],
                photos: [shown('a', '2026-10-05T07:50:00')]
              }
            ]
          }
        ],
        undatedPhotos: [shown('b', null, { category: 'other' })]
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
        timelineWith(draftOf({ proposedStarts: [photoId('a')], sceneStarts: [photoId('a'), photoId('c')] }))
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
        timelineWith(draftOf({ proposedStarts: [photoId('a'), photoId('b')], sceneStarts: [photoId('a'), photoId('b')] }))
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
      cosmosBackend.documents.set(TIMELINE_ID, timelineWith(draftOf({ dayStartHour: 0 })));

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

    it('タイムラインを読んだ後に下書きがやめられて控えが消えていたら、読み直して今の状態（下書きなし）を返す', async () => {
      cosmosBackend.documents.set(TIMELINE_ID, timelineWith(draftOf()));
      // 控えを読む直前に、別の操作が下書きをやめた（下書きを外してから控えを消す）
      cosmosBackend.beforeRead = (id) => {
        if (id === SNAPSHOT_ID) cosmosBackend.documents.set(TIMELINE_ID, timelineWith(null, currentVersion));
      };

      const response = await getTimelineDraftHandler(createRequest(TRIP_ID), mockContext);

      expect(response.status).toBe(200);
      expect(response.jsonBody).toEqual({ success: true, data: { draft: null, urlExpiresAt: '2026-10-25T10:00:00.000Z' } });
    });

    it('読み直す間にも続けて作り直されていたら、続けて読み直す（2回続けて重なっても、今の状態を返す）', async () => {
      // 1回目・2回目に読んだ下書きの控えは、読む前に作り直しで消された。3回目に読むときは下書きがやめられている
      const replacedSnapshotId = `timeline-photos-${TRIP_ID}-55555555-5555-4555-8555-555555555555`;
      cosmosBackend.documents.set(TIMELINE_ID, timelineWith(draftOf()));
      let reads = 0;
      cosmosBackend.beforeRead = (id) => {
        if (id !== SNAPSHOT_ID && id !== replacedSnapshotId) return;
        reads += 1;
        cosmosBackend.documents.set(TIMELINE_ID, reads === 1 ? timelineWith(draftOf({ snapshotId: replacedSnapshotId })) : timelineWith(null, currentVersion));
      };

      const response = await getTimelineDraftHandler(createRequest(TRIP_ID), mockContext);

      expect(response.status).toBe(200);
      expect(response.jsonBody).toEqual({ success: true, data: { draft: null, urlExpiresAt: '2026-10-25T10:00:00.000Z' } });
    });

    it('確かめ中の下書きの写真の控えが無ければ（壊れている）、500 を返す（空の日と場面を返さない）', async () => {
      cosmosBackend.documents.set(TIMELINE_ID, timelineWith(draftOf()));

      const response = await getTimelineDraftHandler(createRequest(TRIP_ID), mockContext);

      expect(response.status).toBe(500);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'INTERNAL_ERROR', message: 'タイムラインの取得に失敗しました' } });
    });

    it.each(databaseFailureCases('タイムラインの取得に失敗しました'))('旅行やタイムラインを読むときに%s', async (_case, error, status, code, message) => {
      cosmosBackend.forcedReadError = error;

      const response = await getTimelineDraftHandler(createRequest(TRIP_ID), mockContext);

      expect(response.status).toBe(status);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code, message } });
    });
  });
  describe('下書きをやめる（DELETE）', () => {
    const snapshotDocument = (id: string) => timelinePhotosDocument(id, TRIP_ID);
    const storedSnapshotIds = () =>
      [...cosmosBackend.documents.values()].filter((doc) => doc.type === 'timelinePhotos').map((doc) => doc.id).sort();

    it.each<[string, TimelineDraft]>([
      ['確かめ中の', draftOf()],
      [
        '作っている途中の',
        draftOf({ phase: 'proposing', job: { step: 'propose', state: 'running', attempts: 1, lastError: null, updatedAt: '2026-10-25T08:59:00.000Z' } })
      ]
    ])('完成版の無い%s下書きをやめると、タイムラインの文書ごと消え、下書きの控えも消える', async (_label, draft) => {
      cosmosBackend.documents.set(SNAPSHOT_ID, snapshotDocument(SNAPSHOT_ID));
      cosmosBackend.documents.set(TIMELINE_ID, timelineWith(draft));

      const response = await deleteTimelineDraftHandler(createRequest(TRIP_ID, 'DELETE'), mockContext);

      expect(response.status).toBe(200);
      expect(response.jsonBody).toEqual({ success: true, data: { draft: null } });
      expect(cosmosBackend.documents.has(TIMELINE_ID)).toBe(false);
      expect(storedSnapshotIds()).toEqual([]);
    });

    it.each<[string, string[], TimelineDraft]>([
      ['作り直しの下書き', [SNAPSHOT_ID, CURRENT_SNAPSHOT_ID], draftOf({ reason: 'rebuild' })],
      [
        '完成版の区切りを直している途中（recut）の下書き（完成版と同じ控えを指す）',
        [CURRENT_SNAPSHOT_ID],
        draftOf({ reason: 'recut', snapshotId: CURRENT_SNAPSHOT_ID })
      ]
    ])('%sをやめると、下書きだけが消え、完成版とその控えは残る', async (_label, snapshotIds, draft) => {
      snapshotIds.forEach((id) => cosmosBackend.documents.set(id, snapshotDocument(id)));
      cosmosBackend.documents.set(TIMELINE_ID, timelineWith(draft, currentVersion));

      const response = await deleteTimelineDraftHandler(createRequest(TRIP_ID, 'DELETE'), mockContext);

      expect(response.status).toBe(200);
      expect(cosmosBackend.documents.get(TIMELINE_ID)).toEqual({ ...timelineWith(null, currentVersion), updatedAt: NOW });
      expect(storedSnapshotIds()).toEqual([CURRENT_SNAPSHOT_ID]);
    });

    it.each(noDraftCases)('%sときは、404（TIMELINE_NOT_FOUND）を返す', async (_label, timelines) => {
      timelines.forEach((doc) => cosmosBackend.documents.set(doc.id, doc));

      const response = await deleteTimelineDraftHandler(createRequest(TRIP_ID, 'DELETE'), mockContext);

      expect(response.status).toBe(404);
      expect(response.jsonBody).toMatchObject({
        success: false,
        error: { code: 'TIMELINE_NOT_FOUND', message: 'タイムラインの下書きが見つかりません' }
      });
    });

    it('読んでから書くまでに他の操作がタイムラインを書いたら、409（TIMELINE_STATE_CONFLICT）で、何も消さない', async () => {
      cosmosBackend.documents.set(SNAPSHOT_ID, snapshotDocument(SNAPSHOT_ID));
      cosmosBackend.documents.set(CURRENT_SNAPSHOT_ID, snapshotDocument(CURRENT_SNAPSHOT_ID));
      cosmosBackend.documents.set(TIMELINE_ID, timelineWith(draftOf({ reason: 'rebuild' }), currentVersion));
      const written = timelineWith(draftOf({ reason: 'rebuild', sceneStarts: [photoId('a')] }), currentVersion);
      cosmosBackend.beforeReplace = (id) => {
        if (id === TIMELINE_ID) cosmosBackend.documents.set(TIMELINE_ID, { ...written });
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

    it('完成版の無い下書きでも、読んでから消すまでに他の操作がタイムラインを書いたら、409 で何も消さない', async () => {
      cosmosBackend.documents.set(SNAPSHOT_ID, snapshotDocument(SNAPSHOT_ID));
      cosmosBackend.documents.set(TIMELINE_ID, timelineWith(draftOf()));
      const written = timelineWith(draftOf({ sceneStarts: [photoId('a')] }));
      cosmosBackend.beforeDelete = (id) => {
        if (id === TIMELINE_ID) cosmosBackend.documents.set(TIMELINE_ID, { ...written });
      };

      const response = await deleteTimelineDraftHandler(createRequest(TRIP_ID, 'DELETE'), mockContext);

      expect(response.status).toBe(409);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'TIMELINE_STATE_CONFLICT' } });
      expect(cosmosBackend.documents.get(TIMELINE_ID)).toEqual(written);
      expect(storedSnapshotIds()).toEqual([SNAPSHOT_ID]);
    });

    it('読んでから消すまでにタイムラインが他の操作で消えていたら（旅行の削除など）、409 で控えを消さない', async () => {
      cosmosBackend.documents.set(SNAPSHOT_ID, snapshotDocument(SNAPSHOT_ID));
      cosmosBackend.documents.set(TIMELINE_ID, timelineWith(draftOf()));
      cosmosBackend.beforeDelete = (id) => {
        if (id === TIMELINE_ID) cosmosBackend.documents.delete(TIMELINE_ID);
      };

      const response = await deleteTimelineDraftHandler(createRequest(TRIP_ID, 'DELETE'), mockContext);

      expect(response.status).toBe(409);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'TIMELINE_STATE_CONFLICT' } });
      expect(storedSnapshotIds()).toEqual([SNAPSHOT_ID]);
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

    it.each(databaseFailureCases('タイムラインの更新に失敗しました'))('旅行やタイムラインを読むときに%s', async (_case, error, status, code, message) => {
      cosmosBackend.forcedReadError = error;

      const response = await deleteTimelineDraftHandler(createRequest(TRIP_ID, 'DELETE'), mockContext);

      expect(response.status).toBe(status);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code, message } });
    });
  });

  describe('区切りを保存する（PUT …/draft/scenes）', () => {
    // 1日目（10/05）: a・b・c、2日目（10/06）: d・e、日時なし: u
    const PHOTOS = [
      snap('a', '2026-10-05T07:50:00'),
      snap('b', '2026-10-05T09:00:00'),
      snap('c', '2026-10-05T12:00:00', { category: 'food' }),
      snap('d', '2026-10-06T09:00:00'),
      snap('e', '2026-10-06T13:00:00'),
      snap('u', null)
    ];
    const proposed = [photoId('a'), photoId('c'), photoId('d')];
    const reviewing = (overrides: Partial<TimelineDraft> = {}) => draftOf({ proposedStarts: proposed, sceneStarts: proposed, ...overrides });

    /** ボディ付きの要求。text を渡すと、JSON として読めない本文にする */
    const putRequest = (tripId: string, body: unknown, text?: string): HttpRequest =>
      ({
        method: 'PUT',
        url: `https://func-snaplant.azurewebsites.net/api/trips/${tripId}/timeline/draft/scenes?code=test-key`,
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        params: { tripId },
        json: async () => (text !== undefined ? JSON.parse(text) : body)
      }) as any as HttpRequest;

    const put = (body: unknown) => putTimelineDraftScenesHandler(putRequest(TRIP_ID, body), mockContext);

    beforeEach(() => {
      placeSnapshot(PHOTOS);
    });

    it('確かめ中の下書きの区切りを置き換え、確かめ中の日と場面を返す（ほかの欄は変わらない）', async () => {
      const timeline = timelineDocument(TRIP_ID, { current: currentVersion, draft: reviewing(), updatedAt: '2026-10-25T08:55:00.000Z' });
      cosmosBackend.documents.set(TIMELINE_ID, timeline);
      const starts = [photoId('a'), photoId('b'), photoId('d')];

      const response = await put({ sceneStarts: starts });

      expect(response.status).toBe(200);
      expect(cosmosBackend.documents.get(TIMELINE_ID)).toEqual({ ...timeline, draft: reviewing({ sceneStarts: starts }), updatedAt: NOW });
      const data = (response.jsonBody as any).data;
      expect(data.urlExpiresAt).toBe('2026-10-25T10:00:00.000Z');
      expect(data.draft).toMatchObject({ id: DRAFT_ID, reason: 'create', phase: 'reviewing', job: null });
      // b は利用者が足した区切り、AI の案の c は消した（b の場面に入る）
      expect(
        data.draft.days.map((day: any) => day.scenes.map((scene: any) => [scene.startPhotoId, scene.startedBy, scene.photos.length]))
      ).toEqual([
        [
          [photoId('a'), 'day', 1],
          [photoId('b'), 'user', 2]
        ],
        [[photoId('d'), 'day', 2]]
      ]);
      expect(data.draft.undatedPhotos).toEqual([shown('u', null)]);
    });

    it('各日の最初の写真は、下書きの日付の切り替えの時刻で決める（5時なら翌日の 4:30 は前の日の途中）', async () => {
      // k は 10/06 4:30。下書きの切り替えが5時なので 10/05 に入り、2日目の最初は d のまま。
      // 既定（4時）と違う値にして、今の設定ではなく下書きに書いた値で分けることを見る
      placeSnapshot([...PHOTOS.slice(0, 3), snap('k', '2026-10-06T04:30:00'), ...PHOTOS.slice(3)]);
      cosmosBackend.documents.set(TIMELINE_ID, timelineWith(reviewing({ dayStartHour: 5 })));

      const response = await put({ sceneStarts: [photoId('a'), photoId('d')] });

      expect(response.status).toBe(200);
      expect((response.jsonBody as any).data.draft.days[0].scenes[0].photos.map((photo: any) => photo.id)).toContain(photoId('k'));
    });

    it.each<[string, string[], string[], string[]]>([
      // 画面には b と c の場面しか見えない（日の最初の場面と2日目を丸ごと見ない）
      ['日の最初の写真が消えていて送られない', ['a', 'd', 'e'], [photoId('b')], [photoId('a'), photoId('b'), photoId('d')]],
      ['日の最初の写真がまだあるのに送られない', [], [photoId('b'), photoId('e')], [photoId('a'), photoId('b'), photoId('d'), photoId('e')]]
    ])('%sときも、各日の最初の写真を補って撮影の順で保存する', async (_label, deleted, starts, saved) => {
      // 控えを取った後に消えた写真
      for (const head of deleted) {
        cosmosBackend.documents.delete(photoId(head));
      }
      cosmosBackend.documents.set(TIMELINE_ID, timelineWith(reviewing()));

      const response = await put({ sceneStarts: starts });

      expect(response.status).toBe(200);
      expect((cosmosBackend.documents.get(TIMELINE_ID) as any).draft.sceneStarts).toEqual(saved);
    });

    it('写真が全部消えた場面の区切りは、送られなくても残す（画面に見えない場面が前の場面に混ざり、文を引き継げなくならないように）', async () => {
      // 1日目は a・b の場面と c の場面。控えを取った後に c を消したので、画面には c の場面が見えず、c の区切りを送れない
      cosmosBackend.documents.delete(photoId('c'));
      cosmosBackend.documents.set(TIMELINE_ID, timelineWith(reviewing()));

      // 2日目の e で区切りを足した
      const response = await put({ sceneStarts: [photoId('a'), photoId('d'), photoId('e')] });

      expect(response.status).toBe(200);
      expect((cosmosBackend.documents.get(TIMELINE_ID) as any).draft.sceneStarts).toEqual([
        photoId('a'),
        photoId('c'),
        photoId('d'),
        photoId('e')
      ]);
    });

    it('応答の日と場面には、控えを取った後に消えた写真を出さない', async () => {
      // 控えを取った後に b を消した
      cosmosBackend.documents.delete(photoId('b'));
      cosmosBackend.documents.set(TIMELINE_ID, timelineWith(reviewing()));

      const response = await put({ sceneStarts: [photoId('a'), photoId('b'), photoId('d')] });

      // b の場面は残り（c がある）、場面の id は控えの最初の写真の b のまま
      const scenes = (response.jsonBody as any).data.draft.days[0].scenes;
      expect(scenes.map((scene: any) => [scene.startPhotoId, scene.photos.map((photo: any) => photo.id)])).toEqual([
        [photoId('a'), [photoId('a')]],
        [photoId('b'), [photoId('c')]]
      ]);
    });

    it('文を書くのに失敗した下書きでも保存でき、確かめ中に戻る（処理は消える）', async () => {
      const failed = reviewing({
        phase: 'writing',
        job: { step: 'write', state: 'failed', attempts: 3, lastError: 'ai', updatedAt: '2026-10-25T08:30:00.000Z' }
      });
      cosmosBackend.documents.set(TIMELINE_ID, timelineWith(failed));

      const response = await put({ sceneStarts: proposed });

      expect(response.status).toBe(200);
      expect(cosmosBackend.documents.get(TIMELINE_ID)).toMatchObject({ draft: { ...failed, phase: 'reviewing', job: null }, updatedAt: NOW });
      expect((response.jsonBody as any).data.draft).toMatchObject({ phase: 'reviewing', job: null });
    });

    it.each(noDraftCases)('%sときは、404（TIMELINE_NOT_FOUND）', async (_label, timelines) => {
      timelines.forEach((doc) => cosmosBackend.documents.set(doc.id, doc));

      const response = await put({ sceneStarts: proposed });

      expect(response.status).toBe(404);
      expect(response.jsonBody).toMatchObject({
        success: false,
        error: { code: 'TIMELINE_NOT_FOUND', message: 'タイムラインの下書きが見つかりません' }
      });
    });

    it.each<[string, Partial<TimelineDraft>]>([
      ['区切り案を作っている', { phase: 'proposing', job: { step: 'propose', state: 'running', attempts: 1, lastError: null, updatedAt: NOW } }],
      ['区切り案に失敗した', { phase: 'proposing', job: { step: 'propose', state: 'failed', attempts: 3, lastError: 'ai', updatedAt: NOW } }],
      ['文を書く順番を待っている', { phase: 'writing', job: { step: 'write', state: 'pending', attempts: 0, lastError: null, updatedAt: NOW } }],
      ['文を書いている', { phase: 'writing', job: { step: 'write', state: 'running', attempts: 1, lastError: null, updatedAt: NOW } }]
    ])('下書きが%sときは、409（TIMELINE_STATE_CONFLICT）で区切りを変えない', async (_label, overrides) => {
      const timeline = timelineWith(reviewing(overrides));
      cosmosBackend.documents.set(TIMELINE_ID, timeline);

      const response = await put({ sceneStarts: [photoId('a'), photoId('b'), photoId('d')] });

      expect(response.status).toBe(409);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'TIMELINE_STATE_CONFLICT' } });
      expect(cosmosBackend.documents.get(TIMELINE_ID)).toEqual(timeline);
    });

    it.each<[string, unknown]>([
      ['区切りが無い', {}],
      ['区切りが配列でない', { sceneStarts: 'aaaa' }],
      ['区切りに文字列でない値がある', { sceneStarts: ['aaaa', 1] }]
    ])('%sときは、400（区切りは写真IDの配列で指定してください）', async (_label, body) => {
      const timeline = timelineWith(reviewing());
      cosmosBackend.documents.set(TIMELINE_ID, timeline);

      const response = await put(body);

      expect(response.status).toBe(400);
      expect(response.jsonBody).toMatchObject({
        success: false,
        error: { code: 'INVALID_REQUEST', message: '区切りは写真IDの配列で指定してください' }
      });
      expect(cosmosBackend.documents.get(TIMELINE_ID)).toEqual(timeline);
    });

    it.each<[string, string[]]>([
      ['控えに無い写真を含む', [photoId('a'), photoId('z'), photoId('d')]],
      ['撮影日時の無い写真を含む', [photoId('a'), photoId('d'), photoId('u')]],
      ['同じ写真を重ねて含む', [photoId('a'), photoId('b'), photoId('b'), photoId('d')]],
      ['先頭で同じ写真を重ねて含む', [photoId('a'), photoId('a'), photoId('d')]],
      ['撮影の順に並んでいない', [photoId('a'), photoId('d'), photoId('b')]]
    ])('区切りが%sときは、400（区切りが無効です）', async (_label, starts) => {
      const timeline = timelineWith(reviewing());
      cosmosBackend.documents.set(TIMELINE_ID, timeline);

      const response = await put({ sceneStarts: starts });

      expect(response.status).toBe(400);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'INVALID_REQUEST', message: '区切りが無効です' } });
      expect(cosmosBackend.documents.get(TIMELINE_ID)).toEqual(timeline);
    });

    it.each<[string, () => HttpRequest, string]>([
      ['JSON として読めない', () => putRequest(TRIP_ID, undefined, '{'), 'リクエストボディの形式が無効です'],
      ['null の', () => putRequest(TRIP_ID, null), 'リクエストボディが指定されていません']
    ])('ボディが%sときは、400', async (_label, request, message) => {
      cosmosBackend.documents.set(TIMELINE_ID, timelineWith(reviewing()));

      const response = await putTimelineDraftScenesHandler(request(), mockContext);

      expect(response.status).toBe(400);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'INVALID_REQUEST', message } });
    });

    it('タイムラインを読んだ後に下書きがやめられて控えが消えていたら、409（TIMELINE_STATE_CONFLICT）で何も書かない', async () => {
      cosmosBackend.documents.set(TIMELINE_ID, timelineWith(reviewing()));
      const cancelled = timelineWith(null, currentVersion);
      cosmosBackend.beforeRead = (id) => {
        if (id === SNAPSHOT_ID) {
          cosmosBackend.documents.set(TIMELINE_ID, cancelled);
          cosmosBackend.documents.delete(SNAPSHOT_ID);
        }
      };

      const response = await put({ sceneStarts: proposed });

      expect(response.status).toBe(409);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'TIMELINE_STATE_CONFLICT' } });
      expect(cosmosBackend.documents.get(TIMELINE_ID)).toEqual(cancelled);
    });

    it('タイムラインを読んだ後に旅行が消されていたら（控えも消えた）、404（TRIP_NOT_FOUND）を返す', async () => {
      cosmosBackend.documents.set(TIMELINE_ID, timelineWith(reviewing()));
      cosmosBackend.beforeRead = (id) => {
        if (id === SNAPSHOT_ID) [TIMELINE_ID, SNAPSHOT_ID, TRIP_ID].forEach((docId) => cosmosBackend.documents.delete(docId));
      };

      const response = await put({ sceneStarts: proposed });

      expect(response.status).toBe(404);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'TRIP_NOT_FOUND' } });
      expect(cosmosBackend.documents.has(TIMELINE_ID)).toBe(false);
    });

    it('下書きの写真の控えが無ければ（壊れている）、区切りを書き換えずに 500 を返す（区切りが無効とは返さない）', async () => {
      cosmosBackend.documents.delete(SNAPSHOT_ID);
      const timeline = timelineWith(reviewing());
      cosmosBackend.documents.set(TIMELINE_ID, timeline);

      const response = await put({ sceneStarts: proposed });

      expect(response.status).toBe(500);
      expect(response.jsonBody).toMatchObject({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'タイムラインの区切りの保存に失敗しました' }
      });
      expect(cosmosBackend.documents.get(TIMELINE_ID)).toEqual(timeline);
    });

    it('写真の保存先の設定に鍵が無ければ、区切りを書き換えずに 500 を返す（保存したのに失敗と返さない）', async () => {
      // 応答の写真の URL を作れないので、書き換える前に失敗させる。書き換えた後に失敗すると、画面は保存できなかったと思って送り直す
      process.env.STORAGE_CONNECTION_STRING = 'DefaultEndpointsProtocol=https;AccountName=test;EndpointSuffix=core.windows.net';
      const timeline = timelineWith(reviewing());
      cosmosBackend.documents.set(TIMELINE_ID, timeline);

      const response = await put({ sceneStarts: [photoId('a'), photoId('b'), photoId('d')] });

      expect(response.status).toBe(500);
      expect(response.jsonBody).toMatchObject({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'タイムラインの区切りの保存に失敗しました' }
      });
      expect(cosmosBackend.documents.get(TIMELINE_ID)).toEqual(timeline);
    });

    it('読んでから書くまでに他の操作がタイムラインを書いたら、409（TIMELINE_STATE_CONFLICT）で、書いたものを変えない', async () => {
      cosmosBackend.documents.set(TIMELINE_ID, timelineWith(reviewing()));
      const written = timelineWith(reviewing({ sceneStarts: [photoId('a'), photoId('c'), photoId('d'), photoId('e')] }));
      cosmosBackend.beforeReplace = (id) => {
        if (id === TIMELINE_ID) cosmosBackend.documents.set(TIMELINE_ID, { ...written });
      };

      const response = await put({ sceneStarts: [photoId('a'), photoId('b'), photoId('d')] });

      expect(response.status).toBe(409);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'TIMELINE_STATE_CONFLICT' } });
      expect(cosmosBackend.documents.get(TIMELINE_ID)).toEqual(written);
    });

    it('旅行が無ければ、404（TRIP_NOT_FOUND）を返す', async () => {
      cosmosBackend.documents.delete(TRIP_ID);

      const response = await put({ sceneStarts: proposed });

      expect(response.status).toBe(404);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'TRIP_NOT_FOUND' } });
    });

    it('旅行IDがUUIDの形でなければ、400を返す', async () => {
      const response = await putTimelineDraftScenesHandler(putRequest('not-a-uuid', { sceneStarts: proposed }), mockContext);

      expect(response.status).toBe(400);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'INVALID_REQUEST', message: '旅行IDの形式が無効です' } });
    });

    it.each(databaseFailureCases('タイムラインの区切りの保存に失敗しました'))('タイムラインを置き換えるときに%s', async (_case, error, status, code, message) => {
      cosmosBackend.documents.set(TIMELINE_ID, timelineWith(reviewing()));
      cosmosBackend.forcedReplaceError = error;

      const response = await put({ sceneStarts: proposed });

      expect(response.status).toBe(status);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code, message } });
    });
  });

  describe('文を書く受付（POST …/draft/write）', () => {
    let queueBackend: FakeQueueBackend;
    const queuedMessages = (): Array<[string, unknown[]]> =>
      [...queueBackend.queues].map(([name, messages]) => [name, messages.map(decodeQueueMessage)]);
    const reviewing = (overrides: Partial<TimelineDraft> = {}) =>
      draftOf({ proposedStarts: [photoId('a')], sceneStarts: [photoId('a'), photoId('b')], ...overrides });
    const postWrite = () => postTimelineDraftWriteHandler(createRequest(TRIP_ID, 'POST'), mockContext);

    beforeEach(() => {
      queueBackend = { queues: new Map(), forcedSendError: null };
      MockedQueueClient.mockImplementation(((_connectionString: string, queueName: string) =>
        createFakeQueueClient(queueBackend, queueName)) as any);
      process.env.AzureWebJobsStorage = 'UseDevelopmentStorage=true';
      process.env.TIMELINE_QUEUE_NAME = 'timeline-processing';
    });

    afterEach(() => {
      delete process.env.AzureWebJobsStorage;
      delete process.env.TIMELINE_QUEUE_NAME;
    });

    it.each<[string, Partial<TimelineDraft>]>([
      ['確かめ中の下書き', {}],
      ['文を書くのに失敗した下書き', { phase: 'writing', job: { step: 'write', state: 'failed', attempts: 3, lastError: 'ai', updatedAt: '2026-10-25T08:30:00.000Z' } }]
    ])('%sは、文を書く待ちにしてキューに積み、202 で状態を返す（区切りと完成版はそのまま）', async (_label, overrides) => {
      const timeline = timelineDocument(TRIP_ID, { current: currentVersion, draft: reviewing(overrides), updatedAt: '2026-10-25T08:55:00.000Z' });
      cosmosBackend.documents.set(TIMELINE_ID, timeline);

      const response = await postWrite();

      expect(response.status).toBe(202);
      const job = { step: 'write', state: 'pending', attempts: 0, lastError: null, updatedAt: NOW };
      expect(cosmosBackend.documents.get(TIMELINE_ID)).toEqual({
        ...timeline,
        draft: { ...reviewing(overrides), phase: 'writing', job },
        updatedAt: NOW
      });
      expect(response.jsonBody).toEqual({
        success: true,
        data: {
          draft: { id: DRAFT_ID, reason: 'create', phase: 'writing', job: { step: 'write', state: 'pending', lastError: null }, startedAt: '2026-10-25T08:50:00.000Z' },
          urlExpiresAt: '2026-10-25T10:00:00.000Z'
        }
      });
      expect(queuedMessages()).toEqual([['timeline-processing', [{ tripId: TRIP_ID, draftId: DRAFT_ID }]]]);
    });

    it.each(noDraftCases)('%sときは、404（TIMELINE_NOT_FOUND）でキューに積まない', async (_label, timelines) => {
      timelines.forEach((doc) => cosmosBackend.documents.set(doc.id, doc));

      const response = await postWrite();

      expect(response.status).toBe(404);
      expect(response.jsonBody).toMatchObject({
        success: false,
        error: { code: 'TIMELINE_NOT_FOUND', message: 'タイムラインの下書きが見つかりません' }
      });
      expect(queuedMessages()).toEqual([]);
    });

    it.each<[string, Partial<TimelineDraft>]>([
      ['区切り案を作っている', { phase: 'proposing', job: { step: 'propose', state: 'running', attempts: 1, lastError: null, updatedAt: NOW } }],
      ['区切り案に失敗した', { phase: 'proposing', job: { step: 'propose', state: 'failed', attempts: 3, lastError: 'ai', updatedAt: NOW } }],
      ['文を書く順番を待っている', { phase: 'writing', job: { step: 'write', state: 'pending', attempts: 0, lastError: null, updatedAt: NOW } }],
      ['文を書いている', { phase: 'writing', job: { step: 'write', state: 'running', attempts: 1, lastError: null, updatedAt: NOW } }]
    ])('下書きが%sときは、409（TIMELINE_STATE_CONFLICT）で下書きを変えずキューに積まない', async (_label, overrides) => {
      const timeline = timelineWith(reviewing(overrides));
      cosmosBackend.documents.set(TIMELINE_ID, timeline);

      const response = await postWrite();

      expect(response.status).toBe(409);
      expect(response.jsonBody).toMatchObject({
        success: false,
        error: { code: 'TIMELINE_STATE_CONFLICT', message: 'タイムラインが変わったか、作っている途中です。読み直してください' }
      });
      expect(cosmosBackend.documents.get(TIMELINE_ID)).toEqual(timeline);
      expect(queuedMessages()).toEqual([]);
    });

    it('読んでから書くまでに他の操作がタイムラインを書いたら、409 で書いたものを変えずキューに積まない', async () => {
      cosmosBackend.documents.set(TIMELINE_ID, timelineWith(reviewing()));
      const written = timelineWith(reviewing({ sceneStarts: [photoId('a')] }));
      cosmosBackend.beforeReplace = (id) => {
        if (id === TIMELINE_ID) cosmosBackend.documents.set(TIMELINE_ID, { ...written });
      };

      const response = await postWrite();

      expect(response.status).toBe(409);
      expect(cosmosBackend.documents.get(TIMELINE_ID)).toEqual(written);
      expect(queuedMessages()).toEqual([]);
    });

    it('キューへの投入に失敗しても、202 で受け付ける（下書きは待ちのまま残り、再投入のタイマーが積む）', async () => {
      cosmosBackend.documents.set(TIMELINE_ID, timelineWith(reviewing()));
      queueBackend.forcedSendError = new Error('queue unavailable');

      const response = await postWrite();

      expect(response.status).toBe(202);
      expect(cosmosBackend.documents.get(TIMELINE_ID)).toMatchObject({ draft: { phase: 'writing', job: { state: 'pending' } } });
    });

    it('旅行が無ければ、404（TRIP_NOT_FOUND）を返す', async () => {
      cosmosBackend.documents.delete(TRIP_ID);

      const response = await postWrite();

      expect(response.status).toBe(404);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'TRIP_NOT_FOUND' } });
    });

    it('旅行IDがUUIDの形でなければ、400を返す', async () => {
      const response = await postTimelineDraftWriteHandler(createRequest('not-a-uuid', 'POST'), mockContext);

      expect(response.status).toBe(400);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'INVALID_REQUEST', message: '旅行IDの形式が無効です' } });
    });

    it.each(databaseFailureCases('タイムラインの作成の受付に失敗しました'))('タイムラインを置き換えるときに%s', async (_case, error, status, code, message) => {
      cosmosBackend.documents.set(TIMELINE_ID, timelineWith(reviewing()));
      cosmosBackend.forcedReplaceError = error;

      const response = await postWrite();

      expect(response.status).toBe(status);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code, message } });
      expect(queuedMessages()).toEqual([]);
    });
  });
});
