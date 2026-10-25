import { HttpRequest, InvocationContext } from '@azure/functions';
import { CosmosClient } from '@azure/cosmos';
import { BlobServiceClient, generateBlobSASQueryParameters } from '@azure/storage-blob';
import { patchTimelineDayHandler, patchTimelineSceneHandler, postTimelineRecutHandler } from '../../src/functions/timelineCurrent';
import { TimelineDocument, TimelinePhotoSnapshot } from '../../src/types/timeline';
import { FakeCosmosBackend, FakeCosmosDocument, createFakeContainer } from '../fakes/cosmos';
import { FakeBlobBackend, createFakeBlobServiceClient } from '../fakes/blob';
import { photoDocument, timelineCurrent, timelineDocument, timelineDraft, timelinePhotosDocument, tripDocument } from '../helpers/albumDocuments';
import { databaseFailureCases } from '../helpers/databaseFailures';

// タイムラインの完成版の操作（段階5。docs/05_api_design.md §5.15、文書は 04 §1.6）。
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
const CURRENT_SNAPSHOT_ID = `timeline-photos-${TRIP_ID}-11111111-1111-4111-8111-111111111111`;
const NOW = '2026-10-25T09:00:00.000Z';
const SAS = 'sig=test';

// 写真の id（SHA-256 の16進）。取り違えを見分けられるよう、先頭の文字だけ変える
const photoId = (head: string): string => head.repeat(64);

/** 完成版の控えの1枚 */
const snap = (head: string, takenAt: string | null): TimelinePhotoSnapshot => ({
  id: photoId(head),
  takenAt,
  category: 'landscape',
  name: null,
  placeName: null,
  comment: null,
  blobName: `${photoId(head)}.jpg`,
  thumbnailBlobName: `${photoId(head)}.thumb.jpg`
});

// 1日目（10/05）: a・b・c、2日目（10/06）: d
const PHOTOS = [snap('a', '2026-10-05T07:50:00'), snap('b', '2026-10-05T09:00:00'), snap('c', '2026-10-05T12:00:00'), snap('d', '2026-10-06T09:00:00')];

const sceneText = (label: string, photoIds: string[]) => ({
  label,
  labelSource: 'ai' as const,
  aiLabel: label,
  note: `${label}の一言`,
  noteSource: 'ai' as const,
  aiNote: `${label}の一言`,
  photoIds
});
const dayText = (title: string, sceneStarts: string[]) => ({
  title,
  titleSource: 'ai' as const,
  aiTitle: title,
  summary: `${title}のまとめ`,
  summarySource: 'ai' as const,
  aiSummary: `${title}のまとめ`,
  sceneStarts
});

/** 完成版。AI の案は a・d、利用者が c を足した。日付の切り替えは 5 時 */
const current = timelineCurrent(CURRENT_SNAPSHOT_ID, {
  dayStartHour: 5,
  proposedStarts: [photoId('a'), photoId('d')],
  sceneStarts: [photoId('a'), photoId('c'), photoId('d')],
  sceneTexts: {
    [photoId('a')]: sceneText('朝ごはん', [photoId('a'), photoId('b')]),
    [photoId('c')]: sceneText('昼ごはん', [photoId('c')]),
    [photoId('d')]: sceneText('運河', [photoId('d')])
  },
  dayTexts: {
    '2026-10-05': dayText('1日目', [photoId('a'), photoId('c')]),
    '2026-10-06': dayText('2日目', [photoId('d')])
  },
  writtenAt: '2026-10-08T12:14:00.000Z'
});

const createRequest = (tripId: string, path: string, method = 'POST', params: Record<string, string> = {}): HttpRequest =>
  ({
    method,
    url: `https://func-snaplant.azurewebsites.net/api/trips/${tripId}/timeline/${path}?code=test-key`,
    query: new Map([['code', 'test-key']]),
    headers: new Map(),
    params: { tripId, ...params }
  }) as any as HttpRequest;

