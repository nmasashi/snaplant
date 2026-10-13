import { HttpRequest, InvocationContext } from '@azure/functions';
import { savePlantHandler } from '../../src/functions/save';
import { Plant } from '../../src/types/plant';
import { CosmosClient } from '@azure/cosmos';
import { FakeCosmosBackend, createFakeContainer } from '../fakes/cosmos';

// 外部依存のみモック
jest.mock('@azure/cosmos');
const MockedCosmosClient = CosmosClient as jest.MockedClass<typeof CosmosClient>;

// id は CosmosService.generateId()（Math.random() ベースの自前実装）が生成するため
// uuidパッケージはモックしても効かない。形式（UUID v4）だけを検証する
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// StorageService.isValidImagePath() が有効と判定するために必要な自ストレージ設定。
// tests/setup.ts のグローバル値と偶然一致させるのではなく、このファイル内で
// 完結させる（beforeEach で process.env に設定する）
const TEST_STORAGE_CONNECTION_STRING = 'DefaultEndpointsProtocol=https;AccountName=test;AccountKey=testkey==;EndpointSuffix=core.windows.net';
const TEST_STORAGE_CONTAINER_NAME = 'test-images';
const TEST_IMAGE_BASE_URL = `https://test.blob.core.windows.net/${TEST_STORAGE_CONTAINER_NAME}`;

