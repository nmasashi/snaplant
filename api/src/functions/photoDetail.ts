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
  // Blob の削除の失敗はログだけにする。ドキュメントはもう無く、残った Blob は掃除のタイマー（段階3）が消す。
  // 原寸で失敗してもサムネイルは消しにいく
  for (const blobName of [deleted.blobName, deleted.thumbnailBlobName]) {
    if (!blobName) {
      continue;
    }
    try {
      await storage.delete(blobName);
    } catch (error: any) {
      context.log(`写真の Blob の削除に失敗しました（ドキュメントは削除済み）: ID=${photoId}`, error);
    }
  }
  return createSuccessResponse({ message: '写真が正常に削除されました' });
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
