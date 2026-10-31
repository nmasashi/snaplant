import { HttpRequest, HttpResponseInit } from '@azure/functions';
import { createValidationError } from './response';
import { readJsonBody } from './tripInput';

/**
 * タイムラインから写真を外す要求のボディ（{ photoIds: string[] }）を読む（下書きと完成版で同じ。05 §5.15）
 *
 * JSON として読めない・null・写真の id の配列でない（空も）なら 400。データベースに触る前に弾く（控えに無い id は、控えを読んでから呼ぶ側が見る）
 */
export async function readPhotoIdsToExclude(request: HttpRequest): Promise<{ photoIds: string[] } | { error: HttpResponseInit }> {
  const read = await readJsonBody(request);
  if ('error' in read) {
    return read;
  }
  if (read.body === null || read.body === undefined) {
    return { error: createValidationError('リクエストボディが指定されていません') };
  }
  const { photoIds } = read.body as { photoIds?: unknown };
  if (!Array.isArray(photoIds) || photoIds.length === 0 || !photoIds.every((id) => typeof id === 'string')) {
    return { error: createValidationError('外す写真は写真IDの配列で指定してください') };
  }
  return { photoIds };
}
