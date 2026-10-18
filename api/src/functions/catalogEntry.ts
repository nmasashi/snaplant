import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { AlbumService } from '../services/albumService';
import { PhotoStorageService } from '../services/photoStorageService';
import { coverUrlMaker, photoListResponseData } from '../services/photoView';
import { createDatabaseErrorResponse, createSuccessResponse, createValidationError } from '../utils/response';
import { readCatalogEntryQuery } from '../utils/catalogInput';

/**
 * 図鑑の項目の詳細 API（項目の見出しと、その写真の1ページ）
 * GET /api/catalog/entry?kind={kind}&name={name}&limit={limit}&continuationToken={token}&code={FUNCTION_KEY}
 *
 * 項目は種類と名前で指定する（名前はクエリ文字列に URL エンコードして載せる。docs/travel-album/05_api_design.md §5.14）。
 * 該当する写真が無ければ 200 で entry: null（項目は文書ではなく「その写真が0枚」に過ぎないので 404 にしない）
 */
export async function getCatalogEntryHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log('図鑑の項目の詳細リクエストを受信');
  const validated = readCatalogEntryQuery(request.query);
  if ('error' in validated) {
    return validated.error;
  }
  try {
    const storage = new PhotoStorageService();
    let result;
    try {
      result = await new AlbumService().getCatalogEntry(validated.query, coverUrlMaker());
    } catch (error: any) {
      // JSON としては読めるが Cosmos が受け付けない継続トークンは、サーバが 400 で拒む（写真の一覧と同じ扱い）
      if (validated.query.continuationToken !== undefined && error.code === 400) {
        return createValidationError('継続トークンの形式が無効です');
      }
      throw error;
    }
    return createSuccessResponse({
      entry: result.entry,
      ...photoListResponseData(result.photos, storage),
      continuationToken: result.continuationToken,
    });
  } catch (error: any) {
    context.log('図鑑の項目の詳細の取得エラー:', error);
    return createDatabaseErrorResponse(error, '図鑑の項目の取得に失敗しました');
  }
}

app.http('getCatalogEntry', {
  methods: ['GET'],
  authLevel: 'function',
  route: 'catalog/entry',
  handler: getCatalogEntryHandler,
});
