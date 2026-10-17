import { app, InvocationContext } from '@azure/functions';
import { AlbumService } from '../services/albumService';
import { PhotoClassifierService } from '../services/photoClassifierService';
import { PhotoStorageService } from '../services/photoStorageService';
import { CLASSIFY_IMAGE_SAS_MINUTES, photoProcessingMaxAttempts } from '../constants/album';
import { UpstreamError } from '../utils/errors';
import { PHOTO_VALIDATION } from '../constants/validation';

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
  // 分類の待ち（state が pending で step が classify）かどうかは、担当の条件付き patch が見る。読んだ値で先に判断しても、
  // 読んでから担当するまでの間に変わりうるので、判断を1か所（Cosmos が原子的に評価する条件）にまとめる。
  // 段階3のワーカーがやるのは分類だけ（識別は段階4）で、step が classify でない写真は担当できずに終わる
  const attempts = photo.processing.attempts + 1;
  const claimed = await album.claimPhotoProcessing(photo.id, 'classify', photo.processing.attempts, {
    ...photo.processing,
    state: 'classifying',
    attempts,
    updatedAt: new Date().toISOString(),
  });
  if (!claimed) {
    context.log(`分類の待ちではないか、別のインスタンスが先に担当しました（何もしません）: ID=${photoId}, 読んだ状態=${photo.processing.state}, 処理=${photo.processing.step}`);
    return;
  }

  try {
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
  } catch (error: any) {
    // どこで失敗したかだけを書く。例外のメッセージは書かない（SDK 由来の文言が写真に残り続ける）
    const lastError = error instanceof UpstreamError ? error.service : 'internal';
    // 上限で止める。同じ画像で AI が毎回失敗しても、再試行を占有し続けない（06 §1.3）
    const failed = attempts >= photoProcessingMaxAttempts();
    // 失敗の記録より先にログを出す。記録も失敗したとき（Cosmos の障害など）に、元の原因が残らなくなるため
    context.log(`写真の分類に失敗しました: ID=${photo.id}, 回数=${attempts}, 失敗した所=${lastError}${failed ? '（上限のため失敗にします）' : ''}`, error);
    await album.writeProcessing(photo.id, {
      state: failed ? 'failed' : 'pending',
      step: 'classify',
      attempts,
      lastError,
      updatedAt: new Date().toISOString(),
    });
    if (!failed) {
      // 分類の待ちに戻したので、キューの再試行（可視性タイムアウトの後）で担当し直せる
      throw error;
    }
  }
}

/**
 * キューのメッセージから写真 ID を取り出す（トリガーは JSON の本文をオブジェクトにして渡す）
 * @returns 写真 ID。読めなければ null
 */
function photoIdOf(message: unknown): string | null {
  const photoId = (message as { photoId?: unknown } | null)?.photoId;
  // 形式（SHA-256 の16進）も見る。Cosmos の SDK は / \ # を含む id や空の id で通信の前に投げるので、
  // 見ないと読めないメッセージが例外になって poison に落ちる
  return typeof photoId === 'string' && PHOTO_VALIDATION.ID_REGEX.test(photoId) ? photoId : null;
}

app.storageQueue('processPhoto', {
  // キューの名前はアプリの設定（Terraform が入れる）。投入する側（PhotoQueueService）と同じ値
  queueName: '%PHOTO_QUEUE_NAME%',
  connection: 'AzureWebJobsStorage',
  handler: processPhotoHandler,
});
