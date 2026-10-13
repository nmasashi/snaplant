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
    MockedOpenAI.mockImplementation(() => mockOpenAI);

    // 環境変数設定
    process.env.OPENAI_API_KEY = 'test-api-key';
    // OpenAI APIを使用する。undefined の代入は文字列 "undefined" になるため delete で消す
    delete process.env.AZURE_OPENAI_ENDPOINT;

    service = new OpenAIVisionService();
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete process.env.OPENAI_API_KEY;
    delete process.env.AZURE_OPENAI_ENDPOINT;
    delete process.env.AZURE_OPENAI_API_KEY;
  });

  describe('LLM応答のバリデーション', () => {
    // LLMはStructured Outputsのスキーマに従うはずだが、それでも契約から外れた
    // 応答を返す可能性があるため、公開API（identifyPlant）経由で不正な応答を
    // 拒否することを確認する。privateメソッドを直接叩かず、createのモックが
    // 返すJSON応答を不正な形にして振る舞いを観察する
    it('必須フィールドが不足している場合、エラーをスローする', async () => {
      mockOpenAI.chat.completions.create.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              isPlant: true
              // confidence が不足
              // reason が不足
            })
          }
        }]
      });

      await expect(service.identifyPlant('https://example.com/image.jpg'))
        .rejects.toThrow('confidenceが0-100の範囲の数値ではありません');
    });

    it('候補の信頼度が数値でない場合、エラーをスローする', async () => {
      mockOpenAI.chat.completions.create.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
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
            })
          }
        }]
      });

      await expect(service.identifyPlant('https://example.com/image.jpg'))
        .rejects.toThrow('候補の信頼度が数値ではありません');
    });

    function llmResponseWithCandidateConfidence(confidence: number) {
      return {
        choices: [{
          message: {
            content: JSON.stringify({
              isPlant: true,
              confidence: 95.5,
              reason: 'テスト',
              plantAnalysis: {
                candidates: [
                  {
                    name: '桜',
                    scientificName: 'Prunus serrulata',
                    familyName: 'バラ科',
                    description: '日本を代表する花木',
                    characteristics: '春に美しいピンクの花を咲かせる',
                    confidence
                  }
                ]
              }
            })
          }
        }]
      };
    }

    // 上限側（100 を超える値）は identify.test が固定している。下限側はここだけ
    it('候補の信頼度が負の場合、エラーをスローする', async () => {
      mockOpenAI.chat.completions.create.mockResolvedValue(llmResponseWithCandidateConfidence(-1));

      await expect(service.identifyPlant('https://example.com/image.jpg'))
        .rejects.toThrow('候補の信頼度が0-100の範囲ではありません');
    });

    it.each([0, 100])('候補の信頼度が境界値（%s）の場合、受け入れる', async (confidence) => {
      mockOpenAI.chat.completions.create.mockResolvedValue(llmResponseWithCandidateConfidence(confidence));

      const result = await service.identifyPlant('https://example.com/image.jpg');

      expect(result.candidates[0].confidence).toBe(confidence);
    });
  });

  // 以下は実際に本番で 400 エラーを引き起こしたパラメータの回帰テスト。
  // モックが呼ばれたことだけを確認していたため、これらの不整合を検知できなかった。
  describe('チャット補完リクエストのパラメータ', () => {
    const validResponse = {
      choices: [{
        message: {
          content: JSON.stringify({
            isPlant: true,
            confidence: 90,
            reason: 'テスト',
            plantAnalysis: {
              candidates: [
                { name: 'テスト植物', characteristics: 'テスト特徴', confidence: 90 }
              ]
            }
          })
        }
      }]
    };

    const getRequestBody = () => mockOpenAI.chat.completions.create.mock.calls[0][0];

    beforeEach(async () => {
      mockOpenAI.chat.completions.create.mockResolvedValue(validResponse);
    });

    it('max_tokens ではなく max_completion_tokens を指定する', async () => {
      await service.identifyPlant('https://example.com/image.jpg');

      const body = getRequestBody();
      // max_tokens は新しいモデルでは 400 (Unsupported parameter) になる
      expect(body).not.toHaveProperty('max_tokens');
      expect(typeof body.max_completion_tokens).toBe('number');
      // 推論トークンも同じ枠から消費されるため、出力が途切れない程度の余裕が必要
      expect(body.max_completion_tokens).toBeGreaterThanOrEqual(2000);
    });

    it('temperature を指定しない（デフォルト値のみサポートするモデル向け）', async () => {
      await service.identifyPlant('https://example.com/image.jpg');

      // temperature: 0.1 などを渡すと 400 (Unsupported value) になる
      expect(getRequestBody()).not.toHaveProperty('temperature');
    });

    it('デプロイ名を環境変数から取得する', async () => {
      process.env.AZURE_OPENAI_DEPLOYMENT_NAME = 'test-deployment';

      await service.identifyPlant('https://example.com/image.jpg');

      expect(getRequestBody().model).toBe('test-deployment');
      delete process.env.AZURE_OPENAI_DEPLOYMENT_NAME;
    });

    it('画像をトークン節約設定で渡す', async () => {
      await service.identifyPlant('https://example.com/image.jpg');

      const body = getRequestBody();
      const imageContent = body.messages[0].content.find((c: any) => c.type === 'image_url');
      expect(imageContent.image_url).toEqual({
        url: 'https://example.com/image.jpg',
        detail: 'low'
      });
    });

    it('JSON Schema (strict) で応答の構造を強制する', async () => {
      await service.identifyPlant('https://example.com/image.jpg');

      const responseFormat = getRequestBody().response_format;
      // json_object では形式のみで中身の構造が保証されない
      expect(responseFormat.type).toBe('json_schema');
      expect(responseFormat.json_schema.strict).toBe(true);

      const schema = responseFormat.json_schema.schema;
      expect(schema.additionalProperties).toBe(false);
      expect(schema.required).toEqual(
        expect.arrayContaining(['isPlant', 'confidence', 'reason', 'plantAnalysis'])
      );

      // strict モードでは全プロパティが required に含まれている必要がある
      const candidateSchema = schema.properties.plantAnalysis.properties.candidates.items;
      expect(candidateSchema.required.sort()).toEqual(
        Object.keys(candidateSchema.properties).sort()
      );
      expect(candidateSchema.additionalProperties).toBe(false);

      // 任意項目は null 許容で表現する
      expect(candidateSchema.properties.scientificName.type).toEqual(['string', 'null']);
      expect(schema.properties.plantAnalysis.type).toEqual(['object', 'null']);
    });

    it('スキーマの null 許容項目を undefined に正規化する', async () => {
      mockOpenAI.chat.completions.create.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              isPlant: true,
              confidence: 70,
              reason: '葉の特徴から植物と判定しました',
              plantAnalysis: {
                candidates: [{
                  name: 'サクラ属',
                  scientificName: null,
                  familyName: null,
                  description: null,
                  characteristics: '鋸歯のある葉',
                  confidence: 70
                }]
              }
            })
          }
        }]
      });

      const result = await service.identifyPlant('https://example.com/image.jpg');

      const candidate = result.candidates[0];
      expect(candidate.name).toBe('サクラ属');
      // null がそのまま保存データに流れないこと
      expect(candidate.scientificName).toBeUndefined();
      expect(candidate.familyName).toBeUndefined();
      expect(candidate.description).toBeUndefined();
    });

    it('Azure 設定時、baseURL とデプロイ名・APIバージョンが正しく組み立てられる', async () => {
      process.env.AZURE_OPENAI_ENDPOINT = 'https://test.openai.azure.com';
      process.env.AZURE_OPENAI_API_KEY = 'azure-api-key';
      process.env.AZURE_OPENAI_DEPLOYMENT_NAME = 'test-deployment';
      process.env.AZURE_OPENAI_API_VERSION = '2024-12-01-preview';
      MockedOpenAI.mockClear();

      new OpenAIVisionService();

      const clientOptions = MockedOpenAI.mock.calls[0][0];
      expect(clientOptions.baseURL).toBe(
        'https://test.openai.azure.com/openai/deployments/test-deployment'
      );
      expect(clientOptions.defaultQuery['api-version']).toBe('2024-12-01-preview');
      expect(clientOptions.defaultHeaders['api-key']).toBe('azure-api-key');

      delete process.env.AZURE_OPENAI_DEPLOYMENT_NAME;
      delete process.env.AZURE_OPENAI_API_VERSION;
    });

    it('Azure のエンドポイントが未設定なら、OpenAI 公式 API 向けの設定でクライアントを作る', async () => {
      // tests/setup.ts が Azure の値を設定しているため、デプロイ名も含めて未設定の状態にする
      delete process.env.AZURE_OPENAI_ENDPOINT;
      delete process.env.AZURE_OPENAI_API_KEY;
      delete process.env.AZURE_OPENAI_DEPLOYMENT_NAME;
      process.env.OPENAI_API_KEY = 'openai-api-key';
      MockedOpenAI.mockClear();

      new OpenAIVisionService();

      const clientOptions = MockedOpenAI.mock.calls[0][0];
      expect(clientOptions.apiKey).toBe('openai-api-key');
      expect(clientOptions.baseURL).toBeUndefined();
      expect(clientOptions.defaultQuery).toBeUndefined();
      expect(clientOptions.defaultHeaders).toBeUndefined();
    });
  });
});