describe('タイムラインの完成版の操作API', () => {
  let mockContext: InvocationContext;
  let cosmosBackend: FakeCosmosBackend<FakeCosmosDocument>;

  const storedTimeline = () => cosmosBackend.documents.get(TIMELINE_ID) as unknown as TimelineDocument | undefined;

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
    cosmosBackend.documents.set(CURRENT_SNAPSHOT_ID, timelinePhotosDocument(CURRENT_SNAPSHOT_ID, TRIP_ID, PHOTOS));
    PHOTOS.forEach((photo) => cosmosBackend.documents.set(photo.id, photoDocument(photo.id, { tripId: TRIP_ID, takenAt: photo.takenAt })));
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  describe('区切りを直し始める（POST …/recut）', () => {
    const recut = () => postTimelineRecutHandler(createRequest(TRIP_ID, 'recut'), mockContext);

    it('完成版の控えと区切りを写した確かめ中の下書き（recut）を作り、確かめ中の日と場面を返す（AI は呼ばない。完成版はそのまま）', async () => {
      const timeline = timelineDocument(TRIP_ID, { current, updatedAt: '2026-10-08T12:14:00.000Z' });
      cosmosBackend.documents.set(TIMELINE_ID, timeline);

      const response = await recut();

      expect(response.status).toBe(200);
      const stored = storedTimeline()!;
      expect(stored).toEqual({
        ...timeline,
        draft: {
          id: expect.stringMatching(/^[0-9a-f-]{36}$/),
          reason: 'recut',
          phase: 'reviewing',
          job: null,
          snapshotId: CURRENT_SNAPSHOT_ID,
          dayStartHour: 5,
          proposedStarts: [photoId('a'), photoId('d')],
          sceneStarts: [photoId('a'), photoId('c'), photoId('d')],
          startedAt: NOW
        },
        updatedAt: NOW
      });
      const data = (response.jsonBody as any).data;
      expect(data.urlExpiresAt).toBe('2026-10-25T10:00:00.000Z');
      expect(data.draft).toMatchObject({ id: stored.draft!.id, reason: 'recut', phase: 'reviewing', job: null, startedAt: NOW });
      expect(data.draft.days.map((day: any) => day.scenes.map((scene: any) => [scene.startPhotoId, scene.startedBy]))).toEqual([
        [
          [photoId('a'), 'day'],
          [photoId('c'), 'user']
        ],
        [[photoId('d'), 'day']]
      ]);
    });

    it.each<[string, TimelineDocument[]]>([
      ['タイムラインが無い', []],
      ['下書きだけで完成版が無い', [timelineDocument(TRIP_ID, { draft: timelineDraft('33333333-3333-4333-8333-333333333333', CURRENT_SNAPSHOT_ID) })]]
    ])('%sときは、404（TIMELINE_NOT_FOUND）', async (_label, timelines) => {
      timelines.forEach((doc) => cosmosBackend.documents.set(doc.id, doc as any));

      const response = await recut();

      expect(response.status).toBe(404);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'TIMELINE_NOT_FOUND', message: 'タイムラインが見つかりません' } });
    });

    it('下書きがあれば（作り直しや区切りの直しの途中）、409（TIMELINE_STATE_CONFLICT）で下書きを変えない', async () => {
      const timeline = timelineDocument(TRIP_ID, { current, draft: timelineDraft('33333333-3333-4333-8333-333333333333', CURRENT_SNAPSHOT_ID) });
      cosmosBackend.documents.set(TIMELINE_ID, timeline);

      const response = await recut();

      expect(response.status).toBe(409);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'TIMELINE_STATE_CONFLICT' } });
      expect(storedTimeline()).toEqual(timeline);
    });

    it('読んでから書くまでに他の操作がタイムラインを書いたら、409 で書いたものを変えない', async () => {
      cosmosBackend.documents.set(TIMELINE_ID, timelineDocument(TRIP_ID, { current }));
      const written = timelineDocument(TRIP_ID, { current, droppedEdits: [] , updatedAt: '2026-10-25T08:59:59.000Z' });
      cosmosBackend.beforeReplace = (id) => {
        if (id === TIMELINE_ID) cosmosBackend.documents.set(TIMELINE_ID, { ...written } as any);
      };

      const response = await recut();

      expect(response.status).toBe(409);
      expect(storedTimeline()).toEqual(written);
    });

    it('旅行が無ければ、404（TRIP_NOT_FOUND）を返す', async () => {
      cosmosBackend.documents.delete(TRIP_ID);

      const response = await recut();

      expect(response.status).toBe(404);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'TRIP_NOT_FOUND' } });
    });

    it('旅行IDがUUIDの形でなければ、400を返す', async () => {
      const response = await postTimelineRecutHandler(createRequest('not-a-uuid', 'recut'), mockContext);

      expect(response.status).toBe(400);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'INVALID_REQUEST', message: '旅行IDの形式が無効です' } });
    });

    it.each(databaseFailureCases('タイムラインの作成の受付に失敗しました'))('タイムラインを置き換えるときに%s', async (_case, error, status, code, message) => {
      cosmosBackend.documents.set(TIMELINE_ID, timelineDocument(TRIP_ID, { current }));
      cosmosBackend.forcedReplaceError = error;

      const response = await recut();

      expect(response.status).toBe(status);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code, message } });
    });
  });

  describe('完成版の文を直す（PATCH …/days/{date}・PATCH …/scenes/{photoId}）', () => {
    /** ボディ付きの要求。text を渡すと、JSON として読めない本文にする */
    const patchRequest = (path: string, params: Record<string, string>, body: unknown, text?: string, tripId = TRIP_ID): HttpRequest =>
      ({
        ...createRequest(tripId, path, 'PATCH', params),
        headers: new Map([['content-type', 'application/json']]),
        json: async () => (text !== undefined ? JSON.parse(text) : body)
      }) as any as HttpRequest;
    const patchDay = (date: string, body: unknown) => patchTimelineDayHandler(patchRequest(`days/${date}`, { date }, body), mockContext);
    const patchScene = (photo: string, body: unknown) => patchTimelineSceneHandler(patchRequest(`scenes/${photo}`, { photoId: photo }, body), mockContext);
    const data = (response: any) => response.jsonBody.data;

    beforeEach(() => {
      cosmosBackend.documents.set(TIMELINE_ID, timelineDocument(TRIP_ID, { current, updatedAt: '2026-10-08T12:14:00.000Z' }));
    });

    it('日のタイトルを前後の空白を除いて保存して書いた主を利用者にし、完成版を読んだ形で返す（まとめはそのまま）', async () => {
      const response = await patchDay('2026-10-05', { title: '  小樽の旅 ' });

      expect(response.status).toBe(200);
      expect(storedTimeline()!.current!.dayTexts['2026-10-05']).toEqual({ ...dayText('1日目', [photoId('a'), photoId('c')]), title: '小樽の旅', titleSource: 'user' });
      expect(storedTimeline()!.updatedAt).toBe(NOW);
      expect(data(response).timeline.current.days[0]).toMatchObject({ date: '2026-10-05', title: '小樽の旅', titleSource: 'user', summary: '1日目のまとめ', summarySource: 'ai' });
      expect(data(response)).toMatchObject({ pendingPhotoCount: 0, urlExpiresAt: '2026-10-25T10:00:00.000Z' });
    });

    it('場面の見出しを保存し、空白だけの一言は AI が書いた文に戻して書いた主を AI にする', async () => {
      const edited = { ...current, sceneTexts: { ...current.sceneTexts, [photoId('c')]: { ...current.sceneTexts[photoId('c')], note: '自分の一言', noteSource: 'user' as const } } };
      cosmosBackend.documents.set(TIMELINE_ID, timelineDocument(TRIP_ID, { current: edited }));

      const response = await patchScene(photoId('c'), { label: 'ラーメン', note: '   ' });

      expect(response.status).toBe(200);
      expect(storedTimeline()!.current!.sceneTexts[photoId('c')]).toEqual({ ...sceneText('昼ごはん', [photoId('c')]), label: 'ラーメン', labelSource: 'user' });
      expect(data(response).timeline.current.days[0].scenes[1]).toMatchObject({ startPhotoId: photoId('c'), label: 'ラーメン', labelSource: 'user', note: '昼ごはんの一言', noteSource: 'ai' });
    });

    it('null を送った欄は AI が書いた文に戻す（日のタイトルとまとめ）', async () => {
      const edited = { ...current, dayTexts: { ...current.dayTexts, '2026-10-06': { ...current.dayTexts['2026-10-06'], title: '自分の題', titleSource: 'user' as const, summary: '自分のまとめ', summarySource: 'user' as const } } };
      cosmosBackend.documents.set(TIMELINE_ID, timelineDocument(TRIP_ID, { current: edited }));

      const response = await patchDay('2026-10-06', { title: null, summary: '' });

      expect(response.status).toBe(200);
      expect(storedTimeline()!.current!.dayTexts['2026-10-06']).toEqual(dayText('2日目', [photoId('d')]));
    });

    it('下書きがあっても完成版の文を直せる（下書きはそのまま）', async () => {
      const draft = timelineDraft('33333333-3333-4333-8333-333333333333', CURRENT_SNAPSHOT_ID, { reason: 'recut' });
      cosmosBackend.documents.set(TIMELINE_ID, timelineDocument(TRIP_ID, { current, draft }));

      const response = await patchScene(photoId('a'), { note: '空港の海鮮丼' });

      expect(response.status).toBe(200);
      expect(storedTimeline()!.draft).toEqual(draft);
      expect(storedTimeline()!.current!.sceneTexts[photoId('a')]).toMatchObject({ note: '空港の海鮮丼', noteSource: 'user' });
    });

    it.each<[string, () => Promise<any>, string]>([
      ['写真IDの形式が無効', () => patchScene('xyz', { label: 'x' }), '写真IDの形式が無効です'],
      ['ボディが JSON として読めない', () => patchTimelineDayHandler(patchRequest('days/2026-10-05', { date: '2026-10-05' }, undefined, '{'), mockContext), 'リクエストボディの形式が無効です'],
      ['ボディが null', () => patchDay('2026-10-05', null), 'リクエストボディが指定されていません'],
      ['どちらの項目も無い（日）', () => patchDay('2026-10-05', {}), '更新する項目が指定されていません'],
      ['どちらの項目も無い（場面）', () => patchScene(photoId('a'), { title: 'x' }), '更新する項目が指定されていません'],
      ['タイトルが文字列でも null でもない', () => patchDay('2026-10-05', { title: 1 }), 'タイトルは文字列で指定してください'],
      ['まとめが文字列でも null でもない', () => patchDay('2026-10-05', { summary: ['x'] }), 'まとめは文字列で指定してください'],
      ['見出しが文字列でも null でもない', () => patchScene(photoId('a'), { label: 1 }), '見出しは文字列で指定してください'],
      ['一言が文字列でも null でもない', () => patchScene(photoId('a'), { note: true }), '一言は文字列で指定してください'],
      ['タイトルが上限を超える', () => patchDay('2026-10-05', { title: '題'.repeat(41) }), 'タイトルは40文字以内で指定してください'],
      ['まとめが上限を超える', () => patchDay('2026-10-05', { summary: 'ま'.repeat(401) }), 'まとめは400文字以内で指定してください'],
      ['見出しが上限を超える', () => patchScene(photoId('a'), { label: '見'.repeat(31) }), '見出しは30文字以内で指定してください'],
      ['一言が上限を超える', () => patchScene(photoId('a'), { note: '一'.repeat(201) }), '一言は200文字以内で指定してください']
    ])('%sときは、400 で何も変えない', async (_label, send, message) => {
      const before = storedTimeline();

      const response = await send();

      expect(response.status).toBe(400);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'INVALID_REQUEST', message } });
      expect(storedTimeline()).toEqual(before);
    });

    it('上限は前後の空白を除いて数える（40 文字のタイトルの前後に空白があっても保存できる）', async () => {
      const response = await patchDay('2026-10-05', { title: ` ${'題'.repeat(40)} ` });

      expect(response.status).toBe(200);
      expect(storedTimeline()!.current!.dayTexts['2026-10-05'].title).toBe('題'.repeat(40));
    });

    it.each<[string, () => Promise<any>, string]>([
      ['その日が完成版に無い', () => patchDay('2026-10-07', { title: 'x' }), 'その日はタイムラインにありません'],
      ['日付の形が違う', () => patchDay('2026-10-5', { title: 'x' }), 'その日はタイムラインにありません'],
      ['実在しない日付', () => patchDay('2026-02-30', { title: 'x' }), 'その日はタイムラインにありません'],
      ['その場面が完成版に無い', () => patchScene(photoId('b'), { label: 'x' }), 'その場面はタイムラインにありません']
    ])('%sときは、404（TIMELINE_NOT_FOUND）で何も変えない', async (_label, send, message) => {
      const before = storedTimeline();

      const response = await send();

      expect(response.status).toBe(404);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'TIMELINE_NOT_FOUND', message } });
      expect(storedTimeline()).toEqual(before);
    });

    it.each<[string, TimelineDocument[]]>([
      ['タイムラインが無い', []],
      ['下書きだけで完成版が無い', [timelineDocument(TRIP_ID, { draft: timelineDraft('33333333-3333-4333-8333-333333333333', CURRENT_SNAPSHOT_ID) })]]
    ])('%sときは、404（タイムラインが見つかりません）', async (_label, timelines) => {
      cosmosBackend.documents.delete(TIMELINE_ID);
      timelines.forEach((doc) => cosmosBackend.documents.set(doc.id, doc as any));

      const response = await patchDay('2026-10-05', { title: 'x' });

      expect(response.status).toBe(404);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'TIMELINE_NOT_FOUND', message: 'タイムラインが見つかりません' } });
    });

    it('読んでから書くまでに他の操作がタイムラインを書いたら、409（TIMELINE_STATE_CONFLICT）で書いたものを変えない', async () => {
      const written = timelineDocument(TRIP_ID, { current, droppedEdits: [], updatedAt: '2026-10-25T08:59:59.000Z' });
      cosmosBackend.beforeReplace = (id) => {
        if (id === TIMELINE_ID) cosmosBackend.documents.set(TIMELINE_ID, { ...written } as any);
      };

      const response = await patchDay('2026-10-05', { title: 'x' });

      expect(response.status).toBe(409);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'TIMELINE_STATE_CONFLICT' } });
      expect(storedTimeline()).toEqual(written);
    });

    it('旅行が無ければ、404（TRIP_NOT_FOUND）を返す', async () => {
      cosmosBackend.documents.delete(TRIP_ID);

      const response = await patchScene(photoId('a'), { label: 'x' });

      expect(response.status).toBe(404);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'TRIP_NOT_FOUND' } });
    });

    it('旅行IDがUUIDの形でなければ、400を返す', async () => {
      const response = await patchTimelineDayHandler(patchRequest('days/2026-10-05', { date: '2026-10-05' }, { title: 'x' }, undefined, 'not-a-uuid'), mockContext);

      expect(response.status).toBe(400);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'INVALID_REQUEST', message: '旅行IDの形式が無効です' } });
    });

    it.each(databaseFailureCases('タイムラインの更新に失敗しました'))('タイムラインを置き換えるときに%s', async (_case, error, status, code, message) => {
      cosmosBackend.forcedReplaceError = error;

      const response = await patchDay('2026-10-05', { title: 'x' });

      expect(response.status).toBe(status);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code, message } });
    });
  });
});
