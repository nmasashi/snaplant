import { app, InvocationContext, Timer } from '@azure/functions';
import { AlbumService } from '../services/albumService';
import { PhotoStorageService } from '../services/photoStorageService';
import { ORPHAN_BLOB_MIN_AGE_HOURS } from '../constants/album';
import { PHOTO_VALIDATION } from '../constants/validation';

/**
 * 写真の Blob 名（<写真 ID>.<拡張子> と <写真 ID>.thumb.jpg）から写真 ID を取り出す
 * @returns 写真 ID。最初の「.」の前が写真 ID の形式でなければ null
 */
function photoIdOfBlob(blobName: string): string | null {
  const dot = blobName.indexOf('.');
  if (dot === -1) {
    return null;
  }
  const head = blobName.slice(0, dot);
  return PHOTO_VALIDATION.ID_REGEX.test(head) ? head : null;
}

/**
 * 掃除のタイマー（1日1回、日本時間の午前3時）
 *
 * 途中で止まった操作の残骸を片付ける（docs/04_data_design.md §7.2）。
 * 1. 写真の文書の無い Blob のうち、1日より古いものを消す
 * 2. 消えた旅行を指す写真を、どの旅行にも属さない写真に戻す（消さない）
 * 3. 原寸の Blob の無い写真の文書をログに出す（消さない。手で直す）
 */
export async function sweepAlbumHandler(_timer: Timer, context: InvocationContext): Promise<void> {
  const album = new AlbumService();
  const storage = new PhotoStorageService();
  // 写真の文書は Blob より先に読む。読んだ後に送られた写真の Blob は新しいので、1 では消さない
  const photos = await album.listPhotoRefs();
  const tripIds = new Set(await album.listTripIds());
  const photoIds = new Set(photos.map((photo) => photo.id));
  const oldestKept = Date.now() - ORPHAN_BLOB_MIN_AGE_HOURS * 60 * 60 * 1000;

  const blobNames = new Set<string>();
  const deletedBlobs: string[] = [];
  for await (const blob of storage.listBlobs()) {
    blobNames.add(blob.name);
    const photoId = photoIdOfBlob(blob.name);
    // 名前から写真を決められない Blob と、文書のある写真の Blob と、新しい Blob は残す
    if (photoId === null || photoIds.has(photoId) || blob.lastModified.getTime() >= oldestKept) {
      continue;
    }
    try {
      await storage.delete(blob.name);
      deletedBlobs.push(photoId);
    } catch (error: any) {
      context.log(`文書の無い Blob を消せませんでした（次の回にもう一度消します）: 写真ID=${photoId}`, error);
    }
  }
  // 件数と写真 ID だけを出す（ファイル名や地名は出さない。05 §1）。手順ごとに出し、後の手順が失敗しても記録が残るようにする
  context.log(`掃除のタイマー: 文書の無い Blob を消した ${deletedBlobs.length} 件`);
  if (deletedBlobs.length > 0) context.log(`Blob を消した写真ID: ${[...new Set(deletedBlobs)].join(', ')}`);

  const missingBlobs = photos.filter((photo) => !blobNames.has(photo.blobName)).map((photo) => photo.id);
  if (missingBlobs.length > 0) context.log(`原寸の Blob が無い写真ID（手で直す）: ${missingBlobs.join(', ')}`);

  const detached: string[] = [];
  for (const photo of photos) {
    if (photo.tripId === null || tripIds.has(photo.tripId)) {
      continue;
    }
    try {
      if (await album.detachPhotoFromMissingTrip(photo.id, photo.tripId)) {
        detached.push(photo.id);
      }
    } catch (error: any) {
      // 1枚の失敗（429 など）で残りを止めない。未所属に戻すのはこのタイマーだけなので、次の回にもう一度戻す
      context.log(`消えた旅行を指す写真を未所属に戻せませんでした（次の回にもう一度戻します）: 写真ID=${photo.id}`, error);
    }
  }

  context.log(`掃除のタイマー: 未所属に戻した写真 ${detached.length} 枚`);
  if (detached.length > 0) context.log(`未所属に戻した写真ID: ${detached.join(', ')}`);
}

app.timer('sweepAlbum', {
  // 秒 分 時 日 月 曜日（UTC）。18 時は日本時間の午前3時
  schedule: '0 0 18 * * *',
  handler: sweepAlbumHandler,
});
