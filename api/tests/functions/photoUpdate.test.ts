import { HttpRequest, InvocationContext } from '@azure/functions';
import { CosmosClient } from '@azure/cosmos';
import { BlobServiceClient, generateBlobSASQueryParameters } from '@azure/storage-blob';
import { QueueClient } from '@azure/storage-queue';
import { updatePhotoHandler } from '../../src/functions/photoDetail';
import { PhotoDocument, PhotoTag } from '../../src/types/album';
import { FakeCosmosBackend, FakeCosmosDocument, createFakeContainer } from '../fakes/cosmos';
import { BlobEntry, FakeBlobBackend, TEST_BLOB_HOST, createFakeBlobServiceClient } from '../fakes/blob';
import { FakeQueueBackend, createFakeQueueClient, decodeQueueMessage } from '../fakes/queue';
import { COSMOS_SYSTEM_FIELDS, photoDocument } from '../helpers/albumDocuments';
import { databaseFailureCases } from '../helpers/databaseFailures';
import { forEachCase } from '../helpers/cases';

// 外部依存のみモック
jest.mock('@azure/cosmos');
// SAS の署名に使う関数は、このファイルで固定のトークンを返す形に差し替える(photoDetail.test.ts と同じ理由。
// 署名の中身は photos.test.ts が実 SDK のトークンで見ているので、ここでは「URL にトークンが付いて返る」ことを見る)
jest.mock('@azure/storage-blob', () => ({
  BlobServiceClient: { fromConnectionString: jest.fn() },
  BlobSASPermissions: jest.fn().mockImplementation(() => ({})),
  StorageSharedKeyCredential: jest.fn().mockImplementation(() => ({})),
  generateBlobSASQueryParameters: jest.fn()
}));
// カテゴリを植物に変えると、品種を調べるために解析のキューに積む
jest.mock('@azure/storage-queue', () => ({ QueueClient: jest.fn() }));

const MockedCosmosClient = CosmosClient as jest.MockedClass<typeof CosmosClient>;
const MockedQueueClient = QueueClient as jest.MockedClass<typeof QueueClient>;
const MockedBlobServiceClient = BlobServiceClient as jest.MockedClass<typeof BlobServiceClient>;
const mockedGenerateSas = generateBlobSASQueryParameters as jest.MockedFunction<
  typeof generateBlobSASQueryParameters
>;

const TEST_SAS_TOKEN = 'sv=2024-01-01&se=2030-01-01T00%3A00%3A00Z&sp=r&sig=testsignature';

// 写真の id(画像のバイト列の SHA-256。小文字16進 64 文字)。このファイルでは画像のバイト列は使わない
const PHOTO_ID = '45ae705277879f7f01d778f7c95a065bb0c06ab9936cf24307f375211fee13d1';

// タグ（名前・種類・位置・出どころ。04 §2）。種類・位置・出どころは既定の値にし、見たい項目だけを変える
const tag = (name: string, overrides: Record<string, unknown> = {}): PhotoTag => ({ name, kind: 'food', x: 0.5, y: 0.5, source: 'user', ...overrides });
// 個数 count のタグ(タグ1、タグ2、…)。個数の上限を境界で見るために使う
const tagsOf = (count: number) => Array.from({ length: count }, (_, i) => tag(`タグ${i + 1}`));

// 写真が属する旅行の id(UUID v4 の形)。写真を直すときに旅行は引かないので、旅行のドキュメントは置かない
const TRIP_ID = '123e4567-e89b-42d3-a456-426614174000';

// 更新した時刻。写真に保存してある updatedAt(2026-09-22)とは別の日にして、書き換わったことを見分ける
const UPDATED_AT = '2026-10-12T05:30:00.000Z';

// 時刻だけを固定する。他のタイマーまで偽物にすると非同期処理が止まりうる
const freezeNow = () =>
  jest.useFakeTimers({
    now: new Date(UPDATED_AT),
    doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'setTimeout', 'setInterval']
  });

const createUpdatePhotoRequestWithJson = (photoId: string, json: jest.Mock): HttpRequest =>
  ({
    method: 'PATCH',
    url: `https://func-snaplant.azurewebsites.net/api/photos/${photoId}?code=test-key`,
    query: new Map([['code', 'test-key']]),
    headers: new Map([['content-type', 'application/json']]),
    params: { photoId },
    json
  }) as any as HttpRequest;

const createUpdatePhotoRequest = (photoId: string, body: unknown): HttpRequest =>
  createUpdatePhotoRequestWithJson(photoId, jest.fn().mockResolvedValue(body));

/**
 * 保存済みの写真(サムネイルあり)。コメント・出どころ・カテゴリ・タグなど、更新の対象と対象外の項目に
 * 違う値を入れ、変わった項目と変わらない項目を見分ける。Cosmos のシステム項目も付ける
 */
const storedPhoto = (overrides: Partial<PhotoDocument> = {}): PhotoDocument =>
  ({
    ...photoDocument(PHOTO_ID, {
      tripId: TRIP_ID,
      category: 'food',
      tags: [tag('朝食'), tag('旅館')],
      comment: 'ホテルの朝食',
      commentSource: 'ai',
      processing: { state: 'done', step: null, attempts: 1, lastError: null, updatedAt: '2026-09-21T01:05:00.000Z' },
      uploadedAt: '2026-09-21T01:00:00.000Z',
      updatedAt: '2026-09-22T02:30:00.000Z',
      ...overrides
    }),
    ...COSMOS_SYSTEM_FIELDS
  }) as PhotoDocument;

