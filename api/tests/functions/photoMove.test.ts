import { HttpRequest, InvocationContext } from '@azure/functions';
import { CosmosClient } from '@azure/cosmos';
import { movePhotosHandler } from '../../src/functions/photoMove';
import { PhotoDocument } from '../../src/types/album';
import { FakeCosmosBackend, FakeCosmosDocument, createFakeContainer } from '../fakes/cosmos';
import { photoDocument, tripDocument } from '../helpers/albumDocuments';
import { databaseFailureCases } from '../helpers/databaseFailures';

// 外部依存のみモック。写真の移動はドキュメントの更新だけで、Blob Storage には触れない
jest.mock('@azure/cosmos');
const MockedCosmosClient = CosmosClient as jest.MockedClass<typeof CosmosClient>;

// 移し先の旅行の id（UUID v4 の形）
const TRIP_A_ID = '123e4567-e89b-42d3-a456-426614174000';

// 写真の id（小文字16進 64 文字）。移動では画像のバイト列は使わないので、写真を見分けられる値にしている
const PHOTO_1_ID = '1'.repeat(64);
const PHOTO_2_ID = '2'.repeat(64);
const OTHER_PHOTO_ID = '3'.repeat(64);

// 形式は正しいが、保存されていない写真の id
const MISSING_PHOTO_ID = '4'.repeat(64);

// 移動した時刻。写真に保存してある updatedAt（2026-09-22）とは別の日にして、書き換わったことを見分ける
const MOVED_AT = '2026-10-12T05:30:00.000Z';

// 時刻だけを固定する。他のタイマーまで偽物にすると非同期処理が止まりうる
const freezeNow = () =>
  jest.useFakeTimers({
    now: new Date(MOVED_AT),
    doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'setTimeout', 'setInterval']
  });

const createMoveRequestWithJson = (json: jest.Mock): HttpRequest =>
  ({
    method: 'POST',
    url: 'https://func-snaplant.azurewebsites.net/api/photos/move?code=test-key',
    query: new Map([['code', 'test-key']]),
    headers: new Map([['content-type', 'application/json']]),
    json
  }) as any as HttpRequest;

const createMoveRequest = (body: unknown): HttpRequest =>
  createMoveRequestWithJson(jest.fn().mockResolvedValue(body));

// 写真の id として形式が正しい、互いに違う id を count 個
const manyPhotoIds = (count: number): string[] =>
  Array.from({ length: count }, (_, i) => i.toString(16).padStart(64, '0'));

/**
 * 項目に値の入った保存済みの写真（tripId は引数。旅行に属さないときは null）。移動で変わるのは tripId と
 * updatedAt だけであることを、comment・category・processing など他の項目が元のままかで見分けるため、
 * 項目ごとに違う値を入れる
 */
const savedPhoto = (id: string, tripId: string | null): PhotoDocument =>
  photoDocument(id, {
    tripId,
    takenAt: '2026-10-05T12:30:15',
    takenAtSource: 'exif',
    sortAt: '2026-10-05T12:30:15',
    location: { latitude: 43.7706, longitude: 142.365, placeName: '北海道旭川市', placeSource: 'device' },
    category: 'food',
    tags: ['朝食', '旅館'],
    comment: `ホテルの朝食 ${id.slice(0, 1)}`,
    commentSource: 'user',
    hint: 'ビュッフェ',
    processing: { state: 'done', step: null, attempts: 1, lastError: null, updatedAt: '2026-09-21T01:05:00.000Z' },
    uploadedAt: '2026-09-21T01:00:00.000Z',
    updatedAt: '2026-09-22T02:30:00.000Z'
  });

