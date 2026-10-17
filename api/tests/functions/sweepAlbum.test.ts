import { InvocationContext, Timer } from '@azure/functions';
import { CosmosClient } from '@azure/cosmos';
import { BlobServiceClient } from '@azure/storage-blob';
import { sweepAlbumHandler } from '../../src/functions/sweepAlbum';
import { PhotoDocument } from '../../src/types/album';
import { FakeCosmosBackend, FakeCosmosDocument, createFakeContainer } from '../fakes/cosmos';
import { BlobEntry, FakeBlobBackend, createFakeBlobServiceClient } from '../fakes/blob';
import { photoDocument, tripDocument } from '../helpers/albumDocuments';

// 外部依存のみモック。Cosmos DB と Blob Storage は状態持ちの偽物
jest.mock('@azure/cosmos');
jest.mock('@azure/storage-blob', () => ({
  ...jest.requireActual('@azure/storage-blob'),
  BlobServiceClient: { fromConnectionString: jest.fn() }
}));

const MockedCosmosClient = CosmosClient as jest.MockedClass<typeof CosmosClient>;
const MockedBlobServiceClient = BlobServiceClient as jest.MockedClass<typeof BlobServiceClient>;

const NOW = '2026-10-18T18:00:00.000Z';
// 1日より古い時刻と、まだ1日たっていない時刻（送信の途中かもしれない。04 §7.2）
const OLD = new Date('2026-10-17T17:59:59.000Z');
const RECENT = new Date('2026-10-17T18:00:01.000Z');
// ちょうど1日前（「1日より古い」に入らないので残す）
const EXACTLY_ONE_DAY = new Date('2026-10-17T18:00:00.000Z');

const TRIP_ID = '123e4567-e89b-42d3-a456-426614174000';
const DELETED_TRIP_ID = '223e4567-e89b-42d3-a456-426614174000';
// 写真の id（SHA-256 の16進）。先頭の文字だけ変える
const photoId = (head: string): string => head.repeat(64);

const timer = { isPastDue: false } as unknown as Timer;
const blob = (lastModified: Date): BlobEntry => ({ content: Buffer.from([0xff, 0xd8]), contentType: 'image/jpeg', lastModified });

