import { TIMELINE_MAX_PHOTOS_PER_CALL } from '../constants/album';
import { TimelineCurrent, TimelineDraft, TimelinePhotoSnapshot } from '../types/timeline';
import { TimelineProposerService } from './timelineProposerService';
import { TimelinePromptPhoto } from './timelinePrompt';
import { TimelineDatedDay, datedDaysOf } from './timelineView';

/**
 * 区切りの案を出す（06 §8.2）
 *
 * AI の案に、作り直しなら完成版で利用者が直した区切り（足した・消した）を当て、最後に各日の最初の写真を足す
 * （利用者が消した区切りが、日付の切り替えの時刻を変えた後などに日の最初になっていても、場面が日をまたがないように）
 * @returns AI の案（各日の最初の写真を足したもの）と区切り。どちらも場面の最初の写真の id で、撮影の順
 */
export async function proposeScenes(
  photos: TimelinePhotoSnapshot[],
  draft: TimelineDraft,
  current: TimelineCurrent | null
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

  let starts = new Set(proposed);
  if (draft.reason === 'rebuild' && current) {
    const aiStarts = new Set(current.proposedStarts);
    const userStarts = new Set(current.sceneStarts);
    const added = current.sceneStarts.filter((id) => !aiStarts.has(id));
    const removed = new Set(current.proposedStarts.filter((id) => !userStarts.has(id)));
    starts = new Set([...proposed, ...added].filter((id) => !removed.has(id)));
  }
  // 撮影の順に並べる。控えに無い・撮影日時の無い写真の区切りはここで落ちる
  const inOrder = (ids: Set<string>) => ordered.filter((id) => ids.has(id));
  return {
    proposedStarts: inOrder(new Set([...proposed, ...dayStarts])),
    sceneStarts: inOrder(new Set([...starts, ...dayStarts])),
  };
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
