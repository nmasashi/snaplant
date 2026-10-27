import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { v4 as uuidv4 } from 'uuid';
import { AlbumService } from '../services/albumService';
import { PhotoStorageService, photoUrlExpiresOn, urlOfPhotos } from '../services/photoStorageService';
import { TimelineService, TimelineSnapshotMissingError } from '../services/timelineService';
import { ErrorCode } from '../types/api';
import { TimelineCurrent, TimelineDraft, TimelinePhotoSnapshot } from '../types/timeline';
import { PHOTO_VALIDATION, TIMELINE_VALIDATION } from '../constants/validation';
import { readJsonBody } from '../utils/tripInput';
import { readTimelineBody } from '../services/timelineRead';
import {
  createDatabaseErrorResponse,
  createTimelineBodyResponse,
  createNotFoundError,
  createSuccessResponse,
  createTimelineStateConflict,
  createValidationError,
  isValidUUID
} from '../utils/response';
import { reviewingDraftOf } from '../services/timelineView';

/**
 * タイムラインの完成版の区切りを直し始める API
 * POST /api/trips/{tripId}/timeline/recut
 *
 * 完成版の控えと区切りを写した確かめ中の下書きを作る（AI の区切り案は出さない。05 §5.15）。
 * 区切りを直して文を書かせると、変わった場面と日だけが書き直される（06 §8.3）
 */
export async function postTimelineRecutHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const tripId = request.params.tripId;
  context.log(`タイムラインの区切りの直しの受付リクエストを受信: 旅行=${tripId}`);
  if (!isValidUUID(tripId)) {
    return createValidationError('旅行IDの形式が無効です');
  }
  try {
    if (!(await new AlbumService().tripExists(tripId))) {
      return createNotFoundError('指定された旅行が見つかりません', ErrorCode.TRIP_NOT_FOUND);
    }
    const timelines = new TimelineService();
    const timeline = await timelines.readTimeline(tripId);
    const current = timeline?.doc.current;
    if (!timeline || !current) {
      return createNotFoundError('タイムラインが見つかりません', ErrorCode.TIMELINE_NOT_FOUND);
    }
    if (timeline.doc.draft) {
      return createTimelineStateConflict();
    }
    const now = new Date().toISOString();
    const draft: TimelineDraft = {
      id: uuidv4(),
      reason: 'recut',
      phase: 'reviewing',
      job: null,
      snapshotId: current.snapshotId,
      dayStartHour: current.dayStartHour,
      proposedStarts: current.proposedStarts,
      sceneStarts: current.sceneStarts,
      startedAt: now,
    };
    // 保存先の設定が足りなければ、下書きを書く前に失敗させる（区切りの保存と同じ）
    const storage = new PhotoStorageService();
    let photos: TimelinePhotoSnapshot[];
    let existing: Set<string>;
    try {
      [photos, existing] = await Promise.all([timelines.readSnapshotPhotos(current.snapshotId), timelines.readTripPhotoIds(tripId)]);
    } catch (error: any) {
      // 完成版の控えが無いのは、読んだ後に旅行の削除と重なったとき（区切りの保存と同じ扱い）。完成版が変わっていれば重なり、
      // 同じ完成版のまま控えだけ無ければ壊れている
      if (!(error instanceof TimelineSnapshotMissingError)) {
        throw error;
      }
      if (!(await new AlbumService().tripExists(tripId))) {
        return createNotFoundError('指定された旅行が見つかりません', ErrorCode.TRIP_NOT_FOUND);
      }
      if ((await timelines.readTimeline(tripId))?.doc.current?.snapshotId !== current.snapshotId) {
        return createTimelineStateConflict();
      }
      throw error;
    }
    if (!(await timelines.replaceTimelineIfUnchanged({ ...timeline.doc, draft, updatedAt: now }, timeline.etag))) {
      return createTimelineStateConflict();
    }
    const expiresOn = photoUrlExpiresOn();
    return createSuccessResponse({ draft: reviewingDraftOf(draft, photos, existing, urlOfPhotos(storage, expiresOn)), urlExpiresAt: expiresOn.toISOString() });
  } catch (error: any) {
    context.log('タイムラインの区切りの直しの受付エラー:', error);
    return createDatabaseErrorResponse(error, 'タイムラインの作成の受付に失敗しました');
  }
}

/**
 * 残せなかった文の知らせを閉じる API
 * DELETE /api/trips/{tripId}/timeline/dropped-edits
 *
 * 文を書き直したときに残せなかった利用者の文（droppedEdits）を空にする（05 §5.15）
 */
export async function deleteTimelineDroppedEditsHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const tripId = request.params.tripId;
  context.log(`タイムラインの残せなかった文を閉じるリクエストを受信: 旅行=${tripId}`);
  if (!isValidUUID(tripId)) {
    return createValidationError('旅行IDの形式が無効です');
  }
  try {
    if (!(await new AlbumService().tripExists(tripId))) {
      return createNotFoundError('指定された旅行が見つかりません', ErrorCode.TRIP_NOT_FOUND);
    }
    const timelines = new TimelineService();
    const timeline = await timelines.readTimeline(tripId);
    if (!timeline) {
      return createNotFoundError('タイムラインが見つかりません', ErrorCode.TIMELINE_NOT_FOUND);
    }
    // 既に無ければ書かない（書くと _etag が変わり、同じときに読んだ他の操作が 409 になる）
    if (
      timeline.doc.droppedEdits.length > 0 &&
      !(await timelines.replaceTimelineIfUnchanged({ ...timeline.doc, droppedEdits: [], updatedAt: new Date().toISOString() }, timeline.etag))
    ) {
      return createTimelineStateConflict();
    }
    return createTimelineBodyResponse(await readTimelineBody(tripId));
  } catch (error: any) {
    context.log('タイムラインの残せなかった文を閉じるエラー:', error);
    return createDatabaseErrorResponse(error, 'タイムラインの更新に失敗しました');
  }
}

/** 直せる文の欄（日はタイトル・まとめ、場面は見出し・一言。05 §5.15・§4） */
interface TextField<K extends string> {
  key: K;
  /** 400 の文言に入れる名前 */
  name: string;
  maxLength: number;
}

const DAY_FIELDS: TextField<'title' | 'summary'>[] = [
  { key: 'title', name: 'タイトル', maxLength: TIMELINE_VALIDATION.MAX_LENGTH.TITLE },
  { key: 'summary', name: 'まとめ', maxLength: TIMELINE_VALIDATION.MAX_LENGTH.SUMMARY },
];
const SCENE_FIELDS: TextField<'label' | 'note'>[] = [
  { key: 'label', name: '見出し', maxLength: TIMELINE_VALIDATION.MAX_LENGTH.LABEL },
  { key: 'note', name: '一言', maxLength: TIMELINE_VALIDATION.MAX_LENGTH.NOTE },
];

/**
 * 完成版の日の文を直す API
 * PATCH /api/trips/{tripId}/timeline/days/{date}  { title?, summary? }
 */
export async function patchTimelineDayHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  return editTimelineText(request, context, 'day');
}

/**
 * 完成版の場面の文を直す API
 * PATCH /api/trips/{tripId}/timeline/scenes/{photoId}  { label?, note? }
 */
export async function patchTimelineSceneHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  return editTimelineText(request, context, 'scene');
}

/**
 * 完成版の文を直す（日と場面で共有する。05 §5.15 の表の 1〜8）
 *
 * 前後の空白を除いて保存し、書いた主を user にする。空か null なら AI が書いた文に戻して ai にする（AI の文が無い欄は null にし、書いた主も null）。
 * 下書きがあっても直せる（下書きの文を書くときに、完成版から引き継ぐ。06 §8.3）
 */
async function editTimelineText(request: HttpRequest, context: InvocationContext, target: 'day' | 'scene'): Promise<HttpResponseInit> {
  const tripId = request.params.tripId;
  const key = target === 'day' ? request.params.date : request.params.photoId;
  context.log(`タイムラインの文の更新リクエストを受信: 旅行=${tripId}, ${target === 'day' ? '日' : '場面'}=${key}`);
  if (!isValidUUID(tripId)) {
    return createValidationError('旅行IDの形式が無効です');
  }
  if (target === 'scene' && !PHOTO_VALIDATION.ID_REGEX.test(key)) {
    return createValidationError('写真IDの形式が無効です');
  }
  const read = await readJsonBody(request);
  if ('error' in read) {
    return read.error;
  }
  if (read.body === null || read.body === undefined) {
    return createValidationError('リクエストボディが指定されていません');
  }
  const edits = readTextEdits(read.body as Record<string, unknown>, target === 'day' ? DAY_FIELDS : SCENE_FIELDS);
  if ('error' in edits) {
    return edits.error;
  }
  try {
    if (!(await new AlbumService().tripExists(tripId))) {
      return createNotFoundError('指定された旅行が見つかりません', ErrorCode.TRIP_NOT_FOUND);
    }
    const timelines = new TimelineService();
    const timeline = await timelines.readTimeline(tripId);
    const current = timeline?.doc.current;
    if (!timeline || !current) {
      return createNotFoundError('タイムラインが見つかりません', ErrorCode.TIMELINE_NOT_FOUND);
    }
    let edited: TimelineCurrent;
    if (target === 'day') {
      // 日付の形が違う・実在しない日付も「その日は無い」（その日付の日は完成版に無い）。完成版の鍵はいつも正しい日付なので
      // 結果は鍵の有無と同じだが、利用者が送った文字列を、形を確かめる前に鍵として使わないために先に見る
      if (!isValidDate(key) || !Object.prototype.hasOwnProperty.call(current.dayTexts, key)) {
        return createNotFoundError('その日はタイムラインにありません', ErrorCode.TIMELINE_NOT_FOUND);
      }
      edited = { ...current, dayTexts: { ...current.dayTexts, [key]: withEdits(current.dayTexts[key], edits.values) } };
    } else {
      if (!Object.prototype.hasOwnProperty.call(current.sceneTexts, key)) {
        return createNotFoundError('その場面はタイムラインにありません', ErrorCode.TIMELINE_NOT_FOUND);
      }
      edited = { ...current, sceneTexts: { ...current.sceneTexts, [key]: withEdits(current.sceneTexts[key], edits.values) } };
    }
    // 文が変わらなければ書かない（書くと _etag が変わり、同じときに読んだ他の操作が 409 になる。残せなかった文を閉じるのと同じ）
    const changed = JSON.stringify(edited) !== JSON.stringify(current);
    if (changed && !(await timelines.replaceTimelineIfUnchanged({ ...timeline.doc, current: edited, updatedAt: new Date().toISOString() }, timeline.etag))) {
      return createTimelineStateConflict();
    }
    // 画面は直した後の完成版を描き直すので、完成版を読んだ形（GET …/timeline と同じ）で返す
    return createTimelineBodyResponse(await readTimelineBody(tripId));
  } catch (error: any) {
    context.log('タイムラインの文の更新エラー:', error);
    return createDatabaseErrorResponse(error, 'タイムラインの更新に失敗しました');
  }
}

