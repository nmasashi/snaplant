import { app, InvocationContext } from '@azure/functions';
import { AlbumService } from '../services/albumService';
import { TimelineService } from '../services/timelineService';
import { TimelineProposerService } from '../services/timelineProposerService';
import { datedDaysOf } from '../services/timelineView';
import { photoProcessingMaxAttempts } from '../constants/album';
import { TimelineCurrent, TimelineDraft, TimelineJob, TimelinePhotoSnapshot } from '../types/timeline';
import { UpstreamError } from '../utils/errors';
import { isValidUUID } from '../utils/response';

/**
 * タイムラインのワーカー（キュー timeline-processing のメッセージ `{ tripId, draftId }` で動く）
 *
 * メッセージは「この下書きを見ろ」という合図だけで、やる処理は下書きの job から読む（docs/06_processing_design.md §8.1）
 */
export async function processTimelineHandler(message: unknown, context: InvocationContext): Promise<void> {
  const ids = idsOf(message);
  if (ids === null) {
    // 読めないメッセージは何度送り直しても読めない。例外にすると poison に落ちるだけなので、ログを出して終える
    context.log('タイムラインのメッセージに旅行IDか下書きIDがありません（何もしません）');
    return;
  }
  const { tripId, draftId } = ids;
  const timelines = new TimelineService();
  const read = await timelines.readTimeline(tripId);
  const draft = read?.doc.draft;
  // やめた・出し直した下書きの古いメッセージ、担当済み・済んだ下書きは触らない
  if (!read || !draft || draft.id !== draftId || !draft.job || draft.job.state !== 'pending') {
    context.log(`処理を待っている下書きではありません（何もしません）: 旅行=${tripId}, 下書き=${draftId}`);
    return;
  }
  if (!(await new AlbumService().tripExists(tripId))) {
    // 旅行の削除と作る受付が重なって、旅行の無いタイムラインが残った（04 §7.1）。残しても誰も読めないので消す
    await timelines.deleteTripTimeline(tripId);
    context.log(`旅行が無いので、タイムラインと写真の控えを消しました: 旅行=${tripId}`);
    return;
  }
  const job = draft.job;
  if (job.step !== 'propose') {
    // 文を書く段（write）は 5-2 で入れる
    context.log(`まだ扱えない処理です（何もしません）: 旅行=${tripId}, 処理=${job.step}`);
    return;
  }

  const claimedJob: TimelineJob = { ...job, state: 'running', attempts: job.attempts + 1, updatedAt: new Date().toISOString() };
  // 読んだときのまま（同じ下書きで、待ちのまま）のときだけ担当する
  if (!(await timelines.writeDraftJob(tripId, draftId, job, claimedJob))) {
    context.log(`別のインスタンスが先に担当したか、下書きが変わりました（何もしません）: 旅行=${tripId}, 下書き=${draftId}`);
    return;
  }

  try {
    const snapshot = await timelines.readSnapshot(draft.snapshotId);
    if (!snapshot) {
      throw new Error(`写真の控えがありません: ${draft.snapshotId}`);
    }
    const starts = await proposeScenes(snapshot.photos, draft, read.doc.current);

    const now = new Date().toISOString();
    const current = await timelines.readTimeline(tripId);
    if (!current || current.doc.draft?.id !== draftId) {
      context.log(`区切り案の間に下書きが変わったので、この結果は書きません: 旅行=${tripId}, 下書き=${draftId}`);
      return;
    }
    await timelines.replaceTimeline(
      {
        ...current.doc,
        draft: { ...current.doc.draft, phase: 'reviewing', job: null, ...starts },
        updatedAt: now,
      },
      current.etag
    );
    context.log(`タイムラインの区切り案が済みました: 旅行=${tripId}, 下書き=${draftId}, 区切り=${starts.sceneStarts.length}`);
  } catch (error: any) {
    // どこで失敗したかだけを書く。例外のメッセージは書かない（SDK 由来の文言が文書に残り続ける）
    const lastError = error instanceof UpstreamError ? error.service : 'internal';
    // 上限で止める。同じ旅行で AI が毎回失敗しても、再試行を占有し続けない（06 §8.1）
    const failed = claimedJob.attempts >= photoProcessingMaxAttempts();
    // 失敗の記録より先にログを出す。記録も失敗したときに、元の原因が残らなくなるため
    context.log(`タイムラインの区切り案に失敗しました: 旅行=${tripId}, 回数=${claimedJob.attempts}, 失敗した所=${lastError}${failed ? '（上限のため失敗にします）' : ''}`, error);
    const written = await timelines.writeDraftJob(tripId, draftId, claimedJob, {
      ...claimedJob,
      state: failed ? 'failed' : 'pending',
      lastError,
      updatedAt: new Date().toISOString(),
    });
    if (!written) {
      context.log(`区切り案の間に下書きが変わったので、この失敗は書きません: 旅行=${tripId}, 下書き=${draftId}`);
      return;
    }
    if (!failed) {
      // 待ちに戻したので、キューの再試行（可視性タイムアウトの後）で担当し直せる
      throw error;
    }
  }
}

