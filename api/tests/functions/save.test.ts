import { HttpRequest, InvocationContext } from '@azure/functions';
import { savePlantHandler } from '../../src/functions/save';
import { Plant } from '../../src/types/plant';
import { CosmosClient, Database, Container } from '@azure/cosmos';

// 外部依存のみモック
jest.mock('@azure/cosmos');
const MockedCosmosClient = CosmosClient as jest.MockedClass<typeof CosmosClient>;

// UUID生成のモック
jest.mock('uuid', () => ({
  v4: jest.fn(() => '123e4567-e89b-12d3-a456-426614174000')
}));

// StorageService.isValidImagePath() が有効と判定するために必要な自ストレージ設定。
// tests/setup.ts のグローバル値と偶然一致させるのではなく、このファイル内で
// 完結させる（beforeEach で process.env に設定する）
const TEST_STORAGE_CONNECTION_STRING = 'DefaultEndpointsProtocol=https;AccountName=test;AccountKey=testkey==;EndpointSuffix=core.windows.net';
const TEST_STORAGE_CONTAINER_NAME = 'test-images';
const TEST_TEMP_CONTAINER_NAME = 'test-temp';
const TEST_IMAGE_BASE_URL = `https://test.blob.core.windows.net/${TEST_STORAGE_CONTAINER_NAME}`;
const TEST_TEMP_BASE_URL = `https://test.blob.core.windows.net/${TEST_TEMP_CONTAINER_NAME}`;

