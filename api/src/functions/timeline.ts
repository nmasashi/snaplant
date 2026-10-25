import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { v4 as uuidv4 } from 'uuid';
import { AlbumService } from '../services/albumService';
import { TimelineConflictError, TimelinePhotoRow, TimelineService, timelineIdOf } from '../services/timelineService';
import { enqueueTimelineOrLog } from '../services/timelineQueueService';
import { photoUrlExpiresOn } from '../services/photoStorageService';
import { draftStatusOf } from '../services/timelineView';
import { readTimelineBody } from '../services/timelineRead';
import {
  createDatabaseErrorResponse,
  createTimelineBodyResponse,
  createErrorResponse,
  createTimelineStateConflict,
  createNotFoundError,
  createSuccessResponse,
  createValidationError,
  isValidUUID
} from '../utils/response';
import { ErrorCode, HttpStatusCode } from '../types/api';
import { TimelineDocument, TimelineDraft, TimelinePhotoSnapshot } from '../types/timeline';
import { TIMELINE_SNAPSHOT_COMMENT_LENGTH, UNFINISHED_PROCESSING_STATES, timelineDayStartHour } from '../constants/album';

/**
 * タイムラインを作る・作り直す API（区切り案の下書きを作って、キューに積む。区切り案はワーカーが後で出す）
 * POST /api/trips/{tripId}/timeline?code={FUNCTION_KEY}
 */
export async function createTimelineHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const tripId = request.params.tripId;
  context.log(`タイムラインの作成リクエストを受信: 旅行=${tripId}`);
  if (!isValidUUID(tripId)) {
    return createValidationError('旅行IDの形式が無効です');
  }
  let draft: TimelineDraft;
  try {
    if (!(await new AlbumService().tripExists(tripId))) {
      return createNotFoundError('指定された旅行が見つかりません', ErrorCode.TRIP_NOT_FOUND);
    }
    const timelines = new TimelineService();
    const existing = await timelines.readTimeline(tripId);
    const job = existing?.doc.draft?.job;
    if (job && (job.state === 'pending' || job.state === 'running')) {
      return createTimelineStateConflict();
    }
    const rows = await timelines.readTripPhotosForSnapshot(tripId);
    if (rows.some((row) => UNFINISHED_PROCESSING_STATES.includes(row.processing.state))) {
      return createErrorResponse(
        ErrorCode.TIMELINE_PHOTOS_PROCESSING,
        '解析中の写真があります。終わってから作ってください',
        HttpStatusCode.CONFLICT
      );
    }
    if (!rows.some((row) => row.takenAt !== null)) {
      return createErrorResponse(ErrorCode.TIMELINE_NO_DATED_PHOTOS, '撮影日時のある写真がありません', HttpStatusCode.CONFLICT);
    }

    const now = new Date().toISOString();
    const snapshotId = `timeline-photos-${tripId}-${uuidv4()}`;
    await timelines.createSnapshot({ id: snapshotId, type: 'timelinePhotos', tripId, photos: snapshotPhotosOf(rows), createdAt: now });
    draft = {
      id: uuidv4(),
      // 完成版があれば作り直し（完成版は文を書き終えるまで変えない。02 §5 #48）
      reason: existing?.doc.current ? 'rebuild' : 'create',
      phase: 'proposing',
      job: { step: 'propose', state: 'pending', attempts: 0, lastError: null, updatedAt: now },
      snapshotId,
      dayStartHour: timelineDayStartHour(),
      proposedStarts: [],
      sceneStarts: [],
      startedAt: now,
    };
    try {
      if (existing) {
        // 前の下書き（確かめ中・失敗）は置き換える。完成版と残せなかった文はそのまま
        await timelines.replaceTimeline({ ...existing.doc, draft, updatedAt: now }, existing.etag);
      } else {
        const doc: TimelineDocument = {
          id: timelineIdOf(tripId),
          type: 'timeline',
          tripId,
          current: null,
          draft,
          droppedEdits: [],
          createdAt: now,
          updatedAt: now,
        };
        await timelines.createTimeline(doc);
      }
    } catch (error: any) {
      if (error instanceof TimelineConflictError) {
        // どこからも指されない控えを残さない（残っても害は無く、旅行の削除で消える。04 §7.1）
        await timelines.deleteUnusedSnapshot(snapshotId, (...args) => context.log(...args));
        return createTimelineStateConflict();
      }
      throw error;
    }
    // 置き換えた下書きの控えは、完成版から指されていなければ使われなくなる
    const replacedSnapshotId = existing?.doc.draft?.snapshotId;
    if (replacedSnapshotId && replacedSnapshotId !== existing.doc.current?.snapshotId) {
      await timelines.deleteUnusedSnapshot(replacedSnapshotId, (...args) => context.log(...args));
    }
  } catch (error: any) {
    context.log('タイムラインの作成の受付エラー:', error);
    return createDatabaseErrorResponse(error, 'タイムラインの作成の受付に失敗しました');
  }

  await enqueueTimelineOrLog(tripId, draft.id, (...args) => context.log(...args));
  return createSuccessResponse(
    { draft: draftStatusOf(draft), urlExpiresAt: photoUrlExpiresOn().toISOString() },
    HttpStatusCode.ACCEPTED
  );
}

