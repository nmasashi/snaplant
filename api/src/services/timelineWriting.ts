import { TimelineCurrent, TimelineDayText, TimelineDraft, TimelinePhotoSnapshot, TimelineSceneText } from '../types/timeline';
import { TimelineWriterService } from './timelineWriterService';
import { datedDaysOf } from './timelineView';

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
  scenes: Map<string, { label: string; note: string }>;
  days: Map<string, { title: string; summary: string }>;
}

/**
 * 下書きの区切りに文を書かせる（06 §8.3）
 *
 * @returns 下書きの区切りで組んだ日と場面と、AI が書いた文（完成版を組むのは assembleCurrent）
 */
export async function writeDraftTexts(photos: TimelinePhotoSnapshot[], draft: TimelineDraft): Promise<{ plan: DayPlan[]; texts: TimelineAiTexts }> {
  const days = datedDaysOf(photos, draft.dayStartHour);
  const plan = planOf(days, draft.sceneStarts);
  const ordered = days.flatMap((day) => day.photos.map((photo) => ({ photo, dayNumber: day.dayNumber })));
  const indexOf = new Map(ordered.map(({ photo }, index) => [photo.id, index]));
  const sceneStarts = plan.flatMap((day) => day.scenes.map((scene) => indexOf.get(scene.start)!));
  const written = await new TimelineWriterService().write({
    photos: ordered,
    sceneStarts,
    scenesToWrite: sceneStarts,
    daysToWrite: plan.map(({ date, dayNumber }) => ({ date, dayNumber })),
  });
  return {
    plan,
    texts: {
      scenes: new Map([...written.scenes].map(([index, text]) => [ordered[index].photo.id, text])),
      days: written.days,
    },
  };
}

/**
 * 下書きと AI の文から完成版を組む（下書きを完成版に入れ替える。06 §8.3 の 6）
 * @param now 書き終えた時刻
 */
export function assembleCurrent(draft: TimelineDraft, plan: DayPlan[], texts: TimelineAiTexts, now: string): TimelineCurrent {
  const sceneTexts: Record<string, TimelineSceneText> = {};
  const dayTexts: Record<string, TimelineDayText> = {};
  for (const day of plan) {
    for (const scene of day.scenes) {
      const { label, note } = texts.scenes.get(scene.start)!;
      sceneTexts[scene.start] = { label, labelSource: 'ai', aiLabel: label, note, noteSource: 'ai', aiNote: note, photoIds: scene.photoIds };
    }
    const { title, summary } = texts.days.get(day.date)!;
    dayTexts[day.date] = {
      title,
      titleSource: 'ai',
      aiTitle: title,
      summary,
      summarySource: 'ai',
      aiSummary: summary,
      sceneStarts: day.scenes.map((scene) => scene.start),
    };
  }
  return {
    snapshotId: draft.snapshotId,
    dayStartHour: draft.dayStartHour,
    proposedStarts: draft.proposedStarts,
    sceneStarts: draft.sceneStarts,
    sceneTexts,
    dayTexts,
    writtenAt: now,
  };
}

/** 日ごとに、各日の最初の写真と区切りの写真から場面を組む（表示の組み方と同じ。04 §1.6） */
function planOf(days: ReturnType<typeof datedDaysOf>, sceneStarts: string[]): DayPlan[] {
  const starts = new Set(sceneStarts);
  return days.map((day) => {
    const scenes: ScenePlan[] = [];
    day.photos.forEach((photo, index) => {
      if (index === 0 || starts.has(photo.id)) {
        scenes.push({ start: photo.id, photoIds: [photo.id] });
      } else {
        scenes[scenes.length - 1].photoIds.push(photo.id);
      }
    });
    return { date: day.date, dayNumber: day.dayNumber, scenes };
  });
}