describe('植物保存API', () => {
  let mockContext: InvocationContext;
  let mockClient: jest.Mocked<CosmosClient>;
  let mockDatabase: jest.Mocked<Database>;
  let mockContainer: jest.Mocked<Container>;
  let mockItems: any;
  let mockItem: any;

  beforeEach(() => {
    // InvocationContextのモック
    mockContext = {
      log: Object.assign(jest.fn(), { error: jest.fn() }),
      error: jest.fn()
    } as any;

    // Cosmos DB SDKのモック
    mockItems = {
      query: jest.fn(),
      create: jest.fn()
    };

    mockItem = {
      read: jest.fn()
    };

    mockContainer = {
      items: mockItems,
      item: jest.fn().mockReturnValue(mockItem)
    } as any;

    mockDatabase = {
      container: jest.fn().mockReturnValue(mockContainer)
    } as any;

    mockClient = {
      database: jest.fn().mockReturnValue(mockDatabase)
    } as any;

    MockedCosmosClient.mockImplementation(() => mockClient);

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
      // 重複チェックで既存植物なしのモック
      const mockQuery = {
        fetchAll: jest.fn().mockResolvedValue({ resources: [] })
      };
      mockItems.query.mockReturnValue(mockQuery);

      // 植物作成成功のモック
      const mockCreatedPlant: Plant = {
        id: '123e4567-e89b-12d3-a456-426614174000',
        name: '桜',
        scientificName: 'Prunus serrulata',
        familyName: 'バラ科',
        description: '日本を代表する花木で、春に美しい花を咲かせる。',
        characteristics: '春に美しいピンクの花を咲かせる',
        confidence: 95.5,
        imagePath: `${TEST_IMAGE_BASE_URL}/sakura.jpg`,
        createdAt: '2024-01-15T10:30:00Z',
        updatedAt: '2024-01-15T10:30:00Z'
      };

      mockItems.create.mockResolvedValue({ resource: mockCreatedPlant });

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

      // 検証
      expect(response.status).toBe(201);
      expect(response.jsonBody).toEqual({
        success: true,
        data: {
          plant: mockCreatedPlant
        }
      });

      // 植物作成が呼ばれることを確認（重複チェックはない）

      // 植物作成が呼ばれることを確認
      expect(mockItems.create).toHaveBeenCalledWith(
        expect.objectContaining({
          id: '123e4567-e89b-12d3-a456-426614174000',
          name: '桜',
          scientificName: 'Prunus serrulata',
          familyName: 'バラ科',
          description: '日本を代表する花木で、春に美しい花を咲かせる。',
          characteristics: '春に美しいピンクの花を咲かせる',
          confidence: 95.5,
          imagePath: `${TEST_IMAGE_BASE_URL}/sakura.jpg`,
          createdAt: expect.any(String),
          updatedAt: expect.any(String)
        })
      );
    });

    it('最小限のフィールドで植物を保存できる', async () => {
      // 重複チェックで既存植物なしのモック
      const mockQuery = {
        fetchAll: jest.fn().mockResolvedValue({ resources: [] })
      };
      mockItems.query.mockReturnValue(mockQuery);

      // 植物作成成功のモック
      const mockCreatedPlant: Plant = {
        id: '123e4567-e89b-12d3-a456-426614174000',
        name: 'テスト植物',
        characteristics: '基本的な特徴',
        confidence: 80.0,
        imagePath: `${TEST_IMAGE_BASE_URL}/test.jpg`,
        createdAt: '2024-01-15T10:30:00Z',
        updatedAt: '2024-01-15T10:30:00Z'
      };

      mockItems.create.mockResolvedValue({ resource: mockCreatedPlant });

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
      expect(mockItems.create).not.toHaveBeenCalled();
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
      expect(mockItems.create).not.toHaveBeenCalled();
    });

    it('信頼度が範囲外の場合は400エラー', async () => {
      // リクエストの作成（信頼度が範囲外）
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/save?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        json: jest.fn().mockResolvedValue({
          name: 'テスト植物',
          characteristics: '特徴',
          confidence: 150.0, // 範囲外
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
      expect(mockItems.create).not.toHaveBeenCalled();
    });

    // 重複チェックは別途実装されるcheckDuplicate APIで行うため、ここではテストしない

    it('同じimagePathを持つ植物が既に保存されている場合は409エラー', async () => {
      // 既存植物が1件存在する状態（同じimagePathを持つ）
      const existingPlant: Plant = {
        id: 'existing-id-0000-0000-000000000000',
        name: '既存の桜',
        characteristics: '既存の特徴',
        confidence: 90.0,
        imagePath: `${TEST_IMAGE_BASE_URL}/duplicate.jpg`,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z'
      };
      const mockQuery = {
        fetchAll: jest.fn().mockResolvedValue({ resources: [existingPlant] })
      };
      mockItems.query.mockReturnValue(mockQuery);

      // 植物作成成功のモック（重複チェックが機能していない場合、
      // そのまま保存が成功して201が返ることを明確に判別するため設定する）
      mockItems.create.mockResolvedValue({
        resource: {
          id: '123e4567-e89b-12d3-a456-426614174000',
          name: 'テスト植物',
          characteristics: '特徴',
          confidence: 80.0,
          imagePath: `${TEST_IMAGE_BASE_URL}/duplicate.jpg`,
          createdAt: '2024-01-15T10:30:00Z',
          updatedAt: '2024-01-15T10:30:00Z'
        }
      });

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
    });

    it('画像パスが自ストレージアカウント以外のホストを指す場合は400エラー', async () => {
      // 植物作成成功のモック（バリデーションが機能していない場合に
      // 保存まで進んでしまうことを明確に判別するため設定する）
      mockItems.create.mockResolvedValue({
        resource: {
          id: '123e4567-e89b-12d3-a456-426614174000',
          name: 'テスト植物',
          characteristics: '特徴',
          confidence: 80.0,
          imagePath: 'https://example.com/test-images/123e4567-e89b-12d3-a456-426614174000.jpg',
          createdAt: '2024-01-15T10:30:00Z',
          updatedAt: '2024-01-15T10:30:00Z'
        }
      });

      // リクエストの作成（imagePathが自アカウント以外のホストを指す。
      // URLとしては正しくパースできるが、他レコードのBlobを指し得る。
      // コンテナ名はあえて永続コンテナ（test-images）と一致させている。
      // 一致しない値（例: foo）だとコンテナ名の不一致だけで400になり、
      // ホスト検証を削除してもこのテストは落ちなくなる）
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
    });

    it('画像パスが自ストレージアカウントの一時コンテナを指す場合は400エラー', async () => {
      // 植物作成成功のモック（バリデーションが機能していない場合に
      // 保存まで進んでしまうことを明確に判別するため設定する）
      mockItems.create.mockResolvedValue({
        resource: {
          id: '123e4567-e89b-12d3-a456-426614174000',
          name: 'テスト植物',
          characteristics: '特徴',
          confidence: 80.0,
          imagePath: `${TEST_TEMP_BASE_URL}/123e4567-e89b-12d3-a456-426614174000.jpg`,
          createdAt: '2024-01-15T10:30:00Z',
          updatedAt: '2024-01-15T10:30:00Z'
        }
      });

      // リクエストの作成（imagePathは自アカウントのホストだが、
      // 永続コンテナ（test-images）ではなく一時コンテナ（test-temp）を指す）
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/save?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        json: jest.fn().mockResolvedValue({
          name: 'テスト植物',
          characteristics: '特徴',
          confidence: 80.0,
          imagePath: `${TEST_TEMP_BASE_URL}/123e4567-e89b-12d3-a456-426614174000.jpg`
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
    });

    it('画像パスが自ストレージアカウントの永続コンテナを指すが中間に余分なセグメントを含む場合は400エラー', async () => {
      // 植物作成成功のモック（バリデーションが機能していない場合に
      // 保存まで進んでしまうことを明確に判別するため設定する）
      mockItems.create.mockResolvedValue({
        resource: {
          id: '123e4567-e89b-12d3-a456-426614174000',
          name: 'テスト植物',
          characteristics: '特徴',
          confidence: 80.0,
          imagePath: `${TEST_IMAGE_BASE_URL}/x/123e4567-e89b-12d3-a456-426614174000.jpg`,
          createdAt: '2024-01-15T10:30:00Z',
          updatedAt: '2024-01-15T10:30:00Z'
        }
      });

      // リクエストの作成（imagePathは自アカウントのホストかつ永続コンテナ（test-images）
      // を指すが、コンテナ名とBlob名の間に余分なセグメント（x）を挟んでいる。
      // アップロードAPIが返す形は常に「/コンテナ名/Blob名」の2セグメントなので、
      // この形は存在しないBlobを指す壊れた参照になる）
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/save?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        json: jest.fn().mockResolvedValue({
          name: 'テスト植物',
          characteristics: '特徴',
          confidence: 80.0,
          imagePath: `${TEST_IMAGE_BASE_URL}/x/123e4567-e89b-12d3-a456-426614174000.jpg`
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
    });

    it('画像パスがコンテナまでしか指していない場合は400エラー', async () => {
      // 植物作成成功のモック（バリデーションが機能していない場合に
      // 保存まで進んでしまうことを明確に判別するため設定する）
      mockItems.create.mockResolvedValue({
        resource: {
          id: '123e4567-e89b-12d3-a456-426614174000',
          name: 'テスト植物',
          characteristics: '特徴',
          confidence: 80.0,
          imagePath: `${TEST_IMAGE_BASE_URL}/`,
          createdAt: '2024-01-15T10:30:00Z',
          updatedAt: '2024-01-15T10:30:00Z'
        }
      });

      // リクエストの作成（imagePathは自アカウントのホストかつ永続コンテナ（test-images）
      // を指すが、末尾がスラッシュでBlob名のセグメントが空。
      // 空文字列のBlob名を許すと、Blobを指さないURLが保存されてしまう）
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/save?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        json: jest.fn().mockResolvedValue({
          name: 'テスト植物',
          characteristics: '特徴',
          confidence: 80.0,
          imagePath: `${TEST_IMAGE_BASE_URL}/`
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
    });

    it('画像パスのスキームがhttpsでない場合は400エラー', async () => {
      // 植物作成成功のモック（バリデーションが機能していない場合に
      // 保存まで進んでしまうことを明確に判別するため設定する）
      mockItems.create.mockResolvedValue({
        resource: {
          id: '123e4567-e89b-12d3-a456-426614174000',
          name: 'テスト植物',
          characteristics: '特徴',
          confidence: 80.0,
          imagePath: `http://test.blob.core.windows.net/${TEST_STORAGE_CONTAINER_NAME}/123e4567-e89b-12d3-a456-426614174000.jpg`,
          createdAt: '2024-01-15T10:30:00Z',
          updatedAt: '2024-01-15T10:30:00Z'
        }
      });

      // リクエストの作成（imagePathはホストと永続コンテナの形は正当だが、
      // スキームがhttpsでない。ホストとパスの一致だけを見る実装では
      // スキームを素通りさせてしまう）
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/save?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        json: jest.fn().mockResolvedValue({
          name: 'テスト植物',
          characteristics: '特徴',
          confidence: 80.0,
          imagePath: `http://test.blob.core.windows.net/${TEST_STORAGE_CONTAINER_NAME}/123e4567-e89b-12d3-a456-426614174000.jpg`
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
    beforeEach(() => {
      // save は保存前に imagePath の重複を確認するため、
      // 重複なしを返すクエリ結果が必要（これが無いと重複チェックの時点で落ちる）
      mockItems.query.mockReturnValue({
        fetchAll: jest.fn().mockResolvedValue({ resources: [] })
      });
    });

    it('DB接続エラーの場合は503エラー', async () => {
      // DB接続エラーのモック
      const connectionError = new Error('ENOTFOUND');
      (connectionError as any).code = 'ENOTFOUND';
      mockItems.create.mockRejectedValue(connectionError);

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
      mockItems.create.mockRejectedValue(conflictError);

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
      // 予期しないエラーのモック（環境変数不足など）
      delete process.env.COSMOS_DB_ENDPOINT;

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
          details: expect.any(String)
        }
      });
    });
  });
});