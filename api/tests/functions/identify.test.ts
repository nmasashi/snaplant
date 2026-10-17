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

  // 基本のリクエスト（画像URLだけ）と、AI（OpenAI）の応答の差し替え
  const identifyRequest = () => ({
    method: 'POST',
    url: 'https://func-snaplant.azurewebsites.net/api/plants/identify?code=test-key',
    query: new Map([['code', 'test-key']]),
    headers: new Map([['content-type', 'application/json']]),
    json: jest.fn().mockResolvedValue({ imagePath: 'https://example.com/sakura.jpg' })
  } as any as HttpRequest);
  const llmReturns = (body: unknown) => {
    mockChatCompletions.create.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify(body) } }]
    });
  };

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

      // 検証（detailsは契約外なので固定しない）
      expect(response.status).toBe(400);
      expect(response.jsonBody).toMatchObject({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: '画像URLの形式が無効です'
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

      // 検証（detailsは契約外なので固定しない）
      expect(response.status).toBe(400);
      expect(response.jsonBody).toMatchObject({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'リクエストボディの形式が無効です'
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

    it('AI識別サービスのホストに接続できない場合は503エラー', async () => {
      // 接続できない errno の分類は全エンドポイントで同じ規則（utils/errors.ts の UNREACHABLE_ERRNOS）。
      // AI の全 errno を通すのは upload.test.ts（アプリが使う入口）なので、ここは1つ（ENOTFOUND）で、AI の経路が分類につながっていることを見る
      // 実SDK（openai 7.x / Node標準のfetch）の接続エラーは3段のcauseチェーンになる。
      //   APIConnectionError（code無し）→ TypeError 'fetch failed'（code無し）→ Error（code=errno）
      // errnoを持つのは最深部だけで、トップレベルにcodeは付かない。
      // トップレベルにcodeを付けると実SDKが作らない形になるので付けない
      const sysError = Object.assign(new Error('getaddrinfo ENOTFOUND example.openai.azure.com'), {
        code: 'ENOTFOUND'
      });
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

  describe('AIの応答の検証', () => {
    // 06_api_design.md §4.2・§6.2「502 / 503 の振り分けと message」。
    // AI の応答が想定の形を満たさなければ、結果を返さず 502 にする
    // 満たした応答は §4.2 の形（AI が null で返した任意項目はキーごと省略）にして返す
    const candidate = {
      name: '桜',
      scientificName: 'Prunus serrulata',
      familyName: 'バラ科',
      description: '日本を代表する花木',
      characteristics: '春に美しいピンクの花を咲かせる',
      confidence: 95.5
    };
    const plantWith = (candidates: unknown[]) => ({
      isPlant: true,
      confidence: 95.5,
      reason: 'テスト',
      plantAnalysis: { candidates }
    });

    it.each([
      ['植物判定の信頼度が無い', { isPlant: true, reason: 'テスト', plantAnalysis: null }],
      ['植物判定の信頼度が負（-1）の', { isPlant: true, confidence: -1, reason: 'テスト', plantAnalysis: null }],
      ['植物判定の信頼度が100を超える（100.5）', { isPlant: true, confidence: 100.5, reason: 'テスト', plantAnalysis: null }],
      ['植物かどうか（isPlant）が真偽値でない', { isPlant: 'yes', confidence: 95.5, reason: 'テスト', plantAnalysis: null }],
      ['判定理由が無い', { isPlant: true, confidence: 95.5, plantAnalysis: null }],
      ['候補の名前が無い', plantWith([{ ...candidate, name: undefined }])],
      ['候補の特徴が無い', plantWith([{ ...candidate, characteristics: undefined }])],
      ['候補の信頼度が数値でない', plantWith([{ ...candidate, confidence: 'invalid' }])],
      ['候補の信頼度が負（-1）の', plantWith([{ ...candidate, confidence: -1 }])],
      ['候補の信頼度が100を超える（100.5）', plantWith([{ ...candidate, confidence: 100.5 }])],
    ])('AIの応答で%s場合は、不正な応答として502エラー', async (_name, body) => {
      llmReturns(body);

      const response = await identifyPlantHandler(identifyRequest(), mockContext);

      // detailsは契約外なので固定しない
      expect(response.status).toBe(502);
      expect(response.jsonBody).toMatchObject({
        success: false,
        error: {
          code: 'AI_SERVICE_ERROR',
          message: '植物識別サービスでエラーが発生しました'
        }
      });
    });

    it.each([0, 100])('AIの応答の候補の信頼度が境界値（%s）なら受け入れて、そのまま返す', async (confidence) => {
      llmReturns(plantWith([{ ...candidate, confidence }]));

      const response = await identifyPlantHandler(identifyRequest(), mockContext);

      expect(response.status).toBe(200);
      expect(response.jsonBody.data.result.candidates).toEqual([{ ...candidate, confidence }]);
    });

    it('AIが特定できなかった候補の学名・科名・説明は、nullではなくキーごと省略して返す', async () => {
      // 06_api_design.md §4.2。AI は strict モードの制約で「不明」を null で返す
      llmReturns({
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
      });

      const response = await identifyPlantHandler(identifyRequest(), mockContext);

      expect(response.status).toBe(200);
      // JSON にしたときにキーが現れないことを、直列化した結果で見る
      const candidates = JSON.parse(JSON.stringify(response.jsonBody)).data.result.candidates;
      expect(candidates).toEqual([{ name: 'サクラ属', characteristics: '鋸歯のある葉', confidence: 70 }]);
    });
  });

  describe('AI識別サービスへ渡すもの', () => {
    // 06_api_design.md §5.9。管理外の依存へ送るものは外部との契約なので、表の要素を検証する。
    // プロンプトの文言は契約外なので見ない。
    // 以下の要素は、実際に本番で 400 エラーを引き起こしたもの（max_tokens・temperature）を含む
    const ENV_KEYS = [
      'AZURE_OPENAI_ENDPOINT',
      'AZURE_OPENAI_API_KEY',
      'AZURE_OPENAI_DEPLOYMENT_NAME',
      'AZURE_OPENAI_CLASSIFY_DEPLOYMENT_NAME',
      'AZURE_OPENAI_API_VERSION',
      'OPENAI_API_KEY'
    ] as const;
    let savedEnv: Record<string, string | undefined>;

    beforeEach(() => {
      savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
      llmReturns({
        isPlant: true,
        confidence: 90,
        reason: 'テスト',
        plantAnalysis: { candidates: [{ name: 'テスト植物', characteristics: 'テスト特徴', confidence: 90 }] }
      });
    });

    afterEach(() => {
      for (const key of ENV_KEYS) {
        if (savedEnv[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = savedEnv[key];
        }
      }
    });

    it('AI識別サービスへ渡すものは§5.9の要素のとおり（モデル・メッセージ・画像・応答の形・トークン上限・送らないパラメータ）', async () => {
      process.env.AZURE_OPENAI_DEPLOYMENT_NAME = 'test-deployment';

      const response = await identifyPlantHandler(identifyRequest(), mockContext);

      expect(response.status).toBe(200);
      expect(mockChatCompletions.create).toHaveBeenCalledTimes(1);
      const body = mockChatCompletions.create.mock.calls[0][0];

      // モデル
      expect(body.model).toBe('test-deployment');

      // メッセージ: user ロールの1件。テキストと画像の2パート。画像は detail: low
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0].role).toBe('user');
      expect(body.messages[0].content).toHaveLength(2);
      expect(body.messages[0].content).toEqual(expect.arrayContaining([
        { type: 'text', text: expect.any(String) },
        { type: 'image_url', image_url: { url: 'https://example.com/sakura.jpg', detail: 'low' } }
      ]));

      // 応答の形: Structured Outputs（json_schema・strict）。json_object では中身の構造が保証されない
      const responseFormat = body.response_format;
      expect(responseFormat.type).toBe('json_schema');
      expect(responseFormat.json_schema.name).toBe('plant_identification');
      expect(responseFormat.json_schema.strict).toBe(true);
      const schema = responseFormat.json_schema.schema;
      expect(schema.additionalProperties).toBe(false);
      expect(schema.required).toEqual(
        expect.arrayContaining(['isPlant', 'confidence', 'reason', 'plantAnalysis'])
      );
      // strict モードでは全プロパティが required に含まれている必要がある
      const candidateSchema = schema.properties.plantAnalysis.properties.candidates.items;
      expect([...candidateSchema.required].sort()).toEqual(
        ['characteristics', 'confidence', 'description', 'familyName', 'name', 'scientificName']
      );
      expect(Object.keys(candidateSchema.properties).sort()).toEqual([...candidateSchema.required].sort());
      expect(candidateSchema.additionalProperties).toBe(false);
      // 任意項目は null 許容で表現する
      expect(candidateSchema.properties.scientificName.type).toEqual(['string', 'null']);
      expect(schema.properties.plantAnalysis.type).toEqual(['object', 'null']);

      // トークン上限: max_completion_tokens。max_tokens は新しいモデルでは 400 (Unsupported parameter) になる
      expect(body.max_completion_tokens).toBe(4000);
      expect(body).not.toHaveProperty('max_tokens');

      // 送らないパラメータ: temperature（0.1 などを渡すと 400 (Unsupported value) になる）
      expect(body).not.toHaveProperty('temperature');
    });

    it('AZURE_OPENAI_ENDPOINTがあれば、接続先はAzure OpenAI Serviceのデプロイメント（api-versionのクエリとapi-keyヘッダ付き）', async () => {
      process.env.AZURE_OPENAI_ENDPOINT = 'https://test.openai.azure.com';
      process.env.AZURE_OPENAI_API_KEY = 'azure-api-key';
      process.env.AZURE_OPENAI_DEPLOYMENT_NAME = 'test-deployment';
      process.env.AZURE_OPENAI_API_VERSION = '2025-04-01-preview';

      const response = await identifyPlantHandler(identifyRequest(), mockContext);

      expect(response.status).toBe(200);
      const clientOptions = MockedOpenAI.mock.calls[0][0];
      expect(clientOptions.baseURL).toBe('https://test.openai.azure.com/openai/deployments/test-deployment');
      expect(clientOptions.defaultQuery['api-version']).toBe('2025-04-01-preview');
      expect(clientOptions.defaultHeaders['api-key']).toBe('azure-api-key');
    });

    it('Azure OpenAI Serviceの接続先があるのにデプロイ名が未設定なら、AIを呼ばずに500エラー', async () => {
      // 接続先のURLに埋め込むデプロイ名が無いまま既定のモデル名で呼ぶと、接続先とモデルが食い違う。
      // tests/setup.ts が全体に値を入れているので、delete で未設定にする（元に戻すのは afterEach）
      process.env.AZURE_OPENAI_ENDPOINT = 'https://test.openai.azure.com';
      process.env.AZURE_OPENAI_API_KEY = 'azure-api-key';
      delete process.env.AZURE_OPENAI_DEPLOYMENT_NAME;

      const response = await identifyPlantHandler(identifyRequest(), mockContext);

      // detailsは契約外なので固定しない
      expect(response.status).toBe(500);
      expect(response.jsonBody).toMatchObject({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: '植物識別処理に失敗しました'
        }
      });
      expect(mockChatCompletions.create).not.toHaveBeenCalled();
    });

    it('AIのクライアントを作れない設定（APIキーが無い）なら、AIの障害（502）ではなく500エラー', async () => {
      // OpenAI SDK はキーが無いとクライアントのコンストラクタで例外を投げる（openai 7.x の実際の文言）。
      // 何も保存しないことまで見るのは upload.test.ts（同じ規則で、一時保存がある入口）
      MockedOpenAI.mockImplementation(() => {
        throw new Error('Missing credentials. Please pass an `apiKey`, `workloadIdentity`, `adminAPIKey`, or set the `OPENAI_API_KEY` or `OPENAI_ADMIN_KEY` environment variable.');
      });

      const response = await identifyPlantHandler(identifyRequest(), mockContext);

      expect(response.status).toBe(500);
      expect(response.jsonBody).toMatchObject({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: '植物識別処理に失敗しました'
        }
      });
    });

    it('分類用のデプロイ名（旅行アルバム）があっても、植物の識別は今のデプロイに送る', async () => {
      // 分類と識別は同じ OpenAIVisionService を通る。分類用のデプロイを足した日に、識別まで分類用のモデルへ送らないように
      process.env.AZURE_OPENAI_ENDPOINT = 'https://test.openai.azure.com';
      process.env.AZURE_OPENAI_API_KEY = 'azure-api-key';
      process.env.AZURE_OPENAI_DEPLOYMENT_NAME = 'test-deployment';
      process.env.AZURE_OPENAI_CLASSIFY_DEPLOYMENT_NAME = 'classify-deployment';

      const response = await identifyPlantHandler(identifyRequest(), mockContext);

      expect(response.status).toBe(200);
      expect(MockedOpenAI.mock.calls[0][0].baseURL).toBe('https://test.openai.azure.com/openai/deployments/test-deployment');
      expect(mockChatCompletions.create.mock.calls[0][0].model).toBe('test-deployment');
    });

    it('デプロイ名の前後に空白があれば、取り除いたデプロイに送る', async () => {
      // アプリの設定に紛れた空白や改行のまま URL に入れると、Azure の 404 になって AI の障害（502）に見える
      process.env.AZURE_OPENAI_ENDPOINT = 'https://test.openai.azure.com';
      process.env.AZURE_OPENAI_API_KEY = 'azure-api-key';
      process.env.AZURE_OPENAI_DEPLOYMENT_NAME = ' test-deployment\n';

      const response = await identifyPlantHandler(identifyRequest(), mockContext);

      expect(response.status).toBe(200);
      expect(MockedOpenAI.mock.calls[0][0].baseURL).toBe('https://test.openai.azure.com/openai/deployments/test-deployment');
      expect(mockChatCompletions.create.mock.calls[0][0].model).toBe('test-deployment');
    });

    it('Azure OpenAI Serviceの接続先が無く、デプロイ名も未設定なら、既定のモデル（gpt-5.6-luna）を指定する', async () => {
      // tests/setup.ts が全体に値を入れているので、delete で未設定にする（元に戻すのは afterEach）
      delete process.env.AZURE_OPENAI_ENDPOINT;
      delete process.env.AZURE_OPENAI_DEPLOYMENT_NAME;
      process.env.OPENAI_API_KEY = 'openai-api-key';

      const response = await identifyPlantHandler(identifyRequest(), mockContext);

      expect(response.status).toBe(200);
      expect(mockChatCompletions.create.mock.calls[0][0].model).toBe('gpt-5.6-luna');
    });

    it('AZURE_OPENAI_API_VERSIONが未設定なら、api-versionは2024-12-01-preview', async () => {
      process.env.AZURE_OPENAI_ENDPOINT = 'https://test.openai.azure.com';
      process.env.AZURE_OPENAI_API_KEY = 'azure-api-key';
      process.env.AZURE_OPENAI_DEPLOYMENT_NAME = 'test-deployment';
      delete process.env.AZURE_OPENAI_API_VERSION;

      const response = await identifyPlantHandler(identifyRequest(), mockContext);

      expect(response.status).toBe(200);
      expect(MockedOpenAI.mock.calls[0][0].defaultQuery['api-version']).toBe('2024-12-01-preview');
    });

    it('AZURE_OPENAI_ENDPOINTが無ければ、接続先はOpenAI API（OPENAI_API_KEY）', async () => {
      // tests/setup.ts が Azure の値を設定しているため、デプロイ名も含めて未設定の状態にする
      delete process.env.AZURE_OPENAI_ENDPOINT;
      delete process.env.AZURE_OPENAI_API_KEY;
      delete process.env.AZURE_OPENAI_DEPLOYMENT_NAME;
      process.env.OPENAI_API_KEY = 'openai-api-key';

      const response = await identifyPlantHandler(identifyRequest(), mockContext);

      expect(response.status).toBe(200);
      const clientOptions = MockedOpenAI.mock.calls[0][0];
      expect(clientOptions.apiKey).toBe('openai-api-key');
      expect(clientOptions.baseURL).toBeUndefined();
      expect(clientOptions.defaultQuery).toBeUndefined();
      expect(clientOptions.defaultHeaders).toBeUndefined();
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