/**
 * 写真の射影から控えを作る。撮影日時のある写真が撮影の順で先、無い写真が後（04 §1.6）
 *
 * 名前は分類と合った識別の名前だけ。コメントは AI に渡す分（先頭）だけを残す
 */
function snapshotPhotosOf(rows: TimelinePhotoRow[]): TimelinePhotoSnapshot[] {
  const bySortAt = (a: TimelinePhotoRow, b: TimelinePhotoRow) => a.sortAt.localeCompare(b.sortAt);
  const dated = rows.filter((row) => row.takenAt !== null).sort(bySortAt);
  const undated = rows.filter((row) => row.takenAt === null).sort(bySortAt);
  return [...dated, ...undated].map((row) => {
    const identification = row.identification as { matchesKind?: unknown; name?: unknown } | null;
    return {
      id: row.id,
      takenAt: row.takenAt,
      category: row.category,
      name: identification?.matchesKind === true && typeof identification.name === 'string' ? identification.name : null,
      placeName: row.location?.placeName ?? null,
      comment: row.comment === null ? null : row.comment.slice(0, TIMELINE_SNAPSHOT_COMMENT_LENGTH),
      blobName: row.blobName,
      thumbnailBlobName: row.thumbnailBlobName,
    };
  });
}

/**
 * タイムラインを読む API（完成版の日と場面、下書きの状態、写真の変化、解析中の枚数）
 * GET /api/trips/{tripId}/timeline?code={FUNCTION_KEY}
 *
 * 完成版の表示を組むのはここだけ（下書きをやめた後も、画面はここを読み直す。05 §5.15）
 */
export async function getTimelineHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const tripId = request.params.tripId;
  context.log(`タイムラインの取得リクエストを受信: 旅行=${tripId}`);
  if (!isValidUUID(tripId)) {
    return createValidationError('旅行IDの形式が無効です');
  }
  try {
    return createTimelineBodyResponse(await readTimelineBody(tripId));
  } catch (error: any) {
    context.log('タイムラインの取得エラー:', error);
    return createDatabaseErrorResponse(error, 'タイムラインの取得に失敗しました');
  }
}

app.http('getTimeline', {
  methods: ['GET'],
  authLevel: 'function',
  route: 'trips/{tripId}/timeline',
  handler: getTimelineHandler,
});

app.http('createTimeline', {
  methods: ['POST'],
  authLevel: 'function',
  route: 'trips/{tripId}/timeline',
  handler: createTimelineHandler,
});