describe('植物保存API', () => {
  let mockContext: InvocationContext;
  let cosmosBackend: FakeCosmosBackend<Plant>;

  beforeEach(() => {
    // InvocationContextのモック
    mockContext = {
      log: jest.fn()
    } as any;

    // Cosmos DBの偽物バックエンド
    cosmosBackend = {
      documents: new Map(),
      forcedCreateError: null
    };
    const fakeContainer = createFakeContainer(cosmosBackend);
    MockedCosmosClient.mockImplementation(() => ({
      database: () => ({
        container: () => fakeContainer
      })
    } as unknown as CosmosClient));

    // 環境変数設定
    process.env.COSMOS_DB_ENDPOINT = 'https://test.documents.azure.com:443/';
    process.env.COSMOS_DB_KEY = 'test-key';
    process.env.COSMOS_DB_DATABASE = 'test-db';
    process.env.COSMOS_DB_CONTAINER = 'test-container';
    // imagePathのバリデーション（StorageService.isValidImagePath）に使う
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

  describe('正常系', () => {
    it('植物を正常に保存できる', async () => {
      // リクエストの作成
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/save?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        json: jest.fn().mockResolvedValue({
          name: '桜',
          scientificName: 'Prunus serrulata',
          familyName: 'バラ科',
          description: '日本を代表する花木で、春に美しい花を咲かせる。',
          characteristics: '春に美しいピンクの花を咲かせる',
          confidence: 95.5,
          imagePath: `${TEST_IMAGE_BASE_URL}/sakura.jpg`
        })
      } as any as HttpRequest;

      // 実行
      const response = await savePlantHandler(request, mockContext);

      // 検証（レスポンス）
      expect(response.status).toBe(201);
      expect(response.jsonBody).toEqual({
        success: true,
        data: {
          plant: {
            id: expect.stringMatching(UUID_V4_PATTERN),
            name: '桜',
            scientificName: 'Prunus serrulata',
            familyName: 'バラ科',
            description: '日本を代表する花木で、春に美しい花を咲かせる。',
            characteristics: '春に美しいピンクの花を咲かせる',
            confidence: 95.5,
            imagePath: `${TEST_IMAGE_BASE_URL}/sakura.jpg`,
            createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
            updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
          }
        }
      });

      // 検証（実際に永続化された内容。create呼び出しの引数ではなく
      // 偽物バックエンドに保存された状態そのものを確認する）。
      // idは実行結果に生成された乱数のため、レスポンスから得たidで
      // バックエンドを引く（固定値を2箇所に書かない）
      const savedId: string = response.jsonBody.data.plant.id;
      expect(cosmosBackend.documents.get(savedId)).toEqual({
        id: savedId,
        name: '桜',
        scientificName: 'Prunus serrulata',
        familyName: 'バラ科',
        description: '日本を代表する花木で、春に美しい花を咲かせる。',
        characteristics: '春に美しいピンクの花を咲かせる',
        confidence: 95.5,
        imagePath: `${TEST_IMAGE_BASE_URL}/sakura.jpg`,
        createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
        updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      });
    });

    it('2回保存すると、それぞれ別のIDで保存される', async () => {
      // 画像は別々にする（同じ画像なら 409 になる）
      const saveRequest = (imageName: string) => ({
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/save?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        json: jest.fn().mockResolvedValue({
          name: '桜',
          characteristics: '春に美しいピンクの花を咲かせる',
          confidence: 95.5,
          imagePath: `${TEST_IMAGE_BASE_URL}/${imageName}`
        })
      } as any as HttpRequest);

      const first = await savePlantHandler(saveRequest('first.jpg'), mockContext);
      const second = await savePlantHandler(saveRequest('second.jpg'), mockContext);

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(first.jsonBody.data.plant.id).not.toBe(second.jsonBody.data.plant.id);
      expect(cosmosBackend.documents.size).toBe(2);
    });

    it('最小限のフィールドで植物を保存できる', async () => {
      // リクエストの作成（必須フィールドのみ）
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/save?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        json: jest.fn().mockResolvedValue({
          name: 'テスト植物',
          characteristics: '基本的な特徴',
          confidence: 80.0,
          imagePath: `${TEST_IMAGE_BASE_URL}/test.jpg`
        })
      } as any as HttpRequest;

      // 実行
      const response = await savePlantHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(201);
      expect(response.jsonBody.success).toBe(true);
      expect(response.jsonBody.data.plant.name).toBe('テスト植物');
    });

    it('アプリが任意項目をnullで送っても保存できる', async () => {
      // Flutterクライアントは空の任意項目をnullで送る。弾くとアプリからの保存が壊れる
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/save?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        json: jest.fn().mockResolvedValue({
          name: 'テスト植物',
          scientificName: null,
          familyName: null,
          description: null,
          characteristics: '基本的な特徴',
          confidence: 80.0,
          imagePath: `${TEST_IMAGE_BASE_URL}/test.jpg`
        })
      } as any as HttpRequest;

      // 実行
      const response = await savePlantHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(201);
      const savedId: string = response.jsonBody.data.plant.id;
      expect(cosmosBackend.documents.get(savedId)?.name).toBe('テスト植物');
    });

    it('名前の前後の空白を取り除いて保存する（重複確認と同じ名前で見つかるようにするため）', async () => {
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/save?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        json: jest.fn().mockResolvedValue({
          name: '  桜  ',
          characteristics: '基本的な特徴',
          confidence: 80.0,
          imagePath: `${TEST_IMAGE_BASE_URL}/sakura.jpg`
        })
      } as any as HttpRequest;

      // 実行
      const response = await savePlantHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(201);
      const savedId: string = response.jsonBody.data.plant.id;
      expect(cosmosBackend.documents.get(savedId)?.name).toBe('桜');
    });

    it('前後に空白が付いていても、取り除いた後の名前が上限ちょうどなら保存できる（保存される名前と同じ長さで上限を判定するため）', async () => {
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/save?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        json: jest.fn().mockResolvedValue({
          // 上限（100文字）ちょうどの名前の前後に半角空白を1つずつ付ける
          name: ' ' + 'あ'.repeat(100) + ' ',
          characteristics: '基本的な特徴',
          confidence: 80.0,
          imagePath: `${TEST_IMAGE_BASE_URL}/sakura.jpg`
        })
      } as any as HttpRequest;

      // 実行
      const response = await savePlantHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(201);
      const savedId: string = response.jsonBody.data.plant.id;
      expect(cosmosBackend.documents.get(savedId)?.name).toBe('あ'.repeat(100));
    });
  });

  describe('バリデーションエラー', () => {
    it('必須フィールドが未指定の場合は400エラー', async () => {
      // リクエストの作成（nameなし）
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/save?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        json: jest.fn().mockResolvedValue({
          characteristics: '特徴',
          confidence: 80.0,
          imagePath: `${TEST_IMAGE_BASE_URL}/test.jpg`
        })
      } as any as HttpRequest;

      // 実行
      const response = await savePlantHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(400);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: '植物名が指定されていません',
          details: undefined
        }
      });
      // 保存されていないことの状態検証（ドキュメントが増えていない）
      expect(cosmosBackend.documents.size).toBe(0);
    });

    it('特徴が未指定の場合は400エラー', async () => {
      // リクエストの作成（characteristicsなし）
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/save?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        json: jest.fn().mockResolvedValue({
          name: 'テスト植物',
          confidence: 80.0,
          imagePath: `${TEST_IMAGE_BASE_URL}/test.jpg`
        })
      } as any as HttpRequest;

      // 実行
      const response = await savePlantHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(400);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: '特徴が指定されていません',
          details: undefined
        }
      });
      // 保存されていないことの状態検証（ドキュメントが増えていない）
      expect(cosmosBackend.documents.size).toBe(0);
    });

    it('植物名が長すぎる場合は400エラー', async () => {
      // リクエストの作成（長すぎる植物名）
      const longName = 'あ'.repeat(101); // 101文字
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/save?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        json: jest.fn().mockResolvedValue({
          name: longName,
          characteristics: '特徴',
          confidence: 80.0,
          imagePath: `${TEST_IMAGE_BASE_URL}/test.jpg`
        })
      } as any as HttpRequest;

      // 実行
      const response = await savePlantHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(400);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: '植物名は100文字以内で指定してください',
          details: undefined
        }
      });
      // 保存されていないことの状態検証（ドキュメントが増えていない）
      expect(cosmosBackend.documents.size).toBe(0);
    });

    it('信頼度が上限を超える場合は400エラー', async () => {
      // リクエストの作成（信頼度が上限を超える）
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/save?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        json: jest.fn().mockResolvedValue({
          name: 'テスト植物',
          characteristics: '特徴',
          confidence: 150.0, // 上限超過
          imagePath: `${TEST_IMAGE_BASE_URL}/test.jpg`
        })
      } as any as HttpRequest;

      // 実行
      const response = await savePlantHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(400);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: '信頼度は0から100の間の数値で指定してください',
          details: undefined
        }
      });
      // 保存されていないことの状態検証（ドキュメントが増えていない）
      expect(cosmosBackend.documents.size).toBe(0);
    });

    it('信頼度が負値の場合は400エラー', async () => {
      // リクエストの作成（信頼度が下限未満）
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/save?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        json: jest.fn().mockResolvedValue({
          name: 'テスト植物',
          characteristics: '特徴',
          confidence: -1, // 下限未満
          imagePath: `${TEST_IMAGE_BASE_URL}/test.jpg`
        })
      } as any as HttpRequest;

      // 実行
      const response = await savePlantHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(400);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: '信頼度は0から100の間の数値で指定してください',
          details: undefined
        }
      });
      // 保存されていないことの状態検証（ドキュメントが増えていない）
      expect(cosmosBackend.documents.size).toBe(0);
    });

    // 必須項目は .trim() で TypeError（500）に、任意項目は上限の検査をすり抜けて
    // そのまま保存されていた。どちらも文字列以外は一律400にする
    it.each([
      { field: 'name', label: '植物名', expectedMessage: '植物名は文字列で指定してください' },
      { field: 'characteristics', label: '特徴', expectedMessage: '特徴は文字列で指定してください' },
      { field: 'imagePath', label: '画像パス', expectedMessage: '画像パスは文字列で指定してください' },
      { field: 'scientificName', label: '学名', expectedMessage: '学名は文字列で指定してください' },
      { field: 'familyName', label: '科名', expectedMessage: '科名は文字列で指定してください' },
      { field: 'description', label: '説明', expectedMessage: '説明は文字列で指定してください' }
    ])('$labelに文字列以外を指定した場合は400エラー', async ({ field, expectedMessage }) => {
      // リクエストの作成（対象の項目だけ数値にし、他は正当な値にする）
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/save?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        json: jest.fn().mockResolvedValue({
          name: 'テスト植物',
          characteristics: '特徴',
          confidence: 80.0,
          imagePath: `${TEST_IMAGE_BASE_URL}/test.jpg`,
          [field]: 123
        })
      } as any as HttpRequest;

      // 実行
      const response = await savePlantHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(400);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: expectedMessage,
          details: undefined
        }
      });
      // 保存されていないことの状態検証
      expect(cosmosBackend.documents.size).toBe(0);
    });

    it('植物名にnullを指定した場合は、型違いではなく未指定として400エラーになる', async () => {
      // 任意項目はnullを「なし」として受け付けるが、必須項目のnullは未指定と同じ扱い
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/save?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        json: jest.fn().mockResolvedValue({
          name: null,
          characteristics: '特徴',
          confidence: 80.0,
          imagePath: `${TEST_IMAGE_BASE_URL}/test.jpg`
        })
      } as any as HttpRequest;

      // 実行
      const response = await savePlantHandler(request, mockContext);

      // 検証（detailsの文言は契約外なので固定しない）
      expect(response.status).toBe(400);
      expect(response.jsonBody.success).toBe(false);
      expect(response.jsonBody.error.code).toBe('INVALID_REQUEST');
      expect(response.jsonBody.error.message).toBe('植物名が指定されていません');
      expect(cosmosBackend.documents.size).toBe(0);
    });

    // 重複チェックは別途実装されるcheckDuplicate APIで行うため、ここではテストしない

    it('同じimagePathを持つ植物が既に保存されている場合は409エラー', async () => {
      // 既存植物が1件存在する状態（同じimagePathを持つ）。
      // 重複チェックが機能していない場合、偽物バックエンドの create が
      // そのまま実行されてしまい、201とドキュメント追加という形で判別できる
      const existingPlant: Plant = {
        id: 'existing-id-0000-0000-000000000000',
        name: '既存の桜',
        characteristics: '既存の特徴',
        confidence: 90.0,
        imagePath: `${TEST_IMAGE_BASE_URL}/duplicate.jpg`,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z'
      };
      cosmosBackend.documents.set(existingPlant.id, existingPlant);

      // リクエストの作成（既存植物と同じimagePath。他のフィールドはすべて正当な値にする）
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/save?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        json: jest.fn().mockResolvedValue({
          name: 'テスト植物',
          characteristics: '特徴',
          confidence: 80.0,
          imagePath: `${TEST_IMAGE_BASE_URL}/duplicate.jpg`
        })
      } as any as HttpRequest;

      // 実行
      const response = await savePlantHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(409);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'IMAGE_ALREADY_SAVED',
          message: 'この画像は既に保存されています',
          details: undefined
        }
      });
      // 新しいドキュメントが追加されていないことの状態検証
      expect(cosmosBackend.documents.size).toBe(1);
    });

    it('画像パスが自ストレージアカウント以外のホストを指す場合は400エラー', async () => {
      // リクエストの作成（imagePathが自アカウント以外のホストを指す。
      // URLとしては正しくパースできるが、他レコードのBlobを指し得る。
      // コンテナ名はあえて永続コンテナ（test-images）と一致させている。
      // 一致しない値（例: foo）だとコンテナ名の不一致だけで400になり、
      // ホスト検証を削除してもこのテストは落ちなくなる。
      // このバリデーションが機能していない場合、偽物バックエンドの create が
      // 実行されて201になるため、201とドキュメント追加という形で判別できる）
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/save?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        json: jest.fn().mockResolvedValue({
          name: 'テスト植物',
          characteristics: '特徴',
          confidence: 80.0,
          imagePath: 'https://example.com/test-images/123e4567-e89b-12d3-a456-426614174000.jpg'
        })
      } as any as HttpRequest;

      // 実行
      const response = await savePlantHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(400);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: '画像アップロードAPIが返したURLを指定してください',
          details: undefined
        }
      });
      expect(cosmosBackend.documents.size).toBe(0);
    });

    // imagePath の形の条件（06_api_design.md §5.4）は save と PUT（§5.5）で同じ。
    // 全ケースはここ（save）で通し、updatePlant.test.ts は別ホストの1行だけにしている。
    // 別ホストは上の1行が見ているので、表には残りを並べる。行の並びは §5.4 の条件の順。
    // 4つの条件（スキーム・ホスト・2セグメント・生の文字列の完全一致）は独立に効くようにしてあり、
    // どれか1つが緩んでも他が残るのが設計（CLAUDE.md「バリデーション定数」）。そのため、
    // スキームやホストの検査だけを外す変異は、最後の完全一致が受け止めて生き残る
    it.each([
      // 値そのものに意味はなく、永続コンテナ以外はすべて拒否するという性質を守る
      ['永続コンテナ以外のコンテナを指す', 'https://test.blob.core.windows.net/some-other-container/123e4567-e89b-12d3-a456-426614174000.jpg'],
      // アップロードAPIが返す形は常に「/コンテナ名/Blob名」の2セグメント。余分なセグメントは存在しないBlobを指す
      ['永続コンテナ名の後に余分なセグメントを挟んだ', 'https://test.blob.core.windows.net/test-images/x/123e4567-e89b-12d3-a456-426614174000.jpg'],
      // Blob名のセグメントが空。Blobを指さないURLが保存されてしまう
      ['コンテナまでしか指していない', 'https://test.blob.core.windows.net/test-images/'],
      ['スキームがhttpsでない', 'http://test.blob.core.windows.net/test-images/123e4567-e89b-12d3-a456-426614174000.jpg'],
      // 以下は new URL() のパース結果では正当なURLと区別できず（クエリ・フラグメント・認証情報は
      // pathname に出ず、ホストの大文字小文字と先頭の空白は正規化される）、生の文字列同士の
      // 完全一致だけが検出する。保存されるのは生の文字列なので、通すと重複チェック
      // （文字列の完全一致）を素通りでき、更新時の旧画像削除の判定（文字列比較）も誤作動する
      ['クエリ文字列が付いた', 'https://test.blob.core.windows.net/test-images/123e4567-e89b-12d3-a456-426614174000.jpg?x=1'],
      ['フラグメントが付いた', 'https://test.blob.core.windows.net/test-images/123e4567-e89b-12d3-a456-426614174000.jpg#f'],
      // 認証情報は、そのまま保存されると資格情報が平文でデータベースに残る点でも害がある
      ['認証情報が付いた', 'https://u:p@test.blob.core.windows.net/test-images/123e4567-e89b-12d3-a456-426614174000.jpg'],
      ['ホスト名が大文字の', 'https://TEST.blob.core.windows.net/test-images/123e4567-e89b-12d3-a456-426614174000.jpg'],
      ['先頭に空白がある', ' https://test.blob.core.windows.net/test-images/123e4567-e89b-12d3-a456-426614174000.jpg']
    ])('画像パスが%sURLの場合は400エラーで、保存されない', async (_name, imagePath) => {
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/save?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        json: jest.fn().mockResolvedValue({
          name: 'テスト植物',
          characteristics: '特徴',
          confidence: 80.0,
          imagePath
        })
      } as any as HttpRequest;

      const response = await savePlantHandler(request, mockContext);

      expect(response.status).toBe(400);
      expect(response.jsonBody).toMatchObject({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: '画像アップロードAPIが返したURLを指定してください'
        }
      });
      expect(cosmosBackend.documents.size).toBe(0);
    });

    it('JSONパースエラーの場合は400エラー', async () => {
      // リクエストの作成（JSONパースエラー）
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/save?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        json: jest.fn().mockRejectedValue(new SyntaxError('Unexpected token'))
      } as any as HttpRequest;

      // 実行
      const response = await savePlantHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(400);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'リクエストボディの形式が無効です',
          details: 'JSON形式で送信してください'
        }
      });
    });
  });

  describe('Cosmos DB エラー', () => {
    it('DB接続エラーの場合は503エラー', async () => {
      // DB接続エラーのモック
      const connectionError = new Error('ENOTFOUND');
      (connectionError as any).code = 'ENOTFOUND';
      cosmosBackend.forcedCreateError = connectionError;

      // リクエストの作成
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/save?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        json: jest.fn().mockResolvedValue({
          name: 'テスト植物',
          characteristics: '特徴',
          confidence: 80.0,
          imagePath: `${TEST_IMAGE_BASE_URL}/test.jpg`
        })
      } as any as HttpRequest;

      // 実行
      const response = await savePlantHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(503);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'DATABASE_ERROR',
          message: 'データベースに接続できません',
          details: 'ENOTFOUND'
        }
      });
    });

    it('Cosmos DB制約エラーの場合は409エラー', async () => {
      // Cosmos DB制約エラーのモック
      const conflictError = new Error('Conflict');
      (conflictError as any).code = 409;
      cosmosBackend.forcedCreateError = conflictError;

      // リクエストの作成
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/save?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        json: jest.fn().mockResolvedValue({
          name: 'テスト植物',
          characteristics: '特徴',
          confidence: 80.0,
          imagePath: `${TEST_IMAGE_BASE_URL}/test.jpg`
        })
      } as any as HttpRequest;

      // 実行
      const response = await savePlantHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(409);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'DATABASE_ERROR',
          message: '植物の保存に失敗しました',
          details: 'Conflict'
        }
      });
    });

    it('予期しないエラーの場合は500エラー', async () => {
      // ENOTFOUND・ECONNREFUSED・409のいずれにも当たらない未分類のエラー。
      // こういったエラーはcatch節のどの分岐にも一致せず、createInternalError
      // のフォールバックに落ちる
      cosmosBackend.forcedCreateError = new Error('Unexpected failure');

      // リクエストの作成
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/save?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        json: jest.fn().mockResolvedValue({
          name: 'テスト植物',
          characteristics: '特徴',
          confidence: 80.0,
          imagePath: `${TEST_IMAGE_BASE_URL}/test.jpg`
        })
      } as any as HttpRequest;

      // 実行
      const response = await savePlantHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(500);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: '植物の保存に失敗しました',
          details: 'Unexpected failure'
        }
      });
    });
  });
});
