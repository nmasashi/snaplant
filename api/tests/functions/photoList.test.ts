import { HttpRequest, InvocationContext } from '@azure/functions';
import { CosmosClient } from '@azure/cosmos';
import { BlobServiceClient, generateBlobSASQueryParameters } from '@azure/storage-blob';
import { listPhotosHandler } from '../../src/functions/photos';
import { PhotoDocument } from '../../src/types/album';
import { FakeCosmosBackend, FakeCosmosDocument, createFakeContainer } from '../fakes/cosmos';
import { BlobEntry, FakeBlobBackend, TEST_BLOB_HOST, createFakeBlobServiceClient } from '../fakes/blob';
import { COSMOS_SYSTEM_FIELDS, photoDocument, tripDocument } from '../helpers/albumDocuments';
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

// 旅行の id（UUID v4 の形）
const TRIP_A_ID = '123e4567-e89b-42d3-a456-426614174000';
const TRIP_B_ID = '223e4567-e89b-42d3-a456-426614174001';
// 既に消えた旅行の id。この id の旅行のドキュメントはテストでも置かない
const TRIP_DELETED_ID = '323e4567-e89b-42d3-a456-426614174002';

// 写真の id（小文字16進 64 文字）。一覧では画像のバイト列は使わないので、写真を見分けられる値にしている
const PHOTO_A1_ID = '1'.repeat(64);
const PHOTO_A2_ID = '2'.repeat(64);
const PHOTO_B1_ID = '3'.repeat(64);
const PHOTO_UNASSIGNED_ID = '4'.repeat(64);
const PHOTO_UNASSIGNED_2_ID = '5'.repeat(64);
const PHOTO_ORPHAN_ID = '6'.repeat(64);
const PHOTO_WITHOUT_TRIP_FIELD_ID = '7'.repeat(64);
const PHOTO_A3_ID = '8'.repeat(64);

/** 写真の項目のうち、ドキュメントと応答で共通のもの */
type PhotoFields = Omit<PhotoDocument, 'type' | 'blobName' | 'thumbnailBlobName'>;

/**
 * 保存済みの写真のドキュメント。原寸とサムネイルの Blob 名は `<id>.jpg` / `<id>.thumb.jpg` で、
 * 応答の URL の期待がこの名前に基づくので、ここで決める。ほかは、テストごとに変えたい項目だけ overrides で上書きする
 */
const storedPhoto = (id: string, tripId: string | null, overrides: Partial<PhotoDocument> = {}): PhotoDocument =>
  photoDocument(id, { tripId, blobName: `${id}.jpg`, thumbnailBlobName: `${id}.thumb.jpg`, ...overrides });

/** 写真のドキュメントから、応答の写真と共通の項目だけを取り出す（type と Blob 名は応答に出ない） */
const responseFieldsOf = (doc: PhotoDocument): PhotoFields => {
  const { type: _type, blobName: _blobName, thumbnailBlobName: _thumbnailBlobName, ...fields } = doc;
  // カテゴリを手で決めた印は、項目の無い写真でも null で返る（02 §5 #53）。お気に入りの印の無い写真は false（02 §5 #63）
  return { ...fields, categorySource: null, favorite: fields.favorite ?? false };
};

/**
 * 写真の一覧の要求。query は実際の HttpRequest と同じ URLSearchParams にする
 * （Map だと、無い項目の get が null ではなく undefined を返し、実際と違う）
 */
const createListPhotosRequest = (query: Record<string, string>): HttpRequest => {
  const searchParams = new URLSearchParams({ code: 'test-key', ...query });
  return {
    method: 'GET',
    url: `https://func-snaplant.azurewebsites.net/api/photos?${searchParams.toString()}`,
    query: searchParams,
    headers: new Map(),
    params: {}
  } as any as HttpRequest;
};

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

