import { HttpRequest, InvocationContext } from '@azure/functions';
import { CosmosClient } from '@azure/cosmos';
import { BlobServiceClient, generateBlobSASQueryParameters } from '@azure/storage-blob';
import { createPhotoHandler } from '../../src/functions/photos';
import { TripDocument } from '../../src/types/album';
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

type PhotoParts = Record<string, string | File | undefined>;

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

const jpegFile = (bytes: Uint8Array | Buffer = IMAGE_BYTES, type = 'image/jpeg'): File =>
  new File([bytes], 'photo', { type });

// 上限は既定値（原寸 10MB = 10485760、サムネイル 1MB = 1048576）。ちょうど1バイト超える大きさ
const OVER_MAX_IMAGE = new Uint8Array(10485761);
const OVER_MAX_THUMBNAIL = new Uint8Array(1048577);

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
      const trip: TripDocument = {
        id: TRIP_ID,
        type: 'trip',
        name: '北海道 2026秋',
        description: null,
        tags: [],
        createdAt: '2026-10-04T09:00:00.000Z',
        updatedAt: '2026-10-04T09:00:00.000Z'
      };
      cosmosBackend.documents.set(trip.id, trip);
      const request = createPhotoRequest(formDataWith({ tripId: TRIP_ID }));

      const response = await createPhotoHandler(request, mockContext);

      expect(response.status).toBe(201);
      expect((response.jsonBody as any).data.photo.tripId).toBe(TRIP_ID);
      expect(cosmosBackend.documents.get(PHOTO_ID)).toMatchObject({ type: 'photo', tripId: TRIP_ID });
    });

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
        () => createPhotoRequest(formDataWith({ photoId: jpegFile(THUMBNAIL_BYTES) })),
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
        () => createPhotoRequest(formDataWith({ image: jpegFile(IMAGE_BYTES, 'image/bmp') })),
        415,
        UNSUPPORTED,
        UNSUPPORTED_MESSAGE
      ],
      [
        'imageのContent-Typeが空',
        () => createPhotoRequest(formDataWith({ image: jpegFile(IMAGE_BYTES, '') })),
        415,
        UNSUPPORTED,
        UNSUPPORTED_MESSAGE
      ],
      // 6: image が空
      [
        'imageが0バイト',
        () => createPhotoRequest(formDataWith({ image: jpegFile(new Uint8Array(0)) })),
        400,
        INVALID,
        '画像ファイルが空です'
      ],
      // 7: image が大きすぎる（上限は10MB）
      [
        'imageが上限を1バイト超える',
        () => createPhotoRequest(formDataWith({ image: jpegFile(OVER_MAX_IMAGE) })),
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
        () => createPhotoRequest(formDataWith({ thumbnail: jpegFile(THUMBNAIL_BYTES, 'image/bmp') })),
        415,
        UNSUPPORTED,
        UNSUPPORTED_MESSAGE
      ],
      // 10: thumbnail が空
      [
        'thumbnailが0バイト',
        () => createPhotoRequest(formDataWith({ thumbnail: jpegFile(new Uint8Array(0)) })),
        400,
        INVALID,
        'サムネイルが空です'
      ],
      // 11: thumbnail が大きすぎる（上限は1MB）
      [
        'thumbnailが上限を1バイト超える',
        () => createPhotoRequest(formDataWith({ thumbnail: jpegFile(OVER_MAX_THUMBNAIL) })),
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
        'placeNameが101文字',
        () => createPhotoRequest(formDataWith({ ...LOCATION, placeName: 'あ'.repeat(101) })),
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
        () => createPhotoRequest(formDataWith({ image: jpegFile(new Uint8Array(0), 'image/bmp') })),
        415,
        UNSUPPORTED,
        UNSUPPORTED_MESSAGE
      ],
      [
        '順序: thumbnailが大きすぎてtripIdも不正なら、thumbnailを指摘する',
        () =>
          createPhotoRequest(formDataWith({ thumbnail: jpegFile(OVER_MAX_THUMBNAIL), tripId: 'not-a-uuid' })),
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
  });
});
