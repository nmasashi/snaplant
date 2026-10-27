import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { AlbumService } from '../services/albumService';
import { createDatabaseErrorResponse, createNotFoundError, createSuccessResponse } from '../utils/response';
import { readMoveInput } from '../utils/photoInput';
import { ErrorCode } from '../types/api';

/**
 * 写真の移動 API（写真をまとめて旅行に入れる、または tripId: null で旅行から外す）
 * POST /api/photos/move
 */
export async function movePhotosHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log('写真の移動リクエストを受信');
  const validated = await readMoveInput(request);
  if ('error' in validated) {
    return validated.error;
  }
  const { photoIds, tripId } = validated.input;
  try {
    const album = new AlbumService();
    if (tripId !== null && !(await album.tripExists(tripId))) {
      return createNotFoundError('指定された旅行が見つかりません', ErrorCode.TRIP_NOT_FOUND);
    }
    const result = await album.movePhotos(photoIds, tripId);
    context.log(`写真の移動: 移した ${result.moved.length} 枚、無かった ${result.notFound.length} 枚`);
    return createSuccessResponse(result);
  } catch (error: any) {
    // 途中で失敗したら、済んだ分は移っている。同じ要求を再送すれば同じ結果になる
    context.log('写真の移動エラー:', error);
    return createDatabaseErrorResponse(error, '写真の移動に失敗しました');
  }
}

app.http('movePhotos', {
  methods: ['POST'],
  authLevel: 'function',
  route: 'photos/move',
  handler: movePhotosHandler,
});
