import { HttpRequest, InvocationContext } from '@azure/functions';
import { CosmosClient } from '@azure/cosmos';
import { BlobServiceClient, generateBlobSASQueryParameters } from '@azure/storage-blob';
import { createTripHandler, listTripsHandler } from '../../src/functions/trips';
import { FakeCosmosBackend, FakeCosmosDocument, createFakeContainer } from '../fakes/cosmos';
import { BlobEntry, TEST_BLOB_HOST, createFakeBlobServiceClient } from '../fakes/blob';
import { COSMOS_SYSTEM_FIELDS, photoDocument, tripDocument } from '../helpers/albumDocuments';
import { allDatabaseFailureCases, databaseFailureCases } from '../helpers/databaseFailures';
import { forEachCase } from '../helpers/cases';

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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TEST_SAS_TOKEN = 'sv=2024-01-01&se=2030-01-01T00%3A00%3A00Z&sp=r&sig=testsignature';

// 表紙のテストで使う旅行の id: 京都(写真2枚)・札幌(写真1枚)・奈良(写真なし)
const KYOTO_TRIP_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SAPPORO_TRIP_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NARA_TRIP_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

// 写真の id(小文字16進 64 文字)。表紙では画像のバイト列は使わないので、写真を見分けられる値にしている
const KYOTO_FIRST_PHOTO_ID = '1'.repeat(64);
const SAPPORO_PHOTO_ID = '2'.repeat(64);
const KYOTO_SECOND_PHOTO_ID = '3'.repeat(64);

/**
 * 保存済みの写真のドキュメント(サムネイルあり)。表紙は旅行(tripId)と並べ替え用の日時(sortAt)で選ばれ、
 * URL は Blob 名(サムネイルは `<id>.thumb.jpg`)に基づくので、ここで決める。ほかの項目は表紙に関係しない
 */
const storedPhoto = (id: string, tripId: string, sortAt: string) =>
  photoDocument(id, { tripId, sortAt, blobName: `${id}.jpg`, thumbnailBlobName: `${id}.thumb.jpg` });

