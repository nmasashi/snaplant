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

app.http('getPhoto', {
  methods: ['GET'],
  authLevel: 'function',
  route: 'photos/{photoId}',
  handler: getPhotoHandler,
});
