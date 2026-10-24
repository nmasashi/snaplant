import { app, InvocationContext, Timer } from '@azure/functions';
import { AlbumService } from '../services/albumService';
import { enqueuePhotoOrLog } from '../services/photoQueueService';
import { TimelineService } from '../services/timelineService';
import { enqueueTimelineOrLog } from '../services/timelineQueueService';
import { PHOTO_REQUEUE_AFTER_MINUTES, UNFINISHED_PROCESSING_STATES, photoProcessingMaxAttempts } from '../constants/album';


/**
 * 再投入のタイマー（10 分ごと）
 *
 * 解析待ち・処理中のまま止まった写真（投入に失敗した、処理中に落ちた、メッセージが poison に落ちた）を拾い、
 * 解析待ちに戻してキューに積む。回数が上限なら積まずに失敗にする（docs/06_processing_design.md §1）。
 * タイムラインの下書き（段階5）も同じ形で拾う（06 §8.1）
 */
export async function requeueStalePhotosHandler(_timer: Timer, context: InvocationContext): Promise<void> {
  const now = new Date();
  const before = new Date(now.getTime() - PHOTO_REQUEUE_AFTER_MINUTES * 60 * 1000).toISOString();
  const maxAttempts = photoProcessingMaxAttempts();
  // 写真と下書きは別々に進める。片方の失敗（写真1枚の書き込みの失敗など）で、もう片方が止まったままにならないように。
  // 失敗は最後に投げる（次の回にやり直す。ログにも残す）
  const results = await Promise.allSettled([
    requeuePhotos(now, before, maxAttempts, context),
    requeueDrafts(now, before, maxAttempts, context),
  ]);
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (rejected) {
    throw rejected.reason;
  }
}

/** 止まった写真を解析待ちに戻して積む。上限なら失敗にする（06 §1.1） */
async function requeuePhotos(now: Date, before: string, maxAttempts: number, context: InvocationContext): Promise<void> {
  const album = new AlbumService();
  const photos = await album.listStalePhotos(before);

  let requeued = 0;
  let failed = 0;
  for (const photo of photos) {
    const read = photo.processing;
    // SQL と同じ条件をコードでも見る。SQL の絞り込みはテストで確かめられない（手で確かめる項目）ので、
    // 崩れても failed や none を拾わない（永遠に回り続けない・意図せず課金しない）ことを、ここでも守る
    if (!UNFINISHED_PROCESSING_STATES.includes(read.state) || read.updatedAt === null || !(read.updatedAt < before)) {
      continue;
    }
    const giveUp = read.attempts >= maxAttempts;
    // ワーカーは解析待ち（pending）の写真しか担当しないので、処理中の写真は解析待ちに戻してから積む
    const written = await album.writeProcessing(photo.id, read, {
      ...read,
      state: giveUp ? 'failed' : 'pending',
      updatedAt: now.toISOString(),
    });
    if (!written) {
      continue;
    }
    if (giveUp) {
      failed += 1;
    } else if (await enqueuePhotoOrLog(photo.id, (...args) => context.log(...args))) {
      requeued += 1;
    }
  }
  context.log(`再投入のタイマー: 止まっていた写真 ${photos.length} 枚、積んだ ${requeued} 枚、失敗にした ${failed} 枚`);
}

/** 止まったタイムラインの下書き（段階5）を、写真と同じく待ちに戻して積む。上限なら失敗にする（06 §8.1） */
async function requeueDrafts(now: Date, before: string, maxAttempts: number, context: InvocationContext): Promise<void> {
  const timelines = new TimelineService();
  const drafts = await timelines.listStaleDrafts(before);
  let requeuedDrafts = 0;
  let failedDrafts = 0;
  for (const { tripId, draft } of drafts) {
    const job = draft?.job;
    // SQL と同じ条件をコードでも見る（写真と同じ理由。failed や確かめ中の下書きを拾わない）
    if (!draft || !job || (job.state !== 'pending' && job.state !== 'running') || !(job.updatedAt < before)) {
      continue;
    }
    const giveUp = job.attempts >= maxAttempts;
    const written = await timelines.writeDraftJob(tripId, draft.id, job, {
      ...job,
      state: giveUp ? 'failed' : 'pending',
      updatedAt: now.toISOString(),
    });
    if (!written) {
      continue;
    }
    if (giveUp) {
      failedDrafts += 1;
    } else if (await enqueueTimelineOrLog(tripId, draft.id, (...args) => context.log(...args))) {
      requeuedDrafts += 1;
    }
  }
  context.log(`再投入のタイマー: 止まっていたタイムラインの下書き ${drafts.length} 件、積んだ ${requeuedDrafts} 件、失敗にした ${failedDrafts} 件`);
}

app.timer('requeueStalePhotos', {
  schedule: '0 */10 * * * *',
  handler: requeueStalePhotosHandler,
});
