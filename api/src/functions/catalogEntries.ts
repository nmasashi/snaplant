import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { AlbumService } from '../services/albumService';
import { coverUrlMaker } from '../services/photoView';
import { createDatabaseErrorResponse, createSuccessResponse } from '../utils/response';
import { readCatalogEntriesQuery } from '../utils/catalogInput';

/**
 * 図鑑の項目の一覧 API（種類ごと。名前順に offset / limit でページに切る）
 * GET /api/catalog/entries?kind={kind}&offset={offset}&limit={limit}&code={FUNCTION_KEY}
 *
 * 項目は文書ではなく、識別済みの写真を名前でまとめたもの（docs/travel-album/04_data_design.md §3.1）
 */
export async function listCatalogEntriesHandler(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  context.log('図鑑の項目の一覧リクエストを受信');
  const validated = readCatalogEntriesQuery(request.query);
  if ('error' in validated) {
    return validated.error;
  }
  try {
    const page = await new AlbumService().listCatalogEntries(validated.query, coverUrlMaker());
    return createSuccessResponse(page);
  } catch (error: any) {
    context.log('図鑑の項目の一覧の取得エラー:', error);
    return createDatabaseErrorResponse(error, '図鑑の一覧の取得に失敗しました');
  }
}

app.http('listCatalogEntries', {
  methods: ['GET'],
  authLevel: 'function',
  route: 'catalog/entries',
  handler: listCatalogEntriesHandler,
});
