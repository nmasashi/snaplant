import { InvocationContext, Timer } from '@azure/functions';
import { CosmosClient } from '@azure/cosmos';
import { QueueClient } from '@azure/storage-queue';
import { requeueStalePhotosHandler } from '../../src/functions/requeueStalePhotos';
import { PhotoDocument, PhotoProcessing } from '../../src/types/album';
import { FakeCosmosBackend, FakeCosmosDocument, createFakeContainer } from '../fakes/cosmos';
import { FakeQueueBackend, createFakeQueueClient, decodeQueueMessage } from '../fakes/queue';
import { photoDocument, timelineDocument, timelineDraft, tripDocument } from '../helpers/albumDocuments';
import { TimelineDraft, TimelineJob } from '../../src/types/timeline';

// 外部依存のみモック。Cosmos DB とキューは状態持ちの偽物
jest.mock('@azure/cosmos');
jest.mock('@azure/storage-queue', () => ({ QueueClient: jest.fn() }));

const MockedCosmosClient = CosmosClient as jest.MockedClass<typeof CosmosClient>;
const MockedQueueClient = QueueClient as jest.MockedClass<typeof QueueClient>;

const NOW = '2026-10-18T03:00:00.000Z';
// 10 分を過ぎた時刻と、まだ過ぎていない時刻（06 §1.1 の再投入のタイマー）
const STALE = '2026-10-18T02:49:59.000Z';
const FRESH = '2026-10-18T02:50:01.000Z';

// 写真の id（SHA-256 の16進）。並びで取り違えを見分けられるよう、先頭の文字だけ変える
const photoId = (head: string): string => head.repeat(64);

const timer = { isPastDue: false } as unknown as Timer;

/** 解析の進み具合だけを指定した写真 */
const photoWith = (id: string, processing: PhotoProcessing): PhotoDocument => photoDocument(id, { processing });

