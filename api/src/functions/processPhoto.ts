import { app, InvocationContext } from '@azure/functions';
import { AlbumService } from '../services/albumService';
import { PhotoClassifierService } from '../services/photoClassifierService';
import { PhotoStorageService } from '../services/photoStorageService';
import { CLASSIFY_IMAGE_SAS_MINUTES, photoProcessingMaxAttempts } from '../constants/album';
import { UpstreamError } from '../utils/errors';
import { PhotoDocument, PhotoProcessing } from '../types/album';
import { PHOTO_VALIDATION } from '../constants/validation';
import { isCatalogKind } from '../catalog/kinds';
import { PhotoIdentifierService } from '../services/photoIdentifierService';
import { enqueuePhotoOrLog } from '../services/photoQueueService';

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
  // やる処理は写真の step から読む（分類か識別）。待ち（state が pending）かどうかは、担当の条件付き patch が見る。
  // 読んだ値で先に判断しても、読んでから担当するまでの間に変わりうるので、判断を1か所（Cosmos が原子的に評価する条件）にまとめる
  const step = photo.processing.step;
  if (step !== 'classify' && step !== 'identify') {
    context.log(`解析の待ちではありません（何もしません）: ID=${photoId}, 読んだ状態=${photo.processing.state}`);
    return;
  }
  const label = step === 'classify' ? '分類' : '識別';
  const attempts = photo.processing.attempts + 1;
  const claimedProcessing: PhotoProcessing = {
    ...photo.processing,
    state: step === 'classify' ? 'classifying' : 'identifying',
    step,
    attempts,
    updatedAt: new Date().toISOString(),
  };
  // 読んだときのまま（待ちで、step も読んだまま）のときだけ担当する
  const claimed = await album.claimPhotoProcessing(photo.id, { ...photo.processing, state: 'pending', step }, claimedProcessing);
  if (!claimed) {
    context.log(`${label}の待ちではないか、別のインスタンスが先に担当しました（何もしません）: ID=${photoId}, 読んだ状態=${photo.processing.state}, 処理=${step}`);
    return;
  }

  try {
    const storage = new PhotoStorageService();
    const imageUrl = storage.readUrl(photo.blobName, new Date(Date.now() + CLASSIFY_IMAGE_SAS_MINUTES * 60 * 1000));
    if (step === 'classify') {
      await classifyPhoto(album, photo, claimedProcessing, imageUrl, context);
    } else {
      await identifyPhoto(album, photo, claimedProcessing, imageUrl, context);
    }
  } catch (error: any) {
    // どこで失敗したかだけを書く。例外のメッセージは書かない（SDK 由来の文言が写真に残り続ける）
    const lastError = error instanceof UpstreamError ? error.service : 'internal';
    // 上限で止める。同じ画像で AI が毎回失敗しても、再試行を占有し続けない（06 §1.3）
    const failed = attempts >= photoProcessingMaxAttempts();
    // 失敗の記録より先にログを出す。記録も失敗したとき（Cosmos の障害など）に、元の原因が残らなくなるため
    context.log(`写真の${label}に失敗しました: ID=${photo.id}, 回数=${attempts}, 失敗した所=${lastError}${failed ? '（上限のため失敗にします）' : ''}`, error);
    const written = await album.writeProcessing(photo.id, claimedProcessing, {
      state: failed ? 'failed' : 'pending',
      step,
      attempts,
      lastError,
      updatedAt: new Date().toISOString(),
    });
    if (!written) {
      // やり直しの受付で積んだメッセージが、改めて担当する
      context.log(`${label}の間にやり直しの受付が入ったので、この失敗は書きません: ID=${photo.id}`);
      return;
    }
    if (!failed) {
      // 待ちに戻したので、キューの再試行（可視性タイムアウトの後）で担当し直せる
      throw error;
    }
  }
}

/**
 * 担当した写真を分類し、結果を書く。種類が図鑑の種類なら識別の待ちにして積む（06 §2.3）
 *
 * 失敗は投げる（呼び出し側が待ちに戻すか failed にする）
 */
async function classifyPhoto(
  album: AlbumService,
  photo: PhotoDocument,
  claimedProcessing: PhotoProcessing,
  imageUrl: string,
  context: InvocationContext
): Promise<void> {
  const attempts = claimedProcessing.attempts;
  const result = await new PhotoClassifierService().classify(imageUrl, {
    placeName: photo.location?.placeName ?? null,
    hint: photo.hint,
  });

  const now = new Date().toISOString();
  const identifies = isCatalogKind(result.kind);
  const written = await album.writeClassification(photo.id, claimedProcessing, {
    category: result.kind,
    classification: { kind: result.kind, confidence: result.confidence, model: result.model, at: now },
    processing: identifies
      ? { state: 'pending', step: 'identify', attempts: 0, lastError: null, updatedAt: now }
      : { state: 'done', step: 'classify', attempts, lastError: null, updatedAt: now },
    updatedAt: now,
  });
  if (!written) {
    context.log(`分類の間にやり直しの受付が入ったので、この結果は書きません: ID=${photo.id}`);
    return;
  }
  context.log(`写真の分類が済みました: ID=${photo.id}, 種類=${result.kind}`);
  if (identifies) {
    await enqueuePhotoOrLog(photo.id, context.log.bind(context));
  }
}

/**
 * 担当した写真を識別し、AI のコメントと結果を書く（06 §3.2）
 *
 * 失敗は投げる（呼び出し側が待ちに戻すか failed にする）
 */
async function identifyPhoto(
  album: AlbumService,
  photo: PhotoDocument,
  claimedProcessing: PhotoProcessing,
  imageUrl: string,
  context: InvocationContext
): Promise<void> {
  const attempts = claimedProcessing.attempts;
  // 分類を経ずに識別の待ちになった写真（ふつうは起きない）は、識別の対象にできないので AI を呼ばない。
  // UpstreamError ではないので内部の失敗として数える（06 §3.1）
  const kind = photo.category;
  if (!isCatalogKind(kind)) {
    throw new Error(`写真の種類が図鑑の種類ではありません: ${kind}`);
  }
  const result = await new PhotoIdentifierService().identify(imageUrl, kind, {
    placeName: photo.location?.placeName ?? null,
    takenAt: photo.takenAt,
    hint: photo.hint,
  });

  const now = new Date().toISOString();
  if (result.matchesKind && result.comment !== null) {
    // 利用者がコメントを書いていたら書かない（false が返る）。それでも結果は書く
    await album.writeAiComment(photo.id, claimedProcessing, result.comment);
  }
  const identification = result.matchesKind
    ? {
        kind,
        matchesKind: true,
        name: result.name,
        confidence: result.confidence,
        description: result.description,
        characteristics: result.characteristics,
        attributes: result.attributes,
        reason: null,
        model: result.model,
        at: now,
      }
    : {
        // 図鑑に出ない形。AI のコメントは理由として残し、写真のコメントには書かない（06 §3.2）
        kind,
        matchesKind: false,
        name: null,
        confidence: result.confidence,
        description: null,
        characteristics: null,
        attributes: {},
        reason: result.comment,
        model: result.model,
        at: now,
      };
  const written = await album.writeIdentification(photo.id, claimedProcessing, {
    identification,
    processing: { state: 'done', step: 'identify', attempts, lastError: null, updatedAt: now },
    updatedAt: now,
  });
  if (!written) {
    context.log(`識別の間にやり直しの受付が入ったので、この結果は書きません: ID=${photo.id}`);
    return;
  }
  context.log(`写真の識別が済みました: ID=${photo.id}, 種類=${kind}, 名前=${identification.name}`);
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
