import { HttpRequest, InvocationContext } from '@azure/functions';
import { CosmosClient } from '@azure/cosmos';
import {
  BlobSASPermissions,
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters
} from '@azure/storage-blob';
import { deletePhotoHandler, getPhotoHandler } from '../../src/functions/photoDetail';
import { PhotoDocument } from '../../src/types/album';
import { FakeCosmosBackend, FakeCosmosDocument, cosmosNotFoundError, createFakeContainer } from '../fakes/cosmos';
import { BlobEntry, FakeBlobBackend, TEST_BLOB_HOST, createFakeBlobServiceClient } from '../fakes/blob';
import { COSMOS_SYSTEM_FIELDS, photoDocument } from '../helpers/albumDocuments';
import { databaseFailureCases } from '../helpers/databaseFailures';
import { forEachCase } from '../helpers/cases';

// 外部依存のみモック
jest.mock('@azure/cosmos');
// SAS の署名に使う関数は、このファイルで固定のトークンを返す形に差し替える。
// 署名はローカルの計算だけで Blob Storage へは通信しない。署名の対象・権限・開始時刻は
// photos.test.ts が実 SDK のトークンで見ているので、ここでは「写真ごとの URL にトークンが付いて返る」ことと
// urlExpiresAt を見る
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

// 写真の id（画像のバイト列の SHA-256。小文字16進 64 文字）。このファイルでは画像のバイト列は使わない
const PHOTO_ID = '45ae705277879f7f01d778f7c95a065bb0c06ab9936cf24307f375211fee13d1';

// 写真が属する旅行の id（UUID v4 の形）。写真を1枚取り出すときに旅行は引かないので、旅行のドキュメントは置かない
const TRIP_ID = '123e4567-e89b-42d3-a456-426614174000';

// 削除のテストで、対象の写真とは別に置いておく写真の id（宛先の取り違えを見分けるため。形式は PHOTO_ID と同じ）
const OTHER_PHOTO_ID = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';

// 形式は正しいが、保存されていない写真の id（空のデータの SHA-256。削除のテストはこの id の写真を置かない）
const MISSING_PHOTO_ID = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const createGetPhotoRequest = (photoId: string): HttpRequest =>
  ({
    method: 'GET',
    url: `https://func-snaplant.azurewebsites.net/api/photos/${photoId}?code=test-key`,
    query: new Map([['code', 'test-key']]),
    headers: new Map(),
    params: { photoId }
  }) as any as HttpRequest;

const createDeletePhotoRequest = (photoId: string): HttpRequest =>
  ({
    method: 'DELETE',
    url: `https://func-snaplant.azurewebsites.net/api/photos/${photoId}?code=test-key`,
    query: new Map([['code', 'test-key']]),
    headers: new Map(),
    params: { photoId }
  }) as any as HttpRequest;

/**
 * サムネイルのある、保存済みの写真のドキュメント。削除のテストは Blob 名(`<id>.jpg` / `<id>.thumb.jpg`)で
 * 消えた画像を見分けるので、ここで決める。ほかの項目は削除に関係しない
 */
const savedPhotoWithThumbnail = (id: string): PhotoDocument =>
  photoDocument(id, { tripId: TRIP_ID, blobName: `${id}.jpg`, thumbnailBlobName: `${id}.thumb.jpg` });

