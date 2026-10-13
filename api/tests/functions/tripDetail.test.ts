import { HttpRequest, InvocationContext } from '@azure/functions';
import { CosmosClient } from '@azure/cosmos';
import { BlobServiceClient, generateBlobSASQueryParameters } from '@azure/storage-blob';
import { deleteTripHandler, getTripHandler, updateTripHandler } from '../../src/functions/tripDetail';
import { FakeCosmosBackend, FakeCosmosDocument, cosmosNotFoundError, createFakeContainer } from '../fakes/cosmos';
import { BlobEntry, FakeBlobBackend, TEST_BLOB_HOST, createFakeBlobServiceClient } from '../fakes/blob';
import { COSMOS_SYSTEM_FIELDS, photoDocument, tripDocument } from '../helpers/albumDocuments';
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
 * 保存済みの写真のドキュメント。表紙は旅行(tripId)と並べ替え用の日時(sortAt)で選ばれ、
 * URL は Blob 名(原寸は `<id>.jpg`)に基づくので、ここで決める。ほかの項目は表紙に関係しない。
 * サムネイルは既定ではあり(`<id>.thumb.jpg`)、null を渡すとサムネイルの無い写真になる
 */
const storedPhoto = (
  id: string,
  tripId: string,
  sortAt: string,
  thumbnailBlobName: string | null = `${id}.thumb.jpg`
) => photoDocument(id, { tripId, sortAt, blobName: `${id}.jpg`, thumbnailBlobName });

// 旅行を削除した時刻。写真に保存してある updatedAt(2026-09-22)とは別の日にして、書き換わったことを見分ける
const DELETED_AT = '2026-10-12T05:30:00.000Z';

// 時刻だけを固定する。他のタイマーまで偽物にすると非同期処理が止まりうる
const freezeNow = () =>
  jest.useFakeTimers({
    now: new Date(DELETED_AT),
    doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'setTimeout', 'setInterval']
  });

