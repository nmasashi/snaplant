import { app, InvocationContext, Timer } from '@azure/functions';
import { AlbumService } from '../services/albumService';
import { PhotoStorageService } from '../services/photoStorageService';
import { ORPHAN_BLOB_MIN_AGE_HOURS } from '../constants/album';

/** 写真の Blob 名（<写真 ID>.<拡張子> と <写真 ID>.thumb.jpg）から写真 ID を取り出す */
const PHOTO_BLOB_NAME = /^([0-9a-f]{64})\./;

/**
 * 掃除のタイマー（1日1回、日本時間の午前3時）
 *
 * 途中で止まった操作の残骸を片付ける（docs/travel-album/04_data_design.md §7.2）。
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
    const match = PHOTO_BLOB_NAME.exec(blob.name);
    // 名前から写真を決められない Blob と、文書のある写真の Blob と、新しい Blob は残す
    if (!match || photoIds.has(match[1]) || blob.lastModified.getTime() >= oldestKept) {
      continue;
    }
    try {
      await storage.delete(blob.name);
      deletedBlobs.push(match[1]);
    } catch (error: any) {
      context.log(`文書の無い Blob を消せませんでした（次の回にもう一度消します）: 写真ID=${match[1]}`, error);
    }
  }

  const detached: string[] = [];
  for (const photo of photos) {
    if (photo.tripId !== null && !tripIds.has(photo.tripId) && (await album.detachPhotoFromMissingTrip(photo.id, photo.tripId))) {
      detached.push(photo.id);
    }
  }

  const missingBlobs = photos.filter((photo) => !blobNames.has(photo.blobName)).map((photo) => photo.id);

  // 件数と写真 ID だけを出す（ファイル名や地名は出さない。05 §1）
  context.log(
    `掃除のタイマー: 文書の無い Blob を消した ${deletedBlobs.length} 件、未所属に戻した写真 ${detached.length} 枚、原寸の Blob が無い写真 ${missingBlobs.length} 枚`
  );
  if (deletedBlobs.length > 0) context.log(`Blob を消した写真ID: ${[...new Set(deletedBlobs)].join(', ')}`);
  if (detached.length > 0) context.log(`未所属に戻した写真ID: ${detached.join(', ')}`);
  if (missingBlobs.length > 0) context.log(`原寸の Blob が無い写真ID（手で直す）: ${missingBlobs.join(', ')}`);
}

app.timer('sweepAlbum', {
  // 秒 分 時 日 月 曜日（UTC）。18 時は日本時間の午前3時
  schedule: '0 0 18 * * *',
  handler: sweepAlbumHandler,
});
