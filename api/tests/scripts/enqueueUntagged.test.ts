import { CosmosClient } from '@azure/cosmos';
import { enqueueUntaggedFoodPhotos } from '../../src/scripts/enqueueUntagged';
import { PhotoDocument, PhotoProcessing } from '../../src/types/album';
import { FakeCosmosBackend, FakeCosmosDocument, createFakeContainer } from '../fakes/cosmos';
import { forEachCase } from '../helpers/cases';
import { photoDocument, tripDocument } from '../helpers/albumDocuments';

// 外部依存のみモック。Cosmos DB は状態持ちの偽物。スクリプトはキューに積まない（積むのは再投入のタイマー。06 §9）
jest.mock('@azure/cosmos');

const MockedCosmosClient = CosmosClient as jest.MockedClass<typeof CosmosClient>;

const NOW = '2026-11-02T03:00:00.000Z';
const CLASSIFIED_AT = '2026-10-17T01:00:00.000Z';
const TRIP_ID = '123e4567-e89b-42d3-a456-426614174000';

// 写真の id（SHA-256 の16進）。取り違えを見分けられるよう、先頭の文字だけ変える
const photoId = (head: string): string => head.repeat(64);

/** C-4 より前に分類まで済んだ食べ物の写真（タグはまだ無い） */
const foodPhoto = (id: string, overrides: Partial<PhotoDocument> = {}): PhotoDocument =>
  photoDocument(id, {
    category: 'food',
    classification: { kind: 'food', confidence: 88, model: 'gpt-6-luna', at: CLASSIFIED_AT },
    tags: [],
    processing: { state: 'done', step: 'classify', attempts: 1, lastError: null, updatedAt: CLASSIFIED_AT },
    ...overrides
  });

/** タグの提案の待ち（スクリプトが書く形。積むのは再投入のタイマー） */
const waitingForTags: PhotoProcessing = { state: 'pending', step: 'tag', attempts: 0, lastError: null, updatedAt: NOW };

describe('既にある食べ物の写真をタグの提案に回すスクリプト（C-4。06 §9）', () => {
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

  it('書き込みを指定すると、解析が済んでタグの無い食べ物の写真を、タグの提案の待ちにする（ほかの欄は変えない）', async () => {
    cosmosBackend.documents.set(photoId('a'), foodPhoto(photoId('a'), { comment: '朝ごはん', tripId: null }));
    // 項目の無い文書もタグ無しとして扱う（04 §2）
    const { tags: _tags, ...withoutTags } = foodPhoto(photoId('b'));
    cosmosBackend.documents.set(photoId('b'), withoutTags as PhotoDocument);
    // 同じコンテナには旅行も入っている（写真だけを読む）
    cosmosBackend.documents.set(TRIP_ID, tripDocument(TRIP_ID, '京都'));

    const result = await enqueueUntaggedFoodPhotos({ apply: true, log });

    expect(result).toEqual({ found: 2, marked: 2 });
    expect(stored(photoId('a'))).toEqual({ ...foodPhoto(photoId('a'), { comment: '朝ごはん', tripId: null }), processing: waitingForTags });
    expect(stored(photoId('b')).processing).toEqual(waitingForTags);
  });

  it('写真が対象でない（タグがある・食べ物でない・解析が済んでいない）なら、書き込みを指定しても変えない', () => forEachCase([
    ['タグがある', { tags: [{ name: '夕食', kind: 'food', x: 0.5, y: 0.5, source: 'user' }] }],
    ['植物', { category: 'plant' }],
    ['風景', { category: 'landscape' }],
    ['分類の待ち', { processing: { state: 'pending', step: 'classify', attempts: 0, lastError: null, updatedAt: CLASSIFIED_AT } }],
    ['上限まで失敗した（failed）', { processing: { state: 'failed', step: 'tag', attempts: 3, lastError: 'ai', updatedAt: CLASSIFIED_AT } }],
    ['解析の対象になっていない（段階2の none）', { category: null, processing: { state: 'none', step: null, attempts: 0, lastError: null, updatedAt: null } }]
  ] as const, async (_label, overrides) => {
    // 対象の絞り込みはクエリでも行うが、クエリの WHERE はテストで確かめられないので、同じ条件をコードでも見る
    const photo = foodPhoto(photoId('a'), overrides as Partial<PhotoDocument>);
    cosmosBackend.documents.set(photoId('a'), photo);

    const result = await enqueueUntaggedFoodPhotos({ apply: true, log });

    expect(result).toEqual({ found: 0, marked: 0 });
    expect(stored(photoId('a'))).toEqual(photo);
  }));

  it('書き込みを指定しなければ、対象の写真を数えるだけで何も変えない', async () => {
    // 本番のデータを書き、AI の費用もかかるので、先に件数を見てから回す（06 §9）
    cosmosBackend.documents.set(photoId('a'), foodPhoto(photoId('a')));

    const result = await enqueueUntaggedFoodPhotos({ apply: false, log });

    expect(result).toEqual({ found: 1, marked: 0 });
    expect(stored(photoId('a'))).toEqual(foodPhoto(photoId('a')));
  });

  it('読んだ後に解析の進み具合が変わった写真（やり直しの受付が入った）は書かず、ほかの写真は書く', async () => {
    cosmosBackend.documents.set(photoId('a'), foodPhoto(photoId('a')));
    cosmosBackend.documents.set(photoId('b'), foodPhoto(photoId('b')));
    const redoRequested = foodPhoto(photoId('a'), {
      processing: { state: 'pending', step: 'classify', attempts: 0, lastError: null, updatedAt: '2026-11-02T02:59:00.000Z' }
    });
    cosmosBackend.beforePatch = (id) => {
      if (id === photoId('a')) {
        cosmosBackend.documents.set(photoId('a'), redoRequested);
      }
    };

    const result = await enqueueUntaggedFoodPhotos({ apply: true, log });

    expect(result).toEqual({ found: 2, marked: 1 });
    expect(stored(photoId('a'))).toEqual(redoRequested);
    expect(stored(photoId('b')).processing).toEqual(waitingForTags);
  });
});
