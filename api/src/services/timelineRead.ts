import { UNFINISHED_PROCESSING_STATES } from '../constants/album';
import { AlbumService } from './albumService';
import { PhotoStorageService, photoUrlExpiresOn, urlOfPhotos } from './photoStorageService';
import { TimelineService, rereadIfSnapshotMissing } from './timelineService';
import { currentTimelineOf, draftStatusOf } from './timelineView';

/**
 * 完成版を読んだ形（GET …/timeline の data。05 §5.15）を組む
 *
 * 完成版の表示を組むのはここだけ（GET …/timeline と、完成版の文を直す操作の応答が使う）。
 * 控えが無ければ最初から読み直す（rereadIfSnapshotMissing。他の操作と重なっただけなら今の状態になる）
 * @returns 応答の data。旅行が無ければ null
 */
export async function readTimelineBody(tripId: string) {
  return rereadIfSnapshotMissing(() => readTimelineBodyOnce(tripId));
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
    const excluded = new Set(doc.current.excludedPhotoIds ?? []);
    current = currentTimelineOf(
      doc.current,
      snapshot,
      (photoId) => existing.has(photoId) && !excluded.has(photoId),
      urlOfPhotos(new PhotoStorageService(), expiresOn)
    );
    // 日時の無い写真も数える（作り直せば控えに入る）。外した写真は画面に出していないので、その後に消えても知らせない
    changes = {
      added: photos.filter((photo) => !snapshotIds.has(photo.id)).length,
      removed: snapshot.filter((photo) => !existing.has(photo.id) && !excluded.has(photo.id)).length,
    };
  }
  return {
    timeline: { current, draft: doc.draft ? draftStatusOf(doc.draft) : null, changes },
    pendingPhotoCount,
    urlExpiresAt: expiresOn.toISOString(),
  };
}
