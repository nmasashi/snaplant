import { HttpRequest, InvocationContext } from '@azure/functions';
import { CosmosClient } from '@azure/cosmos';
import { getTripHandler, updateTripHandler } from '../../src/functions/tripDetail';
import { TripDocument } from '../../src/types/album';
import { FakeCosmosBackend, createFakeContainer } from '../fakes/cosmos';
import { databaseFailureCases } from '../helpers/databaseFailures';

// 外部依存のみモック
jest.mock('@azure/cosmos');
const MockedCosmosClient = CosmosClient as jest.MockedClass<typeof CosmosClient>;

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
  });

  afterEach(() => {
    jest.clearAllMocks();
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
    )('旅行を取り出すときに%s、決まった文言のエラーを返す', async (_case, error, status, code, message) => {
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
      ['旅行の読み取り', (backend, error) => { backend.forcedReadError = error; }],
      ['旅行の書き込み', (backend, error) => { backend.forcedReplaceError = error; }]
    ];
    const failureRows = failurePoints.flatMap(([point, inject]) =>
      databaseFailureCases('旅行の更新に失敗しました').map(
        ([caseName, error, status, code, message]) =>
          [`${point}で${caseName}`, inject, error, status, code, message] as const
      )
    );

    it.each(failureRows)(
      '旅行の更新で%s、決まった文言のエラーを返し何も変えない',
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
  });
});
