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

/** AI に渡す写真の行の頭（06 §8.4 の `[番号] 何日目 …`） */
const PHOTO_LINE = /^\[\d+\] \d+日目/;

/** プロンプトのうち、写真の行でない行（日の区切り・書いてほしい場面と日・前に書いた文など） */
const nonPhotoLines = (prompt: string): string[] => prompt.split('\n').filter((line) => !PHOTO_LINE.test(line.trimStart()));

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

/** 写真の多い旅行の、その日の 6:00 から1分おきに撮った写真（id は日ごとの頭の数と通し番号から作る） */
const photosOfDay = (date: string, head: number, count: number): TimelinePhotoSnapshot[] =>
  Array.from({ length: count }, (_, index) => {
    const minutes = 6 * 60 + index;
    const time = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00`;
    return snapshotPhoto((head * 100000 + index).toString(16).padStart(64, '0'), `${date}T${time}`);
  });

/**
 * 2日の旅行の控え（日付の切り替えは4時）。撮影日時のある写真が撮影の順で先、無い写真が後
 * 1日目（10/05）: a・b・c と、翌日 2:30 の d（4時より前なので 10/05 に入る）。2日目（10/06）: e・f
 * （写真の無い日を挟んだときの何日目かの数え方は、日の分け方を共有する timelineDraft.test.ts で通している）
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
  /** 分けて呼ぶとき、AI が呼ばれた順に bodies を1つずつ返す */
  const replies = (...bodies: unknown[]) => {
    reply = async () => ({ choices: [{ message: { content: JSON.stringify(bodies.shift()) } }] });
  };
  /** 下書きの控えの写真を置き換える */
  const useSnapshot = (photos: TimelinePhotoSnapshot[]) =>
    cosmosBackend.documents.set(SNAPSHOT_ID, timelinePhotosDocument(SNAPSHOT_ID, TRIP_ID, photos));

  /** キューのトリガーが渡すメッセージ（本文の JSON は読まれた後のオブジェクトで届く） */
  const runWorker = (message: unknown = { tripId: TRIP_ID, draftId: DRAFT_ID }) => processTimelineHandler(message, mockContext);

  const storedTimeline = () => cosmosBackend.documents.get(TIMELINE_ID) as unknown as TimelineDocument | undefined;

  /** AI に送ったプロンプト（文字の部分） */
  const sentPrompt = (index = 0): string =>
    sent[index].body.messages[0].content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n');

  /** プロンプトのうち、その写真の番号の行 */
  const promptLineOf = (prompt: string, index: number): string | undefined =>
    prompt.split('\n').find((line) => line.includes(`[${index}]`));

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
      // 撮影時刻は分まで（秒を付けない。後ろに空白が続く）
      for (const element of ['1日目', '10/05 07:50 ', '食べ物', '海鮮丼', '北海道千歳市', '空港で']) {
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
      const dayLines = nonPhotoLines(prompt);
      expect(dayLines.find((line) => line.includes('1日目'))).toEqual(expect.stringMatching(/0.*3/));
      expect(dayLines.find((line) => line.includes('2日目'))).toEqual(expect.stringMatching(/4.*5/));
    });

    it('名前・地名・コメントに改行があっても、写真1枚は1行のまま渡す（改行は空白にする）', async () => {
      // コメントは利用者が書く。改行の後ろが別の写真の行に見えると、AI が番号を取り違える
      cosmosBackend.documents.set(
        SNAPSHOT_ID,
        timelinePhotosDocument(SNAPSHOT_ID, TRIP_ID, [
          snapshotPhoto(photoId('a'), '2026-10-05T07:50:12', { name: '海鮮\n丼', placeName: '北海道\r\n千歳市', comment: '朝ごはん\n[1] 2日目 10/06 08:00 食べ物' }),
          snapshotPhoto(photoId('b'), '2026-10-05T08:10:00')
        ])
      );
      cosmosBackend.documents.set(TIMELINE_ID, proposingTimeline());

      await runWorker();

      const photoLines = sentPrompt().split('\n').filter((line) => PHOTO_LINE.test(line.trimStart()));
      expect(photoLines).toHaveLength(2);
      expect(photoLines[0]).toContain('海鮮 丼');
      expect(photoLines[0]).toContain('北海道 千歳市');
      expect(photoLines[0]).toContain('朝ごはん [1] 2日目');
      expect(photoLines[1]).toContain('10/05 08:10');
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

    it('読んだ後に下書きを出し直していたら（処理は同じ形の待ち）、担当せず AI を呼ばずに終える', async () => {
      cosmosBackend.documents.set(TIMELINE_ID, proposingTimeline());
      const reissued = proposingTimeline({ draft: proposingDraft({ id: '44444444-4444-4444-8444-444444444444' }) });
      let left = 1;
      cosmosBackend.beforePatch = (id) => {
        if (id === TIMELINE_ID && left-- > 0) cosmosBackend.documents.set(TIMELINE_ID, { ...reissued } as any);
      };

      await expect(runWorker()).resolves.toBeUndefined();

      expect(sent).toEqual([]);
      expect(storedTimeline()).toEqual(reissued);
    });

    it('応答は Structured Outputs（strict）で区切りの番号の配列に縛り、出力の上限は 4,000 トークン', async () => {
      cosmosBackend.documents.set(TIMELINE_ID, proposingTimeline());

      await runWorker();

      const body = sent[0].body;
      expect(body.max_completion_tokens).toBe(4000);
      expect(body.response_format.type).toBe('json_schema');
      expect(body.response_format.json_schema.strict).toBe(true);
      // strict では全プロパティが required に要るので、外側は完全一致で見る（項目の説明の文言は契約外）
      expect(body.response_format.json_schema.schema).toEqual({
        type: 'object',
        properties: { sceneStarts: expect.objectContaining({ type: 'array', items: { type: 'integer' } }) },
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

    it('分けて呼ぶときは順に呼び、前の呼び出しが失敗したら残りは呼ばない', async () => {
      useSnapshot([...photosOfDay('2026-10-05', 1, 250), ...photosOfDay('2026-10-06', 2, 200)]);
      cosmosBackend.documents.set(TIMELINE_ID, proposingTimeline());
      // 1回目の番号は1日目の枚数（250）以上なので範囲外
      replies({ sceneStarts: [250] }, { sceneStarts: [0] });

      await expect(runWorker()).rejects.toThrow();

      expect(sent).toHaveLength(1);
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

    it.each<[string, TimelineDraft | null]>([
      ['下書きをやめていた', null],
      // 新しい下書きを別のインスタンスが同じ時刻に担当した（処理は自分の担当と同じ形。下書きの id だけで見分ける）
      [
        '下書きを出し直し、別のインスタンスが担当していた',
        proposingDraft({ id: '44444444-4444-4444-8444-444444444444', job: pendingJob({ state: 'running', attempts: 1, updatedAt: NOW }) })
      ]
    ])('区切り案の間に%sら、AI が失敗しても失敗を書かずに終える（例外も投げない）', async (_case, draft) => {
      cosmosBackend.documents.set(TIMELINE_ID, proposingTimeline());
      let changed: TimelineDocument | undefined;
      reply = async () => {
        changed = { ...storedTimeline()!, draft };
        cosmosBackend.documents.set(TIMELINE_ID, changed as any);
        throw Object.assign(new Error('500 The server had an error while processing your request.'), { name: 'InternalServerError', status: 500 });
      };

      await expect(runWorker()).resolves.toBeUndefined();

      expect(storedTimeline()).toEqual(changed);
    });

    it('失敗を書くときは、処理の時刻を失敗した時刻にする（再投入のタイマーはそこから数える）', async () => {
      cosmosBackend.documents.set(TIMELINE_ID, proposingTimeline());
      reply = async () => {
        jest.setSystemTime(new Date('2026-10-25T09:03:00.000Z'));
        throw Object.assign(new Error('500 The server had an error while processing your request.'), { name: 'InternalServerError', status: 500 });
      };

      await expect(runWorker()).rejects.toThrow();

      expect(storedTimeline()?.draft?.job).toEqual(pendingJob({ attempts: 1, lastError: 'ai', updatedAt: '2026-10-25T09:03:00.000Z' }));
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

  describe('文を書く', () => {
    // 区切り: 1日目は a（a・b）と c（c・d）、2日目は e と、利用者が足した f
    const PROPOSED = [photoId('a'), photoId('c'), photoId('e')];
    const STARTS = [photoId('a'), photoId('c'), photoId('e'), photoId('f')];
    const writingJob = (overrides: Partial<TimelineJob> = {}) => pendingJob({ step: 'write', ...overrides });
    const writingDraft = (overrides: Partial<TimelineDraft> = {}) =>
      proposingDraft({ phase: 'writing', job: writingJob(), proposedStarts: PROPOSED, sceneStarts: STARTS, ...overrides });
    const writingTimeline = (overrides: Partial<TimelineDocument> = {}) => proposingTimeline({ draft: writingDraft(), ...overrides });

    /** AI の応答（撮影日時のある写真の番号は a=0・b=1・c=2・d=3・e=4・f=5） */
    const allTexts = {
      days: [
        { date: '2026-10-05', title: '千歳と札幌', summary: '空港で海鮮丼を食べ、札幌でラーメン。' },
        { date: '2026-10-06', title: '小樽', summary: '小樽運河を歩いた。' }
      ],
      scenes: [
        { start: 0, label: '朝ごはん', note: '空港の海鮮丼' },
        { start: 2, label: '昼ごはん', note: '札幌のラーメン' },
        { start: 4, label: '運河', note: '小樽運河' },
        { start: 5, label: 'おやつ', note: '小樽で一休み' }
      ]
    };
    const aiScene = (label: string, note: string, photoIds: string[]) => ({
      label,
      labelSource: 'ai' as const,
      aiLabel: label,
      note,
      noteSource: 'ai' as const,
      aiNote: note,
      photoIds
    });
    const aiDay = (title: string, summary: string, sceneStarts: string[]) => ({
      title,
      titleSource: 'ai' as const,
      aiTitle: title,
      summary,
      summarySource: 'ai' as const,
      aiSummary: summary,
      sceneStarts
    });

    beforeEach(() => {
      aiReturns(allTexts);
    });

    it('完成版の日付の切り替えの時刻は、下書きのものを写す', async () => {
      cosmosBackend.documents.set(TIMELINE_ID, writingTimeline({ draft: writingDraft({ dayStartHour: 5 }) }));

      await runWorker();

      expect(storedTimeline()!.current!.dayStartHour).toBe(5);
    });

    it('完成版の無い下書きは、AI が全部の日と場面の文を書き、完成版に入れ替わって下書きが消える', async () => {
      cosmosBackend.documents.set(TIMELINE_ID, writingTimeline());

      await runWorker();

      expect(storedTimeline()).toEqual(
        proposingTimeline({
          current: {
            snapshotId: SNAPSHOT_ID,
            dayStartHour: 4,
            proposedStarts: PROPOSED,
            sceneStarts: STARTS,
            sceneTexts: {
              [photoId('a')]: aiScene('朝ごはん', '空港の海鮮丼', [photoId('a'), photoId('b')]),
              [photoId('c')]: aiScene('昼ごはん', '札幌のラーメン', [photoId('c'), photoId('d')]),
              [photoId('e')]: aiScene('運河', '小樽運河', [photoId('e')]),
              [photoId('f')]: aiScene('おやつ', '小樽で一休み', [photoId('f')])
            },
            dayTexts: {
              '2026-10-05': aiDay('千歳と札幌', '空港で海鮮丼を食べ、札幌でラーメン。', [photoId('a'), photoId('c')]),
              '2026-10-06': aiDay('小樽', '小樽運河を歩いた。', [photoId('e'), photoId('f')])
            },
            writtenAt: NOW
          },
          draft: null,
          droppedEdits: [],
          updatedAt: NOW
        })
      );
    });

    it('AI には画像を渡さず、写真の行と日の区切りに加えて、書いてほしい場面（最初の写真の番号）と日を渡す', async () => {
      cosmosBackend.documents.set(TIMELINE_ID, writingTimeline());

      await runWorker();

      expect(sent).toHaveLength(1);
      expect(sent[0].body.messages[0].content.some((part: any) => part.type === 'image_url')).toBe(false);
      const prompt = sentPrompt();
      for (const element of ['1日目', '10/05 07:50 ', '食べ物', '海鮮丼', '北海道千歳市', '空港で']) {
        expect(promptLineOf(prompt, 0)).toContain(element);
      }
      const otherLines = nonPhotoLines(prompt);
      for (const start of ['0番', '2番', '4番', '5番']) {
        expect(otherLines.some((line) => line.includes(start))).toBe(true);
      }
      for (const date of ['2026-10-05', '2026-10-06']) {
        expect(otherLines.some((line) => line.includes(date))).toBe(true);
      }
    });

    it('応答は Structured Outputs（strict）で日と場面の文に縛り、出力の上限は 16,000 トークン', async () => {
      cosmosBackend.documents.set(TIMELINE_ID, writingTimeline());

      await runWorker();

      const body = sent[0].body;
      expect(body.max_completion_tokens).toBe(16000);
      expect(body.response_format.json_schema.strict).toBe(true);
      // strict では全プロパティが required に要るので、外側は完全一致で見る（項目の説明の文言は契約外）
      expect(body.response_format.json_schema.schema).toEqual({
        type: 'object',
        properties: {
          days: expect.objectContaining({
            type: 'array',
            items: expect.objectContaining({
              type: 'object',
              properties: {
                date: expect.objectContaining({ type: 'string' }),
                title: expect.objectContaining({ type: 'string' }),
                summary: expect.objectContaining({ type: 'string' })
              },
              required: ['date', 'title', 'summary'],
              additionalProperties: false
            })
          }),
          scenes: expect.objectContaining({
            type: 'array',
            items: expect.objectContaining({
              type: 'object',
              properties: {
                start: expect.objectContaining({ type: 'integer' }),
                label: expect.objectContaining({ type: 'string' }),
                note: expect.objectContaining({ type: 'string' })
              },
              required: ['start', 'label', 'note'],
              additionalProperties: false
            })
          })
        },
        required: ['days', 'scenes'],
        additionalProperties: false
      });
    });

    // 重なりと頼んでいないものの行は、数を頼んだ数に合わせる（数が違うと、数の検査で先に落ちて、その行の検査に届かない）
    it.each<[string, unknown]>([
      ['頼んだ日が無い', { ...allTexts, days: allTexts.days.slice(1) }],
      ['同じ日が2回ある', { ...allTexts, days: [allTexts.days[0], allTexts.days[0]] }],
      ['頼んでいない場面がある', { ...allTexts, scenes: [{ start: 1, label: 'x', note: 'x' }, ...allTexts.scenes.slice(1)] }],
      ['頼んだ場面が無い', { ...allTexts, scenes: allTexts.scenes.slice(1) }],
      ['空白だけの見出しがある', { ...allTexts, scenes: [{ ...allTexts.scenes[0], label: '  ' }, ...allTexts.scenes.slice(1)] }],
      ['空のまとめがある', { ...allTexts, days: [{ ...allTexts.days[0], summary: '' }, allTexts.days[1]] }],
      ['日が配列でない', { ...allTexts, days: null }]
    ])('AI の応答に%sときは AI の失敗として、下書きを待ちに戻して例外を投げる（完成版は作らない）', async (_label, body) => {
      cosmosBackend.documents.set(TIMELINE_ID, writingTimeline());
      aiReturns(body);

      await expect(runWorker()).rejects.toThrow();

      expect(storedTimeline()).toEqual(
        writingTimeline({ draft: writingDraft({ job: writingJob({ attempts: 1, lastError: 'ai', updatedAt: NOW }) }) })
      );
    });

    it('AI の文は前後の空白を除き、上限（タイトル 40・まとめ 400・見出し 30・一言 200 文字）を超える分は切り詰める', async () => {
      cosmosBackend.documents.set(TIMELINE_ID, writingTimeline());
      aiReturns({
        days: [{ date: '2026-10-05', title: ` ${'題'.repeat(41)} `, summary: 'ま'.repeat(401) }, allTexts.days[1]],
        scenes: [{ start: 0, label: `　${'見'.repeat(31)}`, note: '一'.repeat(201) }, ...allTexts.scenes.slice(1)]
      });

      await runWorker();

      const current = storedTimeline()!.current!;
      expect(current.dayTexts['2026-10-05']).toMatchObject({ title: '題'.repeat(40), aiTitle: '題'.repeat(40), summary: 'ま'.repeat(400) });
      expect(current.sceneTexts[photoId('a')]).toMatchObject({ label: '見'.repeat(30), aiLabel: '見'.repeat(30), note: '一'.repeat(200) });
    });

    describe('写真の多い旅行（一度に渡すのは 400 枚まで）', () => {
      const scene = (start: number, label: string) => ({ start, label, note: `${label}の一言` });
      const day = (date: string, title: string) => ({ date, title, summary: `${title}のまとめ` });
      /** 区切り（AI の案も同じ）の文を書く待ちの下書きを置く */
      const useWritingDraft = (starts: string[]) =>
        cosmosBackend.documents.set(TIMELINE_ID, writingTimeline({ draft: writingDraft({ proposedStarts: starts, sceneStarts: starts }) }));
      const linesAsking = (prompt: string, words: string) => nonPhotoLines(prompt).filter((line) => line.includes(words));

      it('上限を超える旅行は日の境目で分けて順に呼び、番号は呼び出しごとに 0 から振って、その呼び出しの場面と日だけを書かせる', async () => {
        const day1 = photosOfDay('2026-10-05', 1, 250);
        const day2 = photosOfDay('2026-10-06', 2, 200);
        useSnapshot([...day1, ...day2]);
        const starts = [day1[0].id, day1[100].id, day2[0].id, day2[50].id];
        useWritingDraft(starts);
        replies(
          { days: [day('2026-10-05', '1日目')], scenes: [scene(0, '朝'), scene(100, '昼')] },
          { days: [day('2026-10-06', '2日目')], scenes: [scene(0, '朝2'), scene(50, '昼2')] }
        );

        await runWorker();

        expect(sent).toHaveLength(2);
        expect(promptLineOf(sentPrompt(0), 249)).toBeDefined();
        expect(promptLineOf(sentPrompt(0), 250)).toBeUndefined();
        expect(promptLineOf(sentPrompt(1), 199)).toContain('2日目');
        expect(linesAsking(sentPrompt(0), '書いてほしい日')[0]).not.toContain('2026-10-06');
        expect(linesAsking(sentPrompt(1), '書いてほしい日')[0]).not.toContain('2026-10-05');
        const current = storedTimeline()!.current!;
        expect(Object.fromEntries(starts.map((id) => [id, current.sceneTexts[id].label]))).toEqual({
          [day1[0].id]: '朝',
          [day1[100].id]: '昼',
          [day2[0].id]: '朝2',
          [day2[50].id]: '昼2'
        });
        expect(current.dayTexts['2026-10-06'].title).toBe('2日目');
      });

      it('1日で上限を超える日は場面の境目で分けて呼び、日の文はその日の最初の場面を含む呼び出しで書かせる', async () => {
        const day1 = photosOfDay('2026-10-05', 1, 450);
        useSnapshot(day1);
        // 区切り案で 400 枚目は切れ目になっているが、利用者が消して 300 枚目に区切りを入れた
        useWritingDraft([day1[0].id, day1[300].id]);
        replies({ days: [day('2026-10-05', '長い1日')], scenes: [scene(0, '午前')] }, { days: [], scenes: [scene(0, '午後')] });

        await runWorker();

        expect(sent).toHaveLength(2);
        expect(promptLineOf(sentPrompt(0), 299)).toBeDefined();
        expect(promptLineOf(sentPrompt(0), 300)).toBeUndefined();
        expect(promptLineOf(sentPrompt(1), 149)).toBeDefined();
        const current = storedTimeline()!.current!;
        expect(current.sceneTexts[day1[300].id].label).toBe('午後');
        expect(current.dayTexts['2026-10-05'].title).toBe('長い1日');
      });

      it('分けて呼ぶ途中で失敗したら、途中までの文は書かずに全体を失敗にする', async () => {
        const day1 = photosOfDay('2026-10-05', 1, 250);
        const day2 = photosOfDay('2026-10-06', 2, 200);
        useSnapshot([...day1, ...day2]);
        useWritingDraft([day1[0].id, day2[0].id]);
        // 2回目は頼んだ場面が無い
        replies({ days: [day('2026-10-05', '1日目')], scenes: [scene(0, '朝')] }, { days: [day('2026-10-06', '2日目')], scenes: [] });

        await expect(runWorker()).rejects.toThrow();

        expect(storedTimeline()!.current).toBeNull();
        expect(storedTimeline()!.draft!.job).toEqual(writingJob({ attempts: 1, lastError: 'ai', updatedAt: NOW }));
      });
    });

    describe('作り直し（完成版があるとき）', () => {
      const OLD_SNAPSHOT_ID = `timeline-photos-${TRIP_ID}-33333333-3333-4333-8333-333333333333`;
      const userScene = (label: string, aiLabel: string, photoIds: string[]) => ({
        ...aiScene(aiLabel, `${aiLabel}の一言`, photoIds),
        label,
        labelSource: 'user' as const
      });
      const userDay = (title: string, aiTitle: string, sceneStarts: string[]) => ({
        ...aiDay(aiTitle, `${aiTitle}のまとめ`, sceneStarts),
        title,
        titleSource: 'user' as const
      });

      /**
       * 前の完成版。区切りは a（a・b）・c（c だけ。前は d が無かった）・e（e・f）
       * a の場面と 1日目は今の区切りでも同じ。c と e の場面・2日目は写真や区切りが変わった。f は新しい場面
       */
      const oldCurrent = () =>
        timelineCurrent(OLD_SNAPSHOT_ID, {
          proposedStarts: [photoId('a'), photoId('c'), photoId('e')],
          sceneStarts: [photoId('a'), photoId('c'), photoId('e')],
          sceneTexts: {
            [photoId('a')]: userScene('空港の朝', '朝ごはん', [photoId('a'), photoId('b')]),
            [photoId('c')]: userScene('札幌ラーメン', '昼ごはん', [photoId('c')]),
            [photoId('e')]: aiScene('小樽', '運河と店', [photoId('e'), photoId('f')])
          },
          dayTexts: {
            '2026-10-05': userDay('北海道1日目', '千歳と札幌', [photoId('a'), photoId('c')]),
            '2026-10-06': userDay('運河の日', '小樽', [photoId('e')])
          },
          writtenAt: '2026-10-08T12:14:00.000Z'
        });
      const rebuilding = (current = oldCurrent()) =>
        writingTimeline({ current, draft: writingDraft({ reason: 'rebuild' }) });

      /** 書かせるもの（c・e・f の場面と 2日目）だけの応答 */
      const changedTexts = {
        days: [{ date: '2026-10-06', title: '小樽散歩', summary: '運河を歩いて一休み。' }],
        scenes: [
          { start: 2, label: '昼ごはん', note: '札幌のラーメン' },
          { start: 4, label: '運河', note: '小樽運河' },
          { start: 5, label: 'おやつ', note: '小樽で一休み' }
        ]
      };

      beforeEach(() => {
        cosmosBackend.documents.set(OLD_SNAPSHOT_ID, timelinePhotosDocument(OLD_SNAPSHOT_ID, TRIP_ID, PHOTOS));
        aiReturns(changedTexts);
      });

      it('写真と区切りが同じ場面と日は文をそのまま使い、変わった場面と日は AI に書かせて、利用者の文は残し AI の文だけ新しくする', async () => {
        cosmosBackend.documents.set(TIMELINE_ID, rebuilding());

        await runWorker();

        const current = storedTimeline()!.current!;
        expect(current.sceneTexts).toEqual({
          [photoId('a')]: oldCurrent().sceneTexts[photoId('a')],
          [photoId('c')]: { ...userScene('札幌ラーメン', '昼ごはん', [photoId('c'), photoId('d')]), note: '札幌のラーメン', aiNote: '札幌のラーメン' },
          [photoId('e')]: aiScene('運河', '小樽運河', [photoId('e')]),
          [photoId('f')]: aiScene('おやつ', '小樽で一休み', [photoId('f')])
        });
        expect(current.dayTexts).toEqual({
          '2026-10-05': oldCurrent().dayTexts['2026-10-05'],
          '2026-10-06': { ...userDay('運河の日', '小樽散歩', [photoId('e'), photoId('f')]), summary: '運河を歩いて一休み。', aiSummary: '運河を歩いて一休み。' }
        });
        expect(current).toMatchObject({ snapshotId: SNAPSHOT_ID, proposedStarts: PROPOSED, sceneStarts: STARTS, writtenAt: NOW });
        expect(storedTimeline()!.draft).toBeNull();
      });

      it('AI には、変わった場面と日だけを書かせ、引き継ぐ文と利用者が書いた文を文脈として渡す', async () => {
        cosmosBackend.documents.set(TIMELINE_ID, rebuilding());

        await runWorker();

        const otherLines = nonPhotoLines(sentPrompt());
        const scenesLine = otherLines.find((line) => line.includes('書いてほしい場面'))!;
        expect(scenesLine).toEqual(expect.stringContaining('2番'));
        expect(scenesLine).toEqual(expect.stringContaining('4番'));
        expect(scenesLine).toEqual(expect.stringContaining('5番'));
        expect(scenesLine).not.toContain('0番');
        const daysLine = otherLines.find((line) => line.includes('書いてほしい日'))!;
        expect(daysLine).toContain('2026-10-06');
        expect(daysLine).not.toContain('2026-10-05');
        for (const text of ['空港の朝', '北海道1日目', '札幌ラーメン', '運河の日']) {
          expect(otherLines.some((line) => line.includes(text))).toBe(true);
        }
        // 引き継ぐ場面は AI の文も渡し、書き直す場面の AI の前の文は渡さない（書き直させるため）
        expect(otherLines.some((line) => line.includes('朝ごはんの一言'))).toBe(true);
        expect(otherLines.some((line) => line.includes('昼ごはんの一言'))).toBe(false);
        // 今の区切り（全部の場面）と日の区切り（何番から何日目か）も渡す
        expect(otherLines.some((line) => ['0番', '2番', '4番', '5番'].every((start) => line.includes(start)))).toBe(true);
        expect(otherLines.some((line) => ['2日目', '4番', '5番'].every((text) => line.includes(text)))).toBe(true);
      });

      it('分けて呼ぶ作り直しでは、頼むものが無い呼び出しを飛ばし、前の文の文脈もその呼び出しの分だけ渡す', async () => {
        const day1 = photosOfDay('2026-10-05', 1, 250);
        const day2 = photosOfDay('2026-10-06', 2, 200);
        useSnapshot([...day1, ...day2]);
        const starts = [day1[0].id, day2[0].id];
        // 1日目は場面も日も前と同じ。2日目は場面の写真が増えた（前は 100 枚）が、日の区切りは同じ
        const current = timelineCurrent(OLD_SNAPSHOT_ID, {
          proposedStarts: starts,
          sceneStarts: starts,
          sceneTexts: {
            [day1[0].id]: aiScene('1日目の場面', '1日目の一言', day1.map((photo) => photo.id)),
            [day2[0].id]: aiScene('2日目の場面', '2日目の一言', day2.slice(0, 100).map((photo) => photo.id))
          },
          dayTexts: {
            '2026-10-05': aiDay('1日目のタイトル', '1日目のまとめ', [day1[0].id]),
            '2026-10-06': aiDay('2日目のタイトル', '2日目のまとめ', [day2[0].id])
          }
        });
        cosmosBackend.documents.set(TIMELINE_ID, writingTimeline({ current, draft: writingDraft({ reason: 'rebuild', proposedStarts: starts, sceneStarts: starts }) }));
        replies({ days: [], scenes: [{ start: 0, label: '新しい2日目', note: '一言' }] });

        await runWorker();

        expect(sent).toHaveLength(1);
        const lines = nonPhotoLines(sentPrompt(0));
        expect(lines.some((line) => line.includes('2日目のタイトル'))).toBe(true);
        expect(lines.some((line) => line.includes('1日目のタイトル'))).toBe(false);
        expect(storedTimeline()!.current!.sceneTexts[day2[0].id].label).toBe('新しい2日目');
      });

      it('1日を分けて呼ぶときは、日の文の文脈をその日の最初の場面を含む呼び出しだけで渡す', async () => {
        const day1 = photosOfDay('2026-10-05', 1, 450);
        useSnapshot(day1);
        const starts = [day1[0].id, day1[300].id];
        // 最初の場面と日の区切りは前と同じ。2つ目の場面は写真が増えた（前は 100 枚）
        const current = timelineCurrent(OLD_SNAPSHOT_ID, {
          proposedStarts: starts,
          sceneStarts: starts,
          sceneTexts: {
            [day1[0].id]: aiScene('午前', '午前の一言', day1.slice(0, 300).map((photo) => photo.id)),
            [day1[300].id]: aiScene('午後', '午後の一言', day1.slice(300, 400).map((photo) => photo.id))
          },
          dayTexts: { '2026-10-05': aiDay('長い日のタイトル', '長い日のまとめ', starts) }
        });
        cosmosBackend.documents.set(TIMELINE_ID, writingTimeline({ current, draft: writingDraft({ reason: 'rebuild', proposedStarts: starts, sceneStarts: starts }) }));
        replies({ days: [], scenes: [{ start: 0, label: '新しい午後', note: '一言' }] });

        await runWorker();

        // 1回目（最初の場面と日）は頼むものが無いので飛ばし、2回目（2つ目の場面）だけを呼ぶ
        expect(sent).toHaveLength(1);
        expect(nonPhotoLines(sentPrompt(0)).some((line) => line.includes('長い日のタイトル'))).toBe(false);
        expect(storedTimeline()!.current!.dayTexts['2026-10-05'].title).toBe('長い日のタイトル');
      });

      it('書き直す場面と日でも、利用者が書いた一言とまとめは残す（AI の文だけ新しくする）', async () => {
        const current = oldCurrent();
        current.sceneTexts[photoId('c')] = { ...current.sceneTexts[photoId('c')], note: '自分で書いた一言', noteSource: 'user' };
        current.dayTexts['2026-10-06'] = { ...current.dayTexts['2026-10-06'], summary: '自分で書いたまとめ', summarySource: 'user' };
        cosmosBackend.documents.set(TIMELINE_ID, rebuilding(current));

        await runWorker();

        const written = storedTimeline()!.current!;
        expect(written.sceneTexts[photoId('c')]).toMatchObject({ note: '自分で書いた一言', noteSource: 'user', aiNote: '札幌のラーメン' });
        expect(written.dayTexts['2026-10-06']).toMatchObject({ summary: '自分で書いたまとめ', summarySource: 'user', aiSummary: '運河を歩いて一休み。' });
      });

      it('文を書いている間に利用者が完成版の文を直したら、引き継ぐ文は直した後のものにする（当て直し）', async () => {
        cosmosBackend.documents.set(TIMELINE_ID, rebuilding());
        othersWriteBeforeReplace((doc) => {
          const edited = { ...doc.current!.sceneTexts[photoId('a')], label: '空港で朝ごはん' };
          return { ...doc, current: { ...doc.current!, sceneTexts: { ...doc.current!.sceneTexts, [photoId('a')]: edited } } };
        });

        await runWorker();

        expect(storedTimeline()!.current!.sceneTexts[photoId('a')].label).toBe('空港で朝ごはん');
      });

      it('下書きの区切りに無い場面と日の、利用者が書いた文を残せなかった文に足し（重なりは除く）、AI の文は捨てる', async () => {
        // 前の完成版には b の場面（見出しは利用者、一言は AI）と、今は写真の無い 10/07 の日（タイトルは利用者）があった
        const current = oldCurrent();
        current.sceneStarts = [...current.sceneStarts, photoId('b')];
        current.sceneTexts[photoId('b')] = userScene('空港の売店', '売店', [photoId('b')]);
        current.dayTexts['2026-10-07'] = userDay('帰りの日', '帰る', [photoId('z')]);
        const already = { kind: 'scene' as const, key: photoId('b'), field: 'label' as const, text: '空港の売店' };
        // 前の書き直しで残せなかった、別の文の知らせも残る
        const earlier = { kind: 'day' as const, key: '2026-10-04', field: 'summary' as const, text: '前日の移動' };
        cosmosBackend.documents.set(TIMELINE_ID, { ...rebuilding(current), droppedEdits: [earlier, already] } as any);

        await runWorker();

        expect(storedTimeline()!.droppedEdits).toEqual([earlier, already, { kind: 'day', key: '2026-10-07', field: 'title', text: '帰りの日' }]);
        expect(Object.keys(storedTimeline()!.current!.sceneTexts).sort()).toEqual(STARTS.slice().sort());
        expect(Object.keys(storedTimeline()!.current!.dayTexts).sort()).toEqual(['2026-10-05', '2026-10-06']);
      });

      it('書かせる場面も日も無ければ、AI を呼ばずに完成版に入れ替える', async () => {
        // 前の完成版が今の区切りと同じ（区切りだけ直して書き直した・作り直したが写真が変わらなかった）
        const same = timelineCurrent(OLD_SNAPSHOT_ID, {
          proposedStarts: PROPOSED,
          sceneStarts: STARTS,
          sceneTexts: {
            [photoId('a')]: aiScene('朝ごはん', '一言', [photoId('a'), photoId('b')]),
            [photoId('c')]: aiScene('昼ごはん', '一言', [photoId('c'), photoId('d')]),
            [photoId('e')]: aiScene('運河', '一言', [photoId('e')]),
            [photoId('f')]: aiScene('おやつ', '一言', [photoId('f')])
          },
          dayTexts: {
            '2026-10-05': aiDay('1日目', 'まとめ', [photoId('a'), photoId('c')]),
            '2026-10-06': aiDay('2日目', 'まとめ', [photoId('e'), photoId('f')])
          }
        });
        cosmosBackend.documents.set(TIMELINE_ID, rebuilding(same));

        await runWorker();

        expect(sent).toEqual([]);
        expect(storedTimeline()!.current).toEqual({ ...same, snapshotId: SNAPSHOT_ID, writtenAt: NOW });
        expect(storedTimeline()!.draft).toBeNull();
      });

      it('前の完成版の控えは、入れ替えで使われなくなれば消す（ほかの控えは残す）', async () => {
        cosmosBackend.documents.set(TIMELINE_ID, rebuilding());

        await runWorker();

        expect(cosmosBackend.documents.has(OLD_SNAPSHOT_ID)).toBe(false);
        expect(cosmosBackend.documents.has(SNAPSHOT_ID)).toBe(true);
      });

      it('区切りを直した下書き（recut）は前の完成版と同じ控えを指すので、控えを消さない', async () => {
        const current = { ...oldCurrent(), snapshotId: SNAPSHOT_ID };
        cosmosBackend.documents.set(TIMELINE_ID, writingTimeline({ current, draft: writingDraft({ reason: 'recut' }) }));

        await runWorker();

        expect(cosmosBackend.documents.has(SNAPSHOT_ID)).toBe(true);
        expect(storedTimeline()!.current!.snapshotId).toBe(SNAPSHOT_ID);
      });

      it('前の完成版の控えを消すのに失敗しても、完成版の入れ替えは済ませて例外を投げない（控えは旅行の削除で消える）', async () => {
        cosmosBackend.documents.set(TIMELINE_ID, rebuilding());
        cosmosBackend.forcedErrorById = { [OLD_SNAPSHOT_ID]: Object.assign(new Error('Service unavailable'), { code: 503 }) };

        await expect(runWorker()).resolves.toBeUndefined();

        expect(storedTimeline()!.current!.snapshotId).toBe(SNAPSHOT_ID);
        expect(storedTimeline()!.draft).toBeNull();
      });
    });
  });

  describe('何もしない・後始末だけするメッセージ', () => {
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
