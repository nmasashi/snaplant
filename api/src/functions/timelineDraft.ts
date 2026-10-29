import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { AlbumService } from '../services/albumService';
import { TimelineService, TimelineSnapshotMissingError, rereadIfSnapshotMissing } from '../services/timelineService';
import { PhotoStorageService, photoUrlExpiresOn, urlOfPhotos } from '../services/photoStorageService';
import { datedDaysOf, draftStatusOf, reviewingDraftOf, scenesOfDay } from '../services/timelineView';
import { readJsonBody } from '../utils/tripInput';
import { TimelineDraft, TimelinePhotoSnapshot } from '../types/timeline';
import { withRecutStarts } from '../services/timelineWriting';
import {
  createDatabaseErrorResponse,
  createTimelineStateConflict,
  createNotFoundError,
  createSuccessResponse,
  createValidationError,
  isValidUUID
} from '../utils/response';
import { ErrorCode, HttpStatusCode } from '../types/api';
import { TIMELINE_VALIDATION } from '../constants/validation';
import { enqueueTimelineOrLog } from '../services/timelineQueueService';

/**
 * タイムラインの下書きを読む API（状態と、確かめ中か文を書くのに失敗した下書きなら日と場面）
 * GET /api/trips/{tripId}/timeline/draft
 *
 * 下書きを作っている間に画面が 5 秒ごとに読み直すのはこちら。日と場面は確かめ中と文を書くのに失敗したときだけ組む（05 §5.15）
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
  // 確かめ中と、文を書くのに失敗した下書き（区切りの確認の画面で直せる。保存と文の受付と同じ条件）だけが日と場面を返す
  if (!isEditableDraft(draft)) {
    return createSuccessResponse({ draft: draftStatusOf(draft), urlExpiresAt: expiresOn.toISOString() });
  }
  // 互いに頼らない2つの読み取り。区切りの確認の画面が読み直すたびに通るので、続けずに並べて読む
  const [photos, existing] = await Promise.all([timelines.readSnapshotPhotos(draft.snapshotId), timelines.readTripPhotoIds(tripId)]);
  return createSuccessResponse({
    draft: reviewingDraftOf(draft, photos, existing, urlOfPhotos(new PhotoStorageService(), expiresOn)),
    urlExpiresAt: expiresOn.toISOString(),
  });
}

/**
 * タイムラインの下書きをやめる API（完成版はそのまま。完成版も無ければタイムラインごと消す）
 * DELETE /api/trips/{tripId}/timeline/draft
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
    const written = read.doc.current
      ? await timelines.replaceTimelineIfUnchanged({ ...read.doc, draft: null, updatedAt: new Date().toISOString() }, read.etag)
      : await timelines.deleteTimelineIfUnchanged(tripId, read.etag);
    if (!written) {
      return createTimelineStateConflict();
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
 * POST /api/trips/{tripId}/timeline/draft/write
 *
 * 下書きを文を書く待ちにしてキューに積む（ワーカーが文を書き、書き終えると下書きが完成版に入れ替わる。05 §5.15・06 §8.3）。
 * 区切りを直している下書き（recut）は AI を使わず、その場で完成版に当てる（06 §8.6）
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
    if (!isEditableDraft(read)) {
      return createTimelineStateConflict();
    }
    const now = new Date().toISOString();
    if (read.reason === 'recut') {
      // 区切りの直しは AI を使わない（06 §8.6）。当てる完成版が無ければ（重なり・壊れた文書）書かない
      if (!timeline.doc.current) {
        return createTimelineStateConflict();
      }
      const current = withRecutStarts(timeline.doc.current, read.sceneStarts);
      if (!(await timelines.replaceTimelineIfUnchanged({ ...timeline.doc, current, draft: null, updatedAt: now }, timeline.etag))) {
        return createTimelineStateConflict();
      }
      return createSuccessResponse({ draft: null, urlExpiresAt: photoUrlExpiresOn().toISOString() });
    }
    draft = { ...read, phase: 'writing', job: { step: 'write', state: 'pending', attempts: 0, lastError: null, updatedAt: now } };
    if (!(await timelines.replaceTimelineIfUnchanged({ ...timeline.doc, draft, updatedAt: now }, timeline.etag))) {
      return createTimelineStateConflict();
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
 * PUT /api/trips/{tripId}/timeline/draft/scenes  { sceneStarts: string[] }
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
    const writeFailed = isWriteFailed(draft);
    if (!isEditableDraft(draft)) {
      return createTimelineStateConflict();
    }
    const { sceneStarts, sceneComments } = read.body as { sceneStarts?: unknown; sceneComments?: unknown };
    if (!Array.isArray(sceneStarts) || !sceneStarts.every((id) => typeof id === 'string')) {
      return createValidationError('区切りは写真IDの配列で指定してください');
    }
    if (sceneComments !== undefined && !isStringRecord(sceneComments)) {
      return createValidationError('場面のコメントは写真IDと文字列の組で指定してください');
    }
    const maxLength = TIMELINE_VALIDATION.MAX_LENGTH.SCENE_COMMENT;
    if (sceneComments !== undefined && Object.values(sceneComments).some((comment) => trimComment(comment).length > maxLength)) {
      return createValidationError(`場面のコメントは${maxLength}文字以内で指定してください`);
    }
    let photos: TimelinePhotoSnapshot[];
    let existing: Set<string>;
    try {
      [photos, existing] = await Promise.all([timelines.readSnapshotPhotos(draft.snapshotId), timelines.readTripPhotoIds(tripId)]);
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
    const normalized = normalizedSceneStarts(sceneStarts, photos, draft.dayStartHour, draft.sceneStarts, existing);
    if (!normalized) {
      return createValidationError('区切りが無効です');
    }
    const starts = new Set(normalized);
    if (sceneComments !== undefined && Object.keys(sceneComments).some((photoId) => !starts.has(photoId))) {
      return createValidationError('場面のコメントは場面の最初の写真に付けてください');
    }
    const comments = savedCommentsOf(sceneComments, draft.sceneComments, starts);
    const saved: TimelineDraft = {
      ...draft,
      sceneStarts: normalized,
      ...(comments ? { sceneComments: comments } : {}),
      ...(writeFailed ? { phase: 'reviewing', job: null } : {})
    };
    // 保存先の設定が足りなければ、区切りを書き換える前に失敗させる（書き換えた後だと、保存したのに失敗と返す）
    const storage = new PhotoStorageService();
    if (!(await timelines.replaceTimelineIfUnchanged({ ...timeline.doc, draft: saved, updatedAt: new Date().toISOString() }, timeline.etag))) {
      return createTimelineStateConflict();
    }
    const expiresOn = photoUrlExpiresOn();
    return createSuccessResponse({ draft: reviewingDraftOf(saved, photos, existing, urlOfPhotos(storage, expiresOn)), urlExpiresAt: expiresOn.toISOString() });
  } catch (error: any) {
    context.log('タイムラインの区切りの保存エラー:', error);
    return createDatabaseErrorResponse(error, 'タイムラインの区切りの保存に失敗しました');
  }
}

/**
 * 場面のコメントの前後の空白を除く。String.trim は U+0085（次の行）を除かないが、アプリ（Dart の trim）は除くので、
 * それだけのコメントをアプリは空として扱う。そろえないと、空に見えるコメントが残って AI に渡る
 */
