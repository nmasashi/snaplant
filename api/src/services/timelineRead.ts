import { UNFINISHED_PROCESSING_STATES } from '../constants/album';
import { AlbumService } from './albumService';
import { PhotoStorageService, photoUrlExpiresOn, urlOfPhotos } from './photoStorageService';
import { HttpResponseInit } from '@azure/functions';
import { TimelineService, TimelineSnapshotMissingError, rereadIfSnapshotMissing } from './timelineService';
import { currentTimelineOf, draftStatusOf } from './timelineView';
import { TimelineDocument } from '../types/timeline';
import { ErrorCode } from '../types/api';
import { createNotFoundError, createTimelineStateConflict } from '../utils/response';

/**
 * 完成版を読んだ形（GET …/timeline の data。05 §5.15）を組む
 *
 * 完成版の表示を組むのはここだけ（GET …/timeline と、完成版の文を直す操作の応答が使う）。
 * 控えが無ければ最初から読み直す（rereadIfSnapshotMissing。他の操作と重なっただけなら今の状態になる）
 * @param storage 写真の保存先（書く前に設定を確かめた呼び出し側が渡す。無ければここで作る）
 * @returns 応答の data。旅行が無ければ null
 */
export async function readTimelineBody(tripId: string, storage?: PhotoStorageService) {
  return rereadIfSnapshotMissing(() => readTimelineBodyOnce(tripId, storage));
}

/**
 * 控えを使う読み取りを行い、控えが無ければ他の操作との重なりかを見分ける（05 §5.15 の共通の行。区切りの保存・区切りの直しの受付・写真を外す2つで共有する）
 *
 * 控えを消すのはタイムラインの書き込みの後なので、読んだ後に旅行の削除・下書きをやめる・作り直すと重なると控えだけが先に無くなる。
 * 旅行が消えていれば 404、タイムラインが読んだときと違うものを指していれば 409 の応答を返す。同じものを指したまま控えだけ無ければ壊れているので投げる（500）。
 * 最初から読み直して書くことはしない（変わった下書き・完成版に、前のものへの操作を書いてしまう）
 * @param stillSame 読み直したタイムラインが、読んだときと同じ下書き・完成版を指しているか
 */
export async function readUnlessOverlapped<T>(
  timelines: TimelineService,
  tripId: string,
  stillSame: (doc: TimelineDocument | undefined) => boolean,
  read: () => Promise<T>
): Promise<{ value: T } | { error: HttpResponseInit }> {
  try {
    return { value: await read() };
  } catch (error: any) {
    if (!(error instanceof TimelineSnapshotMissingError)) {
      throw error;
    }
    if (!(await new AlbumService().tripExists(tripId))) {
      return { error: createNotFoundError('指定された旅行が見つかりません', ErrorCode.TRIP_NOT_FOUND) };
    }
    if (!stillSame((await timelines.readTimeline(tripId))?.doc)) {
      return { error: createTimelineStateConflict() };
    }
    throw error;
  }
}

async function readTimelineBodyOnce(tripId: string, storage: PhotoStorageService | undefined) {
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
    // 控えで撮影日時があった写真。控えに無い写真と、控えでは撮影日時が無く作った後に手で付けた写真は、
    // 作り直すと入るので増えた写真に数える（02 §5 #59）。ただし外した写真は数えない（控えの写真しか外せないので、
    // 効くのは控えでは日時が無かった写真。日時のある写真を外したときと同じく、外したものを増えたとは知らせない）
    const datedInSnapshot = new Set(snapshot.filter((photo) => photo.takenAt !== null).map((photo) => photo.id));
    const excluded = new Set(doc.current.excludedPhotoIds ?? []);
    // 外した写真は消えた写真と同じく出さない（visiblePhotoIdsOf と同じ決まり。集合を作り直さないように述語で渡す）
    const shown = (photoId: string) => existing.has(photoId) && !excluded.has(photoId);
    current = currentTimelineOf(doc.current, snapshot, shown, urlOfPhotos(storage ?? new PhotoStorageService(), expiresOn));
    // 日時の無い写真はタイムラインに入れない（作り直しても入らない）ので数えない（02 §5 #54）。
    // 外した写真は画面に出していないので、その後に消えても知らせない
    changes = {
      added: photos.filter((photo) => photo.takenAt !== null && !datedInSnapshot.has(photo.id) && !excluded.has(photo.id)).length,
      removed: snapshot.filter((photo) => photo.takenAt !== null && !existing.has(photo.id) && !excluded.has(photo.id)).length,
    };
  }
  return {
    timeline: { current, draft: doc.draft ? draftStatusOf(doc.draft) : null, changes },
    pendingPhotoCount,
    urlExpiresAt: expiresOn.toISOString(),
  };
}
