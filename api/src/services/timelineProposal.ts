import { TIMELINE_MAX_PHOTOS_PER_CALL } from '../constants/album';
import { TimelineDraft, TimelinePhotoSnapshot } from '../types/timeline';
import { TimelineProposerService } from './timelineProposerService';
import { TimelinePromptPhoto } from './timelinePrompt';
import { TimelineDatedDay, datedDaysOf } from './timelineView';

/**
 * 区切りの案を出す（06 §8.2）
 *
 * AI の案に各日の最初の写真を足す（AI の案が日の最初の写真を落としても、場面が日をまたがないように）。
 * 作り直しでも、完成版で利用者が直した区切りは当てない（一から作る。2026-10-27 に人間が決定）
 * @returns AI の案（各日の最初の写真を足したもの）と区切り。どちらも場面の最初の写真の id で、撮影の順
 */
export async function proposeScenes(
  photos: TimelinePhotoSnapshot[],
  draft: TimelineDraft
): Promise<{ proposedStarts: string[]; sceneStarts: string[] }> {
  const days = datedDaysOf(photos, draft.dayStartHour);
  // 撮影日時のある写真の id（撮影の順）
  const ordered = days.flatMap((day) => day.photos.map((photo) => photo.id));
  const { calls, cuts } = proposalCallsOf(days);
  const proposer = new TimelineProposerService();
  const proposed: string[] = [];
  // 順に呼ぶ（functionTimeout に収まる数で、並べると AI の同時実行の枠を一度に使う）。途中で失敗したら投げ、何も書かない
  for (const call of calls) {
    proposed.push(...(await proposer.propose(call)).map((index) => call[index].photo.id));
  }
  // 各日の最初の写真と、1日を上限で切った切れ目は、AI の案によらず場面の始まり
  const dayStarts = [...days.map((day) => day.photos[0].id), ...cuts];

  // 撮影の順に並べる
  const starts = new Set([...proposed, ...dayStarts]);
  const inOrder = ordered.filter((id) => starts.has(id));
  return { proposedStarts: inOrder, sceneStarts: inOrder };
}

/**
 * AI に渡す写真を、一度に渡せる数（TIMELINE_MAX_PHOTOS_PER_CALL）ごとの呼び出しに分ける（06 §8.4）
 *
 * 日の境目で分け、入る日はまとめる。1日で上限を超える日は撮影の順に上限ごとに切り、切れ目の写真を返す（区切りにする）
 */
function proposalCallsOf(days: TimelineDatedDay[]): { calls: TimelinePromptPhoto[][]; cuts: string[] } {
  const calls: TimelinePromptPhoto[][] = [];
  const cuts: string[] = [];
  let call: TimelinePromptPhoto[] = [];
  for (const day of days) {
    const photos = day.photos.map((photo) => ({ photo, dayNumber: day.dayNumber }));
    if (call.length > 0 && call.length + photos.length > TIMELINE_MAX_PHOTOS_PER_CALL) {
      calls.push(call);
      call = [];
    }
    for (let start = 0; start < photos.length; start += TIMELINE_MAX_PHOTOS_PER_CALL) {
      if (start > 0) {
        calls.push(call);
        call = [];
        cuts.push(photos[start].photo.id);
      }
      call.push(...photos.slice(start, start + TIMELINE_MAX_PHOTOS_PER_CALL));
    }
  }
  if (call.length > 0) {
    calls.push(call);
  }
  return { calls, cuts };
}
