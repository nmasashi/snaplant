import { TimelineCurrent, TimelineDayText, TimelineDraft, TimelinePhotoSnapshot, TimelineSceneText } from '../types/timeline';
import { TIMELINE_MAX_PHOTOS_PER_CALL } from '../constants/album';
import { TimelineWriterService } from './timelineWriterService';
import { TimelineDatedDay, datedDaysOf, scenesOfDay } from './timelineView';

/** 下書きの区切りで組んだ場面（控えの撮影日時のある写真。控えを取った後に消えた写真も含める） */
interface ScenePlan {
  start: string;
  photoIds: string[];
}

/** 下書きの区切りで組んだ日 */
interface DayPlan {
  date: string;
  dayNumber: number;
  scenes: ScenePlan[];
}

/** AI が書いた文（場面は最初の写真の id、日は日付ごと） */
export interface TimelineAiTexts {
  scenes: Map<string, { label: string }>;
  days: Map<string, { title: string; summary: string }>;
}

/**
 * 下書きの区切りの全部の場面と日に、AI に文を書かせる（06 §8.3 の 1・2）
 *
 * 前の完成版の文は使わない（作り直しは一から作る。2026-10-27 に人間が決定）。区切りを直したとき（recut）は AI を使わずに withRecutStarts で当てる（06 §8.6）ので、
 * ここには来ない（文を書く段に積まれた recut の下書きも、ワーカーが withRecutStarts で当てる）
 * @returns 下書きの区切りで組んだ日と場面と、AI が書いた文（完成版を組むのは assembleCurrent）
 */
export async function writeDraftTexts(
  photos: TimelinePhotoSnapshot[],
  draft: TimelineDraft
): Promise<{ plan: DayPlan[]; texts: TimelineAiTexts }> {
  const days = datedDaysOf(photos, draft.dayStartHour);
  const plan = planOf(days, draft.sceneStarts, new Set(draft.excludedPhotoIds ?? []));
  const photoOf = new Map(days.flatMap((day) => day.photos.map((photo) => [photo.id, { photo, dayNumber: day.dayNumber }] as const)));
  const writer = new TimelineWriterService();
  const texts: TimelineAiTexts = { scenes: new Map(), days: new Map() };
  // 順に呼ぶ（区切り案と同じ）。途中で失敗したら投げ、何も書かない
  for (const call of writeCallsOf(plan)) {
    const scenes = call.flatMap((piece) => piece.scenes);
    // 番号は呼び出しごとに 0 から振る
    const ordered = scenes.flatMap((scene) => scene.photoIds.map((id) => photoOf.get(id)!));
    const indexOf = new Map(ordered.map(({ photo }, index) => [photo.id, index]));
    // 場面の最初の写真を外した場面は、残りの最初の写真から渡す（文は場面の id（控えの最初の写真）に付ける）
    const sceneStarts = scenes.map((scene) => indexOf.get(scene.photoIds[0])!);
    const written = await writer.write({
      photos: ordered,
      sceneStarts,
      scenesToWrite: sceneStarts,
      sceneComments: new Map(
        scenes.flatMap((scene, index) => {
          const comment = draft.sceneComments?.[scene.start];
          return comment === undefined ? [] : [[sceneStarts[index], comment] as const];
        })
      ),
      daysToWrite: call.filter((piece) => piece.writesDay).map(({ date, dayNumber }) => ({ date, dayNumber })),
    });
    scenes.forEach((scene, index) => {
      const text = written.scenes.get(sceneStarts[index]);
      if (text) texts.scenes.set(scene.start, text);
    });
    written.days.forEach((text, date) => texts.days.set(date, text));
  }
  return { plan, texts };
}

/** 1回の呼び出しに渡す日の一部（1日で上限を超える日は、場面の境目で分かれる） */
interface CallDay {
  date: string;
  dayNumber: number;
  scenes: ScenePlan[];
  /** この呼び出しで日の文を頼むか（その日の最初の場面を含む呼び出しだけ） */
  writesDay: boolean;
}

/**
 * AI に渡す写真を、一度に渡せる数（TIMELINE_MAX_PHOTOS_PER_CALL）ごとの呼び出しに分ける（06 §8.4）
 *
 * 日の境目で分け、入る日はまとめる。1日で上限を超える日は場面の境目で分ける（区切り案のときに上限ごとの切れ目は区切りになっている。
 * 利用者が切れ目を消して上限を超える場面になったら、その場面は1回で渡す）
 */
function writeCallsOf(plan: DayPlan[]): CallDay[][] {
  const calls: CallDay[][] = [];
  let call: CallDay[] = [];
  let size = 0;
  const push = () => {
    if (call.length > 0) {
      calls.push(call);
      call = [];
      size = 0;
    }
  };
  for (const day of plan) {
    const daySize = day.scenes.reduce((sum, scene) => sum + scene.photoIds.length, 0);
    if (size > 0 && size + daySize > TIMELINE_MAX_PHOTOS_PER_CALL) {
      push();
    }
    day.scenes.forEach((scene, index) => {
      if (size > 0 && size + scene.photoIds.length > TIMELINE_MAX_PHOTOS_PER_CALL) {
        push();
      }
      const last = call[call.length - 1];
      if (last && last.date === day.date) {
        last.scenes.push(scene);
      } else {
        call.push({ date: day.date, dayNumber: day.dayNumber, scenes: [scene], writesDay: index === 0 });
      }
      size += scene.photoIds.length;
    });
  }
  push();
  return calls;
}

