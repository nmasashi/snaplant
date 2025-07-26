import { OpenAIVisionService } from '../../src/services/openAIVisionService';

// 外部依存のみモック
jest.mock('openai');

const MockedOpenAI = jest.requireMock('openai');

describe('OpenAIVisionService', () => {
  let service: OpenAIVisionService;
  let mockOpenAI: any;

  beforeEach(() => {
    // OpenAI SDKのモック設定
    mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn()
        }
      }
    };
    if (MockedOpenAI && typeof MockedOpenAI.mockImplementation === 'function') {
      MockedOpenAI.mockImplementation(() => mockOpenAI);
    }

    // 環境変数設定
    process.env.OPENAI_API_KEY = 'test-api-key';
    process.env.AZURE_OPENAI_ENDPOINT = undefined; // OpenAI APIを使用

    service = new OpenAIVisionService();
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete process.env.OPENAI_API_KEY;
    delete process.env.AZURE_OPENAI_ENDPOINT;
    delete process.env.AZURE_OPENAI_API_KEY;
  });

  describe('identifyPlant', () => {
    it('植物識別が成功する場合、正しい結果を返す', async () => {
      // 正常なOpenAI応答のモック（LLMAnalysisResult形式）
      const validLLMResponse = {
        isPlant: true,
        confidence: 95.5,
        reason: '画像に美しい桜の花が写っており、植物と判定しました',
        plantAnalysis: {
          candidates: [
            {
              name: '桜',
              scientificName: 'Prunus serrulata',
              familyName: 'バラ科',
              description: '日本を代表する花木',
              characteristics: '春に美しいピンクの花を咲かせる',
              confidence: 95.5
            }
          ]
        }
      };

      const expectedResult = {
        isPlant: true,
        confidence: 95.5,
        reason: '画像に美しい桜の花が写っており、植物と判定しました',
        candidates: [
          {
            name: '桜',
            scientificName: 'Prunus serrulata',
            familyName: 'バラ科',
            description: '日本を代表する花木',
            characteristics: '春に美しいピンクの花を咲かせる',
            confidence: 95.5
          }
        ]
      };

      mockOpenAI.chat.completions.create.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify(validLLMResponse)
          }
        }]
      });

      const result = await service.identifyPlant('https://example.com/image.jpg');

      expect(result).toEqual(expectedResult);
      expect(mockOpenAI.chat.completions.create).toHaveBeenCalledWith({
        model: 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: expect.stringContaining('この画像を専門的に分析して')
              },
              {
                type: 'image_url',
                image_url: {
                  url: 'https://example.com/image.jpg',
                  detail: 'low'
                }
              }
            ]
          }
        ],
        max_tokens: 1000,
        temperature: 0.1,
        response_format: { type: 'json_object' }
      });
    });

    it('植物でない場合、isPlant: falseを返す', async () => {
      const notPlantLLMResponse = {
        isPlant: false,
        confidence: 15.0,
        reason: '画像には猫が写っており、植物は確認できませんでした',
        plantAnalysis: null
      };

      const expectedResult = {
        isPlant: false,
        confidence: 15.0,
        reason: '画像には猫が写っており、植物は確認できませんでした',
        candidates: []
      };

      mockOpenAI.chat.completions.create.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify(notPlantLLMResponse)
          }
        }]
      });

      const result = await service.identifyPlant('https://example.com/cat.jpg');

      expect(result).toEqual(expectedResult);
    });

    it('OpenAI APIエラーの場合、エラーをスローする', async () => {
      const apiError = new Error('OpenAI API error');
      mockOpenAI.chat.completions.create.mockRejectedValue(apiError);

      await expect(service.identifyPlant('https://example.com/image.jpg'))
        .rejects.toThrow('植物識別に失敗しました: OpenAI API error');
    });

    it('不正なJSON応答の場合、エラーをスローする', async () => {
      mockOpenAI.chat.completions.create.mockResolvedValue({
        choices: [{
          message: {
            content: 'invalid json response'
          }
        }]
      });

      await expect(service.identifyPlant('https://example.com/image.jpg'))
        .rejects.toThrow('植物識別に失敗しました');
    });
  });

  describe('validateImage', () => {
    it('有効な画像URLの場合、trueを返す', async () => {
      const result = await service.validateImage('https://example.com/valid-image.jpg');

      expect(result).toBe(true);
    });

    it('無効な画像URLの場合、falseを返す', async () => {
      const result = await service.validateImage('invalid-url');

      expect(result).toBe(false);
    });

    it('空文字列の場合、falseを返す', async () => {
      const result = await service.validateImage('');

      expect(result).toBe(false);
    });
  });

  describe('validateAnalysisResult - 内部バリデーションロジック', () => {
    it('完全な植物データの場合、バリデーションを通過する', () => {
      const validResult = {
        isPlant: true,
        confidence: 95.5,
        reason: '画像に桜の花が写っており、植物と判定しました',
        plantAnalysis: {
          candidates: [
            {
              name: '桜',
              scientificName: 'Prunus serrulata',
              familyName: 'バラ科',
              description: '日本を代表する花木',
              characteristics: '春に美しいピンクの花を咲かせる',
              confidence: 95.5
            }
          ]
        }
      };

      // privateメソッドへのアクセス（テスト用）
      const validateMethod = (service as any).validateAnalysisResult.bind(service);
      expect(() => validateMethod(validResult)).not.toThrow();
    });

    it('必須フィールドが不足している場合、エラーをスローする', () => {
      const invalidResult = {
        isPlant: true
        // confidence が不足
        // reason が不足
      };

      const validateMethod = (service as any).validateAnalysisResult.bind(service);
      expect(() => validateMethod(invalidResult)).toThrow('confidenceが0-100の範囲の数値ではありません');
    });

    it('候補の信頼度が数値でない場合、エラーをスローする', () => {
      const invalidResult = {
        isPlant: true,
        confidence: 95.5,
        reason: 'テスト',
        plantAnalysis: {
          candidates: [
            {
              name: '桜',
              scientificName: 'Prunus serrulata',
              familyName: 'バラ科',
              characteristics: '春に美しいピンクの花を咲かせる',
              confidence: 'invalid' // 数値ではない
            }
          ]
        }
      };

      const validateMethod = (service as any).validateAnalysisResult.bind(service);
      expect(() => validateMethod(invalidResult)).toThrow('候補の信頼度が数値ではありません');
    });

    it('植物でない場合、候補が空でもバリデーションを通過する', () => {
      const validNotPlantResult = {
        isPlant: false,
        confidence: 10.0,
        reason: '植物は確認できませんでした'
      };

      const validateMethod = (service as any).validateAnalysisResult.bind(service);
      expect(() => validateMethod(validNotPlantResult)).not.toThrow();
    });
  });

  describe('Azure OpenAI設定', () => {
    beforeEach(() => {
      // Azure OpenAI設定
      process.env.AZURE_OPENAI_ENDPOINT = 'https://test.openai.azure.com/';
      process.env.AZURE_OPENAI_API_KEY = 'azure-api-key';
      delete process.env.OPENAI_API_KEY;
    });

    it('Azure OpenAI設定時、正しいクライアントが使用される', async () => {
      // Azure OpenAI用のモック設定
      const mockAzureOpenAI = {
        chat: {
          completions: {
            create: jest.fn().mockResolvedValue({
              choices: [{
                message: {
                  content: JSON.stringify({
                    isPlant: true,
                    confidence: 90.0,
                    reason: 'テスト用の植物です',
                    plantAnalysis: {
                      candidates: [
                        {
                          name: 'テスト植物',
                          scientificName: 'Test Plant',
                          familyName: 'テスト科',
                          characteristics: 'テスト特徴',
                          confidence: 90.0
                        }
                      ]
                    }
                  })
                }
              }]
            })
          }
        }
      };

      if (MockedOpenAI && typeof MockedOpenAI.mockImplementation === 'function') {
        MockedOpenAI.mockImplementation(() => mockAzureOpenAI);
      }

      // Azure設定でサービスを再初期化
      service = new OpenAIVisionService();

      const result = await service.identifyPlant('https://example.com/image.jpg');

      expect(result.isPlant).toBe(true);
      expect(mockAzureOpenAI.chat.completions.create).toHaveBeenCalled();
    });
  });

  describe('エラーハンドリングの詳細テスト', () => {
    it('空のレスポンスの場合、適切なエラーメッセージを返す', async () => {
      mockOpenAI.chat.completions.create.mockResolvedValue({
        choices: []
      });

      await expect(service.identifyPlant('https://example.com/image.jpg'))
        .rejects.toThrow('植物識別に失敗しました');
    });

    it('contentがnullの場合、適切なエラーメッセージを返す', async () => {
      mockOpenAI.chat.completions.create.mockResolvedValue({
        choices: [{
          message: {
            content: null
          }
        }]
      });

      await expect(service.identifyPlant('https://example.com/image.jpg'))
        .rejects.toThrow('植物識別に失敗しました');
    });

    it('ネットワークエラーの場合、適切なエラーメッセージを返す', async () => {
      const networkError = new Error('ENOTFOUND');
      (networkError as any).code = 'ENOTFOUND';
      mockOpenAI.chat.completions.create.mockRejectedValue(networkError);

      await expect(service.identifyPlant('https://example.com/image.jpg'))
        .rejects.toThrow('植物識別に失敗しました: ENOTFOUND');
    });
  });
});