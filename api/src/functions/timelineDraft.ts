import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { AlbumService } from '../services/albumService';
import { TimelineConflictError, TimelineService, TimelineSnapshotMissingError, rereadIfSnapshotMissing } from '../services/timelineService';
import { PhotoStorageService, photoUrlExpiresOn } from '../services/photoStorageService';
import { datedDaysOf, draftStatusOf, layoutTimeline } from '../services/timelineView';
import { readJsonBody } from '../utils/tripInput';
import { TimelineDraft, TimelinePhotoSnapshot } from '../types/timeline';
import {
  createDatabaseErrorResponse,
  createTimelineStateConflict,
  createNotFoundError,
  createSuccessResponse,
  createValidationError,
  isValidUUID
} from '../utils/response';
import { ErrorCode, HttpStatusCode } from '../types/api';
import { enqueueTimelineOrLog } from '../services/timelineQueueService';

/**
 * タイムラインの下書きを読む API（状態と、確かめ中なら日と場面）
 * GET /api/trips/{tripId}/timeline/draft?code={FUNCTION_KEY}
 *
 * 下書きを作っている間に画面が 5 秒ごとに読み直すのはこちら。日と場面は確かめ中のときだけ組む（05 §5.15）
 */
export async function getTimelineDraftHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const tripId = request.params.tripId;
  context.log(`タイムラインの下書きの取得リクエストを受信: 旅行=${tripId}`);
  if (!isValidUUID(tripId)) {
    return createValidationError('旅行IDの形式が無効です');
  }
  try {
    return await rereadIfSnapshotMissing(() => readDraftResponse(tripId));
  } catch (error: any) {
    context.log('タイムラインの下書きの取得エラー:', error);
    return createDatabaseErrorResponse(error, 'タイムラインの取得に失敗しました');
  }
}

/** 下書きを読んで応答を組む（控えが無ければ投げる。呼ぶ側が一度だけ読み直す） */
async function readDraftResponse(tripId: string): Promise<HttpResponseInit> {
  if (!(await new AlbumService().tripExists(tripId))) {
    return createNotFoundError('指定された旅行が見つかりません', ErrorCode.TRIP_NOT_FOUND);
  }
  const timelines = new TimelineService();
  const draft = (await timelines.readTimeline(tripId))?.doc.draft ?? null;
  const expiresOn = photoUrlExpiresOn();
  if (!draft) {
    return createSuccessResponse({ draft: null, urlExpiresAt: expiresOn.toISOString() });
  }
  if (draft.phase !== 'reviewing') {
    return createSuccessResponse({ draft: draftStatusOf(draft), urlExpiresAt: expiresOn.toISOString() });
  }
  // 互いに頼らない2つの読み取り。区切りの確認の画面が読み直すたびに通るので、続けずに並べて読む
  const [photos, existing] = await Promise.all([timelines.readSnapshotPhotos(draft.snapshotId), readExistingPhotoIds(timelines, tripId)]);
  return createSuccessResponse({
    draft: reviewingDraftOf(draft, photos, existing, new PhotoStorageService(), expiresOn),
    urlExpiresAt: expiresOn.toISOString(),
  });
}

/**
 * タイムラインの下書きをやめる API（完成版はそのまま。完成版も無ければタイムラインごと消す）
 * DELETE /api/trips/{tripId}/timeline/draft?code={FUNCTION_KEY}
 *
 * 作っている途中でもやめられる。ワーカーは下書きの id を確かめるので、やめた下書きに結果を書かない（06 §8.1）
 */
export async function deleteTimelineDraftHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const tripId = request.params.tripId;
  context.log(`タイムラインの下書きの削除リクエストを受信: 旅行=${tripId}`);
  if (!isValidUUID(tripId)) {
    return createValidationError('旅行IDの形式が無効です');
  }
  try {
    if (!(await new AlbumService().tripExists(tripId))) {
      return createNotFoundError('指定された旅行が見つかりません', ErrorCode.TRIP_NOT_FOUND);
    }
    const timelines = new TimelineService();
    const read = await timelines.readTimeline(tripId);
    const draft = read?.doc.draft;
    if (!read || !draft) {
      return createNotFoundError('タイムラインの下書きが見つかりません', ErrorCode.TIMELINE_NOT_FOUND);
    }
    try {
      if (read.doc.current) {
        await timelines.replaceTimeline({ ...read.doc, draft: null, updatedAt: new Date().toISOString() }, read.etag);
      } else {
        await timelines.deleteTimeline(tripId, read.etag);
      }
    } catch (error: any) {
      if (error instanceof TimelineConflictError) {
        return createTimelineStateConflict();
      }
      throw error;
    }
    // 下書きの控えは、完成版から指されていなければ使われなくなる
    if (draft.snapshotId !== read.doc.current?.snapshotId) {
      await timelines.deleteUnusedSnapshot(draft.snapshotId, (...args) => context.log(...args));
    }
    return createSuccessResponse({ draft: null });
  } catch (error: any) {
    context.log('タイムラインの下書きの削除エラー:', error);
    return createDatabaseErrorResponse(error, 'タイムラインの更新に失敗しました');
  }
}

