import { HttpRequest, InvocationContext } from '@azure/functions';
import { getPlantByIdHandler, deletePlantHandler } from '../../src/functions/plantDetail';
import { Plant } from '../../src/types/plant';
import { CosmosClient } from '@azure/cosmos';
import { FakeCosmosBackend, createFakeContainer } from '../fakes/cosmos';
import { BlobServiceClient } from '@azure/storage-blob';
import { BlobEntry, FakeBlobBackend, createFakeBlobServiceClient } from '../fakes/blob';

// 外部依存のみモック
jest.mock('@azure/cosmos');
const MockedCosmosClient = CosmosClient as jest.MockedClass<typeof CosmosClient>;

// deletePlant() が内部で構築するStorageServiceが使うBlob SDKもこのファイル内でモックする。
// tests/setup.ts のグローバルモックの getBlockBlobClient() には delete が無く、
// それに頼ると画像削除がTypeErrorになってCosmosService内のcatchに飲み込まれてしまう
// （console.warnも抑制されるため気づけない）。削除が実際に成功する経路を通すため、
// delete を持つ偽物に差し替える
jest.mock('@azure/storage-blob', () => ({
  BlobServiceClient: { fromConnectionString: jest.fn() },
  BlobSASPermissions: jest.fn().mockImplementation(() => ({})),
  StorageSharedKeyCredential: jest.fn().mockImplementation(() => ({})),
  generateBlobSASQueryParameters: jest.fn()
}));
const MockedBlobServiceClient = BlobServiceClient as jest.MockedClass<typeof BlobServiceClient>;

// deletePlant() が内部で構築するStorageServiceの接続文字列解析に必要な自ストレージ設定。
// tests/setup.ts のグローバル値と偶然一致させるのではなく、このファイル内で
// 完結させる（beforeEach で process.env に設定する）
const TEST_STORAGE_CONNECTION_STRING = 'DefaultEndpointsProtocol=https;AccountName=test;AccountKey=testkey==;EndpointSuffix=core.windows.net';
const TEST_STORAGE_CONTAINER_NAME = 'test-images';
const TEST_IMAGE_BASE_URL = `https://test.blob.core.windows.net/${TEST_STORAGE_CONTAINER_NAME}`;


