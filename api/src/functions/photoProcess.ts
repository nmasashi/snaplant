import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { AlbumService } from '../services/albumService';
import { PhotoQueueService } from '../services/photoQueueService';
import { PhotoStorageService } from '../services/photoStorageService';
import { photoResponseData } from '../services/photoView';
import { createDatabaseErrorResponse, createNotFoundError, createSuccessResponse, createValidationError } from '../utils/response';
import { readProcessRequestInput } from '../utils/photoInput';
import { ErrorCode, HttpStatusCode } from '../types/api';
import { PHOTO_VALIDATION } from '../constants/validation';

/**
 * 写真の解析のやり直し API（受け付けて、キューに積む。解析はワーカーが後で行う）
 * POST /api/photos/{photoId}/process?code={FUNCTION_KEY}
 */
export async function processPhotoRequestHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const photoId = request.params.photoId;
  context.log(`解析のやり直しリクエストを受信: ID=${photoId}`);
  if (!PHOTO_VALIDATION.ID_REGEX.test(photoId)) {
    return createValidationError('写真IDの形式が無効です');
  }
  const validated = await readProcessRequestInput(request);
  if ('error' in validated) {
    return validated.error;
  }
  let photo;
  let storage: PhotoStorageService;
  try {
    // 保存先の設定が足りなければ、写真を書き換える前に失敗させる
    storage = new PhotoStorageService();
    photo = await new AlbumService().requestPhotoProcessing(
      photoId,
      validated.input.step,
      validated.input.hint,
      new Date().toISOString()
    );
  } catch (error: any) {
    context.log('解析のやり直しの受付エラー:', error);
    return createDatabaseErrorResponse(error, '解析のやり直しの受付に失敗しました');
  }
  if (!photo) {
    return createNotFoundError('指定された写真が見つかりません', ErrorCode.PHOTO_NOT_FOUND);
  }

  try {
    await new PhotoQueueService().enqueue(photoId);
  } catch (error: any) {
    // 写真は分類の待ちのまま残り、再投入のタイマーが拾う。失敗を返すと「失敗したのに後で勝手に走る」ことになる
    context.log(`解析のキューへの投入に失敗しました（タイマーが再投入します）: ID=${photoId}`, error);
  }
  return createSuccessResponse(photoResponseData(photo, storage), HttpStatusCode.ACCEPTED);
}

app.http('requestPhotoProcessing', {
  methods: ['POST'],
  authLevel: 'function',
  route: 'photos/{photoId}/process',
  handler: processPhotoRequestHandler,
});
