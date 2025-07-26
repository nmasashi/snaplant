import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { CosmosService } from '../services/cosmosService';
import { 
  createSuccessResponse, 
  createValidationError, 
  createInternalError,
  createErrorResponse 
} from '../utils/response';
import { HttpStatusCode, ErrorCode } from '../types/api';
import { PlantUpdateRequest } from '../types/plant';
import { isValidUUID } from '../utils/response';
import { PLANT_VALIDATION, GENERAL_VALIDATION } from '../constants/validation';

/**
 * 植物更新 API
 * PUT /api/plants/{id}?code={FUNCTION_KEY}
 */
export async function updatePlantHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log('植物更新リクエストを受信');

  try {
    // パスパラメータからIDを取得
    const plantId = request.params.id;
    
    if (!plantId || !isValidUUID(plantId)) {
      return createValidationError('有効な植物IDが指定されていません', 'IDはUUID形式で指定してください');
    }

    // リクエストボディの取得
    const requestBody = await request.json() as PlantUpdateRequest;
    
    // バリデーション
    const validationError = validatePlantUpdateRequest(requestBody);
    if (validationError) {
      return validationError;
    }

    context.log(`植物更新開始: ID=${plantId}`);

    // Cosmos DBサービス初期化
    const cosmosService = new CosmosService();
    
    // 植物更新
    const updatedPlant = await cosmosService.updatePlant(plantId, requestBody);
    
    if (!updatedPlant) {
      return createErrorResponse(
        ErrorCode.PLANT_NOT_FOUND,
        '指定された植物が見つかりません',
        HttpStatusCode.NOT_FOUND
      );
    }
    
    context.log(`植物更新成功: ID=${updatedPlant.id}, 名前=${updatedPlant.name}`);
    
    return createSuccessResponse({
      plant: updatedPlant
    });

  } catch (error: any) {
    context.log('植物更新エラー:', error);
    
    // Cosmos DB関連エラー
    if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      return createErrorResponse(
        ErrorCode.DATABASE_ERROR,
        'データベースに接続できません',
        HttpStatusCode.SERVICE_UNAVAILABLE,
        error.message
      );
    }

    // JSONパースエラー
    if (error instanceof SyntaxError) {
      return createValidationError('リクエストボディの形式が無効です', 'JSON形式で送信してください');
    }

    return createInternalError('植物の更新に失敗しました', error.message);
  }
}

/**
 * 植物更新リクエストのバリデーション
 */
function validatePlantUpdateRequest(request: PlantUpdateRequest): HttpResponseInit | null {
  if (!request) {
    return createValidationError('リクエストボディが指定されていません');
  }

  // 必須フィールドのチェック
  if (!request.imagePath || request.imagePath.trim().length === 0) {
    return createValidationError('画像パスが指定されていません');
  }

  if (typeof request.confidence !== 'number' || 
      request.confidence < PLANT_VALIDATION.CONFIDENCE.MIN || 
      request.confidence > PLANT_VALIDATION.CONFIDENCE.MAX) {
    return createValidationError(PLANT_VALIDATION.ERROR_MESSAGES.CONFIDENCE_OUT_OF_RANGE);
  }

  // URL形式のバリデーション
  try {
    new URL(request.imagePath);
  } catch (error) {
    return createValidationError('画像URLの形式が無効です', GENERAL_VALIDATION.ERROR_MESSAGES.INVALID_URL);
  }

  return null;
}

// Azure Functions への登録
app.http('updatePlant', {
  methods: ['PUT'],
  authLevel: 'function',
  route: 'plants/{id}',
  handler: updatePlantHandler
});