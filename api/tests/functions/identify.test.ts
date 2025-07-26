import { HttpRequest, InvocationContext } from '@azure/functions';
import { identifyPlantHandler } from '../../src/functions/identify';
import { PlantCandidate } from '../../src/types/plant';

// 外部依存のみモック
jest.mock('openai');
const MockedOpenAI = jest.requireMock('openai');

describe('植物識別API', () => {
  let mockContext: InvocationContext;
  let mockChatCompletions: any;

  beforeEach(() => {
    // InvocationContextのモック
    mockContext = {
      log: Object.assign(jest.fn(), { error: jest.fn() }),
      error: jest.fn()
    } as any;

    // OpenAI APIのモック
    mockChatCompletions = {
      create: jest.fn()
    };

    const mockClient = {
      chat: {
        completions: mockChatCompletions
      }
    };

    if (MockedOpenAI && typeof MockedOpenAI.mockImplementation === 'function') {
      MockedOpenAI.mockImplementation(() => mockClient as any);
    }
    
    // 環境変数設定
    process.env.OPENAI_API_KEY = 'test-key';
    delete process.env.AZURE_OPENAI_ENDPOINT;
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete process.env.OPENAI_API_KEY;
  });

  describe('正常系', () => {
    it('植物識別を正常に実行できる', async () => {
      // テストデータ
      const mockCandidates: PlantCandidate[] = [
        {
          name: '桜',
          scientificName: 'Prunus serrulata',
          familyName: 'バラ科',
          description: '日本を代表する花木で、春に美しい花を咲かせる。',
          characteristics: '春に美しいピンクの花を咲かせる',
          confidence: 95.5
        },
        {
          name: '梅',
          scientificName: 'Prunus mume',
          familyName: 'バラ科',
          description: '冬から早春にかけて芳香のある花を咲かせる。',
          characteristics: '冬〜早春に芳香のある花を咲かせる',
          confidence: 89.2
        }
      ];

      // OpenAI APIレスポンスのモック
      const llmResponse = {
        isPlant: true,
        confidence: 95,
        reason: '桜の特徴を検出しました',
        plantAnalysis: {
          candidates: mockCandidates
        }
      };

      mockChatCompletions.create.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify(llmResponse)
          }
        }]
      });

      // リクエストの作成
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/identify?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        json: jest.fn().mockResolvedValue({
          imagePath: 'https://example.com/sakura.jpg'
        })
      } as any as HttpRequest;

      // 実行
      const response = await identifyPlantHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(200);
      expect(response.jsonBody).toEqual({
        success: true,
        data: {
          result: {
            isPlant: true,
            confidence: 95,
            reason: '桜の特徴を検出しました',
            candidates: mockCandidates
          }
        }
      });

      expect(mockChatCompletions.create).toHaveBeenCalledWith({
        model: 'gpt-4o',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: expect.stringContaining('この画像を専門的に分析して') },
            {
              type: 'image_url',
              image_url: {
                url: 'https://example.com/sakura.jpg',
                detail: 'low'
              }
            }
          ]
        }],
        max_tokens: 1000,
        temperature: 0.1,
        response_format: { type: 'json_object' }
      });
    });

    it('植物でない場合も正常に動作する', async () => {
      // OpenAI APIレスポンスのモック（植物でない）
      const llmResponse = {
        isPlant: false,
        confidence: 20,
        reason: '動物の画像のようです'
      };

      mockChatCompletions.create.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify(llmResponse)
          }
        }]
      });

      // リクエストの作成
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/identify?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        json: jest.fn().mockResolvedValue({
          imagePath: 'https://example.com/cat.jpg'
        })
      } as any as HttpRequest;

      // 実行
      const response = await identifyPlantHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(200);
      expect(response.jsonBody).toEqual({
        success: true,
        data: {
          result: {
            isPlant: false,
            confidence: 20,
            reason: '動物の画像のようです',
            candidates: []
          }
        }
      });
    });
  });

  describe('バリデーションエラー', () => {
    it('画像URLが未指定の場合は400エラー', async () => {
      // リクエストの作成（imagePathなし）
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/identify?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        json: jest.fn().mockResolvedValue({})
      } as any as HttpRequest;

      // 実行
      const response = await identifyPlantHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(400);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: '画像URLが指定されていません'
        }
      });
      expect(mockChatCompletions.create).not.toHaveBeenCalled();
    });

    it('無効なURL形式の場合は400エラー', async () => {
      // リクエストの作成（無効なURL）
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/identify?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        json: jest.fn().mockResolvedValue({
          imagePath: 'invalid-url'
        })
      } as any as HttpRequest;

      // 実行
      const response = await identifyPlantHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(400);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: '画像URLの形式が無効です',
          details: '有効なURL形式で指定してください'
        }
      });
      expect(mockChatCompletions.create).not.toHaveBeenCalled();
    });

    it('JSONパースエラーの場合は400エラー', async () => {
      // リクエストの作成（JSONパースエラー）
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/identify?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        json: jest.fn().mockRejectedValue(new SyntaxError('Unexpected token'))
      } as any as HttpRequest;

      // 実行
      const response = await identifyPlantHandler(request, mockContext);

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

  describe('OpenAI APIエラー', () => {
    it('OpenAI APIエラーの場合は502エラー', async () => {
      // OpenAI APIエラーのモック
      const openAIError = new Error('OpenAI API error');
      mockChatCompletions.create.mockRejectedValue(openAIError);

      // リクエストの作成
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/identify?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        json: jest.fn().mockResolvedValue({
          imagePath: 'https://example.com/sakura.jpg'
        })
      } as any as HttpRequest;

      // 実行
      const response = await identifyPlantHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(502);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'AI_SERVICE_ERROR',
          message: '植物識別サービスでエラーが発生しました',
          details: '植物識別に失敗しました: OpenAI API error'
        }
      });
    });

    it('ネットワークエラーの場合は503エラー', async () => {
      // ネットワークエラーのモック
      const networkError = new Error('Network error');
      (networkError as any).code = 'ENOTFOUND';
      mockChatCompletions.create.mockRejectedValue(networkError);

      // リクエストの作成
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/identify?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        json: jest.fn().mockResolvedValue({
          imagePath: 'https://example.com/sakura.jpg'
        })
      } as any as HttpRequest;

      // 実行
      const response = await identifyPlantHandler(request, mockContext);

      // 検証（Service層でエラーメッセージが変更されるため500エラーになる）
      expect(response.status).toBe(500);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: '植物識別処理に失敗しました',
          details: '植物識別に失敗しました: Network error'
        }
      });
    });

    it('予期しないエラーの場合は500エラー', async () => {
      // 予期しないエラーのモック
      const unexpectedError = new Error('Unexpected error');
      mockChatCompletions.create.mockRejectedValue(unexpectedError);

      // リクエストの作成
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/identify?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        json: jest.fn().mockResolvedValue({
          imagePath: 'https://example.com/sakura.jpg'
        })
      } as any as HttpRequest;

      // 実行
      const response = await identifyPlantHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(500);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: '植物識別処理に失敗しました',
          details: '植物識別に失敗しました: Unexpected error'
        }
      });
    });
  });
});