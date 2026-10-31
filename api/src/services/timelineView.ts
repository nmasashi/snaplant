import { TimelineCurrent, TimelineDraft, TimelineDraftStatus, TimelinePhotoSnapshot } from '../types/timeline';

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
  const proposed = new Set(input.proposedStarts);
  const days = datedDaysOf(input.photos, input.dayStartHour).map((day) => ({ ...day, scenes: scenesOfDay(day.photos, input.sceneStarts) }));
  // 区切りを入れた主: その日の最初の写真なら day、AI の案にあれば ai、無ければ user
  const startedByOf = (scenes: TimelinePhotoSnapshot[][], index: number): TimelineSceneLayout['startedBy'] =>
    index === 0 ? 'day' : proposed.has(scenes[index][0].id) ? 'ai' : 'user';

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
      dayNumber: day.dayNumber,
      scenes: day.scenes
        .map((scene, index) => ({
          startPhotoId: scene[0].id,
          startedBy: startedByOf(day.scenes, index),
          photos: scene.filter((photo) => input.exists(photo.id)),
        }))
        .filter((scene) => scene.photos.length > 0)
        .map(({ startPhotoId, startedBy, photos }) => ({
          startPhotoId,
          startedBy,
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

/** 完成版の応答（日と場面に文を当てた形。05 §5.15） */
export function currentTimelineOf(
  current: TimelineCurrent,
  photos: TimelinePhotoSnapshot[],
  exists: (photoId: string) => boolean,
  urlOf: (blobName: string) => string
) {
  const layout = layoutTimeline({
    photos,
    sceneStarts: current.sceneStarts,
    proposedStarts: current.proposedStarts,
    dayStartHour: current.dayStartHour,
    exists,
    urlOf,
  });
  return {
    writtenAt: current.writtenAt,
    days: layout.days.map((day) => {
      const text = current.dayTexts[day.date];
      return {
        date: day.date,
        dayNumber: day.dayNumber,
        title: text?.title ?? null,
        titleSource: text?.titleSource ?? null,
        summary: text?.summary ?? null,
        summarySource: text?.summarySource ?? null,
        scenes: day.scenes.map((scene) => {
          const sceneText = current.sceneTexts[scene.startPhotoId];
          return {
            ...scene,
            label: sceneText?.label ?? null,
            labelSource: sceneText?.labelSource ?? null,
            note: sceneText?.note ?? null,
            noteSource: sceneText?.noteSource ?? null,
          };
        }),
      };
    }),
    undatedPhotos: layout.undatedPhotos,
  };
}

/**
 * 1日の写真を場面に分ける（04 §1.6。その日の最初の写真と、区切りの写真が場面の始まり。場面は日をまたがない）
 * @param photos その日の写真（撮影の順）
 * @param sceneStarts 区切り（場面の最初の写真の id。ほかの日の写真や、控えに無い写真の id があっても無視する）
 */
export function scenesOfDay(photos: TimelinePhotoSnapshot[], sceneStarts: string[]): TimelinePhotoSnapshot[][] {
  const starts = new Set(sceneStarts);
  const scenes: TimelinePhotoSnapshot[][] = [];
  photos.forEach((photo, index) => {
    if (index === 0 || starts.has(photo.id)) {
      scenes.push([photo]);
    } else {
      scenes[scenes.length - 1].push(photo);
    }
  });
  return scenes;
}

/** 撮影日時のある写真の1日分 */
export interface TimelineDatedDay {
  date: string;
  /** 何日目か（一番早い日を1日目として、暦の日付の差で数える） */
  dayNumber: number;
  /** その日の写真（撮影の順） */
  photos: TimelinePhotoSnapshot[];
}

/**
 * 控えの撮影日時のある写真を日に分ける（撮影の順のまま。04 §1.6 の日の分け方。日時の無い写真は入れない）
 * @param photos 写真の控え（撮影日時のある写真が撮影の順で先）
 * @param dayStartHour 日付の切り替えの時刻（0〜23）
 */
export function datedDaysOf(photos: TimelinePhotoSnapshot[], dayStartHour: number): TimelineDatedDay[] {
  const days: { date: string; photos: TimelinePhotoSnapshot[] }[] = [];
  for (const photo of photos) {
    if (photo.takenAt === null) {
      continue;
    }
    const date = dayOf(photo.takenAt, dayStartHour);
    const day = days[days.length - 1];
    if (!day || day.date !== date) {
      days.push({ date, photos: [photo] });
    } else {
      day.photos.push(photo);
    }
  }
  const firstDay = days[0]?.date;
  return days.map((day) => ({
    ...day,
    dayNumber: (Date.parse(`${day.date}T00:00:00Z`) - Date.parse(`${firstDay}T00:00:00Z`)) / DAY_MS + 1,
  }));
}

/**
 * 区切りを確かめられる下書き（確かめ中か、文を書くのに失敗した）の応答（状態に、日ごと・場面ごとの写真と日時なしを足す。05 §5.15）
 *
 * 下書きの読み取り・区切りの保存・区切りの直しの受付が同じ形で返す
 * @param existing 旅行の今の写真の id（控えを取った後に消えた写真は出さない）
 * @param urlOf Blob 名から読み取りの SAS 付き URL
 */
export function reviewingDraftOf(draft: TimelineDraft, photos: TimelinePhotoSnapshot[], existing: Set<string>, urlOf: (blobName: string) => string) {
  const excluded = new Set(draft.excludedPhotoIds ?? []);
  const layout = layoutTimeline({
    photos,
    sceneStarts: draft.sceneStarts,
    proposedStarts: draft.proposedStarts,
    dayStartHour: draft.dayStartHour,
    exists: (photoId) => existing.has(photoId) && !excluded.has(photoId),
    urlOf,
  });
  const comments = draft.sceneComments ?? {};
  const days = layout.days.map((day) => ({
    ...day,
    scenes: day.scenes.map((scene) => ({ ...scene, comment: comments[scene.startPhotoId] ?? null })),
  }));
  return { ...draftStatusOf(draft), ...layout, days };
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
