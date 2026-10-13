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
      log: jest.fn()
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

    MockedOpenAI.mockImplementation(() => mockClient as any);


    // 環境変数設定
    process.env.OPENAI_API_KEY = 'test-key';
    delete process.env.AZURE_OPENAI_ENDPOINT;
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete process.env.OPENAI_API_KEY;
    delete process.env.CONTEXT_INFO_MAX_LENGTH;
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

      // OpenAI呼び出しが正しく行われているかの基本的なチェック
      expect(mockChatCompletions.create).toHaveBeenCalledTimes(1);
      
      // 呼び出し内容の詳細チェック
      const callArgs = mockChatCompletions.create.mock.calls[0][0];
      expect(callArgs.messages[0].content[1].image_url.url).toBe('https://example.com/sakura.jpg');
    });

    it('コンテキスト情報ありで植物識別を正常に実行できる', async () => {
      // テストデータ
      const mockCandidates: PlantCandidate[] = [
        {
          name: 'ハクサンイチゲ',
          scientificName: 'Anemone narcissiflora',
          familyName: 'キンポウゲ科',
          description: '高山に自生する多年草',
          characteristics: '白い花を咲かせる高山植物',
          confidence: 97.8
        }
      ];

      // OpenAI APIレスポンスのモック
      const llmResponse = {
        isPlant: true,
        confidence: 97,
        reason: 'コンテキスト情報により高山植物として識別できました',
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

      // リクエストの作成（コンテキスト情報あり）
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/identify?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        json: jest.fn().mockResolvedValue({
          imagePath: 'https://example.com/mountain-flower.jpg',
          contextInfo: '白馬岳の標高2500m、高山帯の岩場'
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
            confidence: 97,
            reason: 'コンテキスト情報により高山植物として識別できました',
            candidates: mockCandidates
          }
        }
      });

      // OpenAI呼び出しが正しく行われているかの基本的なチェック
      expect(mockChatCompletions.create).toHaveBeenCalledTimes(1);
      
      // 呼び出し内容の詳細チェック
      // 固定ラベル「撮影時の環境やコンテキスト情報: 」はプロンプトの文言そのもので、
      // それはテストで固定しない（プロンプトの文言は実装の詳細）。ここで見るのは利用者が入力した
      // 値がプロンプトに届いていることだけなので、値の部分だけを検証する
      const callArgs = mockChatCompletions.create.mock.calls[0][0];
      expect(callArgs.messages[0].content[0].text).toContain('白馬岳の標高2500m、高山帯の岩場');
      expect(callArgs.messages[0].content[1].image_url.url).toBe('https://example.com/mountain-flower.jpg');
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

    it('contextInfoが500文字の場合は正常に処理される', async () => {
      // テストデータ
      const mockCandidates: PlantCandidate[] = [
        {
          name: '桜',
          scientificName: 'Prunus serrulata',
          familyName: 'バラ科',
          description: '日本を代表する花木で、春に美しい花を咲かせる。',
          characteristics: '春に美しいピンクの花を咲かせる',
          confidence: 95.5
        }
      ];

      // OpenAI APIレスポンスのモック
      mockChatCompletions.create.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              isPlant: true,
              confidence: 95,
              reason: '桜の特徴を検出しました',
              plantAnalysis: { candidates: mockCandidates }
            })
          }
        }]
      });

      // リクエストの作成（contextInfoが500文字、他のフィールドは正当な値）
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/identify?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        json: jest.fn().mockResolvedValue({
          imagePath: 'https://example.com/sakura.jpg',
          contextInfo: 'あ'.repeat(500)
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

    it('contextInfoが501文字の場合は400エラー', async () => {
      // OpenAI APIレスポンスのモック（バリデーションで止まるはずだが、
      // 意図せず到達しても別の原因で落ちないようにしておく）
      mockChatCompletions.create.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              isPlant: true,
              confidence: 90,
              reason: 'テスト',
              plantAnalysis: { candidates: [] }
            })
          }
        }]
      });

      // リクエストの作成（contextInfoが501文字、他のフィールドは正当な値）
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/identify?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        json: jest.fn().mockResolvedValue({
          imagePath: 'https://example.com/sakura.jpg',
          contextInfo: 'あ'.repeat(501)
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
          message: '補足情報は500文字以内で指定してください'
        }
      });
    });

    it('CONTEXT_INFO_MAX_LENGTHが数値でない文字列の場合でも、501文字のcontextInfoは拒否される', async () => {
      // parseInt('invalid')はNaNになり、`501 > NaN`はfalseなので、
      // 対策前は上限が消えて素通りしてしまう（contextInfoだけがfail openになる非対称）。
      //
      // constants/validation.ts の定数はモジュール読み込み時に一度だけ評価されるため、
      // このファイル先頭で静的importしたidentifyPlantHandlerは既にデフォルト値(500)で
      // 固定されている。環境変数を変えてもそのままでは反映されないため、
      // jest.resetModules()してからidentify.tsを読み込み直す
      process.env.CONTEXT_INFO_MAX_LENGTH = 'invalid';
      jest.resetModules();

      // resetModules()でモジュールレジストリが空になると、openaiのモックも
      // beforeEachで配線したMockedOpenAIとは別の新しいインスタンスになる。
      // 配線し直さないと、バリデーションを素通りした後にOpenAI呼び出しが
      // 未配線のまま失敗し、「素通りしたので200で返る」という本来確認したい
      // 失敗理由とは別の理由（OpenAIモック未配線の500エラー）でテストが落ちる
      const FreshOpenAI = require('openai');
      const freshChatCompletions = {
        create: jest.fn().mockResolvedValue({
          choices: [{
            message: {
              content: JSON.stringify({
                isPlant: true,
                confidence: 90,
                reason: 'テスト',
                plantAnalysis: { candidates: [] }
              })
            }
          }]
        })
      };
      FreshOpenAI.mockImplementation(() => ({ chat: { completions: freshChatCompletions } }));

      const { identifyPlantHandler: handlerWithInvalidEnv } = require('../../src/functions/identify');

      // リクエストの作成（contextInfoが501文字、他のフィールドは正当な値）
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/identify?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        json: jest.fn().mockResolvedValue({
          imagePath: 'https://example.com/sakura.jpg',
          contextInfo: 'あ'.repeat(501)
        })
      } as any as HttpRequest;

      // 実行
      const response = await handlerWithInvalidEnv(request, mockContext);

      // 検証
      expect(response.status).toBe(400);
    });

    it('contextInfoに文字列ではない配列を指定した場合は400エラー', async () => {
      // OpenAI APIレスポンスのモック（バリデーションで止まるはずだが、
      // 意図せず到達しても別の原因で落ちないようにしておく）
      mockChatCompletions.create.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              isPlant: true,
              confidence: 90,
              reason: 'テスト',
              plantAnalysis: { candidates: [] }
            })
          }
        }]
      });

      // リクエストの作成（contextInfoに配列を指定。他のフィールドは正当な値）
      //
      // 配列を選ぶ理由: 現在の実装は requestBody.contextInfo.length を
      // そのまま500と比較している。文字列なら.lengthは文字数になるが、
      // 配列の.lengthは要素数になる。ここでは要素1つが501文字を超える
      // 文字列でも、配列の要素数(2)は500を超えないため長さ検証を素通りする。
      // request.json()の戻り値はIdentifyRequest型として扱われるが、
      // 実際のJSONボディは型で保証されないため as any で非文字列を再現する。
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/identify?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        json: jest.fn().mockResolvedValue({
          imagePath: 'https://example.com/sakura.jpg',
          contextInfo: ['あ'.repeat(600), 'い'.repeat(600)] as any
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
          message: '補足情報は文字列で指定してください'
        }
      });
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
    it('AIサービスがエラー応答（HTTP 500）を返した場合は502エラー', async () => {
      // 実SDKのAPIErrorのmessageは `${status} ${msg}` の形。メッセージの文字列に頼らず、
      // AIの呼び出しで失敗したことから502に分類されるので、実SDKの形を再現する
      const apiError = Object.assign(
        new Error('500 The server had an error while processing your request.'),
        { name: 'InternalServerError', status: 500 }
      );
      mockChatCompletions.create.mockRejectedValue(apiError);

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

      // 検証（detailsは契約外なので固定しない）
      expect(response.status).toBe(502);
      expect(response.jsonBody).toMatchObject({
        success: false,
        error: {
          code: 'AI_SERVICE_ERROR',
          message: '植物識別サービスでエラーが発生しました'
        }
      });
    });

    it('AIの呼び出しが分類できない理由で失敗した場合も502エラー', async () => {
      // 分類できないエラーでも、AIの呼び出しで起きた失敗なので502になる
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

      // 検証（detailsは契約外なので固定しない）
      expect(response.status).toBe(502);
      expect(response.jsonBody).toMatchObject({
        success: false,
        error: {
          code: 'AI_SERVICE_ERROR',
          message: '植物識別サービスでエラーが発生しました'
        }
      });
    });

    it('AIの応答が空（choicesが空配列）の場合も502エラー', async () => {
      // 応答が成功しても choices が空だとAIサービスの中でTypeErrorになる。
      // メッセージの文字列ではなく、AIの処理中に起きた失敗として502に分類される
      mockChatCompletions.create.mockResolvedValue({ choices: [] });

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

      // 検証（detailsは契約外なので固定しない）
      expect(response.status).toBe(502);
      expect(response.jsonBody).toMatchObject({
        success: false,
        error: {
          code: 'AI_SERVICE_ERROR',
          message: '植物識別サービスでエラーが発生しました'
        }
      });
    });

    it('AIの応答の候補の信頼度が範囲外（150）の場合は不正な応答として502エラー', async () => {
      // JSONとしては正しいが、候補のconfidenceが仕様の0〜100を超えている
      const llmResponse = {
        isPlant: true,
        confidence: 95,
        reason: '桜の特徴を検出しました',
        plantAnalysis: {
          candidates: [
            {
              name: '桜',
              scientificName: 'Prunus serrulata',
              familyName: 'バラ科',
              description: '日本を代表する花木で、春に美しい花を咲かせる。',
              characteristics: '春に美しいピンクの花を咲かせる',
              confidence: 150
            }
          ]
        }
      };
      mockChatCompletions.create.mockResolvedValue({
        choices: [{ message: { content: JSON.stringify(llmResponse) } }]
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

      // 検証（detailsは契約外なので固定しない）
      expect(response.status).toBe(502);
      expect(response.jsonBody).toMatchObject({
        success: false,
        error: {
          code: 'AI_SERVICE_ERROR',
          message: '植物識別サービスでエラーが発生しました'
        }
      });
    });

    it.each([
      ['ENOTFOUND', 'getaddrinfo ENOTFOUND example.openai.azure.com'],
      ['ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:443']
    ])('AI識別サービスのホストに接続できない場合（%s）は503エラー', async (errno, sysMessage) => {
      // 実SDK（openai 7.x / Node標準のfetch）の接続エラーは3段のcauseチェーンになる。
      //   APIConnectionError（code無し）→ TypeError 'fetch failed'（code無し）→ Error（code=errno）
      // errnoを持つのは最深部だけで、トップレベルにcodeは付かない。
      // トップレベルにcodeを付けると実SDKが作らない形になるので付けない
      const sysError = Object.assign(new Error(sysMessage), { code: errno });
      const fetchError = Object.assign(new TypeError('fetch failed'), { cause: sysError });
      const connectionError = Object.assign(new Error('Connection error.'), {
        name: 'APIConnectionError',
        cause: fetchError
      });
      mockChatCompletions.create.mockRejectedValue(connectionError);

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

      // 検証（detailsは契約外なので固定しない）
      expect(response.status).toBe(503);
      expect(response.jsonBody).toMatchObject({
        success: false,
        error: {
          code: 'AI_SERVICE_ERROR',
          message: '植物識別サービスに接続できません'
        }
      });
    });
  });

  describe('AI以外の予期しない失敗', () => {
    it('AIとは関係のない箇所で予期しない失敗が起きた場合は500エラー', async () => {
      // ボディの読み取りがSyntaxError以外で失敗する（AIは呼ばれない）
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/plants/identify?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        json: jest.fn().mockRejectedValue(new Error('stream failure'))
      } as any as HttpRequest;

      // 実行
      const response = await identifyPlantHandler(request, mockContext);

      // 検証（detailsは契約外なので固定しない）
      expect(response.status).toBe(500);
      expect(response.jsonBody).toMatchObject({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: '植物識別処理に失敗しました'
        }
      });
    });
  });
});
