import { HttpRequest, InvocationContext } from '@azure/functions';
import { CosmosClient } from '@azure/cosmos';
import { listCatalogEntriesHandler } from '../../src/functions/catalogEntries';
import { FakeCosmosBackend, FakeCosmosDocument, createFakeContainer } from '../fakes/cosmos';
import { databaseFailureCases } from '../helpers/databaseFailures';
import { forEachCase } from '../helpers/cases';

// 外部依存のみモック。Cosmos DB は状態持ちの偽物
// 偽物は GROUP BY と ORDER BY を解釈しないので、名前ごとの枚数と見出しの写真からページを組み立てる所は
// tests/services/catalogEntries.test.ts で確かめる（CLAUDE.md の名簿）。ここは検証・0件・障害を見る
jest.mock('@azure/cosmos');

const MockedCosmosClient = CosmosClient as jest.MockedClass<typeof CosmosClient>;

/**
 * 項目の一覧の要求。query は実際の HttpRequest と同じ URLSearchParams にする
 * （Map だと、無い項目の get が null ではなく undefined を返し、実際と違う）
 */
const createRequest = (query: Record<string, string>): HttpRequest => {
  const searchParams = new URLSearchParams({ code: 'test-key', ...query });
  return {
    method: 'GET',
    url: `https://func-snaplant.azurewebsites.net/api/catalog/entries?${searchParams.toString()}`,
    query: searchParams,
    headers: new Map(),
    params: {}
  } as any as HttpRequest;
};

describe('図鑑の項目の一覧API', () => {
  let mockContext: InvocationContext;
  let cosmosBackend: FakeCosmosBackend<FakeCosmosDocument>;

  beforeEach(() => {
    mockContext = { log: jest.fn() } as any;
    cosmosBackend = { documents: new Map() };
    const fakeContainer = createFakeContainer(cosmosBackend);
    MockedCosmosClient.mockImplementation(() => ({
      database: () => ({ container: () => fakeContainer })
    }) as unknown as CosmosClient);

    process.env.COSMOS_DB_ENDPOINT = 'https://test.documents.azure.com:443/';
    process.env.COSMOS_DB_KEY = 'test-key';
    process.env.COSMOS_DB_DATABASE = 'test-db';
    process.env.COSMOS_DB_ALBUM_CONTAINER = 'test-album';
    process.env.STORAGE_CONNECTION_STRING =
      'DefaultEndpointsProtocol=https;AccountName=test;AccountKey=testkey==;EndpointSuffix=core.windows.net';
    process.env.PHOTO_STORAGE_CONTAINER_NAME = 'photos';
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('識別された写真が無ければ、200で空の一覧と総数0を返す', async () => {
    const response = await listCatalogEntriesHandler(createRequest({ kind: 'plant' }), mockContext);

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({ success: true, data: { entries: [], total: 0 } });
  });

  it('ページの指定の境界は受け付ける', () => forEachCase([
    ['offset が 0', { offset: '0' }],
    ['limit が上限の 100', { limit: '100' }],
    ['limit が 1', { limit: '1' }]
  ], async (_label, page) => {
    const response = await listCatalogEntriesHandler(createRequest({ kind: 'food', ...page }), mockContext);

    expect(response.status).toBe(200);
  }));

  describe('受け付けないとき', () => {
    it('種類やページ（offset・limit）の指定が正しくなければ、400で理由を返す', () => forEachCase([
      ['種類が無い', {}, '図鑑の種類が無効です'],
      ['種類が定義表に無い（other）', { kind: 'other' }, '図鑑の種類が無効です'],
      ['種類が継承したキー（constructor）', { kind: 'constructor' }, '図鑑の種類が無効です'],
      // 種類は空白を除かず、大文字小文字も区別して比べる（05 §5.14 の検証の表）
      ['種類の大文字小文字が違う（Plant）', { kind: 'Plant' }, '図鑑の種類が無効です'],
      ['種類の前後に空白がある', { kind: ' plant' }, '図鑑の種類が無効です'],
      ['offset が負', { kind: 'plant', offset: '-1' }, 'ページの指定が無効です'],
      ['offset が整数でない', { kind: 'plant', offset: '1.5' }, 'ページの指定が無効です'],
      ['offset が空', { kind: 'plant', offset: '' }, 'ページの指定が無効です'],
      ['offset の先頭がゼロ', { kind: 'plant', offset: '01' }, 'ページの指定が無効です'],
      ['offset が安全な整数（2^53 − 1）を超える', { kind: 'plant', offset: '9007199254740992' }, 'ページの指定が無効です'],
      ['limit が 0', { kind: 'plant', limit: '0' }, 'ページの指定が無効です'],
      ['limit の先頭がゼロ', { kind: 'plant', limit: '01' }, 'ページの指定が無効です'],
      ['limit が指数表記', { kind: 'plant', limit: '1e2' }, 'ページの指定が無効です'],
      ['limit が上限の 100 を超える', { kind: 'plant', limit: '101' }, 'ページの指定が無効です'],
      ['limit が数でない', { kind: 'plant', limit: 'ten' }, 'ページの指定が無効です'],
      ['limit が整数でない', { kind: 'plant', limit: '1.5' }, 'ページの指定が無効です'],
      ['limit が空', { kind: 'plant', limit: '' }, 'ページの指定が無効です'],
      // 検証の順: 種類 → ページ
      ['種類もページも不正（種類の指摘が先）', { kind: 'other', limit: '0' }, '図鑑の種類が無効です']
    ], async (_label, query, message) => {
      const response = await listCatalogEntriesHandler(createRequest(query), mockContext);

      expect(response.status).toBe(400);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'INVALID_REQUEST', message } });
    }));
  });

  it('データベースの読み取りで、データベースに接続できなければ503、それ以外の失敗は500で決まった文言を返す', () => forEachCase(databaseFailureCases('図鑑の一覧の取得に失敗しました'), async (_case, error, status, code, message) => {
    cosmosBackend.forcedQueryError = error;

    const response = await listCatalogEntriesHandler(createRequest({ kind: 'plant' }), mockContext);

    expect(response.status).toBe(status);
    expect(response.jsonBody).toMatchObject({ success: false, error: { code, message } });
  }));
});
