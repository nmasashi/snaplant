import { InvocationContext } from '@azure/functions';
import { CosmosClient } from '@azure/cosmos';
import { processTimelineHandler } from '../../src/functions/processTimeline';
import { TimelineDocument, TimelineDraft, TimelineJob, TimelinePhotoSnapshot } from '../../src/types/timeline';
import { FakeCosmosBackend, FakeCosmosDocument, createFakeContainer } from '../fakes/cosmos';
import { timelineCurrent, timelineDocument, timelineDraft, timelinePhotosDocument, tripDocument } from '../helpers/albumDocuments';

// 外部依存のみモック。Cosmos DB は状態持ちの偽物、AI（管理外）は送った要求を残すモック
jest.mock('@azure/cosmos');
jest.mock('openai', () => {
  const MockOpenAI = jest.fn();
  return Object.assign(MockOpenAI, { default: MockOpenAI });
});
const MockedOpenAI = jest.requireMock('openai');
const MockedCosmosClient = CosmosClient as jest.MockedClass<typeof CosmosClient>;

const TRIP_ID = '123e4567-e89b-42d3-a456-426614174000';
const OTHER_TRIP_ID = '223e4567-e89b-42d3-a456-426614174000';
const TIMELINE_ID = `timeline-${TRIP_ID}`;
const DRAFT_ID = '0b8e1c5a-1111-4111-8111-111111111111';
const SNAPSHOT_ID = `timeline-photos-${TRIP_ID}-7c9e6679-2222-4222-8222-222222222222`;
const NOW = '2026-10-25T09:00:00.000Z';
const QUEUED_AT = '2026-10-25T08:59:00.000Z';

const ENV_KEYS = [
  'COSMOS_DB_ENDPOINT',
  'COSMOS_DB_KEY',
  'COSMOS_DB_DATABASE',
  'COSMOS_DB_ALBUM_CONTAINER',
  'AZURE_OPENAI_ENDPOINT',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_DEPLOYMENT_NAME',
  'AZURE_OPENAI_TIMELINE_DEPLOYMENT_NAME',
  'AZURE_OPENAI_API_VERSION',
  'OPENAI_API_KEY',
  'PHOTO_PROCESSING_MAX_ATTEMPTS'
] as const;

const photoId = (head: string): string => head.repeat(64);

/** 控えの写真。既定は名前・地名・コメントの無い風景の写真 */
const snapshotPhoto = (id: string, takenAt: string | null, overrides: Partial<TimelinePhotoSnapshot> = {}): TimelinePhotoSnapshot => ({
  id,
  takenAt,
  category: 'landscape',
  name: null,
  placeName: null,
  comment: null,
  blobName: `${id}.jpg`,
  thumbnailBlobName: `${id}.thumb.jpg`,
  ...overrides
});

/**
 * 2日の旅行の控え（日付の切り替えは4時）。撮影日時のある写真が撮影の順で先、無い写真が後
 * 1日目（10/05）: a・b・c と、翌日 2:30 の d（4時より前なので 10/05 に入る）。2日目（10/06）: e・f
 */
const PHOTOS: TimelinePhotoSnapshot[] = [
  snapshotPhoto(photoId('a'), '2026-10-05T07:50:12', { category: 'food', name: '海鮮丼', placeName: '北海道千歳市', comment: '空港で' }),
  snapshotPhoto(photoId('b'), '2026-10-05T08:10:00', { placeName: '北海道千歳市' }),
  snapshotPhoto(photoId('c'), '2026-10-05T12:30:00', { category: 'food', name: 'ラーメン', placeName: '札幌市' }),
  snapshotPhoto(photoId('d'), '2026-10-06T02:30:00', { category: 'other', placeName: '札幌市' }),
  snapshotPhoto(photoId('e'), '2026-10-06T09:00:00', { name: '小樽運河', placeName: '小樽市' }),
  snapshotPhoto(photoId('f'), '2026-10-06T11:00:00', { category: 'food', placeName: '小樽市' }),
  snapshotPhoto(photoId('9'), null, { comment: '日時の無い写真' })
];

