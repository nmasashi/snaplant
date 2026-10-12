import { HttpRequest, InvocationContext } from '@azure/functions';
import { CosmosClient } from '@azure/cosmos';
import { BlobServiceClient, generateBlobSASQueryParameters } from '@azure/storage-blob';
import { updatePhotoHandler } from '../../src/functions/photoDetail';
import { PhotoDocument } from '../../src/types/album';
import { FakeCosmosBackend, FakeCosmosDocument, createFakeContainer } from '../fakes/cosmos';
import { BlobEntry, FakeBlobBackend, TEST_BLOB_HOST, createFakeBlobServiceClient } from '../fakes/blob';
import { COSMOS_SYSTEM_FIELDS, photoDocument } from '../helpers/albumDocuments';
import { databaseFailureCases } from '../helpers/databaseFailures';

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

const MockedCosmosClient = CosmosClient as jest.MockedClass<typeof CosmosClient>;
const MockedBlobServiceClient = BlobServiceClient as jest.MockedClass<typeof BlobServiceClient>;
const mockedGenerateSas = generateBlobSASQueryParameters as jest.MockedFunction<
  typeof generateBlobSASQueryParameters
>;

const TEST_SAS_TOKEN = 'sv=2024-01-01&se=2030-01-01T00%3A00%3A00Z&sp=r&sig=testsignature';

// 写真の id(画像のバイト列の SHA-256。小文字16進 64 文字)。このファイルでは画像のバイト列は使わない
const PHOTO_ID = '45ae705277879f7f01d778f7c95a065bb0c06ab9936cf24307f375211fee13d1';

