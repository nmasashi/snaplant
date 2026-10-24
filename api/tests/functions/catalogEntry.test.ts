import { HttpRequest, InvocationContext } from '@azure/functions';
import { CosmosClient } from '@azure/cosmos';
import { BlobServiceClient, generateBlobSASQueryParameters } from '@azure/storage-blob';
import { getCatalogEntryHandler } from '../../src/functions/catalogEntry';
import { PhotoDocument } from '../../src/types/album';
import { FakeCosmosBackend, FakeCosmosDocument, createFakeContainer } from '../fakes/cosmos';
import { BlobEntry, FakeBlobBackend, TEST_BLOB_HOST, createFakeBlobServiceClient } from '../fakes/blob';
import { photoDocument } from '../helpers/albumDocuments';
import { databaseFailureCases } from '../helpers/databaseFailures';

// 外部依存のみモック。Cosmos DB は状態持ちの偽物（図鑑の種類と名前は @kind・@entryName で絞る）。
// 偽物は ORDER BY と COUNT を解釈しないので、見出しの写真の選び方（信頼度の降順）・写真の並び（sortAt）・枚数（photoCount）は
// ここでは見ない（デプロイ後に手で確かめる。docs/08_test_plan.md §5.3）。
// SAS の署名に使う関数は、固定のトークンを返す形に差し替える（署名の中身は photos.test.ts が実 SDK で見ている）
jest.mock('@azure/cosmos');
jest.mock('@azure/storage-blob', () => ({
  BlobServiceClient: { fromConnectionString: jest.fn() },
  BlobSASPermissions: jest.fn().mockImplementation(() => ({})),
  StorageSharedKeyCredential: jest.fn().mockImplementation(() => ({})),
  generateBlobSASQueryParameters: jest.fn()
}));

const MockedCosmosClient = CosmosClient as jest.MockedClass<typeof CosmosClient>;
const MockedBlobServiceClient = BlobServiceClient as jest.MockedClass<typeof BlobServiceClient>;
const mockedGenerateSas = generateBlobSASQueryParameters as jest.MockedFunction<typeof generateBlobSASQueryParameters>;

const TEST_SAS_TOKEN = 'sv=2024-01-01&se=2030-01-01T00%3A00%3A00Z&sp=r&sig=testsignature';
const NOW = '2026-10-18T12:00:00.000Z';

/** 識別済みの写真。id の先頭の文字で見分ける */
const identifiedPhoto = (
  head: string,
  kind: string,
  name: string | null,
  confidence: number,
  overrides: Partial<PhotoDocument> = {}
): PhotoDocument =>
  photoDocument(head.repeat(64), {
    blobName: `${head.repeat(64)}.jpg`,
    thumbnailBlobName: `${head.repeat(64)}.thumb.jpg`,
    category: kind,
    identification: {
      kind,
      matchesKind: name !== null,
      name,
      confidence,
      description: name === null ? null : `${name}の説明`,
      characteristics: name === null ? null : `${name}の特徴`,
      attributes: name === null ? {} : { scientificName: `${name}の学名`, familyName: 'ウリ科' },
      reason: name === null ? '写っていない' : null,
      model: 'gpt-6-luna',
      at: '2026-10-18T09:40:00.000Z'
    },
    ...overrides
  });

/**
 * 項目の詳細の要求。query は実際の HttpRequest と同じ URLSearchParams にする
 * （名前は URLSearchParams が URL エンコードし、get が復号する。Functions の request.query と同じ）
 */
const createRequest = (query: Record<string, string>): HttpRequest => {
  const searchParams = new URLSearchParams({ code: 'test-key', ...query });
  return {
    method: 'GET',
    url: `https://func-snaplant.azurewebsites.net/api/catalog/entry?${searchParams.toString()}`,
    query: searchParams,
    headers: new Map(),
    params: {}
  } as any as HttpRequest;
};

