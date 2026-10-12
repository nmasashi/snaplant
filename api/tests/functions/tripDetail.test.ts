import { HttpRequest, InvocationContext } from '@azure/functions';
import { CosmosClient } from '@azure/cosmos';
import { BlobServiceClient, generateBlobSASQueryParameters } from '@azure/storage-blob';
import { getTripHandler, updateTripHandler } from '../../src/functions/tripDetail';
import { PhotoDocument, TripDocument } from '../../src/types/album';
import { FakeCosmosBackend, createFakeContainer } from '../fakes/cosmos';
import { BlobEntry, TEST_BLOB_HOST, createFakeBlobServiceClient } from '../fakes/blob';
import { databaseFailureCases } from '../helpers/databaseFailures';

// 外部依存のみモック
jest.mock('@azure/cosmos');
// 表紙の SAS の署名に使う関数は、このファイルで固定のトークンを返す形に差し替える。
// 署名はローカルの計算だけで Blob Storage へは通信しない。署名の対象・権限・開始時刻は
// photos.test.ts が実 SDK のトークンで見ているので、ここでは「表紙の URL にトークンが付いて返る」ことを見る
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

// 表紙のテストで使う旅行(京都)と、別の旅行(札幌)の id
const KYOTO_TRIP_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SAPPORO_TRIP_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

// 写真の id(小文字16進 64 文字)。表紙では画像のバイト列は使わないので、写真を見分けられる値にしている
const SAPPORO_PHOTO_ID = '1'.repeat(64);
const KYOTO_FIRST_PHOTO_ID = '2'.repeat(64);
const KYOTO_SECOND_PHOTO_ID = '3'.repeat(64);

/**
 * 保存済みの写真のドキュメント。表紙に関係しない項目は既定値。
 * サムネイルは既定ではあり(`<id>.thumb.jpg`)、null を渡すとサムネイルの無い写真になる。
 * このファイルの偽物の Cosmos は旅行の型で作ってあるので、置くときは旅行の型に合わせる(偽物は型を問わない)
 */
