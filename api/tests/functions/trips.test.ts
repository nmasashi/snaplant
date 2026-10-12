import { HttpRequest, InvocationContext } from '@azure/functions';
import { CosmosClient } from '@azure/cosmos';
import { createTripHandler, listTripsHandler } from '../../src/functions/trips';
import { TripDocument } from '../../src/types/album';
import { FakeCosmosBackend, createFakeContainer } from '../fakes/cosmos';
import { databaseFailureCases } from '../helpers/databaseFailures';

// 外部依存のみモック
jest.mock('@azure/cosmos');
const MockedCosmosClient = CosmosClient as jest.MockedClass<typeof CosmosClient>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('旅行API', () => {
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
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete process.env.COSMOS_DB_ENDPOINT;
    delete process.env.COSMOS_DB_KEY;
    delete process.env.COSMOS_DB_DATABASE;
    delete process.env.COSMOS_DB_ALBUM_CONTAINER;
  });

  describe('旅行作成API', () => {
    it('旅行を作ると201で作った旅行が返り、保存される', async () => {
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
            createdAt: expect.any(String),
            updatedAt: expect.any(String)
          }
        }
      });
      const savedId = (response.jsonBody as any).data.trip.id;
      expect(cosmosBackend.documents.get(savedId)).toMatchObject({
        id: savedId,
        type: 'trip',
        name: '北海道 2026秋'
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

    it.each([
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
    ])('入力が正しくなければ400で理由を返し、何も保存しない（%s）', async (_case, json, message) => {
      const request = requestWith(json);

      const response = await createTripHandler(request, mockContext);

      expect(response.status).toBe(400);
      const body = response.jsonBody as any;
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('INVALID_REQUEST');
      expect(body.error.message).toBe(message);
      expect(cosmosBackend.documents.size).toBe(0);
    });

    it.each([
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
    ])('%sのときは、受け入れて保存する', async (_case, body, expected) => {
      const request = requestWith(jest.fn().mockResolvedValue(body));

      const response = await createTripHandler(request, mockContext);

      expect(response.status).toBe(201);
      const savedTrip = (response.jsonBody as any).data.trip;
      expect(savedTrip.name).toBe(expected.name);
      expect(savedTrip.description).toBe(expected.description);
      expect(cosmosBackend.documents.get(savedTrip.id)).toMatchObject(expected);
    });

    it.each([
      ['説明を省略した', { name: '北海道' }],
      ['説明にnullを指定した', { name: '北海道', description: null }],
      ['説明に空文字を指定した', { name: '北海道', description: '' }]
    ])('%sときは、説明なし（null）として保存される', async (_case, body) => {
      const request = requestWith(jest.fn().mockResolvedValue(body));

      const response = await createTripHandler(request, mockContext);

      expect(response.status).toBe(201);
      const savedTrip = (response.jsonBody as any).data.trip;
      expect(savedTrip.description).toBeNull();
      expect(cosmosBackend.documents.get(savedTrip.id)?.description).toBeNull();
    });

    it.each(
      databaseFailureCases('旅行の作成に失敗しました')
    )('旅行の作成で%s', async (_case, error, status, code, message) => {
      cosmosBackend.forcedCreateError = error;
      const request = requestWith(jest.fn().mockResolvedValue({ name: '北海道' }));

      const response = await createTripHandler(request, mockContext);

      expect(response.status).toBe(status);
      const body = response.jsonBody as any;
      expect(body.success).toBe(false);
      expect(body.error.code).toBe(code);
      expect(body.error.message).toBe(message);
    });
  });

  describe('旅行一覧API', () => {
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

    it.each(
      databaseFailureCases('旅行一覧の取得に失敗しました')
    )('旅行の一覧取得で%s', async (_case, error, status, code, message) => {
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
    });
  });
});