/**
 * ボディから直す欄を読む。どの欄も無い・文字列でも null でもない・前後の空白を除いて上限を超えるなら 400
 * @returns 欄ごとの新しい文（空か null は AI の文に戻す印の null）
 */
function readTextEdits<K extends string>(
  body: Record<string, unknown>,
  fields: TextField<K>[]
): { values: Partial<Record<K, string | null>> } | { error: HttpResponseInit } {
  if (fields.every((field) => body[field.key] === undefined)) {
    return { error: createValidationError('更新する項目が指定されていません') };
  }
  const values: Partial<Record<K, string | null>> = {};
  for (const field of fields) {
    const value = body[field.key];
    if (value === undefined) {
      continue;
    }
    if (value !== null && typeof value !== 'string') {
      return { error: createValidationError(`${field.name}は文字列で指定してください`) };
    }
    const text = value === null ? '' : value.trim();
    if (text.length > field.maxLength) {
      return { error: createValidationError(`${field.name}は${field.maxLength}文字以内で指定してください`) };
    }
    values[field.key] = text === '' ? null : text;
  }
  return { values };
}

/**
 * 文に直しを当てる。文字列なら利用者の文にし、null なら AI が書いた文（ai* の欄）に戻す（AI の文が無ければ null に戻し、書いた主も null）
 */
function withEdits<T extends object>(text: T, edits: Partial<Record<string, string | null>>): T {
  const next = { ...text } as Record<string, unknown>;
  for (const [key, value] of Object.entries(edits)) {
    if (value === undefined) continue;
    const aiKey = `ai${key[0].toUpperCase()}${key.slice(1)}`;
    // AI の文が無い欄（区切りを直して足した場面）は、空に戻して書いた主も無くす
    const aiText = next[aiKey] ?? null;
    next[key] = value === null ? aiText : value;
    next[`${key}Source`] = value !== null ? 'user' : aiText === null ? null : 'ai';
  }
  return next as T;
}

/** 実在する日付か（YYYY-MM-DD の形で、暦にある日） */
function isValidDate(date: string): boolean {
  if (!TIMELINE_VALIDATION.DATE_REGEX.test(date)) {
    return false;
  }
  // 13 月などは Date が無効になる（toISOString が投げる）。2 月 30 日などは翌月にずれるので、戻した日付と比べる
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

app.http('postTimelineRecut', {
  methods: ['POST'],
  authLevel: 'function',
  route: 'trips/{tripId}/timeline/recut',
  handler: postTimelineRecutHandler,
});

app.http('patchTimelineDay', {
  methods: ['PATCH'],
  authLevel: 'function',
  route: 'trips/{tripId}/timeline/days/{date}',
  handler: patchTimelineDayHandler,
});

app.http('patchTimelineScene', {
  methods: ['PATCH'],
  authLevel: 'function',
  route: 'trips/{tripId}/timeline/scenes/{photoId}',
  handler: patchTimelineSceneHandler,
});

app.http('deleteTimelineDroppedEdits', {
  methods: ['DELETE'],
  authLevel: 'function',
  route: 'trips/{tripId}/timeline/dropped-edits',
  handler: deleteTimelineDroppedEditsHandler,
});
