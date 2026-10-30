import { HttpRequest, InvocationContext } from '@azure/functions';
import { CosmosClient } from '@azure/cosmos';
import { BlobServiceClient, generateBlobSASQueryParameters } from '@azure/storage-blob';
import { QueueClient } from '@azure/storage-queue';
import { processPhotoRequestHandler } from '../../src/functions/photoProcess';
import { PhotoDocument } from '../../src/types/album';
import { FakeCosmosBackend, FakeCosmosDocument, createFakeContainer } from '../fakes/cosmos';
import { FakeBlobBackend, TEST_BLOB_HOST, createFakeBlobServiceClient } from '../fakes/blob';
import { FakeQueueBackend, createFakeQueueClient, decodeQueueMessage } from '../fakes/queue';
import { forEachCase } from '../helpers/cases';
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
    delete process.env.CONTEXT_INFO_MAX_LENGTH;
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
      // 分類からやり直すので、カテゴリは AI に任せ直す（手で決めた印を null で書く）
      categorySource: null,
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
          categorySource: null,
          imageUrl: `https://${TEST_BLOB_HOST}/photos/${PHOTO_ID}.jpg?${TEST_SAS_TOKEN}`,
          thumbnailUrl: `https://${TEST_BLOB_HOST}/photos/${PHOTO_ID}.thumb.jpg?${TEST_SAS_TOKEN}`
        },
        urlExpiresAt: '2026-10-18T06:30:00.000Z'
      }
    });
    expect(queuedMessages()).toEqual([['photo-processing', [{ photoId: PHOTO_ID }]]]);
  });

  it('分類のやり直しは、手で決めたカテゴリの印を消し、カテゴリを AI に任せ直す（識別のやり直しは印を残す）', () => forEachCase([
    ['分類のやり直し', 'classify', null],
    ['識別のやり直し', 'identify', 'user']
  ] as const, async (_case, step, categorySource) => {
    // 印が残ったまま AI の分類がカテゴリを書くと、AI の決めたカテゴリが「手で決めた」と表示される（02 §5 #53）
    cosmosBackend.documents.set(PHOTO_ID, classifiedPhoto({ categorySource: 'user' }));

    await processPhotoRequestHandler(createRequest(PHOTO_ID, { step }), mockContext);

    expect(storedPhoto().categorySource).toBe(categorySource);
  }));

  it('識別のやり直しを頼むと、202で受け付け、写真を識別の待ちにして手がかりを書き、コメントを消してキューに積む', async () => {
    // 分類はやり直さず、今のカテゴリ（food）のまま名前などを識別し直す（03 §5.4。アプリはカテゴリが識別の対象の写真で identify を頼む）。前回の識別の結果は、やり直しの結果が出るまで残す
    cosmosBackend.documents.set(
      PHOTO_ID,
      classifiedPhoto({
        identification: { kind: 'food', matchesKind: true, name: '醤油ラーメン' },
        processing: { state: 'done', step: 'identify', attempts: 1, lastError: null, updatedAt: '2026-10-17T01:00:00.000Z' }
      })
    );

    const response = await processPhotoRequestHandler(
      createRequest(PHOTO_ID, { step: 'identify', hint: '味噌ラーメンだった' }),
      mockContext
    );

    expect(response.status).toBe(202);
    expect(storedPhoto()).toEqual(
      classifiedPhoto({
        identification: { kind: 'food', matchesKind: true, name: '醤油ラーメン' },
        hint: '味噌ラーメンだった',
        comment: null,
        commentSource: null,
        processing: { state: 'pending', step: 'identify', attempts: 0, lastError: null, updatedAt: NOW },
        updatedAt: NOW
      })
    );
    expect(response.jsonBody).toMatchObject({ success: true, data: { photo: { processing: { step: 'identify' } } } });
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

  it('手がかりを送らない・空白だけのときは、前回の手がかりを消して、手がかり無しで頼む', () => forEachCase([
    ['手がかりを送らなければ', {}],
    ['手がかりが空白だけなら', { hint: '   ' }],
    ['手がかりがnullなら', { hint: null }]
  ], async (_label, extra) => {
    cosmosBackend.documents.set(PHOTO_ID, classifiedPhoto({ hint: '前回の手がかり' }));

    const response = await processPhotoRequestHandler(
      createRequest(PHOTO_ID, { step: 'classify', ...extra }),
      mockContext
    );

    expect(response.status).toBe(202);
    expect(storedPhoto().hint).toBeNull();
  }));

  it('手がかりは500文字までなら受け付ける', async () => {
    cosmosBackend.documents.set(PHOTO_ID, classifiedPhoto());

    const response = await processPhotoRequestHandler(
      createRequest(PHOTO_ID, { step: 'classify', hint: 'あ'.repeat(500) }),
      mockContext
    );

    expect(response.status).toBe(202);
    expect(storedPhoto().hint).toBe('あ'.repeat(500));
  });

  // 家族の絵文字は見た目は1文字、UTF-16 では8単位
  it('手がかりの文字数は見た目の1文字で数え、絵文字で500文字までなら受け付ける', async () => {
    cosmosBackend.documents.set(PHOTO_ID, classifiedPhoto());

    const response = await processPhotoRequestHandler(
      createRequest(PHOTO_ID, { step: 'classify', hint: '👨‍👩‍👧'.repeat(500) }),
      mockContext
    );

    expect(response.status).toBe(202);
    expect(storedPhoto().hint).toBe('👨‍👩‍👧'.repeat(500));
  });

  it('手がかりの前後の U+0085（次の行）も空白として除く（アプリの trim と同じ。それだけなら手がかりなし）', () => forEachCase<[string, string, string | null]>([
    ['前後にある', '\u0085赤い花\u0085', '赤い花'],
    ['それだけ', '\u0085', null]
  ], async (_label, hint, saved) => {
    cosmosBackend.documents.set(PHOTO_ID, classifiedPhoto());

    const response = await processPhotoRequestHandler(createRequest(PHOTO_ID, { step: 'classify', hint }), mockContext);

    expect(response.status).toBe(202);
    expect(storedPhoto().hint).toBe(saved);
  }));

  it('手がかりの上限の設定（CONTEXT_INFO_MAX_LENGTH）が数値として読めない値でも、上限は既定の500文字のまま', async () => {
    // parseInt('invalid') の NaN をそのまま上限に使うと `501 > NaN` が false になり、上限が静かに消える（05 §4）。
    // 上限はモジュールを読み込んだ時点で決まるので、環境変数を変えてから読み込み直す。
    // 読み込み直したモジュールの SDK のモックは別物になるので、偽物を配線し直す
    // （配線しないと、上限が消えたときに 202 ではなく偽物の未配線という別の理由で落ちる）
    process.env.CONTEXT_INFO_MAX_LENGTH = 'invalid';
    cosmosBackend.documents.set(PHOTO_ID, classifiedPhoto());
    let handlerWithInvalidEnv!: typeof processPhotoRequestHandler;
    jest.isolateModules(() => {
      const fakeContainer = createFakeContainer(cosmosBackend);
      require('@azure/cosmos').CosmosClient.mockImplementation(() => ({
        database: () => ({ container: () => fakeContainer })
      }));
      const freshBlob = require('@azure/storage-blob');
      freshBlob.BlobServiceClient.fromConnectionString = jest.fn().mockReturnValue(createFakeBlobServiceClient(blobBackend));
      freshBlob.generateBlobSASQueryParameters.mockReturnValue({ toString: () => TEST_SAS_TOKEN });
      require('@azure/storage-queue').QueueClient.mockImplementation((_connectionString: string, queueName: string) =>
        createFakeQueueClient(queueBackend, queueName));
      handlerWithInvalidEnv = require('../../src/functions/photoProcess').processPhotoRequestHandler;
    });

    const response = await handlerWithInvalidEnv(
      createRequest(PHOTO_ID, { step: 'classify', hint: 'あ'.repeat(501) }),
      mockContext
    );

    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({
      success: false,
      error: { code: 'INVALID_REQUEST', message: '補足情報は500文字以内で指定してください' }
    });
    expect(storedPhoto()).toEqual(classifiedPhoto());
    expect(queuedMessages()).toEqual([]);
  });

  it('手がかりは、前後の空白を除いて書く', async () => {
    cosmosBackend.documents.set(PHOTO_ID, classifiedPhoto());

    await processPhotoRequestHandler(createRequest(PHOTO_ID, { step: 'classify', hint: '  屋台のラーメン \n' }), mockContext);

    expect(storedPhoto().hint).toBe('屋台のラーメン');
  });

  describe('場所（撮影地の地名）を直して頼む（C-2。02 §5 #53）', () => {
    it('場所を送ると、撮影地の地名を手で直したものとして書く（緯度・経度は残す）', async () => {
      cosmosBackend.documents.set(PHOTO_ID, classifiedPhoto({ location: { latitude: 41.77, longitude: 140.73, placeName: '函館市', placeSource: 'device' } }));

      const response = await processPhotoRequestHandler(createRequest(PHOTO_ID, { step: 'identify', placeName: ' 函館朝市 ' }), mockContext);

      expect(response.status).toBe(202);
      expect(storedPhoto().location).toEqual({ latitude: 41.77, longitude: 140.73, placeName: '函館朝市', placeSource: 'user' });
      expect((response.jsonBody as any).data.photo.location).toEqual({ latitude: 41.77, longitude: 140.73, placeName: '函館朝市', placeSource: 'user' });
    });

    it('位置情報の無い写真に場所を送ると、緯度・経度の無い撮影地として書く', async () => {
      cosmosBackend.documents.set(PHOTO_ID, classifiedPhoto({ location: null }));

      await processPhotoRequestHandler(createRequest(PHOTO_ID, { step: 'classify', placeName: '函館朝市' }), mockContext);

      expect(storedPhoto().location).toEqual({ latitude: null, longitude: null, placeName: '函館朝市', placeSource: 'user' });
    });

    // 地名を消しても出どころは user にする（null だと「まだ地名を引いていない」と区別できず、後で地名を引き直すと消した地名が戻る。04 §1.3）
    it('場所を空にして送ると地名を消す（緯度・経度と、手で消した印を残し、位置情報の無い写真は無いまま）', () => forEachCase([
      ['緯度・経度のある写真', { latitude: 41.77, longitude: 140.73, placeName: '函館市', placeSource: 'device' as const }, { latitude: 41.77, longitude: 140.73, placeName: null, placeSource: 'user' }],
      ['緯度・経度の無い写真', { latitude: null, longitude: null, placeName: '函館朝市', placeSource: 'user' as const }, null],
      ['位置情報の無い写真', null, null]
    ], async (_case, location, expected) => {
      cosmosBackend.documents.set(PHOTO_ID, classifiedPhoto({ location }));

      await processPhotoRequestHandler(createRequest(PHOTO_ID, { step: 'classify', placeName: '   ' }), mockContext);

      expect(storedPhoto().location).toEqual(expected);
    }));

    it('場所を null で送っても、空と同じく地名を消す', async () => {
      cosmosBackend.documents.set(PHOTO_ID, classifiedPhoto({ location: { latitude: 41.77, longitude: 140.73, placeName: '函館市', placeSource: 'device' } }));

      await processPhotoRequestHandler(createRequest(PHOTO_ID, { step: 'classify', placeName: null }), mockContext);

      expect(storedPhoto().location).toEqual({ latitude: 41.77, longitude: 140.73, placeName: null, placeSource: 'user' });
    });

    it('場所は前後の空白を除いて100文字ちょうどなら受け付ける', async () => {
      cosmosBackend.documents.set(PHOTO_ID, classifiedPhoto({ location: null }));

      const response = await processPhotoRequestHandler(createRequest(PHOTO_ID, { step: 'classify', placeName: ` ${'あ'.repeat(100)} ` }), mockContext);

      expect(response.status).toBe(202);
      expect(storedPhoto().location).toMatchObject({ placeName: 'あ'.repeat(100) });
    });

    it('場所を送ったとき、写真が無ければ（分類のやり直しでも）404で理由を返す', async () => {
      // 場所を送ると、分類のやり直しでも今の撮影地を見るために先に写真を読む
      const response = await processPhotoRequestHandler(createRequest(PHOTO_ID, { step: 'classify', placeName: '函館朝市' }), mockContext);

      expect(response.status).toBe(404);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'PHOTO_NOT_FOUND', message: '指定された写真が見つかりません' } });
      expect(queuedMessages()).toEqual([]);
    });

    it('今と同じ地名を送っても、撮影地は変えない（端末が引いた地名のまま）', async () => {
      const location = { latitude: 41.77, longitude: 140.73, placeName: '函館市', placeSource: 'device' as const };
      cosmosBackend.documents.set(PHOTO_ID, classifiedPhoto({ location }));

      await processPhotoRequestHandler(createRequest(PHOTO_ID, { step: 'classify', placeName: '函館市' }), mockContext);

      expect(storedPhoto().location).toEqual(location);
    });
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
      ['やり直す処理が分類でも識別でもない', PHOTO_ID, { step: 'name' }, 'やり直す処理の種類が無効です'],
      ['やり直す処理が文字列でない', PHOTO_ID, { step: 1 }, 'やり直す処理の種類が無効です'],
      ['手がかりが文字列でない', PHOTO_ID, { step: 'classify', hint: 123 }, '補足情報は文字列で指定してください'],
      ['手がかりが500文字を超える', PHOTO_ID, { step: 'classify', hint: 'あ'.repeat(501) }, '補足情報は500文字以内で指定してください'],
      // 場所（撮影地の地名。C-2）
      ['場所が文字列でない', PHOTO_ID, { step: 'classify', placeName: 123 }, '地名は文字列で指定してください'],
      ['場所が前後の空白を除いて100文字を超える', PHOTO_ID, { step: 'classify', placeName: ` ${'あ'.repeat(101)} ` }, '地名は100文字以内で指定してください'],
      // 検証の順序: 写真ID → ボディ → 処理の種類 → 手がかり
      ['写真IDも処理の種類も不正（写真IDの指摘が先）', 'bad', { step: 'name' }, '写真IDの形式が無効です'],
      ['処理の種類も手がかりも不正（処理の種類の指摘が先）', PHOTO_ID, { step: 'name', hint: 123 }, 'やり直す処理の種類が無効です']
    ];

    it('入力が正しくなければ、400で理由を返し、写真も変えずキューにも積まない', () => forEachCase(invalidCases, async (_case, photoId, body, message) => {
      cosmosBackend.documents.set(PHOTO_ID, classifiedPhoto());

      const response = await processPhotoRequestHandler(createRequest(photoId, body), mockContext);

      expect(response.status).toBe(400);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'INVALID_REQUEST', message } });
      expect(storedPhoto()).toEqual(classifiedPhoto());
      expect(queuedMessages()).toEqual([]);
    }));

    it('写真のカテゴリが図鑑の種類でなければ（other・null）、識別のやり直しは400で理由を返し、写真も変えずキューにも積まない', () => forEachCase([
      ['どの種類にも当てはまらない（other）', 'other'],
      ['まだ分類されていない（null）', null]
    ], async (_case, category) => {
      // 識別は図鑑の種類（植物・食べ物・風景）の写真だけ（05 §5.7 の 8）。分類のやり直しなら受け付ける
      cosmosBackend.documents.set(PHOTO_ID, classifiedPhoto({ category }));

      const response = await processPhotoRequestHandler(createRequest(PHOTO_ID, { step: 'identify' }), mockContext);

      expect(response.status).toBe(400);
      expect(response.jsonBody).toMatchObject({
        success: false,
        error: { code: 'INVALID_REQUEST', message: 'この写真は識別の対象ではありません' }
      });
      expect(storedPhoto()).toEqual(classifiedPhoto({ category }));
      expect(queuedMessages()).toEqual([]);
    }));

    it('識別のやり直しでも、写真が無ければ（カテゴリを見る前に）404で理由を返す', async () => {
      const response = await processPhotoRequestHandler(createRequest(PHOTO_ID, { step: 'identify' }), mockContext);

      expect(response.status).toBe(404);
      expect(response.jsonBody).toMatchObject({
        success: false,
        error: { code: 'PHOTO_NOT_FOUND', message: '指定された写真が見つかりません' }
      });
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

    it('データベースの書き込みで、データベースに接続できなければ503、それ以外の失敗は500で決まった文言を返す', () => forEachCase(databaseFailureCases('解析のやり直しの受付に失敗しました'), async (_case, error, status, code, message) => {
      cosmosBackend.documents.set(PHOTO_ID, classifiedPhoto());
      cosmosBackend.forcedPatchError = error;

      const response = await processPhotoRequestHandler(createRequest(PHOTO_ID, { step: 'classify' }), mockContext);

      expect(response.status).toBe(status);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code, message } });
      expect(storedPhoto()).toEqual(classifiedPhoto());
      expect(queuedMessages()).toEqual([]);
    }));

    it('識別のやり直しで、カテゴリを見るための写真の読み取りで、データベースに接続できなければ503、それ以外の失敗は500で決まった文言を返す', () => forEachCase(databaseFailureCases('解析のやり直しの受付に失敗しました'), async (_case, error, status, code, message) => {
      // 識別だけが書く前に写真を読む。読めないのを「写真が無い」（404）と取り違えない
      cosmosBackend.documents.set(PHOTO_ID, classifiedPhoto());
      cosmosBackend.forcedReadError = error;

      const response = await processPhotoRequestHandler(createRequest(PHOTO_ID, { step: 'identify' }), mockContext);

      expect(response.status).toBe(status);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code, message } });
      expect(storedPhoto()).toEqual(classifiedPhoto());
      expect(queuedMessages()).toEqual([]);
    }));
  });
});
