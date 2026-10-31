import { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { CosmosClient } from '@azure/cosmos';
import { BlobServiceClient, generateBlobSASQueryParameters } from '@azure/storage-blob';
import {
  patchTimelineDayHandler,
  patchTimelineSceneHandler,
  postTimelineExcludedPhotosHandler,
  postTimelineRecutHandler
} from '../../src/functions/timelineCurrent';
import { TimelineDocument, TimelinePhotoSnapshot } from '../../src/types/timeline';
import { FakeCosmosBackend, FakeCosmosDocument, createFakeContainer } from '../fakes/cosmos';
import { FakeBlobBackend, createFakeBlobServiceClient } from '../fakes/blob';
import { forEachCase } from '../helpers/cases';
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

/** ボディ付きの要求。text を渡すと、JSON として読めない本文にする */
const bodyRequest = (tripId: string, path: string, method: string, body: unknown, text?: string, params: Record<string, string> = {}): HttpRequest =>
  ({
    ...createRequest(tripId, path, method, params),
    headers: new Map([['content-type', 'application/json']]),
    json: async () => (text !== undefined ? JSON.parse(text) : body)
  }) as any as HttpRequest;

const patchRequest = (path: string, params: Record<string, string>, body: unknown, text?: string, tripId = TRIP_ID): HttpRequest =>
  bodyRequest(tripId, path, 'PATCH', body, text, params);

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

  // 05 §5.15「共通」の行。どの行もエンドポイントごとに1行で、ハンドラがその判定につながっていることだけを見る
  // （データベースの失敗の分類の全行を通す入口は helpers/databaseFailures.ts のコメントにある）。
  // PATCH の2つ（…/days/{date}・…/scenes/{photoId}）は 05 §5.15 の同じ表で決まる1つの操作なので、…/days/{date} で見る
  describe('どのエンドポイントにも共通の決まり', () => {
    type Send = (tripId: string) => Promise<HttpResponseInit>;
    const endpoints: [string, Send, string][] = [
      ['区切りを直し始める（POST …/recut）', (tripId) => postTimelineRecutHandler(createRequest(tripId, 'recut'), mockContext), 'タイムラインの作成の受付に失敗しました'],
      [
        '完成版の文を直す（PATCH …/days/{date}）',
        (tripId) => patchTimelineDayHandler(patchRequest('days/2026-10-05', { date: '2026-10-05' }, { title: 'x' }, undefined, tripId), mockContext),
        'タイムラインの更新に失敗しました'
      ],
      [
        '写真を外す（POST …/excluded-photos）',
        (tripId) => postTimelineExcludedPhotosHandler(bodyRequest(tripId, 'excluded-photos', 'POST', { photoIds: [photoId('b')] }), mockContext),
        'タイムラインの更新に失敗しました'
      ]
    ];
    const databaseFailures = endpoints.flatMap(([name, send, internalErrorMessage]) =>
      databaseFailureCases(internalErrorMessage).map(
        ([label, error, status, code, message]): [string, string, Send, Error, number, string, string] => [name, label, send, error, status, code, message]
      )
    );
    // 完成版があり、下書きは無い（どのエンドポイントも書き込みまで進む）
    const timeline = () => timelineDocument(TRIP_ID, { current, updatedAt: '2026-10-08T12:14:00.000Z' });

    beforeEach(() => {
      cosmosBackend.documents.set(TIMELINE_ID, timeline());
    });

    it('区切りの直し・日の文の更新・写真を外すのどれも、旅行IDがUUIDの形でなければ、400を返す', () => forEachCase(endpoints, async (_name, send, _label) => {
      const response = await send('not-a-uuid');

      expect(response.status).toBe(400);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'INVALID_REQUEST', message: '旅行IDの形式が無効です' } });
    }));

    it('区切りの直し・日の文の更新・写真を外すのどれも、旅行が無ければ、404（TRIP_NOT_FOUND）でタイムラインを変えない', () => forEachCase(endpoints, async (_name, send, _label) => {
      cosmosBackend.documents.delete(TRIP_ID);

      const response = await send(TRIP_ID);

      expect(response.status).toBe(404);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'TRIP_NOT_FOUND' } });
      expect(storedTimeline()).toEqual(timeline());
    }));

    it('区切りの直し・日の文の更新・写真を外すのどれも、読んでから書くまでに他の操作がタイムラインを書いたら、409（TIMELINE_STATE_CONFLICT）で書いたものを変えない', () => forEachCase(endpoints, async (_name, send, _label) => {
      const written = timelineDocument(TRIP_ID, {
        current,
        updatedAt: '2026-10-25T08:59:59.000Z'
      });
      cosmosBackend.beforeReplace = (id) => {
        if (id === TIMELINE_ID) cosmosBackend.documents.set(TIMELINE_ID, { ...written } as any);
      };

      const response = await send(TRIP_ID);

      expect(response.status).toBe(409);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'TIMELINE_STATE_CONFLICT' } });
      expect(storedTimeline()).toEqual(written);
    }));

    it('区切りの直し・日の文の更新・写真を外すのどれも、タイムラインを置き換えるときに、データベースに接続できなければ503、それ以外の失敗は500で決まった文言を返す', () => forEachCase(databaseFailures, async (_name, _label, send, error, status, code, message) => {
      cosmosBackend.forcedReplaceError = error;

      const response = await send(TRIP_ID);

      expect(response.status).toBe(status);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code, message } });
    }));
  });

  describe('区切りを直し始める（POST …/recut）', () => {
    const recut = () => postTimelineRecutHandler(createRequest(TRIP_ID, 'recut'), mockContext);

    it('写真の保存先の設定に鍵が無ければ、下書きを書かずに 500 を返す', async () => {
      process.env.STORAGE_CONNECTION_STRING = 'DefaultEndpointsProtocol=https;AccountName=test;EndpointSuffix=core.windows.net';
      const timeline = timelineDocument(TRIP_ID, { current });
      cosmosBackend.documents.set(TIMELINE_ID, timeline);

      const response = await recut();

      expect(response.status).toBe(500);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'INTERNAL_ERROR', message: 'タイムラインの作成の受付に失敗しました' } });
      expect(storedTimeline()).toEqual(timeline);
    });

    it('控えを読む直前に完成版が別の控えに変わっていたら（前の控えは消えた）、409 で下書きを作らない', async () => {
      cosmosBackend.documents.set(TIMELINE_ID, timelineDocument(TRIP_ID, { current }));
      const rebuilt = timelineDocument(TRIP_ID, { current: { ...current, snapshotId: `timeline-photos-${TRIP_ID}-22222222-2222-4222-8222-222222222222` } });
      cosmosBackend.beforeRead = (id) => {
        if (id === CURRENT_SNAPSHOT_ID) {
          cosmosBackend.documents.delete(CURRENT_SNAPSHOT_ID);
          cosmosBackend.documents.set(TIMELINE_ID, { ...rebuilt } as any);
        }
      };

      const response = await recut();

      expect(response.status).toBe(409);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'TIMELINE_STATE_CONFLICT' } });
      expect(storedTimeline()).toEqual(rebuilt);
    });

    it('完成版が同じままで控えだけが無ければ（壊れている）、500 で下書きを作らない', async () => {
      const timeline = timelineDocument(TRIP_ID, { current });
      cosmosBackend.documents.set(TIMELINE_ID, timeline);
      cosmosBackend.documents.delete(CURRENT_SNAPSHOT_ID);

      const response = await recut();

      expect(response.status).toBe(500);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'INTERNAL_ERROR', message: 'タイムラインの作成の受付に失敗しました' } });
      expect(storedTimeline()).toEqual(timeline);
    });

    it('完成版を読んだ後に旅行が消されていたら（控えも消えた）、404（TRIP_NOT_FOUND）で下書きを作らない', async () => {
      const timeline = timelineDocument(TRIP_ID, { current });
      cosmosBackend.documents.set(TIMELINE_ID, timeline);
      // 控えを読む直前に、控えと旅行が消された（タイムラインの文書は、下書きを書くかを見るために残す）
      cosmosBackend.beforeRead = (id) => {
        if (id === CURRENT_SNAPSHOT_ID) [CURRENT_SNAPSHOT_ID, TRIP_ID].forEach((docId) => cosmosBackend.documents.delete(docId));
      };

      const response = await recut();

      expect(response.status).toBe(404);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'TRIP_NOT_FOUND' } });
      expect(storedTimeline()).toEqual(timeline);
    });

    it('応答の日と場面には、完成版を作った後に消えた写真を出さない（確かめ中の下書きの読み取りと同じ形）', async () => {
      cosmosBackend.documents.set(TIMELINE_ID, timelineDocument(TRIP_ID, { current }));
      // 完成版を作った後に b を消した
      cosmosBackend.documents.delete(photoId('b'));

      const response = await recut();

      const scenes = (response.jsonBody as any).data.draft.days[0].scenes;
      expect(scenes[0].photos.map((photo: any) => photo.id)).toEqual([photoId('a')]);
    });

    it('完成版で外した写真を下書きに引き継ぎ、応答の日と場面に出さない', async () => {
      cosmosBackend.documents.set(TIMELINE_ID, timelineDocument(TRIP_ID, { current: { ...current, excludedPhotoIds: [photoId('b')] } }));

      const response = await recut();

      expect(storedTimeline()!.draft!.excludedPhotoIds).toEqual([photoId('b')]);
      const scenes = (response.jsonBody as any).data.draft.days[0].scenes;
      expect(scenes[0].photos.map((photo: any) => photo.id)).toEqual([photoId('a')]);
    });

    it('完成版の控えと区切りを写した確かめ中の下書き（recut。裏の処理なし）を作り、確かめ中の日と場面を返す（完成版はそのまま）', async () => {
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

    it('タイムラインが無い・下書きだけで完成版が無いときは、404（TIMELINE_NOT_FOUND）', () => forEachCase<[string, TimelineDocument[]]>([
      ['タイムラインが無い', []],
      ['下書きだけで完成版が無い', [timelineDocument(TRIP_ID, { draft: timelineDraft('33333333-3333-4333-8333-333333333333', CURRENT_SNAPSHOT_ID) })]]
    ], async (_label, timelines) => {
      timelines.forEach((doc) => cosmosBackend.documents.set(doc.id, doc as any));

      const response = await recut();

      expect(response.status).toBe(404);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'TIMELINE_NOT_FOUND', message: 'タイムラインが見つかりません' } });
    }));

    it('下書きがあれば（作り直しや区切りの直しの途中）、409（TIMELINE_STATE_CONFLICT）で下書きを変えない', async () => {
      const timeline = timelineDocument(TRIP_ID, { current, draft: timelineDraft('33333333-3333-4333-8333-333333333333', CURRENT_SNAPSHOT_ID) });
      cosmosBackend.documents.set(TIMELINE_ID, timeline);

      const response = await recut();

      expect(response.status).toBe(409);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'TIMELINE_STATE_CONFLICT' } });
      expect(storedTimeline()).toEqual(timeline);
    });
  });

  describe('写真を外す（POST …/excluded-photos）', () => {
    const exclude = (body: unknown) => postTimelineExcludedPhotosHandler(bodyRequest(TRIP_ID, 'excluded-photos', 'POST', body), mockContext);

    it('外した写真を完成版に足し（控えの順・重なりなし）、完成版を読んだ形で返して、外した写真を出さない（写真を全部外した日も出さない）', async () => {
      const timeline = timelineDocument(TRIP_ID, { current: { ...current, excludedPhotoIds: [photoId('d')] }, updatedAt: '2026-10-08T12:14:00.000Z' });
      cosmosBackend.documents.set(TIMELINE_ID, timeline);

      const response = await exclude({ photoIds: [photoId('b'), photoId('a'), photoId('b')] });

      expect(response.status).toBe(200);
      expect(storedTimeline()).toEqual({
        ...timeline,
        current: { ...current, excludedPhotoIds: [photoId('a'), photoId('b'), photoId('d')] },
        updatedAt: NOW
      });
      const data = (response.jsonBody as any).data;
      expect(data.timeline.current.days.map((day: any) => day.scenes.map((scene: any) => [scene.startPhotoId, scene.photos.map((p: any) => p.id)]))).toEqual([
        [[photoId('c'), [photoId('c')]]]
      ]);
      expect(data.timeline.changes).toEqual({ added: 0, removed: 0 });
      expect(data.pendingPhotoCount).toBe(0);
    });

    it('タイムラインを編集している途中でも外せ、編集中の下書きにも足す', async () => {
      const draft = timelineDraft('33333333-3333-4333-8333-333333333333', CURRENT_SNAPSHOT_ID, { reason: 'recut', excludedPhotoIds: [photoId('d')] });
      const timeline = timelineDocument(TRIP_ID, { current, draft });
      cosmosBackend.documents.set(TIMELINE_ID, timeline);

      const response = await exclude({ photoIds: [photoId('b')] });

      expect(response.status).toBe(200);
      // 外した写真の並びに意味は無いので並べ替えて比べる
      const stored = storedTimeline()!;
      expect({ ...stored, draft: { ...stored.draft!, excludedPhotoIds: [...stored.draft!.excludedPhotoIds!].sort() } }).toEqual({
        ...timeline,
        current: { ...current, excludedPhotoIds: [photoId('b')] },
        draft: { ...draft, excludedPhotoIds: [photoId('b'), photoId('d')] },
        updatedAt: NOW
      });
    });

    it('編集の途中でない下書き（5-6b より前の作り直し）があっても外せ、その下書きは変えない', async () => {
      const draft = timelineDraft('33333333-3333-4333-8333-333333333333', 'timeline-photos-other', { reason: 'rebuild' });
      cosmosBackend.documents.set(TIMELINE_ID, timelineDocument(TRIP_ID, { current, draft }));

      const response = await exclude({ photoIds: [photoId('b')] });

      expect(response.status).toBe(200);
      expect(storedTimeline()!.current!.excludedPhotoIds).toEqual([photoId('b')]);
      expect(storedTimeline()!.draft).toEqual(draft);
    });

    it('外した写真が変わらなければ（もう外してある）書き込まずに、完成版を読んだ形を返す（ほかの操作を 409 にしない）', async () => {
      const timeline = timelineDocument(TRIP_ID, { current: { ...current, excludedPhotoIds: [photoId('b')] }, updatedAt: '2026-10-08T12:14:00.000Z' });
      cosmosBackend.documents.set(TIMELINE_ID, timeline);

      const response = await exclude({ photoIds: [photoId('b')] });

      expect(response.status).toBe(200);
      expect(storedTimeline()).toEqual(timeline);
      expect((response.jsonBody as any).data.timeline.current.days[0].scenes[0].photos.map((p: any) => p.id)).toEqual([photoId('a')]);
    });

    it('写真の保存先の設定に鍵が無ければ、書かずに 500 を返す（外したのに失敗と返さない）', async () => {
      process.env.STORAGE_CONNECTION_STRING = 'DefaultEndpointsProtocol=https;AccountName=test;EndpointSuffix=core.windows.net';
      const timeline = timelineDocument(TRIP_ID, { current });
      cosmosBackend.documents.set(TIMELINE_ID, timeline);

      const response = await exclude({ photoIds: [photoId('b')] });

      expect(response.status).toBe(500);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'INTERNAL_ERROR', message: 'タイムラインの更新に失敗しました' } });
      expect(storedTimeline()).toEqual(timeline);
    });

    // photoIds の形の 400 は下書きの表の 1 と同じ規則（05 §5.15）。全ケースとボディの共通の行（JSON として読めない・null）は
    // timelineDraft.test.ts の「写真を外す（POST …/draft/excluded-photos）」で通し、ここはこの受付がその判定につながっていることを1行で見る。
    // 控えに無い写真は完成版の控えで見るので、この受付で見る
    it('外す写真が無い・完成版の控えに無い写真を含むときは、400 で何も書かない', () => forEachCase<[string, () => Promise<HttpResponseInit>, string]>([
      ['無い', () => exclude({}), '外す写真は写真IDの配列で指定してください'],
      ['控えに無い写真を含む', () => exclude({ photoIds: [photoId('a'), photoId('f')] }), '外す写真が無効です']
    ], async (_label, send, message) => {
      const timeline = timelineDocument(TRIP_ID, { current });
      cosmosBackend.documents.set(TIMELINE_ID, timeline);

      const response = await send();

      expect(response.status).toBe(400);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'INVALID_REQUEST', message } });
      expect(storedTimeline()).toEqual(timeline);
    }));

    it('タイムラインが無い・下書きだけで完成版が無いときは、404（タイムラインが見つかりません）', () => forEachCase<[string, TimelineDocument[]]>([
      ['タイムラインが無い', []],
      ['下書きだけで完成版が無い', [timelineDocument(TRIP_ID, { draft: timelineDraft('33333333-3333-4333-8333-333333333333', CURRENT_SNAPSHOT_ID) })]]
    ], async (_label, timelines) => {
      cosmosBackend.documents.delete(TIMELINE_ID);
      timelines.forEach((doc) => cosmosBackend.documents.set(doc.id, doc as any));

      const response = await exclude({ photoIds: [photoId('a')] });

      expect(response.status).toBe(404);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'TIMELINE_NOT_FOUND', message: 'タイムラインが見つかりません' } });
    }));

    // 控えが読めないときは区切りの直しの受付と同じ（05 §5.15 の共通の行。readUnlessOverlapped）。404・500 を含む全部の場合は「区切りを直し始める」で通し、ここはつながりを1行で見る
    it('控えを読む直前に完成版が別の控えに変わっていたら（作り直しで前の控えは消えた）、409 で書かない', async () => {
      cosmosBackend.documents.set(TIMELINE_ID, timelineDocument(TRIP_ID, { current }));
      const rebuilt = timelineDocument(TRIP_ID, { draft: timelineDraft('33333333-3333-4333-8333-333333333333', 'timeline-photos-other') });
      cosmosBackend.beforeRead = (id) => {
        if (id === CURRENT_SNAPSHOT_ID) {
          cosmosBackend.documents.set(TIMELINE_ID, rebuilt as any);
          cosmosBackend.documents.delete(CURRENT_SNAPSHOT_ID);
        }
      };

      const response = await exclude({ photoIds: [photoId('a')] });

      expect(response.status).toBe(409);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'TIMELINE_STATE_CONFLICT' } });
      expect(storedTimeline()).toEqual(rebuilt);
    });
  });

  describe('完成版の文を直す（PATCH …/days/{date}・PATCH …/scenes/{photoId}）', () => {
    const patchDay = (date: string, body: unknown) => patchTimelineDayHandler(patchRequest(`days/${date}`, { date }, body), mockContext);
    const patchScene = (photo: string, body: unknown) => patchTimelineSceneHandler(patchRequest(`scenes/${photo}`, { photoId: photo }, body), mockContext);
    const data = (response: any) => response.jsonBody.data;

    beforeEach(() => {
      cosmosBackend.documents.set(TIMELINE_ID, timelineDocument(TRIP_ID, { current, updatedAt: '2026-10-08T12:14:00.000Z' }));
    });

    it('日のタイトルを前後の空白を除いて保存して書いた主を利用者にし、完成版を読んだ形で返す（送らなかった、利用者が直したまとめはそのまま）', async () => {
      const edited = { ...current, dayTexts: { ...current.dayTexts, '2026-10-05': { ...current.dayTexts['2026-10-05'], summary: '自分のまとめ', summarySource: 'user' as const } } };
      cosmosBackend.documents.set(TIMELINE_ID, timelineDocument(TRIP_ID, { current: edited, updatedAt: '2026-10-08T12:14:00.000Z' }));

      const response = await patchDay('2026-10-05', { title: '  小樽の旅 ' });

      expect(response.status).toBe(200);
      expect(storedTimeline()!.current!.dayTexts['2026-10-05']).toEqual({
        title: '小樽の旅',
        titleSource: 'user',
        aiTitle: '1日目',
        summary: '自分のまとめ',
        summarySource: 'user',
        aiSummary: '1日目のまとめ',
        sceneStarts: [photoId('a'), photoId('c')]
      });
      expect(storedTimeline()!.updatedAt).toBe(NOW);
      expect(data(response).timeline.current.days[0]).toMatchObject({ date: '2026-10-05', title: '小樽の旅', titleSource: 'user', summary: '自分のまとめ', summarySource: 'user' });
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

    it('null か空の文字列を送った欄は AI が書いた文に戻す（タイトルは null、まとめは空）', async () => {
      const edited = { ...current, dayTexts: { ...current.dayTexts, '2026-10-06': { ...current.dayTexts['2026-10-06'], title: '自分の題', titleSource: 'user' as const, summary: '自分のまとめ', summarySource: 'user' as const } } };
      cosmosBackend.documents.set(TIMELINE_ID, timelineDocument(TRIP_ID, { current: edited }));

      const response = await patchDay('2026-10-06', { title: null, summary: '' });

      expect(response.status).toBe(200);
      expect(storedTimeline()!.current!.dayTexts['2026-10-06']).toEqual(dayText('2日目', [photoId('d')]));
    });

    it('区切りを直して足した場面（AI の文が無い）は、書いた見出しを保存でき、空にすると空に戻って書いた主も無くなる', async () => {
      const empty = { label: null, labelSource: null, aiLabel: null, note: null, noteSource: null, aiNote: null };
      const edited = { ...current, sceneTexts: { ...current.sceneTexts, [photoId('c')]: { ...empty, note: '自分の一言', noteSource: 'user' as const } } };
      cosmosBackend.documents.set(TIMELINE_ID, timelineDocument(TRIP_ID, { current: edited as any }));

      const response = await patchScene(photoId('c'), { label: '市場', note: null });

      expect(response.status).toBe(200);
      expect(storedTimeline()!.current!.sceneTexts[photoId('c')]).toEqual({ ...empty, label: '市場', labelSource: 'user' });
      expect(data(response).timeline.current.days[0].scenes[1]).toMatchObject({ startPhotoId: photoId('c'), label: '市場', labelSource: 'user', note: null, noteSource: null });
    });

    it('下書きがあっても完成版の文を直せる（下書きはそのまま）', async () => {
      const draft = timelineDraft('33333333-3333-4333-8333-333333333333', CURRENT_SNAPSHOT_ID, { reason: 'recut' });
      cosmosBackend.documents.set(TIMELINE_ID, timelineDocument(TRIP_ID, { current, draft }));

      const response = await patchScene(photoId('a'), { note: '空港の海鮮丼' });

      expect(response.status).toBe(200);
      expect(storedTimeline()!.draft).toEqual(draft);
      expect(storedTimeline()!.current!.sceneTexts[photoId('a')]).toMatchObject({ note: '空港の海鮮丼', noteSource: 'user' });
    });

    it('入力が正しくないときは、400 で何も変えない', () => forEachCase<[string, () => Promise<any>, string]>([
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
      ['一言が上限を超える', () => patchScene(photoId('a'), { note: '一'.repeat(201) }), '一言は200文字以内で指定してください'],
      // 欄ごとに（日はタイトル → まとめの順に）型 → 上限を見て、最初に当たったものを返す
      ['タイトルの型とまとめの上限がどちらも違う', () => patchDay('2026-10-05', { title: 1, summary: 'ま'.repeat(401) }), 'タイトルは文字列で指定してください'],
      ['タイトルの上限とまとめの型がどちらも違う', () => patchDay('2026-10-05', { title: '題'.repeat(41), summary: 1 }), 'タイトルは40文字以内で指定してください']
    ], async (_label, send, message) => {
      const before = storedTimeline();

      const response = await send();

      expect(response.status).toBe(400);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'INVALID_REQUEST', message } });
      expect(storedTimeline()).toEqual(before);
    }));

    it('直しても文が変わらなければ書き込まずに、完成版を読んだ形を返す（ほかの操作を 409 にしない）', async () => {
      // AI が書いた文のままの欄に null を送る（AI の文に戻す）＝ 変わらない
      const timeline = storedTimeline();

      const response = await patchDay('2026-10-05', { title: null });

      expect(response.status).toBe(200);
      // 書けば更新日時が今になる
      expect(storedTimeline()).toEqual(timeline);
    });

    it('入力が無効なら、旅行が無くても 400（データベースを読む前に確かめる）', async () => {
      cosmosBackend.documents.delete(TRIP_ID);

      const response = await patchDay('2026-10-05', {});

      expect(response.status).toBe(400);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'INVALID_REQUEST', message: '更新する項目が指定されていません' } });
    });

    it('書いた後に読み直したときに旅行が消えていたら、404（TRIP_NOT_FOUND）を返す', async () => {
      cosmosBackend.beforeReplace = (id) => {
        if (id === TIMELINE_ID) cosmosBackend.documents.delete(TRIP_ID);
      };

      const response = await patchDay('2026-10-05', { title: 'x' });

      expect(response.status).toBe(404);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'TRIP_NOT_FOUND' } });
    });

    it('上限は前後の空白を除いて数える（40 文字のタイトルの前後に空白があっても保存できる）', async () => {
      const response = await patchDay('2026-10-05', { title: ` ${'題'.repeat(40)} ` });

      expect(response.status).toBe(200);
      expect(storedTimeline()!.current!.dayTexts['2026-10-05'].title).toBe('題'.repeat(40));
    });

    // 家族の絵文字は見た目は1文字、UTF-16 では8単位
    it('上限は見た目の1文字で数え、絵文字でちょうど上限なら保存できる', () => forEachCase<[string, () => Promise<any>, () => string | null, string]>([
      ['タイトルが絵文字で40文字', () => patchDay('2026-10-05', { title: '👨‍👩‍👧'.repeat(40) }), () => storedTimeline()!.current!.dayTexts['2026-10-05'].title, '👨‍👩‍👧'.repeat(40)],
      ['見出しが絵文字で30文字', () => patchScene(photoId('a'), { label: '👨‍👩‍👧'.repeat(30) }), () => storedTimeline()!.current!.sceneTexts[photoId('a')].label, '👨‍👩‍👧'.repeat(30)]
    ], async (_label, send, saved, expected) => {
      cosmosBackend.documents.set(TIMELINE_ID, timelineDocument(TRIP_ID, { current, updatedAt: '2026-10-08T12:14:00.000Z' }));

      const response = await send();

      expect(response.status).toBe(200);
      expect(saved()).toBe(expected);
    }));

    it('前後の U+0085（次の行）も空白として除く（アプリの trim と同じ。それだけなら AI の文に戻す）', async () => {
      const edited = { ...current, dayTexts: { ...current.dayTexts, '2026-10-05': { ...current.dayTexts['2026-10-05'], summary: '自分のまとめ', summarySource: 'user' as const } } };
      cosmosBackend.documents.set(TIMELINE_ID, timelineDocument(TRIP_ID, { current: edited, updatedAt: '2026-10-08T12:14:00.000Z' }));

      const response = await patchDay('2026-10-05', { title: '\u0085小樽\u0085', summary: '\u0085' });

      expect(response.status).toBe(200);
      const texts = storedTimeline()!.current!.dayTexts['2026-10-05'];
      expect(texts.title).toBe('小樽');
      expect(texts.summary).toBe(current.dayTexts['2026-10-05'].aiSummary);
      expect(texts.summarySource).toBe('ai');
    });

    it('その日や場面が完成版に無いときは、404（TIMELINE_NOT_FOUND）で何も変えない', () => forEachCase<[string, () => Promise<any>, string]>([
      ['その日が完成版に無い', () => patchDay('2026-10-07', { title: 'x' }), 'その日はタイムラインにありません'],
      ['日付の形が違う', () => patchDay('2026-10-5', { title: 'x' }), 'その日はタイムラインにありません'],
      ['実在しない日付', () => patchDay('2026-02-30', { title: 'x' }), 'その日はタイムラインにありません'],
      ['暦に無い月の日付', () => patchDay('2026-13-01', { title: 'x' }), 'その日はタイムラインにありません'],
      ['その場面が完成版に無い', () => patchScene(photoId('b'), { label: 'x' }), 'その場面はタイムラインにありません']
    ], async (_label, send, message) => {
      const before = storedTimeline();

      const response = await send();

      expect(response.status).toBe(404);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'TIMELINE_NOT_FOUND', message } });
      expect(storedTimeline()).toEqual(before);
    }));

    it('タイムラインが無い・下書きだけで完成版が無いときは、404（タイムラインが見つかりません）', () => forEachCase<[string, TimelineDocument[]]>([
      ['タイムラインが無い', []],
      ['下書きだけで完成版が無い', [timelineDocument(TRIP_ID, { draft: timelineDraft('33333333-3333-4333-8333-333333333333', CURRENT_SNAPSHOT_ID) })]]
    ], async (_label, timelines) => {
      cosmosBackend.documents.delete(TIMELINE_ID);
      timelines.forEach((doc) => cosmosBackend.documents.set(doc.id, doc as any));

      const response = await patchDay('2026-10-05', { title: 'x' });

      expect(response.status).toBe(404);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'TIMELINE_NOT_FOUND', message: 'タイムラインが見つかりません' } });
    }));
  });
});
