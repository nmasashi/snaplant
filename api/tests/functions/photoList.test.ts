import { HttpRequest, InvocationContext } from '@azure/functions';
import { CosmosClient } from '@azure/cosmos';
import { BlobServiceClient, generateBlobSASQueryParameters } from '@azure/storage-blob';
import { listPhotosHandler } from '../../src/functions/photos';
import { PhotoDocument, TripDocument } from '../../src/types/album';
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

// Cosmos DB が保存したドキュメントに実際に付けるシステム項目。偽物は付けないので、漏れを見るテストが自分で足す。
// 応答の写真に混ざると、利用者に内部の識別子や ETag が見えてしまう
const COSMOS_SYSTEM_FIELDS = {
  _rid: 'q2cDAOZl6N8BAAAAAAAAAA==',
  _self: 'dbs/q2cDAA==/colls/q2cDAOZl6N8=/docs/q2cDAOZl6N8BAAAAAAAAAA==/',
  _etag: '"0000a1b2-0000-0d00-0000-6706a1b20000"',
  _attachments: 'attachments/',
  _ts: 1760065200
};

/** 旅行のドキュメント（偽物の documents に置いて「旅行がある」状態を作る） */
const tripDocument = (id: string, name: string): TripDocument => ({
  id,
  type: 'trip',
  name,
  description: null,
  tags: [],
  createdAt: '2026-10-04T09:00:00.000Z',
  updatedAt: '2026-10-04T09:00:00.000Z'
});

/** 写真の項目のうち、ドキュメントと応答で共通のもの */
type PhotoFields = Omit<PhotoDocument, 'type' | 'blobName' | 'thumbnailBlobName'>;

/** 項目を既定値で埋めた写真。テストごとに変えたい項目だけ overrides で上書きする */
const photoFields = (id: string, tripId: string | null, overrides: Partial<PhotoFields> = {}): PhotoFields => ({
  id,
  tripId,
  contentType: 'image/jpeg',
  fileSize: 1000,
  takenAt: null,
  takenAtSource: 'none',
  sortAt: '2026-10-10T12:00:00',
  location: null,
  category: null,
  tags: [],
  comment: null,
  commentSource: null,
  hint: null,
  classification: null,
  identification: null,
  processing: { state: 'none', step: null, attempts: 0, lastError: null, updatedAt: null },
  uploadedAt: '2026-10-10T03:00:00.000Z',
  updatedAt: '2026-10-10T03:00:00.000Z',
  ...overrides
});

