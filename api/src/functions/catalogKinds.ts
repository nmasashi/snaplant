import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { CATALOG_KINDS, isListedInCatalog } from '../catalog/kinds';
import { createSuccessResponse } from '../utils/response';

/**
 * 図鑑の種類の一覧 API（定義表から。DB に触らない）
 * GET /api/catalog/kinds
 *
 * アプリは種類のタブと項目詳細の欄をここから作る（docs/04_data_design.md §3.2）。
 * AI に渡す指示（各項目の prompt・namingRule・commentRule）はアプリに要らないので返さない
 */
export async function listCatalogKindsHandler(
  _request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  context.log('図鑑の種類の一覧リクエストを受信');
  // 識別できても図鑑に載せない種類（食べ物・風景）は返さない（02 §5 #51）
  const kinds = Object.entries(CATALOG_KINDS)
    .filter(([kind]) => isListedInCatalog(kind))
    .map(([kind, { label, fields }]) => ({
      kind,
      label,
      fields: fields.map(({ key, label: fieldLabel, type }) => ({ key, label: fieldLabel, type })),
    }));
  return createSuccessResponse({ kinds });
}

app.http('listCatalogKinds', {
  methods: ['GET'],
  authLevel: 'function',
  route: 'catalog/kinds',
  handler: listCatalogKindsHandler,
});
