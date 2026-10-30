import { InvocationContext } from '@azure/functions';
import { CosmosClient } from '@azure/cosmos';
import { QueueClient } from '@azure/storage-queue';
import { BlobServiceClient } from '@azure/storage-blob';
import { processPhotoHandler } from '../../src/functions/processPhoto';
import { PhotoDocument } from '../../src/types/album';
import { FakeCosmosBackend, FakeCosmosDocument, createFakeContainer } from '../fakes/cosmos';
import { FakeBlobBackend, TEST_BLOB_HOST, createFakeBlobServiceClient } from '../fakes/blob';
import { FakeQueueBackend, createFakeQueueClient, decodeQueueMessage } from '../fakes/queue';
import { forEachCase } from '../helpers/cases';
import { photoDocument } from '../helpers/albumDocuments';
import { CATALOG_KINDS } from '../../src/catalog/kinds';

// 外部依存のみモック。Cosmos DB と Blob Storage は状態持ちの偽物、AI（管理外）は送った要求を残すモック。
// SAS の署名は実 SDK のまま（ローカルの計算だけで、Blob Storage へは通信しない）
jest.mock('@azure/cosmos');
jest.mock('@azure/storage-blob', () => ({
  ...jest.requireActual('@azure/storage-blob'),
  BlobServiceClient: { fromConnectionString: jest.fn() }
}));
jest.mock('@azure/storage-queue', () => ({ QueueClient: jest.fn() }));
jest.mock('openai', () => {
  const MockOpenAI = jest.fn();
  return Object.assign(MockOpenAI, { default: MockOpenAI });
});
const MockedOpenAI = jest.requireMock('openai');
const MockedCosmosClient = CosmosClient as jest.MockedClass<typeof CosmosClient>;
const MockedBlobServiceClient = BlobServiceClient as jest.MockedClass<typeof BlobServiceClient>;
const MockedQueueClient = QueueClient as jest.MockedClass<typeof QueueClient>;

const PHOTO_ID = '45ae705277879f7f01d778f7c95a065bb0c06ab9936cf24307f375211fee13d1';
const TRIP_ID = '123e4567-e89b-42d3-a456-426614174000';
const NOW = '2026-10-18T03:00:00.000Z';

const ENV_KEYS = [
  'COSMOS_DB_ENDPOINT',
  'COSMOS_DB_KEY',
  'COSMOS_DB_DATABASE',
  'COSMOS_DB_ALBUM_CONTAINER',
  'STORAGE_CONNECTION_STRING',
  'PHOTO_STORAGE_CONTAINER_NAME',
  'AZURE_OPENAI_ENDPOINT',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_DEPLOYMENT_NAME',
  'AZURE_OPENAI_CLASSIFY_DEPLOYMENT_NAME',
  'AZURE_OPENAI_API_VERSION',
  'OPENAI_API_KEY',
  'PHOTO_PROCESSING_MAX_ATTEMPTS',
  'PHOTO_QUEUE_NAME',
  'AzureWebJobsStorage'
] as const;

/** 分類の待ちの写真（送信が作った直後の形）。利用者が付けたタグ・コメント・旅行を持たせ、変わらないことを見る */
const pendingPhoto = (overrides: Partial<PhotoDocument> = {}): PhotoDocument =>
  photoDocument(PHOTO_ID, {
    tripId: TRIP_ID,
    tags: ['朝食'],
    comment: 'ホテルの朝食',
    commentSource: 'user',
    processing: { state: 'pending', step: 'classify', attempts: 0, lastError: null, updatedAt: '2026-10-18T02:59:00.000Z' },
    updatedAt: '2026-10-18T02:59:00.000Z',
    ...overrides
  });

