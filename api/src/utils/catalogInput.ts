import { HttpResponseInit } from '@azure/functions';
import { createValidationError } from './response';
import { CATALOG_VALIDATION } from '../constants/validation';
import { isCatalogKind } from '../catalog/kinds';
import { CatalogEntriesQuery } from '../types/album';
import { readPageLimit } from './pageLimit';

/**
 * 図鑑の項目の一覧（GET /api/catalog/entries）のクエリを検証する
 *
 * 順は種類 → ページ（docs/travel-album/05_api_design.md §5.14）。Cosmos に触る前に全部弾く。
 * 「無い」と「空」を分ける（無ければ既定、空なら 400。写真の一覧の limit と同じ）
 * @param query リクエストのクエリ
 * @returns 検証を通ったクエリ、または 400 の応答
 */
export function readCatalogEntriesQuery(
  query: URLSearchParams
): { query: CatalogEntriesQuery } | { error: HttpResponseInit } {
  const kind = query.get('kind');
  if (!isCatalogKind(kind)) {
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