describe('写真詳細API', () => {
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

    // 写真を取り出すだけでは Blob の中身は読まない（URL を組み立てるために偽物のサービスクライアントが要る）。
    // 削除では偽物の store から Blob が消えることを見る
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
    // ホストは TEST_BLOB_HOST（test.blob.core.windows.net）になる
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

  describe('写真取得API', () => {
    it('保存してある写真を1枚取り出すと、表示用のURL付きで返る', async () => {
      // 時刻だけを固定する。他のタイマーまで偽物にすると非同期処理が止まりうる
      jest.useFakeTimers({
        now: new Date('2026-10-10T03:12:45.000Z'),
        doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'setTimeout', 'setInterval']
      });
      // 保存済みの写真（サムネイルあり）。応答の値と取り違えが区別できるよう、項目ごとに違う値を入れる。
      // uploadedAt・updatedAt は現在時刻（固定した 2026-10-10）とは別の日で、保存済みの値がそのまま返ることを見る
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
        tags: [{ name: '朝食', kind: 'food', x: 0.5, y: 0.5 }, { name: '旅館', kind: 'food', x: 0.5, y: 0.5 }],
        comment: 'ホテルの朝食',
        commentSource: 'user',
        hint: 'ビュッフェ',
        classification: null,
        identification: null,
        processing: { state: 'none', step: null, attempts: 0, lastError: null, updatedAt: null },
        uploadedAt: '2026-09-21T01:00:00.000Z',
        updatedAt: '2026-09-22T02:30:00.000Z'
      };
      const savedPhoto = photoDocument(PHOTO_ID, {
        ...photoFields,
        blobName: `${PHOTO_ID}.jpg`,
        thumbnailBlobName: `${PHOTO_ID}.thumb.jpg`
      });
      cosmosBackend.documents.set(PHOTO_ID, { ...savedPhoto, ...COSMOS_SYSTEM_FIELDS });
      const request = createGetPhotoRequest(PHOTO_ID);

      const response = await getPhotoHandler(request, mockContext);

      // blobName / thumbnailBlobName / type と Cosmos のシステム項目（_rid・_etag など）は含まず、
      // 代わりに SAS 付きの URL が付く。写真の項目は完全一致で見る（余分な項目が混ざっても、足りなくても落ちる）
      expect(response.status).toBe(200);
      expect(response.jsonBody).toEqual({
        success: true,
        data: {
          photo: {
            ...photoFields,
            categorySource: null,
            imageUrl: `https://${TEST_BLOB_HOST}/photos/${PHOTO_ID}.jpg?${TEST_SAS_TOKEN}`,
            thumbnailUrl: `https://${TEST_BLOB_HOST}/photos/${PHOTO_ID}.thumb.jpg?${TEST_SAS_TOKEN}`
          },
          urlExpiresAt: '2026-10-10T04:12:45.000Z'
        }
      });
    });

    it('C-3a より前に保存した文字列のタグは、応答に出さない（タグは名前・種類・位置の形だけを返す。04 §2）', async () => {
      const tag = { name: '海鮮丼', kind: 'food', x: 0.4, y: 0.6 };
      const savedPhoto = photoDocument(PHOTO_ID, { tags: ['古いタグ', tag] as any });
      cosmosBackend.documents.set(PHOTO_ID, { ...savedPhoto, ...COSMOS_SYSTEM_FIELDS });

      const response = await getPhotoHandler(createGetPhotoRequest(PHOTO_ID), mockContext);

      expect(response.status).toBe(200);
      expect((response.jsonBody as any).data.photo.tags).toEqual([tag]);
    });

    // 写真IDの形式は小文字16進64文字だけ。大文字を許すと同じ写真に2つの id ができるので、大文字は400になる。
    // code は文字列で固定する（クライアントがこの値で分岐する）
    it('取り出す写真の指定の形式が正しくなければ、400で理由を返す', () => forEachCase([
      ['写真IDが3文字', 'abc'],
      ['写真IDが大文字の16進', PHOTO_ID.toUpperCase()],
      ['写真IDが63文字', PHOTO_ID.slice(1)],
      ['写真IDが65文字', `${PHOTO_ID}0`],
      ['写真IDに16進でない文字が入っている', `g${PHOTO_ID.slice(1)}`]
    ], async (_case, photoId) => {
      const request = createGetPhotoRequest(photoId);

      const response = await getPhotoHandler(request, mockContext);

      expect(response.status).toBe(400);
      const body = response.jsonBody as any;
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('INVALID_REQUEST');
      expect(body.error.message).toBe('写真IDの形式が無効です');
    }));

    it('形式は正しいが該当する写真が無ければ、404で理由を返す', async () => {
      // documents は空のまま。形式の検証は通り、データベースの読み取りで見つからない
      const request = createGetPhotoRequest(PHOTO_ID);

      const response = await getPhotoHandler(request, mockContext);

      expect(response.status).toBe(404);
      const body = response.jsonBody as any;
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('PHOTO_NOT_FOUND');
      expect(body.error.message).toBe('指定された写真が見つかりません');
    });

    // 写真の読み取りで失敗したときの分類の表。接続できない障害は503、それ以外は500で、500の message は固定
    it('写真の取得で、データベースに接続できなければ503、それ以外の失敗は500で決まった文言を返す', () => forEachCase(databaseFailureCases('写真詳細の取得に失敗しました'), async (_case, error, status, code, message) => {
      // 形式が正しい photoId で呼ぶ（形式の検証で先に400にならず、データベースの読み取りまで進む）
      cosmosBackend.forcedReadError = error;
      const request = createGetPhotoRequest(PHOTO_ID);

      const response = await getPhotoHandler(request, mockContext);

      expect(response.status).toBe(status);
      const body = response.jsonBody as any;
      expect(body.success).toBe(false);
      expect(body.error.code).toBe(code);
      expect(body.error.message).toBe(message);
    }));

    // 写真のURLは、接続文字列のアカウント名と鍵で署名して作る。鍵が無いまま空の鍵で署名すると、
    // 見かけは普通のURLなのに Blob Storage が403で拒む壊れたURLを返してしまう。
    // このファイルでは署名の関数を固定のトークンを返す形に差し替えているので、空の鍵で署名したことは
    // 応答からは見えない。だから「鍵が無ければURLを作らず、500で決まった文言を返す」ことで確かめる。
    // 写真は保存済みにして、設定以外はすべて正しい状態にする
    it('写真の保存先の設定に鍵が無ければ、壊れたURLを返さず500で決まった文言を返す', async () => {
      process.env.STORAGE_CONNECTION_STRING =
        'DefaultEndpointsProtocol=https;AccountName=test;EndpointSuffix=core.windows.net';
      const savedPhoto = photoDocument(PHOTO_ID, { blobName: `${PHOTO_ID}.jpg`, thumbnailBlobName: null });
      cosmosBackend.documents.set(PHOTO_ID, savedPhoto);
      const request = createGetPhotoRequest(PHOTO_ID);

      const response = await getPhotoHandler(request, mockContext);

      expect(response.status).toBe(500);
      const body = response.jsonBody as any;
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('INTERNAL_ERROR');
      expect(body.error.message).toBe('写真詳細の取得に失敗しました');
    });
  });

  describe('写真削除API', () => {
    it('写真を削除すると、写真のデータと原寸・サムネイルの画像が消え、200で返る', async () => {
      // 削除する写真と、同じ旅行の別の写真を、どちらもサムネイル付きで置く。別の写真が残ることで、
      // 宛先の取り違えや、旅行の写真をまとめて消す誤りを見分ける（偽物は引数ごとに別の Blob を扱う）
      cosmosBackend.documents.set(PHOTO_ID, savedPhotoWithThumbnail(PHOTO_ID));
      cosmosBackend.documents.set(OTHER_PHOTO_ID, savedPhotoWithThumbnail(OTHER_PHOTO_ID));
      blobBackend.store.set(`photos/${PHOTO_ID}.jpg`, { content: Buffer.from('原寸'), contentType: 'image/jpeg' });
      blobBackend.store.set(`photos/${PHOTO_ID}.thumb.jpg`, { content: Buffer.from('縮小'), contentType: 'image/jpeg' });
      blobBackend.store.set(`photos/${OTHER_PHOTO_ID}.jpg`, { content: Buffer.from('別の原寸'), contentType: 'image/jpeg' });
      blobBackend.store.set(`photos/${OTHER_PHOTO_ID}.thumb.jpg`, { content: Buffer.from('別の縮小'), contentType: 'image/jpeg' });
      const request = createDeletePhotoRequest(PHOTO_ID);

      const response = await deletePhotoHandler(request, mockContext);

      expect(response.status).toBe(200);
      expect(response.jsonBody).toEqual({ success: true, data: { message: '写真が正常に削除されました' } });
      // 消えたのは対象の写真だけ。別の写真のデータと画像は残る
      expect(Array.from(cosmosBackend.documents.keys())).toEqual([OTHER_PHOTO_ID]);
      expect(Array.from(blobBackend.store.keys())).toEqual([
        `photos/${OTHER_PHOTO_ID}.jpg`,
        `photos/${OTHER_PHOTO_ID}.thumb.jpg`
      ]);
    });

    // 写真IDの形式は GET と同じ(小文字16進64文字だけ)。404 の行は形式が正しく、写真だけが無い。
    // どの行でも保存済みの写真は PHOTO_ID と OTHER_PHOTO_ID の2枚で、削除は何も変えない。
    // 大文字の行は、小文字にした id の写真(PHOTO_ID)が実際にある。大文字を小文字に直して消してしまう実装は、この行で見分ける
    it('削除する写真の指定が正しくなければ、理由を返し何も消さない', () => forEachCase([
      ['写真IDが3文字', 'abc', 400, 'INVALID_REQUEST', '写真IDの形式が無効です'],
      ['写真IDが大文字の16進', PHOTO_ID.toUpperCase(), 400, 'INVALID_REQUEST', '写真IDの形式が無効です'],
      ['写真IDが63文字', PHOTO_ID.slice(1), 400, 'INVALID_REQUEST', '写真IDの形式が無効です'],
      ['写真IDが65文字', `${PHOTO_ID}0`, 400, 'INVALID_REQUEST', '写真IDの形式が無効です'],
      ['写真IDに16進でない文字が入っている', `g${PHOTO_ID.slice(1)}`, 400, 'INVALID_REQUEST', '写真IDの形式が無効です'],
      ['形式は正しいが該当する写真が無い', MISSING_PHOTO_ID, 404, 'PHOTO_NOT_FOUND', '指定された写真が見つかりません']
    ], async (_case, photoId, status, code, message) => {
      cosmosBackend.documents.set(PHOTO_ID, savedPhotoWithThumbnail(PHOTO_ID));
      cosmosBackend.documents.set(OTHER_PHOTO_ID, savedPhotoWithThumbnail(OTHER_PHOTO_ID));
      blobBackend.store.set(`photos/${PHOTO_ID}.jpg`, { content: Buffer.from('原寸'), contentType: 'image/jpeg' });
      blobBackend.store.set(`photos/${PHOTO_ID}.thumb.jpg`, { content: Buffer.from('縮小'), contentType: 'image/jpeg' });
      blobBackend.store.set(`photos/${OTHER_PHOTO_ID}.jpg`, { content: Buffer.from('別の原寸'), contentType: 'image/jpeg' });
      blobBackend.store.set(`photos/${OTHER_PHOTO_ID}.thumb.jpg`, { content: Buffer.from('別の縮小'), contentType: 'image/jpeg' });
      const request = createDeletePhotoRequest(photoId);

      const response = await deletePhotoHandler(request, mockContext);

      expect(response.status).toBe(status);
      const body = response.jsonBody as any;
      expect(body.success).toBe(false);
      expect(body.error.code).toBe(code);
      expect(body.error.message).toBe(message);
      // 保存済みの2枚のデータと画像は、どれも消えていない
      expect(Array.from(cosmosBackend.documents.keys())).toEqual([PHOTO_ID, OTHER_PHOTO_ID]);
      expect(Array.from(blobBackend.store.keys())).toEqual([
        `photos/${PHOTO_ID}.jpg`,
        `photos/${PHOTO_ID}.thumb.jpg`,
        `photos/${OTHER_PHOTO_ID}.jpg`,
        `photos/${OTHER_PHOTO_ID}.thumb.jpg`
      ]);
    }));

    it('サムネイルの無い写真を削除すると、原寸だけが消え、200で返る', async () => {
      // 削除する写真はサムネイルが無い(thumbnailBlobName が null で、Blob は原寸だけ)。
      // 別の写真はサムネイル付きで置き、削除の宛先を取り違えていないことも見る
      const photoWithoutThumbnail: PhotoDocument = { ...savedPhotoWithThumbnail(PHOTO_ID), thumbnailBlobName: null };
      cosmosBackend.documents.set(PHOTO_ID, photoWithoutThumbnail);
      cosmosBackend.documents.set(OTHER_PHOTO_ID, savedPhotoWithThumbnail(OTHER_PHOTO_ID));
      blobBackend.store.set(`photos/${PHOTO_ID}.jpg`, { content: Buffer.from('原寸'), contentType: 'image/jpeg' });
      blobBackend.store.set(`photos/${OTHER_PHOTO_ID}.jpg`, { content: Buffer.from('別の原寸'), contentType: 'image/jpeg' });
      blobBackend.store.set(`photos/${OTHER_PHOTO_ID}.thumb.jpg`, { content: Buffer.from('別の縮小'), contentType: 'image/jpeg' });
      const request = createDeletePhotoRequest(PHOTO_ID);

      const response = await deletePhotoHandler(request, mockContext);

      expect(response.status).toBe(200);
      expect(response.jsonBody).toEqual({ success: true, data: { message: '写真が正常に削除されました' } });
      expect(Array.from(cosmosBackend.documents.keys())).toEqual([OTHER_PHOTO_ID]);
      expect(Array.from(blobBackend.store.keys())).toEqual([
        `photos/${OTHER_PHOTO_ID}.jpg`,
        `photos/${OTHER_PHOTO_ID}.thumb.jpg`
      ]);
    });

    // 画像の削除の失敗は利用者に見せない(ドキュメントはもう無く、残った画像は掃除のタイマーが消す。05 §5.4)。
    // 原寸の削除が失敗しても、サムネイルは消しにいく。失敗は Blob Storage が権限の不足で返す形(RestError・403)にする
    it('画像の削除に失敗しても、写真のデータは消え、200で返り、もう一方の画像も消しにいく', async () => {
      cosmosBackend.documents.set(PHOTO_ID, savedPhotoWithThumbnail(PHOTO_ID));
      cosmosBackend.documents.set(OTHER_PHOTO_ID, savedPhotoWithThumbnail(OTHER_PHOTO_ID));
      blobBackend.store.set(`photos/${PHOTO_ID}.jpg`, {
        content: Buffer.from('原寸'),
        contentType: 'image/jpeg',
        failWith: Object.assign(new Error('This request is not authorized to perform this operation.'), {
          name: 'RestError',
          statusCode: 403,
          code: 'AuthorizationFailure'
        })
      });
      blobBackend.store.set(`photos/${PHOTO_ID}.thumb.jpg`, { content: Buffer.from('縮小'), contentType: 'image/jpeg' });
      blobBackend.store.set(`photos/${OTHER_PHOTO_ID}.jpg`, { content: Buffer.from('別の原寸'), contentType: 'image/jpeg' });
      blobBackend.store.set(`photos/${OTHER_PHOTO_ID}.thumb.jpg`, { content: Buffer.from('別の縮小'), contentType: 'image/jpeg' });
      const request = createDeletePhotoRequest(PHOTO_ID);

      const response = await deletePhotoHandler(request, mockContext);

      expect(response.status).toBe(200);
      expect(response.jsonBody).toEqual({ success: true, data: { message: '写真が正常に削除されました' } });
      // 写真のデータは消え、サムネイルも消えた。消せなかった原寸と、別の写真のデータと画像は残る
      expect(Array.from(cosmosBackend.documents.keys())).toEqual([OTHER_PHOTO_ID]);
      expect(Array.from(blobBackend.store.keys())).toEqual([
        `photos/${PHOTO_ID}.jpg`,
        `photos/${OTHER_PHOTO_ID}.jpg`,
        `photos/${OTHER_PHOTO_ID}.thumb.jpg`
      ]);
    });

    // データベースの失敗の分類(接続できない障害は503、それ以外は500で message は固定)を、削除が使う2つの操作で確かめる。
    // 写真のデータを読む所と、消す所の、どちらで失敗してもドキュメントも画像も消えない
    // (ドキュメントの削除に失敗したら画像には触らない。04 §7.1)
    it.each(
      (
        [
          ['データベースの読み取り', 'forcedReadError'],
          ['データベースの削除', 'forcedDeleteError']
        ] as const
      ).flatMap(([point, failureKey]) =>
        databaseFailureCases('写真の削除に失敗しました').map(
          ([failureCase, error, status, code, message]) => [failureCase, point, failureKey, error, status, code, message] as const
        )
      )
    )('写真の削除で%s（%s）', async (_case, _point, failureKey, error, status, code, message) => {
      // 形式が正しい photoId で、保存済みの写真を指す(形式の検証や404で先に返らず、データベースの操作まで進む)
      cosmosBackend.documents.set(PHOTO_ID, savedPhotoWithThumbnail(PHOTO_ID));
      cosmosBackend.documents.set(OTHER_PHOTO_ID, savedPhotoWithThumbnail(OTHER_PHOTO_ID));
      blobBackend.store.set(`photos/${PHOTO_ID}.jpg`, { content: Buffer.from('原寸'), contentType: 'image/jpeg' });
      blobBackend.store.set(`photos/${PHOTO_ID}.thumb.jpg`, { content: Buffer.from('縮小'), contentType: 'image/jpeg' });
      blobBackend.store.set(`photos/${OTHER_PHOTO_ID}.jpg`, { content: Buffer.from('別の原寸'), contentType: 'image/jpeg' });
      blobBackend.store.set(`photos/${OTHER_PHOTO_ID}.thumb.jpg`, { content: Buffer.from('別の縮小'), contentType: 'image/jpeg' });
      cosmosBackend[failureKey] = error;
      const request = createDeletePhotoRequest(PHOTO_ID);

      const response = await deletePhotoHandler(request, mockContext);

      expect(response.status).toBe(status);
      const body = response.jsonBody as any;
      expect(body.success).toBe(false);
      expect(body.error.code).toBe(code);
      expect(body.error.message).toBe(message);
      // 保存済みの2枚のデータと画像は、どれも消えていない
      expect(Array.from(cosmosBackend.documents.keys())).toEqual([PHOTO_ID, OTHER_PHOTO_ID]);
      expect(Array.from(blobBackend.store.keys())).toEqual([
        `photos/${PHOTO_ID}.jpg`,
        `photos/${PHOTO_ID}.thumb.jpg`,
        `photos/${OTHER_PHOTO_ID}.jpg`,
        `photos/${OTHER_PHOTO_ID}.thumb.jpg`
      ]);
    });

    // 読んだ後・削除の前に、他のリクエストが同じ写真を消した(同じ写真の削除が重なった)。
    // 実 SDK は存在しないドキュメントの削除を 404 のエラーで返す。このとき写真は「もう無い」ので、
    // 最初から無かったときと同じ 404 にする(500 にしない)。ドキュメントを消せなかったので画像には触らない:
    // 画像は先に消した側が消す。ここで消すと、その後に同じ写真が送り直されたときに、できたばかりの画像を消しかねない
    it('写真の削除の途中で写真が消されていたら、見つからない扱いになる', async () => {
      cosmosBackend.documents.set(PHOTO_ID, savedPhotoWithThumbnail(PHOTO_ID));
      cosmosBackend.documents.set(OTHER_PHOTO_ID, savedPhotoWithThumbnail(OTHER_PHOTO_ID));
      blobBackend.store.set(`photos/${PHOTO_ID}.jpg`, { content: Buffer.from('原寸'), contentType: 'image/jpeg' });
      blobBackend.store.set(`photos/${PHOTO_ID}.thumb.jpg`, { content: Buffer.from('縮小'), contentType: 'image/jpeg' });
      blobBackend.store.set(`photos/${OTHER_PHOTO_ID}.jpg`, { content: Buffer.from('別の原寸'), contentType: 'image/jpeg' });
      blobBackend.store.set(`photos/${OTHER_PHOTO_ID}.thumb.jpg`, { content: Buffer.from('別の縮小'), contentType: 'image/jpeg' });
      cosmosBackend.forcedDeleteError = cosmosNotFoundError();
      const request = createDeletePhotoRequest(PHOTO_ID);

      const response = await deletePhotoHandler(request, mockContext);

      expect(response.status).toBe(404);
      const body = response.jsonBody as any;
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('PHOTO_NOT_FOUND');
      expect(body.error.message).toBe('指定された写真が見つかりません');
      // 2枚のデータと画像は、どれも消えていない
      expect(Array.from(cosmosBackend.documents.keys())).toEqual([PHOTO_ID, OTHER_PHOTO_ID]);
      expect(Array.from(blobBackend.store.keys())).toEqual([
        `photos/${PHOTO_ID}.jpg`,
        `photos/${PHOTO_ID}.thumb.jpg`,
        `photos/${OTHER_PHOTO_ID}.jpg`,
        `photos/${OTHER_PHOTO_ID}.thumb.jpg`
      ]);
    });

    // 画像を消す側の設定（鍵）が足りなければ、写真のデータを消す前に500で返す。
    // 設定が足りないと画像を消すサービスが作れない。作るのが写真のデータを消した後だと、データだけ消えて
    // 画像が残り（掃除のタイマーが消すまで）、しかも例外が応答にならず漏れる。
    // 写真も画像も保存済みで、設定以外はすべて正しい状態にする
    it('写真の保存先の設定に鍵が無ければ、写真を消さずに500で決まった文言を返す', async () => {
      process.env.STORAGE_CONNECTION_STRING =
        'DefaultEndpointsProtocol=https;AccountName=test;EndpointSuffix=core.windows.net';
      cosmosBackend.documents.set(PHOTO_ID, savedPhotoWithThumbnail(PHOTO_ID));
      cosmosBackend.documents.set(OTHER_PHOTO_ID, savedPhotoWithThumbnail(OTHER_PHOTO_ID));
      blobBackend.store.set(`photos/${PHOTO_ID}.jpg`, { content: Buffer.from('原寸'), contentType: 'image/jpeg' });
      blobBackend.store.set(`photos/${PHOTO_ID}.thumb.jpg`, { content: Buffer.from('縮小'), contentType: 'image/jpeg' });
      blobBackend.store.set(`photos/${OTHER_PHOTO_ID}.jpg`, { content: Buffer.from('別の原寸'), contentType: 'image/jpeg' });
      blobBackend.store.set(`photos/${OTHER_PHOTO_ID}.thumb.jpg`, { content: Buffer.from('別の縮小'), contentType: 'image/jpeg' });
      const request = createDeletePhotoRequest(PHOTO_ID);

      const response = await deletePhotoHandler(request, mockContext);

      expect(response.status).toBe(500);
      const body = response.jsonBody as any;
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('INTERNAL_ERROR');
      expect(body.error.message).toBe('写真の削除に失敗しました');
      // 保存済みの2枚のデータと画像は、どれも消えていない
      expect(Array.from(cosmosBackend.documents.keys())).toEqual([PHOTO_ID, OTHER_PHOTO_ID]);
      expect(Array.from(blobBackend.store.keys())).toEqual([
        `photos/${PHOTO_ID}.jpg`,
        `photos/${PHOTO_ID}.thumb.jpg`,
        `photos/${OTHER_PHOTO_ID}.jpg`,
        `photos/${OTHER_PHOTO_ID}.thumb.jpg`
      ]);
    });
  });
});
