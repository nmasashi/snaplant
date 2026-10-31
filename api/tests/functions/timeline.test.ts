import { HttpRequest, InvocationContext } from '@azure/functions';
import { CosmosClient } from '@azure/cosmos';
import { BlobServiceClient, generateBlobSASQueryParameters } from '@azure/storage-blob';
import { QueueClient } from '@azure/storage-queue';
import { createTimelineHandler, getTimelineHandler } from '../../src/functions/timeline';
import { PhotoDocument, PhotoProcessing } from '../../src/types/album';
import { TimelineDocument, TimelineDraft, TimelineJob, TimelinePhotoSnapshot } from '../../src/types/timeline';
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
import { databaseFailureCases } from '../helpers/databaseFailures';
import { forEachCase } from '../helpers/cases';

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

/** 既にあるタイムラインの文書。置き換えたら更新日時が今になり、作った日時は残ることを見分けるため、更新日時を今と変えておく */
const existingTimeline = (overrides: Partial<TimelineDocument> = {}) =>
  timelineDocument(TRIP_ID, {
    updatedAt: '2026-10-08T12:14:00.000Z',
    ...overrides
  });

const createRequest = (tripId: string, method = 'POST'): HttpRequest =>
  ({
    method,
    url: `https://func-snaplant.azurewebsites.net/api/trips/${tripId}/timeline?code=test-key`,
    query: new Map([['code', 'test-key']]),
    headers: new Map(),
    params: { tripId }
  }) as any as HttpRequest;

const SAS = 'sig=test';

let mockContext: InvocationContext;
let cosmosBackend: FakeCosmosBackend<FakeCosmosDocument>;

// 作る・読むに共通の前提（Cosmos DB と Blob の偽物、SAS、環境変数、旅行）
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