const photoDocumentAsStored = (
  id: string,
  tripId: string,
  sortAt: string,
  thumbnailBlobName: string | null = `${id}.thumb.jpg`
): TripDocument => {
  const photo: PhotoDocument = {
    id,
    type: 'photo',
    tripId,
    blobName: `${id}.jpg`,
    thumbnailBlobName,
    contentType: 'image/jpeg',
    fileSize: 1234567,
    takenAt: null,
    takenAtSource: 'none',
    sortAt,
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
  return photo as unknown as TripDocument;
};

describe('旅行詳細API', () => {
  let mockContext: InvocationContext;
  let cosmosBackend: FakeCosmosBackend<TripDocument>;

  beforeEach(() => {
    mockContext = { log: jest.fn() } as any;

    cosmosBackend = { documents: new Map() };
    const fakeContainer = createFakeContainer(cosmosBackend);
    MockedCosmosClient.mockImplementation(() => ({
      database: () => ({
        container: () => fakeContainer
      })
    } as unknown as CosmosClient));

    process.env.COSMOS_DB_ENDPOINT = 'https://test.documents.azure.com:443/';
    process.env.COSMOS_DB_KEY = 'test-key';
    process.env.COSMOS_DB_DATABASE = 'test-db';
    process.env.COSMOS_DB_ALBUM_CONTAINER = 'test-album';

    // 表紙の URL を作るために偽物のサービスクライアントが要る(表紙の Blob の中身は読まない)
    MockedBlobServiceClient.fromConnectionString = jest
      .fn()
      .mockReturnValue(createFakeBlobServiceClient({ store: new Map<string, BlobEntry>() }));
    // jest.fn() のままだと undefined を返し、.toString() で例外になって署名の経路が検証されない
    mockedGenerateSas.mockReturnValue({ toString: () => TEST_SAS_TOKEN } as any);
    // ホストは TEST_BLOB_HOST(test.blob.core.windows.net)になる
    process.env.STORAGE_CONNECTION_STRING =
      'DefaultEndpointsProtocol=https;AccountName=test;AccountKey=testkey==;EndpointSuffix=core.windows.net';
    process.env.PHOTO_STORAGE_CONTAINER_NAME = 'photos';
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete process.env.STORAGE_CONNECTION_STRING;
    delete process.env.PHOTO_STORAGE_CONTAINER_NAME;
    delete process.env.COSMOS_DB_ENDPOINT;
    delete process.env.COSMOS_DB_KEY;
    delete process.env.COSMOS_DB_DATABASE;
    delete process.env.COSMOS_DB_ALBUM_CONTAINER;
  });

  describe('旅行取得API', () => {
    it('旅行を1件取り出すと、写真の集計が付いた旅行が返る', async () => {
      const kyoto = {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        name: '京都旅行',
        description: '紅葉を見に行く',
        tags: ['国内'],
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-02T00:00:00.000Z'
      };
      cosmosBackend.documents.set(kyoto.id, { ...kyoto, type: 'trip' });
      const request = {
        method: 'GET',
        url: `https://func-snaplant.azurewebsites.net/api/trips/${kyoto.id}?code=test-key`,
        query: new Map([['code', 'test-key']]),
        headers: new Map(),
        params: { tripId: kyoto.id }
      } as any as HttpRequest;

      const response = await getTripHandler(request, mockContext);

      // 写真の集計はクエリの結果で偽物では解釈できないため、写真を置かない場合の空の集計を確かめる
      expect(response.status).toBe(200);
      expect(response.jsonBody).toEqual({
        success: true,
        data: {
          trip: {
            ...kyoto,
            photoCount: 0,
            firstTakenAt: null,
            lastTakenAt: null,
            coverThumbnailUrl: null
          }
        }
      });
    });

    it('旅行に写真があれば、先頭の写真のサムネイルが表紙になる', async () => {
      // 集計(photoCount など)は偽物では解釈できないので、このテストは表紙の URL だけを見る。
      // 偽物は ORDER BY を解釈せず挿入順で返すので、京都の写真は sortAt の昇順になる順(1枚目 → 2枚目)で置く。
      // 札幌の写真は京都の写真より先に置く: 旅行での絞り込みが効いていないと、これが先頭になって表紙を取り違える。
      // 京都の写真はどちらもサムネイルがあり、2枚目が使われても区別できる
      cosmosBackend.documents.set(KYOTO_TRIP_ID, {
        id: KYOTO_TRIP_ID,
        type: 'trip',
        name: '京都旅行',
        description: null,
        tags: [],
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-02T00:00:00.000Z'
      });
      cosmosBackend.documents.set(
        SAPPORO_PHOTO_ID,
        photoDocumentAsStored(SAPPORO_PHOTO_ID, SAPPORO_TRIP_ID, '2026-10-01T09:00:00')
      );
      cosmosBackend.documents.set(
        KYOTO_FIRST_PHOTO_ID,
        photoDocumentAsStored(KYOTO_FIRST_PHOTO_ID, KYOTO_TRIP_ID, '2026-10-05T09:00:00')
      );
      cosmosBackend.documents.set(
        KYOTO_SECOND_PHOTO_ID,
        photoDocumentAsStored(KYOTO_SECOND_PHOTO_ID, KYOTO_TRIP_ID, '2026-10-06T09:00:00')
      );
      const request = {
        method: 'GET',
        url: `https://func-snaplant.azurewebsites.net/api/trips/${KYOTO_TRIP_ID}?code=test-key`,
        query: new Map([['code', 'test-key']]),
        headers: new Map(),
        params: { tripId: KYOTO_TRIP_ID }
      } as any as HttpRequest;

      const response = await getTripHandler(request, mockContext);

      expect(response.status).toBe(200);
      const body = response.jsonBody as any;
      expect(body.data.trip.coverThumbnailUrl).toBe(
        `https://${TEST_BLOB_HOST}/photos/${KYOTO_FIRST_PHOTO_ID}.thumb.jpg?${TEST_SAS_TOKEN}`
      );
    });

    it('先頭の写真にサムネイルが無ければ、原寸が表紙になる', async () => {
      // 先頭の写真だけサムネイルが無く、2枚目にはある。サムネイルがある写真まで探して表紙にしたり、
      // 先頭の写真の原寸を使わなかったりすると、期待の URL と食い違う。
      // 偽物は ORDER BY を解釈しないので、sortAt の昇順になる順(1枚目 → 2枚目)で置く
      cosmosBackend.documents.set(KYOTO_TRIP_ID, {
        id: KYOTO_TRIP_ID,
        type: 'trip',
        name: '京都旅行',
        description: null,
        tags: [],
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-02T00:00:00.000Z'
      });
      cosmosBackend.documents.set(
        KYOTO_FIRST_PHOTO_ID,
        photoDocumentAsStored(KYOTO_FIRST_PHOTO_ID, KYOTO_TRIP_ID, '2026-10-05T09:00:00', null)
      );
      cosmosBackend.documents.set(
        KYOTO_SECOND_PHOTO_ID,
        photoDocumentAsStored(KYOTO_SECOND_PHOTO_ID, KYOTO_TRIP_ID, '2026-10-06T09:00:00')
      );
      const request = {
        method: 'GET',
        url: `https://func-snaplant.azurewebsites.net/api/trips/${KYOTO_TRIP_ID}?code=test-key`,
        query: new Map([['code', 'test-key']]),
        headers: new Map(),
        params: { tripId: KYOTO_TRIP_ID }
      } as any as HttpRequest;

      const response = await getTripHandler(request, mockContext);

      expect(response.status).toBe(200);
      const body = response.jsonBody as any;
      expect(body.data.trip.coverThumbnailUrl).toBe(
        `https://${TEST_BLOB_HOST}/photos/${KYOTO_FIRST_PHOTO_ID}.jpg?${TEST_SAS_TOKEN}`
      );
    });

    const photoId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

    it.each([
      ['旅行IDがUUIDの形式でない', 'abc', 400, 'INVALID_REQUEST', '旅行IDの形式が無効です'],
      [
        '該当する旅行が無い',
        'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        404,
        'TRIP_NOT_FOUND',
        '指定された旅行が見つかりません'
      ],
      ['同じIDのものが写真だけ', photoId, 404, 'TRIP_NOT_FOUND', '指定された旅行が見つかりません']
    ])('取り出す旅行の指定が正しくなければ、理由を返す（%s）', async (_case, tripId, status, code, message) => {
      // 写真のドキュメントは旅行の型ではないが、旅行と取り違えないことを確かめるために置く
      cosmosBackend.documents.set(photoId, { id: photoId, type: 'photo' } as unknown as TripDocument);
      const request = {
        method: 'GET',
        url: `https://func-snaplant.azurewebsites.net/api/trips/${tripId}?code=test-key`,
        query: new Map([['code', 'test-key']]),
        headers: new Map(),
        params: { tripId }
      } as any as HttpRequest;

      const response = await getTripHandler(request, mockContext);

      expect(response.status).toBe(status);
      const body = response.jsonBody as any;
      expect(body.success).toBe(false);
      expect(body.error.code).toBe(code);
      expect(body.error.message).toBe(message);
    });

    it.each(
      databaseFailureCases('旅行詳細の取得に失敗しました')
    )('旅行の取得で%s', async (_case, error, status, code, message) => {
      const tripId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      cosmosBackend.forcedReadError = error;
      const request = {
        method: 'GET',
        url: `https://func-snaplant.azurewebsites.net/api/trips/${tripId}?code=test-key`,
        query: new Map([['code', 'test-key']]),
        headers: new Map(),
        params: { tripId }
      } as any as HttpRequest;

      const response = await getTripHandler(request, mockContext);

      expect(response.status).toBe(status);
      const body = response.jsonBody as any;
      expect(body.success).toBe(false);
      expect(body.error.code).toBe(code);
      expect(body.error.message).toBe(message);
    });
  });

  describe('旅行更新API', () => {
    it('旅行を更新すると、名前と説明が置き換わった旅行が返り、タグは変わらない', async () => {
      const tripId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      cosmosBackend.documents.set(tripId, {
        id: tripId,
        type: 'trip',
        name: '京都旅行',
        description: '旧メモ',
        tags: ['国内'],
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-02T00:00:00.000Z'
      });
      const request = {
        method: 'PUT',
        url: `https://func-snaplant.azurewebsites.net/api/trips/${tripId}?code=test-key`,
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        params: { tripId },
        json: jest.fn().mockResolvedValue({ name: '  新しい名前  ', description: null })
      } as any as HttpRequest;

      const response = await updateTripHandler(request, mockContext);

      // 集計の項目（photoCount など）は付かない。toEqual の完全一致でそれも確かめる
      expect(response.status).toBe(200);
      expect(response.jsonBody).toEqual({
        success: true,
        data: {
          trip: {
            id: tripId,
            name: '新しい名前',
            description: null,
            tags: ['国内'],
            createdAt: '2026-10-01T00:00:00.000Z',
            updatedAt: expect.any(String)
          }
        }
      });
      const saved = cosmosBackend.documents.get(tripId);
      expect(saved?.name).toBe('新しい名前');
      expect(saved?.description).toBeNull();
      expect(saved?.tags).toEqual(['国内']);
      expect(saved?.updatedAt).not.toBe('2026-10-02T00:00:00.000Z');
    });

    const existingTripId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const photoDocId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const missingTripId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const validBody = () => jest.fn().mockResolvedValue({ name: '新しい名前' });

    it.each([
      ['旅行IDがUUIDの形式でない', 'abc', validBody(), 400, 'INVALID_REQUEST', '旅行IDの形式が無効です'],
      [
        '旅行IDもボディも不正（IDの形式の検証が先）',
        'abc',
        jest.fn().mockResolvedValue({ name: 123 }),
        400,
        'INVALID_REQUEST',
        '旅行IDの形式が無効です'
      ],
      [
        'ボディがJSONとしてパースできない',
        existingTripId,
        jest.fn().mockRejectedValue(new SyntaxError('Unexpected token')),
        400,
        'INVALID_REQUEST',
        'リクエストボディの形式が無効です'
      ],
      [
        'nameが空白のみ',
        existingTripId,
        jest.fn().mockResolvedValue({ name: '   ' }),
        400,
        'INVALID_REQUEST',
        '旅行名が指定されていません'
      ],
      ['該当する旅行が無い', missingTripId, validBody(), 404, 'TRIP_NOT_FOUND', '指定された旅行が見つかりません'],
      ['同じIDのものが写真だけ', photoDocId, validBody(), 404, 'TRIP_NOT_FOUND', '指定された旅行が見つかりません']
    ])('旅行の更新で指定や入力が正しくなければ、理由を返し何も変えない（%s）', async (_case, tripId, json, status, code, message) => {
      cosmosBackend.documents.set(existingTripId, {
        id: existingTripId,
        type: 'trip',
        name: '京都旅行',
        description: '旧メモ',
        tags: ['国内'],
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-02T00:00:00.000Z'
      });
      // 写真のドキュメントは旅行の型ではないが、旅行と取り違えないことを確かめるために置く
      cosmosBackend.documents.set(photoDocId, { id: photoDocId, type: 'photo' } as unknown as TripDocument);
      const documentsBefore = structuredClone(cosmosBackend.documents);
      const request = {
        method: 'PUT',
        url: `https://func-snaplant.azurewebsites.net/api/trips/${tripId}?code=test-key`,
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        params: { tripId },
        json
      } as any as HttpRequest;

      const response = await updateTripHandler(request, mockContext);

      expect(response.status).toBe(status);
      const body = response.jsonBody as any;
      expect(body.success).toBe(false);
      expect(body.error.code).toBe(code);
      expect(body.error.message).toBe(message);
      expect(cosmosBackend.documents).toEqual(documentsBefore);
    });

    // 失敗する箇所（読み取り・書き込み）ごとに同じ分類の表を回す。どちらで失敗しても応答は同じになる
    const failurePoints: [string, (backend: FakeCosmosBackend<TripDocument>, error: Error) => void][] = [
      ['読み取りで', (backend, error) => { backend.forcedReadError = error; }],
      ['書き込みで', (backend, error) => { backend.forcedReplaceError = error; }]
    ];
    const failureRows = failurePoints.flatMap(([point, inject]) =>
      databaseFailureCases('旅行の更新に失敗しました').map(
        ([caseName, error, status, code, message]) =>
          [`${point}、${caseName}`, inject, error, status, code, message] as const
      )
    );

    it.each(failureRows)(
      '旅行の更新の%s（何も変わらない）',
      async (_case, inject, error, status, code, message) => {
        cosmosBackend.documents.set(existingTripId, {
          id: existingTripId,
          type: 'trip',
          name: '京都旅行',
          description: '旧メモ',
          tags: ['国内'],
          createdAt: '2026-10-01T00:00:00.000Z',
          updatedAt: '2026-10-02T00:00:00.000Z'
        });
        const documentsBefore = structuredClone(cosmosBackend.documents);
        inject(cosmosBackend, error);
        const request = {
          method: 'PUT',
          url: `https://func-snaplant.azurewebsites.net/api/trips/${existingTripId}?code=test-key`,
          query: new Map([['code', 'test-key']]),
          headers: new Map([['content-type', 'application/json']]),
          params: { tripId: existingTripId },
          json: validBody()
        } as any as HttpRequest;

        const response = await updateTripHandler(request, mockContext);

        expect(response.status).toBe(status);
        const body = response.jsonBody as any;
        expect(body.success).toBe(false);
        expect(body.error.code).toBe(code);
        expect(body.error.message).toBe(message);
        expect(cosmosBackend.documents).toEqual(documentsBefore);
      }
    );

    it('旅行の更新の途中で旅行が消されていたら、見つからない扱いになる', async () => {
      cosmosBackend.documents.set(existingTripId, {
        id: existingTripId,
        type: 'trip',
        name: '京都旅行',
        description: '旧メモ',
        tags: ['国内'],
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-02T00:00:00.000Z'
      });
      // 読んだ後・置き換える前に別のリクエストが旅行を消すと、置き換えが Cosmos の 404 で失敗する。
      // 実 SDK は RestError の形（name・code）で投げる
      cosmosBackend.forcedReplaceError = Object.assign(new Error('Entity with the specified id does not exist in the system.'), {
        name: 'RestError',
        code: 404
      });
      const request = {
        method: 'PUT',
        url: `https://func-snaplant.azurewebsites.net/api/trips/${existingTripId}?code=test-key`,
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        params: { tripId: existingTripId },
        json: validBody()
      } as any as HttpRequest;

      const response = await updateTripHandler(request, mockContext);

      expect(response.status).toBe(404);
      const body = response.jsonBody as any;
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('TRIP_NOT_FOUND');
      expect(body.error.message).toBe('指定された旅行が見つかりません');
    });
  });
});
