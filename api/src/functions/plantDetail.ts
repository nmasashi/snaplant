import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { CosmosService } from '../services/cosmosService';
import { 
  createSuccessResponse, 
  createNotFoundError, 
  createInternalError,
  createValidationError,
  createErrorResponse,
  isValidUUID
} from '../utils/response';
import { HttpStatusCode, ErrorCode } from '../types/api';
import { GENERAL_VALIDATION } from '../constants/validation';

/**
 * 植物詳細取得 API
 * GET /api/plants/{id}?code={FUNCTION_KEY}
 */
export async function getPlantByIdHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log('植物詳細取得リクエストを受信');

  try {
    // パスパラメータからIDを取得
    const plantId = request.params.id;
    if (!plantId) {
      return createValidationError('植物IDが指定されていません');
    }

    // UUID形式のバリデーション
    if (!isValidUUID(plantId)) {
      return createValidationError('植物IDの形式が無効です', GENERAL_VALIDATION.ERROR_MESSAGES.INVALID_UUID);
    }

    // Cosmos DBサービス初期化
    const cosmosService = new CosmosService();
    
    // 植物詳細取得
    const plant = await cosmosService.getPlantById(plantId);
    
    if (!plant) {
      context.log(`植物が見つかりません: ID=${plantId}`);
      return createNotFoundError('指定された植物が見つかりません');
    }
    
    context.log(`植物詳細取得成功: ID=${plantId}, 名前=${plant.name}`);
    
    return createSuccessResponse({
      plant
    });

  } catch (error: any) {
    context.log('植物詳細取得エラー:', error);
    
    // Cosmos DB関連エラー
    if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      return createErrorResponse(
        ErrorCode.DATABASE_ERROR,
        'データベースに接続できません',
        HttpStatusCode.SERVICE_UNAVAILABLE,
        error.message
      );
    }

    return createInternalError('植物詳細の取得に失敗しました', error.message);
  }
}

/**
 * 植物削除 API
 * DELETE /api/plants/{id}?code={FUNCTION_KEY}
 */
export async function deletePlantHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log('植物削除リクエストを受信');

  try {
    // パスパラメータからIDを取得
    const plantId = request.params.id;
    if (!plantId) {
      return createValidationError('植物IDが指定されていません');
    }

    // UUID形式のバリデーション
    if (!isValidUUID(plantId)) {
      return createValidationError('植物IDの形式が無効です', GENERAL_VALIDATION.ERROR_MESSAGES.INVALID_UUID);
    }

    // Cosmos DBサービス初期化
    const cosmosService = new CosmosService();
    
    // 植物削除
    const deleted = await cosmosService.deletePlant(plantId);
    
    if (!deleted) {
      context.log(`削除対象の植物が見つかりません: ID=${plantId}`);
      return createNotFoundError('指定された植物が見つかりません');
    }
    
    context.log(`植物削除成功: ID=${plantId}`);
    
    return createSuccessResponse({
      message: '植物が正常に削除されました'
    });

  } catch (error: any) {
    context.log('植物削除エラー:', error);
    
    // Cosmos DB関連エラー
    if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      return createErrorResponse(
        ErrorCode.DATABASE_ERROR,
        'データベースに接続できません',
        HttpStatusCode.SERVICE_UNAVAILABLE,
        error.message
      );
    }

    return createInternalError('植物の削除に失敗しました', error.message);
  }
}

// Azure Functions への登録
app.http('plantDetail', {
  methods: ['GET', 'DELETE'],
  authLevel: 'function',
  route: 'plants/{id}',
  handler: async (request: HttpRequest, context: InvocationContext) => {
    if (request.method === 'GET') {
      return getPlantByIdHandler(request, context);
    } else if (request.method === 'DELETE') {
      return deletePlantHandler(request, context);
    }
    
    return createValidationError('サポートされていないHTTPメソッドです');
  }
});