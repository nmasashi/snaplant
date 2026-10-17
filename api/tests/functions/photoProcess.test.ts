import { HttpRequest, InvocationContext } from '@azure/functions';
import { CosmosClient } from '@azure/cosmos';
import { BlobServiceClient, generateBlobSASQueryParameters } from '@azure/storage-blob';
import { QueueClient } from '@azure/storage-queue';
import { processPhotoRequestHandler } from '../../src/functions/photoProcess';
import { PhotoDocument } from '../../src/types/album';
import { FakeCosmosBackend, FakeCosmosDocument, createFakeContainer } from '../fakes/cosmos';
import { FakeBlobBackend, TEST_BLOB_HOST, createFakeBlobServiceClient } from '../fakes/blob';
import { FakeQueueBackend, createFakeQueueClient, decodeQueueMessage } from '../fakes/queue';
import { photoDocument } from '../helpers/albumDocuments';
import { databaseFailureCases } from '../helpers/databaseFailures';

// 外部依存のみモック。SAS の署名は固定のトークンを返す形に差し替える（署名の中身は photos.test.ts が実 SDK で見ている）
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

const TEST_SAS_TOKEN = 'sv=2024-01-01&se=2030-01-01T00%3A00%3A00Z&sp=r&sig=testsignature';
const PHOTO_ID = '45ae705277879f7f01d778f7c95a065bb0c06ab9936cf24307f375211fee13d1';
const TRIP_ID = '123e4567-e89b-42d3-a456-426614174000';
// 受け付けた時刻。写真に保存してある時刻とは別の日にして、書き換わったことを見分ける
const NOW = '2026-10-18T05:30:00.000Z';

const createRequestWithJson = (photoId: string, json: jest.Mock): HttpRequest =>
  ({
    method: 'POST',
    url: `https://func-snaplant.azurewebsites.net/api/photos/${photoId}/process?code=test-key`,
    query: new Map([['code', 'test-key']]),
    headers: new Map([['content-type', 'application/json']]),
    params: { photoId },
    json
  }) as any as HttpRequest;

const createRequest = (photoId: string, body: unknown): HttpRequest =>
  createRequestWithJson(photoId, jest.fn().mockResolvedValue(body));

/**
 * 分類が済んだ写真。利用者のコメント・タグ・旅行と、前回の分類の結果を持たせ、変わる項目と変わらない項目を見分ける
 */
const classifiedPhoto = (overrides: Partial<PhotoDocument> = {}): PhotoDocument =>
  photoDocument(PHOTO_ID, {
    tripId: TRIP_ID,
    category: 'food',
    tags: ['夕食'],
    comment: '屋台で食べた',
    commentSource: 'user',
    hint: null,
    classification: { kind: 'food', confidence: 60, model: 'gpt-6-luna', at: '2026-10-17T01:00:00.000Z' },
    identification: null,
    processing: { state: 'done', step: 'classify', attempts: 1, lastError: null, updatedAt: '2026-10-17T01:00:00.000Z' },
    updatedAt: '2026-10-17T01:00:00.000Z',
    ...overrides
  });