describe('写真一覧API', () => {
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

    // 写真の一覧では Blob の中身は読まない。URL を組み立てるために偽物のサービスクライアントが要る
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

  describe('写真一覧取得API', () => {
    it('旅行を指定して写真の一覧を取り出すと、その旅行の写真だけが表示用のURL付きで返る', async () => {
      freezeNow('2026-10-10T03:12:45.000Z');
      // 旅行 A・B と、A の写真2枚・B の写真1枚・どの旅行にも属さない写真1枚。
      // A の写真が連続しない順で置き、旅行での絞り込みが効いていないと他の写真が混ざるようにする。
      // 偽物は ORDER BY を解釈せず挿入順で返すので、A の2枚は sortAt の昇順になる順（A1 → A2）で置く。
      // A の2枚は項目ごとに違う値を入れ、2枚目に1枚目の値が使い回される誤りも区別できるようにする
      const photoA1 = storedPhoto(PHOTO_A1_ID, TRIP_A_ID, {
        fileSize: 2345678,
        takenAt: '2026-10-05T09:00:00',
        takenAtSource: 'exif',
        sortAt: '2026-10-05T09:00:00',
        location: { latitude: 43.7706, longitude: 142.365, placeName: '北海道旭川市', placeSource: 'device' },
        category: 'landscape',
        tags: [{ name: '朝', kind: 'food', x: 0.5, y: 0.5, source: 'user' }],
        comment: 'ホテルの窓からの眺め',
        commentSource: 'user'
      });
      const photoA2 = storedPhoto(PHOTO_A2_ID, TRIP_A_ID, {
        contentType: 'image/png',
        fileSize: 345678,
        takenAt: '2026-10-06T12:30:15',
        takenAtSource: 'exif',
        sortAt: '2026-10-06T12:30:15',
        category: 'food',
        tags: [{ name: '昼食', kind: 'food', x: 0.5, y: 0.5, source: 'user' }, { name: '旅館', kind: 'food', x: 0.5, y: 0.5, source: 'user' }],
        uploadedAt: '2026-10-09T01:00:00.000Z',
        updatedAt: '2026-10-09T02:30:00.000Z'
      });
      cosmosBackend.documents.set(TRIP_A_ID, tripDocument(TRIP_A_ID, '北海道 2026秋'));
      cosmosBackend.documents.set(TRIP_B_ID, tripDocument(TRIP_B_ID, '京都 2026冬'));
      cosmosBackend.documents.set(PHOTO_A1_ID, { ...photoA1, ...COSMOS_SYSTEM_FIELDS });
      cosmosBackend.documents.set(PHOTO_B1_ID, { ...storedPhoto(PHOTO_B1_ID, TRIP_B_ID), ...COSMOS_SYSTEM_FIELDS });
      cosmosBackend.documents.set(PHOTO_UNASSIGNED_ID, {
        ...storedPhoto(PHOTO_UNASSIGNED_ID, null),
        ...COSMOS_SYSTEM_FIELDS
      });
      cosmosBackend.documents.set(PHOTO_A2_ID, { ...photoA2, ...COSMOS_SYSTEM_FIELDS });
      const request = createListPhotosRequest({ tripId: TRIP_A_ID });

      const response = await listPhotosHandler(request, mockContext);

      // 各写真は blobName / thumbnailBlobName / type と Cosmos のシステム項目（_rid・_etag など）を含まず、
      // 代わりに SAS 付きの URL が付く。写真の項目は完全一致で見る（余分な項目が混ざっても、足りなくても落ちる）。
      // 1ページに収まるので continuationToken は null。total は返さない
      expect(response.status).toBe(200);
      expect(response.jsonBody).toEqual({
        success: true,
        data: {
          photos: [
            {
              ...responseFieldsOf(photoA1),
              imageUrl: `https://${TEST_BLOB_HOST}/photos/${PHOTO_A1_ID}.jpg?${TEST_SAS_TOKEN}`,
              thumbnailUrl: `https://${TEST_BLOB_HOST}/photos/${PHOTO_A1_ID}.thumb.jpg?${TEST_SAS_TOKEN}`
            },
            {
              ...responseFieldsOf(photoA2),
              imageUrl: `https://${TEST_BLOB_HOST}/photos/${PHOTO_A2_ID}.jpg?${TEST_SAS_TOKEN}`,
              thumbnailUrl: `https://${TEST_BLOB_HOST}/photos/${PHOTO_A2_ID}.thumb.jpg?${TEST_SAS_TOKEN}`
            }
          ],
          continuationToken: null,
          urlExpiresAt: '2026-10-10T04:12:45.000Z'
        }
      });
    });

    it('どの旅行にも属さない写真を一覧で取り出すと、tripIdがnullの写真だけが返る', async () => {
      freezeNow('2026-10-10T03:12:45.000Z');
      // 返るのは tripId が null の2枚（U1・U2）。これを挟んで、返してはいけない写真を3通り置く。
      //  - 旅行 A の写真（旅行は存在する）
      //  - 消えた旅行を指す写真（旅行の削除と送信が重なって残った。旅行のドキュメントは無い）
      //  - tripId の項目そのものが無い写真（null と項目の欠損を区別して、null のものだけを返す）
      // 偽物は ORDER BY を解釈せず挿入順で返すので、U1 → U2 の順に置く。
      // U1・U2 は項目ごとに違う値を入れ、使い回しの誤りも区別できるようにする
      const photoU1 = storedPhoto(PHOTO_UNASSIGNED_ID, null, {
        takenAt: '2026-10-03T08:00:00',
        takenAtSource: 'exif',
        sortAt: '2026-10-03T08:00:00',
        comment: '駅前の看板',
        commentSource: 'user'
      });
      const photoU2 = storedPhoto(PHOTO_UNASSIGNED_2_ID, null, {
        fileSize: 54321,
        sortAt: '2026-10-08T12:00:00',
        tags: [{ name: 'メモ', kind: 'food', x: 0.5, y: 0.5, source: 'user' }]
      });
      const { tripId: _omittedTripId, ...documentWithoutTripField } = storedPhoto(PHOTO_WITHOUT_TRIP_FIELD_ID, null);
      cosmosBackend.documents.set(TRIP_A_ID, tripDocument(TRIP_A_ID, '北海道 2026秋'));
      cosmosBackend.documents.set(PHOTO_UNASSIGNED_ID, { ...photoU1, ...COSMOS_SYSTEM_FIELDS });
      cosmosBackend.documents.set(PHOTO_A1_ID, { ...storedPhoto(PHOTO_A1_ID, TRIP_A_ID), ...COSMOS_SYSTEM_FIELDS });
      cosmosBackend.documents.set(PHOTO_ORPHAN_ID, {
        ...storedPhoto(PHOTO_ORPHAN_ID, TRIP_DELETED_ID),
        ...COSMOS_SYSTEM_FIELDS
      });
      cosmosBackend.documents.set(PHOTO_WITHOUT_TRIP_FIELD_ID, { ...documentWithoutTripField, ...COSMOS_SYSTEM_FIELDS });
      cosmosBackend.documents.set(PHOTO_UNASSIGNED_2_ID, { ...photoU2, ...COSMOS_SYSTEM_FIELDS });
      const request = createListPhotosRequest({ tripId: 'none' });

      const response = await listPhotosHandler(request, mockContext);

      expect(response.status).toBe(200);
      expect(response.jsonBody).toEqual({
        success: true,
        data: {
          photos: [
            {
              ...responseFieldsOf(photoU1),
              imageUrl: `https://${TEST_BLOB_HOST}/photos/${PHOTO_UNASSIGNED_ID}.jpg?${TEST_SAS_TOKEN}`,
              thumbnailUrl: `https://${TEST_BLOB_HOST}/photos/${PHOTO_UNASSIGNED_ID}.thumb.jpg?${TEST_SAS_TOKEN}`
            },
            {
              ...responseFieldsOf(photoU2),
              imageUrl: `https://${TEST_BLOB_HOST}/photos/${PHOTO_UNASSIGNED_2_ID}.jpg?${TEST_SAS_TOKEN}`,
              thumbnailUrl: `https://${TEST_BLOB_HOST}/photos/${PHOTO_UNASSIGNED_2_ID}.thumb.jpg?${TEST_SAS_TOKEN}`
            }
          ],
          continuationToken: null,
          urlExpiresAt: '2026-10-10T04:12:45.000Z'
        }
      });
    });

    it('写真の一覧は、続きがあれば継続トークンが返り、それを渡すと続きが返り、最後のページではトークンがnullになる', async () => {
      freezeNow('2026-10-10T03:12:45.000Z');
      // 旅行 A の写真3枚を sortAt の昇順に置き、1ページ2枚で読む。
      // 偽物は ORDER BY を解釈せず挿入順で返すので、置いた順がそのままページの順になる
      const exifPhoto = (id: string, takenAt: string): PhotoDocument =>
        storedPhoto(id, TRIP_A_ID, { takenAt, takenAtSource: 'exif', sortAt: takenAt });
      const photoA1 = exifPhoto(PHOTO_A1_ID, '2026-10-01T10:00:00');
      const photoA2 = exifPhoto(PHOTO_A2_ID, '2026-10-02T10:00:00');
      const photoA3 = exifPhoto(PHOTO_A3_ID, '2026-10-03T10:00:00');
      cosmosBackend.documents.set(TRIP_A_ID, tripDocument(TRIP_A_ID, '北海道 2026秋'));
      cosmosBackend.documents.set(PHOTO_A1_ID, { ...photoA1, ...COSMOS_SYSTEM_FIELDS });
      cosmosBackend.documents.set(PHOTO_A2_ID, { ...photoA2, ...COSMOS_SYSTEM_FIELDS });
      cosmosBackend.documents.set(PHOTO_A3_ID, { ...photoA3, ...COSMOS_SYSTEM_FIELDS });

      const firstPage = await listPhotosHandler(createListPhotosRequest({ tripId: TRIP_A_ID, limit: '2' }), mockContext);

      // 継続トークンは Cosmos が作る不透明な文字列なので、中身ではなく「文字列であること」だけを見る
      expect(firstPage.status).toBe(200);
      expect(firstPage.jsonBody).toEqual({
        success: true,
        data: {
          photos: [
            {
              ...responseFieldsOf(photoA1),
              imageUrl: `https://${TEST_BLOB_HOST}/photos/${PHOTO_A1_ID}.jpg?${TEST_SAS_TOKEN}`,
              thumbnailUrl: `https://${TEST_BLOB_HOST}/photos/${PHOTO_A1_ID}.thumb.jpg?${TEST_SAS_TOKEN}`
            },
            {
              ...responseFieldsOf(photoA2),
              imageUrl: `https://${TEST_BLOB_HOST}/photos/${PHOTO_A2_ID}.jpg?${TEST_SAS_TOKEN}`,
              thumbnailUrl: `https://${TEST_BLOB_HOST}/photos/${PHOTO_A2_ID}.thumb.jpg?${TEST_SAS_TOKEN}`
            }
          ],
          continuationToken: expect.any(String),
          urlExpiresAt: '2026-10-10T04:12:45.000Z'
        }
      });

      // 返ってきたトークンをそのまま次の要求のクエリに載せる（クライアントと同じ受け渡し）
      const lastPage = await listPhotosHandler(
        createListPhotosRequest({ tripId: TRIP_A_ID, limit: '2', continuationToken: firstPage.jsonBody.data.continuationToken }),
        mockContext
      );

      expect(lastPage.status).toBe(200);
      expect(lastPage.jsonBody).toEqual({
        success: true,
        data: {
          photos: [
            {
              ...responseFieldsOf(photoA3),
              imageUrl: `https://${TEST_BLOB_HOST}/photos/${PHOTO_A3_ID}.jpg?${TEST_SAS_TOKEN}`,
              thumbnailUrl: `https://${TEST_BLOB_HOST}/photos/${PHOTO_A3_ID}.thumb.jpg?${TEST_SAS_TOKEN}`
            }
          ],
          continuationToken: null,
          urlExpiresAt: '2026-10-10T04:12:45.000Z'
        }
      });
    });

    // album コンテナのパーティションキーは /id なので、一覧の ORDER BY はパーティションをまたぐクエリになる。
    // この形で Cosmos は、結果がまだ揃っていないと、空のページ（resources: []）を継続トークン付きで返す。
    // 空のページは「写真が無い」のではなく「まだ取れていない」なので、続きを読んで写真を返す。
    // 空のページをそのまま返すと、写真があるのに空の一覧になり、続きのトークンだけが付く。
    // 偽物は、実際の結果の前に空のページを2回返す。旅行の写真は2枚で、1ページに収まる
    it('結果がまだ揃わず空のページが返っても、続きを読んで写真を返す', async () => {
      freezeNow('2026-10-10T03:12:45.000Z');
      cosmosBackend.emptyPagesBeforeResults = 2;
      const photoA1 = storedPhoto(PHOTO_A1_ID, TRIP_A_ID, { sortAt: '2026-10-05T09:00:00', tags: [{ name: '朝', kind: 'food', x: 0.5, y: 0.5, source: 'user' }] });
      const photoA2 = storedPhoto(PHOTO_A2_ID, TRIP_A_ID, { sortAt: '2026-10-06T12:30:15', tags: [{ name: '昼食', kind: 'food', x: 0.5, y: 0.5, source: 'user' }] });
      cosmosBackend.documents.set(TRIP_A_ID, tripDocument(TRIP_A_ID, '北海道 2026秋'));
      cosmosBackend.documents.set(PHOTO_A1_ID, photoA1);
      cosmosBackend.documents.set(PHOTO_A2_ID, photoA2);
      const request = createListPhotosRequest({ tripId: TRIP_A_ID });

      const response = await listPhotosHandler(request, mockContext);

      expect(response.status).toBe(200);
      expect(response.jsonBody).toEqual({
        success: true,
        data: {
          photos: [
            {
              ...responseFieldsOf(photoA1),
              imageUrl: `https://${TEST_BLOB_HOST}/photos/${PHOTO_A1_ID}.jpg?${TEST_SAS_TOKEN}`,
              thumbnailUrl: `https://${TEST_BLOB_HOST}/photos/${PHOTO_A1_ID}.thumb.jpg?${TEST_SAS_TOKEN}`
            },
            {
              ...responseFieldsOf(photoA2),
              imageUrl: `https://${TEST_BLOB_HOST}/photos/${PHOTO_A2_ID}.jpg?${TEST_SAS_TOKEN}`,
              thumbnailUrl: `https://${TEST_BLOB_HOST}/photos/${PHOTO_A2_ID}.thumb.jpg?${TEST_SAS_TOKEN}`
            }
          ],
          continuationToken: null,
          urlExpiresAt: '2026-10-10T04:12:45.000Z'
        }
      });
    });

    // 05 §5.2 の表の 1〜5 と、7 のうち JSON として読めないトークン(Cosmos に渡す前に弾く分)。
    // 上から順に見て、最初に失敗した1件だけを返す。順序の行を除く各行は、検証したい指定1つだけを不正にする。
    // category は段階3なので、1 は「tripId が無い」だけで見る。code は文字列で固定する（クライアントがこの値で分岐する）。
    // 指定の検証は Cosmos DB に触る前に済ませる。forcedQueryError を立てておくと、検証が通って
    // 問い合わせまで進んだ場合は 400 ではなくこのエラーになり、検証の位置が後ろにずれた退行も落ちる
    const INVALID_LIMIT_MESSAGE = '1ページの枚数は1〜200で指定してください';
    const invalidQueryCases: [string, Record<string, string>, string][] = [
      ['tripIdが無い', {}, '絞り込み条件を指定してください'],
      ['tripIdがUUIDでもnoneでもない', { tripId: 'abc' }, '旅行IDの形式が無効です'],
      // none は小文字だけ。大文字小文字を区別せずに「どの旅行にも属さない」として扱うと、200 になる
      ['tripIdがNONE（大文字）', { tripId: 'NONE' }, '旅行IDの形式が無効です'],
      // 空は「指定あり」なので、「無い」（1）ではなく形式の不正（2）になる
      ['tripIdが空', { tripId: '' }, '旅行IDの形式が無効です'],
      // カテゴリは定義表のキーと other だけ（段階3。05 §5.2 の表の 3）
      ['categoryが定義表に無い', { category: 'animal' }, 'カテゴリが無効です'],
      ['categoryが大文字', { category: 'FOOD' }, 'カテゴリが無効です'],
      ['categoryが空', { tripId: TRIP_A_ID, category: '' }, 'カテゴリが無効です'],
      ['tripIdもcategoryも不正（tripIdの指摘が先）', { tripId: 'abc', category: 'animal' }, '旅行IDの形式が無効です'],
      ['categoryもlimitも不正（categoryの指摘が先）', { category: 'animal', limit: '0' }, 'カテゴリが無効です'],
      ['limitが0', { tripId: TRIP_A_ID, limit: '0' }, INVALID_LIMIT_MESSAGE],
      ['limitが201', { tripId: TRIP_A_ID, limit: '201' }, INVALID_LIMIT_MESSAGE],
      ['limitが負の数', { tripId: TRIP_A_ID, limit: '-1' }, INVALID_LIMIT_MESSAGE],
      ['limitが数字でない', { tripId: TRIP_A_ID, limit: 'abc' }, INVALID_LIMIT_MESSAGE],
      ['limitが整数でない', { tripId: TRIP_A_ID, limit: '1.5' }, INVALID_LIMIT_MESSAGE],
      // 数値に直すと範囲内の整数になる書き方（先頭ゼロ・指数表記・16進・前後の空白）も、
      // 先頭ゼロの無い10進の整数ではないので受け付けない
      ['limitの先頭がゼロ', { tripId: TRIP_A_ID, limit: '01' }, INVALID_LIMIT_MESSAGE],
      ['limitが指数表記', { tripId: TRIP_A_ID, limit: '1e2' }, INVALID_LIMIT_MESSAGE],
      ['limitが16進表記', { tripId: TRIP_A_ID, limit: '0x10' }, INVALID_LIMIT_MESSAGE],
      ['limitの前に空白がある', { tripId: TRIP_A_ID, limit: ' 5' }, INVALID_LIMIT_MESSAGE],
      ['limitが空', { tripId: TRIP_A_ID, limit: '' }, INVALID_LIMIT_MESSAGE],
      ['continuationTokenが空', { tripId: TRIP_A_ID, continuationToken: '' }, '継続トークンの形式が無効です'],
      // 継続トークンの実体は JSON。JSON として読めない文字列を SDK に渡すと、`code` の無い普通の Error
      // （`Failed to parse continuation token: ...`）になり、想定外の失敗（500）と区別できない。
      // そのため Cosmos に渡す前に、空のトークンと同じ 400 / 同じ文言で返す（05 §5.2 の表の 7 のうち、読めない文字列の分）。
      // この行は旅行も写真も置かない: 旅行の確認（404）より先に弾くことも、404 との違いで見える
      [
        'continuationTokenがJSONとして読めない',
        { tripId: TRIP_A_ID, continuationToken: 'not-a-real-token' },
        '継続トークンの形式が無効です'
      ],
      // お気に入りは true だけを受け付ける（05 §5.2 の 3.5）。お気に入りだけでは絞り込み条件にならない
      ['favoriteがfalse', { tripId: TRIP_A_ID, favorite: 'false' }, 'お気に入りの指定が無効です'],
      ['favoriteの大文字小文字が違う', { tripId: TRIP_A_ID, favorite: 'TRUE' }, 'お気に入りの指定が無効です'],
      ['favoriteが空', { tripId: TRIP_A_ID, favorite: '' }, 'お気に入りの指定が無効です'],
      ['favoriteだけ（旅行もカテゴリも無い）', { favorite: 'true' }, '絞り込み条件を指定してください'],
      // 検証の順序: 複数の指定が不正なら、表の上の行の指摘を返す。各行は、隣り合う2つの指定を不正にする
      ['categoryもfavoriteも不正（categoryの指摘が先）', { tripId: TRIP_A_ID, category: 'animal', favorite: 'yes' }, 'カテゴリが無効です'],
      ['favoriteもlimitも不正（favoriteの指摘が先）', { tripId: TRIP_A_ID, favorite: 'yes', limit: '0' }, 'お気に入りの指定が無効です'],
      ['tripIdが無く、continuationTokenが空（tripIdの指摘が先）', { continuationToken: '' }, '絞り込み条件を指定してください'],
      ['tripIdもlimitも不正（tripIdの指摘が先）', { tripId: 'abc', limit: '0' }, '旅行IDの形式が無効です'],
      [
        'limitもcontinuationTokenも不正（limitの指摘が先）',
        { tripId: TRIP_A_ID, limit: '0', continuationToken: '' },
        INVALID_LIMIT_MESSAGE
      ]
    ];

    it('写真の一覧で指定が正しくなければ、400で理由を返す', () => forEachCase(invalidQueryCases, async (_case, query, message) => {
      cosmosBackend.forcedQueryError = new Error('検証より前にデータベースへ問い合わせた');
      const request = createListPhotosRequest(query);

      const response = await listPhotosHandler(request, mockContext);

      expect(response.status).toBe(400);
      const body = response.jsonBody as any;
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('INVALID_REQUEST');
      expect(body.error.message).toBe(message);
    }));

    // 1ページの枚数の境界。下限の1と上限の200は受け付ける（0 と 201 は上の表で 400）。
    // 指定した枚数が効いていることも、返る写真とトークンで見る（1 なら1枚で続きがあり、200 なら全部で最後のページ）。
    // 旅行は置いておく（旅行の確認が入っても、この要求は受け付けられる）
    it('写真の一覧は、1ページの枚数が下限と上限ちょうどでも受け付ける', () => forEachCase([
      ['limitが下限の1', '1', [PHOTO_A1_ID], expect.any(String)],
      ['limitが上限の200', '200', [PHOTO_A1_ID, PHOTO_A2_ID], null]
    ], async (_case, limit, photoIds, continuationToken) => {
      cosmosBackend.documents.set(TRIP_A_ID, tripDocument(TRIP_A_ID, '北海道 2026秋'));
      cosmosBackend.documents.set(PHOTO_A1_ID, storedPhoto(PHOTO_A1_ID, TRIP_A_ID));
      cosmosBackend.documents.set(PHOTO_A2_ID, storedPhoto(PHOTO_A2_ID, TRIP_A_ID));
      const request = createListPhotosRequest({ tripId: TRIP_A_ID, limit });

      const response = await listPhotosHandler(request, mockContext);

      expect(response.status).toBe(200);
      const data = (response.jsonBody as any).data;
      expect(data.photos.map((photo: { id: string }) => photo.id)).toEqual(photoIds);
      expect(data.continuationToken).toEqual(continuationToken);
    }));

    // limit を省略したときの1ページの枚数は 100(05 §5.2 の表。PHOTO_PAGE_SIZE の既定)。
    // 旅行の写真を 101 枚置き、1ページ目が 100 枚で切れて続きがあることを、返る枚数と継続トークンで見る。
    // 既定の枚数が 100 より少なければ 100 枚に届かず、多ければ 101 枚が返ってトークンが null になる
    it('limitを省略すると100枚ずつ返る', async () => {
      cosmosBackend.documents.set(TRIP_A_ID, tripDocument(TRIP_A_ID, '北海道 2026秋'));
      Array.from({ length: 101 }, (_, i) => i.toString(16).padStart(64, '0')).forEach((photoId) => {
        cosmosBackend.documents.set(photoId, storedPhoto(photoId, TRIP_A_ID));
      });
      const request = createListPhotosRequest({ tripId: TRIP_A_ID });

      const response = await listPhotosHandler(request, mockContext);

      expect(response.status).toBe(200);
      const data = (response.jsonBody as any).data;
      expect(data.photos).toHaveLength(100);
      expect(data.continuationToken).toEqual(expect.any(String));
    });

    // 旅行の有無は、旅行のドキュメントだけで決める。写真が残っていても、旅行が無ければ 404。
    // 旅行の削除と送信が重なって、消えた旅行を指す写真が残っている状態にしておく。
    // 旅行の確認を入れず、または「写真が空なら 404」にする実装は、この写真を一覧に載せて 200 を返してしまう
    it('写真の一覧で指定した旅行が無いと、404で理由を返す', async () => {
      cosmosBackend.documents.set(PHOTO_ORPHAN_ID, storedPhoto(PHOTO_ORPHAN_ID, TRIP_DELETED_ID));
      const request = createListPhotosRequest({ tripId: TRIP_DELETED_ID });

      const response = await listPhotosHandler(request, mockContext);

      expect(response.status).toBe(404);
      const body = response.jsonBody as any;
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('TRIP_NOT_FOUND');
      expect(body.error.message).toBe('指定された旅行が見つかりません');
    });

    it('カテゴリだけを指定すると、旅行をまたいで、そのカテゴリの写真だけが返る', async () => {
      // 旅行 A・B と、どの旅行にも属さない写真に、食べ物の写真とそれ以外を混ぜて置く（05 §5.2。段階3）。
      // 旅行を指定しないので、旅行の確認（404）はしない
      cosmosBackend.documents.set(TRIP_A_ID, tripDocument(TRIP_A_ID, '北海道 2026秋'));
      cosmosBackend.documents.set(PHOTO_A1_ID, storedPhoto(PHOTO_A1_ID, TRIP_A_ID, { category: 'food' }));
      cosmosBackend.documents.set(PHOTO_A2_ID, storedPhoto(PHOTO_A2_ID, TRIP_A_ID, { category: 'landscape' }));
      cosmosBackend.documents.set(PHOTO_B1_ID, storedPhoto(PHOTO_B1_ID, TRIP_B_ID, { category: 'food' }));
      cosmosBackend.documents.set(PHOTO_UNASSIGNED_ID, storedPhoto(PHOTO_UNASSIGNED_ID, null, { category: 'food' }));

      const response = await listPhotosHandler(createListPhotosRequest({ category: 'food' }), mockContext);

      expect(response.status).toBe(200);
      expect((response.jsonBody as any).data.photos.map((photo: any) => photo.id)).toEqual([
        PHOTO_A1_ID,
        PHOTO_B1_ID,
        PHOTO_UNASSIGNED_ID
      ]);
    });

    it('カテゴリとお気に入りを指定すると、旅行をまたいで、そのカテゴリのお気に入りの写真だけが返る', async () => {
      cosmosBackend.documents.set(TRIP_A_ID, tripDocument(TRIP_A_ID, '北海道 2026秋'));
      cosmosBackend.documents.set(PHOTO_A1_ID, storedPhoto(PHOTO_A1_ID, TRIP_A_ID, { category: 'food', favorite: true }));
      cosmosBackend.documents.set(PHOTO_A2_ID, storedPhoto(PHOTO_A2_ID, TRIP_A_ID, { category: 'landscape', favorite: true }));
      cosmosBackend.documents.set(PHOTO_B1_ID, storedPhoto(PHOTO_B1_ID, TRIP_B_ID, { category: 'food', favorite: true }));
      cosmosBackend.documents.set(PHOTO_A3_ID, storedPhoto(PHOTO_A3_ID, TRIP_A_ID, { category: 'food', favorite: false }));
      cosmosBackend.documents.set(PHOTO_UNASSIGNED_ID, storedPhoto(PHOTO_UNASSIGNED_ID, null, { category: 'food', favorite: true }));
      // 印の無い（付け外しをしたことの無い）食べ物の写真は、旅行を指定しなくても外れる
      cosmosBackend.documents.set(PHOTO_UNASSIGNED_2_ID, storedPhoto(PHOTO_UNASSIGNED_2_ID, null, { category: 'food' }));

      const response = await listPhotosHandler(createListPhotosRequest({ category: 'food', favorite: 'true' }), mockContext);

      expect(response.status).toBe(200);
      // 並びは偽物が入れた順に返すもので、sortAt の並びは見ていない（08 §5.3 の手での確認で見る）
      expect((response.jsonBody as any).data.photos.map((photo: any) => photo.id)).toEqual([PHOTO_A1_ID, PHOTO_B1_ID, PHOTO_UNASSIGNED_ID]);
    });

    it('旅行とカテゴリの両方を指定すると、その旅行のそのカテゴリの写真だけが返る', async () => {
      cosmosBackend.documents.set(TRIP_A_ID, tripDocument(TRIP_A_ID, '北海道 2026秋'));
      cosmosBackend.documents.set(PHOTO_A1_ID, storedPhoto(PHOTO_A1_ID, TRIP_A_ID, { category: 'other' }));
      cosmosBackend.documents.set(PHOTO_A2_ID, storedPhoto(PHOTO_A2_ID, TRIP_A_ID, { category: 'food' }));
      cosmosBackend.documents.set(PHOTO_B1_ID, storedPhoto(PHOTO_B1_ID, TRIP_B_ID, { category: 'other' }));

      const response = await listPhotosHandler(
        createListPhotosRequest({ tripId: TRIP_A_ID, category: 'other' }),
        mockContext
      );

      expect(response.status).toBe(200);
      expect((response.jsonBody as any).data.photos.map((photo: any) => photo.id)).toEqual([PHOTO_A1_ID]);
    });

    it('旅行とお気に入りを指定すると、その旅行のお気に入りの写真だけが、お気に入りの印付きで返る（印の無い写真は含めない）', async () => {
      cosmosBackend.documents.set(TRIP_A_ID, tripDocument(TRIP_A_ID, '北海道 2026秋'));
      cosmosBackend.documents.set(PHOTO_A1_ID, storedPhoto(PHOTO_A1_ID, TRIP_A_ID, { favorite: true }));
      cosmosBackend.documents.set(PHOTO_A2_ID, storedPhoto(PHOTO_A2_ID, TRIP_A_ID, { favorite: false }));
      cosmosBackend.documents.set(PHOTO_A3_ID, storedPhoto(PHOTO_A3_ID, TRIP_A_ID));
      cosmosBackend.documents.set(PHOTO_B1_ID, storedPhoto(PHOTO_B1_ID, TRIP_B_ID, { favorite: true }));

      const response = await listPhotosHandler(
        createListPhotosRequest({ tripId: TRIP_A_ID, favorite: 'true' }),
        mockContext
      );

      expect(response.status).toBe(200);
      expect((response.jsonBody as any).data.photos.map((photo: any) => [photo.id, photo.favorite])).toEqual([[PHOTO_A1_ID, true]]);
    });

    // 旅行があれば、写真が1枚も無くても 200 で空の一覧を返す（404 にしない）。
    // 別の旅行 B には写真を置き、絞り込みが効かずに他の旅行の写真が混ざる誤りも区別できるようにする。
    // 空でも URL の期限は返る
    it('旅行はあるが写真が1枚も無ければ、空の一覧が返る', async () => {
      freezeNow('2026-10-10T03:12:45.000Z');
      cosmosBackend.documents.set(TRIP_A_ID, tripDocument(TRIP_A_ID, '北海道 2026秋'));
      cosmosBackend.documents.set(TRIP_B_ID, tripDocument(TRIP_B_ID, '京都 2026冬'));
      cosmosBackend.documents.set(PHOTO_B1_ID, storedPhoto(PHOTO_B1_ID, TRIP_B_ID));
      const request = createListPhotosRequest({ tripId: TRIP_A_ID });

      const response = await listPhotosHandler(request, mockContext);

      expect(response.status).toBe(200);
      expect(response.jsonBody).toEqual({
        success: true,
        data: { photos: [], continuationToken: null, urlExpiresAt: '2026-10-10T04:12:45.000Z' }
      });
    });

    // 05 §5.2 の表の 7。JSON として読めないトークンは、上の検証の表で見ている（Cosmos に渡す前に 400）。
    // こちらは JSON として読めるが、データベースが作った形ではないトークン（別の絞り込みのものなど）。
    // これを Cosmos が 400 で拒むかは推測で、実環境では確かめていない（05 §5.2 の表の 7 も「推測」）。
    // 偽物は、偽物が作った形でないトークンに数値の code 400 のエラーを返すようにしてある（推測の再現）。
    // ハンドラは、トークンを渡した一覧のクエリの 400 をトークンの不正とみなし、同じ 400 / 同じ文言で返す。
    // 旅行と写真は置いてあり、トークン以外は正しい要求にする
    it('JSONだがデータベースが受け付けない継続トークンを渡しても、400で理由を返す', async () => {
      cosmosBackend.documents.set(TRIP_A_ID, tripDocument(TRIP_A_ID, '北海道 2026秋'));
      cosmosBackend.documents.set(PHOTO_A1_ID, storedPhoto(PHOTO_A1_ID, TRIP_A_ID));
      const request = createListPhotosRequest({ tripId: TRIP_A_ID, continuationToken: '{"x":1}' });

      const response = await listPhotosHandler(request, mockContext);

      expect(response.status).toBe(400);
      const body = response.jsonBody as any;
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('INVALID_REQUEST');
      expect(body.error.message).toBe('継続トークンの形式が無効です');
    });

    // データベースの失敗の分類。接続できない障害は 503、それ以外は 500 で、500 の message は固定。
    // 失敗する箇所（旅行の確認の読み取り・一覧のクエリ）ごとに同じ表を回し、どちらで失敗しても応答は同じになる。
    // 旅行は置いて、注入した失敗以外はすべて正しい要求にする（表のうち、最後の2行を除いてトークンは渡さない）
    type DatabaseFailureRow = [
      string,
      (backend: FakeCosmosBackend<FakeCosmosDocument>, error: Error) => void,
      Error,
      Record<string, string>,
      number,
      string,
      string
    ];
    const failInTripCheck = (backend: FakeCosmosBackend<FakeCosmosDocument>, error: Error): void => {
      backend.forcedReadError = error;
    };
    const failInPhotoQuery = (backend: FakeCosmosBackend<FakeCosmosDocument>, error: Error): void => {
      backend.forcedQueryError = error;
    };
    const failurePoints: [string, typeof failInTripCheck][] = [
      ['旅行の確認で', failInTripCheck],
      ['一覧の取得で', failInPhotoQuery]
    ];
    const failureRows: DatabaseFailureRow[] = [
      ...failurePoints.flatMap(([point, fail]) =>
        databaseFailureCases('写真一覧の取得に失敗しました').map(
          ([caseName, error, status, code, message]): DatabaseFailureRow => [
            `${point}、${caseName}`,
            fail,
            error,
            { tripId: TRIP_A_ID },
            status,
            code,
            message
          ]
        )
      ),
      // 継続トークンの不正は、トークンを渡したときの Cosmos の 400 だけ（上の「JSONだがデータベースが受け付けない
      // 継続トークン」のテスト。サーバが 400 で拒む形は推測）。
      // トークンを渡していないのに 400 が返るなら、トークンのせいではないので 500
      [
        '一覧の取得で、継続トークンを渡していないのにCosmos DBが400を返したときは、内部エラー（500）を返す',
        failInPhotoQuery,
        Object.assign(new Error('Bad Request'), { name: 'RestError', code: 400 }),
        { tripId: TRIP_A_ID },
        500,
        'INTERNAL_ERROR',
        '写真一覧の取得に失敗しました'
      ],
      // トークンを渡していても、400 以外の失敗をトークンの不正にしない（接続できない障害は 503 のまま）
      [
        '一覧の取得で、継続トークンを渡していても、接続できない障害は400にせず接続できないエラー（503）を返す',
        failInPhotoQuery,
        Object.assign(new Error('getaddrinfo ENOTFOUND example.documents.azure.com'), {
          name: 'RestError',
          code: 'ENOTFOUND'
        }),
        // JSON として読めるトークン（読めない文字列は、データベースに問い合わせる前に 400 で弾かれる）
        { tripId: TRIP_A_ID, continuationToken: '{"fakePosition":1}' },
        503,
        'DATABASE_ERROR',
        'データベースに接続できません'
      ]
    ];

    it.each(failureRows)(
      '写真の一覧で、データベースに接続できなければ503、それ以外の失敗は500で決まった文言を返す（%s）',
      async (_case, fail, error, query, status, code, message) => {
        cosmosBackend.documents.set(TRIP_A_ID, tripDocument(TRIP_A_ID, '北海道 2026秋'));
        fail(cosmosBackend, error);
        const request = createListPhotosRequest(query);

        const response = await listPhotosHandler(request, mockContext);

        expect(response.status).toBe(status);
        const body = response.jsonBody as any;
        expect(body.success).toBe(false);
        expect(body.error.code).toBe(code);
        expect(body.error.message).toBe(message);
      }
    );
  });
});
