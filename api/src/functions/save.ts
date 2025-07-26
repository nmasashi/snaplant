import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { CosmosService } from '../services/cosmosService';
import { 
  createSuccessResponse, 
  createErrorResponse, 
  createInternalError,
  createValidationError
} from '../utils/response';
import { HttpStatusCode, ErrorCode } from '../types/api';
import { PlantCreateRequest, Plant } from '../types/plant';
import { v4 as uuidv4 } from 'uuid';
import { PLANT_VALIDATION, GENERAL_VALIDATION } from '../constants/validation';

/**
 * 植物保存 API
 * POST /api/plants/save?code={FUNCTION_KEY}
 */
export async function savePlantHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log('植物保存リクエストを受信');

  try {
    // リクエストボディの取得
    const requestBody = await request.json() as PlantCreateRequest;
    
    // バリデーション
    const validationError = validatePlantCreateRequest(requestBody);
    if (validationError) {
      return validationError;
    }

    context.log(`植物保存開始: 名前=${requestBody.name}`);

    // 植物オブジェクト作成
    const newPlant: Plant = {
      id: uuidv4(),
      name: requestBody.name,
      scientificName: requestBody.scientificName,
      familyName: requestBody.familyName,
      description: requestBody.description,
      characteristics: requestBody.characteristics,
      confidence: requestBody.confidence,
      imagePath: requestBody.imagePath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    // Cosmos DBサービス初期化
    const cosmosService = new CosmosService();
    
    // 植物保存
    const savedPlant = await cosmosService.createPlant(newPlant);
    
    context.log(`植物保存成功: ID=${savedPlant.id}, 名前=${savedPlant.name}`);
    
    return createSuccessResponse({
      plant: savedPlant
    }, HttpStatusCode.CREATED);

  } catch (error: any) {
    context.log('植物保存エラー:', error);
    
    // Cosmos DB関連エラー
    if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      return createErrorResponse(
        ErrorCode.DATABASE_ERROR,
        'データベースに接続できません',
        HttpStatusCode.SERVICE_UNAVAILABLE,
        error.message
      );
    }

    // Cosmos DB制約エラー（重複など）
    if (error.code === 409) {
      return createErrorResponse(
        ErrorCode.DATABASE_ERROR,
        '植物の保存に失敗しました',
        HttpStatusCode.CONFLICT,
        error.message
      );
    }

    // JSONパースエラー
    if (error instanceof SyntaxError) {
      return createValidationError('リクエストボディの形式が無効です', 'JSON形式で送信してください');
    }

    return createInternalError('植物の保存に失敗しました', error.message);
  }
}

/**
 * 植物作成リクエストのバリデーション
 */
function validatePlantCreateRequest(request: PlantCreateRequest): HttpResponseInit | null {
  if (!request) {
    return createValidationError('リクエストボディが指定されていません');
  }

  // 必須フィールドのチェック
  if (!request.name || request.name.trim().length === 0) {
    return createValidationError('植物名が指定されていません');
  }

  if (!request.characteristics || request.characteristics.trim().length === 0) {
    return createValidationError('特徴が指定されていません');
  }

  if (!request.imagePath || request.imagePath.trim().length === 0) {
    return createValidationError('画像パスが指定されていません');
  }

  if (typeof request.confidence !== 'number' || 
      request.confidence < PLANT_VALIDATION.CONFIDENCE.MIN || 
      request.confidence > PLANT_VALIDATION.CONFIDENCE.MAX) {
    return createValidationError(PLANT_VALIDATION.ERROR_MESSAGES.CONFIDENCE_OUT_OF_RANGE);
  }

  // 文字列長のチェック
  if (request.name.length > PLANT_VALIDATION.MAX_LENGTH.NAME) {
    return createValidationError(PLANT_VALIDATION.ERROR_MESSAGES.NAME_TOO_LONG);
  }

  if (request.scientificName && request.scientificName.length > PLANT_VALIDATION.MAX_LENGTH.SCIENTIFIC_NAME) {
    return createValidationError(PLANT_VALIDATION.ERROR_MESSAGES.SCIENTIFIC_NAME_TOO_LONG);
  }

  if (request.familyName && request.familyName.length > PLANT_VALIDATION.MAX_LENGTH.FAMILY_NAME) {
    return createValidationError(PLANT_VALIDATION.ERROR_MESSAGES.FAMILY_NAME_TOO_LONG);
  }

  if (request.description && request.description.length > PLANT_VALIDATION.MAX_LENGTH.DESCRIPTION) {
    return createValidationError(PLANT_VALIDATION.ERROR_MESSAGES.DESCRIPTION_TOO_LONG);
  }

  if (request.characteristics.length > PLANT_VALIDATION.MAX_LENGTH.CHARACTERISTICS) {
    return createValidationError(PLANT_VALIDATION.ERROR_MESSAGES.CHARACTERISTICS_TOO_LONG);
  }

  // URL形式のバリデーション
  try {
    new URL(request.imagePath);
  } catch (error) {
    return createValidationError('画像パスの形式が無効です', GENERAL_VALIDATION.ERROR_MESSAGES.INVALID_URL);
  }

  return null;
}

// Azure Functions への登録
app.http('save', {
  methods: ['POST'],
  authLevel: 'function',
  route: 'plants/save',
  handler: savePlantHandler
});