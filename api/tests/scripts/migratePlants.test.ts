import { CosmosClient } from '@azure/cosmos';
import { BlobServiceClient } from '@azure/storage-blob';
import { createHash } from 'crypto';
import { migratePlants } from '../../src/scripts/migratePlants';
import { PhotoDocument } from '../../src/types/album';
import { Plant } from '../../src/types/plant';
import { FakeBlobBackend, createFakeBlobServiceClient } from '../fakes/blob';
import { FakeCosmosBackend, FakeCosmosDocument, createFakeContainer } from '../fakes/cosmos';
import { photoDocument } from '../helpers/albumDocuments';

// 植物図鑑の記録を写真へ移すスクリプト（docs/travel-album/06_processing_design.md §7 の手順 2）。
// 外部依存のみモック。Cosmos DB（植物のコンテナと写真のコンテナ）と Blob Storage（images と photos）は状態持ちの偽物
jest.mock('@azure/cosmos');
jest.mock('@azure/storage-blob', () => ({
  BlobServiceClient: { fromConnectionString: jest.fn() }
}));

const MockedCosmosClient = CosmosClient as jest.MockedClass<typeof CosmosClient>;
const MockedBlobServiceClient = BlobServiceClient as jest.MockedClass<typeof BlobServiceClient>;

const NOW = '2026-10-19T03:00:00.000Z';
const CREATED_AT = '2026-04-01T03:00:00.000Z';
const PLANTS_CONTAINER = 'test-plants';
const ALBUM_CONTAINER = 'test-album';

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

/** 植物図鑑の記録（植物ごとに画像は1枚。imagePath は images コンテナの Blob の URL） */
const plant = (id: string, overrides: Partial<Plant> = {}): Plant => ({
  id,
  name: 'ソメイヨシノ',
  scientificName: 'Prunus × yedoensis',
  familyName: 'バラ科',
  description: '日本で最も広く植えられているサクラ',
  characteristics: '淡い桃色の花を葉より先に咲かせる',
  confidence: 92,
  imagePath: `https://test.blob.core.windows.net/images/${id}.jpg`,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
  ...overrides
});