describe('再投入のタイマー', () => {
  let mockContext: InvocationContext;
  let cosmosBackend: FakeCosmosBackend<FakeCosmosDocument>;
  let queueBackend: FakeQueueBackend;

  const stored = (id: string) => cosmosBackend.documents.get(id) as PhotoDocument;
  const queuedPhotoIds = (): unknown[] =>
    (queueBackend.queues.get('photo-processing') ?? []).map((message) => (decodeQueueMessage(message) as any).photoId);

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

    queueBackend = { queues: new Map(), forcedSendError: null };
    MockedQueueClient.mockImplementation(((_connectionString: string, queueName: string) =>
      createFakeQueueClient(queueBackend, queueName)) as any);

    process.env.COSMOS_DB_ENDPOINT = 'https://test.documents.azure.com:443/';
    process.env.COSMOS_DB_KEY = 'test-key';
    process.env.COSMOS_DB_DATABASE = 'test-db';
    process.env.COSMOS_DB_ALBUM_CONTAINER = 'test-album';
    process.env.AzureWebJobsStorage =
      'DefaultEndpointsProtocol=https;AccountName=test;AccountKey=testkey==;EndpointSuffix=core.windows.net';
    process.env.PHOTO_QUEUE_NAME = 'photo-processing';
    delete process.env.PHOTO_PROCESSING_MAX_ATTEMPTS;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
    delete process.env.PHOTO_QUEUE_NAME;
    delete process.env.AzureWebJobsStorage;
  });

  it('10分以上止まっている解析待ち・処理中の写真を、解析待ちに戻して（処理と回数はそのまま）キューに積む', async () => {
    // 投入に失敗した写真（pending）、処理中に落ちた写真（classifying / identifying）。
    // ワーカーは解析待ち（pending）の写真しか担当しないので、処理中の写真は解析待ちに戻してから積む（06 §1.1）
    cosmosBackend.documents.set(photoId('a'), photoWith(photoId('a'), { state: 'pending', step: 'classify', attempts: 0, lastError: null, updatedAt: STALE }));
    cosmosBackend.documents.set(photoId('b'), photoWith(photoId('b'), { state: 'classifying', step: 'classify', attempts: 1, lastError: null, updatedAt: STALE }));
    cosmosBackend.documents.set(photoId('c'), photoWith(photoId('c'), { state: 'identifying', step: 'identify', attempts: 2, lastError: 'ai', updatedAt: STALE }));
    // 旅行のドキュメントは写真ではないので拾わない
    cosmosBackend.documents.set('123e4567-e89b-42d3-a456-426614174000', tripDocument('123e4567-e89b-42d3-a456-426614174000', '北海道'));

    await requeueStalePhotosHandler(timer, mockContext);

    expect(stored(photoId('a')).processing).toEqual({ state: 'pending', step: 'classify', attempts: 0, lastError: null, updatedAt: NOW });
    expect(stored(photoId('b')).processing).toEqual({ state: 'pending', step: 'classify', attempts: 1, lastError: null, updatedAt: NOW });
    expect(stored(photoId('c')).processing).toEqual({ state: 'pending', step: 'identify', attempts: 2, lastError: 'ai', updatedAt: NOW });
    expect(queuedPhotoIds()).toEqual([photoId('a'), photoId('b'), photoId('c')]);
  });

  it('回数が上限（3回）に達した写真は、積まずに失敗（failed）にする', async () => {
    // 処理中に落ち続けた写真が、永遠に回り続けない（06 §1.3）
    cosmosBackend.documents.set(photoId('a'), photoWith(photoId('a'), { state: 'classifying', step: 'classify', attempts: 3, lastError: null, updatedAt: STALE }));

    await requeueStalePhotosHandler(timer, mockContext);

    expect(stored(photoId('a')).processing).toEqual({ state: 'failed', step: 'classify', attempts: 3, lastError: null, updatedAt: NOW });
    expect(queuedPhotoIds()).toEqual([]);
  });

  it.each([
    ['上限まで失敗した（failed）', { state: 'failed', step: 'classify', attempts: 3, lastError: 'ai', updatedAt: STALE }],
    ['解析の対象になっていない（none）', { state: 'none', step: null, attempts: 0, lastError: null, updatedAt: null }],
    ['済み（done）', { state: 'done', step: 'classify', attempts: 1, lastError: null, updatedAt: STALE }],
    ['止まってまだ10分たっていない解析待ち', { state: 'pending', step: 'classify', attempts: 0, lastError: null, updatedAt: FRESH }],
    ['止まってまだ10分たっていない処理中', { state: 'classifying', step: 'classify', attempts: 1, lastError: null, updatedAt: FRESH }]
  ] as [string, PhotoProcessing][])('%sの写真は拾わない（写真も変えず、積まない）', async (_label, processing) => {
    // failed を拾うと同じ画像で永遠に失敗し続け、none を拾うと段階2の写真すべてに意図せず課金する（06 §1.2）
    const photo = photoWith(photoId('a'), processing);
    cosmosBackend.documents.set(photoId('a'), photo);

    await requeueStalePhotosHandler(timer, mockContext);

    expect(stored(photoId('a'))).toEqual(photo);
    expect(queuedPhotoIds()).toEqual([]);
  });

  it('読んだ後にやり直しが受け付けられ、ワーカーが担当し直していたら（state・回数が同じ）、その写真には触らない', async () => {
    // 処理中に落ちた写真（classifying・回数 1）を読んだ後、やり直しで回数が 0 に戻り、新しい担当でまた classifying・1 になる
    cosmosBackend.documents.set(photoId('a'), photoWith(photoId('a'), { state: 'classifying', step: 'classify', attempts: 1, lastError: null, updatedAt: STALE }));
    const reclaimed = photoWith(photoId('a'), { state: 'classifying', step: 'classify', attempts: 1, lastError: null, updatedAt: NOW });
    cosmosBackend.beforePatch = () => {
      cosmosBackend.beforePatch = undefined;
      cosmosBackend.documents.set(photoId('a'), reclaimed);
    };

    await requeueStalePhotosHandler(timer, mockContext);

    expect(stored(photoId('a'))).toEqual(reclaimed);
    expect(queuedPhotoIds()).toEqual([]);
  });

  it('読んだ後にワーカーが担当していたら、その写真には触らない', async () => {
    cosmosBackend.documents.set(photoId('a'), photoWith(photoId('a'), { state: 'pending', step: 'classify', attempts: 0, lastError: null, updatedAt: STALE }));
    const claimed = photoWith(photoId('a'), { state: 'classifying', step: 'classify', attempts: 1, lastError: null, updatedAt: NOW });
    cosmosBackend.beforePatch = () => {
      cosmosBackend.beforePatch = undefined;
      cosmosBackend.documents.set(photoId('a'), claimed);
    };

    await requeueStalePhotosHandler(timer, mockContext);

    expect(stored(photoId('a'))).toEqual(claimed);
    expect(queuedPhotoIds()).toEqual([]);
  });

  it('キューへの投入に失敗しても、残りの写真の再投入を続け、写真は解析待ちのまま残る（次の回に拾う）', async () => {
    cosmosBackend.documents.set(photoId('a'), photoWith(photoId('a'), { state: 'classifying', step: 'classify', attempts: 1, lastError: null, updatedAt: STALE }));
    cosmosBackend.documents.set(photoId('b'), photoWith(photoId('b'), { state: 'pending', step: 'classify', attempts: 0, lastError: null, updatedAt: STALE }));
    queueBackend.forcedSendError = Object.assign(new Error('The specified queue does not exist.'), {
      name: 'RestError',
      statusCode: 404,
      code: 'QueueNotFound'
    });

    await expect(requeueStalePhotosHandler(timer, mockContext)).resolves.toBeUndefined();

    expect(stored(photoId('a')).processing.state).toBe('pending');
    expect(stored(photoId('b')).processing).toEqual({ state: 'pending', step: 'classify', attempts: 0, lastError: null, updatedAt: NOW });
  });

  it('読んだ後に、ワーカーが担当して失敗し解析待ちに戻していたら（state は同じで回数が違う）、その写真には触らない', async () => {
    // 読んだ値で上書きすると、回数が巻き戻って上限で止まらなくなる（06 §1.3）
    cosmosBackend.documents.set(photoId('a'), photoWith(photoId('a'), { state: 'pending', step: 'classify', attempts: 1, lastError: 'ai', updatedAt: STALE }));
    const failedAgain = photoWith(photoId('a'), { state: 'pending', step: 'classify', attempts: 2, lastError: 'ai', updatedAt: NOW });
    cosmosBackend.beforePatch = () => {
      cosmosBackend.beforePatch = undefined;
      cosmosBackend.documents.set(photoId('a'), failedAgain);
    };

    await requeueStalePhotosHandler(timer, mockContext);

    expect(stored(photoId('a'))).toEqual(failedAgain);
    expect(queuedPhotoIds()).toEqual([]);
  });

  it('読んだ後に写真が消されていても、残りの写真の再投入を続ける', async () => {
    cosmosBackend.documents.set(photoId('a'), photoWith(photoId('a'), { state: 'pending', step: 'classify', attempts: 0, lastError: null, updatedAt: STALE }));
    cosmosBackend.documents.set(photoId('b'), photoWith(photoId('b'), { state: 'pending', step: 'classify', attempts: 0, lastError: null, updatedAt: STALE }));
    cosmosBackend.beforePatch = () => {
      cosmosBackend.beforePatch = undefined;
      cosmosBackend.documents.delete(photoId('a'));
    };

    await expect(requeueStalePhotosHandler(timer, mockContext)).resolves.toBeUndefined();

    expect(cosmosBackend.documents.has(photoId('a'))).toBe(false);
    expect(queuedPhotoIds()).toEqual([photoId('b')]);
  });

  it('写真を読めなければ、例外を投げる（次の回に読み直す）', async () => {
    cosmosBackend.documents.set(photoId('a'), photoWith(photoId('a'), { state: 'pending', step: 'classify', attempts: 0, lastError: null, updatedAt: STALE }));
    const queryError = Object.assign(new Error('Service Unavailable'), { code: 503 });
    cosmosBackend.forcedQueryError = queryError;

    await expect(requeueStalePhotosHandler(timer, mockContext)).rejects.toBe(queryError);

    expect(queuedPhotoIds()).toEqual([]);
  });
  describe('タイムラインの下書き（段階5）', () => {
    const TRIP_ID = '123e4567-e89b-42d3-a456-426614174000';
    const TIMELINE_ID = `timeline-${TRIP_ID}`;
    const DRAFT_ID = '33333333-3333-4333-8333-333333333333';
    /** 処理（job）を指定した、区切り案を作っている下書きを持つタイムライン */
    const timelineWithJob = (job: TimelineJob | null, overrides: Partial<TimelineDraft> = {}) =>
      timelineDocument(TRIP_ID, {
        draft: timelineDraft(DRAFT_ID, `timeline-photos-${TRIP_ID}-22222222-2222-4222-8222-222222222222`, { phase: 'proposing', job, ...overrides })
      });
    const storedTimeline = () => cosmosBackend.documents.get(TIMELINE_ID) as any;
    const queuedTimelines = (): unknown[] => (queueBackend.queues.get('timeline-processing') ?? []).map(decodeQueueMessage);

    beforeEach(() => {
      process.env.TIMELINE_QUEUE_NAME = 'timeline-processing';
    });

    afterEach(() => {
      delete process.env.TIMELINE_QUEUE_NAME;
    });

    it.each(['pending', 'running'] as const)('10分以上止まっている下書き（%s）を、待ちに戻して（処理と回数はそのまま）タイムラインのキューに積む', async (state) => {
      cosmosBackend.documents.set(
        TIMELINE_ID,
        timelineWithJob({ step: 'propose', state, attempts: 1, lastError: 'ai', updatedAt: STALE })
      );

      await requeueStalePhotosHandler(timer, mockContext);

      expect(storedTimeline().draft.job).toEqual({ step: 'propose', state: 'pending', attempts: 1, lastError: 'ai', updatedAt: NOW });
      expect(queuedTimelines()).toEqual([{ tripId: TRIP_ID, draftId: DRAFT_ID }]);
      expect(queuedPhotoIds()).toEqual([]);
    });

    it('回数が上限（3回）に達した下書きは、積まずに失敗（failed）にする', async () => {
      cosmosBackend.documents.set(
        TIMELINE_ID,
        timelineWithJob({ step: 'write', state: 'running', attempts: 3, lastError: null, updatedAt: STALE }, { phase: 'writing' })
      );

      await requeueStalePhotosHandler(timer, mockContext);

      expect(storedTimeline().draft.job).toEqual({ step: 'write', state: 'failed', attempts: 3, lastError: null, updatedAt: NOW });
      expect(queuedTimelines()).toEqual([]);
    });

    it.each<[string, TimelineJob | null, Partial<TimelineDraft>]>([
      ['確かめ中で処理の無い', null, { phase: 'reviewing' }],
      ['失敗した', { step: 'propose', state: 'failed', attempts: 3, lastError: 'ai', updatedAt: STALE }, {}],
      ['止まってまだ10分たっていない', { step: 'propose', state: 'running', attempts: 1, lastError: null, updatedAt: FRESH }, {}]
    ])('%s下書きは拾わない（変えず、積まない）', async (_label, job, overrides) => {
      const timeline = timelineWithJob(job, overrides);
      cosmosBackend.documents.set(TIMELINE_ID, timeline);

      await requeueStalePhotosHandler(timer, mockContext);

      expect(storedTimeline()).toEqual(timeline);
      expect(queuedTimelines()).toEqual([]);
    });

    it('写真の再投入で失敗しても、タイムラインの下書きは積み直し、タイマーは失敗として終わる', async () => {
      // 写真の側の障害（1枚の書き込みの失敗など）で、止まった下書きがいつまでも積み直されない、ということにしない
      cosmosBackend.documents.set(photoId('a'), photoWith(photoId('a'), { state: 'pending', step: 'classify', attempts: 0, lastError: null, updatedAt: STALE }));
      const photoError = Object.assign(new Error('something went wrong'), { code: 500 });
      cosmosBackend.forcedErrorById = { [photoId('a')]: photoError };
      cosmosBackend.documents.set(
        TIMELINE_ID,
        timelineWithJob({ step: 'propose', state: 'pending', attempts: 0, lastError: null, updatedAt: STALE })
      );

      await expect(requeueStalePhotosHandler(timer, mockContext)).rejects.toBe(photoError);

      expect(storedTimeline().draft.job).toEqual({ step: 'propose', state: 'pending', attempts: 0, lastError: null, updatedAt: NOW });
      expect(queuedTimelines()).toEqual([{ tripId: TRIP_ID, draftId: DRAFT_ID }]);
    });

    it('下書きの無いタイムラインは拾わない', async () => {
      const timeline = timelineDocument(TRIP_ID);
      cosmosBackend.documents.set(TIMELINE_ID, timeline);

      await requeueStalePhotosHandler(timer, mockContext);

      expect(storedTimeline()).toEqual(timeline);
      expect(queuedTimelines()).toEqual([]);
    });

    it('読んだ後に下書きが置き換えられていたら（やめた・出し直した）、触らない', async () => {
      cosmosBackend.documents.set(
        TIMELINE_ID,
        timelineWithJob({ step: 'propose', state: 'pending', attempts: 0, lastError: null, updatedAt: STALE })
      );
      const replaced = timelineWithJob(
        { step: 'propose', state: 'pending', attempts: 0, lastError: null, updatedAt: STALE },
        { id: '44444444-4444-4444-8444-444444444444' }
      );
      cosmosBackend.beforePatch = (id) => {
        if (id === TIMELINE_ID) cosmosBackend.documents.set(TIMELINE_ID, replaced);
      };

      await requeueStalePhotosHandler(timer, mockContext);

      expect(storedTimeline()).toEqual(replaced);
      expect(queuedTimelines()).toEqual([]);
    });

    it('読んだ後にワーカーが下書きの処理を担当していたら、触らず、積まない', async () => {
      cosmosBackend.documents.set(
        TIMELINE_ID,
        timelineWithJob({ step: 'propose', state: 'pending', attempts: 0, lastError: null, updatedAt: STALE })
      );
      const taken = timelineWithJob({ step: 'propose', state: 'running', attempts: 1, lastError: null, updatedAt: FRESH });
      cosmosBackend.beforePatch = (id) => {
        if (id === TIMELINE_ID) cosmosBackend.documents.set(TIMELINE_ID, taken);
      };

      await requeueStalePhotosHandler(timer, mockContext);

      expect(storedTimeline()).toEqual(taken);
      expect(queuedTimelines()).toEqual([]);
    });

    it('読んだ後にタイムラインが消えていたら（旅行の削除など）、触らず、積まず、タイマーは失敗にしない', async () => {
      cosmosBackend.documents.set(
        TIMELINE_ID,
        timelineWithJob({ step: 'propose', state: 'pending', attempts: 0, lastError: null, updatedAt: STALE })
      );
      cosmosBackend.beforePatch = (id) => {
        if (id === TIMELINE_ID) cosmosBackend.documents.delete(TIMELINE_ID);
      };

      await expect(requeueStalePhotosHandler(timer, mockContext)).resolves.toBeUndefined();

      expect(cosmosBackend.documents.has(TIMELINE_ID)).toBe(false);
      expect(queuedTimelines()).toEqual([]);
    });
  });
});
