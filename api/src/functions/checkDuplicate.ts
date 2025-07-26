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
    context.log('リクエスト詳細:', {
      method: request.method,
      url: request.url,
      query: Object.fromEntries(request.query.entries())
    });

    const plantName = request.query.get('name');
    context.log(`取得した植物名: "${plantName}"`);
    
    if (!plantName || plantName.trim().length === 0) {
      context.log('植物名バリデーションエラー');
      return createValidationError('植物名が指定されていません', 'nameクエリパラメータは必須です');
    }

    const trimmedName = plantName.trim();
    context.log(`重複チェック開始: 植物名="${trimmedName}"`);

    context.log('CosmosService初期化開始');
    const cosmosService = new CosmosService();
    context.log('CosmosService初期化完了');
    
    context.log('checkDuplicateByName実行開始');
    const result = await cosmosService.checkDuplicateByName(trimmedName);
    context.log('checkDuplicateByName実行完了:', result);
    
    context.log(`重複チェック結果: exists=${result.exists}`);
    
    const response = createSuccessResponse(result);
    context.log('レスポンス作成完了:', response);
    
    return response;

  } catch (error: any) {
    context.log('植物重複チェックエラー:', {
      message: error.message,
      stack: error.stack,
      code: error.code,
      name: error.name
    });
    
    // Cosmos DB関連エラー
    if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      context.log('データベース接続エラーを検出');
      return createErrorResponse(
        ErrorCode.DATABASE_ERROR,
        'データベースに接続できません',
        HttpStatusCode.SERVICE_UNAVAILABLE,
        error.message
      );
    }

    context.log('内部エラーとして処理');
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