/**
 * 下書きと AI の文から完成版を組む（06 §8.3 の 3）。文はすべて AI が書いたもので、前の完成版の文は使わない
 * @param now 書き終えた時刻
 */
export function assembleCurrent(draft: TimelineDraft, plan: DayPlan[], texts: TimelineAiTexts, now: string): TimelineCurrent {
  const sceneTexts: Record<string, TimelineSceneText> = {};
  const dayTexts: Record<string, TimelineDayText> = {};
  for (const day of plan) {
    for (const scene of day.scenes) {
      const { label } = written(texts.scenes.get(scene.start), `場面 ${scene.start}`);
      // 場面の一言は AI に書かせない（U-3。02 §5 #55）
      sceneTexts[scene.start] = { ...emptySceneText(), label, labelSource: 'ai', aiLabel: label };
    }
    const { title, summary } = written(texts.days.get(day.date), `日 ${day.date}`);
    dayTexts[day.date] = { title, titleSource: 'ai', aiTitle: title, summary, summarySource: 'ai', aiSummary: summary };
  }
  return {
    snapshotId: draft.snapshotId,
    dayStartHour: draft.dayStartHour,
    proposedStarts: draft.proposedStarts,
    sceneStarts: draft.sceneStarts,
    sceneTexts,
    dayTexts,
    writtenAt: now,
    ...(draft.excludedPhotoIds ? { excludedPhotoIds: draft.excludedPhotoIds } : {}),
  };
}

/**
 * 日ごとに場面を組む（表示と同じ組み方。04 §1.6）
 *
 * 外した写真は AI に渡さないので場面から除き、写真が全部外れた場面と日は文を頼まない（消えた写真は渡す。控えの写真のまま書く）
 */
function planOf(days: TimelineDatedDay[], sceneStarts: string[], excluded: Set<string>): DayPlan[] {
  return days
    .map((day) => ({
      date: day.date,
      dayNumber: day.dayNumber,
      scenes: scenesOfDay(day.photos, sceneStarts)
        .map((photos) => ({ start: photos[0].id, photoIds: photos.map((photo) => photo.id).filter((id) => !excluded.has(id)) }))
        .filter((scene) => scene.photoIds.length > 0),
    }))
    .filter((day) => day.scenes.length > 0);
}

/** AI が書いた文。無ければ（応答の検証を通ったのに頼んだ場面・日が無い）投げる（内部の失敗として書き直す） */
function written<T>(text: T | undefined, what: string): T {
  if (text === undefined) {
    throw new Error(`AI の文がありません: ${what}`);
  }
  return text;
}

/**
 * 完成版に直した区切りを当てる（06 §8.6）。残った場面の文はそのまま、足した場面の文は空、つなげて消えた場面の文は捨てる。
 * 日の文・作成日時・控えはそのまま（区切りを直しても日は変わらない）。
 * 外した写真は、下書き（編集を始めたときの完成版から引き継ぎ、編集で足した）と完成版（編集の間に外した）を合わせる（どちらも戻さないので和でよい）
 */
export function withRecutStarts(current: TimelineCurrent, draft: Pick<TimelineDraft, 'sceneStarts' | 'excludedPhotoIds'>): TimelineCurrent {
  const { sceneStarts } = draft;
  const sceneTexts: Record<string, TimelineSceneText> = {};
  for (const start of sceneStarts) {
    sceneTexts[start] = current.sceneTexts[start] ?? emptySceneText();
  }
  const excluded = mergedExcludedPhotoIds(current.excludedPhotoIds, draft.excludedPhotoIds);
  return { ...current, sceneStarts, sceneTexts, ...(excluded ? { excludedPhotoIds: excluded } : {}) };
}

/**
 * 区切りの直しを当てるときの外した写真（完成版と下書きの和。どちらも戻さないので和でよい）。どちらも無ければ undefined
 *
 * 当てる前に、当てた後の出す写真を確かめる受付（写真を外す2つ）も、これで同じ見方にする
 */
export function mergedExcludedPhotoIds(current: string[] | undefined, draft: string[] | undefined): string[] | undefined {
  return current || draft ? [...new Set([...(current ?? []), ...(draft ?? [])])] : undefined;
}

/** 空の場面の文（区切りを直して足した場面。AI が書いた場面も、これに見出しだけを足す。U-3）。場面ごとに別の値にする（同じ値を指すと、片方を変えたときに両方が変わる） */
function emptySceneText(): TimelineSceneText {
  return { label: null, labelSource: null, aiLabel: null, note: null, noteSource: null, aiNote: null };
}