/**
 * タイムラインの下書きの区切りで文を書く受付 API
 * POST /api/trips/{tripId}/timeline/draft/write?code={FUNCTION_KEY}
 *
 * 下書きを文を書く待ちにしてキューに積む（ワーカーが文を書き、書き終えると下書きが完成版に入れ替わる。05 §5.15・06 §8.3）
 */
export async function postTimelineDraftWriteHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const tripId = request.params.tripId;
  context.log(`タイムラインの文を書く受付リクエストを受信: 旅行=${tripId}`);
  if (!isValidUUID(tripId)) {
    return createValidationError('旅行IDの形式が無効です');
  }
  let draft: TimelineDraft;
  try {
    if (!(await new AlbumService().tripExists(tripId))) {
      return createNotFoundError('指定された旅行が見つかりません', ErrorCode.TRIP_NOT_FOUND);
    }
    const timelines = new TimelineService();
    const timeline = await timelines.readTimeline(tripId);
    const read = timeline?.doc.draft;
    if (!timeline || !read) {
      return createNotFoundError('タイムラインの下書きが見つかりません', ErrorCode.TIMELINE_NOT_FOUND);
    }
    const writeFailed = read.phase === 'writing' && read.job?.state === 'failed';
    if (read.phase !== 'reviewing' && !writeFailed) {
      return createTimelineStateConflict();
    }
    const now = new Date().toISOString();
    draft = { ...read, phase: 'writing', job: { step: 'write', state: 'pending', attempts: 0, lastError: null, updatedAt: now } };
    try {
      await timelines.replaceTimeline({ ...timeline.doc, draft, updatedAt: now }, timeline.etag);
    } catch (error: any) {
      if (error instanceof TimelineConflictError) {
        return createTimelineStateConflict();
      }
      throw error;
    }
  } catch (error: any) {
    context.log('タイムラインの文を書く受付エラー:', error);
    return createDatabaseErrorResponse(error, 'タイムラインの作成の受付に失敗しました');
  }
  // 投入に失敗しても受け付ける（下書きは待ちのまま残り、再投入のタイマーが積む。作る受付と同じ）
  await enqueueTimelineOrLog(tripId, draft.id, (...args) => context.log(...args));
  return createSuccessResponse(
    { draft: draftStatusOf(draft), urlExpiresAt: photoUrlExpiresOn().toISOString() },
    HttpStatusCode.ACCEPTED
  );
}

/**
 * タイムラインの下書きの区切りを保存する API
 * PUT /api/trips/{tripId}/timeline/draft/scenes?code={FUNCTION_KEY}  { sceneStarts: string[] }
 *
 * 画面は区切りを1つ直すたびに送る（途中でやめても残る。05 §5.15）。文を書くのに失敗した下書きなら、確かめ中に戻す
 */