describe('写真の解析のやり直しAPI', () => {
  let mockContext: InvocationContext;
  let cosmosBackend: FakeCosmosBackend<FakeCosmosDocument>;
  let blobBackend: FakeBlobBackend;
  let queueBackend: FakeQueueBackend;

  const storedPhoto = () => cosmosBackend.documents.get(PHOTO_ID) as PhotoDocument;
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

    blobBackend = { store: new Map() };
    MockedBlobServiceClient.fromConnectionString = jest.fn().mockReturnValue(createFakeBlobServiceClient(blobBackend));
    mockedGenerateSas.mockReturnValue({ toString: () => TEST_SAS_TOKEN } as any);

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
    process.env.PHOTO_QUEUE_NAME = 'photo-processing';
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
    delete process.env.PHOTO_QUEUE_NAME;
    delete process.env.AzureWebJobsStorage;
  });

  it('分類のやり直しを頼むと、202で受け付け、写真を分類の待ちにして手がかりを書き、コメントを消してキューに積む', async () => {
    // コメントは、やり直しの結果で置き換えるために受付で消す（利用者の文はアプリが手がかりに事前入力する。05 §5.7）。
    // 前回の分類の結果は、やり直しの結果が出るまで残す。タグと旅行は変わらない
    cosmosBackend.documents.set(PHOTO_ID, classifiedPhoto());

    const response = await processPhotoRequestHandler(
      createRequest(PHOTO_ID, { step: 'classify', hint: '屋台のラーメン' }),
      mockContext
    );

    const expected = classifiedPhoto({
      hint: '屋台のラーメン',
      comment: null,
      commentSource: null,
      processing: { state: 'pending', step: 'classify', attempts: 0, lastError: null, updatedAt: NOW },
      updatedAt: NOW
    });
    expect(storedPhoto()).toEqual(expected);
    expect(response.status).toBe(202);
    const { type: _type, blobName: _blobName, thumbnailBlobName: _thumbnailBlobName, ...fields } = expected;
    expect(response.jsonBody).toEqual({
      success: true,
      data: {
        photo: {
          ...fields,
          imageUrl: `https://${TEST_BLOB_HOST}/photos/${PHOTO_ID}.jpg?${TEST_SAS_TOKEN}`,
          thumbnailUrl: `https://${TEST_BLOB_HOST}/photos/${PHOTO_ID}.thumb.jpg?${TEST_SAS_TOKEN}`
        },
        urlExpiresAt: '2026-10-18T06:30:00.000Z'
      }
    });
    expect(queuedMessages()).toEqual([['photo-processing', [{ photoId: PHOTO_ID }]]]);
  });

  it('上限まで失敗した（failed）写真も、回数を0に戻して、もう一度試せる', async () => {
    // failed から出る経路はこの操作だけ（06 §1.3）
    cosmosBackend.documents.set(
      PHOTO_ID,
      classifiedPhoto({
        category: null,
        classification: null,
        processing: { state: 'failed', step: 'classify', attempts: 3, lastError: 'ai', updatedAt: '2026-10-17T01:00:00.000Z' }
      })
    );

    const response = await processPhotoRequestHandler(createRequest(PHOTO_ID, { step: 'classify' }), mockContext);

    expect(response.status).toBe(202);
    expect(storedPhoto().processing).toEqual({ state: 'pending', step: 'classify', attempts: 0, lastError: null, updatedAt: NOW });
    expect(queuedMessages()).toEqual([['photo-processing', [{ photoId: PHOTO_ID }]]]);
  });

  it.each([
    ['手がかりを送らなければ', {}],
    ['手がかりが空白だけなら', { hint: '   ' }],
    ['手がかりがnullなら', { hint: null }]
  ])('%s、前回の手がかりを消して、手がかり無しで頼む', async (_label, extra) => {
    cosmosBackend.documents.set(PHOTO_ID, classifiedPhoto({ hint: '前回の手がかり' }));

    const response = await processPhotoRequestHandler(
      createRequest(PHOTO_ID, { step: 'classify', ...extra }),
      mockContext
    );

    expect(response.status).toBe(202);
    expect(storedPhoto().hint).toBeNull();
  });

  it('手がかりは、前後の空白を除いて書く', async () => {
    cosmosBackend.documents.set(PHOTO_ID, classifiedPhoto());

    await processPhotoRequestHandler(createRequest(PHOTO_ID, { step: 'classify', hint: '  屋台のラーメン \n' }), mockContext);

    expect(storedPhoto().hint).toBe('屋台のラーメン');
  });

  it('キューへの投入に失敗しても、202で受け付け、写真は分類の待ちのまま残る', async () => {
    // 写真は再投入のタイマーが拾う。失敗を返すと「失敗したのに後で勝手に走る」ことになる（05 §5.7）
    cosmosBackend.documents.set(PHOTO_ID, classifiedPhoto());
    queueBackend.forcedSendError = Object.assign(new Error('The specified queue does not exist.'), {
      name: 'RestError',
      statusCode: 404,
      code: 'QueueNotFound'
    });

    const response = await processPhotoRequestHandler(createRequest(PHOTO_ID, { step: 'classify' }), mockContext);

    expect(response.status).toBe(202);
    expect(storedPhoto().processing.state).toBe('pending');
    expect(queuedMessages()).toEqual([]);
  });

  describe('受け付けないとき', () => {
    const invalidCases: [string, string, unknown, string][] = [
      ['写真IDの形式が無効', 'not-a-photo-id', { step: 'classify' }, '写真IDの形式が無効です'],
      ['ボディがnull', PHOTO_ID, null, 'リクエストボディが指定されていません'],
      ['やり直す処理が無い', PHOTO_ID, {}, 'やり直す処理の種類が無効です'],
      // 識別は段階4。段階3では受け付けない
      ['やり直す処理が識別（段階3）', PHOTO_ID, { step: 'identify' }, 'やり直す処理の種類が無効です'],
      ['やり直す処理が文字列でない', PHOTO_ID, { step: 1 }, 'やり直す処理の種類が無効です'],
      ['手がかりが文字列でない', PHOTO_ID, { step: 'classify', hint: 123 }, '補足情報は文字列で指定してください'],
      ['手がかりが500文字を超える', PHOTO_ID, { step: 'classify', hint: 'あ'.repeat(501) }, '補足情報は500文字以内で指定してください'],
      // 検証の順序: 写真ID → ボディ → 処理の種類 → 手がかり
      ['写真IDも処理の種類も不正（写真IDの指摘が先）', 'bad', { step: 'identify' }, '写真IDの形式が無効です'],
      ['処理の種類も手がかりも不正（処理の種類の指摘が先）', PHOTO_ID, { step: 'identify', hint: 123 }, 'やり直す処理の種類が無効です']
    ];

    it.each(invalidCases)('%sなら、400で理由を返し、写真も変えずキューにも積まない', async (_case, photoId, body, message) => {
      cosmosBackend.documents.set(PHOTO_ID, classifiedPhoto());

      const response = await processPhotoRequestHandler(createRequest(photoId, body), mockContext);

      expect(response.status).toBe(400);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'INVALID_REQUEST', message } });
      expect(storedPhoto()).toEqual(classifiedPhoto());
      expect(queuedMessages()).toEqual([]);
    });

    it('ボディがJSONとして読めなければ、400で理由を返す', async () => {
      cosmosBackend.documents.set(PHOTO_ID, classifiedPhoto());

      const response = await processPhotoRequestHandler(
        createRequestWithJson(PHOTO_ID, jest.fn().mockRejectedValue(new SyntaxError('Unexpected token'))),
        mockContext
      );

      expect(response.status).toBe(400);
      expect(response.jsonBody).toMatchObject({
        success: false,
        error: { code: 'INVALID_REQUEST', message: 'リクエストボディの形式が無効です' }
      });
    });

    it('写真が無ければ、404で理由を返し、キューにも積まない', async () => {
      const response = await processPhotoRequestHandler(createRequest(PHOTO_ID, { step: 'classify' }), mockContext);

      expect(response.status).toBe(404);
      expect(response.jsonBody).toMatchObject({
        success: false,
        error: { code: 'PHOTO_NOT_FOUND', message: '指定された写真が見つかりません' }
      });
      expect(cosmosBackend.documents.size).toBe(0);
      expect(queuedMessages()).toEqual([]);
    });

    it.each(databaseFailureCases('解析のやり直しの受付に失敗しました'))(
      'データベースの書き込みで%s',
      async (_case, error, status, code, message) => {
        cosmosBackend.documents.set(PHOTO_ID, classifiedPhoto());
        cosmosBackend.forcedPatchError = error;

        const response = await processPhotoRequestHandler(createRequest(PHOTO_ID, { step: 'classify' }), mockContext);

        expect(response.status).toBe(status);
        expect(response.jsonBody).toMatchObject({ success: false, error: { code, message } });
        expect(storedPhoto()).toEqual(classifiedPhoto());
        expect(queuedMessages()).toEqual([]);
      }
    );
  });
});
