import {
  TimelineCurrent,
  TimelineDayText,
  TimelineDraft,
  TimelineDroppedEdit,
  TimelinePhotoSnapshot,
  TimelineSceneText,
} from '../types/timeline';
import { TIMELINE_MAX_PHOTOS_PER_CALL } from '../constants/album';
import { TimelineWriterService } from './timelineWriterService';
import { oneLine } from './timelinePrompt';
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

/** AI が書いた文（場面は最初の写真の id、日は日付ごと）。書かせなかった場面と日は入らない */
export interface TimelineAiTexts {
  scenes: Map<string, { label: string; note: string }>;
  days: Map<string, { title: string; summary: string }>;
}

/**
 * 下書きの区切りに文を書かせる（06 §8.3 の 1〜5）
 *
 * 前の完成版と、写真が同じ場面・区切りが同じ日は文を引き継ぐので書かせない。書かせるものが無ければ AI を呼ばない
 * @param current 読んだときの完成版（無ければ全部を書かせる）
 * @returns 下書きの区切りで組んだ日と場面と、AI が書いた文（完成版を組むのは assembleCurrent）
 */
export async function writeDraftTexts(
  photos: TimelinePhotoSnapshot[],
  draft: TimelineDraft,
  current: TimelineCurrent | null
): Promise<{ plan: DayPlan[]; texts: TimelineAiTexts }> {
  const days = datedDaysOf(photos, draft.dayStartHour);
  const plan = planOf(days, draft.sceneStarts);
  const scenesToWrite = plan.flatMap((day) => day.scenes).filter((scene) => !inheritsScene(current, scene));
  const daysToWrite = plan.filter((day) => !inheritsDay(current, day));
  if (scenesToWrite.length === 0 && daysToWrite.length === 0) {
    return { plan, texts: { scenes: new Map(), days: new Map() } };
  }

  const photoOf = new Map(days.flatMap((day) => day.photos.map((photo) => [photo.id, { photo, dayNumber: day.dayNumber }] as const)));
  const fullDays = new Map(plan.map((day) => [day.date, day]));
  const sceneStartsToWrite = new Set(scenesToWrite.map((scene) => scene.start));
  const datesToWrite = new Set(daysToWrite.map((day) => day.date));
  const writer = new TimelineWriterService();
  const texts: TimelineAiTexts = { scenes: new Map(), days: new Map() };
  // 順に呼ぶ（区切り案と同じ）。途中で失敗したら投げ、何も書かない
  for (const call of writeCallsOf(plan)) {
    const scenes = call.flatMap((piece) => piece.scenes);
    const callScenes = scenes.filter((scene) => sceneStartsToWrite.has(scene.start));
    const callDays = call.filter((piece) => piece.writesDay && datesToWrite.has(piece.date));
    if (callScenes.length === 0 && callDays.length === 0) {
      continue;
    }
    // 番号は呼び出しごとに 0 から振る
    const ordered = scenes.flatMap((scene) => scene.photoIds.map((id) => photoOf.get(id)!));
    const indexOf = new Map(ordered.map(({ photo }, index) => [photo.id, index]));
    const written = await writer.write({
      photos: ordered,
      sceneStarts: scenes.map((scene) => indexOf.get(scene.start)!),
      scenesToWrite: callScenes.map((scene) => indexOf.get(scene.start)!),
      daysToWrite: callDays.map(({ date, dayNumber }) => ({ date, dayNumber })),
      context: contextOf(call, current, fullDays, (photoId) => indexOf.get(photoId)!),
    });
    written.scenes.forEach((text, index) => texts.scenes.set(ordered[index].photo.id, text));
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
 * 下書きと AI の文から完成版を組み、残せなかった利用者の文を返す（06 §8.3 の 2・3・6）
 *
 * 引き継ぐ文と利用者の文は、渡した完成版（結果を当て直すたびに読み直した最新のもの）から取る。
 * 書いている間に利用者が完成版の文を直しても、直した後の文が残る
 * @param latest 最新の完成版
 * @param now 書き終えた時刻
 */
export function assembleCurrent(
  draft: TimelineDraft,
  plan: DayPlan[],
  texts: TimelineAiTexts,
  latest: TimelineCurrent | null,
  now: string
): { current: TimelineCurrent; dropped: TimelineDroppedEdit[] } {
  const sceneTexts: Record<string, TimelineSceneText> = {};
  const dayTexts: Record<string, TimelineDayText> = {};
  for (const day of plan) {
    for (const scene of day.scenes) {
      const before = latest?.sceneTexts[scene.start];
      const written = texts.scenes.get(scene.start);
      if (!written) {
        sceneTexts[scene.start] = inherited(before, `場面 ${scene.start}`);
        continue;
      }
      const label = keepUserText(before?.labelSource, before?.label, written.label);
      const note = keepUserText(before?.noteSource, before?.note, written.note);
      sceneTexts[scene.start] = {
        label: label.text,
        labelSource: label.source,
        aiLabel: written.label,
        note: note.text,
        noteSource: note.source,
        aiNote: written.note,
        photoIds: scene.photoIds,
      };
    }
    const before = latest?.dayTexts[day.date];
    const written = texts.days.get(day.date);
    if (!written) {
      dayTexts[day.date] = inherited(before, `日 ${day.date}`);
      continue;
    }
    const title = keepUserText(before?.titleSource, before?.title, written.title);
    const summary = keepUserText(before?.summarySource, before?.summary, written.summary);
    dayTexts[day.date] = {
      title: title.text,
      titleSource: title.source,
      aiTitle: written.title,
      summary: summary.text,
      summarySource: summary.source,
      aiSummary: written.summary,
      sceneStarts: day.scenes.map((scene) => scene.start),
    };
  }
  return {
    current: {
      snapshotId: draft.snapshotId,
      dayStartHour: draft.dayStartHour,
      proposedStarts: draft.proposedStarts,
      sceneStarts: draft.sceneStarts,
      sceneTexts,
      dayTexts,
      writtenAt: now,
    },
    dropped: droppedEditsOf(latest, sceneTexts, dayTexts),
  };
}

/** 残せなかった文を、今までの知らせに足す（同じ日・場面・欄・文は重ねない） */
export function mergeDroppedEdits(existing: TimelineDroppedEdit[], dropped: TimelineDroppedEdit[]): TimelineDroppedEdit[] {
  const keyOf = (edit: TimelineDroppedEdit) => JSON.stringify([edit.kind, edit.key, edit.field, edit.text]);
  const seen = new Set(existing.map(keyOf));
  return [...existing, ...dropped.filter((edit) => !seen.has(keyOf(edit)))];
}

/** 日ごとに場面を組む（表示と同じ組み方。04 §1.6） */
function planOf(days: TimelineDatedDay[], sceneStarts: string[]): DayPlan[] {
  return days.map((day) => ({
    date: day.date,
    dayNumber: day.dayNumber,
    scenes: scenesOfDay(day.photos, sceneStarts).map((photos) => ({ start: photos[0].id, photoIds: photos.map((photo) => photo.id) })),
  }));
}

/** 前の完成版に、同じ最初の写真で写真も同じ場面があれば文を引き継ぐ */
function inheritsScene(current: TimelineCurrent | null, scene: ScenePlan): boolean {
  const before = current?.sceneTexts[scene.start];
  return before !== undefined && sameIds(before.photoIds, scene.photoIds);
}

/** 前の完成版に、同じ日付で区切りも同じ日があれば文を引き継ぐ */
function inheritsDay(current: TimelineCurrent | null, day: DayPlan): boolean {
  const before = current?.dayTexts[day.date];
  return before !== undefined && sameIds(before.sceneStarts, day.scenes.map((scene) => scene.start));
}

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/** 引き継ぐ文。最新の完成版に無ければ（書いている間に完成版が変わった）投げる（内部の失敗として書き直す） */
function inherited<T>(before: T | undefined, what: string): T {
  if (before === undefined) {
    throw new Error(`引き継ぐ文が完成版にありません: ${what}`);
  }
  return before;
}

/** 利用者が書いた文は残し、AI の文なら新しい文にする（AI の文は ai* にも残す） */
function keepUserText(
  source: 'ai' | 'user' | undefined,
  before: string | undefined,
  written: string
): { text: string; source: 'ai' | 'user' } {
  return source === 'user' && before !== undefined ? { text: before, source: 'user' } : { text: written, source: 'ai' };
}

/** 前の完成版にあって新しい完成版に無い場面・日の、利用者が書いた文（AI の文は捨てる） */
function droppedEditsOf(
  latest: TimelineCurrent | null,
  sceneTexts: Record<string, TimelineSceneText>,
  dayTexts: Record<string, TimelineDayText>
): TimelineDroppedEdit[] {
  if (!latest) {
    return [];
  }
  const dropped: TimelineDroppedEdit[] = [];
  for (const [key, text] of Object.entries(latest.sceneTexts)) {
    if (key in sceneTexts) continue;
    if (text.labelSource === 'user') dropped.push({ kind: 'scene', key, field: 'label', text: text.label });
    if (text.noteSource === 'user') dropped.push({ kind: 'scene', key, field: 'note', text: text.note });
  }
  for (const [key, text] of Object.entries(latest.dayTexts)) {
    if (key in dayTexts) continue;
    if (text.titleSource === 'user') dropped.push({ kind: 'day', key, field: 'title', text: text.title });
    if (text.summarySource === 'user') dropped.push({ kind: 'day', key, field: 'summary', text: text.summary });
  }
  return dropped;
}

/**
 * AI に文脈として渡す、前の完成版の文（06 §8.4。書き換えさせない）
 *
 * 引き継ぐ場面・日は文の全部を、書き直す場面・日は利用者が書いた欄だけを渡す（AI の前の文は渡さない。書き直させるため）
 * @param call この呼び出しに渡す日と場面（日の文は、その日の最初の場面を含む呼び出しだけで渡す）
 * @param fullDays 日付ごとの日（1日を分けたときも、引き継ぐかはその日の全部の区切りで決める）
 * @param indexOf 写真の id から、この呼び出しの番号
 */
function contextOf(
  call: CallDay[],
  current: TimelineCurrent | null,
  fullDays: Map<string, DayPlan>,
  indexOf: (photoId: string) => number
): string[] {
  if (!current) {
    return [];
  }
  const lines: string[] = [];
  const line = (subject: string, fields: [string, string, boolean][]) => {
    // 前の文（利用者が直した文を含む）の改行は空白にする（写真の行と同じ。改行の後ろが別の行に見えないように）
    const shown = fields.filter(([, , keep]) => keep).map(([name, text]) => `${name}「${oneLine(text)}」`);
    if (shown.length > 0) {
      lines.push(`${subject}: ${shown.join(' ')}`);
    }
  };
  for (const day of call) {
    const dayText = day.writesDay ? current.dayTexts[day.date] : undefined;
    if (dayText) {
      const all = inheritsDay(current, fullDays.get(day.date)!);
      line(`${day.date}（${all ? '引き継ぐ' : '利用者が書いた'}）`, [
        ['タイトル', dayText.title, all || dayText.titleSource === 'user'],
        ['まとめ', dayText.summary, all || dayText.summarySource === 'user'],
      ]);
    }
    for (const scene of day.scenes) {
      const sceneText = current.sceneTexts[scene.start];
      if (sceneText) {
        const all = inheritsScene(current, scene);
        line(`${indexOf(scene.start)}番の場面（${all ? '引き継ぐ' : '利用者が書いた'}）`, [
          ['見出し', sceneText.label, all || sceneText.labelSource === 'user'],
          ['一言', sceneText.note, all || sceneText.noteSource === 'user'],
        ]);
      }
    }
  }
  return lines;
}
