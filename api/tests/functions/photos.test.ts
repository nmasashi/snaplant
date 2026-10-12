import { HttpRequest, InvocationContext } from '@azure/functions';
import { CosmosClient } from '@azure/cosmos';
import {
  BlobSASPermissions,
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters
} from '@azure/storage-blob';
import { createPhotoHandler } from '../../src/functions/photos';
import { PhotoDocument } from '../../src/types/album';
import { FakeCosmosBackend, FakeCosmosDocument, createFakeContainer } from '../fakes/cosmos';
import { BlobEntry, FakeBlobBackend, TEST_BLOB_HOST, createFakeBlobServiceClient } from '../fakes/blob';
import { COSMOS_SYSTEM_FIELDS, photoDocument, tripDocument } from '../helpers/albumDocuments';
import { databaseFailureCases } from '../helpers/databaseFailures';

// 外部依存のみモック
jest.mock('@azure/cosmos');
// SAS の署名に使う関数は、既定では固定のトークンを返す形に差し替える。
// 多くのテストは「写真ごとの URL にトークンが付いて返る」ことだけを見るので、それで足りる。
// 署名の中身（対象の Blob・読み取りだけの権限・開始時刻と期限）を見るテストは、中で signWithRealSdk() を呼び、
// 実 SDK で署名して返ってきた URL を読む。署名はローカルの計算だけで Blob Storage へは通信しない。
// 権限の組み立て単体は tests/utils/blobSas.test.ts が見ている
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
const MockedBlobSASPermissions = BlobSASPermissions as jest.MockedClass<typeof BlobSASPermissions>;
const MockedStorageSharedKeyCredential = StorageSharedKeyCredential as jest.MockedClass<
  typeof StorageSharedKeyCredential
>;

const TEST_SAS_TOKEN = 'sv=2024-01-01&se=2030-01-01T00%3A00%3A00Z&sp=r&sig=testsignature';

// 原寸の画像: JPEG の先頭 10 バイト（FF D8 FF E0 00 10 'J' 'F' 'I' 'F'）。
// PHOTO_ID はそのバイト列の SHA-256（小文字16進）で、テストの外で
// `printf '\xff\xd8\xff\xe0\x00\x10JFIF' | sha256sum` として求めた値。バイト列を変えたら求め直す
const IMAGE_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PHOTO_ID = '45ae705277879f7f01d778f7c95a065bb0c06ab9936cf24307f375211fee13d1';
// IMAGE_BYTES の末尾1バイトだけ違う（'F' → 'X'）バイト列の SHA-256。形式は正しく、IMAGE_BYTES の
// ものではない。`printf '\xff\xd8\xff\xe0\x00\x10JFIX' | sha256sum` で求めた値
const OTHER_IMAGE_PHOTO_ID = '22778c39fa2908bde6ff9b8a9f422a320bf65a78ef96a67edd9401e3c1d828cd';
// サムネイル: 原寸と中身もバイト数も違う JPEG。取り違えや、fileSize がサムネイルのものになる誤りを区別する
const THUMBNAIL_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

// 送り先の旅行の id（UUID v4 の形）
const TRIP_ID = '123e4567-e89b-42d3-a456-426614174000';

const multipartHeaders = (): Map<string, string> =>
  new Map([['content-type', 'multipart/form-data; boundary=---test']]);

const createRequest = (headers: Map<string, string>, formData: jest.Mock): HttpRequest =>
  ({
    method: 'POST',
    url: 'https://func-snaplant.azurewebsites.net/api/photos?code=test-key',
    query: new Map([['code', 'test-key']]),
    headers,
    formData
  }) as any as HttpRequest;

const createPhotoRequest = (formData: FormData, headers: Map<string, string> = multipartHeaders()): HttpRequest =>
  createRequest(headers, jest.fn().mockResolvedValue(formData));

/** 写真の保存が読む multipart のパート名。綴りを誤ると、壊したつもりのパートが無視されて正常系になってしまう */
type PhotoPartName = 'photoId' | 'image' | 'thumbnail' | 'tripId' | 'takenAt' | 'latitude' | 'longitude' | 'placeName';
type PhotoParts = Partial<Record<PhotoPartName, string | File>>;

/**
 * 検証を全部通る最小の送信内容（photoId と image だけ）に、行ごとに壊したい部分を上書きして作る。
 * undefined を渡したパートは送らない。壊す箇所以外は正しいので、返ってきた理由は壊した箇所のものと言える
 */
const formDataWith = (overrides: PhotoParts = {}): FormData => {
  const parts: PhotoParts = {
    photoId: PHOTO_ID,
    image: new File([IMAGE_BYTES], 'IMG_0001.jpg', { type: 'image/jpeg' }),
    ...overrides
  };
  const formData = new FormData();
  for (const [name, value] of Object.entries(parts)) {
    if (value !== undefined) formData.append(name, value);
  }
  return formData;
};

/** 指定のバイト列と Content-Type を持つファイルのパート（既定は JPEG） */
const imageFile = (bytes: Uint8Array | Buffer, type = 'image/jpeg'): File => new File([bytes], 'photo', { type });

/**
 * 現在時刻だけを固定する（解除は afterEach の useRealTimers）。
 * 他のタイマーまで偽物にすると非同期処理が止まりうるので、時刻以外は実物のままにする
 */
const freezeNow = (iso: string): void => {
  jest.useFakeTimers({
    now: new Date(iso),
    doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'setTimeout', 'setInterval']
  });
};

const realSdk = () => jest.requireActual<typeof import('@azure/storage-blob')>('@azure/storage-blob');

/**
 * このテストの署名を、固定トークンではなく実 SDK に委譲する（beforeEach が次のテストのために固定トークンへ戻す）。
 * 署名はローカルの計算だけで Blob Storage へは通信しない。st・se・sp などは平文のクエリで読める
 */
const signWithRealSdk = (): void => {
  const sdk = realSdk();
  MockedBlobSASPermissions.mockImplementation(() => new sdk.BlobSASPermissions());
  MockedStorageSharedKeyCredential.mockImplementation(
    (accountName, accountKey) => new sdk.StorageSharedKeyCredential(accountName, accountKey as string)
  );
  mockedGenerateSas.mockImplementation(sdk.generateBlobSASQueryParameters);
};

