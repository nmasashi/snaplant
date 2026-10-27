import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { AlbumService } from '../services/albumService';
import { coverUrlMaker } from '../services/photoView';
import { createDatabaseErrorResponse, createSuccessResponse } from '../utils/response';
import { readTripInput } from '../utils/tripInput';
import { HttpStatusCode } from '../types/api';

/**
 * 旅行作成 API
 * POST /api/trips
 */
export async function createTripHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log('旅行作成リクエストを受信');
  const validated = await readTripInput(request);
  if ('error' in validated) {
    return validated.error;
  }
  try {
    const trip = await new AlbumService().createTrip(validated.input);
    context.log(`旅行作成成功: ID=${trip.id}`);
    return createSuccessResponse({ trip }, HttpStatusCode.CREATED);
  } catch (error: any) {
    context.log('旅行作成エラー:', error);
    return createDatabaseErrorResponse(error, '旅行の作成に失敗しました');
  }
}

/**
 * 旅行一覧 API（最初の撮影日時の新しい順、撮影日時の無い旅行は先頭。写真の集計と、旅行に属さない写真の枚数を付ける）
 * GET /api/trips
 */
export async function listTripsHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log('旅行一覧リクエストを受信');
  try {
    const { trips, unassignedPhotoCount } = await new AlbumService().listTrips(coverUrlMaker());
    return createSuccessResponse({ trips, total: trips.length, unassignedPhotoCount });
  } catch (error: any) {
    context.log('旅行一覧取得エラー:', error);
    return createDatabaseErrorResponse(error, '旅行一覧の取得に失敗しました');
  }
}

app.http('listTrips', {
  methods: ['GET'],
  authLevel: 'function',
  route: 'trips',
  handler: listTripsHandler,
});

app.http('createTrip', {
  methods: ['POST'],
  authLevel: 'function',
  route: 'trips',
  handler: createTripHandler,
});