function trimComment(comment: string): string {
  return comment.replace(/^[\s\u0085]+|[\s\u0085]+$/g, '');
}

/** 写真の id と文字列の組か（配列・null は違う） */
function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.values(value).every((item) => typeof item === 'string');
}

/**
 * 保存する場面のコメント（05 §5.15）
 *
 * 送られたら、前後の空白を除いて空でないものに置き換える（どちらのコメントを残すかは画面が決めて送る）。
 * 送られなければ、今のコメントのうち保存する区切りにあるものを残す（区切りだけを送るアプリでも、場面ごと消えたコメントだけが消える）。
 * どちらも無ければ undefined（欄を書かない）
 */
function savedCommentsOf(
  sent: Record<string, string> | undefined,
  previous: Record<string, string> | undefined,
  starts: Set<string>
): Record<string, string> | undefined {
  if (sent !== undefined) {
    return Object.fromEntries(
      Object.entries(sent)
        .map(([photoId, comment]) => [photoId, trimComment(comment)])
        .filter(([, comment]) => comment !== '')
    );
  }
  if (previous === undefined) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(previous).filter(([photoId]) => starts.has(photoId)));
}

/**
 * 区切りを直せる・文を書かせられる下書きか（確かめ中か、文を書くのに失敗した下書き。05 §5.15 の区切りの保存と文を書く受付）
 *
 * 文の失敗からは、区切りを直して確かめ中に戻すことも、そのまま書き直させることもできる
 */
