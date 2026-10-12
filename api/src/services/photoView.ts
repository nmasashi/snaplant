import { Photo, PhotoDocument } from '../types/album';
import { PhotoStorageService } from './photoStorageService';

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
    tags: doc.tags,
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