describe('写真移動API', () => {
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

    process.env.COSMOS_DB_ENDPOINT = 'https://test.documents.azure.com:443/';
    process.env.COSMOS_DB_KEY = 'test-key';
    process.env.COSMOS_DB_DATABASE = 'test-db';
    process.env.COSMOS_DB_ALBUM_CONTAINER = 'test-album';
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
    delete process.env.COSMOS_DB_ENDPOINT;
    delete process.env.COSMOS_DB_KEY;
    delete process.env.COSMOS_DB_DATABASE;
    delete process.env.COSMOS_DB_ALBUM_CONTAINER;
  });

  it('写真をまとめて旅行に入れると、その写真の旅行が変わり、他の項目は変わらない', async () => {
    freezeNow();
    // 旅行 A と、どの旅行にも属さない写真2枚（移す）、移さない別の写真1枚
    const photo1 = savedPhoto(PHOTO_1_ID, null);
    const photo2 = savedPhoto(PHOTO_2_ID, null);
    const otherPhoto = savedPhoto(OTHER_PHOTO_ID, null);
    cosmosBackend.documents.set(TRIP_A_ID, tripDocument(TRIP_A_ID, '京都'));
    cosmosBackend.documents.set(PHOTO_1_ID, photo1);
    cosmosBackend.documents.set(PHOTO_2_ID, photo2);
    cosmosBackend.documents.set(OTHER_PHOTO_ID, otherPhoto);
    const request = createMoveRequest({ photoIds: [PHOTO_1_ID, PHOTO_2_ID], tripId: TRIP_A_ID });

    const response = await movePhotosHandler(request, mockContext);

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({
      success: true,
      data: { moved: [PHOTO_1_ID, PHOTO_2_ID], notFound: [] }
    });
    // 移した2枚は tripId と updatedAt だけが変わり、comment・category・processing などは元のまま。
    // 移さなかった写真と旅行のドキュメントは変わらない
    expect(cosmosBackend.documents.get(PHOTO_1_ID)).toEqual({ ...photo1, tripId: TRIP_A_ID, updatedAt: MOVED_AT });
    expect(cosmosBackend.documents.get(PHOTO_2_ID)).toEqual({ ...photo2, tripId: TRIP_A_ID, updatedAt: MOVED_AT });
    expect(cosmosBackend.documents.get(OTHER_PHOTO_ID)).toEqual(otherPhoto);
    expect(cosmosBackend.documents.get(TRIP_A_ID)).toEqual(tripDocument(TRIP_A_ID, '京都'));
  });

  it('tripIdにnullを渡すと、写真は旅行から外れる', async () => {
    freezeNow();
    // 旅行 A に属する写真2枚のうち、1枚だけを外す。もう1枚は旅行 A に残る
    const photo1 = savedPhoto(PHOTO_1_ID, TRIP_A_ID);
    const otherPhoto = savedPhoto(OTHER_PHOTO_ID, TRIP_A_ID);
    cosmosBackend.documents.set(TRIP_A_ID, tripDocument(TRIP_A_ID, '京都'));
    cosmosBackend.documents.set(PHOTO_1_ID, photo1);
    cosmosBackend.documents.set(OTHER_PHOTO_ID, otherPhoto);
    const request = createMoveRequest({ photoIds: [PHOTO_1_ID], tripId: null });

    const response = await movePhotosHandler(request, mockContext);

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({ success: true, data: { moved: [PHOTO_1_ID], notFound: [] } });
    // tripId は項目ごと消えず null になる（欠けると未所属の一覧から消える。型のコメント参照）
    expect(cosmosBackend.documents.get(PHOTO_1_ID)).toEqual({ ...photo1, tripId: null, updatedAt: MOVED_AT });
    expect(cosmosBackend.documents.get(OTHER_PHOTO_ID)).toEqual(otherPhoto);
  });

  it('無い写真が混ざっていると、notFoundに入り、残りの写真は移る', async () => {
    freezeNow();
    // 無い写真を、保存済みの2枚の間に挟む。途中で止まらず、後ろの写真まで移ることを見る
    const photo1 = savedPhoto(PHOTO_1_ID, null);
    const photo2 = savedPhoto(PHOTO_2_ID, null);
    cosmosBackend.documents.set(TRIP_A_ID, tripDocument(TRIP_A_ID, '京都'));
    cosmosBackend.documents.set(PHOTO_1_ID, photo1);
    cosmosBackend.documents.set(PHOTO_2_ID, photo2);
    const request = createMoveRequest({ photoIds: [PHOTO_1_ID, MISSING_PHOTO_ID, PHOTO_2_ID], tripId: TRIP_A_ID });

    const response = await movePhotosHandler(request, mockContext);

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({
      success: true,
      data: { moved: [PHOTO_1_ID, PHOTO_2_ID], notFound: [MISSING_PHOTO_ID] }
    });
    expect(cosmosBackend.documents.get(PHOTO_1_ID)).toEqual({ ...photo1, tripId: TRIP_A_ID, updatedAt: MOVED_AT });
    expect(cosmosBackend.documents.get(PHOTO_2_ID)).toEqual({ ...photo2, tripId: TRIP_A_ID, updatedAt: MOVED_AT });
    // 無かった写真のドキュメントが作られてはいない
    expect(cosmosBackend.documents.has(MISSING_PHOTO_ID)).toBe(false);
  });

  it('既にその旅行にある写真も、movedに入る', async () => {
    freezeNow();
    // 写真1は既に旅行 A にあり、写真2は未所属
    cosmosBackend.documents.set(TRIP_A_ID, tripDocument(TRIP_A_ID, '京都'));
    cosmosBackend.documents.set(PHOTO_1_ID, savedPhoto(PHOTO_1_ID, TRIP_A_ID));
    cosmosBackend.documents.set(PHOTO_2_ID, savedPhoto(PHOTO_2_ID, null));
    const request = createMoveRequest({ photoIds: [PHOTO_1_ID, PHOTO_2_ID], tripId: TRIP_A_ID });

    const response = await movePhotosHandler(request, mockContext);

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({
      success: true,
      data: { moved: [PHOTO_1_ID, PHOTO_2_ID], notFound: [] }
    });
    expect((cosmosBackend.documents.get(PHOTO_1_ID) as PhotoDocument).tripId).toBe(TRIP_A_ID);
    expect((cosmosBackend.documents.get(PHOTO_2_ID) as PhotoDocument).tripId).toBe(TRIP_A_ID);
  });

  it('同じ写真IDが重複していても、1枚として扱う', async () => {
    freezeNow();
    cosmosBackend.documents.set(TRIP_A_ID, tripDocument(TRIP_A_ID, '京都'));
    cosmosBackend.documents.set(PHOTO_1_ID, savedPhoto(PHOTO_1_ID, null));
    cosmosBackend.documents.set(PHOTO_2_ID, savedPhoto(PHOTO_2_ID, null));
    const request = createMoveRequest({ photoIds: [PHOTO_1_ID, PHOTO_1_ID, PHOTO_2_ID], tripId: TRIP_A_ID });

    const response = await movePhotosHandler(request, mockContext);

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({
      success: true,
      data: { moved: [PHOTO_1_ID, PHOTO_2_ID], notFound: [] }
    });
  });

  it('写真IDがちょうど200件なら受け付けて、全部移す', async () => {
    freezeNow();
    // 上限の境界(201件は 400 になる。下の表)。200枚とも保存済みで、全部が移る
    const photoIds = manyPhotoIds(200);
    cosmosBackend.documents.set(TRIP_A_ID, tripDocument(TRIP_A_ID, '京都'));
    photoIds.forEach((id) => cosmosBackend.documents.set(id, savedPhoto(id, null)));
    const request = createMoveRequest({ photoIds, tripId: TRIP_A_ID });

    const response = await movePhotosHandler(request, mockContext);

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({ success: true, data: { moved: photoIds, notFound: [] } });
    const photos = photoIds.map((id) => cosmosBackend.documents.get(id) as PhotoDocument);
    expect(photos.filter((photo) => photo.tripId !== TRIP_A_ID)).toEqual([]);
  });

  // 05 §5.5 の 1〜8 を、表の順に。どの行も、保存済みの旅行 A と未所属の写真2枚は何も変わらない。
  // 形式の合わない要素の行は、正しい写真1の id を先頭に置く(後ろの不正な要素で、先頭の写真だけ移してしまう実装を見分ける)。
  // 最後の行は検証の順序の例(photoIds が空で tripId のキーも無いときは、表で先の「写真IDが指定されていません」)
  it.each([
    ['ボディがJSONとしてパースできない', jest.fn().mockRejectedValue(new SyntaxError('Unexpected token')), 'リクエストボディの形式が無効です'],
    ['ボディがnull', jest.fn().mockResolvedValue(null), 'リクエストボディが指定されていません'],
    ['photoIdsが文字列', jest.fn().mockResolvedValue({ photoIds: PHOTO_1_ID, tripId: TRIP_A_ID }), '写真IDは配列で指定してください'],
    ['photoIdsが無い', jest.fn().mockResolvedValue({ tripId: TRIP_A_ID }), '写真IDは配列で指定してください'],
    ['photoIdsが空', jest.fn().mockResolvedValue({ photoIds: [], tripId: TRIP_A_ID }), '写真IDが指定されていません'],
    ['photoIdsが201件', jest.fn().mockResolvedValue({ photoIds: manyPhotoIds(201), tripId: TRIP_A_ID }), '一度に移動できる写真は200枚までです'],
    ['photoIdsが同じidの201件(重複を除く前の件数で数える)', jest.fn().mockResolvedValue({ photoIds: Array(201).fill(PHOTO_1_ID), tripId: TRIP_A_ID }), '一度に移動できる写真は200枚までです'],
    ['photoIdsに3文字の要素がある', jest.fn().mockResolvedValue({ photoIds: [PHOTO_1_ID, 'abc'], tripId: TRIP_A_ID }), '写真IDの形式が無効です'],
    ['photoIdsに大文字の16進の要素がある', jest.fn().mockResolvedValue({ photoIds: [PHOTO_1_ID, PHOTO_2_ID.replace(/2/g, 'A')], tripId: TRIP_A_ID }), '写真IDの形式が無効です'],
    ['photoIdsに文字列でない要素がある', jest.fn().mockResolvedValue({ photoIds: [PHOTO_1_ID, 123], tripId: TRIP_A_ID }), '写真IDの形式が無効です'],
    ['tripIdのキーが無い', jest.fn().mockResolvedValue({ photoIds: [PHOTO_1_ID] }), '移動先の旅行が指定されていません'],
    ['tripIdがUUIDの形でない文字列', jest.fn().mockResolvedValue({ photoIds: [PHOTO_1_ID], tripId: 'abc' }), '旅行IDの形式が無効です'],
    ['tripIdが空の文字列', jest.fn().mockResolvedValue({ photoIds: [PHOTO_1_ID], tripId: '' }), '旅行IDの形式が無効です'],
    ['tripIdが数値', jest.fn().mockResolvedValue({ photoIds: [PHOTO_1_ID], tripId: 123 }), '旅行IDの形式が無効です'],
    ['photoIdsが空でtripIdのキーも無い(先の条件の理由を返す)', jest.fn().mockResolvedValue({ photoIds: [] }), '写真IDが指定されていません']
  ])('写真の移動で指定が正しくなければ、400で理由を返し、何も変えない（%s）', async (_case, json, message) => {
    cosmosBackend.documents.set(TRIP_A_ID, tripDocument(TRIP_A_ID, '京都'));
    cosmosBackend.documents.set(PHOTO_1_ID, savedPhoto(PHOTO_1_ID, null));
    cosmosBackend.documents.set(PHOTO_2_ID, savedPhoto(PHOTO_2_ID, null));
    const before = structuredClone(cosmosBackend.documents);
    const request = createMoveRequestWithJson(json);

    const response = await movePhotosHandler(request, mockContext);

    expect(response.status).toBe(400);
    const body = response.jsonBody as any;
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INVALID_REQUEST');
    expect(body.error.message).toBe(message);
    expect(cosmosBackend.documents).toEqual(before);
  });

  it('移す先の旅行が無いと、404で理由を返し、何も変えない', async () => {
    // 旅行 A は置かない。写真は保存済みで、形式も正しい(旅行の確認で初めて断られる)
    cosmosBackend.documents.set(PHOTO_1_ID, savedPhoto(PHOTO_1_ID, null));
    cosmosBackend.documents.set(PHOTO_2_ID, savedPhoto(PHOTO_2_ID, null));
    const before = structuredClone(cosmosBackend.documents);
    const request = createMoveRequest({ photoIds: [PHOTO_1_ID, PHOTO_2_ID], tripId: TRIP_A_ID });

    const response = await movePhotosHandler(request, mockContext);

    expect(response.status).toBe(404);
    const body = response.jsonBody as any;
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('TRIP_NOT_FOUND');
    expect(body.error.message).toBe('指定された旅行が見つかりません');
    expect(cosmosBackend.documents).toEqual(before);
  });

  // データベースの失敗の分類(接続できない障害は503、それ以外は500で message は固定)を、移動が使う2つの操作で確かめる。
  // 旅行の確認(読み取り)で失敗したときは何も移さず、写真の更新(patch)で失敗したときは最初の写真で止まるので何も変わらない
  it.each(
    (
      [
        ['旅行の確認', 'forcedReadError'],
        ['写真の更新', 'forcedPatchError']
      ] as const
    ).flatMap(([point, failureKey]) =>
      databaseFailureCases('写真の移動に失敗しました').map(
        ([failureCase, error, status, code, message]) => [failureCase, point, failureKey, error, status, code, message] as const
      )
    )
  )('写真の移動で%s（%s）', async (_case, _point, failureKey, error, status, code, message) => {
    // 形式が正しい要求で、旅行も写真もある(検証や404で先に返らず、データベースの操作まで進む)
    cosmosBackend.documents.set(TRIP_A_ID, tripDocument(TRIP_A_ID, '京都'));
    cosmosBackend.documents.set(PHOTO_1_ID, savedPhoto(PHOTO_1_ID, null));
    cosmosBackend.documents.set(PHOTO_2_ID, savedPhoto(PHOTO_2_ID, null));
    const before = structuredClone(cosmosBackend.documents);
    cosmosBackend[failureKey] = error;
    const request = createMoveRequest({ photoIds: [PHOTO_1_ID, PHOTO_2_ID], tripId: TRIP_A_ID });

    const response = await movePhotosHandler(request, mockContext);

    expect(response.status).toBe(status);
    const body = response.jsonBody as any;
    expect(body.success).toBe(false);
    expect(body.error.code).toBe(code);
    expect(body.error.message).toBe(message);
    expect(cosmosBackend.documents).toEqual(before);
  });
});