const pendingJob = (overrides: Partial<TimelineJob> = {}): TimelineJob => ({
  step: 'propose',
  state: 'pending',
  attempts: 0,
  lastError: null,
  updatedAt: QUEUED_AT,
  ...overrides
});

/** 区切り案の待ちの下書き（作る受付が作った直後の形） */
const proposingDraft = (overrides: Partial<TimelineDraft> = {}): TimelineDraft =>
  timelineDraft(DRAFT_ID, SNAPSHOT_ID, { phase: 'proposing', job: pendingJob(), startedAt: QUEUED_AT, ...overrides });

const proposingTimeline = (overrides: Partial<TimelineDocument> = {}): TimelineDocument =>
  timelineDocument(TRIP_ID, { draft: proposingDraft(), updatedAt: QUEUED_AT, ...overrides });

describe('タイムラインのワーカー', () => {
  let mockContext: InvocationContext;
  let cosmosBackend: FakeCosmosBackend<FakeCosmosDocument>;
  let savedEnv: Record<string, string | undefined>;
  // AI に送った要求。どの接続先（クライアントの設定）から送ったかと一緒に残す
  let sent: Array<{ options: any; body: any }>;
  let reply: () => Promise<unknown>;

  /** AI が body を JSON の応答として返す */
  const answering = (body: unknown) => async () => ({ choices: [{ message: { content: JSON.stringify(body) } }] });
  const aiReturns = (body: unknown) => {
    reply = answering(body);
  };

  /** キューのトリガーが渡すメッセージ（本文の JSON は読まれた後のオブジェクトで届く） */
  const runWorker = (message: unknown = { tripId: TRIP_ID, draftId: DRAFT_ID }) => processTimelineHandler(message, mockContext);

  const storedTimeline = () => cosmosBackend.documents.get(TIMELINE_ID) as unknown as TimelineDocument | undefined;

  /** AI に送ったプロンプト（文字の部分） */
  const sentPrompt = (index = 0): string =>
    sent[index].body.messages[0].content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n');

  /** プロンプトのうち、その写真の番号の行 */
  const promptLineOf = (prompt: string, index: number): string | undefined =>
    prompt.split('\n').find((line) => line.includes(`[${index}]`));

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
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

    sent = [];
    MockedOpenAI.mockImplementation((options: any) => ({
      chat: {
        completions: {
          create: (body: any) => {
            sent.push({ options, body });
            return reply();
          }
        }
      }
    }));
    aiReturns({ sceneStarts: [0] });

    process.env.COSMOS_DB_ENDPOINT = 'https://test.documents.azure.com:443/';
    process.env.COSMOS_DB_KEY = 'test-key';
    process.env.COSMOS_DB_DATABASE = 'test-db';
    process.env.COSMOS_DB_ALBUM_CONTAINER = 'test-album';
    process.env.AZURE_OPENAI_ENDPOINT = 'https://test.openai.azure.com';
    process.env.AZURE_OPENAI_API_KEY = 'azure-api-key';
    process.env.AZURE_OPENAI_DEPLOYMENT_NAME = 'main-deployment';
    delete process.env.AZURE_OPENAI_TIMELINE_DEPLOYMENT_NAME;
    delete process.env.AZURE_OPENAI_API_VERSION;
    delete process.env.OPENAI_API_KEY;
    delete process.env.PHOTO_PROCESSING_MAX_ATTEMPTS;

    cosmosBackend.documents.set(TRIP_ID, tripDocument(TRIP_ID, '北海道 2026秋'));
    cosmosBackend.documents.set(SNAPSHOT_ID, timelinePhotosDocument(SNAPSHOT_ID, TRIP_ID, PHOTOS));
  });

  afterEach(() => {
    jest.useRealTimers();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    jest.clearAllMocks();
  });

  describe('区切り案', () => {
    it('区切り案の待ちの下書きを処理すると、AI の案に各日の最初の写真を足した区切りが入り、確かめ中になる（ほかの欄は変わらない）', async () => {
      cosmosBackend.documents.set(TIMELINE_ID, proposingTimeline());
      // 重なりと順の乱れは除いて並べ直す。2日目の最初（e）は AI が出さなくても入る
      aiReturns({ sceneStarts: [2, 0, 2, 5] });

      await runWorker();

      const starts = [photoId('a'), photoId('c'), photoId('e'), photoId('f')];
      expect(storedTimeline()).toEqual(
        proposingTimeline({
          draft: proposingDraft({ phase: 'reviewing', job: null, proposedStarts: starts, sceneStarts: starts }),
          updatedAt: NOW
        })
      );
    });

    it('作り直しでは、完成版で利用者が足した区切りを足し、消した区切りを消し（控えに無い写真の区切りは捨てる）、最後に各日の最初の写真を足す', async () => {
      // 完成版: AI の案 a・c・d に対して、利用者が b と控えに無い写真 z を足し、c と d を消した
      const current = timelineCurrent(`timeline-photos-${TRIP_ID}-old`, {
        proposedStarts: [photoId('a'), photoId('c'), photoId('d')],
        sceneStarts: [photoId('a'), photoId('b'), photoId('z')]
      });
      // 日付の切り替えを2時に変えて作り直したので、10/06 02:30 の d は2日目の最初になる（利用者が消していても場面の始まり）
      const draft = proposingDraft({ reason: 'rebuild', dayStartHour: 2 });
      cosmosBackend.documents.set(TIMELINE_ID, proposingTimeline({ current, draft }));
      aiReturns({ sceneStarts: [0, 2, 3, 4] });

      await runWorker();

      expect(storedTimeline()?.draft).toEqual({
        ...draft,
        phase: 'reviewing',
        job: null,
        proposedStarts: [photoId('a'), photoId('c'), photoId('d'), photoId('e')],
        sceneStarts: [photoId('a'), photoId('b'), photoId('d'), photoId('e')]
      });
      expect(storedTimeline()?.current).toEqual(current);
    });

    it('区切り案を出している間、下書きの処理は処理中（running）で、回数と時刻が更新されている', async () => {
      cosmosBackend.documents.set(TIMELINE_ID, proposingTimeline({ draft: proposingDraft({ job: pendingJob({ attempts: 1, lastError: 'ai' }) }) }));
      let duringAi: unknown;
      reply = async () => {
        duringAi = storedTimeline()?.draft?.job;
        return { choices: [{ message: { content: JSON.stringify({ sceneStarts: [0] }) } }] };
      };

      await runWorker();

      expect(duringAi).toEqual({ step: 'propose', state: 'running', attempts: 2, lastError: 'ai', updatedAt: NOW });
    });

    it('AI には画像を渡さず、撮影日時のある写真ごとに番号・何日目・撮影時刻・カテゴリ・名前・地名・コメントを1行で渡す（日時の無い写真は渡さない）', async () => {
      cosmosBackend.documents.set(TIMELINE_ID, proposingTimeline());

      await runWorker();

      expect(sent).toHaveLength(1);
      const content = sent[0].body.messages[0].content;
      expect(content.some((part: any) => part.type === 'image_url')).toBe(false);
      const prompt = sentPrompt();
      const first = promptLineOf(prompt, 0)!;
      for (const element of ['1日目', '10/05 07:50', '食べ物', '海鮮丼', '北海道千歳市', '空港で']) {
        expect(first).toContain(element);
      }
      // 翌日の 2:30 は日付の切り替え（4時）より前なので1日目
      expect(promptLineOf(prompt, 3)).toContain('1日目');
      expect(promptLineOf(prompt, 3)).toContain('10/06 02:30');
      // 図鑑の種類でないカテゴリは「その他」
      expect(promptLineOf(prompt, 3)).toContain('その他');
      expect(promptLineOf(prompt, 4)).toContain('2日目');
      expect(promptLineOf(prompt, 4)).toContain('風景');
      expect(promptLineOf(prompt, 4)).toContain('小樽運河');
      expect(promptLineOf(prompt, 6)).toBeUndefined();
      expect(prompt).not.toContain('日時の無い写真');
      // 日の区切り（何番から何日目か）も渡す。写真の行（[番号] で始まる）とは別の行
      const dayLines = prompt.split('\n').filter((line) => !line.trimStart().startsWith('['));
      expect(dayLines.find((line) => line.includes('1日目'))).toEqual(expect.stringMatching(/0.*3/));
      expect(dayLines.find((line) => line.includes('2日目'))).toEqual(expect.stringMatching(/4.*5/));
    });

    it('分類していない写真（カテゴリが無い）は、カテゴリを書かない', async () => {
      cosmosBackend.documents.set(
        SNAPSHOT_ID,
        timelinePhotosDocument(SNAPSHOT_ID, TRIP_ID, [snapshotPhoto(photoId('a'), '2026-10-05T07:50:12', { category: null, placeName: '札幌市' })])
      );
      cosmosBackend.documents.set(TIMELINE_ID, proposingTimeline());

      await runWorker();

      const line = promptLineOf(sentPrompt(), 0)!;
      expect(line).toContain('札幌市');
      for (const label of ['その他', '植物', '食べ物', '風景', 'null']) {
        expect(line).not.toContain(label);
      }
    });

    it('読んだ後に別のインスタンスが先に担当していたら、AI を呼ばずに終える', async () => {
      cosmosBackend.documents.set(TIMELINE_ID, proposingTimeline());
      // 同じ時刻に担当したので、処理は自分が書くはずだった形と同じになる
      const taken = proposingTimeline({ draft: proposingDraft({ job: pendingJob({ state: 'running', attempts: 1, updatedAt: NOW }) }) });
      let left = 1;
      cosmosBackend.beforePatch = (id) => {
        if (id === TIMELINE_ID && left-- > 0) cosmosBackend.documents.set(TIMELINE_ID, { ...taken } as any);
      };

      await expect(runWorker()).resolves.toBeUndefined();

      expect(sent).toEqual([]);
      expect(storedTimeline()).toEqual(taken);
    });

    it('応答は Structured Outputs（strict）で区切りの番号の配列に縛り、出力の上限は 4,000 トークン', async () => {
      cosmosBackend.documents.set(TIMELINE_ID, proposingTimeline());

      await runWorker();

      const body = sent[0].body;
      expect(body.max_completion_tokens).toBe(4000);
      expect(body.response_format.type).toBe('json_schema');
      expect(body.response_format.json_schema.strict).toBe(true);
      expect(body.response_format.json_schema.schema).toMatchObject({
        type: 'object',
        properties: { sceneStarts: { type: 'array', items: { type: 'integer' } } },
        required: ['sceneStarts'],
        additionalProperties: false
      });
      expect(body.temperature).toBeUndefined();
    });

    // タイムライン用のデプロイは beforeEach で消してあるので、無い行は何も足さない
    it.each<[string, Record<string, string>, string]>([
      ['タイムライン用のデプロイが設定されていれば、そこへ送る', { AZURE_OPENAI_TIMELINE_DEPLOYMENT_NAME: 'timeline-deployment' }, 'timeline-deployment'],
      ['タイムライン用のデプロイが無ければ、識別と同じデプロイへ送る', {}, 'main-deployment'],
      ['タイムライン用のデプロイが空白だけなら、識別と同じデプロイへ送る', { AZURE_OPENAI_TIMELINE_DEPLOYMENT_NAME: '  ' }, 'main-deployment']
    ])('%s', async (_case, env, expected) => {
      Object.assign(process.env, env);
      cosmosBackend.documents.set(TIMELINE_ID, proposingTimeline());

      await runWorker();

      expect(sent[0].body.model).toBe(expected);
      expect(sent[0].options.baseURL).toBe(`https://test.openai.azure.com/openai/deployments/${expected}`);
    });
  });

  describe('結果の書き込みが他の操作と重なったとき', () => {
    const DROPPED = { kind: 'scene' as const, key: photoId('a'), field: 'label' as const, text: '小樽運河さんぽ' };
    const proposedDraft = () =>
      proposingDraft({ phase: 'reviewing', job: null, proposedStarts: [photoId('a'), photoId('e')], sceneStarts: [photoId('a'), photoId('e')] });

    /** 結果を書く直前に、他の操作が書いた文書を置く（count 回まで。置いた文書は別の _etag になるので、読んだ _etag 付きの置き換えは 412 になる） */
    const othersWriteBeforeReplace = (write: (doc: TimelineDocument) => TimelineDocument | null, count = 1) => {
      let left = count;
      cosmosBackend.beforeReplace = (id) => {
        if (id !== TIMELINE_ID || left === 0) return;
        left -= 1;
        const doc = write(storedTimeline()!);
        if (doc === null) {
          cosmosBackend.documents.delete(TIMELINE_ID);
        } else {
          cosmosBackend.documents.set(TIMELINE_ID, doc as any);
        }
      };
    };

    it('下書きがまだ自分のもので処理も担当したときのままなら、3回まで重なっても、読み直した文書に同じ結果を当て直す（他の操作が書いたものは残す）', async () => {
      cosmosBackend.documents.set(TIMELINE_ID, proposingTimeline({ droppedEdits: [DROPPED] }));
      // 区切り案の間に、利用者が残せなかった文の知らせを閉じた（書くたびに他の操作がまた書く）
      othersWriteBeforeReplace((doc) => ({ ...doc, droppedEdits: [], updatedAt: '2026-10-25T08:59:30.000Z' }), 3);

      await runWorker();

      expect(storedTimeline()).toEqual(proposingTimeline({ draft: proposedDraft(), droppedEdits: [], updatedAt: NOW }));
    });

    it('当て直しても4回続けて重なったら、内部の失敗として待ちに戻して例外を投げる', async () => {
      cosmosBackend.documents.set(TIMELINE_ID, proposingTimeline({ droppedEdits: [DROPPED] }));
      othersWriteBeforeReplace((doc) => ({ ...doc, droppedEdits: [] }), 4);

      await expect(runWorker()).rejects.toThrow();

      expect(storedTimeline()).toEqual(
        proposingTimeline({ draft: proposingDraft({ job: pendingJob({ attempts: 1, lastError: 'internal', updatedAt: NOW }) }), droppedEdits: [] })
      );
    });

    it.each<[string, (doc: TimelineDocument) => TimelineDocument]>([
      ['下書きをやめた', (doc) => ({ ...doc, draft: null })],
      // 新しい下書きを別のインスタンスが同じ時刻に担当した（処理は自分が担当したときと同じ形になる。下書きの id だけで見分ける）
      [
        '下書きを出し直した',
        (doc) => ({
          ...doc,
          draft: proposingDraft({ id: '44444444-4444-4444-8444-444444444444', job: pendingJob({ state: 'running', attempts: 1, updatedAt: NOW }) })
        })
      ],
      ['再投入のタイマーが待ちに戻した', (doc) => ({ ...doc, draft: proposingDraft({ job: pendingJob({ attempts: 1, updatedAt: NOW }) }) })],
      [
        '再投入のタイマーが待ちに戻し、別のインスタンスが担当し直した',
        (doc) => ({ ...doc, draft: proposingDraft({ job: pendingJob({ state: 'running', attempts: 2, updatedAt: NOW }) }) })
      ]
    ])('%sなら、結果も失敗も書かずに終える', async (_case, write) => {
      cosmosBackend.documents.set(TIMELINE_ID, proposingTimeline());
      let written: TimelineDocument | undefined;
      othersWriteBeforeReplace((doc) => (written = write(doc)));

      await expect(runWorker()).resolves.toBeUndefined();

      expect(storedTimeline()).toEqual(written);
    });

    it('タイムラインが消えていたら（旅行の削除など）、何も書かずに終える', async () => {
      cosmosBackend.documents.set(TIMELINE_ID, proposingTimeline());
      othersWriteBeforeReplace(() => null);

      await expect(runWorker()).resolves.toBeUndefined();

      expect(storedTimeline()).toBeUndefined();
    });
  });

  describe('写真の多い旅行（一度に渡すのは 400 枚まで）', () => {
    /** その日の 6:00 から1分おきに撮った写真（id は日ごとの頭の数と通し番号から作る） */
    const photosOfDay = (date: string, head: number, count: number): TimelinePhotoSnapshot[] =>
      Array.from({ length: count }, (_, index) => {
        const minutes = 6 * 60 + index;
        const time = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00`;
        return snapshotPhoto((head * 100000 + index).toString(16).padStart(64, '0'), `${date}T${time}`);
      });
    const replies = (...bodies: unknown[]) => {
      reply = async () => ({ choices: [{ message: { content: JSON.stringify(bodies.shift()) } }] });
    };
    const useSnapshot = (photos: TimelinePhotoSnapshot[]) =>
      cosmosBackend.documents.set(SNAPSHOT_ID, timelinePhotosDocument(SNAPSHOT_ID, TRIP_ID, photos));

    it('上限を超える旅行は日の境目で分けて順に呼び、番号は呼び出しごとに 0 から振る', async () => {
      const day1 = photosOfDay('2026-10-05', 1, 250);
      const day2 = photosOfDay('2026-10-06', 2, 200);
      const day3 = photosOfDay('2026-10-07', 3, 100);
      useSnapshot([...day1, ...day2, ...day3]);
      cosmosBackend.documents.set(TIMELINE_ID, proposingTimeline());
      // 1回目は1日目（2日目を足すと上限を超える）、2回目は2日目と3日目
      replies({ sceneStarts: [0, 100] }, { sceneStarts: [0, 50, 200] });

      await runWorker();

      expect(sent).toHaveLength(2);
      expect(promptLineOf(sentPrompt(0), 249)).toContain('1日目');
      expect(promptLineOf(sentPrompt(0), 250)).toBeUndefined();
      expect(promptLineOf(sentPrompt(1), 0)).toContain('2日目');
      expect(promptLineOf(sentPrompt(1), 200)).toContain('3日目');
      expect(promptLineOf(sentPrompt(1), 299)).toContain('3日目');
      expect(promptLineOf(sentPrompt(1), 300)).toBeUndefined();
      const starts = [day1[0].id, day1[100].id, day2[0].id, day2[50].id, day3[0].id];
      expect(storedTimeline()?.draft).toMatchObject({ phase: 'reviewing', proposedStarts: starts, sceneStarts: starts });
    });

    it('ちょうど上限の枚数なら、日をまたいでも1回で呼ぶ', async () => {
      useSnapshot([...photosOfDay('2026-10-05', 1, 250), ...photosOfDay('2026-10-06', 2, 150)]);
      cosmosBackend.documents.set(TIMELINE_ID, proposingTimeline());

      await runWorker();

      expect(sent).toHaveLength(1);
      expect(promptLineOf(sentPrompt(0), 399)).toContain('2日目');
    });

    it('1日で上限を超える日は、撮影の順に上限ごとに切って呼び、切れ目を区切りにする', async () => {
      const day1 = photosOfDay('2026-10-05', 1, 450);
      useSnapshot(day1);
      cosmosBackend.documents.set(TIMELINE_ID, proposingTimeline());
      replies({ sceneStarts: [0, 10] }, { sceneStarts: [20] });

      await runWorker();

      expect(sent).toHaveLength(2);
      expect(promptLineOf(sentPrompt(0), 399)).toBeDefined();
      expect(promptLineOf(sentPrompt(0), 400)).toBeUndefined();
      expect(promptLineOf(sentPrompt(1), 49)).toBeDefined();
      expect(promptLineOf(sentPrompt(1), 50)).toBeUndefined();
      const starts = [day1[0].id, day1[10].id, day1[400].id, day1[420].id];
      expect(storedTimeline()?.draft).toMatchObject({ phase: 'reviewing', proposedStarts: starts, sceneStarts: starts });
    });

    it('分けて呼ぶ途中で失敗したら、途中までの結果は書かずに全体を失敗にする', async () => {
      useSnapshot([...photosOfDay('2026-10-05', 1, 250), ...photosOfDay('2026-10-06', 2, 200)]);
      cosmosBackend.documents.set(TIMELINE_ID, proposingTimeline());
      // 2回目の番号は2日目の枚数（200）以上なので範囲外
      replies({ sceneStarts: [0, 100] }, { sceneStarts: [0, 200] });

      await expect(runWorker()).rejects.toThrow();

      expect(storedTimeline()).toEqual(
        proposingTimeline({ draft: proposingDraft({ job: pendingJob({ attempts: 1, lastError: 'ai', updatedAt: NOW }) }) })
      );
    });
  });

  describe('失敗', () => {
    it.each<[string, () => Promise<unknown>]>([
      ['AI がエラーを返した', async () => {
        throw Object.assign(new Error('500 The server had an error while processing your request.'), { name: 'InternalServerError', status: 500 });
      }],
      ['AI の応答に写真の数以上の番号があった', answering({ sceneStarts: [0, 6] })],
      ['AI の応答に負の番号があった', answering({ sceneStarts: [-1] })],
      ['AI の応答に整数でない番号があった', answering({ sceneStarts: [1.5] })],
      ['AI の応答に番号でない値があった', answering({ sceneStarts: ['1'] })],
      ['AI の応答が配列でなかった', answering({ sceneStarts: 1 })]
    ])('%sら AI の失敗として、下書きを待ちに戻して例外を投げる（キューの再試行に任せる）', async (_case, aiReply) => {
      cosmosBackend.documents.set(TIMELINE_ID, proposingTimeline());
      reply = aiReply;

      await expect(runWorker()).rejects.toThrow();

      expect(storedTimeline()).toEqual(
        proposingTimeline({ draft: proposingDraft({ job: pendingJob({ attempts: 1, lastError: 'ai', updatedAt: NOW }) }) })
      );
    });

    it('区切り案の間に下書きをやめていたら、AI が失敗しても失敗を書かずに終える（例外も投げない）', async () => {
      cosmosBackend.documents.set(TIMELINE_ID, proposingTimeline());
      let cancelled: TimelineDocument | undefined;
      reply = async () => {
        cancelled = { ...storedTimeline()!, draft: null };
        cosmosBackend.documents.set(TIMELINE_ID, cancelled as any);
        throw Object.assign(new Error('500 The server had an error while processing your request.'), { name: 'InternalServerError', status: 500 });
      };

      await expect(runWorker()).resolves.toBeUndefined();

      expect(storedTimeline()).toEqual(cancelled);
    });

    it('回数の上限は PHOTO_PROCESSING_MAX_ATTEMPTS に従う（5 なら3回目の失敗は待ちに戻す）', async () => {
      process.env.PHOTO_PROCESSING_MAX_ATTEMPTS = '5';
      cosmosBackend.documents.set(TIMELINE_ID, proposingTimeline({ draft: proposingDraft({ job: pendingJob({ attempts: 2, lastError: 'ai' }) }) }));
      aiReturns({ sceneStarts: [99] });

      await expect(runWorker()).rejects.toThrow();

      expect(storedTimeline()?.draft?.job).toEqual(pendingJob({ attempts: 3, lastError: 'ai', updatedAt: NOW }));
    });

    it('写真の控えが無いなど AI 以外の失敗は、内部の失敗として待ちに戻して例外を投げ、AI は呼ばない', async () => {
      cosmosBackend.documents.delete(SNAPSHOT_ID);
      cosmosBackend.documents.set(TIMELINE_ID, proposingTimeline());

      await expect(runWorker()).rejects.toThrow();

      expect(storedTimeline()?.draft?.job).toEqual(pendingJob({ attempts: 1, lastError: 'internal', updatedAt: NOW }));
      expect(sent).toEqual([]);
    });

    it('回数が上限（3回）に達したら、失敗（failed）にして例外を投げずに終える（区切り案の段のまま）', async () => {
      cosmosBackend.documents.set(TIMELINE_ID, proposingTimeline({ draft: proposingDraft({ job: pendingJob({ attempts: 2, lastError: 'ai' }) }) }));
      aiReturns({ sceneStarts: [99] });

      await expect(runWorker()).resolves.toBeUndefined();

      expect(storedTimeline()).toEqual(
        proposingTimeline({ draft: proposingDraft({ job: pendingJob({ state: 'failed', attempts: 3, lastError: 'ai', updatedAt: NOW }) }) })
      );
    });
  });

  describe('何もしないメッセージ', () => {
    it.each<[string, unknown]>([
      ['旅行の id が無い', { draftId: DRAFT_ID }],
      ['下書きの id が無い', { tripId: TRIP_ID }],
      ['旅行の id が UUID の形でない', { tripId: 'trip/1', draftId: DRAFT_ID }],
      ['下書きの id が UUID の形でない', { tripId: TRIP_ID, draftId: '' }],
      ['本文が読めない', null]
    ])('%sメッセージは、何もせずに終える', async (_case, message) => {
      const timeline = proposingTimeline();
      cosmosBackend.documents.set(TIMELINE_ID, timeline);

      await expect(runWorker(message)).resolves.toBeUndefined();

      expect(storedTimeline()).toEqual(timeline);
      expect(sent).toEqual([]);
    });

    it.each<[string, TimelineDraft | null]>([
      ['下書きが無い（やめた）', null],
      ['別の下書き（出し直した）', proposingDraft({ id: '44444444-4444-4444-8444-444444444444' })],
      ['処理中（別のインスタンスが担当した）', proposingDraft({ job: pendingJob({ state: 'running', attempts: 1 }) })],
      ['失敗した', proposingDraft({ job: pendingJob({ state: 'failed', attempts: 3 }) })],
      ['確かめ中（区切り案は済んだ）', proposingDraft({ phase: 'reviewing', job: null })]
    ])('%sなら、何もせずに終える', async (_case, draft) => {
      const timeline = proposingTimeline({ draft });
      cosmosBackend.documents.set(TIMELINE_ID, timeline);

      await expect(runWorker()).resolves.toBeUndefined();

      expect(storedTimeline()).toEqual(timeline);
      expect(sent).toEqual([]);
    });

    it('タイムラインが無ければ（旅行の削除で消えた）、何もせずに終える', async () => {
      await expect(runWorker()).resolves.toBeUndefined();

      expect(storedTimeline()).toBeUndefined();
      expect(sent).toEqual([]);
    });

    it('旅行が無ければ（旅行の削除と作る受付が重なった）、その旅行のタイムラインと控えを消して終える（別の旅行のものは残す）', async () => {
      cosmosBackend.documents.delete(TRIP_ID);
      cosmosBackend.documents.set(TIMELINE_ID, proposingTimeline());
      const otherTimeline = timelineDocument(OTHER_TRIP_ID);
      const otherSnapshotId = `timeline-photos-${OTHER_TRIP_ID}-7c9e6679-2222-4222-8222-222222222222`;
      cosmosBackend.documents.set(otherTimeline.id, otherTimeline);
      cosmosBackend.documents.set(otherSnapshotId, timelinePhotosDocument(otherSnapshotId, OTHER_TRIP_ID));

      await expect(runWorker()).resolves.toBeUndefined();

      expect([...cosmosBackend.documents.keys()].sort()).toEqual([otherSnapshotId, otherTimeline.id].sort());
      expect(sent).toEqual([]);
    });
  });
});
