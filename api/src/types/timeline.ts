/**
 * タイムライン（段階5）の型定義
 *
 * 旅行ごとのタイムラインの文書（type: timeline）と、作るときに取った写真の控え（type: timelinePhotos）。
 * 完成版（current）と下書き（draft）を分けて持ち、下書きの文を書き終えるまで完成版は変えない
 * （docs/04_data_design.md §1.6、02 §5 #48）
 */

/** 下書きの裏の処理（区切り案・文）の状態。写真の processing と同じ考え方（06 §8.1） */
export interface TimelineJob {
  step: 'propose' | 'write';
  state: 'pending' | 'running' | 'failed';
  attempts: number;
  /** どこで失敗したか（"ai" / "internal"）。例外の文言は入れない */
  lastError: string | null;
  updatedAt: string;
}

/** 下書き（作る・作り直す・完成版の区切りを直す途中のもの） */
export interface TimelineDraft {
  /** 下書きごとに振る UUID。キューのメッセージにも入れ、やめた・出し直した下書きの古いメッセージを見分ける */
  id: string;
  /** 初めて作る・作り直す（区切り案から）・完成版の区切りを直す */
  reason: 'create' | 'rebuild' | 'recut';
  phase: 'proposing' | 'reviewing' | 'writing';
  /** 裏の処理。確かめ中（reviewing）は null */
  job: TimelineJob | null;
  /** 写真の控え（timelinePhotos の id） */
  snapshotId: string;
  /** 日付の切り替えの時刻（0〜23）。控えを取ったときの TIMELINE_DAY_START_HOUR */
  dayStartHour: number;
  /** AI が出した区切り（場面の最初の写真の id）。利用者が直す前の案 */
  proposedStarts: string[];
  /** 今の区切り（場面の最初の写真の id。撮影の順） */
  sceneStarts: string[];
  startedAt: string;
}

/** 場面の文（見出し・一言と、書いた主） */
export interface TimelineSceneText {
  label: string;
  labelSource: 'ai' | 'user';
  aiLabel: string;
  note: string;
  noteSource: 'ai' | 'user';
  aiNote: string;
  /** 書いたときの場面の写真（区切りが変わったかの判定） */
  photoIds: string[];
}

/** 日の文（タイトル・まとめと、書いた主） */
export interface TimelineDayText {
  title: string;
  titleSource: 'ai' | 'user';
  aiTitle: string;
  summary: string;
  summarySource: 'ai' | 'user';
  aiSummary: string;
  /** 書いたときのその日の区切り */
  sceneStarts: string[];
}

/** 完成版 */
export interface TimelineCurrent {
  snapshotId: string;
  dayStartHour: number;
  proposedStarts: string[];
  sceneStarts: string[];
  /** 場面の最初の写真の id → 文 */
  sceneTexts: Record<string, TimelineSceneText>;
  /** 日付（YYYY-MM-DD）→ 文 */
  dayTexts: Record<string, TimelineDayText>;
  writtenAt: string;
}

/** 文を書き直したときに残せなかった、利用者が書いた文 */
export interface TimelineDroppedEdit {
  kind: 'day' | 'scene';
  /** 日付か、場面の最初の写真の id */
  key: string;
  field: 'title' | 'summary' | 'label' | 'note';
  text: string;
}

/** タイムラインの Cosmos DB の文書（旅行ごとに1件。id は "timeline-" + 旅行の id） */
export interface TimelineDocument {
  id: string;
  type: 'timeline';
  tripId: string;
  current: TimelineCurrent | null;
  draft: TimelineDraft | null;
  droppedEdits: TimelineDroppedEdit[];
  createdAt: string;
  updatedAt: string;
}

/** 写真の控えの1枚（区切り案を出すときに取る。後から変えない） */
export interface TimelinePhotoSnapshot {
  id: string;
  /** 撮影日時（タイムゾーン無し）。無ければ null */
  takenAt: string | null;
  category: string | null;
  /** 識別の名前。分類と合わない・識別していない写真は null */
  name: string | null;
  placeName: string | null;
  /** コメントの先頭（AI に渡す分だけ。TIMELINE_SNAPSHOT_COMMENT_LENGTH） */
  comment: string | null;
  blobName: string;
  thumbnailBlobName: string | null;
}

/** 写真の控えの Cosmos DB の文書（id は "timeline-photos-" + 旅行の id + "-" + UUID） */
export interface TimelinePhotosDocument {
  id: string;
  type: 'timelinePhotos';
  tripId: string;
  /** 撮影日時のある写真が撮影の順で先、無い写真が後 */
  photos: TimelinePhotoSnapshot[];
  createdAt: string;
}

/** 下書きの状態（応答の形。05 §5.15） */
export interface TimelineDraftStatus {
  id: string;
  reason: TimelineDraft['reason'];
  phase: TimelineDraft['phase'];
  job: Pick<TimelineJob, 'step' | 'state' | 'lastError'> | null;
  startedAt: string;
}