describe('旅行詳細API', () => {
  let mockContext: InvocationContext;
  // 旅行も写真も置くので、偽物の型は絞り込みに使う最小の項目だけにする
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

    process.env.COSMOS_DB_ENDPOINT = 'https://test.documents.azure.com:443/';
    process.env.COSMOS_DB_KEY = 'test-key';
    process.env.COSMOS_DB_DATABASE = 'test-db';
    process.env.COSMOS_DB_ALBUM_CONTAINER = 'test-album';

    // 表紙の URL を作るために偽物のサービスクライアントが要る(表紙の Blob の中身は読まない)。
    // 旅行の削除では、偽物の store から Blob が消えるかを見る
    blobBackend = { store: new Map<string, BlobEntry>() };
    MockedBlobServiceClient.fromConnectionString = jest
      .fn()
      .mockReturnValue(createFakeBlobServiceClient(blobBackend));
    // jest.fn() のままだと undefined を返し、.toString() で例外になって署名の経路が検証されない
    mockedGenerateSas.mockReturnValue({ toString: () => TEST_SAS_TOKEN } as any);
    // ホストは TEST_BLOB_HOST(test.blob.core.windows.net)になる
    process.env.STORAGE_CONNECTION_STRING =
      'DefaultEndpointsProtocol=https;AccountName=test;AccountKey=testkey==;EndpointSuffix=core.windows.net';
    process.env.PHOTO_STORAGE_CONTAINER_NAME = 'photos';
  });

  afterEach(() => {
    jest.useRealTimers();
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

    it('旅行を1件取り出すと、データベースが付けた内部の項目と種別は返らない', async () => {
      // 偽物の Cosmos はシステム項目を付けないので、実際の Cosmos が保存したドキュメントの形を自分で置く
      cosmosBackend.documents.set(KYOTO_TRIP_ID, { ...tripDocument(KYOTO_TRIP_ID, '京都旅行'), ...COSMOS_SYSTEM_FIELDS });
      const request = {
        method: 'GET',
        url: `https://func-snaplant.azurewebsites.net/api/trips/${KYOTO_TRIP_ID}?code=test-key`,
        query: new Map([['code', 'test-key']]),
        headers: new Map(),
        params: { tripId: KYOTO_TRIP_ID }
      } as any as HttpRequest;

      const response = await getTripHandler(request, mockContext);

      expect(response.status).toBe(200);
      expect(Object.keys((response.jsonBody as any).data.trip).sort()).toEqual([
        'coverThumbnailUrl', 'createdAt', 'description', 'firstTakenAt', 'id',
        'lastTakenAt', 'name', 'photoCount', 'tags', 'updatedAt'
      ]);
    });

    // 写真の無い旅行の詳細は、写真の保存先(Blob Storage)の設定に頼らない。設定が無い環境でも旅行の詳細は返る。
    // 外側の beforeEach は設定を入れてあるので、このテストが設定を消す。
    // 表紙にする写真が無いのに Blob のサービスを作る退行は、設定が無いので 500 になって落ちる
    it('写真の保存先の設定が無くても、写真の無い旅行なら詳細が返り、表紙はnull', async () => {
      delete process.env.STORAGE_CONNECTION_STRING;
      delete process.env.PHOTO_STORAGE_CONTAINER_NAME;
      cosmosBackend.documents.set(KYOTO_TRIP_ID, tripDocument(KYOTO_TRIP_ID, '京都旅行'));
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
      expect(body.data.trip.coverThumbnailUrl).toBeNull();
    });

    it('旅行に写真があれば、先頭の写真のサムネイルが表紙になる', async () => {
      // 集計(photoCount など)は偽物では解釈できないので、このテストは表紙の URL だけを見る。
      // 偽物は ORDER BY を解釈せず挿入順で返すので、京都の写真は sortAt の昇順になる順(1枚目 → 2枚目)で置く。
      // 札幌の写真は京都の写真より先に置く: 旅行での絞り込みが効いていないと、これが先頭になって表紙を取り違える。
      // 京都の写真はどちらもサムネイルがあり、2枚目が使われても区別できる
      cosmosBackend.documents.set(KYOTO_TRIP_ID, tripDocument(KYOTO_TRIP_ID, '京都旅行'));
      cosmosBackend.documents.set(
        SAPPORO_PHOTO_ID,
        storedPhoto(SAPPORO_PHOTO_ID, SAPPORO_TRIP_ID, '2026-10-01T09:00:00')
      );
      cosmosBackend.documents.set(
        KYOTO_FIRST_PHOTO_ID,
        storedPhoto(KYOTO_FIRST_PHOTO_ID, KYOTO_TRIP_ID, '2026-10-05T09:00:00')
      );
      cosmosBackend.documents.set(
        KYOTO_SECOND_PHOTO_ID,
        storedPhoto(KYOTO_SECOND_PHOTO_ID, KYOTO_TRIP_ID, '2026-10-06T09:00:00')
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
      cosmosBackend.documents.set(KYOTO_TRIP_ID, tripDocument(KYOTO_TRIP_ID, '京都旅行'));
      cosmosBackend.documents.set(
        KYOTO_FIRST_PHOTO_ID,
        storedPhoto(KYOTO_FIRST_PHOTO_ID, KYOTO_TRIP_ID, '2026-10-05T09:00:00', null)
      );
      cosmosBackend.documents.set(
        KYOTO_SECOND_PHOTO_ID,
        storedPhoto(KYOTO_SECOND_PHOTO_ID, KYOTO_TRIP_ID, '2026-10-06T09:00:00')
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
      cosmosBackend.documents.set(photoId, { id: photoId, type: 'photo' });
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
      cosmosBackend.documents.set(
        tripId,
        tripDocument(tripId, '京都旅行', {
          description: '旧メモ',
          tags: ['国内'],
          createdAt: '2026-10-01T00:00:00.000Z',
          updatedAt: '2026-10-02T00:00:00.000Z'
        })
      );
      const request = {
        method: 'PUT',
        url: `https://func-snaplant.azurewebsites.net/api/trips/${tripId}?code=test-key`,
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        params: { tripId },
        json: jest.fn().mockResolvedValue({ name: '  新しい名前  ', description: null })
      } as any as HttpRequest;
      freezeNow();

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
            updatedAt: '2026-10-12T05:30:00.000Z'
          }
        }
      });
      expect(cosmosBackend.documents.get(tripId)).toMatchObject({
        name: '新しい名前',
        description: null,
        tags: ['国内'],
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-12T05:30:00.000Z'
      });
    });

    it('旅行を更新すると、データベースが付けた内部の項目と種別は返らない', async () => {
      // 偽物の Cosmos はシステム項目を付けないので、実際の Cosmos が保存したドキュメントの形を自分で置く
      cosmosBackend.documents.set(KYOTO_TRIP_ID, { ...tripDocument(KYOTO_TRIP_ID, '京都旅行'), ...COSMOS_SYSTEM_FIELDS });
      const request = {
        method: 'PUT',
        url: `https://func-snaplant.azurewebsites.net/api/trips/${KYOTO_TRIP_ID}?code=test-key`,
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        params: { tripId: KYOTO_TRIP_ID },
        json: jest.fn().mockResolvedValue({ name: '新しい名前', description: null })
      } as any as HttpRequest;

      const response = await updateTripHandler(request, mockContext);

      expect(response.status).toBe(200);
      expect(Object.keys((response.jsonBody as any).data.trip).sort()).toEqual([
        'createdAt', 'description', 'id', 'name', 'tags', 'updatedAt'
      ]);
    });

    const existingTripId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const photoDocId ='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const missingTripId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const validBody = () => jest.fn().mockResolvedValue({ name: '新しい名前' });
    // 更新される前の旅行。説明・タグ・更新日時を既定値でない値にして、何も変わらないことを見分けられるようにする
    const existingTrip = () =>
      tripDocument(existingTripId, '京都旅行', {
        description: '旧メモ',
        tags: ['国内'],
        updatedAt: '2026-10-02T00:00:00.000Z'
      });

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
      cosmosBackend.documents.set(existingTripId, existingTrip());
      // 写真のドキュメントは旅行の型ではないが、旅行と取り違えないことを確かめるために置く
      cosmosBackend.documents.set(photoDocId, { id: photoDocId, type: 'photo' });
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
    const failurePoints: [string, (backend: FakeCosmosBackend<FakeCosmosDocument>, error: Error) => void][] = [
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
        cosmosBackend.documents.set(existingTripId, existingTrip());
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
      cosmosBackend.documents.set(existingTripId, existingTrip());
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

  describe('旅行削除API', () => {
    // このブロックのテストで使う道具。deletePhotos は文字列で渡す(undefined なら指定なし)
    const createDeleteRequest = (tripId: string, deletePhotos?: string): HttpRequest => {
      // query は実際の HttpRequest と同じ URLSearchParams にする(無い項目の get は undefined ではなく null)
      const query = new URLSearchParams({ code: 'test-key' });
      if (deletePhotos !== undefined) {
        query.set('deletePhotos', deletePhotos);
      }
      return {
        method: 'DELETE',
        url: `https://func-snaplant.azurewebsites.net/api/trips/${tripId}?${query.toString()}`,
        query,
        headers: new Map(),
        params: { tripId }
      } as any as HttpRequest;
    };
    const putBlobs = (...keys: string[]) =>
      keys.forEach((key) => blobBackend.store.set(key, { content: Buffer.from('image') }));
    const THIRD_KYOTO_PHOTO_ID = '5'.repeat(64);

    it('写真は残すを選んで旅行を削除すると、中の写真はどの旅行にも属さない写真として残り、旅行は消える', async () => {
      freezeNow();
      // 旅行 A(京都。削除する)の写真2枚、旅行 B(札幌)の写真1枚、どの旅行にも属さない写真1枚。
      // 写真ごとに comment を変え、tripId と updatedAt 以外の項目が元のままかを見分けられるようにする。
      // Blob は4枚ぶん(原寸とサムネイル)を置く。「写真は残す」では Blob に触れない
      const unaffiliatedPhotoId = '4'.repeat(64);
      const savedPhoto = (id: string, tripId: string | null) =>
        photoDocument(id, { tripId, comment: `コメント ${id.slice(0, 1)}`, updatedAt: '2026-09-22T02:30:00.000Z' });
      const kyoto = tripDocument(KYOTO_TRIP_ID, '京都旅行');
      const sapporo = tripDocument(SAPPORO_TRIP_ID, '札幌旅行');
      const kyotoFirst = savedPhoto(KYOTO_FIRST_PHOTO_ID, KYOTO_TRIP_ID);
      const kyotoSecond = savedPhoto(KYOTO_SECOND_PHOTO_ID, KYOTO_TRIP_ID);
      const sapporoPhoto = savedPhoto(SAPPORO_PHOTO_ID, SAPPORO_TRIP_ID);
      const unaffiliatedPhoto = savedPhoto(unaffiliatedPhotoId, null);
      [kyoto, sapporo, kyotoFirst, kyotoSecond, sapporoPhoto, unaffiliatedPhoto].forEach((doc) =>
        cosmosBackend.documents.set(doc.id, doc)
      );
      [KYOTO_FIRST_PHOTO_ID, KYOTO_SECOND_PHOTO_ID, SAPPORO_PHOTO_ID, unaffiliatedPhotoId].forEach((id) =>
        putBlobs(`photos/${id}.jpg`, `photos/${id}.thumb.jpg`)
      );
      const request = createDeleteRequest(KYOTO_TRIP_ID, 'false');

      const response = await deleteTripHandler(request, mockContext);

      expect(response.status).toBe(200);
      expect(response.jsonBody).toEqual({
        success: true,
        data: { message: '旅行が正常に削除されました', deletedPhotoCount: 0, detachedPhotoCount: 2 }
      });
      // 旅行 A だけが消える。A の写真は tripId が null になり(項目ごと消えず null)、updatedAt だけが変わる。
      // 旅行 B・B の写真・元から属さない写真は変わらない
      expect(cosmosBackend.documents).toEqual(
        new Map<string, FakeCosmosDocument>([
          [SAPPORO_TRIP_ID, sapporo],
          [KYOTO_FIRST_PHOTO_ID, { ...kyotoFirst, tripId: null, updatedAt: DELETED_AT }],
          [KYOTO_SECOND_PHOTO_ID, { ...kyotoSecond, tripId: null, updatedAt: DELETED_AT }],
          [SAPPORO_PHOTO_ID, sapporoPhoto],
          [unaffiliatedPhotoId, unaffiliatedPhoto]
        ])
      );
      // 写真は残るので、Blob は1つも消えない
      expect(Array.from(blobBackend.store.keys())).toEqual([
        `photos/${KYOTO_FIRST_PHOTO_ID}.jpg`,
        `photos/${KYOTO_FIRST_PHOTO_ID}.thumb.jpg`,
        `photos/${KYOTO_SECOND_PHOTO_ID}.jpg`,
        `photos/${KYOTO_SECOND_PHOTO_ID}.thumb.jpg`,
        `photos/${SAPPORO_PHOTO_ID}.jpg`,
        `photos/${SAPPORO_PHOTO_ID}.thumb.jpg`,
        `photos/${unaffiliatedPhotoId}.jpg`,
        `photos/${unaffiliatedPhotoId}.thumb.jpg`
      ]);
    });

    it('写真も消すを選んで旅行を削除すると、中の写真のデータと画像が消え、旅行も消える', async () => {
      // 旅行 A(京都。削除する)の写真2枚(2枚目はサムネイルが無い)、旅行 B(札幌)の写真1枚、どの旅行にも属さない写真1枚。
      // 宛先の取り違え(B や未所属の写真を消す、原寸だけ・サムネイルだけ消す)を見分けるため、Blob は全写真ぶん置く
      const unaffiliatedPhotoId = '4'.repeat(64);
      const kyoto = tripDocument(KYOTO_TRIP_ID, '京都旅行');
      const sapporo = tripDocument(SAPPORO_TRIP_ID, '札幌旅行');
      const kyotoFirst = storedPhoto(KYOTO_FIRST_PHOTO_ID, KYOTO_TRIP_ID, '2026-10-05T09:00:00');
      const kyotoSecond = storedPhoto(KYOTO_SECOND_PHOTO_ID, KYOTO_TRIP_ID, '2026-10-06T09:00:00', null);
      const sapporoPhoto = storedPhoto(SAPPORO_PHOTO_ID, SAPPORO_TRIP_ID, '2026-10-01T09:00:00');
      const unaffiliatedPhoto = photoDocument(unaffiliatedPhotoId, { tripId: null });
      [kyoto, sapporo, kyotoFirst, kyotoSecond, sapporoPhoto, unaffiliatedPhoto].forEach((doc) =>
        cosmosBackend.documents.set(doc.id, doc)
      );
      putBlobs(
        `photos/${KYOTO_FIRST_PHOTO_ID}.jpg`,
        `photos/${KYOTO_FIRST_PHOTO_ID}.thumb.jpg`,
        `photos/${KYOTO_SECOND_PHOTO_ID}.jpg`,
        `photos/${SAPPORO_PHOTO_ID}.jpg`,
        `photos/${SAPPORO_PHOTO_ID}.thumb.jpg`,
        `photos/${unaffiliatedPhotoId}.jpg`,
        `photos/${unaffiliatedPhotoId}.thumb.jpg`
      );
      const request = createDeleteRequest(KYOTO_TRIP_ID, 'true');

      const response = await deleteTripHandler(request, mockContext);

      expect(response.status).toBe(200);
      expect(response.jsonBody).toEqual({
        success: true,
        data: { message: '旅行が正常に削除されました', deletedPhotoCount: 2, detachedPhotoCount: 0 }
      });
      // 旅行 A と A の写真2枚だけが消え、旅行 B・B の写真・元から属さない写真は変わらない
      expect(cosmosBackend.documents).toEqual(
        new Map<string, FakeCosmosDocument>([
          [SAPPORO_TRIP_ID, sapporo],
          [SAPPORO_PHOTO_ID, sapporoPhoto],
          [unaffiliatedPhotoId, unaffiliatedPhoto]
        ])
      );
      // A の写真の原寸とサムネイル(2枚目はサムネイルが無いので原寸だけ)が消え、他の Blob は残る
      expect(Array.from(blobBackend.store.keys())).toEqual([
        `photos/${SAPPORO_PHOTO_ID}.jpg`,
        `photos/${SAPPORO_PHOTO_ID}.thumb.jpg`,
        `photos/${unaffiliatedPhotoId}.jpg`,
        `photos/${unaffiliatedPhotoId}.thumb.jpg`
      ]);
    });

    it('写真も消すとき、画像の削除に失敗しても、写真のデータと旅行は消え、200で返る', async () => {
      // 京都の1枚目の原寸だけ、Blob の削除が失敗する。サムネイルの無い写真にして、失敗する Blob を1つに絞る。
      // 失敗してもドキュメントの削除と2枚目以降の処理は進む
      cosmosBackend.documents.set(KYOTO_TRIP_ID, tripDocument(KYOTO_TRIP_ID, '京都旅行'));
      cosmosBackend.documents.set(
        KYOTO_FIRST_PHOTO_ID,
        storedPhoto(KYOTO_FIRST_PHOTO_ID, KYOTO_TRIP_ID, '2026-10-05T09:00:00', null)
      );
      cosmosBackend.documents.set(
        KYOTO_SECOND_PHOTO_ID,
        storedPhoto(KYOTO_SECOND_PHOTO_ID, KYOTO_TRIP_ID, '2026-10-06T09:00:00')
      );
      putBlobs(
        `photos/${KYOTO_FIRST_PHOTO_ID}.jpg`,
        `photos/${KYOTO_SECOND_PHOTO_ID}.jpg`,
        `photos/${KYOTO_SECOND_PHOTO_ID}.thumb.jpg`
      );
      blobBackend.store.get(`photos/${KYOTO_FIRST_PHOTO_ID}.jpg`)!.failWith = Object.assign(
        new Error('This request is not authorized to perform this operation.'),
        { name: 'RestError', statusCode: 403, code: 'AuthorizationFailure' }
      );
      const request = createDeleteRequest(KYOTO_TRIP_ID, 'true');

      const response = await deleteTripHandler(request, mockContext);

      expect(response.status).toBe(200);
      expect(response.jsonBody).toEqual({
        success: true,
        data: { message: '旅行が正常に削除されました', deletedPhotoCount: 2, detachedPhotoCount: 0 }
      });
      expect(cosmosBackend.documents).toEqual(new Map());
      // 失敗した Blob だけが残り、2枚目の Blob は消える
      expect(Array.from(blobBackend.store.keys())).toEqual([`photos/${KYOTO_FIRST_PHOTO_ID}.jpg`]);
    });

    it.each([
      ['写真も消す', 'true'],
      ['写真は残す', 'false']
    ])('写真の無い旅行を削除すると、%sを選んでも旅行が消え、枚数は0', async (_choice, deletePhotos) => {
      // 札幌の写真は、京都の削除で巻き込まれないことを見るために置く
      cosmosBackend.documents.set(KYOTO_TRIP_ID, tripDocument(KYOTO_TRIP_ID, '京都旅行'));
      const sapporo = tripDocument(SAPPORO_TRIP_ID, '札幌旅行');
      const sapporoPhoto = storedPhoto(SAPPORO_PHOTO_ID, SAPPORO_TRIP_ID, '2026-10-01T09:00:00');
      cosmosBackend.documents.set(SAPPORO_TRIP_ID, sapporo);
      cosmosBackend.documents.set(SAPPORO_PHOTO_ID, sapporoPhoto);
      const request = createDeleteRequest(KYOTO_TRIP_ID, deletePhotos);

      const response = await deleteTripHandler(request, mockContext);

      expect(response.status).toBe(200);
      expect(response.jsonBody).toEqual({
        success: true,
        data: { message: '旅行が正常に削除されました', deletedPhotoCount: 0, detachedPhotoCount: 0 }
      });
      expect(cosmosBackend.documents).toEqual(
        new Map<string, FakeCosmosDocument>([
          [SAPPORO_TRIP_ID, sapporo],
          [SAPPORO_PHOTO_ID, sapporoPhoto]
        ])
      );
    });

    // 3枚の写真(原寸とサムネイルの Blob つき)。「写真も消す」では全部消え、「写真は残す」では全部残る
    const threeKyotoPhotoIds = [KYOTO_FIRST_PHOTO_ID, KYOTO_SECOND_PHOTO_ID, THIRD_KYOTO_PHOTO_ID];
    const threeKyotoPhotoBlobKeys = [
      `photos/${KYOTO_FIRST_PHOTO_ID}.jpg`,
      `photos/${KYOTO_FIRST_PHOTO_ID}.thumb.jpg`,
      `photos/${KYOTO_SECOND_PHOTO_ID}.jpg`,
      `photos/${KYOTO_SECOND_PHOTO_ID}.thumb.jpg`,
      `photos/${THIRD_KYOTO_PHOTO_ID}.jpg`,
      `photos/${THIRD_KYOTO_PHOTO_ID}.thumb.jpg`
    ];

    it.each([
      ['写真も消す', 'true', 3, 0, [], []],
      ['写真は残す', 'false', 0, 3, threeKyotoPhotoIds, threeKyotoPhotoBlobKeys]
    ])(
      '結果の揃わない空のページが挟まっても、中の写真は全部処理される（%s）',
      async (_choice, deletePhotos, deletedPhotoCount, detachedPhotoCount, remainingPhotoIds, remainingBlobKeys) => {
        // 偽物は、実際の結果を返す前に空のページと継続トークンを2回返す。
        // 空のページで読むのをやめると、写真が1枚も処理されない
        cosmosBackend.emptyPagesBeforeResults = 2;
        cosmosBackend.documents.set(KYOTO_TRIP_ID, tripDocument(KYOTO_TRIP_ID, '京都旅行'));
        threeKyotoPhotoIds.forEach((id) =>
          cosmosBackend.documents.set(id, storedPhoto(id, KYOTO_TRIP_ID, '2026-10-05T09:00:00'))
        );
        putBlobs(...threeKyotoPhotoBlobKeys);
        const request = createDeleteRequest(KYOTO_TRIP_ID, deletePhotos);

        const response = await deleteTripHandler(request, mockContext);

        expect(response.status).toBe(200);
        expect(response.jsonBody).toEqual({
          success: true,
          data: { message: '旅行が正常に削除されました', deletedPhotoCount, detachedPhotoCount }
        });
        // 旅行は消え、写真は消えたか(true)、全部残って tripId が null になった(false)。tripId が残った写真は無い
        expect(Array.from(cosmosBackend.documents.keys())).toEqual(remainingPhotoIds);
        const remaining = Array.from(cosmosBackend.documents.values());
        expect(remaining.filter((doc) => doc.tripId !== null)).toEqual([]);
        // 写真を消したときだけ、その画像も消える
        expect(Array.from(blobBackend.store.keys())).toEqual(remainingBlobKeys);
      }
    );

    it('最後に旅行を消すときに、他の操作で既に消されていても、成功として返る', async () => {
      // 写真は残す(delete を使うのは旅行の削除だけ)。旅行の delete が 404 になるのは、
      // 読んだ後・消す前に別のリクエストが旅行を消した場合
      cosmosBackend.documents.set(KYOTO_TRIP_ID, tripDocument(KYOTO_TRIP_ID, '京都旅行'));
      cosmosBackend.documents.set(
        KYOTO_FIRST_PHOTO_ID,
        storedPhoto(KYOTO_FIRST_PHOTO_ID, KYOTO_TRIP_ID, '2026-10-05T09:00:00')
      );
      cosmosBackend.forcedDeleteError = cosmosNotFoundError();
      const request = createDeleteRequest(KYOTO_TRIP_ID, 'false');

      const response = await deleteTripHandler(request, mockContext);

      expect(response.status).toBe(200);
      expect(response.jsonBody).toEqual({
        success: true,
        data: { message: '旅行が正常に削除されました', deletedPhotoCount: 0, detachedPhotoCount: 1 }
      });
    });

    it('旅行の削除の途中で写真が別の操作で消されていても、残りの写真と旅行の削除は進む', async () => {
      freezeNow();
      // 写真は残す。京都の写真2枚のうち1枚目は、一覧を読んだ後・旅行から外す前に別のリクエストが消した。
      // 偽物は読んだ後に消せないので、1枚目の patch だけが Cosmos の 404 で失敗する形にする(実 SDK は存在しない
      // ドキュメントの patch を 404 にする)。消えた写真は処理した枚数に数えず、2枚目と旅行の削除は進む
      const kyotoSecond = storedPhoto(KYOTO_SECOND_PHOTO_ID, KYOTO_TRIP_ID, '2026-10-06T09:00:00');
      cosmosBackend.documents.set(KYOTO_TRIP_ID, tripDocument(KYOTO_TRIP_ID, '京都旅行'));
      cosmosBackend.documents.set(
        KYOTO_FIRST_PHOTO_ID,
        storedPhoto(KYOTO_FIRST_PHOTO_ID, KYOTO_TRIP_ID, '2026-10-05T09:00:00')
      );
      cosmosBackend.documents.set(KYOTO_SECOND_PHOTO_ID, kyotoSecond);
      cosmosBackend.forcedErrorById = { [KYOTO_FIRST_PHOTO_ID]: cosmosNotFoundError() };
      const request = createDeleteRequest(KYOTO_TRIP_ID, 'false');

      const response = await deleteTripHandler(request, mockContext);

      expect(response.status).toBe(200);
      expect(response.jsonBody).toEqual({
        success: true,
        data: { message: '旅行が正常に削除されました', deletedPhotoCount: 0, detachedPhotoCount: 1 }
      });
      // 旅行は消え、2枚目は未所属に戻る。1枚目は消えたことにした偽物の都合で Map に残るので見ない
      expect(cosmosBackend.documents.has(KYOTO_TRIP_ID)).toBe(false);
      expect(cosmosBackend.documents.get(KYOTO_SECOND_PHOTO_ID)).toEqual({
        ...kyotoSecond,
        tripId: null,
        updatedAt: DELETED_AT
      });
    });

    // 「写真は残す」は画像に触れないので、写真の保存先(Blob Storage)の設定に頼らない。外側の beforeEach は設定を
    // 入れてあるので、このテストが設定を消す。使わない保存先のサービスを作る退行は、設定が無いので 500 になって落ちる
    it('写真は残すを選んだときは、写真の保存先の設定が無くても旅行を削除できる', async () => {
      freezeNow();
      delete process.env.STORAGE_CONNECTION_STRING;
      delete process.env.PHOTO_STORAGE_CONTAINER_NAME;
      const kyotoFirst = storedPhoto(KYOTO_FIRST_PHOTO_ID, KYOTO_TRIP_ID, '2026-10-05T09:00:00');
      cosmosBackend.documents.set(KYOTO_TRIP_ID, tripDocument(KYOTO_TRIP_ID, '京都旅行'));
      cosmosBackend.documents.set(KYOTO_FIRST_PHOTO_ID, kyotoFirst);
      const request = createDeleteRequest(KYOTO_TRIP_ID, 'false');

      const response = await deleteTripHandler(request, mockContext);

      expect(response.status).toBe(200);
      expect(response.jsonBody).toEqual({
        success: true,
        data: { message: '旅行が正常に削除されました', deletedPhotoCount: 0, detachedPhotoCount: 1 }
      });
      // 旅行だけが消え、写真は未所属に戻って残る
      expect(Array.from(cosmosBackend.documents.keys())).toEqual([KYOTO_FIRST_PHOTO_ID]);
      expect(cosmosBackend.documents.get(KYOTO_FIRST_PHOTO_ID)).toEqual({
        ...kyotoFirst,
        tripId: null,
        updatedAt: DELETED_AT
      });
    });

    const missingTripId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const photoOnlyId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

    it.each([
      ['旅行IDがUUIDの形式でない', 'abc', 'true', '旅行IDの形式が無効です'],
      ['deletePhotosが無い', KYOTO_TRIP_ID, undefined, '写真を削除するかどうかを指定してください'],
      ['deletePhotosがyes', KYOTO_TRIP_ID, 'yes', '写真を削除するかどうかの指定が無効です'],
      ['deletePhotosが大文字のTRUE', KYOTO_TRIP_ID, 'TRUE', '写真を削除するかどうかの指定が無効です'],
      ['deletePhotosが空文字', KYOTO_TRIP_ID, '', '写真を削除するかどうかの指定が無効です'],
      ['旅行IDもdeletePhotosも不正（IDの形式の検証が先）', 'abc', undefined, '旅行IDの形式が無効です'],
      [
        'deletePhotosが無く旅行も無い（deletePhotosの検証が先）',
        missingTripId,
        undefined,
        '写真を削除するかどうかを指定してください'
      ],
      [
        'deletePhotosが不正で旅行も無い（deletePhotosの検証が先）',
        missingTripId,
        'yes',
        '写真を削除するかどうかの指定が無効です'
      ]
    ])('旅行の削除で指定が正しくなければ、400で理由を返し何も変えない（%s）', async (_case, tripId, deletePhotos, message) => {
      cosmosBackend.documents.set(KYOTO_TRIP_ID, tripDocument(KYOTO_TRIP_ID, '京都旅行'));
      cosmosBackend.documents.set(
        KYOTO_FIRST_PHOTO_ID,
        storedPhoto(KYOTO_FIRST_PHOTO_ID, KYOTO_TRIP_ID, '2026-10-05T09:00:00')
      );
      putBlobs(`photos/${KYOTO_FIRST_PHOTO_ID}.jpg`, `photos/${KYOTO_FIRST_PHOTO_ID}.thumb.jpg`);
      const documentsBefore = structuredClone(cosmosBackend.documents);
      const request = createDeleteRequest(tripId, deletePhotos);

      const response = await deleteTripHandler(request, mockContext);

      expect(response.status).toBe(400);
      const body = response.jsonBody as any;
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('INVALID_REQUEST');
      expect(body.error.message).toBe(message);
      expect(cosmosBackend.documents).toEqual(documentsBefore);
      expect(blobBackend.store.size).toBe(2);
    });

    it.each([
      ['該当する旅行が無い', missingTripId],
      ['同じIDのものが写真だけ', photoOnlyId]
    ])('削除する旅行が無いと、404で理由を返し、写真に触れない（%s）', async (_case, tripId) => {
      // 旅行が無いのに削除を進めると壊れ方が大きい「写真も消す」で見る。
      // KYOTO_FIRST_PHOTO_ID の写真は、無い旅行(または写真のドキュメントしか無い id)を指している
      cosmosBackend.documents.set(photoOnlyId, storedPhoto(photoOnlyId, SAPPORO_TRIP_ID, '2026-10-05T09:00:00'));
      cosmosBackend.documents.set(
        KYOTO_FIRST_PHOTO_ID,
        storedPhoto(KYOTO_FIRST_PHOTO_ID, tripId, '2026-10-05T09:00:00')
      );
      putBlobs(`photos/${KYOTO_FIRST_PHOTO_ID}.jpg`, `photos/${KYOTO_FIRST_PHOTO_ID}.thumb.jpg`);
      const documentsBefore = structuredClone(cosmosBackend.documents);
      const request = createDeleteRequest(tripId, 'true');

      const response = await deleteTripHandler(request, mockContext);

      expect(response.status).toBe(404);
      const body = response.jsonBody as any;
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('TRIP_NOT_FOUND');
      expect(body.error.message).toBe('指定された旅行が見つかりません');
      expect(cosmosBackend.documents).toEqual(documentsBefore);
      expect(blobBackend.store.size).toBe(2);
    });

    // 失敗する箇所ごとに同じ分類の表を回す。どこで失敗しても応答は同じで、旅行は残る
    const deleteFailurePoints: [
      string,
      string,
      (backend: FakeCosmosBackend<FakeCosmosDocument>, error: Error) => void
    ][] = [
      ['旅行の読み取りで', 'false', (backend, error) => { backend.forcedReadError = error; }],
      ['写真の一覧の取得で', 'false', (backend, error) => { backend.forcedQueryError = error; }],
      ['写真を旅行から外す操作で', 'false', (backend, error) => { backend.forcedPatchError = error; }],
      ['写真のデータを消す操作で', 'true', (backend, error) => { backend.forcedDeleteError = error; }]
    ];
    const deleteFailureRows = deleteFailurePoints.flatMap(([point, deletePhotos, inject]) =>
      databaseFailureCases('旅行の削除に失敗しました').map(
        ([caseName, error, status, code, message]) =>
          [`${point}、${caseName}`, deletePhotos, inject, error, status, code, message] as const
      )
    );

    it.each(deleteFailureRows)(
      '旅行の削除の%s（旅行は残る）',
      async (_case, deletePhotos, inject, error, status, code, message) => {
        cosmosBackend.documents.set(KYOTO_TRIP_ID, tripDocument(KYOTO_TRIP_ID, '京都旅行'));
        cosmosBackend.documents.set(
          KYOTO_FIRST_PHOTO_ID,
          storedPhoto(KYOTO_FIRST_PHOTO_ID, KYOTO_TRIP_ID, '2026-10-05T09:00:00')
        );
        putBlobs(`photos/${KYOTO_FIRST_PHOTO_ID}.jpg`, `photos/${KYOTO_FIRST_PHOTO_ID}.thumb.jpg`);
        const documentsBefore = structuredClone(cosmosBackend.documents);
        inject(cosmosBackend, error);
        const request = createDeleteRequest(KYOTO_TRIP_ID, deletePhotos);

        const response = await deleteTripHandler(request, mockContext);

        expect(response.status).toBe(status);
        const body = response.jsonBody as any;
        expect(body.success).toBe(false);
        expect(body.error.code).toBe(code);
        expect(body.error.message).toBe(message);
        expect(cosmosBackend.documents).toEqual(documentsBefore);
        // どこで失敗しても画像には触れない(写真のデータを消す前に画像を消す誤りを見分ける)
        expect(Array.from(blobBackend.store.keys())).toEqual([
          `photos/${KYOTO_FIRST_PHOTO_ID}.jpg`,
          `photos/${KYOTO_FIRST_PHOTO_ID}.thumb.jpg`
        ]);
      }
    );

    // 写真を旅行から外したあと、最後の旅行の削除が失敗したとき。旅行は残り、外した写真は戻らない
    // (失敗してから再送しても、同じ結果になる)。404 は別のテストで成功として扱う
    it.each(
      databaseFailureCases('旅行の削除に失敗しました')
    )('写真を外した後、旅行を消すときに%s（旅行は残り、外した写真はそのまま）', async (_case, error, status, code, message) => {
      freezeNow();
      const kyoto = tripDocument(KYOTO_TRIP_ID, '京都旅行');
      const kyotoFirst = storedPhoto(KYOTO_FIRST_PHOTO_ID, KYOTO_TRIP_ID, '2026-10-05T09:00:00');
      cosmosBackend.documents.set(KYOTO_TRIP_ID, kyoto);
      cosmosBackend.documents.set(KYOTO_FIRST_PHOTO_ID, kyotoFirst);
      cosmosBackend.forcedDeleteError = error;
      const request = createDeleteRequest(KYOTO_TRIP_ID, 'false');

      const response = await deleteTripHandler(request, mockContext);

      expect(response.status).toBe(status);
      const body = response.jsonBody as any;
      expect(body.success).toBe(false);
      expect(body.error.code).toBe(code);
      expect(body.error.message).toBe(message);
      expect(Array.from(cosmosBackend.documents.keys())).toEqual([KYOTO_TRIP_ID, KYOTO_FIRST_PHOTO_ID]);
      expect(cosmosBackend.documents.get(KYOTO_TRIP_ID)).toEqual(kyoto);
      expect(cosmosBackend.documents.get(KYOTO_FIRST_PHOTO_ID)).toEqual({
        ...kyotoFirst,
        tripId: null,
        updatedAt: DELETED_AT
      });
    });

    // 画像を消すときだけ保存先を使うので、設定が足りないのは何かを消す前に分かる。
    // AccountKey が無い接続文字列で、保存先のサービスが作れない(鍵が空だと署名が壊れるので作らせない)
    it('写真も消すを選んだとき、写真の保存先の設定が足りなければ、何も消さずに500で返る', async () => {
      process.env.STORAGE_CONNECTION_STRING =
        'DefaultEndpointsProtocol=https;AccountName=test;EndpointSuffix=core.windows.net';
      cosmosBackend.documents.set(KYOTO_TRIP_ID, tripDocument(KYOTO_TRIP_ID, '京都旅行'));
      cosmosBackend.documents.set(
        KYOTO_FIRST_PHOTO_ID,
        storedPhoto(KYOTO_FIRST_PHOTO_ID, KYOTO_TRIP_ID, '2026-10-05T09:00:00')
      );
      putBlobs(`photos/${KYOTO_FIRST_PHOTO_ID}.jpg`, `photos/${KYOTO_FIRST_PHOTO_ID}.thumb.jpg`);
      const documentsBefore = structuredClone(cosmosBackend.documents);
      const request = createDeleteRequest(KYOTO_TRIP_ID, 'true');

      const response = await deleteTripHandler(request, mockContext);

      expect(response.status).toBe(500);
      const body = response.jsonBody as any;
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('INTERNAL_ERROR');
      expect(body.error.message).toBe('旅行の削除に失敗しました');
      expect(cosmosBackend.documents).toEqual(documentsBefore);
      expect(Array.from(blobBackend.store.keys())).toEqual([
        `photos/${KYOTO_FIRST_PHOTO_ID}.jpg`,
        `photos/${KYOTO_FIRST_PHOTO_ID}.thumb.jpg`
      ]);
    });
  });
});