describe('旅行API', () => {
  let mockContext: InvocationContext;
  // 旅行も写真も置くので、偽物の型は絞り込みに使う最小の項目だけにする
  let cosmosBackend: FakeCosmosBackend<FakeCosmosDocument>;

  beforeEach(() => {
    mockContext = { log: jest.fn() } as any;

    cosmosBackend = { documents: new Map() };
    const fakeContainer = createFakeContainer(cosmosBackend);
    MockedCosmosClient.mockImplementation(() => ({
      database: () => ({
        container: () => fakeContainer
      })
    } as unknown as CosmosClient));

    // 表紙の URL を作るために偽物のサービスクライアントが要る(表紙の Blob の中身は読まない)
    MockedBlobServiceClient.fromConnectionString = jest
      .fn()
      .mockReturnValue(createFakeBlobServiceClient({ store: new Map<string, BlobEntry>() }));
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
  });

  describe('旅行作成API', () => {
    it('旅行を作ると201で作った旅行が返り、保存される', async () => {
      // 時刻だけを固定する。他のタイマーまで偽物にすると非同期処理が止まりうる
      jest.useFakeTimers({
        now: new Date('2026-10-12T03:04:05.000Z'),
        doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'setTimeout', 'setInterval']
      });
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/trips?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        json: jest.fn().mockResolvedValue({
          name: '北海道 2026秋',
          description: '紅葉を見に行く'
        })
      } as any as HttpRequest;

      const response = await createTripHandler(request, mockContext);

      expect(response.status).toBe(201);
      expect(response.jsonBody).toEqual({
        success: true,
        data: {
          trip: {
            id: expect.stringMatching(UUID_PATTERN),
            name: '北海道 2026秋',
            description: '紅葉を見に行く',
            tags: [],
            createdAt: '2026-10-12T03:04:05.000Z',
            updatedAt: '2026-10-12T03:04:05.000Z'
          }
        }
      });
      const savedId = (response.jsonBody as any).data.trip.id;
      expect(cosmosBackend.documents.get(savedId)).toMatchObject({
        id: savedId,
        type: 'trip',
        name: '北海道 2026秋',
        createdAt: '2026-10-12T03:04:05.000Z',
        updatedAt: '2026-10-12T03:04:05.000Z'
      });
    });

    const requestWith = (json: jest.Mock): HttpRequest =>
      ({
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/trips?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        json
      }) as any as HttpRequest;

    it('入力が正しくなければ400で理由を返し、何も保存しない', () => forEachCase([
      [
        'ボディがJSONとしてパースできない',
        jest.fn().mockRejectedValue(new SyntaxError('Unexpected token')),
        'リクエストボディの形式が無効です'
      ],
      ['ボディがnull', jest.fn().mockResolvedValue(null), 'リクエストボディが指定されていません'],
      ['nameが数値', jest.fn().mockResolvedValue({ name: 123 }), '旅行名は文字列で指定してください'],
      [
        'descriptionが数値',
        jest.fn().mockResolvedValue({ name: '北海道', description: 123 }),
        '説明は文字列で指定してください'
      ],
      ['nameが未指定', jest.fn().mockResolvedValue({}), '旅行名が指定されていません'],
      ['nameがnull', jest.fn().mockResolvedValue({ name: null }), '旅行名が指定されていません'],
      ['nameが空文字', jest.fn().mockResolvedValue({ name: '' }), '旅行名が指定されていません'],
      ['nameが空白のみ', jest.fn().mockResolvedValue({ name: '   ' }), '旅行名が指定されていません'],
      [
        'nameが前後の空白を除いて101文字',
        jest.fn().mockResolvedValue({ name: ` ${'あ'.repeat(101)} ` }),
        '旅行名は100文字以内で指定してください'
      ],
      [
        'descriptionが1001文字',
        jest.fn().mockResolvedValue({ name: '北海道', description: 'あ'.repeat(1001) }),
        '説明は1000文字以内で指定してください'
      ],
      [
        'nameもdescriptionも数値（nameの指摘が先）',
        jest.fn().mockResolvedValue({ name: 123, description: 456 }),
        '旅行名は文字列で指定してください'
      ]
    ], async (_case, json, message) => {
      const request = requestWith(json);

      const response = await createTripHandler(request, mockContext);

      expect(response.status).toBe(400);
      const body = response.jsonBody as any;
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('INVALID_REQUEST');
      expect(body.error.message).toBe(message);
      expect(cosmosBackend.documents.size).toBe(0);
    }));

    it('旅行名と説明が上限ちょうどのときは、受け入れて保存する', () => forEachCase([
      [
        '旅行名が前後の空白を除いてちょうど100文字',
        { name: ` ${'あ'.repeat(100)} `, description: null },
        { name: 'あ'.repeat(100), description: null }
      ],
      [
        '説明がちょうど1000文字',
        { name: '北海道', description: 'あ'.repeat(1000) },
        { name: '北海道', description: 'あ'.repeat(1000) }
      ]
    ], async (_case, body, expected) => {
      const request = requestWith(jest.fn().mockResolvedValue(body));

      const response = await createTripHandler(request, mockContext);

      expect(response.status).toBe(201);
      const savedTrip = (response.jsonBody as any).data.trip;
      expect(savedTrip.name).toBe(expected.name);
      expect(savedTrip.description).toBe(expected.description);
      expect(cosmosBackend.documents.get(savedTrip.id)).toMatchObject(expected);
    }));

    it('説明を省略した・null・空文字のときは、説明なし（null）として保存される', () => forEachCase([
      ['説明を省略した', { name: '北海道' }],
      ['説明にnullを指定した', { name: '北海道', description: null }],
      ['説明に空文字を指定した', { name: '北海道', description: '' }]
    ], async (_case, body) => {
      const request = requestWith(jest.fn().mockResolvedValue(body));

      const response = await createTripHandler(request, mockContext);

      expect(response.status).toBe(201);
      const savedTrip = (response.jsonBody as any).data.trip;
      expect(savedTrip.description).toBeNull();
      expect(cosmosBackend.documents.get(savedTrip.id)).toMatchObject({ description: null });
    }));

    it('旅行の作成で、データベースに接続できなければ503、それ以外の失敗は500で決まった文言を返す（接続の失敗は cause もたどる）', () => forEachCase(allDatabaseFailureCases('旅行の作成に失敗しました'), async (_case, error, status, code, message) => {
      cosmosBackend.forcedCreateError = error;
      const request = requestWith(jest.fn().mockResolvedValue({ name: '北海道' }));

      const response = await createTripHandler(request, mockContext);

      expect(response.status).toBe(status);
      const body = response.jsonBody as any;
      expect(body.success).toBe(false);
      expect(body.error.code).toBe(code);
      expect(body.error.message).toBe(message);
    }));

    it('旅行の作成で、原因（cause）が循環したエラーのときも、止まらずに内部エラー（500）を返す', async () => {
      // 接続できない障害かは cause をたどって判定する。循環に歯止めが無いと、このテストは
      // 同期の無限ループになる。同期ループは Jest の testTimeout（10秒）では中断できないため、
      // 失敗はテストの赤ではなく CI のジョブのタイムアウトとして現れる
      const a: any = new Error('a');
      const b: any = new Error('b');
      a.cause = b;
      b.cause = a;
      cosmosBackend.forcedCreateError = a;
      const request = requestWith(jest.fn().mockResolvedValue({ name: '北海道' }));

      const response = await createTripHandler(request, mockContext);

      expect(response.status).toBe(500);
      const body = response.jsonBody as any;
      expect(body.error.code).toBe('INTERNAL_ERROR');
      expect(body.error.message).toBe('旅行の作成に失敗しました');
    });
  });

  describe('旅行一覧API', () => {
    it('旅行の一覧には、データベースが付けた内部の項目と種別は返らない', async () => {
      // 偽物の Cosmos はシステム項目を付けないので、実際の Cosmos が保存したドキュメントの形を自分で置く
      cosmosBackend.documents.set(KYOTO_TRIP_ID, { ...tripDocument(KYOTO_TRIP_ID, '京都旅行'), ...COSMOS_SYSTEM_FIELDS });
      const request = {
        method: 'GET',
        url: 'https://func-snaplant.azurewebsites.net/api/trips?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map()
      } as any as HttpRequest;

      const response = await listTripsHandler(request, mockContext);

      expect(response.status).toBe(200);
      expect(Object.keys((response.jsonBody as any).data.trips[0]).sort()).toEqual([
        'coverThumbnailUrl', 'createdAt', 'description', 'firstTakenAt', 'id',
        'lastTakenAt', 'name', 'photoCount', 'tags', 'updatedAt'
      ]);
    });

    it('写真が無ければ、各旅行の枚数と旅行に属さない写真の枚数が0で返る', async () => {
      const kyoto = {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        name: '京都旅行',
        description: null,
        tags: [],
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z'
      };
      const sapporo = {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        name: '札幌旅行',
        description: '雪まつり',
        tags: ['国内'],
        createdAt: '2026-10-02T00:00:00.000Z',
        updatedAt: '2026-10-03T00:00:00.000Z'
      };
      cosmosBackend.documents.set(kyoto.id, { ...kyoto, type: 'trip' });
      cosmosBackend.documents.set(sapporo.id, { ...sapporo, type: 'trip' });
      const request = {
        method: 'GET',
        url: 'https://func-snaplant.azurewebsites.net/api/trips?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map()
      } as any as HttpRequest;

      const response = await listTripsHandler(request, mockContext);

      // 並び順は ORDER BY によるもので偽物では見られないため、順序に依存せず比べる
      const summary = { photoCount: 0, firstTakenAt: null, lastTakenAt: null, coverThumbnailUrl: null };
      expect(response.status).toBe(200);
      const body = response.jsonBody as any;
      expect(body.success).toBe(true);
      expect(body.data.trips).toHaveLength(2);
      expect(body.data.trips).toEqual(
        expect.arrayContaining([{ ...kyoto, ...summary }, { ...sapporo, ...summary }])
      );
      expect(body.data.total).toBe(2);
      expect(body.data.unassignedPhotoCount).toBe(0);
    });

    describe('表紙', () => {
      // 写真の無い旅行の一覧は、写真の保存先(Blob Storage)の設定に頼らない。設定が無い環境でも旅行の一覧は返る。
      // 外側の beforeEach は設定を入れてあるので、このテストが設定を消す。
      // 表紙にする写真が無いのに Blob のサービスを作る退行は、設定が無いので 500 になって落ちる
      it('写真の保存先の設定が無くても、写真の無い旅行だけなら一覧が返り、表紙はnull', async () => {
        delete process.env.STORAGE_CONNECTION_STRING;
        delete process.env.PHOTO_STORAGE_CONTAINER_NAME;
        cosmosBackend.documents.set(KYOTO_TRIP_ID, tripDocument(KYOTO_TRIP_ID, '京都旅行'));
        cosmosBackend.documents.set(NARA_TRIP_ID, tripDocument(NARA_TRIP_ID, '奈良旅行'));
        const request = {
          method: 'GET',
          url: 'https://func-snaplant.azurewebsites.net/api/trips?code=test-key',
          query: new Map([['code', 'test-key']]),
          headers: new Map()
        } as any as HttpRequest;

        const response = await listTripsHandler(request, mockContext);

        expect(response.status).toBe(200);
        const body = response.jsonBody as any;
        const coverByTripId = Object.fromEntries(body.data.trips.map((trip: any) => [trip.id, trip.coverThumbnailUrl]));
        expect(coverByTripId).toEqual({ [KYOTO_TRIP_ID]: null, [NARA_TRIP_ID]: null });
      });

      it('旅行の一覧では、旅行ごとにその旅行の先頭の写真が表紙になり、写真の無い旅行は表紙なし', async () => {
        // 集計(photoCount など)は偽物では解釈できないので、このテストは表紙の URL だけを見る。
        // 偽物は ORDER BY を解釈せず挿入順で返すので、各旅行の写真が sortAt の昇順になる順で置く。
        // 京都と札幌の写真は交互に置く(京都1枚目 → 札幌 → 京都2枚目): 旅行での絞り込みが効いていないと、
        // 札幌と奈良が京都の1枚目を表紙にして取り違える。先頭ではなく最後の写真を取ると、京都は2枚目になる。
        // 旅行は、写真の無い奈良を京都と札幌の間に挟んで置く: 表紙を旅行に突き合わせる位置がずれると取り違える。
        // 並び順(作成日時の降順)は偽物では見られないので、旅行の id ごとに表紙を取り出して比べる
        cosmosBackend.documents.set(KYOTO_TRIP_ID, tripDocument(KYOTO_TRIP_ID, '京都旅行'));
        cosmosBackend.documents.set(NARA_TRIP_ID, tripDocument(NARA_TRIP_ID, '奈良旅行'));
        cosmosBackend.documents.set(SAPPORO_TRIP_ID, tripDocument(SAPPORO_TRIP_ID, '札幌旅行'));
        cosmosBackend.documents.set(
          KYOTO_FIRST_PHOTO_ID,
          storedPhoto(KYOTO_FIRST_PHOTO_ID, KYOTO_TRIP_ID, '2026-10-05T09:00:00')
        );
        cosmosBackend.documents.set(
          SAPPORO_PHOTO_ID,
          storedPhoto(SAPPORO_PHOTO_ID, SAPPORO_TRIP_ID, '2026-10-06T09:00:00')
        );
        cosmosBackend.documents.set(
          KYOTO_SECOND_PHOTO_ID,
          storedPhoto(KYOTO_SECOND_PHOTO_ID, KYOTO_TRIP_ID, '2026-10-07T09:00:00')
        );
        const request = {
          method: 'GET',
          url: 'https://func-snaplant.azurewebsites.net/api/trips?code=test-key',
          query: new Map([['code', 'test-key']]),
          headers: new Map()
        } as any as HttpRequest;

        const response = await listTripsHandler(request, mockContext);

        expect(response.status).toBe(200);
        const body = response.jsonBody as any;
        const coverByTripId = Object.fromEntries(body.data.trips.map((trip: any) => [trip.id, trip.coverThumbnailUrl]));
        expect(coverByTripId).toEqual({
          [KYOTO_TRIP_ID]: `https://${TEST_BLOB_HOST}/photos/${KYOTO_FIRST_PHOTO_ID}.thumb.jpg?${TEST_SAS_TOKEN}`,
          [NARA_TRIP_ID]: null,
          [SAPPORO_TRIP_ID]: `https://${TEST_BLOB_HOST}/photos/${SAPPORO_PHOTO_ID}.thumb.jpg?${TEST_SAS_TOKEN}`
        });
      });
    });

    it('旅行の一覧取得で、データベースに接続できなければ503、それ以外の失敗は500で決まった文言を返す', () => forEachCase(databaseFailureCases('旅行一覧の取得に失敗しました'), async (_case, error, status, code, message) => {
      cosmosBackend.forcedQueryError = error;
      const request = {
        method: 'GET',
        url: 'https://func-snaplant.azurewebsites.net/api/trips?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map()
      } as any as HttpRequest;

      const response = await listTripsHandler(request, mockContext);

      expect(response.status).toBe(status);
      const body = response.jsonBody as any;
      expect(body.success).toBe(false);
      expect(body.error.code).toBe(code);
      expect(body.error.message).toBe(message);
    }));
  });
});
