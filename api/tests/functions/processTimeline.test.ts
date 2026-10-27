import { InvocationContext } from '@azure/functions';
import { CosmosClient } from '@azure/cosmos';
import { processTimelineHandler } from '../../src/functions/processTimeline';
import { TimelineDocument, TimelineDraft, TimelineJob, TimelinePhotoSnapshot } from '../../src/types/timeline';
import { FakeCosmosBackend, FakeCosmosDocument, createFakeContainer } from '../fakes/cosmos';
import { forEachCase } from '../helpers/cases';
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

/** プロンプトのうち、写真の行でない行（日の区切り・書いてほしい場面と日など） */
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

    it('作り直しの区切り案を書いても、完成版の控えは消さない（完成版はまだ使っている）', async () => {
      const currentSnapshotId = `timeline-photos-${TRIP_ID}-33333333-3333-4333-8333-333333333333`;
      cosmosBackend.documents.set(currentSnapshotId, timelinePhotosDocument(currentSnapshotId, TRIP_ID, PHOTOS));
      cosmosBackend.documents.set(TIMELINE_ID, proposingTimeline({ current: timelineCurrent(currentSnapshotId), draft: proposingDraft({ reason: 'rebuild' }) }));

      await runWorker();

      expect(cosmosBackend.documents.has(currentSnapshotId)).toBe(true);
      expect(storedTimeline()!.draft!.phase).toBe('reviewing');
    });

    it('作り直しでは、完成版で利用者が直した区切りを当てず、AI の案に各日の最初の写真を足しただけにする（完成版はそのまま）', async () => {
      // 完成版: AI の案 a・c・d に対して、利用者が b を足し、c と d を消した。作り直しは一から作るので、どちらも使わない（06 §8.2 の 4）
      const current = timelineCurrent(`timeline-photos-${TRIP_ID}-old`, {
        proposedStarts: [photoId('a'), photoId('c'), photoId('d')],
        sceneStarts: [photoId('a'), photoId('b')]
      });
      // 日付の切り替えを2時に変えて作り直したので、10/06 02:30 の d は2日目の最初になる
      const draft = proposingDraft({ reason: 'rebuild', dayStartHour: 2 });
      cosmosBackend.documents.set(TIMELINE_ID, proposingTimeline({ current, draft }));
      aiReturns({ sceneStarts: [0, 2, 4] });

      await runWorker();

      expect(storedTimeline()?.draft).toEqual({
        ...draft,
        phase: 'reviewing',
        job: null,
        proposedStarts: [photoId('a'), photoId('c'), photoId('d'), photoId('e')],
        sceneStarts: [photoId('a'), photoId('c'), photoId('d'), photoId('e')]
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

    it('処理の間に下書きをやめた・別の下書きに変わったなら、結果も失敗も書かずに終える', () => forEachCase<[string, (doc: TimelineDocument) => TimelineDocument]>([
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
    ], async (_case, write) => {
      cosmosBackend.documents.set(TIMELINE_ID, proposingTimeline());
      let written: TimelineDocument | undefined;
      othersWriteBeforeReplace((doc) => (written = write(doc)));

      await expect(runWorker()).resolves.toBeUndefined();

      expect(storedTimeline()).toEqual(written);
    }));

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
    it('AI がエラーを返した・接続できなかったら AI の失敗として、下書きを待ちに戻して例外を投げる（キューの再試行に任せる）', () => forEachCase<[string, () => Promise<unknown>]>([
      ['AI がエラーを返した', async () => {
        throw Object.assign(new Error('500 The server had an error while processing your request.'), { name: 'InternalServerError', status: 500 });
      }],
      ['AI の応答に写真の数以上の番号があった', answering({ sceneStarts: [0, 6] })],
      ['AI の応答に負の番号があった', answering({ sceneStarts: [-1] })],
      ['AI の応答に整数でない番号があった', answering({ sceneStarts: [1.5] })],
      ['AI の応答に番号でない値があった', answering({ sceneStarts: ['1'] })],
      ['AI の応答が配列でなかった', answering({ sceneStarts: 1 })]
    ], async (_case, aiReply) => {
      cosmosBackend.documents.set(TIMELINE_ID, proposingTimeline());
      reply = aiReply;

      await expect(runWorker()).rejects.toThrow();

      expect(storedTimeline()).toEqual(
        proposingTimeline({ draft: proposingDraft({ job: pendingJob({ attempts: 1, lastError: 'ai', updatedAt: NOW }) }) })
      );
    }));

    it('区切り案の間に下書きをやめていた・別の下書きに変わっていたら、AI が失敗しても失敗を書かずに終える（例外も投げない）', () => forEachCase<[string, TimelineDraft | null]>([
      ['下書きをやめていた', null],
      // 新しい下書きを別のインスタンスが同じ時刻に担当した（処理は自分の担当と同じ形。下書きの id だけで見分ける）
      [
        '下書きを出し直し、別のインスタンスが担当していた',
        proposingDraft({ id: '44444444-4444-4444-8444-444444444444', job: pendingJob({ state: 'running', attempts: 1, updatedAt: NOW }) })
      ]
    ], async (_case, draft) => {
      cosmosBackend.documents.set(TIMELINE_ID, proposingTimeline());
      let changed: TimelineDocument | undefined;
      reply = async () => {
        changed = { ...storedTimeline()!, draft };
        cosmosBackend.documents.set(TIMELINE_ID, changed as any);
        throw Object.assign(new Error('500 The server had an error while processing your request.'), { name: 'InternalServerError', status: 500 });
      };

      await expect(runWorker()).resolves.toBeUndefined();

      expect(storedTimeline()).toEqual(changed);
    }));

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
        { start: 0, end: 1, label: '朝ごはん', note: '空港の海鮮丼' },
        { start: 2, end: 3, label: '昼ごはん', note: '札幌のラーメン' },
        { start: 4, end: 4, label: '運河', note: '小樽運河' },
        { start: 5, end: 5, label: 'おやつ', note: '小樽で一休み' }
      ]
    };
    /** AI が書いた場面の文（作り直しでも前の文を引き継がないので、書いたときの写真は持たない。06 §8.3） */
    const aiScene = (label: string, note: string) => ({
      label,
      labelSource: 'ai' as const,
      aiLabel: label,
      note,
      noteSource: 'ai' as const,
      aiNote: note
    });
    /** AI が書いた日の文（書いたときの区切りは持たない） */
    const aiDay = (title: string, summary: string) => ({
      title,
      titleSource: 'ai' as const,
      aiTitle: title,
      summary,
      summarySource: 'ai' as const,
      aiSummary: summary
    });

    beforeEach(() => {
      aiReturns(allTexts);
    });

    it('文もタイムライン用のデプロイが設定されていれば、そこへ送る', async () => {
      process.env.AZURE_OPENAI_TIMELINE_DEPLOYMENT_NAME = 'timeline-deployment';
      cosmosBackend.documents.set(TIMELINE_ID, writingTimeline());

      await runWorker();

      expect(sent[0].body.model).toBe('timeline-deployment');
    });

    it('文を書く段は、下書きの日付の切り替えの時刻で日を分け、その時刻を完成版に写す', async () => {
      // 2時にすると、10/06 02:30 の d は2日目の最初になる（4時なら1日目）
      const starts = [photoId('a'), photoId('c'), photoId('d'), photoId('e')];
      cosmosBackend.documents.set(TIMELINE_ID, writingTimeline({ draft: writingDraft({ dayStartHour: 2, proposedStarts: starts, sceneStarts: starts }) }));
      aiReturns({
        days: allTexts.days,
        scenes: [
          { start: 0, end: 1, label: '朝', note: '一言' },
          { start: 2, end: 2, label: '昼', note: '一言' },
          { start: 3, end: 3, label: '夜中', note: '一言' },
          { start: 4, end: 5, label: '運河', note: '一言' }
        ]
      });

      await runWorker();

      expect(promptLineOf(sentPrompt(), 3)).toContain('2日目');
      expect(storedTimeline()!.current!.dayStartHour).toBe(2);
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
              [photoId('a')]: aiScene('朝ごはん', '空港の海鮮丼'),
              [photoId('c')]: aiScene('昼ごはん', '札幌のラーメン'),
              [photoId('e')]: aiScene('運河', '小樽運河'),
              [photoId('f')]: aiScene('おやつ', '小樽で一休み')
            },
            dayTexts: {
              '2026-10-05': aiDay('千歳と札幌', '空港で海鮮丼を食べ、札幌でラーメン。'),
              '2026-10-06': aiDay('小樽', '小樽運河を歩いた。')
            },
            writtenAt: NOW
          },
          draft: null,
          droppedEdits: [],
          updatedAt: NOW
        })
      );
    });

    it('場面の区切りと書いてほしい場面は、最初と最後の写真の番号の範囲で渡す（AI が場面の写真を数え違えないように）', async () => {
      cosmosBackend.documents.set(TIMELINE_ID, writingTimeline());

      await runWorker();

      const otherLines = nonPhotoLines(sentPrompt());
      for (const range of ['0番〜1番', '2番〜3番', '4番〜4番', '5番〜5番']) {
        // 区切りの並びと、書いてほしい場面の並びの少なくとも2か所に出る（指示の例などで増えるのは構わない。日の区切りの行は 0番〜3番・4番〜5番 で、どの場面の範囲とも違う）。
        // 前に数字が続くもの（10番〜11番 の 0番〜1番 など）は数えない
        const pattern = new RegExp(`(?<![0-9])${range}`);
        expect(otherLines.filter((line) => pattern.test(line)).length).toBeGreaterThanOrEqual(2);
      }
    });

    it('AI には画像を渡さず、写真の行と日の区切りに加えて、書いてほしい日を渡す', async () => {
      cosmosBackend.documents.set(TIMELINE_ID, writingTimeline());

      await runWorker();

      expect(sent).toHaveLength(1);
      expect(sent[0].body.messages[0].content.some((part: any) => part.type === 'image_url')).toBe(false);
      const prompt = sentPrompt();
      for (const element of ['1日目', '10/05 07:50 ', '食べ物', '海鮮丼', '北海道千歳市', '空港で']) {
        expect(promptLineOf(prompt, 0)).toContain(element);
      }
      const otherLines = nonPhotoLines(prompt);
      // 書いてほしい場面は、上の範囲のテストが見る
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
                end: expect.objectContaining({ type: 'integer' }),
                label: expect.objectContaining({ type: 'string' }),
                note: expect.objectContaining({ type: 'string' })
              },
              required: ['start', 'end', 'label', 'note'],
              additionalProperties: false
            })
          })
        },
        required: ['days', 'scenes'],
        additionalProperties: false
      });
    });

    // 重なりと頼んでいないものの行は、数を頼んだ数に合わせる（数が違うと、数の検査で先に落ちて、その行の検査に届かない）
    it('AI の応答の日や場面が頼んだものと合わないときは AI の失敗として、下書きを待ちに戻して例外を投げる（完成版は作らない）', () => forEachCase<[string, unknown]>([
      ['頼んだ日が無い', { ...allTexts, days: allTexts.days.slice(1) }],
      ['同じ日が2回ある', { ...allTexts, days: [allTexts.days[0], allTexts.days[0]] }],
      ['頼んでいない場面がある', { ...allTexts, scenes: [{ start: 1, end: 1, label: 'x', note: 'x' }, ...allTexts.scenes.slice(1)] }],
      ['頼んだ場面が無い', { ...allTexts, scenes: allTexts.scenes.slice(1) }],
      // 番号と文の組を取り違えた応答（最初の場面に、次の場面の範囲と文を返した）。最初の写真の番号だけでは見分けられない
      ['場面の最後の写真の番号が、その場面と合わない', { ...allTexts, scenes: [{ ...allTexts.scenes[1], start: 0 }, ...allTexts.scenes.slice(1)] }],
      // 逆向きの取り違え（1枚の場面 5番〜5番 に、前の場面 4番〜4番 の範囲と文を返した）。最後の番号が小さすぎる
      ['場面の最後の写真の番号が、その場面より前で終わっている', { ...allTexts, scenes: [...allTexts.scenes.slice(0, 3), { ...allTexts.scenes[2], start: 5 }] }],
      ['空白だけの見出しがある', { ...allTexts, scenes: [{ ...allTexts.scenes[0], label: '  ' }, ...allTexts.scenes.slice(1)] }],
      ['空のまとめがある', { ...allTexts, days: [{ ...allTexts.days[0], summary: '' }, allTexts.days[1]] }],
      ['日が配列でない', { ...allTexts, days: null }]
    ], async (_label, body) => {
      cosmosBackend.documents.set(TIMELINE_ID, writingTimeline());
      aiReturns(body);

      await expect(runWorker()).rejects.toThrow();

      expect(storedTimeline()).toEqual(
        writingTimeline({ draft: writingDraft({ job: writingJob({ attempts: 1, lastError: 'ai', updatedAt: NOW }) }) })
      );
    }));

    it('AI の文は前後の空白を除き、上限（タイトル 40・まとめ 400・見出し 30・一言 200 文字）を超える分は切り詰める', async () => {
      cosmosBackend.documents.set(TIMELINE_ID, writingTimeline());
      aiReturns({
        days: [{ date: '2026-10-05', title: ` ${'題'.repeat(41)} `, summary: 'ま'.repeat(401) }, allTexts.days[1]],
        scenes: [{ start: 0, end: 1, label: `　${'見'.repeat(31)}`, note: '一'.repeat(201) }, ...allTexts.scenes.slice(1)]
      });

      await runWorker();

      const current = storedTimeline()!.current!;
      expect(current.dayTexts['2026-10-05']).toMatchObject({ title: '題'.repeat(40), aiTitle: '題'.repeat(40), summary: 'ま'.repeat(400) });
      expect(current.sceneTexts[photoId('a')]).toMatchObject({ label: '見'.repeat(30), aiLabel: '見'.repeat(30), note: '一'.repeat(200) });
    });

    it('上限で切り詰めるときは、絵文字などの途中（サロゲートペアの片割れ）で切らない', async () => {
      cosmosBackend.documents.set(TIMELINE_ID, writingTimeline());
      // 29 文字の後に絵文字（UTF-16 で 2 つ分）。30 で切ると絵文字の前半だけが残る
      aiReturns({ ...allTexts, scenes: [{ start: 0, end: 1, label: `${'見'.repeat(29)}🍣`, note: '一言' }, ...allTexts.scenes.slice(1)] });

      await runWorker();

      expect(storedTimeline()!.current!.sceneTexts[photoId('a')].label).toBe('見'.repeat(29));
    });

    it('最初の1文字だけで上限を超える文は、空にせず AI の失敗にする', async () => {
      cosmosBackend.documents.set(TIMELINE_ID, writingTimeline());
      // 結合文字を 31 個重ねた1文字（UTF-16 で 32 個分）。見出しの上限 30 に1文字も収まらない
      const label = `a${String.fromCharCode(0x301).repeat(31)}`;
      aiReturns({ ...allTexts, scenes: [{ start: 0, end: 1, label, note: '一言' }, ...allTexts.scenes.slice(1)] });

      await expect(runWorker()).rejects.toThrow();

      expect(storedTimeline()!.current).toBeNull();
      expect(storedTimeline()!.draft!.job).toEqual(writingJob({ attempts: 1, lastError: 'ai', updatedAt: NOW }));
    });

    it('上限で切り詰めるときは、見た目の1文字の途中で切らず、切った後ろの空白も除く', () => forEachCase<[string, string, string]>([
      // 家族の絵文字は 👨・👩・👧 を結合子でつないだ1文字。途中で切ると 👨 だけが残る
      ['結合した絵文字', `${'見'.repeat(28)}👨‍👩‍👧`, '見'.repeat(28)],
      // 国旗は2つの記号で1文字。途中で切ると片方だけが残る
      ['国旗', `${'見'.repeat(29)}🇯🇵`, '見'.repeat(29)],
      // 切った最後が空白なら、それも除く
      ['空白の後ろ', `${'見'.repeat(29)} ${'見'.repeat(5)}`, '見'.repeat(29)]
    ], async (_label, label, expected) => {
      cosmosBackend.documents.set(TIMELINE_ID, writingTimeline());
      aiReturns({ ...allTexts, scenes: [{ start: 0, end: 1, label, note: '一言' }, ...allTexts.scenes.slice(1)] });

      await runWorker();

      expect(storedTimeline()!.current!.sceneTexts[photoId('a')].label).toBe(expected);
    }));

    describe('写真の多い旅行（一度に渡すのは 400 枚まで）', () => {
      const scene = (start: number, end: number, label: string) => ({ start, end, label, note: `${label}の一言` });
      const day = (date: string, title: string) => ({ date, title, summary: `${title}のまとめ` });
      /** 区切り（AI の案も同じ）の文を書く待ちの下書きを置く */
      const useWritingDraft = (starts: string[]) =>
        cosmosBackend.documents.set(TIMELINE_ID, writingTimeline({ draft: writingDraft({ proposedStarts: starts, sceneStarts: starts }) }));

      it('上限を超える旅行は日の境目で分けて順に呼び、番号は呼び出しごとに 0 から振って、その呼び出しの場面と日だけを書かせる', async () => {
        const day1 = photosOfDay('2026-10-05', 1, 250);
        const day2 = photosOfDay('2026-10-06', 2, 200);
        useSnapshot([...day1, ...day2]);
        const starts = [day1[0].id, day1[100].id, day2[0].id, day2[50].id];
        useWritingDraft(starts);
        replies(
          { days: [day('2026-10-05', '1日目')], scenes: [scene(0, 99, '朝'), scene(100, 249, '昼')] },
          { days: [day('2026-10-06', '2日目')], scenes: [scene(0, 49, '朝2'), scene(50, 199, '昼2')] }
        );

        await runWorker();

        expect(sent).toHaveLength(2);
        expect(promptLineOf(sentPrompt(0), 249)).toBeDefined();
        expect(promptLineOf(sentPrompt(0), 250)).toBeUndefined();
        expect(promptLineOf(sentPrompt(1), 199)).toContain('2日目');
        // 日付（YYYY-MM-DD）は、頼む日にしか出ない
        expect(nonPhotoLines(sentPrompt(0)).some((line) => line.includes('2026-10-06'))).toBe(false);
        expect(nonPhotoLines(sentPrompt(1)).some((line) => line.includes('2026-10-05'))).toBe(false);
        const current = storedTimeline()!.current!;
        expect(Object.fromEntries(starts.map((id) => [id, current.sceneTexts[id].label]))).toEqual({
          [day1[0].id]: '朝',
          [day1[100].id]: '昼',
          [day2[0].id]: '朝2',
          [day2[50].id]: '昼2'
        });
        expect(current.dayTexts['2026-10-06'].title).toBe('2日目');
      });

      it('ちょうど上限の枚数なら、日をまたいでも1回で呼ぶ', async () => {
        const day1 = photosOfDay('2026-10-05', 1, 250);
        const day2 = photosOfDay('2026-10-06', 2, 150);
        useSnapshot([...day1, ...day2]);
        useWritingDraft([day1[0].id, day2[0].id]);
        aiReturns({ days: [day('2026-10-05', '1日目'), day('2026-10-06', '2日目')], scenes: [scene(0, 249, '朝'), scene(250, 399, '朝2')] });

        await runWorker();

        expect(sent).toHaveLength(1);
      });

      it('1日で上限を超える日は場面の境目で分けて呼び、日の文はその日の最初の場面を含む呼び出しで書かせる', async () => {
        const day1 = photosOfDay('2026-10-05', 1, 450);
        useSnapshot(day1);
        // 区切り案で 400 枚目は切れ目になっているが、利用者が消して 300 枚目に区切りを入れた
        useWritingDraft([day1[0].id, day1[300].id]);
        replies({ days: [day('2026-10-05', '長い1日')], scenes: [scene(0, 299, '午前')] }, { days: [], scenes: [scene(0, 149, '午後')] });

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
        replies({ days: [day('2026-10-05', '1日目')], scenes: [scene(0, 249, '朝')] }, { days: [day('2026-10-06', '2日目')], scenes: [] });

        await expect(runWorker()).rejects.toThrow();

        expect(storedTimeline()!.current).toBeNull();
        expect(storedTimeline()!.draft!.job).toEqual(writingJob({ attempts: 1, lastError: 'ai', updatedAt: NOW }));
      });
    });

    describe('作り直し（完成版があるとき）', () => {
      const OLD_SNAPSHOT_ID = `timeline-photos-${TRIP_ID}-33333333-3333-4333-8333-333333333333`;

      /**
       * 前の完成版。区切りは a・c・e で、利用者が見出し・一言・タイトル・まとめを直している。
       * 作り直しは一から作るので、この文も区切りも新しい完成版に残らない（06 §8.3）
       */
      const oldCurrent = () =>
        timelineCurrent(OLD_SNAPSHOT_ID, {
          proposedStarts: [photoId('a'), photoId('b'), photoId('e')],
          sceneStarts: [photoId('a'), photoId('c'), photoId('e')],
          sceneTexts: {
            [photoId('a')]: { ...aiScene('朝ごはん', '朝ごはんの一言'), label: '空港の朝', labelSource: 'user' },
            [photoId('c')]: { ...aiScene('昼ごはん', '昼ごはんの一言'), note: '自分で書いた一言', noteSource: 'user' },
            [photoId('e')]: aiScene('小樽', '運河と店')
          },
          dayTexts: {
            '2026-10-05': { ...aiDay('千歳と札幌', '千歳と札幌のまとめ'), title: '北海道1日目', titleSource: 'user' },
            '2026-10-06': { ...aiDay('小樽', '小樽のまとめ'), summary: '自分で書いたまとめ', summarySource: 'user' }
          },
          writtenAt: '2026-10-08T12:14:00.000Z'
        });
      const rebuilding = (current = oldCurrent()) =>
        writingTimeline({ current, draft: writingDraft({ reason: 'rebuild' }) });

      beforeEach(() => {
        cosmosBackend.documents.set(OLD_SNAPSHOT_ID, timelinePhotosDocument(OLD_SNAPSHOT_ID, TRIP_ID, PHOTOS));
      });

      it('前の完成版の文（利用者が書いたものも）を使わず、全部の場面と日を AI が書いた新しい完成版に入れ替える', async () => {
        cosmosBackend.documents.set(TIMELINE_ID, rebuilding());

        await runWorker();

        expect(storedTimeline()!.current).toEqual({
          snapshotId: SNAPSHOT_ID,
          dayStartHour: 4,
          proposedStarts: PROPOSED,
          sceneStarts: STARTS,
          sceneTexts: {
            [photoId('a')]: aiScene('朝ごはん', '空港の海鮮丼'),
            [photoId('c')]: aiScene('昼ごはん', '札幌のラーメン'),
            [photoId('e')]: aiScene('運河', '小樽運河'),
            [photoId('f')]: aiScene('おやつ', '小樽で一休み')
          },
          dayTexts: {
            '2026-10-05': aiDay('千歳と札幌', '空港で海鮮丼を食べ、札幌でラーメン。'),
            '2026-10-06': aiDay('小樽', '小樽運河を歩いた。')
          },
          writtenAt: NOW
        });
        expect(storedTimeline()!.draft).toBeNull();
      });

      it('AI には全部の場面と日を頼み、前の完成版の文は渡さない', async () => {
        cosmosBackend.documents.set(TIMELINE_ID, rebuilding());

        await runWorker();

        // 何を頼むかは、全部の場面と日を返す応答（allTexts）で成功する上のテストが固定している（頼む数が違えば検証で失敗する）。
        // 前の文は、写真の行に添える形でも渡さない（どの文も写真の名前・地名・コメントには無いので、プロンプト全体で探す）
        const prompt = sentPrompt();
        for (const text of ['空港の朝', '朝ごはんの一言', '自分で書いた一言', '北海道1日目', '自分で書いたまとめ', '運河と店']) {
          expect(prompt.includes(text)).toBe(false);
        }
      });

      it('写真も区切りも前の完成版と同じ作り直しでも、AI に全部を書かせ、前の文は残さない（函館の旅行で、AI が呼ばれずずれた文が残った）', async () => {
        const same = timelineCurrent(OLD_SNAPSHOT_ID, {
          proposedStarts: PROPOSED,
          sceneStarts: STARTS,
          sceneTexts: {
            [photoId('a')]: aiScene('前の朝', '前の一言'),
            [photoId('c')]: aiScene('前の昼', '前の一言'),
            [photoId('e')]: aiScene('前の運河', '前の一言'),
            [photoId('f')]: aiScene('前のおやつ', '前の一言')
          },
          dayTexts: { '2026-10-05': aiDay('前の1日目', '前のまとめ'), '2026-10-06': aiDay('前の2日目', '前のまとめ') }
        });
        cosmosBackend.documents.set(TIMELINE_ID, rebuilding(same));

        await runWorker();

        expect(sent).toHaveLength(1);
        expect(storedTimeline()!.current!.sceneTexts[photoId('a')]).toEqual(aiScene('朝ごはん', '空港の海鮮丼'));
        expect(storedTimeline()!.current!.dayTexts['2026-10-05']).toEqual(aiDay('千歳と札幌', '空港で海鮮丼を食べ、札幌でラーメン。'));
      });

      it('前の完成版で利用者が書いた文は、残せなかった文の知らせにも足さない（今ある知らせはそのまま）', async () => {
        const earlier = { kind: 'day' as const, key: '2026-10-04', field: 'summary' as const, text: '前日の移動' };
        cosmosBackend.documents.set(TIMELINE_ID, { ...rebuilding(), droppedEdits: [earlier] } as any);

        await runWorker();

        expect(storedTimeline()!.droppedEdits).toEqual([earlier]);
      });

      it('文を書いている間に利用者が前の完成版の文を直したり知らせを閉じたりしても、読み直した文書に新しい完成版を当てる（直した文は残らず、閉じた知らせは閉じたまま）', async () => {
        const earlier = { kind: 'day' as const, key: '2026-10-04', field: 'summary' as const, text: '前日の移動' };
        cosmosBackend.documents.set(TIMELINE_ID, { ...rebuilding(), droppedEdits: [earlier] } as any);
        othersWriteBeforeReplace((doc) => {
          const edited = { ...doc.current!.sceneTexts[photoId('e')], label: '小樽で散歩', labelSource: 'user' as const };
          return { ...doc, current: { ...doc.current!, sceneTexts: { ...doc.current!.sceneTexts, [photoId('e')]: edited } }, droppedEdits: [] };
        });

        await runWorker();

        expect(storedTimeline()!.current!.sceneTexts[photoId('e')]).toEqual(aiScene('運河', '小樽運河'));
        expect(storedTimeline()!.droppedEdits).toEqual([]);
        expect(storedTimeline()!.draft).toBeNull();
      });

      it('作り直しでも、完成版の日付の切り替えの時刻は下書きのものにする（前の完成版は 4 時）', async () => {
        cosmosBackend.documents.set(TIMELINE_ID, writingTimeline({ current: oldCurrent(), draft: writingDraft({ reason: 'rebuild', dayStartHour: 5 }) }));

        await runWorker();

        expect(storedTimeline()!.current!.dayStartHour).toBe(5);
      });

      it('前の完成版の控えは、入れ替えで使われなくなれば消す（ほかの控えは残す）', async () => {
        cosmosBackend.documents.set(TIMELINE_ID, rebuilding());

        await runWorker();

        expect(cosmosBackend.documents.has(OLD_SNAPSHOT_ID)).toBe(false);
        expect(cosmosBackend.documents.has(SNAPSHOT_ID)).toBe(true);
      });

      it('区切りを直した下書き（recut。AI なしにする前に文を書く段へ積まれたもの）は、AI を呼ばずに直した区切りを当て、利用者の文を残し、控えを消さない', async () => {
        // 当て方は POST …/draft/write の recut と同じ（06 §8.6）。残った場面の文と日の文・作成日時はそのまま、足した f の場面は空
        const current = { ...oldCurrent(), snapshotId: SNAPSHOT_ID };
        cosmosBackend.documents.set(TIMELINE_ID, writingTimeline({ current, draft: writingDraft({ reason: 'recut' }) }));

        await runWorker();

        expect(sent).toEqual([]);
        expect(storedTimeline()!.current).toEqual({
          ...current,
          sceneStarts: STARTS,
          sceneTexts: {
            [photoId('a')]: current.sceneTexts[photoId('a')],
            [photoId('c')]: current.sceneTexts[photoId('c')],
            [photoId('e')]: current.sceneTexts[photoId('e')],
            [photoId('f')]: { label: null, labelSource: null, aiLabel: null, note: null, noteSource: null, aiNote: null }
          }
        });
        expect(storedTimeline()!.draft).toBeNull();
        expect(cosmosBackend.documents.has(SNAPSHOT_ID)).toBe(true);
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
    it('旅行や下書きの id が無いメッセージは、何もせずに終える', () => forEachCase<[string, unknown]>([
      ['旅行の id が無い', { draftId: DRAFT_ID }],
      ['下書きの id が無い', { tripId: TRIP_ID }],
      ['旅行の id が UUID の形でない', { tripId: 'trip/1', draftId: DRAFT_ID }],
      ['下書きの id が UUID の形でない', { tripId: TRIP_ID, draftId: '' }],
      ['本文が読めない', null]
    ], async (_case, message) => {
      const timeline = proposingTimeline();
      cosmosBackend.documents.set(TIMELINE_ID, timeline);

      await expect(runWorker(message)).resolves.toBeUndefined();

      expect(storedTimeline()).toEqual(timeline);
      expect(sent).toEqual([]);
    }));

    it('下書きが無い・別の下書きに変わったなら、何もせずに終える', () => forEachCase<[string, TimelineDraft | null]>([
      ['下書きが無い（やめた）', null],
      ['別の下書き（出し直した）', proposingDraft({ id: '44444444-4444-4444-8444-444444444444' })],
      ['処理中（別のインスタンスが担当した）', proposingDraft({ job: pendingJob({ state: 'running', attempts: 1 }) })],
      ['失敗した', proposingDraft({ job: pendingJob({ state: 'failed', attempts: 3 }) })],
      ['確かめ中（区切り案は済んだ）', proposingDraft({ phase: 'reviewing', job: null })]
    ], async (_case, draft) => {
      const timeline = proposingTimeline({ draft });
      cosmosBackend.documents.set(TIMELINE_ID, timeline);

      await expect(runWorker()).resolves.toBeUndefined();

      expect(storedTimeline()).toEqual(timeline);
      expect(sent).toEqual([]);
    }));

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
