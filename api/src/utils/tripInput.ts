import { HttpRequest, HttpResponseInit } from '@azure/functions';
import { createValidationError, isPresentNonString } from './response';
import { TripInput } from '../types/album';
import { TRIP_VALIDATION } from '../constants/validation';

/**
 * 旅行の作成・更新のボディを読んで検証する（POST /api/trips と PUT /api/trips/{tripId} が共有する）
 * @param request リクエスト
 * @returns 検証を通った入力、または 400 の応答
 */
export async function readTripInput(request: HttpRequest): Promise<{ input: TripInput } | { error: HttpResponseInit }> {
  let body: unknown;
  try {
    body = await request.json();
  } catch (error: any) {
    if (error instanceof SyntaxError) {
      return { error: createValidationError('リクエストボディの形式が無効です', 'JSON形式で送信してください') };
    }
    throw error;
  }
  return validateTripInput(body);
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
