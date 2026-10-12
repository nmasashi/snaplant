import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { AlbumService } from '../services/albumService';
import { PhotoStorageService } from '../services/photoStorageService';
import { photoResponseData } from '../services/photoView';
import {
  createDatabaseErrorResponse,
  createNotFoundError,
  createSuccessResponse,
  createValidationError
} from '../utils/response';
import { ErrorCode } from '../types/api';
import { readPhotoUpdateInput } from '../utils/photoInput';
import { PHOTO_VALIDATION } from '../constants/validation';

/**
 * 写真詳細 API（表示用の SAS 付き URL を付ける）
 * GET /api/photos/{photoId}?code={FUNCTION_KEY}
 */
export async function getPhotoHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const photoId = request.params.photoId;
  context.log(`写真詳細リクエストを受信: ID=${photoId}`);
  if (!PHOTO_VALIDATION.ID_REGEX.test(photoId)) {
    return createValidationError('写真IDの形式が無効です');
  }
  try {
    const photo = await new AlbumService().getPhoto(photoId);
    if (!photo) {
      return createNotFoundError('指定された写真が見つかりません', ErrorCode.PHOTO_NOT_FOUND);
    }
    return createSuccessResponse(photoResponseData(photo, new PhotoStorageService()));
  } catch (error: any) {
    context.log('写真詳細取得エラー:', error);
    return createDatabaseErrorResponse(error, '写真詳細の取得に失敗しました');
  }
}

/**
 * 写真削除 API（ドキュメントを消してから、原寸とサムネイルの Blob を消す）
 * DELETE /api/photos/{photoId}?code={FUNCTION_KEY}
 */
export async function deletePhotoHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const photoId = request.params.photoId;
  context.log(`写真削除リクエストを受信: ID=${photoId}`);
  if (!PHOTO_VALIDATION.ID_REGEX.test(photoId)) {
    return createValidationError('写真IDの形式が無効です');
  }
  let deleted;
  let storage: PhotoStorageService;
  try {
    // 保存先の設定が足りなければ、写真のデータを消す前に失敗させる（消した後だと画像が孤児として残る）
    storage = new PhotoStorageService();
    deleted = await new AlbumService().deletePhoto(photoId);
  } catch (error: any) {
    context.log('写真削除エラー:', error);
    return createDatabaseErrorResponse(error, '写真の削除に失敗しました');
  }
  if (!deleted) {
    return createNotFoundError('指定された写真が見つかりません', ErrorCode.PHOTO_NOT_FOUND);
  }
  await storage.deletePhotoBlobs(deleted, (message, error) => context.log(message, error));
  return createSuccessResponse({ message: '写真が正常に削除されました' });
}

/**
 * 写真更新 API（利用者のコメントとタグを直す）
 * PATCH /api/photos/{photoId}?code={FUNCTION_KEY}
 */
export async function updatePhotoHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const photoId = request.params.photoId;
  context.log(`写真更新リクエストを受信: ID=${photoId}`);
  if (!PHOTO_VALIDATION.ID_REGEX.test(photoId)) {
    return createValidationError('写真IDの形式が無効です');
  }
  const validated = await readPhotoUpdateInput(request);
  if ('error' in validated) {
    return validated.error;
  }
  try {
    // 保存先の設定が足りなければ、写真を書き換える前に失敗させる
    const storage = new PhotoStorageService();
    const photo = await new AlbumService().updatePhoto(photoId, validated.input);
    if (!photo) {
      return createNotFoundError('指定された写真が見つかりません', ErrorCode.PHOTO_NOT_FOUND);
    }
    return createSuccessResponse(photoResponseData(photo, storage));
  } catch (error: any) {
    context.log('写真更新エラー:', error);
    return createDatabaseErrorResponse(error, '写真の更新に失敗しました');
  }
}

app.http('getPhoto', {
  methods: ['GET'],
  authLevel: 'function',
  route: 'photos/{photoId}',
  handler: getPhotoHandler,
});

app.http('deletePhoto', {
  methods: ['DELETE'],
  authLevel: 'function',
  route: 'photos/{photoId}',
  handler: deletePhotoHandler,
});

app.http('updatePhoto', {
  methods: ['PATCH'],
  authLevel: 'function',
  route: 'photos/{photoId}',
  handler: updatePhotoHandler,
});
