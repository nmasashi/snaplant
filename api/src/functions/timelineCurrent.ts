import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { v4 as uuidv4 } from 'uuid';
import { AlbumService } from '../services/albumService';
import { PhotoStorageService, photoUrlExpiresOn, urlOfPhotos } from '../services/photoStorageService';
import { TimelineConflictError, TimelineService } from '../services/timelineService';
import { ErrorCode } from '../types/api';
import { TimelineDraft } from '../types/timeline';
import {
  createDatabaseErrorResponse,
  createNotFoundError,
  createSuccessResponse,
  createTimelineStateConflict,
  createValidationError,
  isValidUUID
} from '../utils/response';
import { reviewingDraftOf } from '../services/timelineView';

/**
 * タイムラインの完成版の区切りを直し始める API
 * POST /api/trips/{tripId}/timeline/recut?code={FUNCTION_KEY}
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
    const [photos, existing] = await Promise.all([timelines.readSnapshotPhotos(current.snapshotId), timelines.readTripPhotoIds(tripId)]);
    try {
      await timelines.replaceTimeline({ ...timeline.doc, draft, updatedAt: now }, timeline.etag);
    } catch (error: any) {
      if (error instanceof TimelineConflictError) {
        return createTimelineStateConflict();
      }
      throw error;
    }
    const expiresOn = photoUrlExpiresOn();
    return createSuccessResponse({ draft: reviewingDraftOf(draft, photos, existing, urlOfPhotos(storage, expiresOn)), urlExpiresAt: expiresOn.toISOString() });
  } catch (error: any) {
    context.log('タイムラインの区切りの直しの受付エラー:', error);
    return createDatabaseErrorResponse(error, 'タイムラインの作成の受付に失敗しました');
  }
}

app.http('postTimelineRecut', {
  methods: ['POST'],
  authLevel: 'function',
  route: 'trips/{tripId}/timeline/recut',
  handler: postTimelineRecutHandler,
});