describe('図鑑の項目の詳細API', () => {
  let mockContext: InvocationContext;
  let cosmosBackend: FakeCosmosBackend<FakeCosmosDocument>;

  const urlOf = (blobName: string) => `https://${TEST_BLOB_HOST}/photos/${blobName}?${TEST_SAS_TOKEN}`;
  const photoIdsOf = (response: any): string[] => response.jsonBody.data.photos.map((photo: { id: string }) => photo.id);

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date(NOW), doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'setTimeout', 'setInterval'] });
    mockContext = { log: jest.fn() } as any;
    cosmosBackend = { documents: new Map() };
    const fakeContainer = createFakeContainer(cosmosBackend);
    MockedCosmosClient.mockImplementation(() => ({
      database: () => ({ container: () => fakeContainer })
    }) as unknown as CosmosClient);
    const blobBackend: FakeBlobBackend = { store: new Map<string, BlobEntry>(), forcedUploadError: null };
    MockedBlobServiceClient.fromConnectionString = jest.fn().mockReturnValue(createFakeBlobServiceClient(blobBackend));
    mockedGenerateSas.mockReturnValue({ toString: () => TEST_SAS_TOKEN } as any);

    process.env.COSMOS_DB_ENDPOINT = 'https://test.documents.azure.com:443/';
    process.env.COSMOS_DB_KEY = 'test-key';
    process.env.COSMOS_DB_DATABASE = 'test-db';
    process.env.COSMOS_DB_ALBUM_CONTAINER = 'test-album';
    process.env.STORAGE_CONNECTION_STRING =
      'DefaultEndpointsProtocol=https;AccountName=test;AccountKey=testkey==;EndpointSuffix=core.windows.net';
    process.env.PHOTO_STORAGE_CONTAINER_NAME = 'photos';
    process.env.PHOTO_SAS_EXPIRY_MINUTES = '60';

    // 植物のメロン（見出しになる信頼度の高い1枚を先に置く）と、同じ名前の食べ物、別の名前の植物、写っていない植物
    for (const photo of [
      identifiedPhoto('a', 'plant', 'メロン', 92),
      identifiedPhoto('b', 'plant', 'メロン', 60, { thumbnailBlobName: null }),
      identifiedPhoto('c', 'food', 'メロン', 95),
      identifiedPhoto('d', 'plant', 'スイカ', 88),
      identifiedPhoto('e', 'plant', null, 20)
    ]) {
      cosmosBackend.documents.set(photo.id, photo);
    }
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('種類と名前で開くと、200で見出しの写真からの項目と、その種類・名前の写真の1ページを返す', async () => {
    // 同じ名前でも種類が違う写真（食べ物のメロン）と、写っていない写真は含めない（04 §3.1）
    const response = await getCatalogEntryHandler(createRequest({ kind: 'plant', name: 'メロン' }), mockContext);

    expect(response.status).toBe(200);
    const data = (response.jsonBody as any).data;
    // photoCount は見ない（偽物は COUNT の代わりに文書を返す）。toEqual にしない
    expect(data.entry).toMatchObject({
      kind: 'plant',
      name: 'メロン',
      confidence: 92,
      description: 'メロンの説明',
      characteristics: 'メロンの特徴',
      attributes: { scientificName: 'メロンの学名', familyName: 'ウリ科' },
      coverThumbnailUrl: urlOf(`${'a'.repeat(64)}.thumb.jpg`)
    });
    expect(photoIdsOf(response).sort()).toEqual(['a'.repeat(64), 'b'.repeat(64)]);
    expect(data.photos.find((photo: { id: string }) => photo.id === 'b'.repeat(64))).toMatchObject({
      imageUrl: urlOf(`${'b'.repeat(64)}.jpg`),
      thumbnailUrl: null
    });
    expect(data.continuationToken).toBeNull();
    expect(data.urlExpiresAt).toBe('2026-10-18T13:00:00.000Z');
  });

  it('同じ名前でも種類を替えれば、その種類の項目と写真になる', async () => {
    // 畑のメロンは植物、皿のメロンは食べ物（04 §3.1。まとめる鍵に種類を含める理由）
    const response = await getCatalogEntryHandler(createRequest({ kind: 'food', name: 'メロン' }), mockContext);

    expect((response.jsonBody as any).data.entry).toMatchObject({ kind: 'food', name: 'メロン', confidence: 95 });
    expect(photoIdsOf(response)).toEqual(['c'.repeat(64)]);
  });

  it('名前は前後の空白を除いてから比べる', async () => {
    const response = await getCatalogEntryHandler(createRequest({ kind: 'plant', name: '  メロン ' }), mockContext);

    expect((response.jsonBody as any).data.entry).toMatchObject({ name: 'メロン' });
    expect(photoIdsOf(response).sort()).toEqual(['a'.repeat(64), 'b'.repeat(64)]);
  });

  it('その種類と名前の写真が無ければ、200で entry: null・空のページを返す', async () => {
    // 項目は文書ではなく「該当する写真が0枚」に過ぎないので 404 にしない（05 §5.14）。やり直しで名前が変わった直後に起きる
    const response = await getCatalogEntryHandler(createRequest({ kind: 'food', name: 'スイカ' }), mockContext);

    expect(response.status).toBe(200);
    expect((response.jsonBody as any).data).toMatchObject({ entry: null, photos: [], continuationToken: null });
  });

  it('続きを読む間に項目の写真が無くなったら、古い継続トークンでも 200 で entry: null を返す（読み終える）', async () => {
    // 03 §6.2。見出しが無ければ写真のページを読まないので、トークンを Cosmos に渡さない
    const response = await getCatalogEntryHandler(
      createRequest({ kind: 'food', name: 'スイカ', continuationToken: '{}' }),
      mockContext
    );

    expect(response.status).toBe(200);
    expect((response.jsonBody as any).data).toMatchObject({ entry: null, photos: [], continuationToken: null });
  });

  it('写真は limit 枚ずつのページで、継続トークンで続きを読む', async () => {
    // ページの受け渡しは GET /api/photos と同じ（05 §5.14）
    const first = await getCatalogEntryHandler(createRequest({ kind: 'plant', name: 'メロン', limit: '1' }), mockContext);
    const token = (first.jsonBody as any).data.continuationToken;
    const second = await getCatalogEntryHandler(
      createRequest({ kind: 'plant', name: 'メロン', limit: '1', continuationToken: token }),
      mockContext
    );

    expect(typeof token).toBe('string');
    expect([...photoIdsOf(first), ...photoIdsOf(second)].sort()).toEqual(['a'.repeat(64), 'b'.repeat(64)]);
    expect((second.jsonBody as any).data.continuationToken).toBeNull();
  });

  it.each([
    ['名前が前後の空白を除いて100文字ちょうど', { kind: 'plant', name: ` ${'あ'.repeat(100)} ` }],
    ['写真の枚数が上限の200', { kind: 'plant', name: 'メロン', limit: '200' }]
  ])('境界（%s）は受け付ける', async (_label, query) => {
    // 名前の長さは前後の空白を除いてから数える（05 §5.14 の検証の表の 3）
    const response = await getCatalogEntryHandler(createRequest(query), mockContext);

    expect(response.status).toBe(200);
  });

  describe('受け付けないとき', () => {
    it.each([
      ['種類が無い', { name: 'メロン' }, '図鑑の種類が無効です'],
      ['種類が定義表に無い（other）', { kind: 'other', name: 'メロン' }, '図鑑の種類が無効です'],
      // 種類は空白を除かずに比べる（項目の一覧と同じ）
      ['種類の前後に空白がある', { kind: ' plant', name: 'メロン' }, '図鑑の種類が無効です'],
      ['名前が無い', { kind: 'plant' }, '図鑑の項目の名前が指定されていません'],
      ['名前が空白だけ', { kind: 'plant', name: '   ' }, '図鑑の項目の名前が指定されていません'],
      ['名前が前後の空白を除いて100文字を超える', { kind: 'plant', name: ` ${'あ'.repeat(101)} ` }, '図鑑の項目の名前は100文字以内で指定してください'],
      ['写真の枚数が上限を超える', { kind: 'plant', name: 'メロン', limit: '201' }, '1ページの枚数は1〜200で指定してください'],
      ['継続トークンが JSON でない', { kind: 'plant', name: 'メロン', continuationToken: 'not-json' }, '継続トークンの形式が無効です'],
      // JSON としては読めるが Cosmos が受け付けない（偽物は、自分が作った形でないトークンに code 400 を投げる。実環境の 400 は推測）
      ['継続トークンが Cosmos の受け付けない JSON', { kind: 'plant', name: 'メロン', continuationToken: '{}' }, '継続トークンの形式が無効です'],
      // 検証の順: 種類 → 名前 → 名前の長さ → ページ
      ['種類も名前も不正（種類の指摘が先）', { kind: 'other' }, '図鑑の種類が無効です'],
      ['名前もページも不正（名前の指摘が先）', { kind: 'plant', name: '', limit: '0' }, '図鑑の項目の名前が指定されていません']
    ])('%sなら、400で理由を返す', async (_label, query, message) => {
      const response = await getCatalogEntryHandler(createRequest(query), mockContext);

      expect(response.status).toBe(400);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code: 'INVALID_REQUEST', message } });
    });
  });

  it.each(databaseFailureCases('図鑑の項目の取得に失敗しました'))(
    'データベースの読み取りで%s',
    async (_case, error, status, code, message) => {
      cosmosBackend.forcedQueryError = error;

      const response = await getCatalogEntryHandler(createRequest({ kind: 'plant', name: 'メロン' }), mockContext);

      expect(response.status).toBe(status);
      expect(response.jsonBody).toMatchObject({ success: false, error: { code, message } });
    }
  );

  it.each([
    [
      '継続トークンを渡していないのに Cosmos DB が 400 を返したときは、内部エラー（500）を返す',
      Object.assign(new Error('Bad Request'), { name: 'RestError', code: 400 }),
      {},
      500,
      'INTERNAL_ERROR',
      '図鑑の項目の取得に失敗しました'
    ],
    [
      '継続トークンを渡していても、接続できない障害は 400 にせず、接続できないエラー（503）を返す',
      Object.assign(new Error('getaddrinfo ENOTFOUND test.documents.azure.com'), { name: 'RestError', code: 'ENOTFOUND' }),
      { continuationToken: '{"fakePosition":1}' },
      503,
      'DATABASE_ERROR',
      'データベースに接続できません'
    ]
  ])('データベースの読み取りで%s', async (_case, error, extra, status, code, message) => {
    // 「継続トークンの形式が無効です」にするのは、トークンを渡した写真のページの 400 だけ（05 §5.14 の 6）
    cosmosBackend.forcedQueryError = error;

    const response = await getCatalogEntryHandler(createRequest({ kind: 'plant', name: 'メロン', ...extra }), mockContext);

    expect(response.status).toBe(status);
    expect(response.jsonBody).toMatchObject({ success: false, error: { code, message } });
  });
});
