import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { AlbumService } from '../services/albumService';
import { enqueuePhotoOrLog } from '../services/photoQueueService';
import { PhotoStorageService } from '../services/photoStorageService';
import { photoResponseData } from '../services/photoView';
import { createDatabaseErrorResponse, createNotFoundError, createSuccessResponse, createValidationError } from '../utils/response';
import { readProcessRequestInput } from '../utils/photoInput';
import { ErrorCode, HttpStatusCode } from '../types/api';
import { PHOTO_VALIDATION } from '../constants/validation';
import { isCatalogKind } from '../catalog/kinds';

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
    const album = new AlbumService();
    if (validated.input.step === 'identify') {
      // 識別は図鑑の種類の写真だけ（05 §5.7 の 8）。写真があるか（7）を先に見る。
      // 読んでから書くまでに分類がカテゴリを other に変えることはまれで、そのときもワーカーが AI を呼ばずに内部の失敗として数える
      const current = await album.getPhoto(photoId);
      if (!current) {
        return createNotFoundError('指定された写真が見つかりません', ErrorCode.PHOTO_NOT_FOUND);
      }
      if (!isCatalogKind(current.category)) {
        return createValidationError('この写真は識別の対象ではありません');
      }
    }
    photo = await album.requestPhotoProcessing(
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

  await enqueuePhotoOrLog(photoId, (...args) => context.log(...args));
  return createSuccessResponse(photoResponseData(photo, storage), HttpStatusCode.ACCEPTED);
}

app.http('requestPhotoProcessing', {
  methods: ['POST'],
  authLevel: 'function',
  route: 'photos/{photoId}/process',
  handler: processPhotoRequestHandler,
});
