import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { CosmosService } from '../services/cosmosService';
import { 
  createSuccessResponse, 
  createErrorResponse, 
  createInternalError
} from '../utils/response';
import { HttpStatusCode, ErrorCode } from '../types/api';

/**
 * 植物一覧取得 API
 * GET /api/plants?code={FUNCTION_KEY}
 */
export async function getPlantsHandler(_request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log('植物一覧取得リクエストを受信');

  try {
    // Cosmos DBサービス初期化
    const cosmosService = new CosmosService();
    
    // 植物一覧取得
    const plants = await cosmosService.getPlants();
    
    context.log(`植物一覧取得成功: ${plants.length}件`);
    
    return createSuccessResponse({
      plants,
      total: plants.length
    });

  } catch (error: any) {
    context.log('植物一覧取得エラー:', error);
    
    // Cosmos DB関連エラー
    if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      return createErrorResponse(
        ErrorCode.DATABASE_ERROR,
        'データベースに接続できません',
        HttpStatusCode.SERVICE_UNAVAILABLE,
        error.message
      );
    }

    return createInternalError('植物一覧の取得に失敗しました', error.message);
  }
}

// Azure Functions への登録
app.http('plants', {
  methods: ['GET'],
  authLevel: 'function',
  route: 'plants',
  handler: getPlantsHandler
});