describe('タイムラインを作るAPI', () => {
  let queueBackend: FakeQueueBackend;

  const storedTimeline = () => cosmosBackend.documents.get(TIMELINE_ID) as any;
  const storedSnapshots = () => [...cosmosBackend.documents.values()].filter((doc) => doc.type === 'timelinePhotos') as any[];
  const queuedMessages = (): Array<[string, unknown[]]> =>
    [...queueBackend.queues].map(([name, messages]) => [name, messages.map(decodeQueueMessage)]);

  beforeEach(() => {
    queueBackend = { queues: new Map(), forcedSendError: null };
    MockedQueueClient.mockImplementation(((_connectionString: string, queueName: string) =>
      createFakeQueueClient(queueBackend, queueName)) as any);

    process.env.AzureWebJobsStorage =
      'DefaultEndpointsProtocol=https;AccountName=test;AccountKey=testkey==;EndpointSuffix=core.windows.net';
    process.env.TIMELINE_QUEUE_NAME = 'timeline-processing';
    delete process.env.TIMELINE_DAY_START_HOUR;
  });

  afterEach(() => {
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

  it.each([
    // UTF-16 では2つ分。UTF-16 の単位で切ると前半だけが残る
    ['絵文字', '😀'],
    // 2つのコードポイント。コードポイントで切ると片方だけが残る
    ['国旗', '🇯🇵'],
    // ゼロ幅接合子でつないだ5つのコードポイント
    ['つないだ絵文字', '👨‍👩‍👧']
  ])('控えのコメントは見た目の1文字で数えて切り、100 文字目の%sを途中で切らない', async (_label, emoji) => {
    cosmosBackend.documents.set(
      photoId('a'),
      analyzedPhoto(photoId('a'), {
        takenAt: '2026-10-05T07:50:12',
        takenAtSource: 'exif',
        sortAt: '2026-10-05T07:50:12',
        comment: 'あ'.repeat(99) + emoji + 'い'.repeat(10),
        commentSource: 'user'
      })
    );

    const response = await createTimelineHandler(createRequest(TRIP_ID), mockContext);

    expect(response.status).toBe(202);
    expect(storedSnapshots()[0].photos[0].comment).toBe('あ'.repeat(99) + emoji);
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

    it('確かめ中の下書き（完成版なし）があれば、新しい下書きに置き換え（場面のコメントも引き継がない）、前の下書きの控えを消す。作った日時は残す', async () => {
      cosmosBackend.documents.set(OLD_DRAFT_SNAPSHOT_ID, snapshotDocument(OLD_DRAFT_SNAPSHOT_ID));
      // AI に案を出し直してもらうと、区切りと一緒に場面のコメントも消える（03 §8.7）
      cosmosBackend.documents.set(TIMELINE_ID, existingTimeline({ draft: reviewingDraft({ sceneComments: { [photoId('a')]: '朝市で海鮮丼' } }) }));

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
        '5-6b より前に始めた作り直しの確かめ中の下書きも置き換え、その控えも消す',
        [CURRENT_SNAPSHOT_ID, OLD_DRAFT_SNAPSHOT_ID],
        reviewingDraft({ reason: 'rebuild' })
      ],
      [
        '区切りを直している途中（recut）の下書きは、完成版と同じ控えを指す',
        [CURRENT_SNAPSHOT_ID],
        reviewingDraft({ reason: 'recut', snapshotId: CURRENT_SNAPSHOT_ID })
      ]
    ])('完成版があれば消して、作る（create）の下書きにし、完成版の控えも消す（%s）', async (_label, snapshotIds, draft) => {
      snapshotIds.forEach((id) => cosmosBackend.documents.set(id, snapshotDocument(id)));
      cosmosBackend.documents.set(TIMELINE_ID, existingTimeline({ current: currentVersion, draft }));

      const response = await createTimelineHandler(createRequest(TRIP_ID), mockContext);

      expect(response.status).toBe(202);
      expect((response.jsonBody as any).data.draft.reason).toBe('create');
      const timeline = storedTimeline();
      expect(timeline.current).toBeNull();
      expect(timeline.draft).toMatchObject({ reason: 'create', phase: 'proposing' });
      expect(storedSnapshots().map((doc) => doc.id)).toEqual([timeline.draft.snapshotId]);
    });

    it('区切り案・文に失敗した下書きは置き換える', () => forEachCase<[string, TimelineJob['step'], TimelineDraft['phase']]>([
      ['区切り案', 'propose', 'proposing'],
      ['文', 'write', 'writing']
    ], async (_label, step, phase) => {
      cosmosBackend.documents.set(
        TIMELINE_ID,
        existingTimeline({
          draft: reviewingDraft({ phase, job: { step, state: 'failed', attempts: 3, lastError: 'ai', updatedAt: '2026-10-08T12:20:00.000Z' } })
        })
      );

      const response = await createTimelineHandler(createRequest(TRIP_ID), mockContext);

      expect(response.status).toBe(202);
      expect(storedTimeline().draft).toMatchObject({ phase: 'proposing', job: { step: 'propose', state: 'pending', attempts: 0 } });
    }));

    it('読んでから書くまでに他の操作がタイムラインを書いたら、409（TIMELINE_STATE_CONFLICT）で、作った控えを消してキューに積まない（完成版と前の下書きの控えは残す）', async () => {
      cosmosBackend.documents.set(TIMELINE_ID, existingTimeline({ current: currentVersion, draft: reviewingDraft() }));
      // 他が書いた文書は完成版と前の下書きの控えを指したままなので、消してはいけない
      cosmosBackend.documents.set(CURRENT_SNAPSHOT_ID, snapshotDocument(CURRENT_SNAPSHOT_ID));
      cosmosBackend.documents.set(OLD_DRAFT_SNAPSHOT_ID, snapshotDocument(OLD_DRAFT_SNAPSHOT_ID));
      const written = existingTimeline({ current: currentVersion, draft: reviewingDraft({ sceneStarts: [] }), updatedAt: '2026-10-25T08:59:59.000Z' });
      cosmosBackend.beforeReplace = (id) => {
        if (id === TIMELINE_ID) cosmosBackend.documents.set(TIMELINE_ID, { ...written });
      };

      const response = await createTimelineHandler(createRequest(TRIP_ID), mockContext);

      expect(response.status).toBe(409);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'TIMELINE_STATE_CONFLICT' } });
      expect(storedTimeline()).toEqual(written);
      expect(storedSnapshots().map((doc) => doc.id).sort()).toEqual([CURRENT_SNAPSHOT_ID, OLD_DRAFT_SNAPSHOT_ID].sort());
      expect(queuedMessages()).toEqual([]);
    });

    it('消した完成版の控えを消すのに失敗しても、202 で下書きを作ってキューに積む（控えは旅行の削除で消える）', async () => {
      cosmosBackend.documents.set(CURRENT_SNAPSHOT_ID, snapshotDocument(CURRENT_SNAPSHOT_ID));
      cosmosBackend.documents.set(TIMELINE_ID, existingTimeline({ current: currentVersion }));
      cosmosBackend.forcedErrorById = { [CURRENT_SNAPSHOT_ID]: Object.assign(new Error('Service unavailable'), { code: 503 }) };

      const response = await createTimelineHandler(createRequest(TRIP_ID), mockContext);

      expect(response.status).toBe(202);
      const timeline = storedTimeline();
      expect(timeline.current).toBeNull();
      expect(queuedMessages()).toEqual([['timeline-processing', [{ tripId: TRIP_ID, draftId: timeline.draft.id }]]]);
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

  it('写真を読むときに、データベースに接続できなければ503、それ以外の失敗は500で決まった文言を返す', () => forEachCase(databaseFailureCases('タイムラインの作成の受付に失敗しました'), async (_case, error, status, code, message) => {
    cosmosBackend.documents.set(photoId('a'), analyzedPhoto(photoId('a'), { takenAt: '2026-10-05T07:50:12', takenAtSource: 'exif' }));
    cosmosBackend.forcedQueryError = error;

    const response = await createTimelineHandler(createRequest(TRIP_ID), mockContext);

    expect(response.status).toBe(status);
    expect(response.jsonBody).toMatchObject({ success: false, error: { code, message } });
    expect(storedTimeline()).toBeUndefined();
  }));
});

describe('タイムラインを読むAPI（GET）', () => {
  const DRAFT_ID = '44444444-4444-4444-8444-444444444444';

  /** 完成版の控えの1枚（既定は名前・地名の無い風景の写真） */
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
  const shown = (photo: TimelinePhotoSnapshot) => ({
    id: photo.id,
    takenAt: photo.takenAt,
    category: photo.category,
    name: photo.name,
    placeName: photo.placeName,
    thumbnailUrl: `https://${TEST_BLOB_HOST}/photos/${photo.thumbnailBlobName ?? photo.blobName}?${SAS}`
  });

  // 1日目（10/05）: a・b・c、2日目（10/06）: d・e、日時なし: u
  const A = snap('a', '2026-10-05T07:50:12', { category: 'food', name: '海鮮丼', placeName: '北海道千歳市' });
  const B = snap('b', '2026-10-05T08:10:00', { placeName: '北海道千歳市', thumbnailBlobName: null });
  const C = snap('c', '2026-10-05T12:30:00', { category: 'food', name: 'ラーメン', placeName: '札幌市' });
  const D = snap('d', '2026-10-06T09:00:00', { name: '小樽運河', placeName: '小樽市' });
  const E = snap('e', '2026-10-06T11:00:00', { placeName: '小樽市' });
  const U = snap('u', null);
  const PHOTOS = [A, B, C, D, E, U];

  const sceneText = (label: string, labelSource: 'ai' | 'user', photoIds: string[]) => ({
    label,
    labelSource,
    aiLabel: `AIの${label}`,
    note: `${label}の一言`,
    noteSource: 'ai' as const,
    aiNote: `${label}の一言`,
    photoIds
  });
  const dayText = (title: string, sceneStarts: string[]) => ({
    title,
    titleSource: 'user' as const,
    aiTitle: `AIの${title}`,
    summary: `${title}のまとめ`,
    summarySource: 'ai' as const,
    aiSummary: `${title}のまとめ`,
    sceneStarts
  });

  /** 完成版。AI の案は a・c・d で、利用者が e を足した */
  const current = timelineCurrent(CURRENT_SNAPSHOT_ID, {
    proposedStarts: [A.id, C.id, D.id],
    sceneStarts: [A.id, C.id, D.id, E.id],
    sceneTexts: {
      [A.id]: sceneText('朝ごはん', 'ai', [A.id, B.id]),
      [C.id]: sceneText('昼ごはん', 'user', [C.id]),
      [D.id]: sceneText('運河', 'ai', [D.id]),
      [E.id]: sceneText('散歩', 'ai', [E.id])
    },
    dayTexts: {
      '2026-10-05': dayText('千歳と札幌', [A.id, C.id]),
      '2026-10-06': dayText('小樽', [D.id, E.id])
    },
    writtenAt: '2026-10-08T12:14:00.000Z'
  });
  const DROPPED = [{ kind: 'scene' as const, key: photoId('z'), field: 'label' as const, text: '小樽運河さんぽ' }];

  /** 旅行の写真の文書（解析の状態と、撮影日時（既定は無し）を指定する） */
  const placePhoto = (id: string, state: PhotoProcessing['state'] = 'done', tripId: string = TRIP_ID, takenAt: string | null = null) =>
    cosmosBackend.documents.set(
      id,
      photoDocument(id, { tripId, takenAt, processing: { state, step: 'identify', attempts: 1, lastError: null, updatedAt: '2026-10-08T00:00:00.000Z' } })
    );

  /** 完成版の控えを置き、removed 以外の控えの写真を旅行の写真として置く */
  const placeCurrentSnapshot = (removed: string[] = []) => {
    cosmosBackend.documents.set(CURRENT_SNAPSHOT_ID, timelinePhotosDocument(CURRENT_SNAPSHOT_ID, TRIP_ID, PHOTOS));
    PHOTOS.filter((photo) => !removed.includes(photo.id)).forEach((photo) => placePhoto(photo.id));
  };

  const getRequest = (tripId: string) => createRequest(tripId, 'GET');

  const read = async () => {
    const response = await getTimelineHandler(getRequest(TRIP_ID), mockContext);
    expect(response.status).toBe(200);
    return (response.jsonBody as any).data;
  };

  it('タイムラインが無ければ null で、解析が済んでいない写真の枚数を返す（別の旅行の写真は数えない）', async () => {
    placePhoto(photoId('1'), 'pending');
    placePhoto(photoId('2'), 'classifying');
    placePhoto(photoId('3'), 'identifying');
    placePhoto(photoId('4'), 'none');
    placePhoto(photoId('5'), 'done');
    placePhoto(photoId('6'), 'failed');
    placePhoto(photoId('7'), 'pending', OTHER_TRIP_ID);

    expect(await read()).toEqual({ timeline: null, pendingPhotoCount: 3, urlExpiresAt: '2026-10-25T10:00:00.000Z' });
  });

  it('完成版は、日ごと・場面ごとに文と写真を並べ（区切りを入れた主・食べ物の印・地名と名前）、撮影日時の無い写真は出さない（以前の版が書いた残せなかった文が文書に残っていても返さない）', async () => {
    placeCurrentSnapshot();
    // 以前の版が書いた文書（今の型には無い欄）
    cosmosBackend.documents.set(TIMELINE_ID, { ...timelineDocument(TRIP_ID, { current }), droppedEdits: DROPPED } as any);

    expect(await read()).toEqual({
      timeline: {
        current: {
          writtenAt: '2026-10-08T12:14:00.000Z',
          days: [
            {
              date: '2026-10-05',
              dayNumber: 1,
              title: '千歳と札幌',
              titleSource: 'user',
              summary: '千歳と札幌のまとめ',
              summarySource: 'ai',
              scenes: [
                {
                  startPhotoId: A.id, startedBy: 'day', hasFood: true,
                  label: '朝ごはん', labelSource: 'ai', note: '朝ごはんの一言', noteSource: 'ai',
                  firstTakenAt: '2026-10-05T07:50:12', lastTakenAt: '2026-10-05T08:10:00',
                  placeNames: ['北海道千歳市'], names: ['海鮮丼'], photos: [shown(A), shown(B)]
                },
                {
                  startPhotoId: C.id, startedBy: 'ai', hasFood: true,
                  label: '昼ごはん', labelSource: 'user', note: '昼ごはんの一言', noteSource: 'ai',
                  firstTakenAt: '2026-10-05T12:30:00', lastTakenAt: '2026-10-05T12:30:00',
                  placeNames: ['札幌市'], names: ['ラーメン'], photos: [shown(C)]
                }
              ]
            },
            {
              date: '2026-10-06',
              dayNumber: 2,
              title: '小樽',
              titleSource: 'user',
              summary: '小樽のまとめ',
              summarySource: 'ai',
              scenes: [
                {
                  startPhotoId: D.id, startedBy: 'day', hasFood: false,
                  label: '運河', labelSource: 'ai', note: '運河の一言', noteSource: 'ai',
                  firstTakenAt: '2026-10-06T09:00:00', lastTakenAt: '2026-10-06T09:00:00',
                  placeNames: ['小樽市'], names: ['小樽運河'], photos: [shown(D)]
                },
                {
                  startPhotoId: E.id, startedBy: 'user', hasFood: false,
                  label: '散歩', labelSource: 'ai', note: '散歩の一言', noteSource: 'ai',
                  firstTakenAt: '2026-10-06T11:00:00', lastTakenAt: '2026-10-06T11:00:00',
                  placeNames: ['小樽市'], names: [], photos: [shown(E)]
                }
              ]
            }
          ]
        },
        draft: null,
        changes: { added: 0, removed: 0 }
      },
      pendingPhotoCount: 0,
      urlExpiresAt: '2026-10-25T10:00:00.000Z'
    });
  });

  it('控えを取った後に消えた写真は出さない（写真が全部消えた場面と日も出さない）', async () => {
    // b と2日目の写真（d・e）と日時の無い写真が消えた
    placeCurrentSnapshot([B.id, D.id, E.id, U.id]);
    cosmosBackend.documents.set(TIMELINE_ID, timelineDocument(TRIP_ID, { current }));

    const data = await read();

    expect(data.timeline.current.days.map((day: any) => [day.date, day.scenes.map((s: any) => s.photos.map((p: any) => p.id))])).toEqual([
      ['2026-10-05', [[A.id], [C.id]]]
    ]);
  });

  it('外した写真は出さず（写真を全部外した場面と日も）、外した後に消えた写真は「消えた」に数えない', async () => {
    // a・d・e と日時の無い写真を外した。その後に b（外していない）と d（外した）が消えた
    placeCurrentSnapshot([B.id, D.id]);
    cosmosBackend.documents.set(TIMELINE_ID, timelineDocument(TRIP_ID, { current: { ...current, excludedPhotoIds: [A.id, D.id, E.id, U.id] } }));

    const data = await read();

    expect(data.timeline.current.days.map((day: any) => [day.date, day.scenes.map((s: any) => [s.startPhotoId, s.photos.map((p: any) => p.id)])])).toEqual([
      ['2026-10-05', [[C.id, [C.id]]]]
    ]);
    expect(data.timeline.changes).toEqual({ added: 0, removed: 1 });
  });

  it('撮影日時の無い写真は、増えても消えても数えない（タイムラインに入れないので）', async () => {
    // 控えの日時の無い写真 u が消え、日時の無い写真 n が増えた。日時のある写真 m も増えた
    placeCurrentSnapshot([U.id]);
    cosmosBackend.documents.set(photoId('n'), photoDocument(photoId('n'), { tripId: TRIP_ID, takenAt: null }));
    cosmosBackend.documents.set(photoId('m'), photoDocument(photoId('m'), { tripId: TRIP_ID, takenAt: '2026-10-06T15:00:00' }));
    cosmosBackend.documents.set(TIMELINE_ID, timelineDocument(TRIP_ID, { current }));

    const data = await read();

    expect(data.timeline.changes).toEqual({ added: 1, removed: 0 });
  });

  it('完成版の控えと比べて増えた・消えた撮影日時のある写真の枚数を返し、完成版があっても解析中の写真を数える', async () => {
    // b が消え、控えに無い撮影日時のある写真が2枚増えた（1枚は解析中）
    placeCurrentSnapshot([B.id]);
    placePhoto(photoId('n'), 'done', TRIP_ID, '2026-10-06T15:00:00');
    placePhoto(photoId('m'), 'pending', TRIP_ID, '2026-10-06T16:00:00');
    cosmosBackend.documents.set(TIMELINE_ID, timelineDocument(TRIP_ID, { current }));

    const data = await read();

    expect(data.timeline.changes).toEqual({ added: 2, removed: 1 });
    expect(data.pendingPhotoCount).toBe(1);
  });

  it('タイムラインを読んだ後に旅行が消されていたら（控えも消えた）、読み直して 404（TRIP_NOT_FOUND）を返す', async () => {
    placeCurrentSnapshot();
    cosmosBackend.documents.set(TIMELINE_ID, timelineDocument(TRIP_ID, { current }));
    // 控えを読む直前に、旅行の削除がタイムラインと控えと旅行を消した
    cosmosBackend.beforeRead = (id) => {
      if (id === CURRENT_SNAPSHOT_ID) {
        [TIMELINE_ID, CURRENT_SNAPSHOT_ID, TRIP_ID].forEach((docId) => cosmosBackend.documents.delete(docId));
      }
    };

    const response = await getTimelineHandler(getRequest(TRIP_ID), mockContext);

    expect(response.status).toBe(404);
    expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'TRIP_NOT_FOUND' } });
  });

  it('完成版の写真の控えが無ければ（壊れている）、500 を返す（空の完成版や、全部の写真が増えたとは返さない）', async () => {
    PHOTOS.forEach((photo) => placePhoto(photo.id));
    cosmosBackend.documents.set(TIMELINE_ID, timelineDocument(TRIP_ID, { current }));

    const response = await getTimelineHandler(getRequest(TRIP_ID), mockContext);

    expect(response.status).toBe(500);
    expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'INTERNAL_ERROR', message: 'タイムラインの取得に失敗しました' } });
  });

  it('文の無い日と場面は、文と書いた主を null にして返す（項目は省かない）', async () => {
    placeCurrentSnapshot();
    cosmosBackend.documents.set(TIMELINE_ID, timelineDocument(TRIP_ID, { current: { ...current, sceneTexts: {}, dayTexts: {} } }));

    const day = (await read()).timeline.current.days[0];

    expect(day).toMatchObject({ title: null, titleSource: null, summary: null, summarySource: null });
    expect(day.scenes[0]).toMatchObject({ label: null, labelSource: null, note: null, noteSource: null });
  });

  it('完成版の日は、完成版の日付の切り替えの時刻で分ける（5時なら翌日の 4:30 は前の日に入る）', async () => {
    // 既定（4時）と違う値にして、今の設定ではなく完成版に書いた値で分けることを見る
    const K = snap('k', '2026-10-06T04:30:00');
    cosmosBackend.documents.set(CURRENT_SNAPSHOT_ID, timelinePhotosDocument(CURRENT_SNAPSHOT_ID, TRIP_ID, [A, K, D]));
    [A, K, D].forEach((photo) => placePhoto(photo.id));
    cosmosBackend.documents.set(
      TIMELINE_ID,
      timelineDocument(TRIP_ID, { current: timelineCurrent(CURRENT_SNAPSHOT_ID, { dayStartHour: 5, proposedStarts: [A.id, D.id], sceneStarts: [A.id, D.id] }) })
    );

    const data = await read();

    expect(data.timeline.current.days.map((day: any) => [day.date, day.scenes[0].photos.map((photo: any) => photo.id)])).toEqual([
      ['2026-10-05', [A.id, K.id]],
      ['2026-10-06', [D.id]]
    ]);
  });

  it('下書きがあれば状態だけを返す（区切りの中身は返さない）', async () => {
    placeCurrentSnapshot();
    const draft = timelineDraft(DRAFT_ID, OLD_DRAFT_SNAPSHOT_ID, {
      reason: 'rebuild',
      phase: 'proposing',
      job: { step: 'propose', state: 'running', attempts: 1, lastError: null, updatedAt: '2026-10-25T08:59:00.000Z' },
      proposedStarts: [A.id],
      sceneStarts: [A.id],
      startedAt: '2026-10-25T08:58:00.000Z'
    });
    cosmosBackend.documents.set(TIMELINE_ID, timelineDocument(TRIP_ID, { current, draft }));

    const data = await read();

    expect(data.timeline.draft).toEqual({
      id: DRAFT_ID,
      reason: 'rebuild',
      phase: 'proposing',
      job: { step: 'propose', state: 'running', lastError: null },
      startedAt: '2026-10-25T08:58:00.000Z'
    });
    expect(data.timeline.current.days).toHaveLength(2);
  });

  it('完成版が無く下書きだけなら、完成版と写真の変化は null', async () => {
    placePhoto(A.id);
    const draft = timelineDraft(DRAFT_ID, OLD_DRAFT_SNAPSHOT_ID, { startedAt: '2026-10-25T08:58:00.000Z' });
    cosmosBackend.documents.set(TIMELINE_ID, timelineDocument(TRIP_ID, { draft }));

    expect(await read()).toEqual({
      timeline: {
        current: null,
        draft: { id: DRAFT_ID, reason: 'create', phase: 'reviewing', job: null, startedAt: '2026-10-25T08:58:00.000Z' },
        changes: null
      },
      pendingPhotoCount: 0,
      urlExpiresAt: '2026-10-25T10:00:00.000Z'
    });
  });

  it('旅行が無ければ、404（TRIP_NOT_FOUND）を返す', async () => {
    cosmosBackend.documents.delete(TRIP_ID);

    const response = await getTimelineHandler(getRequest(TRIP_ID), mockContext);

    expect(response.status).toBe(404);
    expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'TRIP_NOT_FOUND' } });
  });

  it('旅行IDがUUIDの形でなければ、400を返す', async () => {
    const response = await getTimelineHandler(getRequest('not-a-uuid'), mockContext);

    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'INVALID_REQUEST', message: '旅行IDの形式が無効です' } });
  });

  it('旅行の写真を読むときに、データベースに接続できなければ503、それ以外の失敗は500で決まった文言を返す', () => forEachCase(databaseFailureCases('タイムラインの取得に失敗しました'), async (_case, error, status, code, message) => {
    cosmosBackend.forcedQueryError = error;

    const response = await getTimelineHandler(getRequest(TRIP_ID), mockContext);

    expect(response.status).toBe(status);
    expect(response.jsonBody).toMatchObject({ success: false, error: { code, message } });
  }));
});
