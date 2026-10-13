import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { OpenAIVisionService } from '../services/openAIVisionService';
import { 
  createSuccessResponse, 
  createInternalError,
  createValidationError,
  createUpstreamErrorResponse
} from '../utils/response';
import { IdentifyRequest } from '../types/plant';
import { UpstreamError } from '../utils/errors';
import { GENERAL_VALIDATION, CONTEXT_INFO_VALIDATION } from '../constants/validation';

/**
 * 植物識別 API
 * POST /api/plants/identify?code={FUNCTION_KEY}
 */
export async function identifyPlantHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log('植物識別リクエストを受信');

  try {
    // リクエストボディの取得
    const requestBody = await request.json() as IdentifyRequest;
    
    // バリデーション
    if (!requestBody || !requestBody.imagePath) {
      return createValidationError('画像URLが指定されていません');
    }

    // URL形式のバリデーション
    try {
      new URL(requestBody.imagePath);
    } catch (error) {
      return createValidationError('画像URLの形式が無効です', GENERAL_VALIDATION.ERROR_MESSAGES.INVALID_URL);
    }

    // 補足情報のバリデーション。
    // request.json() の値は型が保証されないため、まず文字列であることを要求する。
    // 型を見ずに .length を比較すると、配列では要素数が、数値では undefined が
    // 比較対象になり、長さの上限を素通りしてプロンプトに埋め込まれてしまう
    const contextInfo: unknown = requestBody.contextInfo;
    if (contextInfo !== undefined && contextInfo !== null) {
      if (typeof contextInfo !== 'string') {
        return createValidationError(CONTEXT_INFO_VALIDATION.ERROR_MESSAGES.NOT_A_STRING);
      }
      if (contextInfo.length > CONTEXT_INFO_VALIDATION.MAX_LENGTH) {
        return createValidationError(CONTEXT_INFO_VALIDATION.ERROR_MESSAGES.TOO_LONG);
      }
    }

    context.log(`植物識別開始: 画像URL=${requestBody.imagePath}, コンテキスト情報=${requestBody.contextInfo || 'なし'}`);

    // OpenAI Visionサービス初期化
    const visionService = new OpenAIVisionService();

    // LLMで植物識別実行（コンテキスト情報があれば渡す）
    const identificationResult = await visionService.identifyPlant(requestBody.imagePath, requestBody.contextInfo);
    
    context.log(`植物識別完了: 植物=${identificationResult.isPlant}, 候補数=${identificationResult.candidates.length}`);
    
    return createSuccessResponse({
      result: identificationResult
    });

  } catch (error: any) {
    context.log('植物識別エラー:', error);
    
    // AI 識別サービスの呼び出しで起きたエラー。
    // メッセージの文字列ではなく、どこで失敗したか（UpstreamError の service）で分類する。
    // SDK のエラーのメッセージは "500 The server had an error..." のような形で、
    // 'OpenAI' という語を含まないため、文字列で見ると上流の失敗が 500 になっていた
    if (error instanceof UpstreamError) {
      return createUpstreamErrorResponse(error);
    }

    // JSONパースエラー
    if (error instanceof SyntaxError) {
      return createValidationError('リクエストボディの形式が無効です', 'JSON形式で送信してください');
    }

    return createInternalError('植物識別処理に失敗しました', error.message);
  }
}

// Azure Functions への登録
app.http('identify', {
  methods: ['POST'],
  authLevel: 'function',
  route: 'plants/identify',
  handler: identifyPlantHandler
});