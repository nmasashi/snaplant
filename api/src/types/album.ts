/**
 * 旅行アルバムの型定義
 *
 * 旅行と写真は Cosmos DB の album コンテナに type で区別して置く
 * （docs/travel-album/04_data_design.md §1）。
 */

/** 旅行（API の応答の形） */
export interface Trip {
  id: string;
  name: string;
  description: string | null;
  /** 利用者のタグ。段階2は常に空 */
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

/** 旅行の Cosmos DB のドキュメント */
export interface TripDocument extends Trip {
  type: 'trip';
}

/**
 * 写真から導いた集計を足した旅行
 *
 * 枚数・撮影期間・表紙は旅行のドキュメントに保存しない。カウンタを持つと
 * 同時更新で狂い、写真の移動のたびに2つの旅行を更新することになるため
 */
export interface TripSummary extends Trip {
  photoCount: number;
  /** 撮影日時のある写真の最初と最後（タイムゾーン無し）。無ければ null */
  firstTakenAt: string | null;
  lastTakenAt: string | null;
  /** 先頭の写真のサムネイルの SAS 付き URL。写真が無ければ null */
  coverThumbnailUrl: string | null;
}

/** 旅行の作成・更新で受け取る項目 */
export interface TripInput {
  name: string;
  description: string | null;
}
