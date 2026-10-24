import { HttpRequest, InvocationContext } from '@azure/functions';
import { CosmosClient } from '@azure/cosmos';
import { BlobServiceClient, generateBlobSASQueryParameters } from '@azure/storage-blob';
import { QueueClient } from '@azure/storage-queue';
import { createTimelineHandler } from '../../src/functions/timeline';
import { PhotoDocument, PhotoProcessing } from '../../src/types/album';
import { TimelineDocument, TimelineDraft, TimelineJob } from '../../src/types/timeline';
import { FakeCosmosBackend, FakeCosmosDocument, createFakeContainer } from '../fakes/cosmos';
import { FakeBlobBackend, createFakeBlobServiceClient } from '../fakes/blob';
import { FakeQueueBackend, createFakeQueueClient, decodeQueueMessage } from '../fakes/queue';
import {
  photoDocument,
  timelineCurrent,
  timelineDocument,
  timelineDraft,
  timelinePhotosDocument,
  tripDocument
} from '../helpers/albumDocuments';
import { databaseFailureCases } from '../helpers/databaseFailures';

// タイムライン（段階5。docs/05_api_design.md §5.15、文書は 04 §1.6）。
// 外部依存のみモック。Cosmos DB とキューは状態持ちの偽物。SAS の署名は固定のトークンを返す形に差し替える
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
const OTHER_TRIP_ID = '223e4567-e89b-42d3-a456-426614174000';
const TIMELINE_ID = `timeline-${TRIP_ID}`;
const NOW = '2026-10-25T09:00:00.000Z';

// 写真の id（SHA-256 の16進）。取り違えを見分けられるよう、先頭の文字だけ変える
const photoId = (head: string): string => head.repeat(64);

/** 解析が済んだ写真（撮影日時・カテゴリ・識別・地名・コメントを持つ） */
const analyzedPhoto = (id: string, overrides: Partial<PhotoDocument> = {}): PhotoDocument =>
  photoDocument(id, {
    tripId: TRIP_ID,
    processing: { state: 'done', step: 'identify', attempts: 1, lastError: null, updatedAt: '2026-10-08T00:00:00.000Z' },
    ...overrides
  });

const CURRENT_SNAPSHOT_ID = `timeline-photos-${TRIP_ID}-11111111-1111-4111-8111-111111111111`;
const OLD_DRAFT_SNAPSHOT_ID = `timeline-photos-${TRIP_ID}-22222222-2222-4222-8222-222222222222`;
const OLD_DRAFT_ID = '33333333-3333-4333-8333-333333333333';

/** 写真の控えの文書（中身は確かめに使わない） */
const snapshotDocument = (id: string) => timelinePhotosDocument(id, TRIP_ID);

/** 完成版（文は確かめに使わない形だけ） */
const currentVersion = timelineCurrent(CURRENT_SNAPSHOT_ID, { proposedStarts: [photoId('a')], sceneStarts: [photoId('a')] });

/** 確かめ中の下書き */
const reviewingDraft = (overrides: Partial<TimelineDraft> = {}) =>
  timelineDraft(OLD_DRAFT_ID, OLD_DRAFT_SNAPSHOT_ID, { proposedStarts: [photoId('a')], sceneStarts: [photoId('a')], ...overrides });

/** 既にあるタイムラインの文書。置き換えても残すものを確かめるため、残せなかった文を持たせ、更新日時を今と変えておく */
const existingTimeline = (overrides: Partial<TimelineDocument> = {}) =>
  timelineDocument(TRIP_ID, {
    droppedEdits: [{ kind: 'scene', key: photoId('a'), field: 'label', text: '小樽運河さんぽ' }],
    updatedAt: '2026-10-08T12:14:00.000Z',
    ...overrides
  });

const createRequest = (tripId: string): HttpRequest =>
  ({
    method: 'POST',
    url: `https://func-snaplant.azurewebsites.net/api/trips/${tripId}/timeline?code=test-key`,
    query: new Map([['code', 'test-key']]),
    headers: new Map(),
    params: { tripId }
  }) as any as HttpRequest;

