import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { AlbumService } from '../services/albumService';
import { coverUrlMaker } from '../services/photoView';
import { PhotoStorageService } from '../services/photoStorageService';
import {
  createDatabaseErrorResponse,
  createNotFoundError,
  createSuccessResponse,
  createValidationError,
  isValidUUID
} from '../utils/response';
import { readTripInput } from '../utils/tripInput';
import { ErrorCode } from '../types/api';

/**
 * 旅行詳細 API（写真の集計を付ける）
 * GET /api/trips/{tripId}?code={FUNCTION_KEY}
 */
export async function getTripHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const tripId = request.params.tripId;
  context.log(`旅行詳細リクエストを受信: ID=${tripId}`);
  if (!isValidUUID(tripId)) {
    return createValidationError('旅行IDの形式が無効です');
  }
  try {
    const trip = await new AlbumService().getTrip(tripId, coverUrlMaker());
    if (!trip) {
      return createNotFoundError('指定された旅行が見つかりません', ErrorCode.TRIP_NOT_FOUND);
    }
    return createSuccessResponse({ trip });
  } catch (error: any) {
    context.log('旅行詳細取得エラー:', error);
    return createDatabaseErrorResponse(error, '旅行詳細の取得に失敗しました');
  }
}

/**
 * 旅行更新 API（名前と説明の全体置き換え。タグは変えない）
 * PUT /api/trips/{tripId}?code={FUNCTION_KEY}
 */
export async function updateTripHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const tripId = request.params.tripId;
  context.log(`旅行更新リクエストを受信: ID=${tripId}`);
  if (!isValidUUID(tripId)) {
    return createValidationError('旅行IDの形式が無効です');
  }
  const validated = await readTripInput(request);
  if ('error' in validated) {
    return validated.error;
  }
  try {
    const trip = await new AlbumService().updateTrip(tripId, validated.input);
    if (!trip) {
      return createNotFoundError('指定された旅行が見つかりません', ErrorCode.TRIP_NOT_FOUND);
    }
    return createSuccessResponse({ trip });
  } catch (error: any) {
    context.log('旅行更新エラー:', error);
    return createDatabaseErrorResponse(error, '旅行の更新に失敗しました');
  }
}

/**
 * 旅行削除 API（中の写真を消すか、どの旅行にも属さない写真に戻すかを deletePhotos で選ぶ）
 * DELETE /api/trips/{tripId}?deletePhotos=true|false&code={FUNCTION_KEY}
 */
export async function deleteTripHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const tripId = request.params.tripId;
  context.log(`旅行削除リクエストを受信: ID=${tripId}`);
  if (!isValidUUID(tripId)) {
    return createValidationError('旅行IDの形式が無効です');
  }
  // 省略時の既定で写真が消える（または残る）事故を防ぐため、利用者の選択を必ず載せさせる
  const deletePhotosParam = request.query.get('deletePhotos');
  if (deletePhotosParam === null) {
    return createValidationError('写真を削除するかどうかを指定してください');
  }
  if (deletePhotosParam !== 'true' && deletePhotosParam !== 'false') {
    return createValidationError('写真を削除するかどうかの指定が無効です');
  }
  try {
    const deletePhotos = deletePhotosParam === 'true';
    // 写真の画像を消すときだけ保存先を使う。設定が足りなければ、何も消す前に失敗させる
    const storage = deletePhotos ? new PhotoStorageService() : null;
    const result = await new AlbumService().deleteTrip(tripId, deletePhotos, async (photo) => {
      await storage?.deletePhotoBlobs(photo, (message, error) => context.log(message, error));
    });
    if (!result) {
      return createNotFoundError('指定された旅行が見つかりません', ErrorCode.TRIP_NOT_FOUND);
    }
    context.log(`旅行削除成功: ID=${tripId}、写真を消した ${result.deletedPhotoCount} 枚、未所属に戻した ${result.detachedPhotoCount} 枚`);
    return createSuccessResponse({ message: '旅行が正常に削除されました', ...result });
  } catch (error: any) {
    context.log('旅行削除エラー:', error);
    return createDatabaseErrorResponse(error, '旅行の削除に失敗しました');
  }
}

app.http('getTrip', {
  methods: ['GET'],
  authLevel: 'function',
  route: 'trips/{tripId}',
  handler: getTripHandler,
});

app.http('updateTrip', {
  methods: ['PUT'],
  authLevel: 'function',
  route: 'trips/{tripId}',
  handler: updateTripHandler,
});

app.http('deleteTrip', {
  methods: ['DELETE'],
  authLevel: 'function',
  route: 'trips/{tripId}',
  handler: deleteTripHandler,
});