export async function putTimelineDraftScenesHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const tripId = request.params.tripId;
  context.log(`タイムラインの区切りの保存リクエストを受信: 旅行=${tripId}`);
  if (!isValidUUID(tripId)) {
    return createValidationError('旅行IDの形式が無効です');
  }
  const read = await readJsonBody(request);
  if ('error' in read) {
    return read.error;
  }
  if (read.body === null || read.body === undefined) {
    return createValidationError('リクエストボディが指定されていません');
  }
  try {
    if (!(await new AlbumService().tripExists(tripId))) {
      return createNotFoundError('指定された旅行が見つかりません', ErrorCode.TRIP_NOT_FOUND);
    }
    const timelines = new TimelineService();
    const timeline = await timelines.readTimeline(tripId);
    const draft = timeline?.doc.draft;
    if (!timeline || !draft) {
      return createNotFoundError('タイムラインの下書きが見つかりません', ErrorCode.TIMELINE_NOT_FOUND);
    }
    const writeFailed = draft.phase === 'writing' && draft.job?.state === 'failed';
    if (draft.phase !== 'reviewing' && !writeFailed) {
      return createTimelineStateConflict();
    }
    const { sceneStarts } = read.body as { sceneStarts?: unknown };
    if (!Array.isArray(sceneStarts) || !sceneStarts.every((id) => typeof id === 'string')) {
      return createValidationError('区切りは写真IDの配列で指定してください');
    }
    let photos: TimelinePhotoSnapshot[];
    let existing: Set<string>;
    try {
      [photos, existing] = await Promise.all([timelines.readSnapshotPhotos(draft.snapshotId), readExistingPhotoIds(timelines, tripId)]);
    } catch (error: any) {
      // 読んだ後に他の操作が旅行を消した・下書きをやめた・作り直した（控えを消した）なら重なり。下書きが同じまま控えだけ無ければ壊れている。
      // 最初から読み直して保存はしない（出し直した新しい下書きに、前の下書きへの直しを書いてしまう）
      if (!(error instanceof TimelineSnapshotMissingError)) {
        throw error;
      }
      if (!(await new AlbumService().tripExists(tripId))) {
        return createNotFoundError('指定された旅行が見つかりません', ErrorCode.TRIP_NOT_FOUND);
      }
      if ((await timelines.readTimeline(tripId))?.doc.draft?.id !== draft.id) {
        return createTimelineStateConflict();
      }
      throw error;
    }
    if (!isValidSceneStarts(sceneStarts, photos, draft.dayStartHour)) {
      return createValidationError('区切りが無効です');
    }
    const saved: TimelineDraft = { ...draft, sceneStarts, ...(writeFailed ? { phase: 'reviewing', job: null } : {}) };
    // 保存先の設定が足りなければ、区切りを書き換える前に失敗させる（書き換えた後だと、保存したのに失敗と返す）
    const storage = new PhotoStorageService();
    try {
      await timelines.replaceTimeline({ ...timeline.doc, draft: saved, updatedAt: new Date().toISOString() }, timeline.etag);
    } catch (error: any) {
      if (error instanceof TimelineConflictError) {
        return createTimelineStateConflict();
      }
      throw error;
    }
    const expiresOn = photoUrlExpiresOn();
    return createSuccessResponse({ draft: reviewingDraftOf(saved, photos, existing, storage, expiresOn), urlExpiresAt: expiresOn.toISOString() });
  } catch (error: any) {
    context.log('タイムラインの区切りの保存エラー:', error);
    return createDatabaseErrorResponse(error, 'タイムラインの区切りの保存に失敗しました');
  }
}

/** 旅行の今の写真の id（控えを取った後に消えた写真を見分ける） */
async function readExistingPhotoIds(timelines: TimelineService, tripId: string): Promise<Set<string>> {
  return new Set((await timelines.readTripPhotoStates(tripId)).map((photo) => photo.id));
}

/** 確かめ中の下書きの応答（状態に、日ごと・場面ごとの写真と日時なしを足す。05 §5.15） */
function reviewingDraftOf(
  draft: TimelineDraft,
  photos: TimelinePhotoSnapshot[],
  existing: Set<string>,
  storage: PhotoStorageService,
  expiresOn: Date
) {
  const layout = layoutTimeline({
    photos,
    sceneStarts: draft.sceneStarts,
    proposedStarts: draft.proposedStarts,
    dayStartHour: draft.dayStartHour,
    exists: (photoId) => existing.has(photoId),
    urlOf: (blobName) => storage.readUrl(blobName, expiresOn),
  });
  return { ...draftStatusOf(draft), ...layout };
}

/**
 * 区切りが控えに合っているか（05 §5.15 の表の 4）
 *
 * どれも控えの撮影日時のある写真で、重ならず撮影の順に並び、各日の最初の写真が入っていること（場面は日をまたがない）
 */
function isValidSceneStarts(sceneStarts: string[], photos: TimelinePhotoSnapshot[], dayStartHour: number): boolean {
  const days = datedDaysOf(photos, dayStartHour);
  const order = new Map(days.flatMap((day) => day.photos).map((photo, index) => [photo.id, index]));
  const positions = sceneStarts.map((id) => order.get(id));
  if (positions.some((position, index) => position === undefined || (index > 0 && position <= positions[index - 1]!))) {
    return false;
  }
  const starts = new Set(sceneStarts);
  return days.every((day) => starts.has(day.photos[0].id));
}

app.http('getTimelineDraft', {
  methods: ['GET'],
  authLevel: 'function',
  route: 'trips/{tripId}/timeline/draft',
  handler: getTimelineDraftHandler,
});

app.http('putTimelineDraftScenes', {
  methods: ['PUT'],
  authLevel: 'function',
  route: 'trips/{tripId}/timeline/draft/scenes',
  handler: putTimelineDraftScenesHandler,
});

app.http('postTimelineDraftWrite', {
  methods: ['POST'],
  authLevel: 'function',
  route: 'trips/{tripId}/timeline/draft/write',
  handler: postTimelineDraftWriteHandler,
});

app.http('deleteTimelineDraft', {
  methods: ['DELETE'],
  authLevel: 'function',
  route: 'trips/{tripId}/timeline/draft',
  handler: deleteTimelineDraftHandler,
});