/** 原寸とサムネイルの Blob 名が `<id>.jpg` / `<id>.thumb.jpg` の、保存済みの写真のドキュメント */
const photoDocument = (fields: PhotoFields): PhotoDocument => ({
  ...fields,
  type: 'photo',
  blobName: `${fields.id}.jpg`,
  thumbnailBlobName: `${fields.id}.thumb.jpg`
});

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
      const fieldsA1 = photoFields(PHOTO_A1_ID, TRIP_A_ID, {
        fileSize: 2345678,
        takenAt: '2026-10-05T09:00:00',
        takenAtSource: 'exif',
        sortAt: '2026-10-05T09:00:00',
        location: { latitude: 43.7706, longitude: 142.365, placeName: '北海道旭川市', placeSource: 'device' },
        category: 'landscape',
        tags: ['朝'],
        comment: 'ホテルの窓からの眺め',
        commentSource: 'user'
      });
      const fieldsA2 = photoFields(PHOTO_A2_ID, TRIP_A_ID, {
        contentType: 'image/png',
        fileSize: 345678,
        takenAt: '2026-10-06T12:30:15',
        takenAtSource: 'exif',
        sortAt: '2026-10-06T12:30:15',
        category: 'food',
        tags: ['昼食', '旅館'],
        uploadedAt: '2026-10-09T01:00:00.000Z',
        updatedAt: '2026-10-09T02:30:00.000Z'
      });
      cosmosBackend.documents.set(TRIP_A_ID, tripDocument(TRIP_A_ID, '北海道 2026秋'));
      cosmosBackend.documents.set(TRIP_B_ID, tripDocument(TRIP_B_ID, '京都 2026冬'));
      cosmosBackend.documents.set(PHOTO_A1_ID, { ...photoDocument(fieldsA1), ...COSMOS_SYSTEM_FIELDS });
      cosmosBackend.documents.set(PHOTO_B1_ID, { ...photoDocument(photoFields(PHOTO_B1_ID, TRIP_B_ID)), ...COSMOS_SYSTEM_FIELDS });
      cosmosBackend.documents.set(PHOTO_UNASSIGNED_ID, {
        ...photoDocument(photoFields(PHOTO_UNASSIGNED_ID, null)),
        ...COSMOS_SYSTEM_FIELDS
      });
      cosmosBackend.documents.set(PHOTO_A2_ID, { ...photoDocument(fieldsA2), ...COSMOS_SYSTEM_FIELDS });
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
              ...fieldsA1,
              imageUrl: `https://${TEST_BLOB_HOST}/photos/${PHOTO_A1_ID}.jpg?${TEST_SAS_TOKEN}`,
              thumbnailUrl: `https://${TEST_BLOB_HOST}/photos/${PHOTO_A1_ID}.thumb.jpg?${TEST_SAS_TOKEN}`
            },
            {
              ...fieldsA2,
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
      const fieldsU1 = photoFields(PHOTO_UNASSIGNED_ID, null, {
        takenAt: '2026-10-03T08:00:00',
        takenAtSource: 'exif',
        sortAt: '2026-10-03T08:00:00',
        comment: '駅前の看板',
        commentSource: 'user'
      });
      const fieldsU2 = photoFields(PHOTO_UNASSIGNED_2_ID, null, {
        fileSize: 54321,
        sortAt: '2026-10-08T12:00:00',
        tags: ['メモ']
      });
      const { tripId: _omittedTripId, ...documentWithoutTripField } = photoDocument(
        photoFields(PHOTO_WITHOUT_TRIP_FIELD_ID, null)
      );
      cosmosBackend.documents.set(TRIP_A_ID, tripDocument(TRIP_A_ID, '北海道 2026秋'));
      cosmosBackend.documents.set(PHOTO_UNASSIGNED_ID, { ...photoDocument(fieldsU1), ...COSMOS_SYSTEM_FIELDS });
      cosmosBackend.documents.set(PHOTO_A1_ID, { ...photoDocument(photoFields(PHOTO_A1_ID, TRIP_A_ID)), ...COSMOS_SYSTEM_FIELDS });
      cosmosBackend.documents.set(PHOTO_ORPHAN_ID, {
        ...photoDocument(photoFields(PHOTO_ORPHAN_ID, TRIP_DELETED_ID)),
        ...COSMOS_SYSTEM_FIELDS
      });
      cosmosBackend.documents.set(PHOTO_WITHOUT_TRIP_FIELD_ID, { ...documentWithoutTripField, ...COSMOS_SYSTEM_FIELDS });
      cosmosBackend.documents.set(PHOTO_UNASSIGNED_2_ID, { ...photoDocument(fieldsU2), ...COSMOS_SYSTEM_FIELDS });
      const request = createListPhotosRequest({ tripId: 'none' });

      const response = await listPhotosHandler(request, mockContext);

      expect(response.status).toBe(200);
      expect(response.jsonBody).toEqual({
        success: true,
        data: {
          photos: [
            {
              ...fieldsU1,
              imageUrl: `https://${TEST_BLOB_HOST}/photos/${PHOTO_UNASSIGNED_ID}.jpg?${TEST_SAS_TOKEN}`,
              thumbnailUrl: `https://${TEST_BLOB_HOST}/photos/${PHOTO_UNASSIGNED_ID}.thumb.jpg?${TEST_SAS_TOKEN}`
            },
            {
              ...fieldsU2,
              imageUrl: `https://${TEST_BLOB_HOST}/photos/${PHOTO_UNASSIGNED_2_ID}.jpg?${TEST_SAS_TOKEN}`,
              thumbnailUrl: `https://${TEST_BLOB_HOST}/photos/${PHOTO_UNASSIGNED_2_ID}.thumb.jpg?${TEST_SAS_TOKEN}`
            }
          ],
          continuationToken: null,
          urlExpiresAt: '2026-10-10T04:12:45.000Z'
        }
      });
    });

    it('写真の一覧は指定した枚数ずつ返り、継続トークンを渡すと続きが返り、最後のページではトークンがnullになる', async () => {
      freezeNow('2026-10-10T03:12:45.000Z');
      // 旅行 A の写真3枚を sortAt の昇順に置き、1ページ2枚で読む。
      // 偽物は ORDER BY を解釈せず挿入順で返すので、置いた順がそのままページの順になる
      const exifFields = (id: string, takenAt: string): PhotoFields =>
        photoFields(id, TRIP_A_ID, { takenAt, takenAtSource: 'exif', sortAt: takenAt });
      const fieldsA1 = exifFields(PHOTO_A1_ID, '2026-10-01T10:00:00');
      const fieldsA2 = exifFields(PHOTO_A2_ID, '2026-10-02T10:00:00');
      const fieldsA3 = exifFields(PHOTO_A3_ID, '2026-10-03T10:00:00');
      cosmosBackend.documents.set(TRIP_A_ID, tripDocument(TRIP_A_ID, '北海道 2026秋'));
      cosmosBackend.documents.set(PHOTO_A1_ID, { ...photoDocument(fieldsA1), ...COSMOS_SYSTEM_FIELDS });
      cosmosBackend.documents.set(PHOTO_A2_ID, { ...photoDocument(fieldsA2), ...COSMOS_SYSTEM_FIELDS });
      cosmosBackend.documents.set(PHOTO_A3_ID, { ...photoDocument(fieldsA3), ...COSMOS_SYSTEM_FIELDS });

      const firstPage = await listPhotosHandler(createListPhotosRequest({ tripId: TRIP_A_ID, limit: '2' }), mockContext);

      // 継続トークンは Cosmos が作る不透明な文字列なので、中身ではなく「文字列であること」だけを見る
      expect(firstPage.status).toBe(200);
      expect(firstPage.jsonBody).toEqual({
        success: true,
        data: {
          photos: [
            {
              ...fieldsA1,
              imageUrl: `https://${TEST_BLOB_HOST}/photos/${PHOTO_A1_ID}.jpg?${TEST_SAS_TOKEN}`,
              thumbnailUrl: `https://${TEST_BLOB_HOST}/photos/${PHOTO_A1_ID}.thumb.jpg?${TEST_SAS_TOKEN}`
            },
            {
              ...fieldsA2,
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
              ...fieldsA3,
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
      const fieldsA1 = photoFields(PHOTO_A1_ID, TRIP_A_ID, { sortAt: '2026-10-05T09:00:00', tags: ['朝'] });
      const fieldsA2 = photoFields(PHOTO_A2_ID, TRIP_A_ID, { sortAt: '2026-10-06T12:30:15', tags: ['昼食'] });
      cosmosBackend.documents.set(TRIP_A_ID, tripDocument(TRIP_A_ID, '北海道 2026秋'));
      cosmosBackend.documents.set(PHOTO_A1_ID, photoDocument(fieldsA1));
      cosmosBackend.documents.set(PHOTO_A2_ID, photoDocument(fieldsA2));
      const request = createListPhotosRequest({ tripId: TRIP_A_ID });

      const response = await listPhotosHandler(request, mockContext);

      expect(response.status).toBe(200);
      expect(response.jsonBody).toEqual({
        success: true,
        data: {
          photos: [
            {
              ...fieldsA1,
              imageUrl: `https://${TEST_BLOB_HOST}/photos/${PHOTO_A1_ID}.jpg?${TEST_SAS_TOKEN}`,
              thumbnailUrl: `https://${TEST_BLOB_HOST}/photos/${PHOTO_A1_ID}.thumb.jpg?${TEST_SAS_TOKEN}`
            },
            {
              ...fieldsA2,
              imageUrl: `https://${TEST_BLOB_HOST}/photos/${PHOTO_A2_ID}.jpg?${TEST_SAS_TOKEN}`,
              thumbnailUrl: `https://${TEST_BLOB_HOST}/photos/${PHOTO_A2_ID}.thumb.jpg?${TEST_SAS_TOKEN}`
            }
          ],
          continuationToken: null,
          urlExpiresAt: '2026-10-10T04:12:45.000Z'
        }
      });
    });

    // 05 §5.2 の表の 1〜5。上から順に見て、最初に失敗した1件だけを返す。各行は、検証したい指定1つだけを不正にする。
    // category は段階3なので、1 は「tripId が無い」だけで見る。code は文字列で固定する（クライアントがこの値で分岐する）。
    // 指定の検証は Cosmos DB に触る前に済ませる。forcedQueryError を立てておくと、検証が通って
    // 問い合わせまで進んだ場合は 400 ではなくこのエラーになり、検証の位置が後ろにずれた退行も落ちる
    const INVALID_LIMIT_MESSAGE = '1ページの枚数は1〜200で指定してください';
    const invalidQueryCases: [string, Record<string, string>, string][] = [
      ['tripIdが無い', {}, '絞り込み条件を指定してください'],
      ['tripIdがUUIDでもnoneでもない', { tripId: 'abc' }, '旅行IDの形式が無効です'],
      // 空は「指定あり」なので、「無い」（1）ではなく形式の不正（2）になる
      ['tripIdが空', { tripId: '' }, '旅行IDの形式が無効です'],
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
      ['continuationTokenが空', { tripId: TRIP_A_ID, continuationToken: '' }, '継続トークンの形式が無効です']
    ];

    it.each(invalidQueryCases)('写真の一覧で指定が正しくなければ、400で理由を返す（%s）', async (_case, query, message) => {
      cosmosBackend.forcedQueryError = new Error('検証より前にデータベースへ問い合わせた');
      const request = createListPhotosRequest(query);

      const response = await listPhotosHandler(request, mockContext);

      expect(response.status).toBe(400);
      const body = response.jsonBody as any;
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('INVALID_REQUEST');
      expect(body.error.message).toBe(message);
    });

    // 1ページの枚数の境界。下限の1と上限の200は受け付ける（0 と 201 は上の表で 400）。
    // 指定した枚数が効いていることも、返る写真とトークンで見る（1 なら1枚で続きがあり、200 なら全部で最後のページ）。
    // 旅行は置いておく（旅行の確認が入っても、この要求は受け付けられる）
    it.each([
      ['limitが下限の1', '1', [PHOTO_A1_ID], expect.any(String)],
      ['limitが上限の200', '200', [PHOTO_A1_ID, PHOTO_A2_ID], null]
    ])('写真の一覧は、1ページの枚数が下限と上限ちょうどでも受け付ける（%s）', async (_case, limit, photoIds, continuationToken) => {
      cosmosBackend.documents.set(TRIP_A_ID, tripDocument(TRIP_A_ID, '北海道 2026秋'));
      cosmosBackend.documents.set(PHOTO_A1_ID, photoDocument(photoFields(PHOTO_A1_ID, TRIP_A_ID)));
      cosmosBackend.documents.set(PHOTO_A2_ID, photoDocument(photoFields(PHOTO_A2_ID, TRIP_A_ID)));
      const request = createListPhotosRequest({ tripId: TRIP_A_ID, limit });

      const response = await listPhotosHandler(request, mockContext);

      expect(response.status).toBe(200);
      const data = (response.jsonBody as any).data;
      expect(data.photos.map((photo: { id: string }) => photo.id)).toEqual(photoIds);
      expect(data.continuationToken).toEqual(continuationToken);
    });

    // 旅行の有無は、旅行のドキュメントだけで決める。写真が残っていても、旅行が無ければ 404。
    // 旅行の削除と送信が重なって、消えた旅行を指す写真が残っている状態にしておく。
    // 旅行の確認を入れず、または「写真が空なら 404」にする実装は、この写真を一覧に載せて 200 を返してしまう
    it('写真の一覧で指定した旅行が無いと、404で理由を返す', async () => {
      cosmosBackend.documents.set(PHOTO_ORPHAN_ID, photoDocument(photoFields(PHOTO_ORPHAN_ID, TRIP_DELETED_ID)));
      const request = createListPhotosRequest({ tripId: TRIP_DELETED_ID });

      const response = await listPhotosHandler(request, mockContext);

      expect(response.status).toBe(404);
      const body = response.jsonBody as any;
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('TRIP_NOT_FOUND');
      expect(body.error.message).toBe('指定された旅行が見つかりません');
    });

    // 旅行があれば、写真が1枚も無くても 200 で空の一覧を返す（404 にしない）。
    // 別の旅行 B には写真を置き、絞り込みが効かずに他の旅行の写真が混ざる誤りも区別できるようにする。
    // 空でも URL の期限は返る
    it('旅行はあるが写真が1枚も無ければ、空の一覧が返る', async () => {
      freezeNow('2026-10-10T03:12:45.000Z');
      cosmosBackend.documents.set(TRIP_A_ID, tripDocument(TRIP_A_ID, '北海道 2026秋'));
      cosmosBackend.documents.set(TRIP_B_ID, tripDocument(TRIP_B_ID, '京都 2026冬'));
      cosmosBackend.documents.set(PHOTO_B1_ID, photoDocument(photoFields(PHOTO_B1_ID, TRIP_B_ID)));
      const request = createListPhotosRequest({ tripId: TRIP_A_ID });

      const response = await listPhotosHandler(request, mockContext);

      expect(response.status).toBe(200);
      expect(response.jsonBody).toEqual({
        success: true,
        data: { photos: [], continuationToken: null, urlExpiresAt: '2026-10-10T04:12:45.000Z' }
      });
    });

    // 05 §5.2 の表の 7。継続トークンは Cosmos が作る不透明な文字列だが、実体は JSON。JSON として読めない
    // 文字列を SDK に渡すと、`code` の無い普通の Error（`Failed to parse continuation token: ...`）になり、
    // 想定外の失敗（500）と区別できない。そのため、データベースに問い合わせる前に、空のトークンと同じ
    // 400 / 同じ文言で返す（クライアントは先頭から取り直す）。
    // JSON として読めるが、データベースが受け付けない形のトークンは、次のテストで見る。
    // 旅行と写真は置いてあり、トークン以外は正しい要求にする
    it('データベースが受け付けない継続トークンを渡すと、400で理由を返す', async () => {
      cosmosBackend.documents.set(TRIP_A_ID, tripDocument(TRIP_A_ID, '北海道 2026秋'));
      cosmosBackend.documents.set(PHOTO_A1_ID, photoDocument(photoFields(PHOTO_A1_ID, TRIP_A_ID)));
      const request = createListPhotosRequest({ tripId: TRIP_A_ID, continuationToken: 'not-a-real-token' });

      const response = await listPhotosHandler(request, mockContext);

      expect(response.status).toBe(400);
      const body = response.jsonBody as any;
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('INVALID_REQUEST');
      expect(body.error.message).toBe('継続トークンの形式が無効です');
    });

    // 上のテストのトークンは JSON として読めない文字列。こちらは JSON として読めるが、データベースが
    // 作った形ではないトークンで、実 SDK はこれを数値の code 400 のエラーで拒む（偽物も同じ）。
    // どちらも同じ 400 / 同じ文言で返す。旅行と写真は置いてあり、トークン以外は正しい要求にする
    it('JSONだがデータベースが受け付けない継続トークンを渡しても、400で理由を返す', async () => {
      cosmosBackend.documents.set(TRIP_A_ID, tripDocument(TRIP_A_ID, '北海道 2026秋'));
      cosmosBackend.documents.set(PHOTO_A1_ID, photoDocument(photoFields(PHOTO_A1_ID, TRIP_A_ID)));
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
      // 継続トークンの不正は、トークンを渡したときの Cosmos の 400 だけ（上の 400 のテスト）。
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