describe('写真の解析のワーカー', () => {
  let mockContext: InvocationContext;
  let cosmosBackend: FakeCosmosBackend<FakeCosmosDocument>;
  let blobBackend: FakeBlobBackend;
  let queueBackend: FakeQueueBackend;
  let savedEnv: Record<string, string | undefined>;
  // AI に送った要求。どの接続先（クライアントの設定）から送ったかと一緒に残す
  let sent: Array<{ options: any; body: any }>;
  let reply: () => Promise<unknown>;

  const aiReturns = (body: unknown) => {
    reply = async () => ({ choices: [{ message: { content: JSON.stringify(body) } }] });
  };

  /** キューのトリガーが渡すメッセージ（本文の JSON は読まれた後のオブジェクトで届く） */
  const runWorker = (message: unknown = { photoId: PHOTO_ID }) => processPhotoHandler(message, mockContext);

  const storedPhoto = () => cosmosBackend.documents.get(PHOTO_ID) as PhotoDocument;

  /** キューの名前ごとの、積まれたメッセージ（読み戻した本文） */
  const queuedMessages = (): Array<[string, unknown[]]> =>
    [...queueBackend.queues].map(([name, messages]) => [name, messages.map(decodeQueueMessage)]);

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

    blobBackend = { store: new Map() };
    MockedBlobServiceClient.fromConnectionString = jest.fn().mockReturnValue(createFakeBlobServiceClient(blobBackend));

    queueBackend = { queues: new Map(), forcedSendError: null };
    MockedQueueClient.mockImplementation(((_connectionString: string, queueName: string) =>
      createFakeQueueClient(queueBackend, queueName)) as any);

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
    aiReturns({ kind: 'food', confidence: 82.5, reason: 'ラーメンが写っている' });

    process.env.COSMOS_DB_ENDPOINT = 'https://test.documents.azure.com:443/';
    process.env.COSMOS_DB_KEY = 'test-key';
    process.env.COSMOS_DB_DATABASE = 'test-db';
    process.env.COSMOS_DB_ALBUM_CONTAINER = 'test-album';
    process.env.STORAGE_CONNECTION_STRING =
      'DefaultEndpointsProtocol=https;AccountName=test;AccountKey=dGVzdGtleQ==;EndpointSuffix=core.windows.net';
    process.env.PHOTO_STORAGE_CONTAINER_NAME = 'photos';
    process.env.AZURE_OPENAI_ENDPOINT = 'https://test.openai.azure.com';
    process.env.AZURE_OPENAI_API_KEY = 'azure-api-key';
    process.env.AZURE_OPENAI_DEPLOYMENT_NAME = 'main-deployment';
    delete process.env.AZURE_OPENAI_CLASSIFY_DEPLOYMENT_NAME;
    delete process.env.AZURE_OPENAI_API_VERSION;
    delete process.env.OPENAI_API_KEY;
    delete process.env.PHOTO_PROCESSING_MAX_ATTEMPTS;
    process.env.PHOTO_QUEUE_NAME = 'photo-processing';
    process.env.AzureWebJobsStorage = 'UseDevelopmentStorage=true';
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

  describe('分類', () => {
    it('分類の待ちの写真を分類すると、種類と分類の結果が書かれて済みになり、利用者の書いた欄は変わらない', async () => {
      // 図鑑の種類でない（other）ので、分類で済みになる（図鑑の種類なら識別の待ちになる。下のテスト）。
      // 前に1回失敗している（attempts 1・lastError あり）。成功で lastError が消え、attempts は数え続ける。
      // 前回の解析の識別が残っている（やり直し）。分類で種類が変わりうるので、識別は消す（06 §2.3）
      cosmosBackend.documents.set(
        PHOTO_ID,
        pendingPhoto({
          identification: { kind: 'plant', name: 'ソメイヨシノ' },
          processing: { state: 'pending', step: 'classify', attempts: 1, lastError: 'ai', updatedAt: '2026-10-18T02:59:00.000Z' }
        })
      );
      aiReturns({ kind: 'other', confidence: 82.5, reason: '人が写っている' });

      await runWorker();

      expect(storedPhoto()).toEqual({
        ...pendingPhoto(),
        category: 'other',
        classification: { kind: 'other', confidence: 82.5, model: 'main-deployment', at: NOW },
        identification: null,
        processing: { state: 'done', step: 'classify', attempts: 2, lastError: null, updatedAt: NOW },
        updatedAt: NOW
      });
      expect(queuedMessages()).toEqual([]);
    });

    it('分類している間、写真は処理中（classifying）で、回数と時刻が更新されている', async () => {
      // 処理中は画面に「分類中...」と出る。重複配信で同じ写真が2回分類されないのも、この状態による（04 §7.4）
      cosmosBackend.documents.set(PHOTO_ID, pendingPhoto());
      let duringAi: unknown;
      reply = async () => {
        duringAi = storedPhoto().processing;
        return { choices: [{ message: { content: JSON.stringify({ kind: 'food', confidence: 82.5, reason: 'テスト' }) } }] };
      };

      await runWorker();

      expect(duringAi).toEqual({ state: 'classifying', step: 'classify', attempts: 1, lastError: null, updatedAt: NOW });
    });

    it.each(['plant'])(
      '種類が自動で詳しく識別する種類（%s）なら、識別の待ち（回数は0から）にして、その写真を解析のキューに積む',
      async (kind) => {
        // 識別は別の回のワーカーが担当する（06 §2.3）。分類の失敗の回数は識別に持ち越さない。自動で識別するのは植物だけ（02 #51）
        cosmosBackend.documents.set(
          PHOTO_ID,
          pendingPhoto({
            processing: { state: 'pending', step: 'classify', attempts: 1, lastError: 'ai', updatedAt: '2026-10-18T02:59:00.000Z' }
          })
        );
        aiReturns({ kind, confidence: 70, reason: 'テスト' });

        await runWorker();

        expect(storedPhoto().category).toBe(kind);
        expect(storedPhoto().classification).toEqual({ kind, confidence: 70, model: 'main-deployment', at: NOW });
        expect(storedPhoto().processing).toEqual({ state: 'pending', step: 'identify', attempts: 0, lastError: null, updatedAt: NOW });
        expect(queuedMessages()).toEqual([['photo-processing', [{ photoId: PHOTO_ID }]]]);
      }
    );

    it.each(['food', 'landscape'])(
      '種類が図鑑の種類でも自動で識別しない種類（%s）なら、分類で済みにし、キューに積まない',
      async (kind) => {
        // 食べ物・風景の詳しい識別は、利用者がやり直しで頼んだときだけ（02 #51。05 §5.7 の step: "identify"）
        cosmosBackend.documents.set(PHOTO_ID, pendingPhoto());
        aiReturns({ kind, confidence: 70, reason: 'テスト', comment: 'テスト' });

        await runWorker();

        expect(storedPhoto().category).toBe(kind);
        expect(storedPhoto().classification).toEqual({ kind, confidence: 70, model: 'main-deployment', at: NOW });
        expect(storedPhoto().processing).toEqual({ state: 'done', step: 'classify', attempts: 1, lastError: null, updatedAt: NOW });
        expect(queuedMessages()).toEqual([]);
      }
    );

    it('分類のAIが返した一言（前後の空白を除いたもの）を、AIのコメントとして写真に書く', async () => {
      // 詳しい識別をしない写真にもコメントが付くように、分類が一言を書く（02 #51。植物は後の識別のコメントで書き直す）
      cosmosBackend.documents.set(PHOTO_ID, pendingPhoto({ comment: null, commentSource: null }));
      aiReturns({ kind: 'food', confidence: 82.5, reason: 'ラーメンが写っている', comment: ' 湯気の立つ味噌ラーメン。 ' });

      await runWorker();

      expect(storedPhoto().comment).toBe('湯気の立つ味噌ラーメン。');
      expect(storedPhoto().commentSource).toBe('ai');
    });

    it('識別の待ちを積むのに失敗しても、分類の結果と識別の待ちは書いたまま、例外を投げない（タイマーが積み直す）', async () => {
      // 例外にするとキューが分類をやり直すが、写真はもう分類の待ちではないので担当されず、AI の費用もかからない。
      // 識別の待ちのまま残れば、再投入のタイマーが 10 分後に積む（04 §7.1）
      cosmosBackend.documents.set(PHOTO_ID, pendingPhoto());
      queueBackend.forcedSendError = Object.assign(new Error('The specified queue does not exist.'), {
        name: 'RestError',
        statusCode: 404,
        code: 'QueueNotFound'
      });

      await expect(runWorker()).resolves.toBeUndefined();

      expect(storedPhoto().category).toBe('food');
      expect(storedPhoto().processing).toEqual({ state: 'pending', step: 'identify', attempts: 0, lastError: null, updatedAt: NOW });
      expect(queuedMessages()).toEqual([]);
    });

    it('AIに送る画像は、その写真の原寸を読み取りだけで開ける、15分で切れる署名付きのURL', async () => {
      // サムネイルではなく原寸（detail: low でも、縮める前の画像の方が分類しやすい）。06 §2.1
      cosmosBackend.documents.set(PHOTO_ID, pendingPhoto({ blobName: `${PHOTO_ID}.png`, contentType: 'image/png' }));

      await runWorker();

      expect(sent).toHaveLength(1);
      const image = sent[0].body.messages[0].content.find((part: any) => part.type === 'image_url').image_url;
      expect(image.detail).toBe('low');
      const url = new URL(image.url);
      expect(`${url.origin}${url.pathname}`).toBe(`https://${TEST_BLOB_HOST}/photos/${PHOTO_ID}.png`);
      expect(url.searchParams.get('sp')).toBe('r');
      expect(url.searchParams.get('sr')).toBe('b');
      expect(url.searchParams.get('se')).toBe('2026-10-18T03:15:00Z');
    });

    it('やり直しの手がかり（hint）があれば、AIに渡す', async () => {
      // やり直しの受付（POST /api/photos/{photoId}/process）が写真に書いたもの。メッセージには載せず、写真から読む
      cosmosBackend.documents.set(PHOTO_ID, pendingPhoto({ hint: '屋台のラーメン' }));

      await runWorker();

      const text = sent[0].body.messages[0].content.find((part: any) => part.type === 'text').text;
      expect(text).toContain('屋台のラーメン');
    });

    it('撮影地があれば、手がかりとしてAIに渡す', async () => {
      cosmosBackend.documents.set(
        PHOTO_ID,
        pendingPhoto({ location: { latitude: 43.06, longitude: 141.35, placeName: '北海道札幌市中央区', placeSource: 'device' } })
      );

      await runWorker();

      const text = sent[0].body.messages[0].content.find((part: any) => part.type === 'text').text;
      expect(text).toContain('北海道札幌市中央区');
    });

    it('撮影地が無ければ、無い値（null）を撮影地としてAIに渡さない', () => forEachCase([
      ['位置情報が無い', null],
      ['位置はあるが地名が無い', { latitude: 43.06, longitude: 141.35, placeName: null, placeSource: 'device' as const }]
    ], async (_label, location) => {
      // forEachCase は行の間で sent を空にしない。この行で送った要求だけを見る（前の行の要求を見て通らないように）
      sent = [];
      cosmosBackend.documents.set(PHOTO_ID, pendingPhoto({ location }));

      await runWorker();

      // 文言は契約外なので、無い値（null）が文字として紛れ込んでいないことだけを見る
      const text = sent[0].body.messages[0].content.find((part: any) => part.type === 'text').text;
      expect(text).not.toContain('null');
    }));

    it('AIに送る要求は、テキストと画像の2パートと、定義表の種類とotherから1つ選ばせるstrictな応答の形（06 §2.1・§2.2）', async () => {
      cosmosBackend.documents.set(PHOTO_ID, pendingPhoto());

      await runWorker();

      expect(sent).toHaveLength(1);
      const body = sent[0].body;

      // メッセージ: user ロールの1件。テキストと画像の2パート（画像の URL の中身は「AIに送る画像は…」の行で見る）
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0].role).toBe('user');
      expect(body.messages[0].content).toHaveLength(2);
      expect(body.messages[0].content).toEqual(expect.arrayContaining([
        { type: 'text', text: expect.any(String) },
        { type: 'image_url', image_url: { url: expect.any(String), detail: 'low' } }
      ]));

      // 応答の形: Structured Outputs（json_schema・strict）。選択肢は定義表の種類と other。description の文言は契約外
      expect(body.response_format.type).toBe('json_schema');
      expect(body.response_format.json_schema.strict).toBe(true);
      const schema = body.response_format.json_schema.schema;
      expect(schema.properties.kind.enum).toEqual(['plant', 'food', 'landscape', 'other']);
      expect([...schema.required].sort()).toEqual(['comment', 'confidence', 'kind', 'reason']);
      expect(Object.keys(schema.properties).sort()).toEqual([...schema.required].sort());
      expect(schema.additionalProperties).toBe(false);
      expect(schema.properties.kind.type).toBe('string');
      expect(schema.properties.confidence.type).toBe('number');
      expect(schema.properties.reason.type).toBe('string');
      expect(schema.properties.comment.type).toBe('string');

      // トークン上限は max_completion_tokens（max_tokens は新しいモデルでは 400）。temperature は送らない
      expect(body.max_completion_tokens).toBe(4000);
      expect(body).not.toHaveProperty('max_tokens');
      expect(body).not.toHaveProperty('temperature');
    });

    it.each([0, 100])('信頼度が%sでも受け付けて、分類の結果に書く', async (confidence) => {
      // 0〜100 の両端は範囲内（06 §2.1）
      cosmosBackend.documents.set(PHOTO_ID, pendingPhoto());
      aiReturns({ kind: 'other', confidence, reason: 'テスト' });

      await runWorker();

      expect(storedPhoto().classification).toEqual({ kind: 'other', confidence, model: 'main-deployment', at: NOW });
      expect(storedPhoto().processing.state).toBe('done');
    });
  });

  describe('識別', () => {
    /** 植物の識別の応答。名前とコメントの前後の空白は、書くときに除く */
    const plantAnswer = {
      matchesKind: true,
      name: ' ソメイヨシノ ',
      confidence: 92,
      description: '日本で最も広く植えられているサクラの栽培品種',
      characteristics: '淡い桃色の花を葉より先に咲かせる',
      comment: ' 満開のソメイヨシノ。エドヒガンの可能性もある ',
      attributes: { scientificName: 'Prunus × yedoensis', familyName: 'バラ科' }
    };

    /** 識別の待ちの写真（分類が植物と決めた直後の形）。利用者のコメントはまだ無い */
    const waitingPhoto = (overrides: Partial<PhotoDocument> = {}): PhotoDocument =>
      pendingPhoto({
        category: 'plant',
        classification: { kind: 'plant', confidence: 88, model: 'main-deployment', at: '2026-10-18T02:58:00.000Z' },
        comment: null,
        commentSource: null,
        processing: { state: 'pending', step: 'identify', attempts: 0, lastError: null, updatedAt: '2026-10-18T02:59:00.000Z' },
        ...overrides
      });

    const promptText = () => sent[0].body.messages[0].content.find((part: any) => part.type === 'text').text;

    beforeEach(() => aiReturns(plantAnswer));

    it('識別の待ちの写真を識別すると、識別の結果とAIのコメントが書かれて済みになり、利用者の書いた欄は変わらない', async () => {
      // 図鑑はこの identification からまとめる（04 §3.1）。名前とコメントは前後の空白を除いて書く
      cosmosBackend.documents.set(PHOTO_ID, waitingPhoto());

      await runWorker();

      expect(storedPhoto()).toEqual({
        ...waitingPhoto(),
        identification: {
          kind: 'plant',
          matchesKind: true,
          name: 'ソメイヨシノ',
          confidence: 92,
          description: '日本で最も広く植えられているサクラの栽培品種',
          characteristics: '淡い桃色の花を葉より先に咲かせる',
          attributes: { scientificName: 'Prunus × yedoensis', familyName: 'バラ科' },
          reason: null,
          model: 'main-deployment',
          at: NOW
        },
        comment: '満開のソメイヨシノ。エドヒガンの可能性もある',
        commentSource: 'ai',
        processing: { state: 'done', step: 'identify', attempts: 1, lastError: null, updatedAt: NOW },
        updatedAt: NOW
      });
      expect(queuedMessages()).toEqual([]);
    });

    it('識別している間、写真は処理中（identifying）で、回数と時刻が更新されている', async () => {
      // 処理中は画面に「識別中...」と出る（03 §5.1）
      cosmosBackend.documents.set(PHOTO_ID, waitingPhoto());
      let duringAi: unknown;
      reply = async () => {
        duringAi = storedPhoto().processing;
        return { choices: [{ message: { content: JSON.stringify(plantAnswer) } }] };
      };

      await runWorker();

      expect(duringAi).toEqual({ state: 'identifying', step: 'identify', attempts: 1, lastError: null, updatedAt: NOW });
    });

    it('分類どおりの種類が写っていなければ（matchesKind: false）、名前が無くても受け付けて、図鑑に出ない形の結果を書いて済みにし、コメントは変えない', async () => {
      // 名前以下は持たず、AI のコメントを理由として残す（06 §3.2）。画面は「分類と合わない」と出す。
      // 写っているのに名前が無い応答は拒む（下の「応答の検証に通らなければ」の表）
      cosmosBackend.documents.set(PHOTO_ID, waitingPhoto());
      // 写っていないのに説明や項目を返してきても、図鑑に出ない形なので持たない
      aiReturns({
        matchesKind: false,
        name: null,
        confidence: 30,
        description: '布の柄',
        characteristics: '花の模様',
        comment: '植物ではなく、植物の柄の布が写っている',
        attributes: { scientificName: 'Prunus', familyName: 'バラ科' }
      });

      await runWorker();

      expect(storedPhoto()).toEqual({
        ...waitingPhoto(),
        identification: {
          kind: 'plant',
          matchesKind: false,
          name: null,
          confidence: 30,
          description: null,
          characteristics: null,
          attributes: {},
          reason: '植物ではなく、植物の柄の布が写っている',
          model: 'main-deployment',
          at: NOW
        },
        processing: { state: 'done', step: 'identify', attempts: 1, lastError: null, updatedAt: NOW },
        updatedAt: NOW
      });
    });

    it('利用者がコメントを書いていたら、識別の間（担当の後）に書いたものでも、識別の結果は書くが、AIのコメントで上書きしない', async () => {
      // 自動の解析は利用者の文を消さない（06 §3.2）。書くときの条件（Cosmos が原子的に評価する）で守るので、
      // 送信の後・識別の前に書いたコメントも、この読んだ後に書いたコメントと同じ条件で残る
      cosmosBackend.documents.set(PHOTO_ID, waitingPhoto());
      // 1回目の patch は担当。2回目（コメントの書き込み）の直前に、利用者の PATCH が入る
      cosmosBackend.beforePatch = () => {
        cosmosBackend.beforePatch = () => {
          cosmosBackend.beforePatch = undefined;
          const edited: PhotoDocument = { ...storedPhoto(), comment: '公園の入口の木', commentSource: 'user' };
          cosmosBackend.documents.set(PHOTO_ID, edited);
        };
      };

      await runWorker();

      expect(storedPhoto()).toMatchObject({
        comment: '公園の入口の木',
        commentSource: 'user',
        identification: { name: 'ソメイヨシノ' },
        processing: { state: 'done' }
      });
    });

    it('前回のAIのコメントがある写真（自動の解析の再試行）では、新しいAIのコメントで書き直す', async () => {
      cosmosBackend.documents.set(PHOTO_ID, waitingPhoto({ comment: '前回のコメント', commentSource: 'ai' }));

      await runWorker();

      expect(storedPhoto()).toMatchObject({ comment: '満開のソメイヨシノ。エドヒガンの可能性もある', commentSource: 'ai' });
    });

    it('識別には、分類用のデプロイ名があっても今のデプロイを使う（識別用のデプロイ名は無い）', async () => {
      process.env.AZURE_OPENAI_CLASSIFY_DEPLOYMENT_NAME = 'classify-deployment';
      cosmosBackend.documents.set(PHOTO_ID, waitingPhoto());

      await runWorker();

      expect(sent).toHaveLength(1);
      expect(sent[0].options.baseURL).toBe('https://test.openai.azure.com/openai/deployments/main-deployment');
      expect(sent[0].body.model).toBe('main-deployment');
      expect(storedPhoto().identification).toMatchObject({ model: 'main-deployment' });
    });

    it('AIに送る要求は、原寸の画像と、種類ごとの項目（定義表のfields）を持つstrictな応答の形（06 §3.1）', async () => {
      cosmosBackend.documents.set(PHOTO_ID, waitingPhoto({ blobName: `${PHOTO_ID}.png`, contentType: 'image/png' }));

      await runWorker();

      expect(sent).toHaveLength(1);
      const body = sent[0].body;
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0].role).toBe('user');
      expect(body.messages[0].content).toHaveLength(2);
      expect(body.messages[0].content).toEqual(expect.arrayContaining([
        { type: 'text', text: expect.any(String) },
        { type: 'image_url', image_url: { url: expect.any(String), detail: 'low' } }
      ]));
      // 画像は分類と同じく、原寸を読み取りだけで開ける 15 分の署名付き URL
      const url = new URL(body.messages[0].content.find((part: any) => part.type === 'image_url').image_url.url);
      expect(`${url.origin}${url.pathname}`).toBe(`https://${TEST_BLOB_HOST}/photos/${PHOTO_ID}.png`);
      expect(url.searchParams.get('sp')).toBe('r');
      expect(url.searchParams.get('se')).toBe('2026-10-18T03:15:00Z');

      expect(body.response_format.type).toBe('json_schema');
      expect(body.response_format.json_schema.strict).toBe(true);
      expect(body.response_format.json_schema.name).toBe('photo_identification');
      const schema = body.response_format.json_schema.schema;
      // 共通項目。strict ではすべてを required に入れ、無いことは null で表す
      expect(Object.keys(schema.properties).sort()).toEqual(
        ['attributes', 'characteristics', 'comment', 'confidence', 'description', 'matchesKind', 'name'].sort()
      );
      expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
      expect(schema.additionalProperties).toBe(false);
      expect(schema.properties.matchesKind.type).toBe('boolean');
      expect(schema.properties.name.type).toEqual(['string', 'null']);
      expect(schema.properties.description.type).toEqual(['string', 'null']);
      expect(schema.properties.characteristics.type).toEqual(['string', 'null']);
      expect(schema.properties.comment.type).toBe('string');
      expect(schema.properties.confidence.type).toBe('number');
      // 種類ごとの項目（植物は学名・科名）
      const attributes = schema.properties.attributes;
      expect(attributes.type).toBe('object');
      expect(Object.keys(attributes.properties).sort()).toEqual(['familyName', 'scientificName']);
      expect([...attributes.required].sort()).toEqual(['familyName', 'scientificName']);
      expect(attributes.additionalProperties).toBe(false);
      expect(attributes.properties.scientificName.type).toEqual(['string', 'null']);

      expect(body.max_completion_tokens).toBe(4000);
      expect(body).not.toHaveProperty('max_tokens');
      expect(body).not.toHaveProperty('temperature');
    });

    it('種類ごとの項目は写真の種類の定義から作り、文字列の配列の項目は配列（null 可）で受ける', async () => {
      // 食べ物は料理のジャンル（文字列）と主な食材（文字列の配列）
      cosmosBackend.documents.set(PHOTO_ID, waitingPhoto({ category: 'food' }));
      aiReturns({ ...plantAnswer, name: '札幌味噌ラーメン', attributes: { genre: 'ラーメン', mainIngredients: ['中華麺', '味噌'] } });

      await runWorker();

      // 命名規則も写真の種類のもの（06 §3.1）
      expect(promptText()).toContain(CATALOG_KINDS.food.namingRule);
      const attributes = sent[0].body.response_format.json_schema.schema.properties.attributes;
      expect(Object.keys(attributes.properties).sort()).toEqual(['genre', 'mainIngredients']);
      expect(attributes.properties.genre.type).toEqual(['string', 'null']);
      expect(attributes.properties.mainIngredients.type).toEqual(['array', 'null']);
      expect(attributes.properties.mainIngredients.items).toEqual({ type: 'string' });
      expect(storedPhoto().identification).toMatchObject({
        kind: 'food',
        name: '札幌味噌ラーメン',
        attributes: { genre: 'ラーメン', mainIngredients: ['中華麺', '味噌'] }
      });
    });

    it('プロンプトには、種類の命名規則と、ある手がかり（やり直しの手がかり・撮影地・撮影日時）を含める', async () => {
      // 文言は契約外。何を渡したか（06 §3.1 の要素）だけを見る
      cosmosBackend.documents.set(
        PHOTO_ID,
        waitingPhoto({
          hint: '旭川の公園',
          takenAt: '2026-10-05T12:30:15',
          location: { latitude: 43.77, longitude: 142.36, placeName: '北海道旭川市', placeSource: 'device' }
        })
      );

      await runWorker();

      expect(promptText()).toContain(CATALOG_KINDS.plant.namingRule);
      expect(promptText()).toContain('旭川の公園');
      expect(promptText()).toContain('北海道旭川市');
      // 撮影日時は分まで（YYYY-MM-DD HH:mm。06 §3.1）
      expect(promptText()).toMatch(/2026-10-05 12:30(?!:)/);
    });

    it('手がかりが無ければ、無い値（null）を手がかりとしてAIに渡さない', async () => {
      cosmosBackend.documents.set(PHOTO_ID, waitingPhoto({ hint: null, takenAt: null, location: null }));

      await runWorker();

      expect(promptText()).not.toContain('null');
    });

    it('応答の検証に通らなければ、AIの失敗として識別の待ちに戻し、結果を書かない', () => forEachCase([
      ['写っているかが真偽値でない', { matchesKind: 'true' }],
      ['信頼度が0より小さい', { confidence: -1 }],
      ['信頼度が100より大きい', { confidence: 101 }],
      ['信頼度が数値でない', { confidence: '92' }],
      ['写っているのに名前が無い', { name: null }],
      ['写っているのに名前が空白だけ', { name: '   ' }],
      ['写っているのに名前が100文字を超える', { name: 'あ'.repeat(101) }],
      ['写っていないのに信頼度が100より大きい', { matchesKind: false, name: null, confidence: 101 }],
      ['種類ごとの項目の文字列が文字列でない', { attributes: { scientificName: 123, familyName: 'バラ科' } }]
    ], async (_label, broken) => {
      // strict のスキーマでも範囲や空は強制できない。通らない応答を書くと、図鑑に名前の無い項目や範囲外の信頼度が出る（06 §3.1）
      cosmosBackend.documents.set(PHOTO_ID, waitingPhoto());
      aiReturns({ ...plantAnswer, ...broken });

      await expect(runWorker()).rejects.toThrow();

      expect(storedPhoto()).toEqual(
        waitingPhoto({ processing: { state: 'pending', step: 'identify', attempts: 1, lastError: 'ai', updatedAt: NOW } })
      );
    }));

    it('応答の検証に通らなければ、AIの失敗として識別の待ちに戻す', () => forEachCase([
      ['文字列の配列の項目が配列でない', { genre: 'ラーメン', mainIngredients: '中華麺' }],
      ['文字列の配列の項目に文字列でない値がある', { genre: 'ラーメン', mainIngredients: ['中華麺', 1] }]
    ], async (_label, attributes) => {
      cosmosBackend.documents.set(PHOTO_ID, waitingPhoto({ category: 'food' }));
      aiReturns({ ...plantAnswer, attributes });

      await expect(runWorker()).rejects.toThrow();

      expect(storedPhoto().identification).toBeNull();
      expect(storedPhoto().processing).toEqual({ state: 'pending', step: 'identify', attempts: 1, lastError: 'ai', updatedAt: NOW });
    }));

    it('種類ごとの項目が特定できず nullでも受け付けて、null のまま書く', () => forEachCase([
      ['植物の学名（文字列の項目）', 'plant', { scientificName: null, familyName: 'バラ科' }],
      ['食べ物の主な食材（文字列の配列の項目）', 'food', { genre: 'ラーメン', mainIngredients: null }]
    ] as const, async (_label, category, attributes) => {
      // 定義表の prompt は「特定できない場合は null」と頼むので、null はふつうに来る（06 §3.1）
      cosmosBackend.documents.set(PHOTO_ID, waitingPhoto({ category }));
      aiReturns({ ...plantAnswer, attributes });

      await runWorker();

      expect(storedPhoto().identification).toMatchObject({ matchesKind: true, attributes });
      expect(storedPhoto().processing.state).toBe('done');
    }));

    it('写っていて名前がちょうど100文字なら受け付けて、そのまま書く', async () => {
      // 上限の境界（04 §3.1 の 1〜100 文字）
      cosmosBackend.documents.set(PHOTO_ID, waitingPhoto());
      aiReturns({ ...plantAnswer, name: 'あ'.repeat(100) });

      await runWorker();

      expect(storedPhoto().identification).toMatchObject({ name: 'あ'.repeat(100) });
    });

    it('識別のAIの設定の誤り（デプロイ名が無い）は、AIの失敗とは分けて、内部の失敗として数える', async () => {
      // どちらも上限まで送り直すが、lastError で AI の障害と設定の誤りを見分けられるようにする
      // （06 §3.1 のデプロイの行。分類とは別のサービスを通るので、分類のテストでは守れない）
      delete process.env.AZURE_OPENAI_DEPLOYMENT_NAME;
      cosmosBackend.documents.set(PHOTO_ID, waitingPhoto());

      await expect(runWorker()).rejects.toThrow();

      expect(sent).toHaveLength(0);
      expect(storedPhoto().processing).toEqual({ state: 'pending', step: 'identify', attempts: 1, lastError: 'internal', updatedAt: NOW });
    });

    it.each([0, 100])('信頼度が%sでも受け付けて、識別の結果に書く', async (confidence) => {
      cosmosBackend.documents.set(PHOTO_ID, waitingPhoto());
      aiReturns({ ...plantAnswer, confidence });

      await runWorker();

      expect(storedPhoto().identification).toMatchObject({ confidence, name: 'ソメイヨシノ' });
    });

    it('種類ごとの項目は定義表の項目だけを書く（定義に無いキーは捨てる）', async () => {
      cosmosBackend.documents.set(PHOTO_ID, waitingPhoto());
      aiReturns({ ...plantAnswer, attributes: { scientificName: 'Prunus × yedoensis', familyName: 'バラ科', nickname: 'サクラ' } });

      await runWorker();

      expect(storedPhoto().identification).toMatchObject({
        attributes: { scientificName: 'Prunus × yedoensis', familyName: 'バラ科' }
      });
      expect((storedPhoto().identification as any).attributes).not.toHaveProperty('nickname');
    });

    it('AIのコメントが空白だけなら、コメントを書かずに識別の結果を書く', async () => {
      cosmosBackend.documents.set(PHOTO_ID, waitingPhoto());
      aiReturns({ ...plantAnswer, comment: '   ' });

      await runWorker();

      expect(storedPhoto()).toMatchObject({ comment: null, commentSource: null, identification: { name: 'ソメイヨシノ' } });
    });

    it('識別のAIが失敗したら、識別の待ちに戻してどこで失敗したかを書き、例外を投げてキューの再試行に任せる', async () => {
      // 分類と同じ扱い（06 §1.3）。やる処理は識別のまま（分類からやり直さない）
      cosmosBackend.documents.set(PHOTO_ID, waitingPhoto());
      reply = async () => {
        throw Object.assign(new Error('500 The server had an error while processing your request.'), {
          name: 'InternalServerError',
          status: 500
        });
      };

      await expect(runWorker()).rejects.toThrow();

      expect(storedPhoto()).toEqual(
        waitingPhoto({ processing: { state: 'pending', step: 'identify', attempts: 1, lastError: 'ai', updatedAt: NOW } })
      );
    });

    it('上限（3回）目の識別の失敗なら、失敗（failed）にして例外を投げない。やる処理は識別のまま残す', async () => {
      // 画面は step で「識別に失敗しました」と出す（03 §5.1）
      cosmosBackend.documents.set(
        PHOTO_ID,
        waitingPhoto({ processing: { state: 'pending', step: 'identify', attempts: 2, lastError: 'ai', updatedAt: '2026-10-18T02:59:00.000Z' } })
      );
      aiReturns({ ...plantAnswer, confidence: 101 });

      await expect(runWorker()).resolves.toBeUndefined();

      expect(storedPhoto().processing).toEqual({ state: 'failed', step: 'identify', attempts: 3, lastError: 'ai', updatedAt: NOW });
      expect(storedPhoto().identification).toBeNull();
    });

    it('識別の間にやり直しの受付が入ったら、古い識別の結果もAIのコメントも書かず、やり直しを残す', async () => {
      // 捨てる結果のコメントを、やり直しの写真に残さない（06 §3.2）
      cosmosBackend.documents.set(PHOTO_ID, waitingPhoto());
      const redoRequested = waitingPhoto({
        hint: '梅かもしれない',
        processing: { state: 'pending', step: 'identify', attempts: 0, lastError: null, updatedAt: '2026-10-18T03:00:00.000Z' }
      });
      reply = async () => {
        cosmosBackend.documents.set(PHOTO_ID, redoRequested);
        return { choices: [{ message: { content: JSON.stringify(plantAnswer) } }] };
      };

      await expect(runWorker()).resolves.toBeUndefined();

      expect(storedPhoto()).toEqual(redoRequested);
    });

    it('写真の種類が図鑑の種類でない識別の待ちは、AIを呼ばずに内部の失敗として数える', async () => {
      // 分類を経ずに識別の待ちになった写真（ふつうは起きない）。識別の対象にできないので AI の費用をかけない（06 §3.1）
      cosmosBackend.documents.set(PHOTO_ID, waitingPhoto({ category: 'other' }));

      await expect(runWorker()).rejects.toThrow();

      expect(sent).toHaveLength(0);
      expect(storedPhoto().processing).toEqual({ state: 'pending', step: 'identify', attempts: 1, lastError: 'internal', updatedAt: NOW });
    });
  });

  describe('分類に使うAIのデプロイ', () => {
    // 選んだデプロイ名は、接続先の URL・要求の model・写真に書く classification.model のすべてに入る（06 §2.1）
    const expectDeployment = (deployment: string) => {
      expect(sent).toHaveLength(1);
      expect(sent[0].options.baseURL).toBe(`https://test.openai.azure.com/openai/deployments/${deployment}`);
      expect(sent[0].body.model).toBe(deployment);
      expect(storedPhoto().classification).toMatchObject({ model: deployment });
    };

    it('分類用のデプロイ名（AZURE_OPENAI_CLASSIFY_DEPLOYMENT_NAME）が未設定なら、今のデプロイ（AZURE_OPENAI_DEPLOYMENT_NAME）を使う', async () => {
      // 未設定にするのは beforeEach
      cosmosBackend.documents.set(PHOTO_ID, pendingPhoto());

      await runWorker();

      expectDeployment('main-deployment');
    });

    it.each([
      ['があれば、そのデプロイを使う', 'classify-deployment', 'classify-deployment'],
      ['が空文字列なら、未設定と同じく今のデプロイを使う', '', 'main-deployment'],
      ['が空白だけなら、未設定と同じく今のデプロイを使う', '  ', 'main-deployment']
    ])('分類用のデプロイ名%s', async (_label, classifyDeployment, expected) => {
      process.env.AZURE_OPENAI_CLASSIFY_DEPLOYMENT_NAME = classifyDeployment;
      cosmosBackend.documents.set(PHOTO_ID, pendingPhoto());

      await runWorker();

      expectDeployment(expected);
    });

    it('今のデプロイ名の前後に空白や改行があれば、取り除いたデプロイに送る', async () => {
      // アプリの設定に紛れた空白や改行のまま URL に入れると、Azure の 404 になって AI の障害に見える（06 §2.1）
      process.env.AZURE_OPENAI_DEPLOYMENT_NAME = ' main-deployment\n';
      cosmosBackend.documents.set(PHOTO_ID, pendingPhoto());

      await runWorker();

      expectDeployment('main-deployment');
    });

    it('分類用のデプロイ名があれば、今のデプロイ名が無くても分類できる', async () => {
      process.env.AZURE_OPENAI_CLASSIFY_DEPLOYMENT_NAME = 'classify-deployment';
      delete process.env.AZURE_OPENAI_DEPLOYMENT_NAME;
      cosmosBackend.documents.set(PHOTO_ID, pendingPhoto());

      await runWorker();

      expectDeployment('classify-deployment');
      expect(storedPhoto().classification).toEqual({ kind: 'food', confidence: 82.5, model: 'classify-deployment', at: NOW });
    });
  });

  describe('AIの接続先', () => {
    // Azure OpenAI Service と OpenAI API の分岐、api-version・api-key ヘッダの付け方（06 §2.1。分類と識別で同じ）
    it('Azure OpenAI Serviceの接続先には、api-versionのクエリ（AZURE_OPENAI_API_VERSION）とapi-keyヘッダを付ける', async () => {
      process.env.AZURE_OPENAI_API_VERSION = '2025-04-01-preview';
      cosmosBackend.documents.set(PHOTO_ID, pendingPhoto());

      await runWorker();

      expect(sent).toHaveLength(1);
      expect(sent[0].options.baseURL).toBe('https://test.openai.azure.com/openai/deployments/main-deployment');
      expect(sent[0].options.defaultQuery['api-version']).toBe('2025-04-01-preview');
      expect(sent[0].options.defaultHeaders['api-key']).toBe('azure-api-key');
    });

    it('AZURE_OPENAI_API_VERSIONが未設定なら、api-versionは2024-12-01-preview', async () => {
      // 未設定にするのは beforeEach
      cosmosBackend.documents.set(PHOTO_ID, pendingPhoto());

      await runWorker();

      expect(sent).toHaveLength(1);
      expect(sent[0].options.defaultQuery['api-version']).toBe('2024-12-01-preview');
    });

    it('AZURE_OPENAI_ENDPOINTが無ければ、接続先はOpenAI API（OPENAI_API_KEY）', async () => {
      delete process.env.AZURE_OPENAI_ENDPOINT;
      delete process.env.AZURE_OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = 'openai-api-key';
      cosmosBackend.documents.set(PHOTO_ID, pendingPhoto());

      await runWorker();

      expect(sent).toHaveLength(1);
      expect(sent[0].options.apiKey).toBe('openai-api-key');
      expect(sent[0].options.baseURL).toBeUndefined();
      expect(sent[0].options.defaultQuery).toBeUndefined();
      expect(sent[0].options.defaultHeaders).toBeUndefined();
    });

    it('AZURE_OPENAI_ENDPOINTが無く、デプロイ名も未設定なら、既定のモデル（gpt-5.6-luna）を指定する', async () => {
      delete process.env.AZURE_OPENAI_ENDPOINT;
      delete process.env.AZURE_OPENAI_DEPLOYMENT_NAME;
      process.env.OPENAI_API_KEY = 'openai-api-key';
      cosmosBackend.documents.set(PHOTO_ID, pendingPhoto());

      await runWorker();

      expect(sent).toHaveLength(1);
      expect(sent[0].body.model).toBe('gpt-5.6-luna');
      expect(storedPhoto().classification).toMatchObject({ model: 'gpt-5.6-luna' });
    });
  });

  describe('何もしないとき', () => {
    it('写真が解析の対象でない・別のインスタンスが処理中・済みなら、AIを呼ばず、写真も変えない', () => forEachCase([
      ['解析の対象になっていない（none）', { state: 'none', step: null, attempts: 0, lastError: null, updatedAt: null }],
      ['別のインスタンスが処理中（classifying）', { state: 'classifying', step: 'classify', attempts: 1, lastError: null, updatedAt: '2026-10-18T02:59:30.000Z' }],
      ['済み（done）', { state: 'done', step: 'classify', attempts: 1, lastError: null, updatedAt: '2026-10-18T02:59:30.000Z' }],
      ['上限まで失敗した（failed）', { state: 'failed', step: 'classify', attempts: 3, lastError: 'ai', updatedAt: '2026-10-18T02:59:30.000Z' }]
    ] as const, async (_label, processing) => {
      // 古いメッセージの重複配信や、やり直しの受付の後に残っていたメッセージ。06 §1.3
      const photo = pendingPhoto({ processing: { ...processing } });
      cosmosBackend.documents.set(PHOTO_ID, photo);

      await runWorker();

      expect(sent).toHaveLength(0);
      expect(storedPhoto()).toEqual(photo);
    }));

    it('読んだ後に別のインスタンスが担当して失敗し、分類の待ちに戻していたら、担当せず失敗の回数を数え直さない', async () => {
      // 同じメッセージが2回届き、両方が回数 0 の分類の待ちとして読んだ。このワーカーが担当を書く直前に、
      // もう一方が担当して AI に失敗し、回数 1 で分類の待ちに戻している。ここで担当すると回数をまた 1 と書き、
      // 上限（3回）で止まらなくなる（06 §1.3）
      cosmosBackend.documents.set(PHOTO_ID, pendingPhoto());
      const failedOnceByOther = pendingPhoto({
        processing: { state: 'pending', step: 'classify', attempts: 1, lastError: 'ai', updatedAt: '2026-10-18T02:59:59.000Z' }
      });
      cosmosBackend.beforePatch = () => {
        cosmosBackend.beforePatch = undefined;
        cosmosBackend.documents.set(PHOTO_ID, failedOnceByOther);
      };

      await runWorker();

      expect(sent).toHaveLength(0);
      expect(storedPhoto()).toEqual(failedOnceByOther);
    });

    it('読んだ後・担当する前に、別の処理がやる処理（step）を変えていたら、AIを呼ばず、その写真を変えない', async () => {
      // 同じ分類のメッセージが2回届き、片方が分類を済ませて識別の待ち（段階4。06 §2.3）にした後で、もう片方が担当しようとする。
      // state も回数も読んだときと同じに見えるので、step も担当の条件に入れないと、識別を捨てて分類し直す
      cosmosBackend.documents.set(PHOTO_ID, pendingPhoto());
      const waitingForIdentify = pendingPhoto({
        category: 'plant',
        processing: { state: 'pending', step: 'identify', attempts: 0, lastError: null, updatedAt: '2026-10-18T02:59:59.000Z' }
      });
      cosmosBackend.beforePatch = () => {
        cosmosBackend.beforePatch = undefined;
        cosmosBackend.documents.set(PHOTO_ID, waitingForIdentify);
      };

      await runWorker();

      expect(sent).toHaveLength(0);
      expect(storedPhoto()).toEqual(waitingForIdentify);
    });

    it('読んだ後に別のインスタンスが先に担当していたら、AIを呼ばず、その担当を邪魔しない', async () => {
      // 同じメッセージが2回届き（可視性タイムアウト後の重複配信）、両方が分類の待ちとして読んだ状態。
      // このワーカーが担当を書く直前に、もう一方が処理中にする
      cosmosBackend.documents.set(PHOTO_ID, pendingPhoto());
      const claimedByOther = pendingPhoto({
        processing: { state: 'classifying', step: 'classify', attempts: 1, lastError: null, updatedAt: '2026-10-18T02:59:59.000Z' }
      });
      cosmosBackend.beforePatch = () => {
        cosmosBackend.beforePatch = undefined;
        cosmosBackend.documents.set(PHOTO_ID, claimedByOther);
      };

      await runWorker();

      expect(sent).toHaveLength(0);
      expect(storedPhoto()).toEqual(claimedByOther);
    });

    it('読んだ後・担当する前にやり直しの受付が入ったら（state・処理・回数が同じに戻る）、担当せず、新しい手がかりを捨てない', async () => {
      // 送った直後の写真（回数 0）を読んだ後に、利用者が手がかり付きでやり直しを頼むと、state・step・回数は同じ値に戻る。
      // 担当すると読んだ古い写真（手がかり無し）で分類して済みにし、やり直しのメッセージは担当できずに捨てられる
      cosmosBackend.documents.set(PHOTO_ID, pendingPhoto());
      const redo = pendingPhoto({
        hint: '富士山',
        comment: null,
        commentSource: null,
        processing: { state: 'pending', step: 'classify', attempts: 0, lastError: null, updatedAt: '2026-10-18T02:59:59.000Z' }
      });
      cosmosBackend.beforePatch = () => {
        cosmosBackend.beforePatch = undefined;
        cosmosBackend.documents.set(PHOTO_ID, redo);
      };

      await runWorker();

      expect(sent).toHaveLength(0);
      expect(storedPhoto()).toEqual(redo);
    });

    it('読んだ後・担当する前に写真が消されたら、AIを呼ばずに何もせず終える', async () => {
      cosmosBackend.documents.set(PHOTO_ID, pendingPhoto());
      cosmosBackend.beforePatch = () => {
        cosmosBackend.beforePatch = undefined;
        cosmosBackend.documents.delete(PHOTO_ID);
      };

      await expect(runWorker()).resolves.toBeUndefined();

      expect(sent).toHaveLength(0);
      expect(cosmosBackend.documents.size).toBe(0);
    });

    it('写真が無ければ（消された後のメッセージ）、何もせずに終える', async () => {
      // 例外にすると、写真が無いメッセージがキューの再試行を3回使って poison に落ちるだけになる
      await expect(runWorker()).resolves.toBeUndefined();

      expect(sent).toHaveLength(0);
      expect(cosmosBackend.documents.size).toBe(0);
    });

    it('メッセージの写真IDが無い・文字列でないなら、何もせずに終える', () => forEachCase([
      ['写真IDが無い', {}],
      ['写真IDが文字列でない', { photoId: 123 }],
      ['写真IDの形式が違う', { photoId: '../photos/other' }],
      ['JSONのオブジェクトでない', 'not-json']
    ], async (_label, message) => {
      cosmosBackend.documents.set(PHOTO_ID, pendingPhoto());

      await expect(runWorker(message)).resolves.toBeUndefined();

      expect(sent).toHaveLength(0);
      expect(storedPhoto()).toEqual(pendingPhoto());
    }));
  });

  describe('失敗したとき', () => {
    // 実 SDK のエラー応答の形（message に OpenAI は入らない）
    const aiServerError = () =>
      Object.assign(new Error('500 The server had an error while processing your request.'), {
        name: 'InternalServerError',
        status: 500
      });

    it('AIが失敗したら、分類の待ちに戻してどこで失敗したかを書き、例外を投げてキューの再試行に任せる', async () => {
      cosmosBackend.documents.set(PHOTO_ID, pendingPhoto());
      reply = async () => {
        throw aiServerError();
      };

      await expect(runWorker()).rejects.toThrow();

      // 例外のメッセージは書かない（SDK 由来の文言が残り続ける）。結果の欄には何も書かない
      expect(storedPhoto()).toEqual(
        pendingPhoto({
          processing: { state: 'pending', step: 'classify', attempts: 1, lastError: 'ai', updatedAt: NOW }
        })
      );
    });

    it('上限（3回）目の失敗なら、失敗（failed）にして例外を投げない（キューの再試行もタイマーも拾わない）', async () => {
      cosmosBackend.documents.set(
        PHOTO_ID,
        pendingPhoto({
          processing: { state: 'pending', step: 'classify', attempts: 2, lastError: 'ai', updatedAt: '2026-10-18T02:59:00.000Z' }
        })
      );
      reply = async () => {
        throw aiServerError();
      };

      await expect(runWorker()).resolves.toBeUndefined();

      expect(storedPhoto().processing).toEqual({ state: 'failed', step: 'classify', attempts: 3, lastError: 'ai', updatedAt: NOW });
    });

    it('上限の回数は、環境変数（PHOTO_PROCESSING_MAX_ATTEMPTS）で決まる', async () => {
      process.env.PHOTO_PROCESSING_MAX_ATTEMPTS = '5';
      cosmosBackend.documents.set(
        PHOTO_ID,
        pendingPhoto({
          processing: { state: 'pending', step: 'classify', attempts: 2, lastError: 'ai', updatedAt: '2026-10-18T02:59:00.000Z' }
        })
      );
      reply = async () => {
        throw aiServerError();
      };

      await expect(runWorker()).rejects.toThrow();

      expect(storedPhoto().processing).toEqual({ state: 'pending', step: 'classify', attempts: 3, lastError: 'ai', updatedAt: NOW });
    });

    it('AIの設定の誤り（デプロイ名が無い）は、AIの失敗とは分けて、内部の失敗として数える', async () => {
      delete process.env.AZURE_OPENAI_DEPLOYMENT_NAME;
      cosmosBackend.documents.set(PHOTO_ID, pendingPhoto());

      await expect(runWorker()).rejects.toThrow();

      expect(sent).toHaveLength(0);
      expect(storedPhoto().processing).toEqual({ state: 'pending', step: 'classify', attempts: 1, lastError: 'internal', updatedAt: NOW });
    });

    it('AIのクライアントを作れない設定（APIキーが無い）は、AIの失敗とは分けて、内部の失敗として数える', async () => {
      // 実 SDK はキーが無いとクライアントのコンストラクタで投げる。AI の失敗にすると、一時的な障害として送り直し続ける（06 §2.1）
      delete process.env.AZURE_OPENAI_API_KEY;
      MockedOpenAI.mockImplementation(() => {
        throw new Error('Missing credentials. Please pass an `apiKey`, `workloadIdentity`, `adminAPIKey`, or set the `OPENAI_API_KEY` or `OPENAI_ADMIN_KEY` environment variable.');
      });
      cosmosBackend.documents.set(PHOTO_ID, pendingPhoto());

      await expect(runWorker()).rejects.toThrow();

      expect(storedPhoto().processing).toEqual({ state: 'pending', step: 'classify', attempts: 1, lastError: 'internal', updatedAt: NOW });
    });

    it('AIの応答が選択肢に無い種類・範囲外の信頼度なら、AIの失敗として分類の待ちに戻し、結果を書かない', () => forEachCase([
      ['選択肢に無い種類', JSON.stringify({ kind: 'animal', confidence: 90, reason: '犬が写っている' })],
      ['負の数の信頼度', JSON.stringify({ kind: 'food', confidence: -0.1, reason: 'テスト' })],
      ['100を超える信頼度', JSON.stringify({ kind: 'food', confidence: 100.5, reason: 'テスト' })],
      ['数値でない信頼度', JSON.stringify({ kind: 'food', confidence: '90', reason: 'テスト' })],
      ['空', null],
      ['JSONとして読めない', '{"kind": "food"']
    ], async (_label, content) => {
      // 検査を通らない応答を書き込むと、写真の category が図鑑の種類と食い違う（06 §2.1）
      cosmosBackend.documents.set(PHOTO_ID, pendingPhoto());
      reply = async () => ({ choices: [{ message: { content } }] });

      await expect(runWorker()).rejects.toThrow();

      expect(storedPhoto()).toEqual(
        pendingPhoto({
          processing: { state: 'pending', step: 'classify', attempts: 1, lastError: 'ai', updatedAt: NOW }
        })
      );
    }));

    it('写真を読めなければ、写真を変えずに例外を投げる（キューの再試行に任せる）', async () => {
      cosmosBackend.documents.set(PHOTO_ID, pendingPhoto());
      cosmosBackend.forcedReadError = Object.assign(new Error('Service Unavailable'), { code: 503 });

      await expect(runWorker()).rejects.toThrow();

      expect(sent).toHaveLength(0);
      expect(storedPhoto()).toEqual(pendingPhoto());
    });
  });

  describe('解析中に利用者が写真を変えたとき', () => {
    // やり直しの受付が写真に書く形（05 §5.7）。回数を 0 に戻し、分類の待ちにする
    const redoRequested = () =>
      pendingPhoto({
        hint: '屋台のラーメン',
        comment: null,
        commentSource: null,
        processing: { state: 'pending', step: 'classify', attempts: 0, lastError: null, updatedAt: '2026-10-18T03:00:00.000Z' }
      });

    it('分類の間にやり直しの受付が入ったら、古い分類の結果を書かず、やり直しを残す', async () => {
      // 古い処理の結果でやり直しを上書きすると、やり直しで積んだメッセージは担当できずに捨てられ、やり直しが黙って消える
      cosmosBackend.documents.set(PHOTO_ID, pendingPhoto());
      reply = async () => {
        cosmosBackend.documents.set(PHOTO_ID, redoRequested());
        return { choices: [{ message: { content: JSON.stringify({ kind: 'food', confidence: 82.5, reason: 'テスト' }) } }] };
      };

      await expect(runWorker()).resolves.toBeUndefined();

      expect(storedPhoto()).toEqual(redoRequested());
    });

    it('分類の間にやり直しが受け付けられ、別のインスタンスが担当し直していたら（回数が同じ）、古い分類の結果を書かない', async () => {
      // やり直しで回数が 0 に戻り、新しい担当でまた 1 になる。state と回数だけでは古い担当と見分けられない
      cosmosBackend.documents.set(PHOTO_ID, pendingPhoto());
      const reclaimed = pendingPhoto({
        hint: '富士山',
        comment: null,
        commentSource: null,
        processing: { state: 'classifying', step: 'classify', attempts: 1, lastError: null, updatedAt: '2026-10-18T03:00:30.000Z' }
      });
      reply = async () => {
        cosmosBackend.documents.set(PHOTO_ID, reclaimed);
        return { choices: [{ message: { content: JSON.stringify({ kind: 'food', confidence: 82.5, reason: 'テスト' }) } }] };
      };

      await expect(runWorker()).resolves.toBeUndefined();

      expect(storedPhoto()).toEqual(reclaimed);
    });

    it('分類の間に写真が消されたら、何も書かず、例外も投げない', async () => {
      cosmosBackend.documents.set(PHOTO_ID, pendingPhoto());
      reply = async () => {
        cosmosBackend.documents.delete(PHOTO_ID);
        return { choices: [{ message: { content: JSON.stringify({ kind: 'food', confidence: 82.5, reason: 'テスト' }) } }] };
      };

      await expect(runWorker()).resolves.toBeUndefined();

      expect(cosmosBackend.documents.size).toBe(0);
    });

    it('分類の間にやり直しの受付が入ったら、古い分類の失敗も書かず、例外も投げない', async () => {
      cosmosBackend.documents.set(PHOTO_ID, pendingPhoto());
      reply = async () => {
        cosmosBackend.documents.set(PHOTO_ID, redoRequested());
        throw Object.assign(new Error('500 The server had an error while processing your request.'), {
          name: 'InternalServerError',
          status: 500
        });
      };

      await expect(runWorker()).resolves.toBeUndefined();

      expect(storedPhoto()).toEqual(redoRequested());
    });

    it('担当の後、結果を書く前に利用者がタグと旅行を変えても、結果を書いた後に残る', async () => {
      // ロックは置かず、AI は自分の欄だけを書く（04 §7.4）。解析中でも利用者は写真を編集できる
      cosmosBackend.documents.set(PHOTO_ID, pendingPhoto());
      // 1回目の patch は担当。2回目（結果の書き込み）の直前に、利用者の編集が入る
      cosmosBackend.beforePatch = () => {
        cosmosBackend.beforePatch = () => {
          cosmosBackend.beforePatch = undefined;
          const edited: PhotoDocument = { ...storedPhoto(), tags: ['朝食', '札幌'], tripId: null };
          cosmosBackend.documents.set(PHOTO_ID, edited);
        };
      };

      await runWorker();

      expect(storedPhoto()).toMatchObject({
        tags: ['朝食', '札幌'],
        tripId: null,
        category: 'food',
        classification: { kind: 'food' }
      });
    });
  });
});