describe('タイムラインを作るAPI', () => {
  let mockContext: InvocationContext;
  let cosmosBackend: FakeCosmosBackend<FakeCosmosDocument>;
  let queueBackend: FakeQueueBackend;

  const storedTimeline = () => cosmosBackend.documents.get(TIMELINE_ID) as any;
  const storedSnapshots = () => [...cosmosBackend.documents.values()].filter((doc) => doc.type === 'timelinePhotos') as any[];
  const queuedMessages = (): Array<[string, unknown[]]> =>
    [...queueBackend.queues].map(([name, messages]) => [name, messages.map(decodeQueueMessage)]);

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
    mockedGenerateSas.mockReturnValue({ toString: () => 'sig=test' } as any);

    queueBackend = { queues: new Map(), forcedSendError: null };
    MockedQueueClient.mockImplementation(((_connectionString: string, queueName: string) =>
      createFakeQueueClient(queueBackend, queueName)) as any);

    process.env.COSMOS_DB_ENDPOINT = 'https://test.documents.azure.com:443/';
    process.env.COSMOS_DB_KEY = 'test-key';
    process.env.COSMOS_DB_DATABASE = 'test-db';
    process.env.COSMOS_DB_ALBUM_CONTAINER = 'test-album';
    process.env.STORAGE_CONNECTION_STRING =
      'DefaultEndpointsProtocol=https;AccountName=test;AccountKey=testkey==;EndpointSuffix=core.windows.net';
    process.env.PHOTO_STORAGE_CONTAINER_NAME = 'photos';
    process.env.PHOTO_SAS_EXPIRY_MINUTES = '60';
    process.env.AzureWebJobsStorage =
      'DefaultEndpointsProtocol=https;AccountName=test;AccountKey=testkey==;EndpointSuffix=core.windows.net';
    process.env.TIMELINE_QUEUE_NAME = 'timeline-processing';
    delete process.env.TIMELINE_DAY_START_HOUR;

    cosmosBackend.documents.set(TRIP_ID, tripDocument(TRIP_ID, '北海道 2026秋'));
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
    delete process.env.TIMELINE_QUEUE_NAME;
    delete process.env.TIMELINE_DAY_START_HOUR;
    delete process.env.AzureWebJobsStorage;
  });

  it('撮影日時のある写真があり、解析中の写真が無ければ、202で受け付け、写真の控えを取って下書きを作り、キューに積む', async () => {
    const longComment = 'あ'.repeat(120);
    cosmosBackend.documents.set(
      photoId('a'),
      analyzedPhoto(photoId('a'), {
        takenAt: '2026-10-05T07:50:12',
        takenAtSource: 'exif',
        sortAt: '2026-10-05T07:50:12',
        category: 'food',
        identification: { kind: 'food', matchesKind: true, name: '海鮮丼' },
        location: { latitude: 42.79, longitude: 141.68, placeName: '北海道千歳市', placeSource: 'device' },
        comment: longComment,
        commentSource: 'user'
      })
    );
    cosmosBackend.documents.set(
      photoId('b'),
      analyzedPhoto(photoId('b'), {
        takenAt: '2026-10-05T10:10:00',
        takenAtSource: 'exif',
        sortAt: '2026-10-05T10:10:00',
        category: 'landscape',
        // 分類と合わない写真の名前は控えに入れない（名前が残っていても）
        identification: { kind: 'landscape', matchesKind: false, name: '小樽運河' },
        thumbnailBlobName: null
      })
    );
    // 撮影日時の無い写真は、並び位置（アップロード日時から作る sortAt）が早くても、控えの後ろに入る
    cosmosBackend.documents.set(
      photoId('c'),
      analyzedPhoto(photoId('c'), { takenAt: null, sortAt: '2026-10-01T09:00:00', category: 'other' })
    );
    // 別の旅行の写真は入れない
    cosmosBackend.documents.set(photoId('d'), analyzedPhoto(photoId('d'), { tripId: OTHER_TRIP_ID, takenAt: '2026-10-05T08:00:00', takenAtSource: 'exif' }));

    const response = await createTimelineHandler(createRequest(TRIP_ID), mockContext);

    expect(response.status).toBe(202);
    const timeline = storedTimeline();
    const snapshots = storedSnapshots();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toEqual({
      id: expect.stringMatching(new RegExp(`^timeline-photos-${TRIP_ID}-[0-9a-f-]{36}$`)),
      type: 'timelinePhotos',
      tripId: TRIP_ID,
      photos: [
        { id: photoId('a'), takenAt: '2026-10-05T07:50:12', category: 'food', name: '海鮮丼', placeName: '北海道千歳市', comment: 'あ'.repeat(100), blobName: `${photoId('a')}.jpg`, thumbnailBlobName: `${photoId('a')}.thumb.jpg` },
        { id: photoId('b'), takenAt: '2026-10-05T10:10:00', category: 'landscape', name: null, placeName: null, comment: null, blobName: `${photoId('b')}.jpg`, thumbnailBlobName: null },
        { id: photoId('c'), takenAt: null, category: 'other', name: null, placeName: null, comment: null, blobName: `${photoId('c')}.jpg`, thumbnailBlobName: `${photoId('c')}.thumb.jpg` }
      ],
      createdAt: NOW
    });
    expect(timeline).toEqual({
      id: TIMELINE_ID,
      type: 'timeline',
      tripId: TRIP_ID,
      current: null,
      draft: {
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        reason: 'create',
        phase: 'proposing',
        job: { step: 'propose', state: 'pending', attempts: 0, lastError: null, updatedAt: NOW },
        snapshotId: snapshots[0].id,
        dayStartHour: 4,
        proposedStarts: [],
        sceneStarts: [],
        startedAt: NOW
      },
      droppedEdits: [],
      createdAt: NOW,
      updatedAt: NOW
    });
    expect(response.jsonBody).toEqual({
      success: true,
      data: {
        draft: {
          id: timeline.draft.id,
          reason: 'create',
          phase: 'proposing',
          job: { step: 'propose', state: 'pending', lastError: null },
          startedAt: NOW
        },
        urlExpiresAt: '2026-10-25T10:00:00.000Z'
      }
    });
    expect(queuedMessages()).toEqual([['timeline-processing', [{ tripId: TRIP_ID, draftId: timeline.draft.id }]]]);
  });

  it('写真の控えは、撮影日時のある写真を撮影の順に並べ、その後に撮影日時の無い写真を並び位置の順に並べる', async () => {
    // 偽物はクエリの結果を置いた順に返すので、わざと撮影の順と逆に置く
    cosmosBackend.documents.set(photoId('b'), analyzedPhoto(photoId('b'), { takenAt: '2026-10-05T10:10:00', takenAtSource: 'exif', sortAt: '2026-10-05T10:10:00' }));
    cosmosBackend.documents.set(photoId('e'), analyzedPhoto(photoId('e'), { takenAt: null, sortAt: '2026-10-02T09:00:00' }));
    cosmosBackend.documents.set(photoId('a'), analyzedPhoto(photoId('a'), { takenAt: '2026-10-05T07:50:12', takenAtSource: 'exif', sortAt: '2026-10-05T07:50:12' }));
    cosmosBackend.documents.set(photoId('c'), analyzedPhoto(photoId('c'), { takenAt: null, sortAt: '2026-10-01T09:00:00' }));

    const response = await createTimelineHandler(createRequest(TRIP_ID), mockContext);

    expect(response.status).toBe(202);
    expect(storedSnapshots()[0].photos.map((photo: { id: string }) => photo.id)).toEqual([photoId('a'), photoId('b'), photoId('c'), photoId('e')]);
  });

  it('撮影日時のある写真が1枚も無ければ、409（TIMELINE_NO_DATED_PHOTOS）で、何も作らずキューにも積まない', async () => {
    cosmosBackend.documents.set(photoId('a'), analyzedPhoto(photoId('a'), { takenAt: null }));

    const response = await createTimelineHandler(createRequest(TRIP_ID), mockContext);

    expect(response.status).toBe(409);
    expect(response.jsonBody).toMatchObject({
      success: false,
      error: { code: 'TIMELINE_NO_DATED_PHOTOS', message: '撮影日時のある写真がありません' }
    });
    expect(storedTimeline()).toBeUndefined();
    expect(storedSnapshots()).toEqual([]);
    expect(queuedMessages()).toEqual([]);
  });

  it.each(['pending', 'classifying', 'identifying'] as const)(
    '解析が済んでいない写真（%s）があれば、409（TIMELINE_PHOTOS_PROCESSING）で、何も作らない',
    async (state) => {
      cosmosBackend.documents.set(photoId('a'), analyzedPhoto(photoId('a'), { takenAt: '2026-10-05T07:50:12', takenAtSource: 'exif' }));
      cosmosBackend.documents.set(
        photoId('b'),
        analyzedPhoto(photoId('b'), {
          takenAt: '2026-10-05T08:00:00',
          takenAtSource: 'exif',
          processing: { state, step: 'classify', attempts: 0, lastError: null, updatedAt: '2026-10-25T08:59:00.000Z' }
        })
      );

      const response = await createTimelineHandler(createRequest(TRIP_ID), mockContext);

      expect(response.status).toBe(409);
      expect(response.jsonBody).toMatchObject({
        success: false,
        error: { code: 'TIMELINE_PHOTOS_PROCESSING', message: '解析中の写真があります。終わってから作ってください' }
      });
      expect(storedTimeline()).toBeUndefined();
      expect(storedSnapshots()).toEqual([]);
      expect(queuedMessages()).toEqual([]);
    }
  );

  it.each<[string, PhotoProcessing]>([
    ['none', { state: 'none', step: null, attempts: 0, lastError: null, updatedAt: null }],
    ['failed', { state: 'failed', step: 'identify', attempts: 3, lastError: 'ai', updatedAt: null }]
  ])('解析の対象でない・解析に失敗した写真（%s）があっても、作れる（202）', async (_state, processing) => {
    cosmosBackend.documents.set(photoId('a'), analyzedPhoto(photoId('a'), { takenAt: '2026-10-05T07:50:12', takenAtSource: 'exif', processing }));

    const response = await createTimelineHandler(createRequest(TRIP_ID), mockContext);

    expect(response.status).toBe(202);
  });

  it.each(['pending', 'running'] as const)(
    '下書きを作っている途中（%s）なら、409（TIMELINE_STATE_CONFLICT）で、下書きを変えない',
    async (state) => {
      cosmosBackend.documents.set(photoId('a'), analyzedPhoto(photoId('a'), { takenAt: '2026-10-05T07:50:12', takenAtSource: 'exif' }));
      const existing = existingTimeline({
        draft: reviewingDraft({ phase: 'proposing', job: { step: 'propose', state, attempts: 1, lastError: null, updatedAt: '2026-10-25T08:59:00.000Z' } })
      });
      cosmosBackend.documents.set(TIMELINE_ID, existing);

      const response = await createTimelineHandler(createRequest(TRIP_ID), mockContext);

      expect(response.status).toBe(409);
      expect(response.jsonBody).toMatchObject({
        success: false,
        error: { code: 'TIMELINE_STATE_CONFLICT', message: 'タイムラインが変わったか、作っている途中です。読み直してください' }
      });
      expect(storedTimeline()).toEqual(existing);
      expect(storedSnapshots()).toEqual([]);
      expect(queuedMessages()).toEqual([]);
    }
  );

  it('旅行が無ければ、404（TRIP_NOT_FOUND）を返す', async () => {
    cosmosBackend.documents.delete(TRIP_ID);

    const response = await createTimelineHandler(createRequest(TRIP_ID), mockContext);

    expect(response.status).toBe(404);
    expect(response.jsonBody).toMatchObject({
      success: false,
      error: { code: 'TRIP_NOT_FOUND', message: '指定された旅行が見つかりません' }
    });
  });

  it('旅行IDがUUIDの形でなければ、400を返す', async () => {
    const response = await createTimelineHandler(createRequest('not-a-uuid'), mockContext);

    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({
      success: false,
      error: { code: 'INVALID_REQUEST', message: '旅行IDの形式が無効です' }
    });
  });

  it.each([
    ['0', 0],
    ['23', 23],
    ['24', 4],
    ['-1', 4],
    ['abc', 4],
    ['', 4]
  ])('日付の切り替えの時刻（TIMELINE_DAY_START_HOUR=%j）を、下書きに %i として書く（0〜23 の整数でなければ既定の4時）', async (value, expected) => {
    process.env.TIMELINE_DAY_START_HOUR = value;
    cosmosBackend.documents.set(photoId('a'), analyzedPhoto(photoId('a'), { takenAt: '2026-10-05T07:50:12', takenAtSource: 'exif' }));

    await createTimelineHandler(createRequest(TRIP_ID), mockContext);

    expect(storedTimeline().draft.dayStartHour).toBe(expected);
  });
  describe('既にタイムラインがあるとき', () => {
    beforeEach(() => {
      cosmosBackend.documents.set(photoId('a'), analyzedPhoto(photoId('a'), { takenAt: '2026-10-05T07:50:12', takenAtSource: 'exif' }));
    });

    it('確かめ中の下書き（完成版なし）があれば、新しい下書きに置き換え、前の下書きの控えを消す。残せなかった文と作った日時は残す', async () => {
      cosmosBackend.documents.set(OLD_DRAFT_SNAPSHOT_ID, snapshotDocument(OLD_DRAFT_SNAPSHOT_ID));
      cosmosBackend.documents.set(TIMELINE_ID, existingTimeline({ draft: reviewingDraft() }));

      const response = await createTimelineHandler(createRequest(TRIP_ID), mockContext);

      expect(response.status).toBe(202);
      const timeline = storedTimeline();
      const snapshots = storedSnapshots();
      expect(snapshots.map((doc) => doc.id)).toEqual([timeline.draft.snapshotId]);
      expect(timeline.draft.id).not.toBe(OLD_DRAFT_ID);
      expect(timeline).toEqual({
        ...existingTimeline(),
        draft: {
          id: timeline.draft.id,
          reason: 'create',
          phase: 'proposing',
          job: { step: 'propose', state: 'pending', attempts: 0, lastError: null, updatedAt: NOW },
          snapshotId: timeline.draft.snapshotId,
          dayStartHour: 4,
          proposedStarts: [],
          sceneStarts: [],
          startedAt: NOW
        },
        updatedAt: NOW
      });
      expect(queuedMessages()).toEqual([['timeline-processing', [{ tripId: TRIP_ID, draftId: timeline.draft.id }]]]);
    });

    it.each<[string, string[], TimelineDraft | null]>([
      ['下書きなし', [CURRENT_SNAPSHOT_ID], null],
      [
        '作り直しの確かめ中の下書きは置き換え、その控えを消す',
        [CURRENT_SNAPSHOT_ID, OLD_DRAFT_SNAPSHOT_ID],
        reviewingDraft({ reason: 'rebuild' })
      ],
      [
        '区切りを直している途中（recut）の下書きは、完成版と同じ控えを指すので、控えを消さない',
        [CURRENT_SNAPSHOT_ID],
        reviewingDraft({ reason: 'recut', snapshotId: CURRENT_SNAPSHOT_ID })
      ]
    ])('完成版があれば作り直し（rebuild）の下書きにし、完成版とその控えは変えない（%s）', async (_label, snapshotIds, draft) => {
      snapshotIds.forEach((id) => cosmosBackend.documents.set(id, snapshotDocument(id)));
      cosmosBackend.documents.set(TIMELINE_ID, existingTimeline({ current: currentVersion, draft }));

      const response = await createTimelineHandler(createRequest(TRIP_ID), mockContext);

      expect(response.status).toBe(202);
      expect((response.jsonBody as any).data.draft.reason).toBe('rebuild');
      const timeline = storedTimeline();
      expect(timeline.current).toEqual(currentVersion);
      expect(timeline.draft).toMatchObject({ reason: 'rebuild', phase: 'proposing' });
      expect(storedSnapshots().map((doc) => doc.id).sort()).toEqual([CURRENT_SNAPSHOT_ID, timeline.draft.snapshotId].sort());
    });

    it.each<[string, TimelineJob['step'], TimelineDraft['phase']]>([
      ['区切り案', 'propose', 'proposing'],
      ['文', 'write', 'writing']
    ])('%sに失敗した下書きは置き換える', async (_label, step, phase) => {
      cosmosBackend.documents.set(
        TIMELINE_ID,
        existingTimeline({
          draft: reviewingDraft({ phase, job: { step, state: 'failed', attempts: 3, lastError: 'ai', updatedAt: '2026-10-08T12:20:00.000Z' } })
        })
      );

      const response = await createTimelineHandler(createRequest(TRIP_ID), mockContext);

      expect(response.status).toBe(202);
      expect(storedTimeline().draft).toMatchObject({ phase: 'proposing', job: { step: 'propose', state: 'pending', attempts: 0 } });
    });

    it('読んでから書くまでに他の操作がタイムラインを書いたら、409（TIMELINE_STATE_CONFLICT）で、作った控えを消してキューに積まない（前の下書きの控えは残す）', async () => {
      cosmosBackend.documents.set(TIMELINE_ID, existingTimeline({ draft: reviewingDraft() }));
      // 他が書いた文書は前の下書きの控えを指したままなので、消してはいけない
      cosmosBackend.documents.set(OLD_DRAFT_SNAPSHOT_ID, snapshotDocument(OLD_DRAFT_SNAPSHOT_ID));
      const written = existingTimeline({ draft: reviewingDraft({ sceneStarts: [] }), updatedAt: '2026-10-25T08:59:59.000Z' });
      cosmosBackend.beforeReplace = (id) => {
        if (id === TIMELINE_ID) cosmosBackend.documents.set(TIMELINE_ID, { ...written });
      };

      const response = await createTimelineHandler(createRequest(TRIP_ID), mockContext);

      expect(response.status).toBe(409);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'TIMELINE_STATE_CONFLICT' } });
      expect(storedTimeline()).toEqual(written);
      expect(storedSnapshots().map((doc) => doc.id)).toEqual([OLD_DRAFT_SNAPSHOT_ID]);
      expect(queuedMessages()).toEqual([]);
    });

    it('読んでから書くまでにタイムラインが他の操作で消えていたら（旅行の削除など）、409（TIMELINE_STATE_CONFLICT）で、作った控えを消してキューに積まない', async () => {
      cosmosBackend.documents.set(TIMELINE_ID, existingTimeline({ draft: reviewingDraft() }));
      cosmosBackend.beforeReplace = (id) => {
        if (id === TIMELINE_ID) cosmosBackend.documents.delete(TIMELINE_ID);
      };

      const response = await createTimelineHandler(createRequest(TRIP_ID), mockContext);

      expect(response.status).toBe(409);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'TIMELINE_STATE_CONFLICT' } });
      expect(storedTimeline()).toBeUndefined();
      expect(storedSnapshots()).toEqual([]);
      expect(queuedMessages()).toEqual([]);
    });
  });

  it('読んでから作るまでに、同じ旅行のタイムラインが他の操作で作られていたら、409（TIMELINE_STATE_CONFLICT）で、作った控えを消す', async () => {
    cosmosBackend.documents.set(photoId('a'), analyzedPhoto(photoId('a'), { takenAt: '2026-10-05T07:50:12', takenAtSource: 'exif' }));
    const created = existingTimeline({ draft: reviewingDraft() });
    cosmosBackend.beforeCreate = () => {
      if (!cosmosBackend.documents.has(TIMELINE_ID)) cosmosBackend.documents.set(TIMELINE_ID, created);
    };

    const response = await createTimelineHandler(createRequest(TRIP_ID), mockContext);

    expect(response.status).toBe(409);
    expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'TIMELINE_STATE_CONFLICT' } });
    expect(storedTimeline()).toEqual(created);
    expect(storedSnapshots()).toEqual([]);
    expect(queuedMessages()).toEqual([]);
  });

  it('キューへの投入に失敗しても、202で受け付ける（下書きは待ちのまま残り、再投入のタイマーが積む）', async () => {
    cosmosBackend.documents.set(photoId('a'), analyzedPhoto(photoId('a'), { takenAt: '2026-10-05T07:50:12', takenAtSource: 'exif' }));
    queueBackend.forcedSendError = new Error('queue unavailable');

    const response = await createTimelineHandler(createRequest(TRIP_ID), mockContext);

    expect(response.status).toBe(202);
    expect(storedTimeline().draft).toMatchObject({ phase: 'proposing', job: { state: 'pending' } });
  });

  it.each(databaseFailureCases('タイムラインの作成の受付に失敗しました'))('写真を読むときに%s', async (_case, error, status, code, message) => {
    cosmosBackend.documents.set(photoId('a'), analyzedPhoto(photoId('a'), { takenAt: '2026-10-05T07:50:12', takenAtSource: 'exif' }));
    cosmosBackend.forcedQueryError = error;

    const response = await createTimelineHandler(createRequest(TRIP_ID), mockContext);

    expect(response.status).toBe(status);
    expect(response.jsonBody).toMatchObject({ success: false, error: { code, message } });
    expect(storedTimeline()).toBeUndefined();
  });
});
