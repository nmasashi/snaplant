import { app, InvocationContext } from '@azure/functions';
import { AlbumService } from '../services/albumService';
import { PhotoClassifierService } from '../services/photoClassifierService';
import { PhotoStorageService } from '../services/photoStorageService';

/** AI に渡す原寸の SAS の有効期限（分）。AI が画像を取りに来るまでの間だけ開ける（一時画像と同じ理由。06 §2.1） */
const CLASSIFY_IMAGE_SAS_MINUTES = 15;

/**
 * 写真の解析のワーカー（キュー photo-processing のメッセージ `{ photoId }` で動く）
 *
 * メッセージは「この写真を見ろ」という合図だけで、やる処理は写真の processing から読む
 * （docs/travel-album/06_processing_design.md §1）
 */
export async function processPhotoHandler(message: unknown, context: InvocationContext): Promise<void> {
  const photoId = photoIdOf(message);
  if (photoId === null) {
    // 読めないメッセージは何度送り直しても読めない。例外にすると poison に落ちるだけなので、ログを出して終える
    context.log('解析のメッセージに写真IDがありません（何もしません）');
    return;
  }
  const album = new AlbumService();
  const photo = await album.getPhoto(photoId);
  if (!photo) {
    context.log(`写真がありません（消された後のメッセージ。何もしません）: ID=${photoId}`);
    return;
  }
  // 分類の待ち（pending）かどうかは、担当の条件付き patch が見る。読んだ値で先に判断しても、
  // 読んでから担当するまでの間に変わりうるので、判断を1か所（Cosmos が原子的に評価する条件）にまとめる
  const attempts = photo.processing.attempts + 1;
  const claimed = await album.claimPhotoProcessing(photo.id, {
    ...photo.processing,
    state: 'classifying',
    attempts,
    updatedAt: new Date().toISOString(),
  });
  if (!claimed) {
    context.log(`分類の待ちではないか、別のインスタンスが先に担当しました（何もしません）: ID=${photoId}, 読んだ状態=${photo.processing.state}`);
    return;
  }

  const storage = new PhotoStorageService();
  const imageUrl = storage.readUrl(photo.blobName, new Date(Date.now() + CLASSIFY_IMAGE_SAS_MINUTES * 60 * 1000));
  const result = await new PhotoClassifierService().classify(imageUrl, photo.location?.placeName ?? null);

  const now = new Date().toISOString();
  await album.writeClassification(photo.id, {
    category: result.kind,
    classification: { kind: result.kind, confidence: result.confidence, model: result.model, at: now },
    processing: { state: 'done', step: 'classify', attempts, lastError: null, updatedAt: now },
    updatedAt: now,
  });
  context.log(`写真の分類が済みました: ID=${photo.id}, 種類=${result.kind}`);
}

/**
 * キューのメッセージから写真 ID を取り出す（トリガーは JSON の本文をオブジェクトにして渡す）
 * @returns 写真 ID。読めなければ null
 */
function photoIdOf(message: unknown): string | null {
  const photoId = (message as { photoId?: unknown } | null)?.photoId;
  // 形式（SHA-256 の16進）は見ない。形式の違う ID は写真が見つからず、何もせずに終わる
  return typeof photoId === 'string' ? photoId : null;
}

app.storageQueue('processPhoto', {
  // キューの名前はアプリの設定（Terraform が入れる）。投入する側（PhotoQueueService）と同じ値
  queueName: '%PHOTO_QUEUE_NAME%',
  connection: 'AzureWebJobsStorage',
  handler: processPhotoHandler,
});