/** `<blobUrl>?<SAS>` の URL から、SAS トークンのクエリを取り出す（実 SDK で署名したトークンを読むテスト用） */
const tokenOf = (url: string): URLSearchParams => new URLSearchParams(url.slice(url.indexOf('?') + 1));

// 上限は既定値（原寸 10MB = 10485760、サムネイル 1MB = 1048576）。ちょうど1バイト超える大きさと、ちょうど上限の大きさ
const OVER_MAX_IMAGE = new Uint8Array(10485761);
const OVER_MAX_THUMBNAIL = new Uint8Array(1048577);
const MAX_THUMBNAIL = new Uint8Array(1048576);

describe('写真API', () => {
  let mockContext: InvocationContext;
  let cosmosBackend: FakeCosmosBackend<FakeCosmosDocument>;
  let blobStore: Map<string, BlobEntry>;
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

    blobStore = new Map();
    blobBackend = { store: blobStore, forcedUploadError: null };
    MockedBlobServiceClient.fromConnectionString = jest
      .fn()
      .mockReturnValue(createFakeBlobServiceClient(blobBackend));

    // jest.fn() のままだと undefined を返し、.toString() で例外になって署名の経路が検証されない
    mockedGenerateSas.mockReturnValue({ toString: () => TEST_SAS_TOKEN } as any);
    // 署名を実 SDK に委譲するテストが、後のテストに実物の権限や資格情報を持ち越さないよう、毎回ここで戻す
    MockedBlobSASPermissions.mockImplementation(() => ({}) as BlobSASPermissions);
    MockedStorageSharedKeyCredential.mockImplementation(() => ({}) as StorageSharedKeyCredential);

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
      freezeNow('2026-10-10T03:12:45.000Z');
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

    it('写真IDと画像だけを送ると、サムネイル・撮影日時・位置情報なしの写真として保存される', async () => {
      // アップロード日時は UTC で 10日 20:00 で、日本時間に直すと翌 11日 05:00 になる
      // （日付をまたぐので、UTC のまま切り出した誤りと区別できる）
      freezeNow('2026-10-10T20:00:00.000Z');
      const request = createPhotoRequest(formDataWith());

      const response = await createPhotoHandler(request, mockContext);

      expect(response.status).toBe(201);
      expect((response.jsonBody as any).data.photo).toMatchObject({
        thumbnailUrl: null,
        takenAt: null,
        takenAtSource: 'none',
        sortAt: '2026-10-11T05:00:00',
        location: null
      });
      expect(cosmosBackend.documents.get(PHOTO_ID)).toMatchObject({
        thumbnailBlobName: null,
        takenAt: null,
        takenAtSource: 'none',
        sortAt: '2026-10-11T05:00:00',
        location: null
      });
      // サムネイルを送っていないので、Blob は原寸だけ
      expect(blobStore).toEqual(
        new Map([[`photos/${PHOTO_ID}.jpg`, { content: IMAGE_BYTES, contentType: 'image/jpeg' }]])
      );
    });

    it('緯度と経度だけを送ると、地名も地名の出どころも無い位置情報として保存される', async () => {
      const request = createPhotoRequest(formDataWith({ latitude: '43.7706', longitude: '142.365' }));
      const noPlaceLocation = { latitude: 43.7706, longitude: 142.365, placeName: null, placeSource: null };

      const response = await createPhotoHandler(request, mockContext);

      expect(response.status).toBe(201);
      expect((response.jsonBody as any).data.photo.location).toEqual(noPlaceLocation);
      expect(cosmosBackend.documents.get(PHOTO_ID)).toMatchObject({ location: noPlaceLocation });
    });

    // Blob 名の拡張子は、送られたファイル名ではなく原寸の Content-Type から決まる。
    // image/jpeg は全項目の正常系が見ているので、ここは残りの形式。同じバイト列に別の Content-Type を付けて送る
    // （形式はバイト列ではなく Content-Type で判定するので、写真IDの照合は通る）
    it.each([
      ['image/png', '.png'],
      ['image/webp', '.webp'],
      ['image/gif', '.gif']
    ])('原寸が%sなら、Blobの拡張子は%sになる', async (contentType, extension) => {
      const request = createPhotoRequest(formDataWith({ image: imageFile(IMAGE_BYTES, contentType) }));

      const response = await createPhotoHandler(request, mockContext);

      expect(response.status).toBe(201);
      expect((response.jsonBody as any).data.photo.imageUrl).toBe(
        `https://${TEST_BLOB_HOST}/photos/${PHOTO_ID}${extension}?${TEST_SAS_TOKEN}`
      );
      expect(cosmosBackend.documents.get(PHOTO_ID)).toMatchObject({
        blobName: `${PHOTO_ID}${extension}`,
        contentType
      });
      expect(blobStore).toEqual(
        new Map([[`photos/${PHOTO_ID}${extension}`, { content: IMAGE_BYTES, contentType }]])
      );
    });

    // 緯度は -90〜90、経度は -180〜180 で、端の値ちょうども受け付ける。緯度と経度は上限が別なので行を分ける。
    // 範囲を超える値が400になることは、入力検証の表が見ている
    it.each([
      ['緯度が90', '90', '142.365', { latitude: 90, longitude: 142.365 }],
      ['緯度が-90', '-90', '142.365', { latitude: -90, longitude: 142.365 }],
      ['経度が180', '43.7706', '180', { latitude: 43.7706, longitude: 180 }],
      ['経度が-180', '43.7706', '-180', { latitude: 43.7706, longitude: -180 }]
    ])('位置情報の端の値ちょうども受け付け、そのまま保存される（%s）', async (_case, latitude, longitude, expected) => {
      const request = createPhotoRequest(formDataWith({ latitude, longitude }));

      const response = await createPhotoHandler(request, mockContext);

      expect(response.status).toBe(201);
      expect((response.jsonBody as any).data.photo.location).toMatchObject(expected);
      expect(cosmosBackend.documents.get(PHOTO_ID)).toMatchObject({ location: expected });
    });

    it('地名がちょうど100文字なら受け付け、そのまま保存される', async () => {
      // 101文字が400になることは、入力検証の表が見ている
      const placeName = 'あ'.repeat(100);
      const request = createPhotoRequest(formDataWith({ latitude: '43.7706', longitude: '142.365', placeName }));

      const response = await createPhotoHandler(request, mockContext);

      expect(response.status).toBe(201);
      expect((response.jsonBody as any).data.photo.location).toEqual({
        latitude: 43.7706,
        longitude: 142.365,
        placeName,
        placeSource: 'device'
      });
      expect(cosmosBackend.documents.get(PHOTO_ID)).toMatchObject({
        location: { latitude: 43.7706, longitude: 142.365, placeName, placeSource: 'device' }
      });
    });

    it('サムネイルがちょうど1MBなら受け付け、そのまま保存される', async () => {
      // 1バイト超えると413になることは、入力検証の表が見ている
      const request = createPhotoRequest(formDataWith({ thumbnail: imageFile(MAX_THUMBNAIL) }));

      const response = await createPhotoHandler(request, mockContext);

      expect(response.status).toBe(201);
      expect(cosmosBackend.documents.get(PHOTO_ID)).toMatchObject({ thumbnailBlobName: `${PHOTO_ID}.thumb.jpg` });
      expect(blobStore.get(`photos/${PHOTO_ID}.thumb.jpg`)?.content.length).toBe(1048576);
    });

    // サムネイルは JPEG を想定するが、対応形式なら受け付ける。Blob 名の拡張子は原寸と違って形式によらず .thumb.jpg で、
    // Content-Type は送られたものを使う（原寸の Blob 名は Content-Type から決まる。image/png の原寸なら .png）
    it('サムネイルがPNGでも受け付け、.thumb.jpgの名前で、送られた形式のまま保存される', async () => {
      const request = createPhotoRequest(formDataWith({ thumbnail: imageFile(THUMBNAIL_BYTES, 'image/png') }));

      const response = await createPhotoHandler(request, mockContext);

      expect(response.status).toBe(201);
      expect((response.jsonBody as any).data.photo.thumbnailUrl).toBe(
        `https://${TEST_BLOB_HOST}/photos/${PHOTO_ID}.thumb.jpg?${TEST_SAS_TOKEN}`
      );
      expect(cosmosBackend.documents.get(PHOTO_ID)).toMatchObject({ thumbnailBlobName: `${PHOTO_ID}.thumb.jpg` });
      expect(blobStore.get(`photos/${PHOTO_ID}.thumb.jpg`)).toEqual({
        content: THUMBNAIL_BYTES,
        contentType: 'image/png'
      });
    });

    it('地名は、前後の空白も含めて送られたまま保存される', async () => {
      const request = createPhotoRequest(
        formDataWith({ latitude: '43.7706', longitude: '142.365', placeName: ' 旭川 ' })
      );
      const expectedLocation = { latitude: 43.7706, longitude: 142.365, placeName: ' 旭川 ', placeSource: 'device' };

      const response = await createPhotoHandler(request, mockContext);

      expect(response.status).toBe(201);
      expect((response.jsonBody as any).data.photo.location).toEqual(expectedLocation);
      expect(cosmosBackend.documents.get(PHOTO_ID)).toMatchObject({ location: expectedLocation });
    });

    // 写真のURLの有効期限は PHOTO_SAS_EXPIRY_MINUTES（分）で決まり、読めない値なら60分になる。
    // 応答の urlExpiresAt で見る。未設定は delete で作る（process.env.X = undefined は文字列 "undefined" になる）
    it.each([
      ['30分', () => { process.env.PHOTO_SAS_EXPIRY_MINUTES = '30'; }, '2026-10-10T03:42:45.000Z'],
      ['未設定', () => { delete process.env.PHOTO_SAS_EXPIRY_MINUTES; }, '2026-10-10T04:12:45.000Z'],
      ['数字でない値', () => { process.env.PHOTO_SAS_EXPIRY_MINUTES = 'abc'; }, '2026-10-10T04:12:45.000Z'],
      ['0', () => { process.env.PHOTO_SAS_EXPIRY_MINUTES = '0'; }, '2026-10-10T04:12:45.000Z'],
      ['負の値', () => { process.env.PHOTO_SAS_EXPIRY_MINUTES = '-5'; }, '2026-10-10T04:12:45.000Z']
    ])('写真のURLの有効期限は、設定した分数だけ先になり、読めない設定なら60分先になる（%s）', async (_case, configure, expected) => {
      freezeNow('2026-10-10T03:12:45.000Z');
      configure();
      const request = createPhotoRequest(formDataWith());

      const response = await createPhotoHandler(request, mockContext);

      expect(response.status).toBe(201);
      expect((response.jsonBody as any).data.urlExpiresAt).toBe(expected);
    });

    it('写真のURLは発行の5分前から有効で、期限は応答のurlExpiresAtと同じになる', async () => {
      freezeNow('2026-10-10T03:12:45.000Z');
      // 開始時刻（st）と期限（se）を読むため、署名を実 SDK に委譲する。固定トークンでは読めない
      signWithRealSdk();
      const request = createPhotoRequest(formDataWith({ thumbnail: imageFile(THUMBNAIL_BYTES) }));

      const response = await createPhotoHandler(request, mockContext);

      // 原寸とサムネイルの両方の URL を同じ基準で見る
      const { photo, urlExpiresAt } = (response.jsonBody as any).data;
      const urls = [photo.imageUrl, photo.thumbnailUrl];
      expect(response.status).toBe(201);
      expect(urlExpiresAt).toBe('2026-10-10T04:12:45.000Z');
      expect(urls.map((url) => tokenOf(url).get('se'))).toEqual(['2026-10-10T04:12:45Z', '2026-10-10T04:12:45Z']);
      expect(urls.map((url) => tokenOf(url).get('st'))).toEqual(['2026-10-10T03:07:45Z', '2026-10-10T03:07:45Z']);
    });

    // 写真のURLが開けるのは、その写真のBlob1つだけで、権限は読み取りだけ。署名（sig）は HMAC で読めないので、
    // 期待するトークンを実 SDK で作り、URL 全体を比べる。実 SDK は HMAC の計算にだけ使う:
    // 署名する条件（コンテナ・Blob名・権限・開始と期限・アカウント名と鍵）は、すべてこのテストにリテラルで書く。
    // 対象や権限がずれると sig が変わるので、署名のずれはここで落ちる
    it('写真のURLは、その写真のBlobだけを読み取りで開ける署名になっている', async () => {
      freezeNow('2026-10-10T03:12:45.000Z');
      signWithRealSdk();
      const expectedToken = (blobName: string): string => {
        const sdk = realSdk();
        const permissions = new sdk.BlobSASPermissions();
        permissions.read = true;
        return sdk
          .generateBlobSASQueryParameters(
            {
              containerName: 'photos',
              blobName,
              permissions,
              startsOn: new Date('2026-10-10T03:07:45.000Z'),
              expiresOn: new Date('2026-10-10T04:12:45.000Z')
            },
            new sdk.StorageSharedKeyCredential('test', 'testkey==')
          )
          .toString();
      };
      const request = createPhotoRequest(formDataWith({ thumbnail: imageFile(THUMBNAIL_BYTES) }));

      const response = await createPhotoHandler(request, mockContext);

      const { photo } = (response.jsonBody as any).data;
      expect(response.status).toBe(201);
      expect(photo.imageUrl).toBe(
        `https://${TEST_BLOB_HOST}/photos/${PHOTO_ID}.jpg?${expectedToken(`${PHOTO_ID}.jpg`)}`
      );
      expect(photo.thumbnailUrl).toBe(
        `https://${TEST_BLOB_HOST}/photos/${PHOTO_ID}.thumb.jpg?${expectedToken(`${PHOTO_ID}.thumb.jpg`)}`
      );
    });

    // SAS の期限（se）は秒の単位までしか持てない。応答の urlExpiresAt をミリ秒まで出すと、実際の期限の方が
    // 最大1秒早く切れ、クライアントが urlExpiresAt ぎりぎりまで使うと最後の1秒未満で403になる。
    // 期限は秒に切り捨て、urlExpiresAt と se を一致させる。時刻はミリ秒（.678）を持つ値に固定する
    // （他のテストの .000 では、ミリ秒を残してもずれず、この誤りを見逃す）
    it('写真のURLの期限は秒の単位で、応答のurlExpiresAtと実際の期限がずれない', async () => {
      freezeNow('2026-10-10T03:12:45.678Z');
      // 実際の期限（se）を読むため、署名を実 SDK に委譲する。固定トークンでは読めない
      signWithRealSdk();
      const request = createPhotoRequest(formDataWith());

      const response = await createPhotoHandler(request, mockContext);

      const { photo, urlExpiresAt } = (response.jsonBody as any).data;
      expect(response.status).toBe(201);
      expect(urlExpiresAt).toBe('2026-10-10T04:12:45.000Z');
      expect(tokenOf(photo.imageUrl).get('se')).toBe('2026-10-10T04:12:45Z');
    });

    it('画像の内容と写真IDが一致しないと400で理由を返し、Blobにもデータベースにも何も保存しない', async () => {
      // 写真IDの形式は正しい（小文字16進64文字）が、送った画像のSHA-256ではない。
      // サムネイルも付けて、原寸だけでなくサムネイルも書かれないことを見る
      const formData = new FormData();
      formData.append('photoId', OTHER_IMAGE_PHOTO_ID);
      formData.append('image', new File([IMAGE_BYTES], 'IMG_0001.jpg', { type: 'image/jpeg' }));
      formData.append('thumbnail', new File([THUMBNAIL_BYTES], 'IMG_0001.thumb.jpg', { type: 'image/jpeg' }));
      const request = createPhotoRequest(formData);

      const response = await createPhotoHandler(request, mockContext);

      expect(response.status).toBe(400);
      const body = response.jsonBody as any;
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('INVALID_REQUEST');
      expect(body.error.message).toBe('写真IDが画像の内容と一致しません');
      expect(blobStore).toEqual(new Map());
      expect(cosmosBackend.documents).toEqual(new Map());
    });

    it('送り先の旅行を指定すると、その旅行の写真として保存される', async () => {
      cosmosBackend.documents.set(TRIP_ID, tripDocument(TRIP_ID, '北海道 2026秋'));
      const request = createPhotoRequest(formDataWith({ tripId: TRIP_ID }));

      const response = await createPhotoHandler(request, mockContext);

      expect(response.status).toBe(201);
      expect((response.jsonBody as any).data.photo.tripId).toBe(TRIP_ID);
      expect(cosmosBackend.documents.get(PHOTO_ID)).toMatchObject({ type: 'photo', tripId: TRIP_ID });
    });

    it('送り先に指定した旅行が無いと404で理由を返し、Blobにもデータベースにも何も保存しない', async () => {
      // tripId の形式は正しい（UUID）が、その旅行はデータベースに無い（documents は空のまま）。
      // サムネイルも付けて、原寸だけでなくサムネイルも書かれないことを見る
      const request = createPhotoRequest(
        formDataWith({ tripId: TRIP_ID, thumbnail: imageFile(THUMBNAIL_BYTES) })
      );

      const response = await createPhotoHandler(request, mockContext);

      expect(response.status).toBe(404);
      const body = response.jsonBody as any;
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('TRIP_NOT_FOUND');
      expect(body.error.message).toBe('指定された旅行が見つかりません');
      expect(blobStore).toEqual(new Map());
      expect(cosmosBackend.documents).toEqual(new Map());
    });

    it('同じ写真をもう一度送ると、200で保存済みの写真を返し、画像は上書きしない', async () => {
      freezeNow('2026-10-10T03:12:45.000Z');
      // 保存済みの写真。送る内容と区別できるよう、旅行に属さず（tripId: null）、サムネイルも無く、
      // 保存後に利用者が付けたカテゴリ・タグ・コメントがあり、画像のバイト列も送るものと違う
      const savedBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
      const savedFields: Omit<PhotoDocument, 'type' | 'blobName' | 'thumbnailBlobName'> = {
        id: PHOTO_ID,
        tripId: null,
        contentType: 'image/jpeg',
        fileSize: 12,
        takenAt: '2026-09-20T08:15:30',
        takenAtSource: 'exif',
        sortAt: '2026-09-20T08:15:30',
        location: { latitude: 35.6586, longitude: 139.7454, placeName: '東京都港区', placeSource: 'device' },
        category: 'food',
        tags: ['朝食'],
        comment: 'ホテルの朝食',
        commentSource: 'user',
        hint: null,
        classification: null,
        identification: null,
        processing: { state: 'none', step: null, attempts: 0, lastError: null, updatedAt: null },
        uploadedAt: '2026-09-21T01:00:00.000Z',
        updatedAt: '2026-09-22T02:30:00.000Z'
      };
      const savedPhoto = photoDocument(PHOTO_ID, {
        ...savedFields,
        blobName: `${PHOTO_ID}.jpg`,
        thumbnailBlobName: null
      });
      // データベースに入っているドキュメントには、Cosmos のシステム項目が付いている
      const storedPhoto = { ...savedPhoto, ...COSMOS_SYSTEM_FIELDS };
      cosmosBackend.documents.set(PHOTO_ID, { ...storedPhoto });
      cosmosBackend.documents.set(TRIP_ID, tripDocument(TRIP_ID, '北海道 2026秋'));
      blobStore.set(`photos/${PHOTO_ID}.jpg`, { content: savedBytes, contentType: 'image/jpeg' });
      // 旅行（tripId）とサムネイルを付けて、同じ写真（同じ photoId・同じ画像）をもう一度送る
      const request = createPhotoRequest(
        formDataWith({ tripId: TRIP_ID, thumbnail: imageFile(THUMBNAIL_BYTES) })
      );

      const response = await createPhotoHandler(request, mockContext);

      // 応答: 保存済みの内容がそのまま返る（システム項目は含まない）。tripId は null のまま（送った旅行に入れ替えない）で、
      // 保存済みの写真にサムネイルは無いので thumbnailUrl は null
      expect(response.status).toBe(200);
      expect(response.jsonBody).toEqual({
        success: true,
        data: {
          photo: {
            ...savedFields,
            imageUrl: `https://${TEST_BLOB_HOST}/photos/${PHOTO_ID}.jpg?${TEST_SAS_TOKEN}`,
            thumbnailUrl: null
          },
          urlExpiresAt: '2026-10-10T04:12:45.000Z'
        }
      });
      // 状態: 画像は保存済みの中身のまま、サムネイルの Blob は作られず、ドキュメントも変わらない
      expect(blobStore).toEqual(
        new Map([[`photos/${PHOTO_ID}.jpg`, { content: savedBytes, contentType: 'image/jpeg' }]])
      );
      expect(cosmosBackend.documents.get(PHOTO_ID)).toEqual(storedPhoto);
    });

    it('保存済みの写真を再送したときは、送り先の旅行が消えていても、200で保存済みの写真を返す', async () => {
      // 「送信に成功したが応答が届かず、その間に送り先の旅行が消され、同じ写真を同じ旅行付きで再送した」状態。
      // 保存済みの写真は旅行（TRIP_ID）に入れて保存したもので、偽物には旅行のドキュメントを置かない（消えた後）。
      // 同じ写真は何度送っても1枚（冪等）なので、旅行の有無にかかわらず保存済みのものがそのまま返る
      const savedPhoto = photoDocument(PHOTO_ID, {
        tripId: TRIP_ID,
        blobName: `${PHOTO_ID}.jpg`,
        thumbnailBlobName: null
      });
      cosmosBackend.documents.set(PHOTO_ID, { ...savedPhoto });
      const request = createPhotoRequest(formDataWith({ tripId: TRIP_ID }));

      const response = await createPhotoHandler(request, mockContext);

      expect(response.status).toBe(200);
      expect((response.jsonBody as any).data.photo.id).toBe(PHOTO_ID);
      expect(cosmosBackend.documents).toEqual(new Map([[PHOTO_ID, savedPhoto]]));
    });

    it('同じ写真がほぼ同時に送られ、保存の直前に別の送信が先に作っていたら、200で先に作られた写真を返す', async () => {
      freezeNow('2026-10-10T03:12:45.000Z');
      // 先に作られた写真。この送信が作るものとは、uploadedAt / updatedAt（と、そこから決まる sortAt）が
      // 1秒前であることだけが違う。応答がどちらの内容かをそこで区別する
      const firstFields: Omit<PhotoDocument, 'type' | 'blobName' | 'thumbnailBlobName'> = {
        id: PHOTO_ID,
        tripId: null,
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
      const firstCreated = photoDocument(PHOTO_ID, {
        ...firstFields,
        blobName: `${PHOTO_ID}.jpg`,
        thumbnailBlobName: null
      });
      // この送信が写真を読んだ時点では無く、ドキュメントを作る直前に別の送信が作る。
      // データベースに入ったドキュメントには、Cosmos のシステム項目が付いている
      const firstStored = { ...firstCreated, ...COSMOS_SYSTEM_FIELDS };
      cosmosBackend.beforeCreate = () => {
        cosmosBackend.documents.set(PHOTO_ID, { ...firstStored });
      };
      const request = createPhotoRequest(formDataWith());

      const response = await createPhotoHandler(request, mockContext);

      expect(response.status).toBe(200);
      expect(response.jsonBody).toEqual({
        success: true,
        data: {
          photo: {
            ...firstFields,
            imageUrl: `https://${TEST_BLOB_HOST}/photos/${PHOTO_ID}.jpg?${TEST_SAS_TOKEN}`,
            thumbnailUrl: null
          },
          urlExpiresAt: '2026-10-10T04:12:45.000Z'
        }
      });
      // 状態: 写真のドキュメントは先に作られた1件のまま（この送信のもので置き換わらない）
      expect(cosmosBackend.documents).toEqual(new Map([[PHOTO_ID, firstStored]]));
    });

    // データベースの失敗する箇所（写真を読む・写真を作る）ごとに同じ分類の表を回す。どちらで失敗しても応答は同じになる。
    // 作成の失敗の表には 409 の行が無い。409 は「先に作られていた」で、別のテストで確かめている。
    // 409 以外の作成の失敗が握りつぶされず、ここで 503 / 500 になることも、この表が見ている
    const failurePoints: [string, (backend: FakeCosmosBackend<FakeCosmosDocument>, error: Error) => void][] = [
      ['写真の読み取りで', (backend, error) => { backend.forcedReadError = error; }],
      ['写真の作成で', (backend, error) => { backend.forcedCreateError = error; }]
    ];
    const failureRows = failurePoints.flatMap(([point, inject]) =>
      databaseFailureCases('写真の保存に失敗しました').map(
        ([caseName, error, status, code, message]) =>
          [`${point}、${caseName}`, inject, error, status, code, message] as const
      )
    );

    it.each(failureRows)(
      '写真を保存するとき、%s（写真のドキュメントは作られない）',
      async (_case, inject, error, status, code, message) => {
        inject(cosmosBackend, error);
        const request = createPhotoRequest(formDataWith());

        const response = await createPhotoHandler(request, mockContext);

        expect(response.status).toBe(status);
        const body = response.jsonBody as any;
        expect(body.success).toBe(false);
        expect(body.error.code).toBe(code);
        expect(body.error.message).toBe(message);
        expect(cosmosBackend.documents).toEqual(new Map());
      }
    );

    // 画像の保存先（Blob Storage）の失敗。実 SDK が投げる形を再現する（実装の判定に合わせた文字列は作らない）:
    // - 接続できたうえでの失敗は RestError（name・HTTP ステータス・Storage のエラーコード）で、
    //   ネットワーク系の code は持たない。message は英語の文で、"Storage" を含むとは限らない
    // - 接続できない失敗は、Azure の transport が errno を RestError の code に直接載せる
    const storageRejected = () =>
      Object.assign(new Error('This request is not authorized to perform this operation.'), {
        name: 'RestError',
        statusCode: 403,
        code: 'AuthorizationFailure'
      });
    const storageUnreachable = (errno: string) =>
      Object.assign(new Error(`接続に失敗しました (${errno})`), { name: 'RestError', code: errno });
    const STORAGE_FAILED = 'ストレージサービスでエラーが発生しました';
    const STORAGE_UNREACHABLE = 'ストレージサービスに接続できません';
    const storageFailureCases: [string, (backend: FakeBlobBackend) => void, number, string][] = [
      [
        '原寸のアップロードが保存先のエラー応答で失敗したときは、502を返す',
        (backend) => { backend.forcedUploadError = storageRejected(); },
        502,
        STORAGE_FAILED
      ],
      // 接続できない errno の一覧は utils/response.ts の共通設定で、全部を通すのは upload.test.ts。
      // ここは写真の保存の Blob の失敗が、その共通設定を通って 503 になることだけを見るので、1つで足りる
      [
        '原寸のアップロードがENOTFOUNDで失敗したときは、接続できないエラー（503）を返す',
        (backend) => { backend.forcedUploadError = storageUnreachable('ENOTFOUND'); },
        503,
        STORAGE_UNREACHABLE
      ],
      // 原寸とサムネイルは同じコンテナなので、サムネイルの Blob 名だけを失敗させる（原寸は書き込み済み）
      [
        'サムネイルのアップロードだけが保存先のエラー応答で失敗したときは、502を返す',
        (backend) => { backend.forcedUploadErrorByKey = { [`photos/${PHOTO_ID}.thumb.jpg`]: storageRejected() }; },
        502,
        STORAGE_FAILED
      ]
    ];

    it.each(storageFailureCases)(
      '写真の保存で、画像の保存先が失敗したら理由を返し、写真のドキュメントは作られない（%s）',
      async (_case, inject, status, message) => {
        inject(blobBackend);
        const request = createPhotoRequest(formDataWith({ thumbnail: imageFile(THUMBNAIL_BYTES) }));

        const response = await createPhotoHandler(request, mockContext);

        expect(response.status).toBe(status);
        const body = response.jsonBody as any;
        expect(body.success).toBe(false);
        expect(body.error.code).toBe('STORAGE_ERROR');
        expect(body.error.message).toBe(message);
        expect(cosmosBackend.documents).toEqual(new Map());
      }
    );

    // 05 §5.1 の入力検証の表（1〜17）と、multipart として読み取れない場合。18（SHA-256 の照合）は上のテスト。
    // 各行は「正しい送信内容」から1か所だけ壊す。行は表の順に並べ、最後に検証の順序を確かめる行を置く。
    // 要求は行ごとに作る（10MB の画像を、使わない行の分まで先に作らないため）
    const INVALID = 'INVALID_REQUEST';
    const UNSUPPORTED = 'UNSUPPORTED_MEDIA_TYPE';
    const TOO_LARGE = 'FILE_TOO_LARGE';
    const UNSUPPORTED_MESSAGE = 'サポートされていない画像形式です';
    const LOCATION = { latitude: '43.7706', longitude: '142.365' };
    const invalidInputCases: [string, () => HttpRequest, number, string, string][] = [
      // 1: Content-Type
      [
        'Content-Typeがmultipart/form-dataではない',
        () => createPhotoRequest(formDataWith(), new Map([['content-type', 'application/json']])),
        400,
        INVALID,
        'Content-Typeがmultipart/form-dataではありません'
      ],
      [
        'Content-Typeヘッダが無い',
        () => createPhotoRequest(formDataWith(), new Map()),
        400,
        INVALID,
        'Content-Typeがmultipart/form-dataではありません'
      ],
      // multipart として読み取れない（実際に undici が投げる形）
      [
        'multipartとして読み取れない',
        () =>
          createRequest(
            multipartHeaders(),
            jest.fn().mockRejectedValue(new TypeError('Could not parse content as FormData.'))
          ),
        400,
        INVALID,
        'ファイルの読み取りに失敗しました'
      ],
      // 2: photoId が未指定・空
      ['photoIdが未指定', () => createPhotoRequest(formDataWith({ photoId: undefined })), 400, INVALID, '写真IDが指定されていません'],
      ['photoIdが空', () => createPhotoRequest(formDataWith({ photoId: '' })), 400, INVALID, '写真IDが指定されていません'],
      [
        'photoIdがファイルとして送られた',
        () => createPhotoRequest(formDataWith({ photoId: imageFile(THUMBNAIL_BYTES) })),
        400,
        INVALID,
        '写真IDが指定されていません'
      ],
      // 3: photoId の形式
      [
        'photoIdが大文字の16進',
        () => createPhotoRequest(formDataWith({ photoId: PHOTO_ID.toUpperCase() })),
        400,
        INVALID,
        '写真IDの形式が無効です'
      ],
      [
        'photoIdが63文字',
        () => createPhotoRequest(formDataWith({ photoId: PHOTO_ID.slice(1) })),
        400,
        INVALID,
        '写真IDの形式が無効です'
      ],
      [
        'photoIdが65文字',
        () => createPhotoRequest(formDataWith({ photoId: `${PHOTO_ID}0` })),
        400,
        INVALID,
        '写真IDの形式が無効です'
      ],
      [
        'photoIdに16進でない文字が入っている',
        () => createPhotoRequest(formDataWith({ photoId: `g${PHOTO_ID.slice(1)}` })),
        400,
        INVALID,
        '写真IDの形式が無効です'
      ],
      // 4: image が未指定・テキスト
      ['imageが未指定', () => createPhotoRequest(formDataWith({ image: undefined })), 400, INVALID, '画像ファイルが指定されていません'],
      [
        'imageがテキストで送られた',
        () => createPhotoRequest(formDataWith({ image: 'not-a-file' })),
        400,
        INVALID,
        '画像ファイルが指定されていません'
      ],
      // 5: image の形式
      [
        'imageがBMP',
        () => createPhotoRequest(formDataWith({ image: imageFile(IMAGE_BYTES, 'image/bmp') })),
        415,
        UNSUPPORTED,
        UNSUPPORTED_MESSAGE
      ],
      [
        'imageのContent-Typeが空',
        () => createPhotoRequest(formDataWith({ image: imageFile(IMAGE_BYTES, '') })),
        415,
        UNSUPPORTED,
        UNSUPPORTED_MESSAGE
      ],
      // 6: image が空
      [
        'imageが0バイト',
        () => createPhotoRequest(formDataWith({ image: imageFile(new Uint8Array(0)) })),
        400,
        INVALID,
        '画像ファイルが空です'
      ],
      // 7: image が大きすぎる（上限は10MB）
      [
        'imageが上限を1バイト超える',
        () => createPhotoRequest(formDataWith({ image: imageFile(OVER_MAX_IMAGE) })),
        413,
        TOO_LARGE,
        'ファイルサイズが大きすぎます'
      ],
      // 8: thumbnail がファイルでない
      [
        'thumbnailがテキストで送られた',
        () => createPhotoRequest(formDataWith({ thumbnail: 'not-a-file' })),
        400,
        INVALID,
        'サムネイルはファイルで送信してください'
      ],
      // 9: thumbnail の形式
      [
        'thumbnailがBMP',
        () => createPhotoRequest(formDataWith({ thumbnail: imageFile(THUMBNAIL_BYTES, 'image/bmp') })),
        415,
        UNSUPPORTED,
        UNSUPPORTED_MESSAGE
      ],
      // 10: thumbnail が空
      [
        'thumbnailが0バイト',
        () => createPhotoRequest(formDataWith({ thumbnail: imageFile(new Uint8Array(0)) })),
        400,
        INVALID,
        'サムネイルが空です'
      ],
      // 11: thumbnail が大きすぎる（上限は1MB）
      [
        'thumbnailが上限を1バイト超える',
        () => createPhotoRequest(formDataWith({ thumbnail: imageFile(OVER_MAX_THUMBNAIL) })),
        413,
        TOO_LARGE,
        'サムネイルのサイズが大きすぎます'
      ],
      // 12: tripId の形式
      ['tripIdがUUIDでない', () => createPhotoRequest(formDataWith({ tripId: 'not-a-uuid' })), 400, INVALID, '旅行IDの形式が無効です'],
      // 13: takenAt の形式と実在
      [
        'takenAtが日付だけ',
        () => createPhotoRequest(formDataWith({ takenAt: '2026-10-05' })),
        400,
        INVALID,
        '撮影日時の形式が無効です'
      ],
      [
        'takenAtにタイムゾーンが付いている',
        () => createPhotoRequest(formDataWith({ takenAt: '2026-10-05T12:30:15Z' })),
        400,
        INVALID,
        '撮影日時の形式が無効です'
      ],
      [
        'takenAtが存在しない日付（2月30日）',
        () => createPhotoRequest(formDataWith({ takenAt: '2026-02-30T12:00:00' })),
        400,
        INVALID,
        '撮影日時の形式が無効です'
      ],
      [
        'takenAtが存在しない時刻（25時）',
        () => createPhotoRequest(formDataWith({ takenAt: '2026-10-05T25:00:00' })),
        400,
        INVALID,
        '撮影日時の形式が無効です'
      ],
      [
        'takenAtが存在しない時刻（分が60）',
        () => createPhotoRequest(formDataWith({ takenAt: '2026-10-05T12:60:00' })),
        400,
        INVALID,
        '撮影日時の形式が無効です'
      ],
      // 14: 緯度・経度の片方だけ
      [
        'latitudeだけがある',
        () => createPhotoRequest(formDataWith({ latitude: '43.7706' })),
        400,
        INVALID,
        '緯度と経度は両方指定してください'
      ],
      [
        'longitudeだけがある',
        () => createPhotoRequest(formDataWith({ longitude: '142.365' })),
        400,
        INVALID,
        '緯度と経度は両方指定してください'
      ],
      // 15: 緯度・経度が数値でない、または範囲外
      [
        'latitudeが数値でない',
        () => createPhotoRequest(formDataWith({ latitude: 'abc', longitude: '142.365' })),
        400,
        INVALID,
        '位置情報の形式が無効です'
      ],
      [
        'latitudeが空文字',
        () => createPhotoRequest(formDataWith({ latitude: '', longitude: '142.365' })),
        400,
        INVALID,
        '位置情報の形式が無効です'
      ],
      [
        'latitudeがファイルとして送られた',
        () => createPhotoRequest(formDataWith({ latitude: imageFile(THUMBNAIL_BYTES), longitude: '142.365' })),
        400,
        INVALID,
        '位置情報の形式が無効です'
      ],
      [
        'latitudeがNaN',
        () => createPhotoRequest(formDataWith({ latitude: 'NaN', longitude: '142.365' })),
        400,
        INVALID,
        '位置情報の形式が無効です'
      ],
      [
        'longitudeがInfinity',
        () => createPhotoRequest(formDataWith({ latitude: '43.7706', longitude: 'Infinity' })),
        400,
        INVALID,
        '位置情報の形式が無効です'
      ],
      [
        'latitudeが90を超える',
        () => createPhotoRequest(formDataWith({ latitude: '90.0001', longitude: '142.365' })),
        400,
        INVALID,
        '位置情報の形式が無効です'
      ],
      [
        'latitudeが-90を下回る',
        () => createPhotoRequest(formDataWith({ latitude: '-90.0001', longitude: '142.365' })),
        400,
        INVALID,
        '位置情報の形式が無効です'
      ],
      [
        'longitudeが180を超える',
        () => createPhotoRequest(formDataWith({ latitude: '43.7706', longitude: '180.0001' })),
        400,
        INVALID,
        '位置情報の形式が無効です'
      ],
      [
        'longitudeが-180を下回る',
        () => createPhotoRequest(formDataWith({ latitude: '43.7706', longitude: '-180.0001' })),
        400,
        INVALID,
        '位置情報の形式が無効です'
      ],
      // 16: 地名だけで緯度・経度が無い
      [
        'placeNameがあり緯度・経度が無い',
        () => createPhotoRequest(formDataWith({ placeName: '北海道旭川市' })),
        400,
        INVALID,
        '地名は緯度・経度と一緒に指定してください'
      ],
      // 17: 地名が空白のみ、または長すぎる
      [
        'placeNameが空白のみ',
        () => createPhotoRequest(formDataWith({ ...LOCATION, placeName: '   ' })),
        400,
        INVALID,
        '地名は100文字以内で指定してください'
      ],
      [
        'placeNameがファイルとして送られた',
        () => createPhotoRequest(formDataWith({ ...LOCATION, placeName: imageFile(THUMBNAIL_BYTES) })),
        400,
        INVALID,
        '地名は100文字以内で指定してください'
      ],
      [
        'placeNameが101文字',
        () => createPhotoRequest(formDataWith({ ...LOCATION, placeName: 'あ'.repeat(101) })),
        400,
        INVALID,
        '地名は100文字以内で指定してください'
      ],
      // 長さは前後の空白も含めて数える（空白を除くと99文字だが、送られたまま保存するので101文字として弾く）
      [
        'placeNameが前後の空白込みで101文字',
        () => createPhotoRequest(formDataWith({ ...LOCATION, placeName: ` ${'あ'.repeat(99)} ` })),
        400,
        INVALID,
        '地名は100文字以内で指定してください'
      ],
      // 検証の順序: 最初に失敗した1件だけを返す
      [
        '順序: photoIdが不正でimageも無ければ、photoIdを指摘する',
        () => createPhotoRequest(formDataWith({ photoId: 'abc', image: undefined })),
        400,
        INVALID,
        '写真IDの形式が無効です'
      ],
      [
        '順序: imageがBMPで0バイトなら、形式を指摘する',
        () => createPhotoRequest(formDataWith({ image: imageFile(new Uint8Array(0), 'image/bmp') })),
        415,
        UNSUPPORTED,
        UNSUPPORTED_MESSAGE
      ],
      [
        '順序: thumbnailが大きすぎてtripIdも不正なら、thumbnailを指摘する',
        () =>
          createPhotoRequest(formDataWith({ thumbnail: imageFile(OVER_MAX_THUMBNAIL), tripId: 'not-a-uuid' })),
        413,
        TOO_LARGE,
        'サムネイルのサイズが大きすぎます'
      ],
      [
        '順序: tripIdとtakenAtがともに不正なら、tripIdを指摘する',
        () => createPhotoRequest(formDataWith({ tripId: 'not-a-uuid', takenAt: 'yesterday' })),
        400,
        INVALID,
        '旅行IDの形式が無効です'
      ],
      // 写真IDが画像の内容と一致しないこと（18）は、他の検証をすべて通った後にだけ見る
      [
        '順序: placeNameが101文字でphotoIdも画像と一致しなければ、placeNameを指摘する',
        () =>
          createPhotoRequest(
            formDataWith({ photoId: OTHER_IMAGE_PHOTO_ID, ...LOCATION, placeName: 'あ'.repeat(101) })
          ),
        400,
        INVALID,
        '地名は100文字以内で指定してください'
      ]
    ];

    it.each(invalidInputCases)(
      '入力が正しくなければ理由を返し、Blobにもデータベースにも何も保存しない（%s）',
      async (_case, buildRequest, status, code, message) => {
        const request = buildRequest();

        const response = await createPhotoHandler(request, mockContext);

        expect(response.status).toBe(status);
        const body = response.jsonBody as any;
        expect(body.success).toBe(false);
        expect(body.error.code).toBe(code);
        expect(body.error.message).toBe(message);
        expect(blobStore).toEqual(new Map());
        expect(cosmosBackend.documents).toEqual(new Map());
      }
    );

    // 緯度・経度は10進の数（符号は先頭の - だけ）しか受け付けない。どの行も JavaScript の Number() なら
    // 読める形で、値も範囲（緯度 ±90）の中に収まる（26・10・15・43.7・10・43.7）ので、範囲の検証では弾かれず、
    // 形の検証でだけ弾かれる。経度は正しい値のままにして、緯度の形だけを壊す
    it.each([
      ['16進', '0x1A'],
      ['2進', '0b1010'],
      ['8進', '0o17'],
      ['前後に空白がある', ' 43.7 '],
      ['指数表記', '1e1'],
      ['先頭に+がある', '+43.7']
    ])(
      '緯度・経度が10進の数でなければ、400で位置情報の形式が無効ですを返し、何も保存しない（緯度が%s）',
      async (_case, latitude) => {
        const request = createPhotoRequest(formDataWith({ latitude, longitude: '142.365' }));

        const response = await createPhotoHandler(request, mockContext);

        expect(response.status).toBe(400);
        const body = response.jsonBody as any;
        expect(body.success).toBe(false);
        expect(body.error.code).toBe('INVALID_REQUEST');
        expect(body.error.message).toBe('位置情報の形式が無効です');
        expect(blobStore).toEqual(new Map());
        expect(cosmosBackend.documents).toEqual(new Map());
      }
    );
  });
});
