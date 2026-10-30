import { HttpResponseInit } from '@azure/functions';
import { createValidationError } from './response';
import { CATALOG_VALIDATION } from '../constants/validation';
import { isListedInCatalog } from '../catalog/kinds';
import { CatalogEntriesQuery, CatalogEntryQuery } from '../types/album';
import { readPhotoPage } from './photoInput';
import { readPageLimit } from './pageLimit';

/**
 * 図鑑の項目の一覧（GET /api/catalog/entries）のクエリを検証する
 *
 * 順は種類 → ページ（docs/05_api_design.md §5.14）。Cosmos に触る前に全部弾く。
 * 「無い」と「空」を分ける（無ければ既定、空なら 400。写真の一覧の limit と同じ）
 * @param query リクエストのクエリ
 * @returns 検証を通ったクエリ、または 400 の応答
 */
export function readCatalogEntriesQuery(
  query: URLSearchParams
): { query: CatalogEntriesQuery } | { error: HttpResponseInit } {
  const kind = query.get('kind');
  if (!isListedInCatalog(kind)) {
    return { error: createValidationError(CATALOG_VALIDATION.ERROR_MESSAGES.KIND_INVALID) };
  }

  const offsetParam = query.get('offset');
  const offset = offsetParam === null ? 0 : /^(0|[1-9][0-9]*)$/.test(offsetParam) ? Number(offsetParam) : NaN;
  const limit = readPageLimit(query.get('limit'), CATALOG_VALIDATION.PAGE_SIZE, CATALOG_VALIDATION.MAX_PAGE_SIZE);
  // NaN は比較がすべて偽になるので、「範囲内」を肯定で書いて否定する
  if (!(offset >= 0 && Number.isSafeInteger(offset)) || limit === null) {
    return { error: createValidationError(CATALOG_VALIDATION.ERROR_MESSAGES.PAGE_INVALID) };
  }
  return { query: { kind, offset, limit } };
}

/**
 * 図鑑の項目の詳細（GET /api/catalog/entry）のクエリを検証する
 *
 * 順は種類 → 名前 → 名前の長さ → 写真のページ（docs/05_api_design.md §5.14）。
 * 写真のページ（limit・継続トークン）は写真の一覧（GET /api/photos）と同じ規則と文言
 * @param query リクエストのクエリ（名前は URL エンコードされて届き、get が復号する）
 * @returns 検証を通ったクエリ（名前は前後の空白を除いたもの）、または 400 の応答
 */
export function readCatalogEntryQuery(
  query: URLSearchParams
): { query: CatalogEntryQuery } | { error: HttpResponseInit } {
  const kind = query.get('kind');
  if (!isListedInCatalog(kind)) {
    return { error: createValidationError(CATALOG_VALIDATION.ERROR_MESSAGES.KIND_INVALID) };
  }
  const name = query.get('name')?.trim() ?? '';
  if (name === '') {
    return { error: createValidationError(CATALOG_VALIDATION.ERROR_MESSAGES.NAME_REQUIRED) };
  }
  if (name.length > CATALOG_VALIDATION.NAME_MAX_LENGTH) {
    return { error: createValidationError(CATALOG_VALIDATION.ERROR_MESSAGES.NAME_TOO_LONG) };
  }
  const page = readPhotoPage(query);
  if ('error' in page) {
    return page;
  }
  return { query: { kind, name, ...page.page } };
}