describe('掃除のタイマー', () => {
  let mockContext: InvocationContext;
  let cosmosBackend: FakeCosmosBackend<FakeCosmosDocument>;
  let blobBackend: FakeBlobBackend;

  const stored = (id: string) => cosmosBackend.documents.get(id) as PhotoDocument;

  beforeEach(() => {
    jest.useFakeTimers({
      now: new Date(NOW),
      doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'setTimeout', 'setInterval']
    });
    mockContext = { log: jest.fn() } as any;

    cosmosBackend = { documents: new Map() };
    const fakeContainer = createFakeContainer(cosmosBackend);
    MockedCosmosClient.mockImplementation(() => ({
      database: () => ({ container: () => fakeContainer })
    }) as unknown as CosmosClient);

    blobBackend = { store: new Map() };
    MockedBlobServiceClient.fromConnectionString = jest.fn().mockReturnValue(createFakeBlobServiceClient(blobBackend));

    process.env.COSMOS_DB_ENDPOINT = 'https://test.documents.azure.com:443/';
    process.env.COSMOS_DB_KEY = 'test-key';
    process.env.COSMOS_DB_DATABASE = 'test-db';
    process.env.COSMOS_DB_ALBUM_CONTAINER = 'test-album';
    process.env.STORAGE_CONNECTION_STRING =
      'DefaultEndpointsProtocol=https;AccountName=test;AccountKey=testkey==;EndpointSuffix=core.windows.net';
    process.env.PHOTO_STORAGE_CONTAINER_NAME = 'photos';
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('写真の文書が無いBlobのうち、1日より古いものだけを消し、新しいものと文書のあるBlobは残す', async () => {
    // 写真 a は文書があり、原寸とサムネイルの Blob がある（どれだけ古くても残す）。
    // b は送信の途中で止まった（文書が無い）古い原寸とサムネイル、c は送信の途中かもしれない新しい原寸
    cosmosBackend.documents.set(photoId('a'), photoDocument(photoId('a'), { blobName: `${photoId('a')}.jpg` }));
    blobBackend.store.set(`photos/${photoId('a')}.jpg`, blob(OLD));
    blobBackend.store.set(`photos/${photoId('a')}.thumb.jpg`, blob(OLD));
    blobBackend.store.set(`photos/${photoId('b')}.png`, blob(OLD));
    blobBackend.store.set(`photos/${photoId('b')}.thumb.jpg`, blob(OLD));
    blobBackend.store.set(`photos/${photoId('c')}.jpg`, blob(RECENT));
    blobBackend.store.set(`photos/${photoId('e')}.jpg`, blob(EXACTLY_ONE_DAY));
    // 別のコンテナの Blob には触らない
    blobBackend.store.set(`images/${photoId('d')}.jpg`, blob(OLD));

    await sweepAlbumHandler(timer, mockContext);

    expect([...blobBackend.store.keys()].sort()).toEqual(
      [
        `photos/${photoId('a')}.jpg`,
        `photos/${photoId('a')}.thumb.jpg`,
        `photos/${photoId('c')}.jpg`,
        `photos/${photoId('e')}.jpg`,
        `images/${photoId('d')}.jpg`
      ].sort()
    );
  });

  it('写真の名前の形（写真IDで始まる）でないBlobは、古くても消さない', async () => {
    // photos コンテナに置くのはこのアプリだけだが、名前から写真を決められないものは消さない
    blobBackend.store.set('photos/readme.txt', blob(OLD));
    blobBackend.store.set(`photos/${photoId('A')}.jpg`, blob(OLD));
    // 写真 ID（64 文字）の後が拡張子の区切りでない
    blobBackend.store.set(`photos/${'f'.repeat(65)}.jpg`, blob(OLD));

    await sweepAlbumHandler(timer, mockContext);

    expect([...blobBackend.store.keys()].sort()).toEqual(
      ['photos/readme.txt', `photos/${photoId('A')}.jpg`, `photos/${'f'.repeat(65)}.jpg`].sort()
    );
  });

  it('消えた旅行を指す写真を、どの旅行にも属さない写真に戻し（消さない）、ある旅行の写真はそのままにする', async () => {
    // 旅行の削除と送信・移動が重なって残った写真（04 §7.3）
    cosmosBackend.documents.set(TRIP_ID, tripDocument(TRIP_ID, '北海道'));
    const inTrip = photoDocument(photoId('a'), { tripId: TRIP_ID });
    const orphaned = photoDocument(photoId('b'), { tripId: DELETED_TRIP_ID, updatedAt: '2026-10-01T00:00:00.000Z' });
    const unassigned = photoDocument(photoId('c'), { tripId: null });
    cosmosBackend.documents.set(photoId('a'), inTrip);
    cosmosBackend.documents.set(photoId('b'), orphaned);
    cosmosBackend.documents.set(photoId('c'), unassigned);

    await sweepAlbumHandler(timer, mockContext);

    expect(stored(photoId('a'))).toEqual(inTrip);
    expect(stored(photoId('b'))).toEqual({ ...orphaned, tripId: null, updatedAt: NOW });
    expect(stored(photoId('c'))).toEqual(unassigned);
  });

  it('読んだ後に利用者が写真を別の旅行へ移していたら、未所属に戻さない', async () => {
    // 読んだときは消えた旅行を指していたが、未所属に戻す前に利用者が移した
    cosmosBackend.documents.set(TRIP_ID, tripDocument(TRIP_ID, '北海道'));
    cosmosBackend.documents.set(photoId('a'), photoDocument(photoId('a'), { tripId: DELETED_TRIP_ID }));
    const moved = photoDocument(photoId('a'), { tripId: TRIP_ID, updatedAt: NOW });
    cosmosBackend.beforePatch = () => {
      cosmosBackend.beforePatch = undefined;
      cosmosBackend.documents.set(photoId('a'), moved);
    };

    await sweepAlbumHandler(timer, mockContext);

    expect(stored(photoId('a'))).toEqual(moved);
  });

  it('原寸のBlobが無い写真の文書は、消さずに残す（手で直す）', async () => {
    // 写真の削除と送信が重なったときに残りうる（04 §7.1）。タイマーはログに出すだけ
    const photo = photoDocument(photoId('a'), { blobName: `${photoId('a')}.jpg` });
    cosmosBackend.documents.set(photoId('a'), photo);

    await sweepAlbumHandler(timer, mockContext);

    expect(stored(photoId('a'))).toEqual(photo);
  });

  it('写真の文書を読めなければ、Blobを消さずに例外を投げる（文書の無いBlobと取り違えない）', async () => {
    cosmosBackend.documents.set(photoId('a'), photoDocument(photoId('a'), { blobName: `${photoId('a')}.jpg` }));
    blobBackend.store.set(`photos/${photoId('a')}.jpg`, blob(OLD));
    cosmosBackend.forcedQueryError = Object.assign(new Error('Service Unavailable'), { code: 503 });

    await expect(sweepAlbumHandler(timer, mockContext)).rejects.toThrow();

    expect([...blobBackend.store.keys()]).toEqual([`photos/${photoId('a')}.jpg`]);
  });
});
