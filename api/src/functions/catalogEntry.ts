import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { AlbumService } from '../services/albumService';
import { PhotoStorageService, photoUrlExpiresOn } from '../services/photoStorageService';
import { photoListResponseData } from '../services/photoView';
import { createDatabaseErrorResponse, createSuccessResponse, createValidationError } from '../utils/response';
import { readCatalogEntryQuery } from '../utils/catalogInput';
import { InvalidContinuationTokenError } from '../utils/errors';
import { PHOTO_VALIDATION } from '../constants/validation';

/**
 * 図鑑の項目の詳細 API（項目の見出しと、その写真の1ページ）
 * GET /api/catalog/entry?kind={kind}&name={name}&limit={limit}&continuationToken={token}&code={FUNCTION_KEY}
 *
 * 項目は種類と名前で指定する（名前はクエリ文字列に URL エンコードして載せる。docs/05_api_design.md §5.14）。
 * 該当する写真が無ければ 200 で entry: null（項目は文書ではなく「その写真が0枚」に過ぎないので 404 にしない）
 */
export async function getCatalogEntryHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log('図鑑の項目の詳細リクエストを受信');
  const validated = readCatalogEntryQuery(request.query);
  if ('error' in validated) {
    return validated.error;
  }
  try {
    // 表紙と写真の URL の期限を1つにそろえる。保存先は URL を作るときに初めて作る（項目が無ければ保存先の設定を読まない）
    const expiresOn = photoUrlExpiresOn();
    let storage: PhotoStorageService | null = null;
    const storageOf = () => (storage ??= new PhotoStorageService());
    let result;
    try {
      result = await new AlbumService().getCatalogEntry(validated.query, (blobName) =>
        storageOf().readUrl(blobName, expiresOn)
      );
    } catch (error: any) {
      if (error instanceof InvalidContinuationTokenError) {
        return createValidationError(PHOTO_VALIDATION.ERROR_MESSAGES.CONTINUATION_TOKEN_INVALID);
      }
      throw error;
    }
    if (result.entry === null) {
      return createSuccessResponse({ entry: null, photos: [], urlExpiresAt: expiresOn.toISOString(), continuationToken: null });
    }
    return createSuccessResponse({
      entry: result.entry,
      ...photoListResponseData(result.photos, storageOf(), expiresOn),
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