describe('植物図鑑の記録を写真へ移すスクリプト', () => {
  let plantsBackend: FakeCosmosBackend<FakeCosmosDocument>;
  let albumBackend: FakeCosmosBackend<FakeCosmosDocument>;
  let blobBackend: FakeBlobBackend;
  let log: jest.Mock;

  const photo = (id: string) => albumBackend.documents.get(id) as PhotoDocument | undefined;

  /** 植物と、その画像を images コンテナに置く */
  const putPlant = (p: Plant, image: Buffer, contentType = 'image/jpeg') => {
    plantsBackend.documents.set(p.id, p as unknown as FakeCosmosDocument);
    blobBackend.store.set(`images/${p.id}.jpg`, { content: image, contentType });
  };

  beforeEach(() => {
    jest.useFakeTimers({
      now: new Date(NOW),
      doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'setTimeout', 'setInterval']
    });
    log = jest.fn();

    plantsBackend = { documents: new Map() };
    albumBackend = { documents: new Map() };
    const containers: Record<string, unknown> = {
      [PLANTS_CONTAINER]: createFakeContainer(plantsBackend),
      [ALBUM_CONTAINER]: createFakeContainer(albumBackend)
    };
    MockedCosmosClient.mockImplementation(() => ({
      database: () => ({ container: (name: string) => containers[name] })
    }) as unknown as CosmosClient);
    blobBackend = { store: new Map(), forcedUploadError: null };
    MockedBlobServiceClient.fromConnectionString = jest.fn().mockReturnValue(createFakeBlobServiceClient(blobBackend));

    process.env.COSMOS_DB_ENDPOINT = 'https://test.documents.azure.com:443/';
    process.env.COSMOS_DB_KEY = 'test-key';
    process.env.COSMOS_DB_DATABASE = 'test-db';
    process.env.COSMOS_DB_CONTAINER = PLANTS_CONTAINER;
    process.env.COSMOS_DB_ALBUM_CONTAINER = ALBUM_CONTAINER;
    // ホストは test.blob.core.windows.net になる
    process.env.STORAGE_CONNECTION_STRING =
      'DefaultEndpointsProtocol=https;AccountName=test;AccountKey=testkey==;EndpointSuffix=core.windows.net';
    process.env.STORAGE_CONTAINER_NAME = 'images';
    process.env.PHOTO_STORAGE_CONTAINER_NAME = 'photos';
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
    delete process.env.COSMOS_DB_CONTAINER;
    delete process.env.STORAGE_CONTAINER_NAME;
  });

  it('書き込みを指定すると、植物の画像を写真の保存先に上げ、識別の済んだ旅行に属さない写真として作る', async () => {
    const image = Buffer.from('sakura-image');
    const hash = sha256(image);
    putPlant(plant('p1'), image);

    const result = await migratePlants({ apply: true, log });

    expect(result).toEqual({ found: 1, migrated: 1, skipped: [] });
    expect(blobBackend.store.get(`photos/${hash}.jpg`)).toEqual({ content: image, contentType: 'image/jpeg' });
    expect(photo(hash)).toEqual({
      id: hash,
      type: 'photo',
      tripId: null,
      blobName: `${hash}.jpg`,
      thumbnailBlobName: null,
      contentType: 'image/jpeg',
      fileSize: image.length,
      takenAt: null,
      takenAtSource: 'none',
      // 撮影日時が無いので、植物を保存した日時を日本時間に直したもの（04 §1.3）
      sortAt: '2026-04-01T12:00:00',
      location: null,
      category: 'plant',
      tags: [],
      comment: '淡い桃色の花を葉より先に咲かせる',
      commentSource: 'ai',
      hint: null,
      // 分類 AI は通していないので、分類の信頼度は無い
      classification: { kind: 'plant', confidence: null, model: 'migration', at: CREATED_AT },
      identification: {
        kind: 'plant',
        matchesKind: true,
        name: 'ソメイヨシノ',
        confidence: 92,
        description: '日本で最も広く植えられているサクラ',
        characteristics: '淡い桃色の花を葉より先に咲かせる',
        attributes: { scientificName: 'Prunus × yedoensis', familyName: 'バラ科' },
        reason: null,
        model: 'migration',
        at: CREATED_AT
      },
      processing: { state: 'done', step: 'identify', attempts: 0, lastError: null, updatedAt: CREATED_AT },
      uploadedAt: CREATED_AT,
      updatedAt: NOW,
      legacyPlantId: 'p1'
    });
  });

  it('説明・特徴・学名・科名の無い（空の）植物は、識別の値と欄とコメントを null にして移す', async () => {
    // 識別のワーカーと同じ形にする（欄は植物の定義表の項目をすべて持ち、値が無ければ null。04 §3.1）。
    // 「無い」がキーの欠けと null の2通りになると、Cosmos SQL の振る舞いが分かれる
    const image = Buffer.from('unknown-plant');
    putPlant(
      plant('p1', { description: undefined, characteristics: '', scientificName: undefined, familyName: '' }),
      image
    );

    await migratePlants({ apply: true, log });

    const migrated = photo(sha256(image))!;
    const identification = migrated.identification as Record<string, unknown>;
    expect(identification.description).toBeNull();
    expect(identification.characteristics).toBeNull();
    expect(identification.attributes).toStrictEqual({ scientificName: null, familyName: null });
    expect(migrated.comment).toBeNull();
    expect(migrated.commentSource).toBeNull();
  });

  it('画像の Content-Type の大文字小文字は問わず、小文字にそろえて移す', async () => {
    // 植物図鑑は送られた Content-Type をそのまま Blob に付けていた（検証は大文字小文字を問わない）
    const image = Buffer.from('upper-case-type');
    putPlant(plant('p1'), image, 'image/JPEG');

    const result = await migratePlants({ apply: true, log });

    expect(result.migrated).toBe(1);
    expect(photo(sha256(image))!.contentType).toBe('image/jpeg');
    expect(blobBackend.store.get(`photos/${sha256(image)}.jpg`)?.contentType).toBe('image/jpeg');
  });

  it('書き込みを指定しないと、移す植物と飛ばす植物を数えるだけで、何も書かない', async () => {
    putPlant(plant('p1'), Buffer.from('sakura-image'));
    plantsBackend.documents.set('p2', plant('p2') as unknown as FakeCosmosDocument);

    const result = await migratePlants({ apply: false, log });

    expect(result).toEqual({
      found: 2,
      migrated: 0,
      skipped: [{ plantId: 'p2', name: 'ソメイヨシノ', reason: '画像が見つからない' }]
    });
    expect(albumBackend.documents.size).toBe(0);
    expect([...blobBackend.store.keys()]).toEqual(['images/p1.jpg']);
  });

  it('画像の Blob が無い植物は飛ばして一覧に出し、ほかの植物は移す', async () => {
    // 画像の無い植物を先に保存していた（飛ばした後も、続く植物を移す）
    const image = Buffer.from('sakura-image');
    plantsBackend.documents.set(
      'p1',
      plant('p1', { name: 'ウメ', createdAt: '2026-03-01T03:00:00.000Z' }) as unknown as FakeCosmosDocument
    );
    putPlant(plant('p2'), image);

    const result = await migratePlants({ apply: true, log });

    expect(result).toEqual({
      found: 2,
      migrated: 1,
      skipped: [{ plantId: 'p1', name: 'ウメ', reason: '画像が見つからない' }]
    });
    expect(photo(sha256(image))?.legacyPlantId).toBe('p2');
  });

  // 植物図鑑の API は保存のときに imagePath を検証しているが、移す前にもう一度確かめる（別のホスト・別のコンテナの Blob を読まない）。
  // 行ごとに条件を1つだけ外す。p1 の画像は images コンテナに置いてあるので、条件が緩むと読んで移してしまう
  it.each([
    ['別のホストの URL', 'https://evil.example.com/images/p1.jpg'],
    ['別のコンテナの URL', 'https://test.blob.core.windows.net/photos/p1.jpg'],
    ['https でない URL', 'http://test.blob.core.windows.net/images/p1.jpg'],
    ['コンテナの下の階層を指す URL', 'https://test.blob.core.windows.net/images/sub/p1.jpg'],
    ['Blob の名前が無い URL', 'https://test.blob.core.windows.net/images/'],
    ['URL として読めない文字列', 'images/p1.jpg']
  ])('画像の URL が images コンテナの Blob を指していない植物（%s）は飛ばして一覧に出し、ほかの植物は移す', async (_, imagePath) => {
    const image = Buffer.from('sakura-image');
    putPlant(plant('p1', { imagePath, createdAt: '2026-03-01T03:00:00.000Z' }), Buffer.from('other-image'));
    putPlant(plant('p2'), image);

    const result = await migratePlants({ apply: true, log });

    expect(result).toEqual({
      found: 2,
      migrated: 1,
      skipped: [{ plantId: 'p1', name: 'ソメイヨシノ', reason: '画像の URL が images コンテナの Blob ではない' }]
    });
    expect(albumBackend.documents.size).toBe(1);
    expect(photo(sha256(image))?.legacyPlantId).toBe('p2');
  });

  it('画像の形式が写真として受け付けないもの（HEIC など）の植物は飛ばして一覧に出す', async () => {
    putPlant(plant('p1'), Buffer.from('heic-image'), 'image/heic');

    const result = await migratePlants({ apply: true, log });

    expect(result.skipped).toEqual([
      { plantId: 'p1', name: 'ソメイヨシノ', reason: '画像の形式（image/heic）が写真として受け付けないもの' }
    ]);
    expect(albumBackend.documents.size).toBe(0);
  });

  it('PNG の画像は、拡張子を .png にして写真の保存先に上げる', async () => {
    const image = Buffer.from('png-image');
    const hash = sha256(image);
    putPlant(plant('p1'), image, 'image/png');

    await migratePlants({ apply: true, log });

    expect(blobBackend.store.get(`photos/${hash}.png`)).toEqual({ content: image, contentType: 'image/png' });
    expect(photo(hash)).toMatchObject({ blobName: `${hash}.png`, contentType: 'image/png' });
  });

  it('同じ画像の写真が先にあれば飛ばして一覧に出し、先の写真を変えない', async () => {
    // 旅行アルバムに同じ写真を送っていた（写真の id は画像の SHA-256 なので同じになる）
    const image = Buffer.from('sakura-image');
    const hash = sha256(image);
    const existing = photoDocument(hash, { tripId: '123e4567-e89b-42d3-a456-426614174000', category: 'plant' });
    albumBackend.documents.set(hash, existing as unknown as FakeCosmosDocument);
    putPlant(plant('p1'), image);

    const result = await migratePlants({ apply: true, log });

    expect(result).toEqual({
      found: 1,
      migrated: 0,
      skipped: [{ plantId: 'p1', name: 'ソメイヨシノ', reason: `同じ写真が先にある（写真 ID=${hash}）` }]
    });
    expect(photo(hash)).toEqual(existing);
  });

  it('もう一度回すと、移した植物はどれも先にあるとして飛ばし、写真を変えない', async () => {
    // 途中で止まったときに、続きから回し直せる（冪等）
    const image = Buffer.from('sakura-image');
    const hash = sha256(image);
    putPlant(plant('p1'), image);
    await migratePlants({ apply: true, log });
    const migrated = photo(hash);

    const result = await migratePlants({ apply: true, log });

    expect(result.migrated).toBe(0);
    expect(result.skipped).toEqual([
      { plantId: 'p1', name: 'ソメイヨシノ', reason: `同じ写真が先にある（写真 ID=${hash}）` }
    ]);
    expect(photo(hash)).toEqual(migrated);
  });

  it('画像の保存に失敗したら止め、それまでに移した植物はそのまま残す', async () => {
    // Blob → 写真の文書の順に書くので、文書の無い Blob だけが残る（もう一度回すと上書きされる）
    const first = Buffer.from('first-image');
    putPlant(plant('p1', { createdAt: '2026-04-01T03:00:00.000Z' }), first);
    putPlant(plant('p2', { createdAt: '2026-04-02T03:00:00.000Z' }), Buffer.from('second-image'));
    blobBackend.forcedUploadErrorByKey = { [`photos/${sha256(Buffer.from('second-image'))}.jpg`]: new Error('upload failed') };

    await expect(migratePlants({ apply: true, log })).rejects.toThrow('upload failed');

    expect(photo(sha256(first))?.legacyPlantId).toBe('p1');
    expect(albumBackend.documents.size).toBe(1);
  });

  it('設定が足りなければ、足りない設定の名前をすべて言って、何も書かずに止める', async () => {
    // 空白だけの値も、無いものとして扱う
    putPlant(plant('p1'), Buffer.from('sakura-image'));
    delete process.env.COSMOS_DB_CONTAINER;
    process.env.STORAGE_CONTAINER_NAME = '  ';

    await expect(migratePlants({ apply: true, log })).rejects.toThrow(
      new Error('設定が足りません: COSMOS_DB_CONTAINER, STORAGE_CONTAINER_NAME')
    );

    expect(albumBackend.documents.size).toBe(0);
    expect([...blobBackend.store.keys()]).toEqual(['images/p1.jpg']);
  });

  it('画像の読み込みが「見つからない」以外の理由で失敗したら、飛ばさずに止める', async () => {
    // 権限やネットワークの失敗で飛ばすと、画像がある植物を「画像が見つからない」として一覧に出してしまう
    const failure = Object.assign(new Error('This request is not authorized to perform this operation.'), {
      name: 'RestError',
      statusCode: 403,
      code: 'AuthorizationFailure'
    });
    const first = Buffer.from('first-image');
    putPlant(plant('p1', { createdAt: '2026-04-01T03:00:00.000Z' }), first);
    putPlant(plant('p2', { createdAt: '2026-04-02T03:00:00.000Z' }), Buffer.from('second-image'));
    blobBackend.store.get('images/p2.jpg')!.failWith = failure;

    await expect(migratePlants({ apply: true, log })).rejects.toBe(failure);

    expect(photo(sha256(first))?.legacyPlantId).toBe('p1');
    expect(albumBackend.documents.size).toBe(1);
  });
});