/**
 * 区切りの案を出す（06 §8.2）
 *
 * AI の案に、作り直しなら完成版で利用者が直した区切り（足した・消した）を当て、最後に各日の最初の写真を足す
 * （利用者が消した区切りが、日付の切り替えの時刻を変えた後などに日の最初になっていても、場面が日をまたがないように）
 * @returns AI の案（各日の最初の写真を足したもの）と区切り。どちらも場面の最初の写真の id で、撮影の順
 */
async function proposeScenes(
  photos: TimelinePhotoSnapshot[],
  draft: TimelineDraft,
  current: TimelineCurrent | null
): Promise<{ proposedStarts: string[]; sceneStarts: string[] }> {
  const days = datedDaysOf(photos, draft.dayStartHour);
  const ordered = days.flatMap((day) => day.photos.map((photo) => ({ photo, dayNumber: day.dayNumber })));
  const proposed = (await new TimelineProposerService().propose(ordered)).map((index) => ordered[index].photo.id);
  const dayStarts = days.map((day) => day.photos[0].id);

  let starts = new Set(proposed);
  if (draft.reason === 'rebuild' && current) {
    const aiStarts = new Set(current.proposedStarts);
    const userStarts = new Set(current.sceneStarts);
    const added = current.sceneStarts.filter((id) => !aiStarts.has(id));
    const removed = new Set(current.proposedStarts.filter((id) => !userStarts.has(id)));
    starts = new Set([...proposed, ...added].filter((id) => !removed.has(id)));
  }
  // 撮影の順に並べる。控えに無い・撮影日時の無い写真の区切りはここで落ちる
  const inOrder = (ids: Set<string>) => ordered.map(({ photo }) => photo.id).filter((id) => ids.has(id));
  return {
    proposedStarts: inOrder(new Set([...proposed, ...dayStarts])),
    sceneStarts: inOrder(new Set([...starts, ...dayStarts])),
  };
}

/**
 * キューのメッセージから旅行 ID と下書き ID を取り出す（トリガーは JSON の本文をオブジェクトにして渡す）
 * @returns 読めなければ null
 */
function idsOf(message: unknown): { tripId: string; draftId: string } | null {
  const { tripId, draftId } = (message ?? {}) as { tripId?: unknown; draftId?: unknown };
  // 形式（UUID）も見る。Cosmos の SDK は / \ # を含む id や空の id で通信の前に投げるので、
  // 見ないと読めないメッセージが例外になって poison に落ちる
  if (typeof tripId !== 'string' || typeof draftId !== 'string' || !isValidUUID(tripId) || !isValidUUID(draftId)) {
    return null;
  }
  return { tripId, draftId };
}

app.storageQueue('processTimeline', {
  // キューの名前はアプリの設定（Terraform が入れる）。投入する側（TimelineQueueService）と同じ値
  queueName: '%TIMELINE_QUEUE_NAME%',
  connection: 'AzureWebJobsStorage',
  handler: processTimelineHandler,
});