// 重複しない個数 count のタグ(タグ1、タグ2、…)。個数の上限を境界で見るために使う
const distinctTags = (count: number): string[] => Array.from({ length: count }, (_, i) => `タグ${i + 1}`);

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
      tags: ['朝食', '旅館'],
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

    process.env.COSMOS_DB_ENDPOINT = 'https://test.documents.azure.com:443/';
    process.env.COSMOS_DB_KEY = 'test-key';
    process.env.COSMOS_DB_DATABASE = 'test-db';
    process.env.COSMOS_DB_ALBUM_CONTAINER = 'test-album';
    // ホストは TEST_BLOB_HOST(test.blob.core.windows.net)になる
    process.env.STORAGE_CONNECTION_STRING =
      'DefaultEndpointsProtocol=https;AccountName=test;AccountKey=testkey==;EndpointSuffix=core.windows.net';
    process.env.PHOTO_STORAGE_CONTAINER_NAME = 'photos';
    process.env.PHOTO_SAS_EXPIRY_MINUTES = '60';
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
      tags: ['旅館'],
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
          comment: '夕食の懐石',
          commentSource: 'user',
          updatedAt: UPDATED_AT,
          imageUrl: `https://${TEST_BLOB_HOST}/photos/${PHOTO_ID}.jpg?${TEST_SAS_TOKEN}`,
          thumbnailUrl: `https://${TEST_BLOB_HOST}/photos/${PHOTO_ID}.thumb.jpg?${TEST_SAS_TOKEN}`
        },
        urlExpiresAt: '2026-10-12T06:30:00.000Z'
      }
    });
    // 保存されたドキュメントも、同じ3項目だけが変わる
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

  it('タグを送ると、元のタグは消えて送ったタグに置き換わり、カテゴリは変わらない', async () => {
    freezeNow();
    const photo = storedPhoto({ tags: ['朝食', '旅館'], category: 'food' });
    cosmosBackend.documents.set(PHOTO_ID, photo);
    const request = createUpdatePhotoRequest(PHOTO_ID, { tags: ['夕食', '温泉'] });

    const response = await updatePhotoHandler(request, mockContext);

    expect(response.status).toBe(200);
    const body = response.jsonBody as any;
    expect(body.data.photo.tags).toEqual(['夕食', '温泉']);
    expect(body.data.photo.category).toBe('food');
    // タグだけを送ったときは、コメントとその出どころ(AI が書いたもの)に触らない
    expect(cosmosBackend.documents.get(PHOTO_ID)).toEqual({
      ...photo,
      tags: ['夕食', '温泉'],
      updatedAt: UPDATED_AT
    });
  });

  it('重複したタグは1つにまとめ、先に出たものを残す', async () => {
    freezeNow();
    cosmosBackend.documents.set(PHOTO_ID, storedPhoto());
    const request = createUpdatePhotoRequest(PHOTO_ID, { tags: ['温泉', '旅館', '温泉'] });

    const response = await updatePhotoHandler(request, mockContext);

    expect(response.status).toBe(200);
    const body = response.jsonBody as any;
    expect(body.data.photo.tags).toEqual(['温泉', '旅館']);
    expect((cosmosBackend.documents.get(PHOTO_ID) as PhotoDocument).tags).toEqual(['温泉', '旅館']);
  });

  it('タグの前後の空白は除いて保存する', async () => {
    freezeNow();
    cosmosBackend.documents.set(PHOTO_ID, storedPhoto());
    const request = createUpdatePhotoRequest(PHOTO_ID, { tags: ['  温泉  ', '旅館 '] });

    const response = await updatePhotoHandler(request, mockContext);

    expect(response.status).toBe(200);
    const body = response.jsonBody as any;
    expect(body.data.photo.tags).toEqual(['温泉', '旅館']);
    expect((cosmosBackend.documents.get(PHOTO_ID) as PhotoDocument).tags).toEqual(['温泉', '旅館']);
  });

  // 05 §5.6 の 1〜9 を、表の順に。どの行も、写真は保存済みで(404 で先に返らない)、何も変わらない。
  // 最後の 2 行は検証の順序の例(写真IDが先、コメントはタグより先)
  it.each([
    ['写真IDの形式が無効', 'abc', jest.fn().mockResolvedValue({ comment: '夕食' }), '写真IDの形式が無効です'],
    ['ボディがJSONとしてパースできない', PHOTO_ID, jest.fn().mockRejectedValue(new SyntaxError('Unexpected token')), 'リクエストボディの形式が無効です'],
    ['ボディがnull', PHOTO_ID, jest.fn().mockResolvedValue(null), 'リクエストボディが指定されていません'],
    ['commentもtagsも無い(空のオブジェクト)', PHOTO_ID, jest.fn().mockResolvedValue({}), '更新する項目が指定されていません'],
    ['commentもtagsも無い(関係ないキーだけ)', PHOTO_ID, jest.fn().mockResolvedValue({ hint: '夕食' }), '更新する項目が指定されていません'],
    ['commentが数値', PHOTO_ID, jest.fn().mockResolvedValue({ comment: 123 }), 'コメントは文字列で指定してください'],
    ['commentが配列', PHOTO_ID, jest.fn().mockResolvedValue({ comment: ['夕食'] }), 'コメントは文字列で指定してください'],
    ['commentが前後の空白を除いて501文字', PHOTO_ID, jest.fn().mockResolvedValue({ comment: ` ${'あ'.repeat(501)} ` }), 'コメントは500文字以内で指定してください'],
    ['tagsが文字列', PHOTO_ID, jest.fn().mockResolvedValue({ tags: '温泉' }), 'タグは配列で指定してください'],
    ['tagsが配列でないオブジェクト', PHOTO_ID, jest.fn().mockResolvedValue({ tags: { 0: '温泉' } }), 'タグは配列で指定してください'],
    ['tagsの要素に文字列でないものがある', PHOTO_ID, jest.fn().mockResolvedValue({ tags: ['温泉', 123] }), 'タグは文字列で指定してください'],
    ['tagsの要素が空の文字列', PHOTO_ID, jest.fn().mockResolvedValue({ tags: ['温泉', ''] }), 'タグは1〜30文字で指定してください'],
    ['tagsの要素が空白だけ', PHOTO_ID, jest.fn().mockResolvedValue({ tags: ['温泉', '   '] }), 'タグは1〜30文字で指定してください'],
    ['tagsの要素が前後の空白を除いて31文字', PHOTO_ID, jest.fn().mockResolvedValue({ tags: ['温泉', ` ${'あ'.repeat(31)} `] }), 'タグは1〜30文字で指定してください'],
    // 上限は重複を除いた後の個数で数える(21個とも違う値)。9 の後の行
    ['tagsが重複を除いて21個', PHOTO_ID, jest.fn().mockResolvedValue({ tags: distinctTags(21) }), 'タグは20個までです'],
    ['写真IDもボディも無効(写真IDの理由を返す)', 'abc', jest.fn().mockRejectedValue(new SyntaxError('Unexpected token')), '写真IDの形式が無効です'],
    ['commentもtagsも無効(commentの理由を返す)', PHOTO_ID, jest.fn().mockResolvedValue({ comment: 123, tags: '温泉' }), 'コメントは文字列で指定してください']
  ])('写真の更新で指定が正しくなければ、400で理由を返し、何も変えない(%s)', async (_case, photoId, json, message) => {
    cosmosBackend.documents.set(PHOTO_ID, storedPhoto());
    const before = new Map(cosmosBackend.documents);
    const request = createUpdatePhotoRequestWithJson(photoId, json);

    const response = await updatePhotoHandler(request, mockContext);

    expect(response.status).toBe(400);
    const body = response.jsonBody as any;
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INVALID_REQUEST');
    expect(body.error.message).toBe(message);
    expect(cosmosBackend.documents).toEqual(before);
  });

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

  it('タグが前後の空白を除いて30文字なら、空白を含めて30文字を超えていても保存できる', async () => {
    freezeNow();
    cosmosBackend.documents.set(PHOTO_ID, storedPhoto());
    const tag = 'あ'.repeat(30);
    const request = createUpdatePhotoRequest(PHOTO_ID, { tags: [` ${tag} `] });

    const response = await updatePhotoHandler(request, mockContext);

    expect(response.status).toBe(200);
    expect((cosmosBackend.documents.get(PHOTO_ID) as PhotoDocument).tags).toEqual([tag]);
  });

  it('前後の空白を除くと同じになるタグは、1つにまとめる', async () => {
    freezeNow();
    cosmosBackend.documents.set(PHOTO_ID, storedPhoto());
    const request = createUpdatePhotoRequest(PHOTO_ID, { tags: ['温泉', ' 温泉 '] });

    const response = await updatePhotoHandler(request, mockContext);

    expect(response.status).toBe(200);
    expect((cosmosBackend.documents.get(PHOTO_ID) as PhotoDocument).tags).toEqual(['温泉']);
  });

  it('タグがちょうど20個なら保存できる', async () => {
    freezeNow();
    cosmosBackend.documents.set(PHOTO_ID, storedPhoto());
    const request = createUpdatePhotoRequest(PHOTO_ID, { tags: distinctTags(20) });

    const response = await updatePhotoHandler(request, mockContext);

    expect(response.status).toBe(200);
    expect((cosmosBackend.documents.get(PHOTO_ID) as PhotoDocument).tags).toEqual(distinctTags(20));
  });

  it('重複を含めて21個でも、重複を除いて20個なら保存できる', async () => {
    freezeNow();
    cosmosBackend.documents.set(PHOTO_ID, storedPhoto());
    const request = createUpdatePhotoRequest(PHOTO_ID, { tags: [...distinctTags(20), 'タグ1'] });

    const response = await updatePhotoHandler(request, mockContext);

    expect(response.status).toBe(200);
    expect((cosmosBackend.documents.get(PHOTO_ID) as PhotoDocument).tags).toEqual(distinctTags(20));
  });

  it('更新する写真が無いと、404で理由を返し、何も変えない', async () => {
    // 形式は正しいが、その id の写真は無い。別の写真は保存済みで、patch が誤って作ったり書き換えたりしないことも見る
    const otherPhotoId = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
    cosmosBackend.documents.set(otherPhotoId, storedPhoto({ id: otherPhotoId }));
    const before = new Map(cosmosBackend.documents);
    const request = createUpdatePhotoRequest(PHOTO_ID, { comment: '夕食の懐石' });

    const response = await updatePhotoHandler(request, mockContext);

    expect(response.status).toBe(404);
    const body = response.jsonBody as any;
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('PHOTO_NOT_FOUND');
    expect(body.error.message).toBe('指定された写真が見つかりません');
    expect(cosmosBackend.documents).toEqual(before);
  });

  // データベースの失敗の分類(接続できない障害は503、それ以外は500で message は固定)を、写真の更新(patch)で確かめる
  it.each(
    databaseFailureCases('写真の更新に失敗しました')
  )('写真の更新で%s', async (_case, error, status, code, message) => {
    // 形式が正しい要求で、写真もある(検証や404で先に返らず、patch まで進む)
    cosmosBackend.documents.set(PHOTO_ID, storedPhoto());
    const before = new Map(cosmosBackend.documents);
    cosmosBackend.forcedPatchError = error;
    const request = createUpdatePhotoRequest(PHOTO_ID, { comment: '夕食の懐石' });

    const response = await updatePhotoHandler(request, mockContext);

    expect(response.status).toBe(status);
    const body = response.jsonBody as any;
    expect(body.success).toBe(false);
    expect(body.error.code).toBe(code);
    expect(body.error.message).toBe(message);
    expect(cosmosBackend.documents).toEqual(before);
  });
});
