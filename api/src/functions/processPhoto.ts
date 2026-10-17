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
  const photoId = (message as { photoId: string }).photoId;
  const album = new AlbumService();
  const photo = (await album.getPhoto(photoId))!;

  const storage = new PhotoStorageService();
  const imageUrl = storage.readUrl(photo.blobName, new Date(Date.now() + CLASSIFY_IMAGE_SAS_MINUTES * 60 * 1000));
  const result = await new PhotoClassifierService().classify(imageUrl, photo.location?.placeName ?? null);

  const now = new Date().toISOString();
  await album.writeClassification(photo.id, {
    category: result.kind,
    classification: { kind: result.kind, confidence: result.confidence, model: result.model, at: now },
    processing: { state: 'done', step: 'classify', attempts: photo.processing.attempts + 1, lastError: null, updatedAt: now },
    updatedAt: now,
  });
  context.log(`写真の分類が済みました: ID=${photo.id}, 種類=${result.kind}`);
}

app.storageQueue('processPhoto', {
  // キューの名前はアプリの設定（Terraform が入れる）。投入する側（PhotoQueueService）と同じ値
  queueName: '%PHOTO_QUEUE_NAME%',
  connection: 'AzureWebJobsStorage',
  handler: processPhotoHandler,
});
