import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { CosmosService } from '../services/cosmosService';
import { StorageService } from '../services/storageService';
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
    
    // 文言は GET / DELETE（plantDetail.ts）と揃える。クライアントは 400 の message を画面にそのまま出す
    if (!plantId) {
      return createValidationError('植物IDが指定されていません');
    }
    if (!isValidUUID(plantId)) {
      return createValidationError('植物IDの形式が無効です', GENERAL_VALIDATION.ERROR_MESSAGES.INVALID_UUID);
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
    
    // imagePath の重複チェック。
    //
    // save 側だけ塞いでも PUT から同じ状態を作れるので、入口を揃える。
    // 同じ imagePath を持つレコードが2つできると、一方を削除または別の画像に
    // 更新した時点で、もう一方の画像まで消えてしまう。
    //
    // 自分自身は除外する。同じ imagePath のまま他のフィールドだけ更新する
    // 場合に自分とぶつかるため。
    //
    // 判定は「**自分が既にその画像を持っているか**」で行う。
    // 既に持っているなら、この更新で新たな重複は生まれないので通す。
    //
    // 1件だけ取って id を比べる形では判定できなかった。クエリに ORDER BY は
    // 無いため得られるのは「任意の1件」で、重複が既に2件ある状態
    // （save は read-then-write なので同時リクエストで作れる）では
    // 更新対象ではない方が返ることがあり、**正当な更新が 409 で永久に
    // 拒まれた**。「自分以外が残るか」で見るのも駄目で、既にある重複を
    // 理由に自分の更新を拒んでしまう。
    //
    // save と同じ read-then-write なので、ほぼ同時に届いた2リクエストには
    // 効かない（docs/09_backlog.md に限界として記録済み）
    const existingByImage = await cosmosService.getPlantsByImagePath(requestBody.imagePath);
    const heldBySelf = existingByImage.some((plant) => plant.id === plantId);
    if (existingByImage.length > 0 && !heldBySelf) {
      return createErrorResponse(
        ErrorCode.IMAGE_ALREADY_SAVED,
        'この画像は既に保存されています',
        HttpStatusCode.CONFLICT
      );
    }

    // 植物更新。ボディを詰め直して、更新を許す2項目だけを渡す。
    // そのまま渡すと、ボディに含まれた name や createdAt まで既存の植物に上書きされる
    const updatedPlant = await cosmosService.updatePlant(plantId, {
      imagePath: requestBody.imagePath,
      confidence: requestBody.confidence
    });
    
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

  // 型のチェック。.trim() より前に置く（文字列以外だと TypeError で 500 になるため。save.ts と同じ）
  if (request.imagePath !== undefined && request.imagePath !== null && typeof request.imagePath !== 'string') {
    return createValidationError('画像パスは文字列で指定してください');
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

  // 自アカウントの永続コンテナを指すことのバリデーション。
  // URL としてパースできるかの検証は別に置かない（save.ts と同じ理由）。
  // ここを通すと、更新時の旧画像削除が外部ホストのURLを宛先にしてしまい、
  // ファイル名が一致するだけの他レコードのBlobを消せてしまう
  if (!StorageService.isValidImagePath(request.imagePath)) {
    return createValidationError(GENERAL_VALIDATION.ERROR_MESSAGES.IMAGE_PATH_NOT_ALLOWED);
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