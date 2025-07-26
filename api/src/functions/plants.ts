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
    // 環境変数の確認
    context.log('Environment variables check:');
    context.log('COSMOS_DB_ENDPOINT:', process.env.COSMOS_DB_ENDPOINT ? 'SET' : 'NOT SET');
    context.log('COSMOS_DB_KEY:', process.env.COSMOS_DB_KEY ? 'SET' : 'NOT SET');
    context.log('COSMOS_DB_DATABASE:', process.env.COSMOS_DB_DATABASE);
    context.log('COSMOS_DB_CONTAINER:', process.env.COSMOS_DB_CONTAINER);

    // 一時的にCosmos DBアクセスをスキップして、基本的な応答を返す
    return createSuccessResponse({
      plants: [],
      total: 0,
      message: "Test response - Cosmos DB access skipped"
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