import { HttpRequest, InvocationContext } from '@azure/functions';
import { CosmosClient } from '@azure/cosmos';
import { BlobServiceClient, generateBlobSASQueryParameters } from '@azure/storage-blob';
import { QueueClient } from '@azure/storage-queue';
import { createTimelineHandler } from '../../src/functions/timeline';
import { PhotoDocument } from '../../src/types/album';
import { FakeCosmosBackend, FakeCosmosDocument, createFakeContainer } from '../fakes/cosmos';
import { FakeBlobBackend, createFakeBlobServiceClient } from '../fakes/blob';
import { FakeQueueBackend, createFakeQueueClient, decodeQueueMessage } from '../fakes/queue';
import { photoDocument, tripDocument } from '../helpers/albumDocuments';

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
    // 分類と合わない写真は名前を持たない（識別の名前は null）
    cosmosBackend.documents.set(
      photoId('b'),
      analyzedPhoto(photoId('b'), {
        takenAt: '2026-10-05T10:10:00',
        takenAtSource: 'exif',
        sortAt: '2026-10-05T10:10:00',
        category: 'landscape',
        identification: { kind: 'landscape', matchesKind: false, name: null },
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

  it.each(['none', 'failed'] as const)('解析の対象でない・解析に失敗した写真（%s）は、済んだものとして扱う', async (state) => {
    cosmosBackend.documents.set(
      photoId('a'),
      analyzedPhoto(photoId('a'), {
        takenAt: '2026-10-05T07:50:12',
        takenAtSource: 'exif',
        processing: { state, step: state === 'none' ? null : 'identify', attempts: state === 'none' ? 0 : 3, lastError: state === 'none' ? null : 'ai', updatedAt: null }
      })
    );

    const response = await createTimelineHandler(createRequest(TRIP_ID), mockContext);

    expect(response.status).toBe(202);
  });

  it.each(['pending', 'running'] as const)(
    '下書きを作っている途中（%s）なら、409（TIMELINE_STATE_CONFLICT）で、下書きを変えない',
    async (state) => {
      cosmosBackend.documents.set(photoId('a'), analyzedPhoto(photoId('a'), { takenAt: '2026-10-05T07:50:12', takenAtSource: 'exif' }));
      const existing = {
        id: TIMELINE_ID,
        type: 'timeline',
        tripId: TRIP_ID,
        current: null,
        draft: {
          id: '0b8e1c5a-1111-4111-8111-111111111111',
          reason: 'create',
          phase: 'proposing',
          job: { step: 'propose', state, attempts: 1, lastError: null, updatedAt: '2026-10-25T08:59:00.000Z' },
          snapshotId: `timeline-photos-${TRIP_ID}-0b8e1c5a-2222-4222-8222-222222222222`,
          dayStartHour: 4,
          proposedStarts: [],
          sceneStarts: [],
          startedAt: '2026-10-25T08:58:00.000Z'
        },
        droppedEdits: [],
        createdAt: '2026-10-25T08:58:00.000Z',
        updatedAt: '2026-10-25T08:59:00.000Z'
      };
      cosmosBackend.documents.set(TIMELINE_ID, existing as any);

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
  ])('日付の切り替えの時刻（TIMELINE_DAY_START_HOUR=%j）を、下書きに %i として書く', async (value, expected) => {
    process.env.TIMELINE_DAY_START_HOUR = value;
    cosmosBackend.documents.set(photoId('a'), analyzedPhoto(photoId('a'), { takenAt: '2026-10-05T07:50:12', takenAtSource: 'exif' }));

    await createTimelineHandler(createRequest(TRIP_ID), mockContext);

    expect(storedTimeline().draft.dayStartHour).toBe(expected);
  });
});
