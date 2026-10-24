import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { AlbumService } from '../services/albumService';
import { TimelineConflictError, TimelineService } from '../services/timelineService';
import { PhotoStorageService, photoUrlExpiresOn } from '../services/photoStorageService';
import { draftStatusOf, layoutTimeline } from '../services/timelineView';
import {
  createDatabaseErrorResponse,
  createTimelineStateConflict,
  createNotFoundError,
  createSuccessResponse,
  createValidationError,
  isValidUUID
} from '../utils/response';
import { ErrorCode } from '../types/api';

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
    const snapshot = await timelines.readSnapshot(draft.snapshotId);
    const existing = await timelines.readTripPhotoIds(tripId);
    const storage = new PhotoStorageService();
    const layout = layoutTimeline({
      photos: snapshot?.photos ?? [],
      sceneStarts: draft.sceneStarts,
      proposedStarts: draft.proposedStarts,
      dayStartHour: draft.dayStartHour,
      exists: (photoId) => existing.has(photoId),
      urlOf: (blobName) => storage.readUrl(blobName, expiresOn),
    });
    return createSuccessResponse({ draft: { ...draftStatusOf(draft), ...layout }, urlExpiresAt: expiresOn.toISOString() });
  } catch (error: any) {
    context.log('タイムラインの下書きの取得エラー:', error);
    return createDatabaseErrorResponse(error, 'タイムラインの取得に失敗しました');
  }
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

app.http('getTimelineDraft', {
  methods: ['GET'],
  authLevel: 'function',
  route: 'trips/{tripId}/timeline/draft',
  handler: getTimelineDraftHandler,
});

app.http('deleteTimelineDraft', {
  methods: ['DELETE'],
  authLevel: 'function',
  route: 'trips/{tripId}/timeline/draft',
  handler: deleteTimelineDraftHandler,
});
