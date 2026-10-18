import { CosmosClient } from '@azure/cosmos';
import { enqueueUnidentifiedPhotos } from '../../src/scripts/enqueueUnidentified';
import { PhotoDocument, PhotoProcessing } from '../../src/types/album';
import { FakeCosmosBackend, FakeCosmosDocument, createFakeContainer } from '../fakes/cosmos';
import { photoDocument, tripDocument } from '../helpers/albumDocuments';

// 外部依存のみモック。Cosmos DB は状態持ちの偽物。スクリプトはキューに積まない（積むのは再投入のタイマー。06 §1）
jest.mock('@azure/cosmos');

const MockedCosmosClient = CosmosClient as jest.MockedClass<typeof CosmosClient>;

const NOW = '2026-10-18T03:00:00.000Z';
const CLASSIFIED_AT = '2026-10-17T01:00:00.000Z';
const TRIP_ID = '123e4567-e89b-42d3-a456-426614174000';

// 写真の id（SHA-256 の16進）。取り違えを見分けられるよう、先頭の文字だけ変える
const photoId = (head: string): string => head.repeat(64);

/** 段階3で分類まで済んだ写真（識別の対象の種類で、識別はまだ無い） */
const classifiedPhoto = (id: string, overrides: Partial<PhotoDocument> = {}): PhotoDocument =>
  photoDocument(id, {
    category: 'plant',
    classification: { kind: 'plant', confidence: 88, model: 'gpt-6-luna', at: CLASSIFIED_AT },
    identification: null,
    processing: { state: 'done', step: 'classify', attempts: 1, lastError: null, updatedAt: CLASSIFIED_AT },
    ...overrides
  });

/** 識別の待ち（スクリプトが書く形。積むのは再投入のタイマー） */
const waitingForIdentify: PhotoProcessing = { state: 'pending', step: 'identify', attempts: 0, lastError: null, updatedAt: NOW };

