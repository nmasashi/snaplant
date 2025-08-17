import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { OpenAIVisionService } from '../services/openAIVisionService';
import { 
  createSuccessResponse, 
  createErrorResponse, 
  createInternalError,
  createValidationError
} from '../utils/response';
import { HttpStatusCode, ErrorCode } from '../types/api';
import { IdentifyRequest } from '../types/plant';
import { GENERAL_VALIDATION } from '../constants/validation';

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

    context.log(`植物識別開始: 画像URL=${requestBody.imagePath}, コンテキスト情報=${requestBody.contextInfo || 'なし'}`);

    // OpenAI Visionサービス初期化
    const visionService = new OpenAIVisionService();
    
    // 画像の有効性チェック
    const isValidImage = await visionService.validateImage(requestBody.imagePath);
    if (!isValidImage) {
      return createValidationError('画像の解析に失敗しました', '有効な画像URLを指定してください');
    }

    // LLMで植物識別実行（コンテキスト情報があれば渡す）
    const identificationResult = await visionService.identifyPlant(requestBody.imagePath, requestBody.contextInfo);
    
    context.log(`植物識別完了: 植物=${identificationResult.isPlant}, 候補数=${identificationResult.candidates.length}`);
    
    return createSuccessResponse({
      result: identificationResult
    });

  } catch (error: any) {
    context.log('植物識別エラー:', error);
    
    // OpenAI API関連エラー
    if (error.message.includes('OpenAI') || error.message.includes('LLM') || error.code === 'insufficient_quota') {
      return createErrorResponse(
        ErrorCode.AI_SERVICE_ERROR,
        '植物識別サービスでエラーが発生しました',
        HttpStatusCode.BAD_GATEWAY,
        error.message
      );
    }


    // ネットワークエラー
    if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      return createErrorResponse(
        ErrorCode.AI_SERVICE_ERROR,
        '植物識別サービスに接続できません',
        HttpStatusCode.SERVICE_UNAVAILABLE,
        error.message
      );
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