describe('写真更新API', () => {
  let mockContext: InvocationContext;
  let cosmosBackend: FakeCosmosBackend<FakeCosmosDocument>;
  let blobBackend: FakeBlobBackend;
  let queueBackend: FakeQueueBackend;

  /** キューの名前ごとに、積まれたメッセージを読み戻したもの */
  const queuedMessages = (): Array<[string, unknown[]]> =>
    [...queueBackend.queues].map(([name, messages]) => [name, messages.map(decodeQueueMessage)]);

  beforeEach(() => {
    mockContext = { log: jest.fn() } as any;

    cosmosBackend = { documents: new Map() };
    const fakeContainer = createFakeContainer(cosmosBackend);
    MockedCosmosClient.mockImplementation(() => ({
      database: () => ({
        container: () => fakeContainer
      })
    } as unknown as CosmosClient));

    // 更新では Blob の中身は読まない(応答の URL を組み立てるために偽物のサービスクライアントが要る)
    blobBackend = { store: new Map<string, BlobEntry>(), forcedUploadError: null };
    MockedBlobServiceClient.fromConnectionString = jest
      .fn()
      .mockReturnValue(createFakeBlobServiceClient(blobBackend));

    // jest.fn() のままだと undefined を返し、.toString() で例外になって署名の経路が検証されない
    mockedGenerateSas.mockReturnValue({ toString: () => TEST_SAS_TOKEN } as any);

    queueBackend = { queues: new Map(), forcedSendError: null };
    MockedQueueClient.mockImplementation(((_connectionString: string, queueName: string) =>
      createFakeQueueClient(queueBackend, queueName)) as any);

    process.env.COSMOS_DB_ENDPOINT = 'https://test.documents.azure.com:443/';
    process.env.COSMOS_DB_KEY = 'test-key';
    process.env.COSMOS_DB_DATABASE = 'test-db';
    process.env.COSMOS_DB_ALBUM_CONTAINER = 'test-album';
    // ホストは TEST_BLOB_HOST(test.blob.core.windows.net)になる
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
    delete process.env.COSMOS_DB_ENDPOINT;
    delete process.env.COSMOS_DB_KEY;
    delete process.env.COSMOS_DB_DATABASE;
    delete process.env.COSMOS_DB_ALBUM_CONTAINER;
    delete process.env.STORAGE_CONNECTION_STRING;
    delete process.env.PHOTO_STORAGE_CONTAINER_NAME;
    delete process.env.PHOTO_SAS_EXPIRY_MINUTES;
    delete process.env.AzureWebJobsStorage;
    delete process.env.PHOTO_QUEUE_NAME;
  });

  it('写真のコメントを直すと、利用者のコメントとして保存され、表示用のURL付きの写真が返る', async () => {
    freezeNow();
    // コメントの無い写真。解析がまだ始まっていない(pending)が、直せることを兼ねて見る。
    // コメント以外の項目は、項目ごとに違う値を入れ、元のままであることを見分ける
    const photoFields: Omit<PhotoDocument, 'type' | 'blobName' | 'thumbnailBlobName'> = {
      id: PHOTO_ID,
      tripId: TRIP_ID,
      contentType: 'image/jpeg',
      fileSize: 1234567,
      takenAt: '2026-10-05T12:30:15',
      takenAtSource: 'exif',
      sortAt: '2026-10-05T12:30:15',
      location: { latitude: 43.7706, longitude: 142.365, placeName: '北海道旭川市', placeSource: 'device' },
      category: 'food',
      tags: [tag('旅館')],
      comment: null,
      commentSource: null,
      hint: 'ビュッフェ',
      classification: null,
      identification: null,
      processing: { state: 'pending', step: 'classify', attempts: 0, lastError: null, updatedAt: '2026-09-21T01:05:00.000Z' },
      uploadedAt: '2026-09-21T01:00:00.000Z',
      updatedAt: '2026-09-22T02:30:00.000Z'
    };
    const savedPhoto = {
      ...photoDocument(PHOTO_ID, {
        ...photoFields,
        blobName: `${PHOTO_ID}.jpg`,
        thumbnailBlobName: `${PHOTO_ID}.thumb.jpg`
      }),
      ...COSMOS_SYSTEM_FIELDS
    };
    cosmosBackend.documents.set(PHOTO_ID, savedPhoto);
    const request = createUpdatePhotoRequest(PHOTO_ID, { comment: '  夕食の懐石  ' });

    const response = await updatePhotoHandler(request, mockContext);

    // 応答の写真は、コメント(前後の空白を除く)・commentSource・updatedAt だけが変わり、タグ・カテゴリ・解析の状態は元のまま。
    // Blob 名・type・Cosmos のシステム項目は含まず、代わりに SAS 付きの URL が付く。完全一致で見る
    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({
      success: true,
      data: {
        photo: {
          ...photoFields,
          // カテゴリを手で決めた印。項目の無い（C-1 より前の）写真は null で返す
          categorySource: null,
          comment: '夕食の懐石',
          commentSource: 'user',
          updatedAt: UPDATED_AT,
          imageUrl: `https://${TEST_BLOB_HOST}/photos/${PHOTO_ID}.jpg?${TEST_SAS_TOKEN}`,
          thumbnailUrl: `https://${TEST_BLOB_HOST}/photos/${PHOTO_ID}.thumb.jpg?${TEST_SAS_TOKEN}`
        },
        urlExpiresAt: '2026-10-12T06:30:00.000Z'
      }
    });
    // 保存されたドキュメントも、同じ3項目だけが変わる。偽物の patch は Cosmos のシステム項目(_etag・_ts)を更新しないので、
    // それらが変わらないことは見ていない(実際の Cosmos は書くたびに更新する)
    expect(cosmosBackend.documents.get(PHOTO_ID)).toEqual({
      ...savedPhoto,
      comment: '夕食の懐石',
      commentSource: 'user',
      updatedAt: UPDATED_AT
    });
  });

  it('commentにnullを送るとコメントが消え、出どころもnullになる', async () => {
    freezeNow();
    const photo = storedPhoto({ comment: '夕食の懐石', commentSource: 'user' });
    cosmosBackend.documents.set(PHOTO_ID, photo);
    const request = createUpdatePhotoRequest(PHOTO_ID, { comment: null });

    const response = await updatePhotoHandler(request, mockContext);

    expect(response.status).toBe(200);
    const body = response.jsonBody as any;
    expect(body.data.photo.comment).toBeNull();
    expect(body.data.photo.commentSource).toBeNull();
    // 項目ごと消えず null になり、タグ・カテゴリ・解析の状態は元のまま
    expect(cosmosBackend.documents.get(PHOTO_ID)).toEqual({
      ...photo,
      comment: null,
      commentSource: null,
      updatedAt: UPDATED_AT
    });
  });

  it('空白だけのコメントは、nullと同じくコメントを消す', async () => {
    freezeNow();
    const photo = storedPhoto({ comment: '夕食の懐石', commentSource: 'user' });
    cosmosBackend.documents.set(PHOTO_ID, photo);
    const request = createUpdatePhotoRequest(PHOTO_ID, { comment: '   ' });

    const response = await updatePhotoHandler(request, mockContext);

    expect(response.status).toBe(200);
    const body = response.jsonBody as any;
    expect(body.data.photo.comment).toBeNull();
    expect(body.data.photo.commentSource).toBeNull();
    expect(cosmosBackend.documents.get(PHOTO_ID)).toEqual({
      ...photo,
      comment: null,
      commentSource: null,
      updatedAt: UPDATED_AT
    });
  });

  it('コメントの前後の U+0085（次の行）も空白として除く（アプリの trim と同じ。それだけならコメントを消す）', () => forEachCase<[string, string, string | null]>([
    ['前後にある', '\u0085夕食の懐石\u0085', '夕食の懐石'],
    ['それだけ', '\u0085', null]
  ], async (_label, comment, saved) => {
    cosmosBackend.documents.set(PHOTO_ID, storedPhoto({ comment: '朝ごはん', commentSource: 'user' }));

    const response = await updatePhotoHandler(createUpdatePhotoRequest(PHOTO_ID, { comment }), mockContext);

    expect(response.status).toBe(200);
    expect((cosmosBackend.documents.get(PHOTO_ID) as any).comment).toBe(saved);
  }));

  it('タグ（名前・種類・位置・出どころ）を送ると、元のタグは消えて送ったタグに置き換わる。名前の前後の空白を除き、出どころを省いたタグは利用者のものにし、ほかのキーは保存せず、カテゴリは変わらない', async () => {
    freezeNow();
    const photo = storedPhoto({ tags: [tag('朝食'), tag('旅館')], category: 'food' });
    cosmosBackend.documents.set(PHOTO_ID, photo);
    // 位置は画像の端（0 と 1）も置ける
    const request = createUpdatePhotoRequest(PHOTO_ID, {
      tags: [
        { name: '  夕食 ', kind: 'food', x: 0, y: 1, memo: '保存しない' },
        { name: '温泉', kind: 'landscape', x: 0.25, y: 0.75, source: 'ai' },
        { name: '紅葉', kind: 'plant', x: 0.5, y: 0.5, source: 'user' },
        { name: '箸置き', kind: 'other', x: 0.6, y: 0.4 }
      ]
    });

    const response = await updatePhotoHandler(request, mockContext);

    expect(response.status).toBe(200);
    const saved = [
      { name: '夕食', kind: 'food', x: 0, y: 1, source: 'user' },
      { name: '温泉', kind: 'landscape', x: 0.25, y: 0.75, source: 'ai' },
      { name: '紅葉', kind: 'plant', x: 0.5, y: 0.5, source: 'user' },
      { name: '箸置き', kind: 'other', x: 0.6, y: 0.4, source: 'user' }
    ];
    const body = response.jsonBody as any;
    expect(body.data.photo.tags).toEqual(saved);
    expect(body.data.photo.category).toBe('food');
    // タグだけを送ったときは、コメントとその出どころ(AI が書いたもの)に触らない
    expect(cosmosBackend.documents.get(PHOTO_ID)).toEqual({
      ...photo,
      tags: saved,
      updatedAt: UPDATED_AT
    });
  });

  it('C-4 より前に保存した、出どころの無いタグは、利用者のタグとして返す（04 §2）', async () => {
    freezeNow();
    cosmosBackend.documents.set(PHOTO_ID, storedPhoto({ tags: [{ name: '朝食', kind: 'food', x: 0.5, y: 0.5 }] }));

    const response = await updatePhotoHandler(createUpdatePhotoRequest(PHOTO_ID, { comment: '旅館' }), mockContext);

    expect(response.status).toBe(200);
    expect((response.jsonBody as any).data.photo.tags).toEqual([{ name: '朝食', kind: 'food', x: 0.5, y: 0.5, source: 'user' }]);
  });

  it('同じ名前のタグは1つにまとめず、送った順に全部残す（皿が2つなど。02 §5 #57）', async () => {
    freezeNow();
    cosmosBackend.documents.set(PHOTO_ID, storedPhoto());
    const tags = [tag('皿', { x: 0.2 }), tag('汁'), tag('皿', { x: 0.8 })];

    const response = await updatePhotoHandler(createUpdatePhotoRequest(PHOTO_ID, { tags }), mockContext);

    expect(response.status).toBe(200);
    expect((response.jsonBody as any).data.photo.tags).toEqual(tags);
    expect((cosmosBackend.documents.get(PHOTO_ID) as PhotoDocument).tags).toEqual(tags);
  });

  // 05 §5.6 の 1〜9 を、表の順に。どの行も、写真は保存済みで(404 で先に返らない)、何も変わらない。
  // 最後の 2 行は検証の順序の例(写真IDが先、コメントはタグより先)
  it('写真の更新で指定が正しくなければ、400で理由を返し、何も変えない', () => forEachCase([
    ['写真IDの形式が無効', 'abc', jest.fn().mockResolvedValue({ comment: '夕食' }), '写真IDの形式が無効です'],
    ['ボディがJSONとしてパースできない', PHOTO_ID, jest.fn().mockRejectedValue(new SyntaxError('Unexpected token')), 'リクエストボディの形式が無効です'],
    ['ボディがnull', PHOTO_ID, jest.fn().mockResolvedValue(null), 'リクエストボディが指定されていません'],
    ['commentもtagsも無い(空のオブジェクト)', PHOTO_ID, jest.fn().mockResolvedValue({}), '更新する項目が指定されていません'],
    ['commentもtagsも無い(関係ないキーだけ)', PHOTO_ID, jest.fn().mockResolvedValue({ hint: '夕食' }), '更新する項目が指定されていません'],
    ['commentが数値', PHOTO_ID, jest.fn().mockResolvedValue({ comment: 123 }), 'コメントは文字列で指定してください'],
    ['commentが配列', PHOTO_ID, jest.fn().mockResolvedValue({ comment: ['夕食'] }), 'コメントは文字列で指定してください'],
    ['commentが前後の空白を除いて501文字', PHOTO_ID, jest.fn().mockResolvedValue({ comment: ` ${'あ'.repeat(501)} ` }), 'コメントは500文字以内で指定してください'],
    ['tagsが文字列', PHOTO_ID, jest.fn().mockResolvedValue({ tags: '温泉' }), 'タグは配列で指定してください'],
    ['tagsが配列でないオブジェクト', PHOTO_ID, jest.fn().mockResolvedValue({ tags: { 0: tag('温泉') } }), 'タグは配列で指定してください'],
    ['tagsの要素が文字列（C-3a より前の形）', PHOTO_ID, jest.fn().mockResolvedValue({ tags: [tag('温泉'), '旅館'] }), 'タグの形式が無効です'],
    ['tagsの要素がnull', PHOTO_ID, jest.fn().mockResolvedValue({ tags: [tag('温泉'), null] }), 'タグの形式が無効です'],
    ['tagsの要素が配列', PHOTO_ID, jest.fn().mockResolvedValue({ tags: [[tag('温泉')]] }), 'タグの形式が無効です'],
    ['タグの名前が無い', PHOTO_ID, jest.fn().mockResolvedValue({ tags: [{ kind: 'food', x: 0.5, y: 0.5 }] }), 'タグの名前は1〜30文字で指定してください'],
    ['タグの名前が数値', PHOTO_ID, jest.fn().mockResolvedValue({ tags: [{ name: 123, kind: 'food', x: 0.5, y: 0.5 }] }), 'タグの名前は1〜30文字で指定してください'],
    ['タグの名前が空の文字列', PHOTO_ID, jest.fn().mockResolvedValue({ tags: [tag('温泉'), tag('')] }), 'タグの名前は1〜30文字で指定してください'],
    ['タグの名前が空白だけ', PHOTO_ID, jest.fn().mockResolvedValue({ tags: [tag('   ')] }), 'タグの名前は1〜30文字で指定してください'],
    ['タグの名前が前後の空白を除いて31文字', PHOTO_ID, jest.fn().mockResolvedValue({ tags: [tag(` ${'あ'.repeat(31)} `)] }), 'タグの名前は1〜30文字で指定してください'],
    // 出どころ（C-4）は名前より先に見る（05 §5.6）
    ['タグの出どころが ai・user のどちらでもない', PHOTO_ID, jest.fn().mockResolvedValue({ tags: [tag('温泉', { source: 'AI' })] }), 'タグの形式が無効です'],
    ['タグの出どころが null', PHOTO_ID, jest.fn().mockResolvedValue({ tags: [tag('温泉', { source: null })] }), 'タグの形式が無効です'],
    ['1つのタグで出どころと名前が無効(出どころの理由を返す)', PHOTO_ID, jest.fn().mockResolvedValue({ tags: [tag('', { source: 'robot' })] }), 'タグの形式が無効です'],
    ['タグの種類が分類の種類に無い', PHOTO_ID, jest.fn().mockResolvedValue({ tags: [tag('温泉', { kind: 'animal' })] }), 'タグの種類が無効です'],
    ['タグの種類が無い', PHOTO_ID, jest.fn().mockResolvedValue({ tags: [{ name: '温泉', x: 0.5, y: 0.5 }] }), 'タグの種類が無効です'],
    ['タグの種類の大文字小文字が違う', PHOTO_ID, jest.fn().mockResolvedValue({ tags: [tag('温泉', { kind: 'Food' })] }), 'タグの種類が無効です'],
    ['タグの x が 1 を超える', PHOTO_ID, jest.fn().mockResolvedValue({ tags: [tag('温泉', { x: 1.01 })] }), 'タグの位置が無効です'],
    ['タグの y が負', PHOTO_ID, jest.fn().mockResolvedValue({ tags: [tag('温泉', { y: -0.01 })] }), 'タグの位置が無効です'],
    ['タグの x が数の文字列', PHOTO_ID, jest.fn().mockResolvedValue({ tags: [tag('温泉', { x: '0.5' })] }), 'タグの位置が無効です'],
    ['タグの y が null', PHOTO_ID, jest.fn().mockResolvedValue({ tags: [tag('温泉', { y: null })] }), 'タグの位置が無効です'],
    ['タグの y が無い', PHOTO_ID, jest.fn().mockResolvedValue({ tags: [{ name: '温泉', kind: 'food', x: 0.5 }] }), 'タグの位置が無効です'],
    // 上限は同じ名前のタグも数える（同じ名前を除かない。02 §5 #57）
    ['tagsが同じ名前を含めて21個', PHOTO_ID, jest.fn().mockResolvedValue({ tags: [...tagsOf(20), tag('タグ1')] }), 'タグは20個までです'],
    // タグの中の順（要素ごとに先頭から。1つの要素の中では 8 → 8.5（出どころ）→ 9 → 9.1 → 9.2。05 §5.6。8.5 と 9 の順は上の出どころの行で見る）
    ['1つのタグで名前・種類・位置が全部無効(名前の理由を返す)', PHOTO_ID, jest.fn().mockResolvedValue({ tags: [{ name: '', kind: 'animal', x: 5, y: 0.5 }] }), 'タグの名前は1〜30文字で指定してください'],
    ['1つのタグで種類と位置が無効(種類の理由を返す)', PHOTO_ID, jest.fn().mockResolvedValue({ tags: [tag('温泉', { kind: 'animal', x: 5 })] }), 'タグの種類が無効です'],
    ['1つ目のタグの種類が無効で2つ目が文字列(先の要素の理由を返す)', PHOTO_ID, jest.fn().mockResolvedValue({ tags: [tag('温泉', { kind: 'animal' }), '旅館'] }), 'タグの種類が無効です'],
    // 数は要素の中身より先に見る（大きな配列を、全部の要素を確かめてから断らない）
    ['tagsが21個で、中に形式の無効なものがある', PHOTO_ID, jest.fn().mockResolvedValue({ tags: [...tagsOf(20), null] }), 'タグは20個までです'],
    // カテゴリは分類の種類（plant・food・landscape・other）のどれか。大文字小文字も区別する
    ['categoryが分類の種類に無い', PHOTO_ID, jest.fn().mockResolvedValue({ category: 'animal' }), 'カテゴリが無効です'],
    ['categoryの大文字小文字が違う', PHOTO_ID, jest.fn().mockResolvedValue({ category: 'Plant' }), 'カテゴリが無効です'],
    ['categoryがnull', PHOTO_ID, jest.fn().mockResolvedValue({ category: null }), 'カテゴリが無効です'],
    ['categoryが数値', PHOTO_ID, jest.fn().mockResolvedValue({ category: 1 }), 'カテゴリが無効です'],
    // 撮影日時は写真の送信と同じく、タイムゾーン無しの実在する日時（02 §5 #59。05 §5.6 の 9.7「写真の送信と同じ検証」）。
    // 形式と実在の全ケースは写真の送信の入口（photos.test.ts の「13: takenAt の形式と実在」）で通し、ここでは確かめを通ることだけを見る
    ['takenAtが実在しない日付', PHOTO_ID, jest.fn().mockResolvedValue({ takenAt: '2026-02-30T12:00:00' }), '撮影日時の形式が無効です'],
    ['takenAtが数値', PHOTO_ID, jest.fn().mockResolvedValue({ takenAt: 20261005 }), '撮影日時の形式が無効です'],
    // 文字列に直すと正しい日時になる値も、文字列でなければ断る（照合は値を文字列に直すので、文字列かは別に確かめる）
    ['takenAtが配列（文字列に直すと正しい日時）', PHOTO_ID, jest.fn().mockResolvedValue({ takenAt: ['2026-10-05T12:00:00'] }), '撮影日時の形式が無効です'],
    ['写真IDもボディも無効(写真IDの理由を返す)', 'abc', jest.fn().mockRejectedValue(new SyntaxError('Unexpected token')), '写真IDの形式が無効です'],
    ['commentもtagsも無効(commentの理由を返す)', PHOTO_ID, jest.fn().mockResolvedValue({ comment: 123, tags: '温泉' }), 'コメントは文字列で指定してください']
  ], async (_case, photoId, json, message) => {
    cosmosBackend.documents.set(PHOTO_ID, storedPhoto());
    const before = structuredClone(cosmosBackend.documents);
    const request = createUpdatePhotoRequestWithJson(photoId, json);

    const response = await updatePhotoHandler(request, mockContext);

    expect(response.status).toBe(400);
    const body = response.jsonBody as any;
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INVALID_REQUEST');
    expect(body.error.message).toBe(message);
    expect(cosmosBackend.documents).toEqual(before);
  }));

  // 上限は前後の空白を除いた後の文字数で数える。空白を含めると上限を超えるものが、除いて上限ちょうどなら通る
  it('コメントが前後の空白を除いて500文字なら、空白を含めて500文字を超えていても保存できる', async () => {
    freezeNow();
    cosmosBackend.documents.set(PHOTO_ID, storedPhoto());
    const comment = 'あ'.repeat(500);
    const request = createUpdatePhotoRequest(PHOTO_ID, { comment: `  ${comment}  ` });

    const response = await updatePhotoHandler(request, mockContext);

    expect(response.status).toBe(200);
    expect((cosmosBackend.documents.get(PHOTO_ID) as PhotoDocument).comment).toBe(comment);
  });

  it('タグの名前が前後の空白を除いて30文字なら、空白を含めて30文字を超えていても保存できる', async () => {
    freezeNow();
    cosmosBackend.documents.set(PHOTO_ID, storedPhoto());
    const name = 'あ'.repeat(30);
    const request = createUpdatePhotoRequest(PHOTO_ID, { tags: [tag(` ${name} `)] });

    const response = await updatePhotoHandler(request, mockContext);

    expect(response.status).toBe(200);
    expect((cosmosBackend.documents.get(PHOTO_ID) as PhotoDocument).tags).toEqual([tag(name)]);
  });

  // 家族の絵文字は見た目は1文字、UTF-16 では8単位
  it('コメントとタグの名前の文字数は見た目の1文字で数え、絵文字でちょうど上限なら保存できる', async () => {
    freezeNow();
    cosmosBackend.documents.set(PHOTO_ID, storedPhoto());
    const comment = '👨‍👩‍👧'.repeat(500);
    const name = '👨‍👩‍👧'.repeat(30);

    const response = await updatePhotoHandler(createUpdatePhotoRequest(PHOTO_ID, { comment, tags: [tag(name)] }), mockContext);

    expect(response.status).toBe(200);
    expect(cosmosBackend.documents.get(PHOTO_ID)).toMatchObject({ comment, tags: [tag(name)] });
  });

  it('結合文字を重ねて見た目は1文字でも、とても長い文は上限を超えたとして 400 で何も変えない（文字数の規則はほかの欄と同じ関数）', async () => {
    // 見た目の1文字だけで数えると、1文字に結合文字をいくらでも重ねられ、文の大きさの上限が無くなる
    cosmosBackend.documents.set(PHOTO_ID, storedPhoto());
    const before = cosmosBackend.documents.get(PHOTO_ID);

    // UTF-16 の長さの上限は文字数 × 32（500 文字なら 16,000 単位）。a と結合文字で 16,001 単位
    const response = await updatePhotoHandler(createUpdatePhotoRequest(PHOTO_ID, { comment: `a${'\u0301'.repeat(16_000)}` }), mockContext);

    expect(response.status).toBe(400);
    expect((response.jsonBody as any).error.message).toBe('コメントは500文字以内で指定してください');
    expect(cosmosBackend.documents.get(PHOTO_ID)).toEqual(before);
  });

  it('UTF-16 の長さがちょうど上限（文字数 × 32）なら保存できる', async () => {
    // 1文字が長い絵文字（肌の色を付けた家族の絵文字は見た目は1文字、UTF-16 では19単位）も、上限の文字数まで並べられるように余裕を取っている
    freezeNow();
    cosmosBackend.documents.set(PHOTO_ID, storedPhoto());
    const comment = `a${'\u0301'.repeat(15_999)}`;

    const response = await updatePhotoHandler(createUpdatePhotoRequest(PHOTO_ID, { comment }), mockContext);

    expect(response.status).toBe(200);
    expect((cosmosBackend.documents.get(PHOTO_ID) as PhotoDocument).comment).toBe(comment);
  });

  it('タグの名前の前後の U+0085（次の行）も空白として除く（アプリの trim と同じ）', async () => {
    freezeNow();
    cosmosBackend.documents.set(PHOTO_ID, storedPhoto());
    const request = createUpdatePhotoRequest(PHOTO_ID, { tags: [tag('\u0085温泉\u0085')] });

    const response = await updatePhotoHandler(request, mockContext);

    expect(response.status).toBe(200);
    expect((cosmosBackend.documents.get(PHOTO_ID) as PhotoDocument).tags).toEqual([tag('温泉')]);
  });

  it('コメントとタグを同時に送ると、両方が保存される', async () => {
    freezeNow();
    const photo = storedPhoto({ tags: [tag('朝食'), tag('旅館')], comment: 'ホテルの朝食', commentSource: 'ai' });
    cosmosBackend.documents.set(PHOTO_ID, photo);
    const request = createUpdatePhotoRequest(PHOTO_ID, { comment: '夕食の懐石', tags: [tag('夕食'), tag('温泉')] });

    const response = await updatePhotoHandler(request, mockContext);

    expect(response.status).toBe(200);
    const body = response.jsonBody as any;
    expect(body.data.photo.comment).toBe('夕食の懐石');
    expect(body.data.photo.tags).toEqual([tag('夕食'), tag('温泉')]);
    expect(cosmosBackend.documents.get(PHOTO_ID)).toEqual({
      ...photo,
      comment: '夕食の懐石',
      commentSource: 'user',
      tags: [tag('夕食'), tag('温泉')],
      updatedAt: UPDATED_AT
    });
  });

  it('tagsに空の配列を送ると、タグが全部消え、コメントには触らない', async () => {
    freezeNow();
    const photo = storedPhoto({ tags: [tag('朝食'), tag('旅館')] });
    cosmosBackend.documents.set(PHOTO_ID, photo);
    const request = createUpdatePhotoRequest(PHOTO_ID, { tags: [] });

    const response = await updatePhotoHandler(request, mockContext);

    expect(response.status).toBe(200);
    const body = response.jsonBody as any;
    expect(body.data.photo.tags).toEqual([]);
    expect(cosmosBackend.documents.get(PHOTO_ID)).toEqual({ ...photo, tags: [], updatedAt: UPDATED_AT });
  });

  // 保存先(Blob Storage)の設定は応答の URL を作るために要る。足りないまま写真を書き換えると、
  // 書き換えたのに 500 を返すことになるので、書き換える前に失敗させる。AccountKey が無い接続文字列で再現する
  it('写真の保存先の設定が足りなければ、写真を書き換えずに500で返る', async () => {
    process.env.STORAGE_CONNECTION_STRING =
      'DefaultEndpointsProtocol=https;AccountName=test;EndpointSuffix=core.windows.net';
    cosmosBackend.documents.set(PHOTO_ID, storedPhoto());
    const before = structuredClone(cosmosBackend.documents);
    const request = createUpdatePhotoRequest(PHOTO_ID, { comment: '夕食の懐石' });

    const response = await updatePhotoHandler(request, mockContext);

    expect(response.status).toBe(500);
    const body = response.jsonBody as any;
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe('写真の更新に失敗しました');
    expect(cosmosBackend.documents).toEqual(before);
  });

  it('タグがちょうど20個なら保存できる', async () => {
    freezeNow();
    cosmosBackend.documents.set(PHOTO_ID, storedPhoto());
    const request = createUpdatePhotoRequest(PHOTO_ID, { tags: tagsOf(20) });

    const response = await updatePhotoHandler(request, mockContext);

    expect(response.status).toBe(200);
    expect((cosmosBackend.documents.get(PHOTO_ID) as PhotoDocument).tags).toEqual(tagsOf(20));
  });

  describe('カテゴリを手で直す（02 §5 #53）', () => {
    /** 識別の済んだ写真の識別の結果（中身は見ない。消えるか残るかだけを見る） */
    const identification = (kind: string) => ({
      kind,
      matchesKind: true,
      name: '名前',
      confidence: 80,
      description: null,
      characteristics: null,
      attributes: {},
      reason: null,
      model: 'gpt-6-luna',
      at: '2026-09-21T01:06:00.000Z'
    });

    it('植物に変えると、手で決めたカテゴリとして保存し、前の識別と AI が書いたコメントを消して、品種を調べる待ちにしてキューに積む', async () => {
      // AI のコメントは前のカテゴリで書いたもので、新しいカテゴリの写真には合わない（植物なら識別が書き直す）
      freezeNow();
      const photo = storedPhoto({ category: 'food', identification: identification('food') });
      cosmosBackend.documents.set(PHOTO_ID, photo);

      const response = await updatePhotoHandler(createUpdatePhotoRequest(PHOTO_ID, { category: 'plant' }), mockContext);

      expect(response.status).toBe(200);
      expect((response.jsonBody as any).data.photo).toMatchObject({
        category: 'plant',
        categorySource: 'user',
        identification: null,
        comment: null,
        commentSource: null
      });
      expect(cosmosBackend.documents.get(PHOTO_ID)).toEqual({
        ...photo,
        category: 'plant',
        categorySource: 'user',
        identification: null,
        comment: null,
        commentSource: null,
        processing: { state: 'pending', step: 'identify', attempts: 0, lastError: null, updatedAt: UPDATED_AT },
        updatedAt: UPDATED_AT
      });
      expect(queuedMessages()).toEqual([['photo-processing', [{ photoId: PHOTO_ID }]]]);
    });

    it('自動で調べない種類（食べ物）に変えると、前の識別と AI が書いたコメントを消して済みにし、キューに積まない', async () => {
      // 植物から変えると、調べた品種は消え、図鑑から外れる
      freezeNow();
      const photo = storedPhoto({ category: 'plant', identification: identification('plant') });
      cosmosBackend.documents.set(PHOTO_ID, photo);

      const response = await updatePhotoHandler(createUpdatePhotoRequest(PHOTO_ID, { category: 'food' }), mockContext);

      expect(response.status).toBe(200);
      expect(cosmosBackend.documents.get(PHOTO_ID)).toEqual({
        ...photo,
        category: 'food',
        categorySource: 'user',
        identification: null,
        comment: null,
        commentSource: null,
        processing: { state: 'done', step: 'classify', attempts: 0, lastError: null, updatedAt: UPDATED_AT },
        updatedAt: UPDATED_AT
      });
      expect(queuedMessages()).toEqual([]);
    });

    it('利用者が書いたコメントは、カテゴリを変えても残す', async () => {
      const photo = storedPhoto({ category: 'plant', comment: '庭で見た花', commentSource: 'user' });
      cosmosBackend.documents.set(PHOTO_ID, photo);

      await updatePhotoHandler(createUpdatePhotoRequest(PHOTO_ID, { category: 'food' }), mockContext);

      expect(cosmosBackend.documents.get(PHOTO_ID)).toMatchObject({ category: 'food', comment: '庭で見た花', commentSource: 'user' });
    });

    // カテゴリは写真を読んでから書くので、その間に他の操作がコメントを書くことがある。消すかどうかは書くときのコメントで決める
    it('写真を読んだ後に利用者がコメントを書いていたら、カテゴリを変えてもそのコメントは残す', async () => {
      cosmosBackend.documents.set(PHOTO_ID, storedPhoto({ category: 'plant' }));
      cosmosBackend.beforePatch = () => {
        cosmosBackend.beforePatch = undefined;
        Object.assign(cosmosBackend.documents.get(PHOTO_ID)!, { comment: '庭で見た花', commentSource: 'user' });
      };

      const response = await updatePhotoHandler(createUpdatePhotoRequest(PHOTO_ID, { category: 'food' }), mockContext);

      expect(response.status).toBe(200);
      expect((response.jsonBody as any).data.photo).toMatchObject({ category: 'food', comment: '庭で見た花', commentSource: 'user' });
      expect(cosmosBackend.documents.get(PHOTO_ID)).toMatchObject({ category: 'food', comment: '庭で見た花', commentSource: 'user' });
    });

    it('写真を読んだ後に AI がコメントを書いていたら、カテゴリを変えるとそのコメントも消す', async () => {
      // 識別中の写真を食べ物に変えると、識別の担当が書いた品種のコメントが食べ物の写真に残り続ける（食べ物には AI が書き直さない）
      cosmosBackend.documents.set(PHOTO_ID, storedPhoto({ category: 'plant', comment: null, commentSource: null }));
      cosmosBackend.beforePatch = () => {
        cosmosBackend.beforePatch = undefined;
        Object.assign(cosmosBackend.documents.get(PHOTO_ID)!, { comment: 'サクラの花', commentSource: 'ai' });
      };

      const response = await updatePhotoHandler(createUpdatePhotoRequest(PHOTO_ID, { category: 'food' }), mockContext);

      expect(response.status).toBe(200);
      expect((response.jsonBody as any).data.photo).toMatchObject({ category: 'food', comment: null, commentSource: null });
      expect(cosmosBackend.documents.get(PHOTO_ID)).toMatchObject({ category: 'food', comment: null, commentSource: null });
    });

    it('書く直前にコメントが書き換わるのが3回続いたら、写真を書き換えずに500で返る', async () => {
      // 読み直すたびに、書く直前で AI と利用者のコメントが入れ替わる
      cosmosBackend.documents.set(PHOTO_ID, storedPhoto({ category: 'plant' }));
      cosmosBackend.beforePatch = () => {
        const doc = cosmosBackend.documents.get(PHOTO_ID) as PhotoDocument;
        Object.assign(doc, doc.commentSource === 'ai' ? { comment: '庭で見た花', commentSource: 'user' } : { comment: 'サクラの花', commentSource: 'ai' });
      };

      const response = await updatePhotoHandler(createUpdatePhotoRequest(PHOTO_ID, { category: 'food' }), mockContext);

      expect(response.status).toBe(500);
      expect((response.jsonBody as any).error.code).toBe('INTERNAL_ERROR');
      expect((response.jsonBody as any).error.message).toBe('写真の更新に失敗しました');
      // 手で決めた印も、解析の状態も書かれていない（コメントは書く直前の入れ替えのまま）
      expect(cosmosBackend.documents.get(PHOTO_ID)).toMatchObject({ category: 'plant', processing: storedPhoto().processing });
      expect((cosmosBackend.documents.get(PHOTO_ID) as PhotoDocument).categorySource).toBeUndefined();
    });

    it('分類に失敗した写真（カテゴリ無し）にも、カテゴリを手で決められる（失敗は済みになる）', async () => {
      freezeNow();
      const photo = storedPhoto({
        category: null,
        processing: { state: 'failed', step: 'classify', attempts: 3, lastError: 'openai', updatedAt: '2026-09-21T01:05:00.000Z' }
      });
      cosmosBackend.documents.set(PHOTO_ID, photo);

      await updatePhotoHandler(createUpdatePhotoRequest(PHOTO_ID, { category: 'other' }), mockContext);

      expect(cosmosBackend.documents.get(PHOTO_ID)).toMatchObject({
        category: 'other',
        categorySource: 'user',
        processing: { state: 'done', step: 'classify', attempts: 0, lastError: null, updatedAt: UPDATED_AT }
      });
      expect(queuedMessages()).toEqual([]);
    });

    it('今と同じカテゴリを送ると、手で決めた印だけを付け、識別と解析の状態は残し、キューに積まない', async () => {
      freezeNow();
      const photo = storedPhoto({ category: 'plant', identification: identification('plant') });
      cosmosBackend.documents.set(PHOTO_ID, photo);

      await updatePhotoHandler(createUpdatePhotoRequest(PHOTO_ID, { category: 'plant' }), mockContext);

      expect(cosmosBackend.documents.get(PHOTO_ID)).toEqual({ ...photo, categorySource: 'user', updatedAt: UPDATED_AT });
      expect(queuedMessages()).toEqual([]);
    });

    // queuedMessages() は行をまたいで溜まるので、forEachCase ではなく it.each で行ごとに置き直す
    // 分類に失敗した写真も、分類が済んでいない（同じカテゴリを手で決めると失敗から出る）
    it.each(['pending', 'classifying', 'failed'] as const)('分類を待っている・している・失敗した（%s）写真に今と同じカテゴリを送っても、分類を止めて手で決めたカテゴリにし、AI が書いたコメントを消す', async (state) => {
      // 分類を止めないと、後で AI の分類がカテゴリを書き換え、手で決めたものが消える（02 §5 #53）
      freezeNow();
      const photo = storedPhoto({
        category: 'plant',
        identification: identification('plant'),
        processing: { state, step: 'classify', attempts: 0, lastError: null, updatedAt: '2026-09-21T01:05:00.000Z' }
      });
      cosmosBackend.documents.set(PHOTO_ID, photo);

      await updatePhotoHandler(createUpdatePhotoRequest(PHOTO_ID, { category: 'plant' }), mockContext);

      expect(cosmosBackend.documents.get(PHOTO_ID)).toMatchObject({
        category: 'plant',
        categorySource: 'user',
        identification: null,
        // storedPhoto のコメントは AI が書いたもの。分類を止めるときも、カテゴリを変えたときと同じく消す
        comment: null,
        commentSource: null,
        processing: { state: 'pending', step: 'identify', attempts: 0, lastError: null, updatedAt: UPDATED_AT }
      });
      expect(queuedMessages()).toEqual([['photo-processing', [{ photoId: PHOTO_ID }]]]);
    });
  });

  // カテゴリは書く前に今の写真を読む別の経路なので、その経路の 404 も見る
  it.each([
    ['コメント', { comment: '夕食の懐石' }],
    ['カテゴリ', { category: 'plant' }]
  ])('更新する写真が無いと、404で理由を返し、何も変えない（%sの更新）', async (_case, requestBody) => {
    // 形式は正しいが、その id の写真は無い。別の写真は保存済みで、patch が誤って作ったり書き換えたりしないことも見る
    const otherPhotoId = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
    cosmosBackend.documents.set(otherPhotoId, storedPhoto({ id: otherPhotoId }));
    const before = structuredClone(cosmosBackend.documents);
    const request = createUpdatePhotoRequest(PHOTO_ID, requestBody);

    const response = await updatePhotoHandler(request, mockContext);

    expect(response.status).toBe(404);
    const body = response.jsonBody as any;
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('PHOTO_NOT_FOUND');
    expect(body.error.message).toBe('指定された写真が見つかりません');
    expect(cosmosBackend.documents).toEqual(before);
  });

  describe('撮影日時を手で付ける（02 §5 #59）', () => {
    // 行ごとに写真を置き直す（前の行の書き込みを持ち越さない）
    it('撮影日時を付ける・直すと、撮影日時と手で付けた印と並びの日時を書いて返し、ほかの項目には触らない', () => forEachCase<[string, Partial<PhotoDocument>, string]>([
      ['撮影日時の無い写真に付ける', { takenAt: null, takenAtSource: 'none', sortAt: '2026-09-21T10:00:00' }, '2026-10-05T12:00:00'],
      ['手で付けた撮影日時を直す', { takenAt: '2026-10-05T12:00:00', takenAtSource: 'user', sortAt: '2026-10-05T12:00:00' }, '2026-10-06T08:30:00']
    ], async (_case, current, takenAt) => {
      freezeNow();
      const photo = storedPhoto(current);
      cosmosBackend.documents.set(PHOTO_ID, photo);

      const response = await updatePhotoHandler(createUpdatePhotoRequest(PHOTO_ID, { takenAt }), mockContext);

      expect(response.status).toBe(200);
      const returned = (response.jsonBody as any).data.photo;
      expect([returned.takenAt, returned.takenAtSource]).toEqual([takenAt, 'user']);
      expect(cosmosBackend.documents.get(PHOTO_ID)).toEqual({ ...photo, takenAt, takenAtSource: 'user', sortAt: takenAt, updatedAt: UPDATED_AT });
    }));

    it('takenAt に null を送ると、撮影日時なしにして、並びの日時を送った日時（日本時間）に戻す', () => forEachCase<[string, Partial<PhotoDocument>]>([
      ['手で付けた撮影日時を消す', { takenAt: '2026-10-05T12:00:00', takenAtSource: 'user', sortAt: '2026-10-05T12:00:00' }],
      // 書く値は今と同じでも断らない（05 §5.6 の takenAt の項目）
      ['撮影日時の無い写真に null を送る', { takenAt: null, takenAtSource: 'none', sortAt: '2026-09-21T10:00:00' }]
    ], async (_case, current) => {
      // 送った日時 2026-09-21T01:00:00Z は、日本時間で 2026-09-21T10:00:00
      freezeNow();
      const photo = storedPhoto(current);
      cosmosBackend.documents.set(PHOTO_ID, photo);

      const response = await updatePhotoHandler(createUpdatePhotoRequest(PHOTO_ID, { takenAt: null }), mockContext);

      expect(response.status).toBe(200);
      const returned = (response.jsonBody as any).data.photo;
      expect([returned.takenAt, returned.takenAtSource]).toEqual([null, 'none']);
      expect(cosmosBackend.documents.get(PHOTO_ID)).toEqual({ ...photo, takenAt: null, takenAtSource: 'none', sortAt: '2026-09-21T10:00:00', updatedAt: UPDATED_AT });
    }));

    it('カメラが記録した撮影日時の写真には、409 で断って何も変えない', () => forEachCase<[string, string | null]>([
      ['日時を変える', '2026-10-06T08:30:00'],
      ['日時を消す', null]
    ], async (_case, takenAt) => {
      cosmosBackend.documents.set(PHOTO_ID, storedPhoto({ takenAt: '2026-10-05T07:58:00', takenAtSource: 'exif', sortAt: '2026-10-05T07:58:00' }));
      const before = structuredClone(cosmosBackend.documents);

      const response = await updatePhotoHandler(createUpdatePhotoRequest(PHOTO_ID, { takenAt }), mockContext);

      expect(response.status).toBe(409);
      const body = response.jsonBody as any;
      expect(body.error.code).toBe('TAKEN_AT_FROM_CAMERA');
      expect(body.error.message).toBe('カメラが記録した撮影日時は変えられません');
      expect(cosmosBackend.documents).toEqual(before);
    }));
  });

  // データベースの失敗の分類(接続できない障害は503、それ以外は500で message は固定)を、写真の更新(patch)で確かめる
  it('写真の更新で、データベースに接続できなければ503、それ以外の失敗は500で決まった文言を返す', () => forEachCase(databaseFailureCases('写真の更新に失敗しました'), async (_case, error, status, code, message) => {
    // 形式が正しい要求で、写真もある(検証や404で先に返らず、patch まで進む)
    cosmosBackend.documents.set(PHOTO_ID, storedPhoto());
    const before = structuredClone(cosmosBackend.documents);
    cosmosBackend.forcedPatchError = error;
    const request = createUpdatePhotoRequest(PHOTO_ID, { comment: '夕食の懐石' });

    const response = await updatePhotoHandler(request, mockContext);

    expect(response.status).toBe(status);
    const body = response.jsonBody as any;
    expect(body.success).toBe(false);
    expect(body.error.code).toBe(code);
    expect(body.error.message).toBe(message);
    expect(cosmosBackend.documents).toEqual(before);
  }));
});
