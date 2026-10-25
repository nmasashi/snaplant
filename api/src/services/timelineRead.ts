import { HttpResponseInit } from '@azure/functions';
import { UNFINISHED_PROCESSING_STATES } from '../constants/album';
import { ErrorCode } from '../types/api';
import { createNotFoundError, createSuccessResponse } from '../utils/response';
import { AlbumService } from './albumService';
import { PhotoStorageService, photoUrlExpiresOn, urlOfPhotos } from './photoStorageService';
import { TimelineService, rereadIfSnapshotMissing } from './timelineService';
import { currentTimelineOf, draftStatusOf } from './timelineView';

/**
 * 完成版を読んだ形（GET …/timeline の data。05 §5.15）を組む
 *
 * 完成版の表示を組むのはここだけ（GET …/timeline と、完成版の文を直す・残せなかった文を閉じる操作の応答が使う）。
 * 控えが無ければ最初から読み直す（rereadIfSnapshotMissing。他の操作と重なっただけなら今の状態になる）
 * @returns 応答の data。旅行が無ければ null
 */
export async function readTimelineBody(tripId: string) {
  return rereadIfSnapshotMissing(() => readTimelineBodyOnce(tripId));
}

/**
 * 完成版を読んだ形の応答（200）。旅行が無ければ 404 TRIP_NOT_FOUND（GET …/timeline と、完成版の文を直す・残せなかった文を閉じる操作が返す）
 */
export async function readTimelineResponse(tripId: string): Promise<HttpResponseInit> {
  const body = await readTimelineBody(tripId);
  return body ? createSuccessResponse(body) : createNotFoundError('指定された旅行が見つかりません', ErrorCode.TRIP_NOT_FOUND);
}

async function readTimelineBodyOnce(tripId: string) {
  if (!(await new AlbumService().tripExists(tripId))) {
    return null;
  }
  const timelines = new TimelineService();
  const [read, photos] = await Promise.all([timelines.readTimeline(tripId), timelines.readTripPhotoStates(tripId)]);
  const expiresOn = photoUrlExpiresOn();
  const pendingPhotoCount = photos.filter((photo) => UNFINISHED_PROCESSING_STATES.includes(photo.state)).length;
  if (!read) {
    return { timeline: null, pendingPhotoCount, urlExpiresAt: expiresOn.toISOString() };
  }
  const doc = read.doc;
  let current = null;
  let changes = null;
  if (doc.current) {
    const snapshot = await timelines.readSnapshotPhotos(doc.current.snapshotId);
    const existing = new Set(photos.map((photo) => photo.id));
    const snapshotIds = new Set(snapshot.map((photo) => photo.id));
    current = currentTimelineOf(doc.current, snapshot, (photoId) => existing.has(photoId), urlOfPhotos(new PhotoStorageService(), expiresOn));
    // 日時の無い写真も数える（作り直せば控えに入る）
    changes = {
      added: photos.filter((photo) => !snapshotIds.has(photo.id)).length,
      removed: snapshot.filter((photo) => !existing.has(photo.id)).length,
    };
  }
  return {
    timeline: { current, draft: doc.draft ? draftStatusOf(doc.draft) : null, changes, droppedEdits: doc.droppedEdits },
    pendingPhotoCount,
    urlExpiresAt: expiresOn.toISOString(),
  };
}