describe('分類まで済んだ写真を識別に回すスクリプト', () => {
  let cosmosBackend: FakeCosmosBackend<FakeCosmosDocument>;
  let log: jest.Mock;

  const stored = (id: string) => cosmosBackend.documents.get(id) as PhotoDocument;

  beforeEach(() => {
    jest.useFakeTimers({
      now: new Date(NOW),
      doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'setTimeout', 'setInterval']
    });
    log = jest.fn();

    cosmosBackend = { documents: new Map() };
    const fakeContainer = createFakeContainer(cosmosBackend);
    MockedCosmosClient.mockImplementation(() => ({
      database: () => ({ container: () => fakeContainer })
    }) as unknown as CosmosClient);

    process.env.COSMOS_DB_ENDPOINT = 'https://test.documents.azure.com:443/';
    process.env.COSMOS_DB_KEY = 'test-key';
    process.env.COSMOS_DB_DATABASE = 'test-db';
    process.env.COSMOS_DB_ALBUM_CONTAINER = 'test-album';
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('書き込みを指定すると、分類まで済んで識別の無い図鑑の種類の写真を、識別の待ちにする', async () => {
    // 植物・食べ物・風景のどれも対象。分類の結果・カテゴリ・利用者の欄は変えない
    cosmosBackend.documents.set(photoId('a'), classifiedPhoto(photoId('a'), { tags: ['公園'], tripId: null }));
    cosmosBackend.documents.set(photoId('b'), classifiedPhoto(photoId('b'), { category: 'food' }));
    cosmosBackend.documents.set(photoId('c'), classifiedPhoto(photoId('c'), { category: 'landscape' }));
    // 同じコンテナには旅行も入っている（写真だけを読む）
    cosmosBackend.documents.set(TRIP_ID, tripDocument(TRIP_ID, '京都'));

    const result = await enqueueUnidentifiedPhotos({ apply: true, log });

    expect(result).toEqual({ found: 3, marked: 3 });
    expect(stored(photoId('a'))).toEqual({
      ...classifiedPhoto(photoId('a'), { tags: ['公園'], tripId: null }),
      processing: waitingForIdentify
    });
    expect(stored(photoId('b')).processing).toEqual(waitingForIdentify);
    expect(stored(photoId('c')).processing).toEqual(waitingForIdentify);
  });

  it.each([
    ['どの種類にも当てはまらない（other）', { category: 'other' }],
    ['識別が済んでいる', { identification: { kind: 'plant', matchesKind: true, name: 'ソメイヨシノ' } }],
    ['分類の待ち', { processing: { state: 'pending', step: 'classify', attempts: 0, lastError: null, updatedAt: CLASSIFIED_AT } }],
    ['識別中', { processing: { state: 'identifying', step: 'identify', attempts: 1, lastError: null, updatedAt: CLASSIFIED_AT } }],
    ['上限まで失敗した（failed）', { processing: { state: 'failed', step: 'classify', attempts: 3, lastError: 'ai', updatedAt: CLASSIFIED_AT } }],
    ['解析の対象になっていない（段階2の none）', { category: null, processing: { state: 'none', step: null, attempts: 0, lastError: null, updatedAt: null } }]
  ] as const)('写真が%sなら、書き込みを指定しても変えない', async (_label, overrides) => {
    // 対象の絞り込みはクエリでも行うが、クエリの WHERE はテストで確かめられないので、同じ条件をコードでも見る
    const photo = classifiedPhoto(photoId('a'), overrides as Partial<PhotoDocument>);
    cosmosBackend.documents.set(photoId('a'), photo);

    const result = await enqueueUnidentifiedPhotos({ apply: true, log });

    expect(result).toEqual({ found: 0, marked: 0 });
    expect(stored(photoId('a'))).toEqual(photo);
  });

  it('書き込みを指定しなければ、対象の写真を数えるだけで何も変えない', async () => {
    // 本番のデータを書くので、先に件数を見てから回す（06 §1）
    cosmosBackend.documents.set(photoId('a'), classifiedPhoto(photoId('a')));
    cosmosBackend.documents.set(photoId('b'), classifiedPhoto(photoId('b'), { category: 'food' }));

    const result = await enqueueUnidentifiedPhotos({ apply: false, log });

    expect(result).toEqual({ found: 2, marked: 0 });
    expect(stored(photoId('a'))).toEqual(classifiedPhoto(photoId('a')));
    expect(stored(photoId('b'))).toEqual(classifiedPhoto(photoId('b'), { category: 'food' }));
  });

  it('読んだ後に解析の進み具合が変わった写真（やり直しの受付が入った）は書かず、ほかの写真は書く', async () => {
    // 読んだときの processing の条件付きの patch（04 §7.4）。受付の書いた分類の待ちを、識別の待ちで上書きしない
    cosmosBackend.documents.set(photoId('a'), classifiedPhoto(photoId('a')));
    cosmosBackend.documents.set(photoId('b'), classifiedPhoto(photoId('b')));
    const redoRequested = classifiedPhoto(photoId('a'), {
      hint: '梅かもしれない',
      processing: { state: 'pending', step: 'classify', attempts: 0, lastError: null, updatedAt: '2026-10-18T02:59:00.000Z' }
    });
    cosmosBackend.beforePatch = (id) => {
      if (id === photoId('a')) {
        cosmosBackend.documents.set(photoId('a'), redoRequested);
      }
    };

    const result = await enqueueUnidentifiedPhotos({ apply: true, log });

    expect(result).toEqual({ found: 2, marked: 1 });
    expect(stored(photoId('a'))).toEqual(redoRequested);
    expect(stored(photoId('b')).processing).toEqual(waitingForIdentify);
  });

  it.each(['COSMOS_DB_ENDPOINT', 'COSMOS_DB_KEY', 'COSMOS_DB_DATABASE', 'COSMOS_DB_ALBUM_CONTAINER'])(
    'Cosmos の設定（%s）が無ければ、どの設定が無いかを言って止まる',
    async (name) => {
      // 手元に local.settings.json が無いと、どれも無いまま回る。SDK の TypeError（Invalid URL）では何が足りないか分からない
      delete process.env[name];

      await expect(enqueueUnidentifiedPhotos({ apply: false, log })).rejects.toThrow(name);
    }
  );

  it('Cosmos の設定が空白だけでも、無いのと同じに止まる', async () => {
    // local.settings.json の値を空のまま残したとき
    process.env.COSMOS_DB_DATABASE = '  ';

    await expect(enqueueUnidentifiedPhotos({ apply: false, log })).rejects.toThrow('COSMOS_DB_DATABASE');
  });

  it('読んだ後に消された写真は飛ばして、ほかの写真は書く', async () => {
    // 消された写真への patch は 404。止めずに次の写真へ進む（04 §7.1）
    cosmosBackend.documents.set(photoId('a'), classifiedPhoto(photoId('a')));
    cosmosBackend.documents.set(photoId('b'), classifiedPhoto(photoId('b')));
    cosmosBackend.beforePatch = (id) => {
      if (id === photoId('a')) {
        cosmosBackend.documents.delete(photoId('a'));
      }
    };

    const result = await enqueueUnidentifiedPhotos({ apply: true, log });

    expect(result).toEqual({ found: 2, marked: 1 });
    expect(cosmosBackend.documents.has(photoId('a'))).toBe(false);
    expect(stored(photoId('b')).processing).toEqual(waitingForIdentify);
  });
});
