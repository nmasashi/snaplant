import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { AlbumService } from '../services/albumService';
import {
  createErrorResponse,
  createInternalError,
  createSuccessResponse,
  createValidationError,
  isPresentNonString
} from '../utils/response';
import { isConnectivityError } from '../utils/errors';
import { ErrorCode, HttpStatusCode } from '../types/api';
import { TripInput } from '../types/album';
import { TRIP_VALIDATION } from '../constants/validation';

/**
 * 旅行作成 API
 * POST /api/trips?code={FUNCTION_KEY}
 */
export async function createTripHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log('旅行作成リクエストを受信');
  let body: unknown;
  try {
    body = await request.json();
  } catch (error: any) {
    if (error instanceof SyntaxError) {
      return createValidationError('リクエストボディの形式が無効です', 'JSON形式で送信してください');
    }
    throw error;
  }
  const validated = validateTripInput(body);
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
 * Cosmos DB の操作の失敗を応答にする
 * @param error 捕まえたエラー
 * @param internalMessage 接続できない以外の失敗（500）で返す文言
 */
export function createDatabaseErrorResponse(error: any, internalMessage: string): HttpResponseInit {
  if (isConnectivityError(error)) {
    return createErrorResponse(
      ErrorCode.DATABASE_ERROR,
      'データベースに接続できません',
      HttpStatusCode.SERVICE_UNAVAILABLE,
      error.message
    );
  }
  return createInternalError(internalMessage, error.message);
}

/**
 * 旅行一覧 API（作成日時の新しい順。写真の集計と、旅行に属さない写真の枚数を付ける）
 * GET /api/trips?code={FUNCTION_KEY}
 */
export async function listTripsHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log('旅行一覧リクエストを受信');
  try {
    const { trips, unassignedPhotoCount } = await new AlbumService().listTrips();
    return createSuccessResponse({ trips, total: trips.length, unassignedPhotoCount });
  } catch (error: any) {
    context.log('旅行一覧取得エラー:', error);
    return createDatabaseErrorResponse(error, '旅行一覧の取得に失敗しました');
  }
}

/**
 * 旅行の作成・更新のボディを検証する（docs/travel-album/05_api_design.md §5.8 の表の順）
 *
 * 型の検査を空・文字数の検査より先に置く。文字列以外を通すと .trim() の TypeError で 500 になる
 * @param body リクエストボディ
 * @returns 検証を通った入力、または 400 の応答
 */
export function validateTripInput(body: unknown): { input: TripInput } | { error: HttpResponseInit } {
  if (body === null || body === undefined) {
    return { error: createValidationError('リクエストボディが指定されていません') };
  }
  const { name, description } = body as { name?: unknown; description?: unknown };
  const messages = TRIP_VALIDATION.ERROR_MESSAGES;
  if (isPresentNonString(name)) {
    return { error: createValidationError(messages.NAME_NOT_A_STRING) };
  }
  if (isPresentNonString(description)) {
    return { error: createValidationError(messages.DESCRIPTION_NOT_A_STRING) };
  }
  const trimmedName = typeof name === 'string' ? name.trim() : '';
  if (trimmedName === '') {
    return { error: createValidationError(messages.NAME_REQUIRED) };
  }
  if (trimmedName.length > TRIP_VALIDATION.MAX_LENGTH.NAME) {
    return { error: createValidationError(messages.NAME_TOO_LONG) };
  }
  if (typeof description === 'string' && description.length > TRIP_VALIDATION.MAX_LENGTH.DESCRIPTION) {
    return { error: createValidationError(messages.DESCRIPTION_TOO_LONG) };
  }
  return { input: { name: trimmedName, description: typeof description === 'string' && description !== '' ? description : null } };
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
