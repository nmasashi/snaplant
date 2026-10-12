import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { AlbumService } from '../services/albumService';
import { coverUrlMaker } from '../services/photoView';
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
