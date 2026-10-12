import { HttpRequest, InvocationContext } from '@azure/functions';
import { CosmosClient } from '@azure/cosmos';
import { BlobServiceClient, generateBlobSASQueryParameters } from '@azure/storage-blob';
import { createPhotoHandler } from '../../src/functions/photos';
import { FakeCosmosBackend, FakeCosmosDocument, createFakeContainer } from '../fakes/cosmos';
import { BlobEntry, FakeBlobBackend, TEST_BLOB_HOST, createFakeBlobServiceClient } from '../fakes/blob';

// 外部依存のみモック
jest.mock('@azure/cosmos');
// SAS の署名に使う関数は、このファイルで固定のトークンを返す形に差し替える。
// 署名はローカルの計算だけで Blob Storage へは通信しない。権限や有効期限は utils/blobSas の責務で、
// ここでは「写真ごとの URL にトークンが付いて返る」ことだけを見る
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

// 原寸の画像: JPEG の先頭 10 バイト（FF D8 FF E0 00 10 'J' 'F' 'I' 'F'）。
// PHOTO_ID はそのバイト列の SHA-256（小文字16進）で、テストの外で
// `printf '\xff\xd8\xff\xe0\x00\x10JFIF' | sha256sum` として求めた値。バイト列を変えたら求め直す
const IMAGE_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PHOTO_ID = '45ae705277879f7f01d778f7c95a065bb0c06ab9936cf24307f375211fee13d1';
// サムネイル: 原寸と中身もバイト数も違う JPEG。取り違えや、fileSize がサムネイルのものになる誤りを区別する
const THUMBNAIL_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

const createPhotoRequest = (formData: FormData): HttpRequest =>
  ({
    method: 'POST',
    url: 'https://func-snaplant.azurewebsites.net/api/photos?code=test-key',
    query: new Map([['code', 'test-key']]),
    headers: new Map([['content-type', 'multipart/form-data; boundary=---test']]),
    formData: jest.fn().mockResolvedValue(formData)
  }) as any as HttpRequest;

describe('写真API', () => {
  let mockContext: InvocationContext;
  let cosmosBackend: FakeCosmosBackend<FakeCosmosDocument>;
  let blobStore: Map<string, BlobEntry>;

  beforeEach(() => {
    mockContext = { log: jest.fn() } as any;

    cosmosBackend = { documents: new Map() };
    const fakeContainer = createFakeContainer(cosmosBackend);
    MockedCosmosClient.mockImplementation(() => ({
      database: () => ({
        container: () => fakeContainer
      })
    } as unknown as CosmosClient));

    blobStore = new Map();
    const blobBackend: FakeBlobBackend = { store: blobStore, forcedUploadError: null };
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

  describe('写真保存API', () => {
    it('写真を保存すると、201で表示用のURL付きの写真が返り、全項目がそろって保存される', async () => {
      // 時刻だけを固定する。他のタイマーまで偽物にすると非同期処理が止まりうる
      jest.useFakeTimers({
        now: new Date('2026-10-10T03:12:45.000Z'),
        doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'setTimeout', 'setInterval']
      });
      const formData = new FormData();
      formData.append('photoId', PHOTO_ID);
      formData.append('image', new File([IMAGE_BYTES], 'IMG_0001.jpg', { type: 'image/jpeg' }));
      formData.append('thumbnail', new File([THUMBNAIL_BYTES], 'IMG_0001.thumb.jpg', { type: 'image/jpeg' }));
      formData.append('takenAt', '2026-10-05T12:30:15');
      formData.append('latitude', '43.7706');
      formData.append('longitude', '142.365');
      formData.append('placeName', '北海道旭川市');
      const request = createPhotoRequest(formData);
      // 応答の写真とドキュメントに共通する項目。撮影日時（10月5日）とアップロード日時（10月10日）を
      // 離してあるので、sortAt がどちらから作られたかも区別できる
      const commonFields = {
        id: PHOTO_ID,
        tripId: null,
        contentType: 'image/jpeg',
        fileSize: 10,
        takenAt: '2026-10-05T12:30:15',
        takenAtSource: 'exif',
        sortAt: '2026-10-05T12:30:15',
        location: { latitude: 43.7706, longitude: 142.365, placeName: '北海道旭川市', placeSource: 'device' },
        category: null,
        tags: [],
        comment: null,
        commentSource: null,
        hint: null,
        classification: null,
        identification: null,
        processing: { state: 'none', step: null, attempts: 0, lastError: null, updatedAt: null },
        uploadedAt: '2026-10-10T03:12:45.000Z',
        updatedAt: '2026-10-10T03:12:45.000Z'
      };

      const response = await createPhotoHandler(request, mockContext);

      // 応答: blobName / thumbnailBlobName / type は含まず、代わりに SAS 付きの URL が付く
      expect(response.status).toBe(201);
      expect(response.jsonBody).toEqual({
        success: true,
        data: {
          photo: {
            ...commonFields,
            imageUrl: `https://${TEST_BLOB_HOST}/photos/${PHOTO_ID}.jpg?${TEST_SAS_TOKEN}`,
            thumbnailUrl: `https://${TEST_BLOB_HOST}/photos/${PHOTO_ID}.thumb.jpg?${TEST_SAS_TOKEN}`
          },
          urlExpiresAt: '2026-10-10T04:12:45.000Z'
        }
      });
      // 状態: ドキュメントは1件だけ。tripId のキーが null で存在する（IS_NULL(c.tripId) で引くため）
      expect(cosmosBackend.documents).toEqual(
        new Map([
          [
            PHOTO_ID,
            {
              ...commonFields,
              type: 'photo',
              blobName: `${PHOTO_ID}.jpg`,
              thumbnailBlobName: `${PHOTO_ID}.thumb.jpg`
            }
          ]
        ])
      );
      // 状態: Blob は原寸とサムネイルの2つだけで、中身は送ったバイト列
      expect(blobStore).toEqual(
        new Map([
          [`photos/${PHOTO_ID}.jpg`, { content: IMAGE_BYTES, contentType: 'image/jpeg' }],
          [`photos/${PHOTO_ID}.thumb.jpg`, { content: THUMBNAIL_BYTES, contentType: 'image/jpeg' }]
        ])
      );
    });
  });
});