function isEditableDraft(draft: TimelineDraft): boolean {
  return draft.phase === 'reviewing' || isWriteFailed(draft);
}

/** 文を書くのに失敗した下書きか */
function isWriteFailed(draft: TimelineDraft): boolean {
  return draft.phase === 'writing' && draft.job?.state === 'failed';
}

/**
 * 区切りが控えに合っているか（05 §5.15 の表の 4）
 *
 * どれも控えの撮影日時のある写真で、重ならず撮影の順に並ぶこと。合っていれば、各日の最初の写真を足した区切り（撮影の順）を返し、合わなければ null。
 * 場面は日をまたがないので、日の最初の写真は必ず場面の始まり。区切りの確認の画面は写真が全部消えた日や場面を見ないので、
 * その日の最初の写真（控えにだけある）を送れない。求めて 400 にすると、その旅行では区切りを直せなくなる（5-3b）。
 * 同じく、今の区切り（[previousStarts]）のうち写真が全部消えた（[existing] に1枚も無い）場面の区切りも送れないので補う（5-4a）。
 * 補わないと、見えない場面の写真が前の場面に混ざり、区切りの直しを当てるとき（06 §8.6）に、見えない場面の文が捨てられ、その写真は前の場面に入る。
 * ただし、同じ日でその次にある見える場面の区切りを外した（前の場面とつなげた）ときは補わない（補うと、つなげた場面が見えない場面に付く）
 */
function normalizedSceneStarts(
  sceneStarts: string[],
  photos: TimelinePhotoSnapshot[],
  dayStartHour: number,
  previousStarts: string[],
  existing: Set<string>
): string[] | null {
  const days = datedDaysOf(photos, dayStartHour);
  const ordered = days.flatMap((day) => day.photos.map((photo) => photo.id));
  const order = new Map(ordered.map((id, index) => [id, index]));
  const positions = sceneStarts.map((id) => order.get(id));
  if (positions.some((position, index) => position === undefined || (index > 0 && position <= positions[index - 1]!))) {
    return null;
  }
  const sent = new Set(sceneStarts);
  const starts = new Set([...sceneStarts, ...days.map((day) => day.photos[0].id), ...hiddenStartsToKeep(days, previousStarts, existing, sent)]);
  return ordered.filter((id) => starts.has(id));
}

/**
 * 今の区切りで分けた場面のうち、写真が全部消えて画面に見えない場面の区切りで、残すもの（[normalizedSceneStarts] の説明）
 *
 * 同じ日でその後に見える場面が無いか、その次の見える場面の区切りが送られていれば残す
 */
function hiddenStartsToKeep(
  days: { photos: TimelinePhotoSnapshot[] }[],
  previousStarts: string[],
  existing: Set<string>,
  sent: Set<string>
): string[] {
  const kept: string[] = [];
  for (const day of days) {
    // 今の区切りで日を場面に分け（画面と同じ分け方）、場面の最初の写真の id と、今も見える写真があるかを見る
    const scenes = scenesOfDay(day.photos, previousStarts).map((photos) => ({
      start: photos[0].id,
      visible: photos.some((photo) => existing.has(photo.id))
    }));
    scenes.forEach((scene, index) => {
      if (scene.visible) {
        return;
      }
      const nextVisible = scenes.slice(index + 1).find((later) => later.visible);
      if (!nextVisible || sent.has(nextVisible.start)) {
        kept.push(scene.start);
      }
    });
  }
  return kept;
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
