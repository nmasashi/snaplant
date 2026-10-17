import { InvocationContext } from '@azure/functions';
import { CosmosClient } from '@azure/cosmos';
import { BlobServiceClient } from '@azure/storage-blob';
import { processPhotoHandler } from '../../src/functions/processPhoto';
import { PhotoDocument } from '../../src/types/album';
import { FakeCosmosBackend, FakeCosmosDocument, createFakeContainer } from '../fakes/cosmos';
import { FakeBlobBackend, TEST_BLOB_HOST, createFakeBlobServiceClient } from '../fakes/blob';
import { photoDocument } from '../helpers/albumDocuments';

// 外部依存のみモック。Cosmos DB と Blob Storage は状態持ちの偽物、AI（管理外）は送った要求を残すモック。
// SAS の署名は実 SDK のまま（ローカルの計算だけで、Blob Storage へは通信しない）
jest.mock('@azure/cosmos');
jest.mock('@azure/storage-blob', () => ({
  ...jest.requireActual('@azure/storage-blob'),
  BlobServiceClient: { fromConnectionString: jest.fn() }
}));
jest.mock('openai', () => {
  const MockOpenAI = jest.fn();
  return Object.assign(MockOpenAI, { default: MockOpenAI });
});
const MockedOpenAI = jest.requireMock('openai');
const MockedCosmosClient = CosmosClient as jest.MockedClass<typeof CosmosClient>;
const MockedBlobServiceClient = BlobServiceClient as jest.MockedClass<typeof BlobServiceClient>;

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
  'PHOTO_PROCESSING_MAX_ATTEMPTS'
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
    delete process.env.PHOTO_PROCESSING_MAX_ATTEMPTS;
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
      // 前に1回失敗している（attempts 1・lastError あり）。成功で lastError が消え、attempts は数え続ける
      cosmosBackend.documents.set(
        PHOTO_ID,
        pendingPhoto({
          processing: { state: 'pending', step: 'classify', attempts: 1, lastError: 'ai', updatedAt: '2026-10-18T02:59:00.000Z' }
        })
      );

      await runWorker();

      expect(storedPhoto()).toEqual({
        ...pendingPhoto(),
        category: 'food',
        classification: { kind: 'food', confidence: 82.5, model: 'main-deployment', at: NOW },
        identification: null,
        processing: { state: 'done', step: 'classify', attempts: 2, lastError: null, updatedAt: NOW },
        updatedAt: NOW
      });
    });

    it.each(['plant', 'landscape', 'other'])(
      '種類が%sでも、段階3では分類の後に済みになる（識別は段階4）',
      async (kind) => {
        cosmosBackend.documents.set(PHOTO_ID, pendingPhoto());
        aiReturns({ kind, confidence: 70, reason: 'テスト' });

        await runWorker();

        expect(storedPhoto().category).toBe(kind);
        expect(storedPhoto().processing).toEqual({ state: 'done', step: 'classify', attempts: 1, lastError: null, updatedAt: NOW });
      }
    );

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

    it('撮影地があれば、手がかりとしてAIに渡す', async () => {
      cosmosBackend.documents.set(
        PHOTO_ID,
        pendingPhoto({ location: { latitude: 43.06, longitude: 141.35, placeName: '北海道札幌市中央区', placeSource: 'device' } })
      );

      await runWorker();

      const text = sent[0].body.messages[0].content.find((part: any) => part.type === 'text').text;
      expect(text).toContain('北海道札幌市中央区');
    });
  });

  describe('何もしないとき', () => {
    it.each([
      ['解析の対象になっていない（none）', { state: 'none', step: null, attempts: 0, lastError: null, updatedAt: null }],
      ['別のインスタンスが処理中（classifying）', { state: 'classifying', step: 'classify', attempts: 1, lastError: null, updatedAt: '2026-10-18T02:59:30.000Z' }],
      ['済み（done）', { state: 'done', step: 'classify', attempts: 1, lastError: null, updatedAt: '2026-10-18T02:59:30.000Z' }],
      ['上限まで失敗した（failed）', { state: 'failed', step: 'classify', attempts: 3, lastError: 'ai', updatedAt: '2026-10-18T02:59:30.000Z' }]
    ] as const)('写真が%sなら、AIを呼ばず、写真も変えない', async (_label, processing) => {
      // 古いメッセージの重複配信や、やり直しの受付の後に残っていたメッセージ。06 §1.3
      const photo = pendingPhoto({ processing: { ...processing } });
      cosmosBackend.documents.set(PHOTO_ID, photo);

      await runWorker();

      expect(sent).toHaveLength(0);
      expect(storedPhoto()).toEqual(photo);
    });

    it('読んだ後に別のインスタンスが先に担当していたら、AIを呼ばず、その担当を邪魔しない', async () => {
      // 同じメッセージが2回届き（可視性タイムアウト後の重複配信）、両方が分類の待ちとして読んだ状態。
      // このワーカーが担当を書く直前に、もう一方が処理中にする
      cosmosBackend.documents.set(PHOTO_ID, pendingPhoto());
      const claimedByOther = pendingPhoto({
        processing: { state: 'classifying', step: 'classify', attempts: 1, lastError: null, updatedAt: '2026-10-18T02:59:59.000Z' }
      });
      let patches = 0;
      cosmosBackend.beforePatch = () => {
        patches += 1;
        if (patches === 1) {
          cosmosBackend.documents.set(PHOTO_ID, claimedByOther);
        }
      };

      await runWorker();

      expect(sent).toHaveLength(0);
      expect(storedPhoto()).toEqual(claimedByOther);
    });

    it('写真が無ければ（消された後のメッセージ）、何もせずに終える', async () => {
      // 例外にすると、写真が無いメッセージがキューの再試行を3回使って poison に落ちるだけになる
      await expect(runWorker()).resolves.toBeUndefined();

      expect(sent).toHaveLength(0);
      expect(cosmosBackend.documents.size).toBe(0);
    });

    it.each([
      ['写真IDが無い', {}],
      ['写真IDが文字列でない', { photoId: 123 }],
      ['写真IDの形式が違う', { photoId: '../photos/other' }],
      ['JSONのオブジェクトでない', 'not-json']
    ])('メッセージの%sなら、何もせずに終える', async (_label, message) => {
      cosmosBackend.documents.set(PHOTO_ID, pendingPhoto());

      await expect(runWorker(message)).resolves.toBeUndefined();

      expect(sent).toHaveLength(0);
      expect(storedPhoto()).toEqual(pendingPhoto());
    });
  });
});
