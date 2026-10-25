import { TimelineDraft, TimelineDraftStatus, TimelinePhotoSnapshot } from '../types/timeline';

/** 応答に出す写真（控えから作る。05 §5.15） */
export interface TimelinePhotoView {
  id: string;
  takenAt: string | null;
  category: string | null;
  name: string | null;
  placeName: string | null;
  /** サムネイル（無ければ原寸）の読み取りの SAS 付き URL */
  thumbnailUrl: string;
}

/** 応答に出す場面（文の無い形。完成版は文を足す） */
export interface TimelineSceneLayout {
  startPhotoId: string;
  /** 区切りを入れた主（その日の最初の写真・AI の案・利用者） */
  startedBy: 'day' | 'ai' | 'user';
  /** 食べ物の写真が1枚でもあるか（画面の印の色） */
  hasFood: boolean;
  firstTakenAt: string;
  lastTakenAt: string;
  /** 地名（重なりを除いて撮影の順） */
  placeNames: string[];
  /** 識別の名前（重なりを除いて撮影の順） */
  names: string[];
  photos: TimelinePhotoView[];
}

/** 応答に出す日 */
export interface TimelineDayLayout {
  date: string;
  /** 何日目か（一番早い日を1日目として、暦の日付の差で数える） */
  dayNumber: number;
  scenes: TimelineSceneLayout[];
}

/** 日と場面を組むのに要るもの */
export interface TimelineLayoutInput {
  /** 写真の控え（撮影日時のある写真が撮影の順で先、無い写真が後） */
  photos: TimelinePhotoSnapshot[];
  /** 区切り（場面の最初の写真の id） */
  sceneStarts: string[];
  /** AI の案の区切り（区切りを入れた主を見分ける） */
  proposedStarts: string[];
  /** 日付の切り替えの時刻（0〜23） */
  dayStartHour: number;
  /** その写真がまだあるか（控えを取った後に消えた写真は出さない） */
  exists: (photoId: string) => boolean;
  /** Blob 名から読み取りの SAS 付き URL を作る */
  urlOf: (blobName: string) => string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 写真の控えと区切りから、日ごと・場面ごとの並びを組む（docs/04_data_design.md §1.6 の決まり）
 *
 * - 写真の日は、撮影日時から日付の切り替えの時刻を引いた日付（4 なら 10月6日 2:30 は 10月5日）
 * - 各日の最初の写真と、区切りの写真が場面の始まり（場面は日をまたがない）
 * - 何日目かと場面の分け方は、消えた写真も含めた控えで決め、出すときに消えた写真を除く
 *   （写真を消しても日の番号や区切りが動かないように）。写真が全部消えた場面と日は出さない
 */
export function layoutTimeline(input: TimelineLayoutInput): { days: TimelineDayLayout[]; undatedPhotos: TimelinePhotoView[] } {
  const starts = new Set(input.sceneStarts);
  const proposed = new Set(input.proposedStarts);
  const dated = input.photos.filter((photo) => photo.takenAt !== null);
  const firstDay = dated.length > 0 ? dayOf(dated[0].takenAt!, input.dayStartHour) : null;

  const days: { date: string; scenes: TimelinePhotoSnapshot[][] }[] = [];
  const starters = new Map<string, TimelineSceneLayout['startedBy']>();
  for (const photo of dated) {
    const date = dayOf(photo.takenAt!, input.dayStartHour);
    const day = days[days.length - 1];
    if (!day || day.date !== date) {
      days.push({ date, scenes: [[photo]] });
      starters.set(photo.id, 'day');
    } else if (starts.has(photo.id)) {
      day.scenes.push([photo]);
      starters.set(photo.id, proposed.has(photo.id) ? 'ai' : 'user');
    } else {
      day.scenes[day.scenes.length - 1].push(photo);
    }
  }

  const view = (photo: TimelinePhotoSnapshot): TimelinePhotoView => ({
    id: photo.id,
    takenAt: photo.takenAt,
    category: photo.category,
    name: photo.name,
    placeName: photo.placeName,
    thumbnailUrl: input.urlOf(photo.thumbnailBlobName ?? photo.blobName),
  });

  const laidOut = days
    .map((day) => ({
      date: day.date,
      dayNumber: (Date.parse(`${day.date}T00:00:00Z`) - Date.parse(`${firstDay}T00:00:00Z`)) / DAY_MS + 1,
      scenes: day.scenes
        .map((scene) => ({ startPhotoId: scene[0].id, photos: scene.filter((photo) => input.exists(photo.id)) }))
        .filter((scene) => scene.photos.length > 0)
        .map(({ startPhotoId, photos }) => ({
          startPhotoId,
          startedBy: starters.get(startPhotoId)!,
          hasFood: photos.some((photo) => photo.category === 'food'),
          firstTakenAt: photos[0].takenAt!,
          lastTakenAt: photos[photos.length - 1].takenAt!,
          placeNames: distinct(photos.map((photo) => photo.placeName)),
          names: distinct(photos.map((photo) => photo.name)),
          photos: photos.map(view),
        })),
    }))
    .filter((day) => day.scenes.length > 0);

  const undatedPhotos = input.photos.filter((photo) => photo.takenAt === null && input.exists(photo.id)).map(view);
  return { days: laidOut, undatedPhotos };
}

/** 下書きの状態（応答の形。05 §5.15） */
export function draftStatusOf(draft: TimelineDraft): TimelineDraftStatus {
  return {
    id: draft.id,
    reason: draft.reason,
    phase: draft.phase,
    job: draft.job ? { step: draft.job.step, state: draft.job.state, lastError: draft.job.lastError } : null,
    startedAt: draft.startedAt,
  };
}

/**
 * 撮影日時（タイムゾーン無しの YYYY-MM-DDTHH:mm:ss）が属する日
 *
 * 日付の切り替えの時刻だけ戻した日付。撮影日時は現地の時刻のまま扱い、タイムゾーンを変換しない
 */
function dayOf(takenAt: string, dayStartHour: number): string {
  const shifted = Date.parse(`${takenAt}Z`) - dayStartHour * 60 * 60 * 1000;
  return new Date(shifted).toISOString().slice(0, 10);
}

/** null を除き、重なりを除いて、最初に出た順に並べる */
function distinct(values: (string | null)[]): string[] {
  return [...new Set(values.filter((value): value is string => value !== null))];
}
