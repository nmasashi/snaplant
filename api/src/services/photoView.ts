import { Photo, PhotoDocument, PhotoTag, StoredPhotoTag } from '../types/album';
import { PhotoStorageService, photoUrlExpiresOn } from './photoStorageService';

/**
 * 写真のドキュメントを応答の形にする
 *
 * Blob 名の代わりに SAS 付きの URL を入れ、type と Cosmos のシステム項目は出さない。
 * スプレッドで除く形にするとシステム項目（_rid・_etag など）まで漏れるので、項目を列挙する
 * @param doc 写真のドキュメント
 * @param storage URL を作る写真の Blob のサービス
 * @param expiresOn URL の有効期限
 */
export function toPhoto(doc: PhotoDocument, storage: PhotoStorageService, expiresOn: Date): Photo {
  return {
    id: doc.id,
    tripId: doc.tripId,
    imageUrl: storage.readUrl(doc.blobName, expiresOn),
    thumbnailUrl: doc.thumbnailBlobName ? storage.readUrl(doc.thumbnailBlobName, expiresOn) : null,
    contentType: doc.contentType,
    fileSize: doc.fileSize,
    takenAt: doc.takenAt,
    takenAtSource: doc.takenAtSource,
    sortAt: doc.sortAt,
    location: doc.location,
    category: doc.category,
    categorySource: doc.categorySource ?? null,
    // C-3a より前は文字列の配列だった（画面が無く、本番は空のはず）。名前・種類・位置の形のタグだけを返す（04 §2）。欄の無い文書はタグ無し
    // C-4 より前のタグには出どころが無い。利用者が付けたものなので user として返す
    tags: (doc.tags ?? [])
      .filter((tag): tag is StoredPhotoTag => typeof tag === 'object' && tag !== null)
      .map((tag): PhotoTag => ({ name: tag.name, kind: tag.kind, x: tag.x, y: tag.y, source: tag.source ?? 'user' })),
    comment: doc.comment,
    commentSource: doc.commentSource,
    hint: doc.hint,
    classification: doc.classification,
    identification: doc.identification,
    processing: doc.processing,
    uploadedAt: doc.uploadedAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * 表紙の URL を作る関数を返す
 *
 * 写真の Blob のサービスは、表紙にする写真が見つかって初めて作る（写真の無い旅行だけなら Blob の設定を読まない）
 */
export function coverUrlMaker(): (blobName: string) => string {
  const expiresOn = photoUrlExpiresOn();
  let storage: PhotoStorageService | null = null;
  return (blobName) => {
    storage ??= new PhotoStorageService();
    return storage.readUrl(blobName, expiresOn);
  };
}

/**
 * 写真の一覧の応答の data（写真と、その URL の有効期限）を作る
 *
 * 一覧のすべての URL に同じ期限を使う（クライアントは urlExpiresAt を見てページを取り直す）
 * @param docs 写真のドキュメント
 * @param storage URL を作る写真の Blob のサービス
 */
export function photoListResponseData(
  docs: PhotoDocument[],
  storage: PhotoStorageService,
  expiresOn: Date = photoUrlExpiresOn()
): { photos: Photo[]; urlExpiresAt: string } {
  return { photos: docs.map((doc) => toPhoto(doc, storage, expiresOn)), urlExpiresAt: expiresOn.toISOString() };
}

/**
 * 写真1枚の応答の data（写真と、その URL の有効期限）を作る
 *
 * URL の期限はこの応答を作るときに決める。クライアントは urlExpiresAt を見て取り直す
 * @param doc 写真のドキュメント
 * @param storage URL を作る写真の Blob のサービス
 */
export function photoResponseData(doc: PhotoDocument, storage: PhotoStorageService): { photo: Photo; urlExpiresAt: string } {
  const expiresOn = photoUrlExpiresOn();
  return { photo: toPhoto(doc, storage, expiresOn), urlExpiresAt: expiresOn.toISOString() };
}