describe('植物詳細取得API', () => {
  let mockContext: InvocationContext;
  let cosmosBackend: FakeCosmosBackend<Plant>;
  let blobStore: Map<string, BlobEntry>;

  beforeEach(() => {
    // InvocationContextのモック
    mockContext = {
      log: jest.fn()
    } as any;

    // Cosmos DBの偽物バックエンド
    cosmosBackend = { documents: new Map() };
    const fakeContainer = createFakeContainer(cosmosBackend);
    MockedCosmosClient.mockImplementation(() => ({
      database: () => ({
        container: () => fakeContainer
      })
    } as unknown as CosmosClient));

    // Blobの偽物バックエンド
    blobStore = new Map();
    MockedBlobServiceClient.fromConnectionString = jest.fn().mockReturnValue(
      createFakeBlobServiceClient({ store: blobStore })
    );

    // 環境変数設定
    process.env.COSMOS_DB_ENDPOINT = 'https://test.documents.azure.com:443/';
    process.env.COSMOS_DB_KEY = 'test-key';
    process.env.COSMOS_DB_DATABASE = 'test-db';
    process.env.COSMOS_DB_CONTAINER = 'test-container';
    // deletePlant()が内部で構築するStorageServiceに使う
    process.env.STORAGE_CONNECTION_STRING = TEST_STORAGE_CONNECTION_STRING;
    process.env.STORAGE_CONTAINER_NAME = TEST_STORAGE_CONTAINER_NAME;
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete process.env.COSMOS_DB_ENDPOINT;
    delete process.env.COSMOS_DB_KEY;
    delete process.env.COSMOS_DB_DATABASE;
    delete process.env.COSMOS_DB_CONTAINER;
    delete process.env.STORAGE_CONNECTION_STRING;
    delete process.env.STORAGE_CONTAINER_NAME;
  });

  describe('GET /api/plants/{id} - 植物詳細取得', () => {
    const validPlantId = '123e4567-e89b-12d3-a456-426614174000';

    it('植物詳細を正常に取得できる', async () => {
      // テストデータ
      const mockPlant: Plant = {
        id: validPlantId,
        name: '桜',
        scientificName: 'Prunus serrulata',
        familyName: 'バラ科',
        description: '日本を代表する花木',
        characteristics: '春に美しい花を咲かせる',
        confidence: 95.5,
        imagePath: 'https://example.com/sakura.jpg',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z'
      };
      cosmosBackend.documents.set(validPlantId, mockPlant);

      // リクエストの作成
      const request = {
        method: 'GET',
        url: `https://func-snaplant.azurewebsites.net/api/plants/${validPlantId}?code=test-key`,
        query: new Map([['code', 'test-key']]),
        params: { id: validPlantId },
        headers: new Map()
      } as any as HttpRequest;

      // 実行
      const response = await getPlantByIdHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(200);
      expect(response.jsonBody).toEqual({
        success: true,
        data: {
          plant: mockPlant
        }
      });
    });

    it('存在しない植物IDの場合は404エラー', async () => {
      // リクエストの作成（cosmosBackend.documents は空のまま。該当IDが無い状態）
      const request = {
        method: 'GET',
        url: `https://func-snaplant.azurewebsites.net/api/plants/${validPlantId}?code=test-key`,
        query: new Map([['code', 'test-key']]),
        params: { id: validPlantId },
        headers: new Map()
      } as any as HttpRequest;

      // 実行
      const response = await getPlantByIdHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(404);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'PLANT_NOT_FOUND',
          message: '指定された植物が見つかりません'
        }
      });
    });

    it('無効なUUID形式の場合は400エラー', async () => {
      const invalidId = 'invalid-uuid';

      // リクエストの作成
      const request = {
        method: 'GET',
        url: `https://func-snaplant.azurewebsites.net/api/plants/${invalidId}?code=test-key`,
        query: new Map([['code', 'test-key']]),
        params: { id: invalidId },
        headers: new Map()
      } as any as HttpRequest;

      // 実行
      const response = await getPlantByIdHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(400);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: '植物IDの形式が無効です',
          details: 'UUID形式で指定してください'
        }
      });
    });

    // 植物 ID の形の規則（06_api_openapi.yaml の id の説明）は GET / PUT / DELETE で同じ（06_api_design.md §5.2）。
    // 全ケースはここ（GET）で通し、PUT は「無効な植物ID」の1行だけにしている。
    // 受け入れた ID は形の検査を通ってデータベースを引きに行くので、該当が無ければ 404 になる
    const getPlantRequest = (id: string) => ({
      method: 'GET',
      url: `https://func-snaplant.azurewebsites.net/api/plants/${id}?code=test-key`,
      query: new Map([['code', 'test-key']]),
      params: { id },
      headers: new Map()
    } as any as HttpRequest);

    it.each([
      ['小文字のUUID v4', 'f47ac10b-58cc-4372-a567-0e02b2c3d479'],
      ['大文字', 'A1234567-B89C-4234-A567-123456789ABC'],
      ['バージョン1（下限）', '123e4567-e89b-11d3-a456-426614174000'],
      ['バージョン5（上限）', '123e4567-e89b-51d3-a456-426614174000'],
      ['variantが8（下限）', '123e4567-e89b-41d3-8456-426614174000'],
      ['variantがb（上限）', '123e4567-e89b-41d3-b456-426614174000'],
    ])('植物IDが%sのUUIDなら形の検査を通り、該当が無ければ404エラー', async (_name, id) => {
      const response = await getPlantByIdHandler(getPlantRequest(id), mockContext);

      expect(response.status).toBe(404);
      expect(response.jsonBody).toMatchObject({
        success: false,
        error: { code: 'PLANT_NOT_FOUND', message: '指定された植物が見つかりません' }
      });
    });

    it.each([
      ['短すぎる', '123e4567-e89b-12d3-a456'],
      ['先頭に余分な文字がある', 'x123e4567-e89b-41d3-a456-426614174000'],
      ['末尾に余分な文字がある', '123e4567-e89b-41d3-a456-426614174000-extra'],
      ['16進数でない文字を含む', '123e4567-e89b-41d3-a456-42661417400g'],
      ['区切りがアンダースコアの', '123e4567_e89b_41d3_a456_426614174000'],
      ['ハイフンが欠けている', '123e4567e89b-41d3-a456-426614174000'],
      ['バージョンが0の', '123e4567-e89b-01d3-a456-426614174000'],
      ['バージョンが6の', '123e4567-e89b-61d3-a456-426614174000'],
      ['variantが7の', '123e4567-e89b-41d3-7456-426614174000'],
      ['variantがcの', '123e4567-e89b-41d3-c456-426614174000'],
    ])('植物IDが%sものは、形式が無効として400エラー', async (_name, id) => {
      const response = await getPlantByIdHandler(getPlantRequest(id), mockContext);

      expect(response.status).toBe(400);
      expect(response.jsonBody).toMatchObject({
        success: false,
        error: { code: 'INVALID_REQUEST', message: '植物IDの形式が無効です' }
      });
    });

    it('植物IDが未指定の場合は400エラー', async () => {
      // リクエストの作成
      const request = {
        method: 'GET',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/?code=test-key',
        query: new Map([['code', 'test-key']]),
        params: {},
        headers: new Map()
      } as any as HttpRequest;

      // 実行
      const response = await getPlantByIdHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(400);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: '植物IDが指定されていません'
        }
      });
    });
  });

  describe('DELETE /api/plants/{id} - 植物削除', () => {
    const validPlantId = '123e4567-e89b-12d3-a456-426614174000';
    const deletePlantRequest = (id: string) => ({
      method: 'DELETE',
      url: `https://func-snaplant.azurewebsites.net/api/plants/${id}?code=test-key`,
      query: new Map([['code', 'test-key']]),
      params: { id },
      headers: new Map()
    } as any as HttpRequest);

    it('植物を正常に削除できる', async () => {
      // 削除対象のドキュメントを用意する（imagePathを持つ。deletePlant()は
      // ドキュメント削除前にimagePathを読み、削除後にその画像も削除する）
      const existingPlant: Plant = {
        id: validPlantId,
        name: '桜',
        characteristics: '春に美しい花を咲かせる',
        confidence: 95.5,
        imagePath: `${TEST_IMAGE_BASE_URL}/sakura.jpg`,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z'
      };
      cosmosBackend.documents.set(validPlantId, existingPlant);
      // 画像削除が実際に成功する経路を通すため、対応するBlobも存在させておく
      blobStore.set('test-images/sakura.jpg', { content: Buffer.from('dummy') });

      // リクエストの作成
      const request = {
        method: 'DELETE',
        url: `https://func-snaplant.azurewebsites.net/api/plants/${validPlantId}?code=test-key`,
        query: new Map([['code', 'test-key']]),
        params: { id: validPlantId },
        headers: new Map()
      } as any as HttpRequest;

      // 実行
      const response = await deletePlantHandler(request, mockContext);

      // 検証（レスポンス）
      expect(response.status).toBe(200);
      expect(response.jsonBody).toEqual({
        success: true,
        data: {
          message: '植物が正常に削除されました'
        }
      });
      // 検証（ドキュメントが消えたことの状態検証。delete呼び出しの引数ではなく、
      // 実際にバックエンドから無くなったかどうかを確認する）
      expect(cosmosBackend.documents.has(validPlantId)).toBe(false);
      // 検証（画像も削除されたことの状態検証）
      expect(blobStore.has('test-images/sakura.jpg')).toBe(false);
    });

    it('画像の削除に失敗しても、200で植物は消える（画像は残る）', async () => {
      // 06_api_design.md §5.7。画像の削除の失敗はログだけで、ドキュメントの削除は成功扱いにする
      cosmosBackend.documents.set(validPlantId, {
        id: validPlantId,
        name: '桜',
        characteristics: '春に美しい花を咲かせる',
        confidence: 95.5,
        imagePath: `${TEST_IMAGE_BASE_URL}/sakura.jpg`,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z'
      });
      blobStore.set('test-images/sakura.jpg', {
        content: Buffer.from('dummy'),
        failWith: new Error('Delete failed')
      });

      const response = await deletePlantHandler(deletePlantRequest(validPlantId), mockContext);

      expect(response.status).toBe(200);
      expect(response.jsonBody).toEqual({
        success: true,
        data: { message: '植物が正常に削除されました' }
      });
      expect(cosmosBackend.documents.has(validPlantId)).toBe(false);
      expect(blobStore.has('test-images/sakura.jpg')).toBe(true);
    });

    describe('消す画像の条件', () => {
      // 06_api_design.md §5.7（条件は §5.5 の旧画像と同じ）。自ストレージアカウントの永続コンテナか
      // 一時コンテナを指す imagePath だけを削除し、それ以外は何も削除せずエラーにもしない。
      // 入口の検証（isValidImagePath）を通らない imagePath も、検証が入る前のデータとしては残りうるので、
      // 偽物のデータベースに直接置いて確かめる
      const fileName = '44444444-4444-4444-4444-444444444444.jpg';
      const plantWithImage = (imagePath: string): Plant => ({
        id: validPlantId,
        name: '桜',
        characteristics: '春に美しい花を咲かせる',
        confidence: 95.5,
        imagePath,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z'
      });

      beforeEach(() => {
        process.env.TEMP_STORAGE_CONTAINER_NAME = 'test-temp';
      });

      afterEach(() => {
        delete process.env.TEMP_STORAGE_CONTAINER_NAME;
      });

      it('ストレージアカウント名に一時コンテナ名が含まれていても、永続コンテナの画像が消える', async () => {
        // アカウント名 "test-temp-account" が一時コンテナ名 "test-temp" を含む。
        // コンテナを URL 全体の文字列包含で判定すると、パス上は永続コンテナの画像を
        // 一時コンテナ側と誤認し、消したつもりで残る
        process.env.STORAGE_CONNECTION_STRING =
          'DefaultEndpointsProtocol=https;AccountName=test-temp-account;AccountKey=testkey==;EndpointSuffix=core.windows.net';
        cosmosBackend.documents.set(
          validPlantId,
          plantWithImage(`https://test-temp-account.blob.core.windows.net/test-images/${fileName}`)
        );
        blobStore.set(`test-images/${fileName}`, { content: Buffer.from('data') });

        const response = await deletePlantHandler(deletePlantRequest(validPlantId), mockContext);

        expect(response.status).toBe(200);
        expect(cosmosBackend.documents.has(validPlantId)).toBe(false);
        expect(blobStore.has(`test-images/${fileName}`)).toBe(false);
      });

      it.each([
        // コンテナ名はあえて永続コンテナと同じにする。違うとコンテナの不一致だけで消えず、ホストを見ているか分からない
        ['自ストレージアカウント以外のホスト', `https://example.com/test-images/${fileName}`, [`test-images/${fileName}`]],
        // 一時コンテナ名 "test-temp" で始まるだけの別のコンテナ。前方一致なら一時コンテナと、
        // 未知のコンテナを永続コンテナとみなすなら永続コンテナと誤認して、同名の画像を消す
        [
          '一時コンテナ名で始まるだけの未知のコンテナ',
          `https://test.blob.core.windows.net/test-temp-archive/${fileName}`,
          [`test-temp-archive/${fileName}`, `test-temp/${fileName}`, `test-images/${fileName}`]
        ],
        // コンテナ名と Blob 名の間に余分なセグメント。最後のセグメントだけを Blob 名にすると、無関係な画像を指す
        ['永続コンテナの後に余分なセグメントを挟んだURL', `https://test.blob.core.windows.net/test-images/x/${fileName}`, [`test-images/${fileName}`]],
      ])('画像のURLが%sを指す植物を削除しても、200で、同名の画像は消えない', async (_name, imagePath, keysToKeep) => {
        cosmosBackend.documents.set(validPlantId, plantWithImage(imagePath));
        for (const key of keysToKeep) {
          blobStore.set(key, { content: Buffer.from('data') });
        }

        const response = await deletePlantHandler(deletePlantRequest(validPlantId), mockContext);

        expect(response.status).toBe(200);
        expect(cosmosBackend.documents.has(validPlantId)).toBe(false);
        for (const key of keysToKeep) {
          expect(blobStore.has(key)).toBe(true);
        }
      });
    });

    it('存在しない植物IDの場合は404エラー', async () => {
      // リクエストの作成（cosmosBackend.documents は空のまま。該当IDが無い状態。
      // read はNotFoundを飲み込んでresourceなしを返し、delete は例外を投げる
      // ——どちらも実SDKの挙動に合わせた偽物の既定動作）
      const request = {
        method: 'DELETE',
        url: `https://func-snaplant.azurewebsites.net/api/plants/${validPlantId}?code=test-key`,
        query: new Map([['code', 'test-key']]),
        params: { id: validPlantId },
        headers: new Map()
      } as any as HttpRequest;

      // 実行
      const response = await deletePlantHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(404);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'PLANT_NOT_FOUND',
          message: '指定された植物が見つかりません'
        }
      });
    });

    it('データベースの削除に失敗した場合は500エラーになり、植物も画像も残る', async () => {
      // 404（該当なし）とは区別される、予期しない失敗。detailsは契約外なので文言を固定しない
      const existingPlant: Plant = {
        id: validPlantId,
        name: '桜',
        characteristics: '春に美しい花を咲かせる',
        confidence: 95.5,
        imagePath: `${TEST_IMAGE_BASE_URL}/sakura.jpg`,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z'
      };
      cosmosBackend.documents.set(validPlantId, existingPlant);
      blobStore.set('test-images/sakura.jpg', { content: Buffer.from('dummy') });
      cosmosBackend.forcedDeleteError = new Error('Delete failed');
      const request = {
        method: 'DELETE',
        url: `https://func-snaplant.azurewebsites.net/api/plants/${validPlantId}?code=test-key`,
        query: new Map([['code', 'test-key']]),
        params: { id: validPlantId },
        headers: new Map()
      } as any as HttpRequest;

      const response = await deletePlantHandler(request, mockContext);

      expect(response.status).toBe(500);
      expect(response.jsonBody).toMatchObject({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: '植物の削除に失敗しました' }
      });
      expect(cosmosBackend.documents.has(validPlantId)).toBe(true);
      expect(blobStore.has('test-images/sakura.jpg')).toBe(true);
    });
  });

});
