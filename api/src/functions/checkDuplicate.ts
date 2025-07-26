import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { CosmosService } from '../services/cosmosService';
import { 
  createSuccessResponse, 
  createValidationError, 
  createInternalError,
  createErrorResponse 
} from '../utils/response';
import { HttpStatusCode, ErrorCode } from '../types/api';

/**
 * 植物重複チェック API
 * GET /api/plants/check-duplicate?name={植物名}
 */
export async function checkDuplicateHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log('植物重複チェックリクエストを受信');

  try {
    const plantName = request.query.get('name');
    
    if (!plantName || plantName.trim().length === 0) {
      return createValidationError('植物名が指定されていません', 'nameクエリパラメータは必須です');
    }

    context.log(`重複チェック開始: 植物名=${plantName}`);

    const cosmosService = new CosmosService();
    const result = await cosmosService.checkDuplicateByName(plantName.trim());
    
    context.log(`重複チェック結果: exists=${result.exists}`);
    
    return createSuccessResponse(result);

  } catch (error: any) {
    context.log('植物重複チェックエラー:', error);
    
    // Cosmos DB関連エラー
    if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      return createErrorResponse(
        ErrorCode.DATABASE_ERROR,
        'データベースに接続できません',
        HttpStatusCode.SERVICE_UNAVAILABLE,
        error.message
      );
    }

    return createInternalError('重複チェックに失敗しました', error.message);
  }
}

// Azure Functions への登録
app.http('checkDuplicate', {
  methods: ['GET'],
  authLevel: 'function',
  route: 'plants/check-duplicate',
  handler: checkDuplicateHandler
});