import { HttpRequest, InvocationContext } from '@azure/functions';
import { CosmosClient } from '@azure/cosmos';
import {
  BlobSASPermissions,
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters
} from '@azure/storage-blob';
import { getPhotoHandler } from '../../src/functions/photoDetail';
import { PhotoDocument } from '../../src/types/album';
import { FakeCosmosBackend, FakeCosmosDocument, createFakeContainer } from '../fakes/cosmos';
import { BlobEntry, FakeBlobBackend, TEST_BLOB_HOST, createFakeBlobServiceClient } from '../fakes/blob';
import { databaseFailureCases } from '../helpers/databaseFailures';

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

// Cosmos DB が保存したドキュメントに実際に付けるシステム項目。偽物は付けないので、漏れを見るテストが自分で足す。
// 応答の写真に混ざると、利用者に内部の識別子や ETag が見えてしまう
const COSMOS_SYSTEM_FIELDS = {
  _rid: 'q2cDAOZl6N8BAAAAAAAAAA==',
  _self: 'dbs/q2cDAA==/colls/q2cDAOZl6N8=/docs/q2cDAOZl6N8BAAAAAAAAAA==/',
  _etag: '"0000a1b2-0000-0d00-0000-6706a1b20000"',
  _attachments: 'attachments/',
  _ts: 1760065200
};

const createGetPhotoRequest = (photoId: string): HttpRequest =>
  ({
    method: 'GET',
    url: `https://func-snaplant.azurewebsites.net/api/photos/${photoId}?code=test-key`,
    query: new Map([['code', 'test-key']]),
    headers: new Map(),
    params: { photoId }
  }) as any as HttpRequest;

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

    // 写真を取り出すだけでは Blob の中身は読まない。URL を組み立てるために偽物のサービスクライアントが要る
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
        tags: ['朝食', '旅館'],
        comment: 'ホテルの朝食',
        commentSource: 'user',
        hint: 'ビュッフェ',
        classification: null,
        identification: null,
        processing: { state: 'none', step: null, attempts: 0, lastError: null, updatedAt: null },
        uploadedAt: '2026-09-21T01:00:00.000Z',
        updatedAt: '2026-09-22T02:30:00.000Z'
      };
      const savedPhoto: PhotoDocument = {
        ...photoFields,
        type: 'photo',
        blobName: `${PHOTO_ID}.jpg`,
        thumbnailBlobName: `${PHOTO_ID}.thumb.jpg`
      };
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
            imageUrl: `https://${TEST_BLOB_HOST}/photos/${PHOTO_ID}.jpg?${TEST_SAS_TOKEN}`,
            thumbnailUrl: `https://${TEST_BLOB_HOST}/photos/${PHOTO_ID}.thumb.jpg?${TEST_SAS_TOKEN}`
          },
          urlExpiresAt: '2026-10-10T04:12:45.000Z'
        }
      });
    });

    // 写真IDの形式は小文字16進64文字だけ。大文字を許すと同じ写真に2つの id ができるので、大文字は400になる。
    // code は文字列で固定する（クライアントがこの値で分岐する）
    it.each([
      ['写真IDが3文字', 'abc'],
      ['写真IDが大文字の16進', PHOTO_ID.toUpperCase()],
      ['写真IDが63文字', PHOTO_ID.slice(1)],
      ['写真IDが65文字', `${PHOTO_ID}0`],
      ['写真IDに16進でない文字が入っている', `g${PHOTO_ID.slice(1)}`]
    ])('取り出す写真の指定の形式が正しくなければ、400で理由を返す（%s）', async (_case, photoId) => {
      const request = createGetPhotoRequest(photoId);

      const response = await getPhotoHandler(request, mockContext);

      expect(response.status).toBe(400);
      const body = response.jsonBody as any;
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('INVALID_REQUEST');
      expect(body.error.message).toBe('写真IDの形式が無効です');
    });

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
    it.each(
      databaseFailureCases('写真詳細の取得に失敗しました')
    )('写真の取得で%s', async (_case, error, status, code, message) => {
      // 形式が正しい photoId で呼ぶ（形式の検証で先に400にならず、データベースの読み取りまで進む）
      cosmosBackend.forcedReadError = error;
      const request = createGetPhotoRequest(PHOTO_ID);

      const response = await getPhotoHandler(request, mockContext);

      expect(response.status).toBe(status);
      const body = response.jsonBody as any;
      expect(body.success).toBe(false);
      expect(body.error.code).toBe(code);
      expect(body.error.message).toBe(message);
    });

    // 写真のURLは、接続文字列のアカウント名と鍵で署名して作る。鍵が無いまま空の鍵で署名すると、
    // 見かけは普通のURLなのに Blob Storage が403で拒む壊れたURLを返してしまう。
    // このファイルでは署名の関数を固定のトークンを返す形に差し替えているので、空の鍵で署名したことは
    // 応答からは見えない。だから「鍵が無ければURLを作らず、500で決まった文言を返す」ことで確かめる。
    // 写真は保存済みにして、設定以外はすべて正しい状態にする
    it('写真の保存先の設定に鍵が無ければ、壊れたURLを返さず500で決まった文言を返す', async () => {
      process.env.STORAGE_CONNECTION_STRING =
        'DefaultEndpointsProtocol=https;AccountName=test;EndpointSuffix=core.windows.net';
      const savedPhoto: PhotoDocument = {
        id: PHOTO_ID,
        type: 'photo',
        tripId: null,
        blobName: `${PHOTO_ID}.jpg`,
        thumbnailBlobName: null,
        contentType: 'image/jpeg',
        fileSize: 10,
        takenAt: null,
        takenAtSource: 'none',
        sortAt: '2026-10-10T12:12:44',
        location: null,
        category: null,
        tags: [],
        comment: null,
        commentSource: null,
        hint: null,
        classification: null,
        identification: null,
        processing: { state: 'none', step: null, attempts: 0, lastError: null, updatedAt: null },
        uploadedAt: '2026-10-10T03:12:44.000Z',
        updatedAt: '2026-10-10T03:12:44.000Z'
      };
      cosmosBackend.documents.set(PHOTO_ID, { ...savedPhoto });
      const request = createGetPhotoRequest(PHOTO_ID);

      const response = await getPhotoHandler(request, mockContext);

      expect(response.status).toBe(500);
      const body = response.jsonBody as any;
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('INTERNAL_ERROR');
      expect(body.error.message).toBe('写真詳細の取得に失敗しました');
    });
  });
});
