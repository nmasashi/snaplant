import { CatalogKind } from '../catalog/kinds';

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

/** 写真の位置情報 */
export interface PhotoLocation {
  latitude: number;
  longitude: number;
  /** 地名（市区町村など）。無ければ null */
  placeName: string | null;
  /** 地名の出どころ。段階2は端末の Geocoder（device）か null */
  placeSource: 'device' | 'server' | null;
}

/** 写真の解析（分類・識別）の進み具合。段階2の写真は state: none、段階3から送った写真は pending から始まる */
export interface PhotoProcessing {
  state: 'none' | 'pending' | 'classifying' | 'identifying' | 'done' | 'failed';
  step: 'classify' | 'identify' | null;
  attempts: number;
  lastError: string | null;
  updatedAt: string | null;
}

/**
 * 写真の項目のうち、ドキュメントと応答で共通のもの
 *
 * 段階3・4で使う項目（category・classification など）も段階2から null で持つ。
 * 項目が無いドキュメントと null のドキュメントは Cosmos SQL での振る舞いが違う
 * （null との等価比較や IS_NULL は、項目が無いと偽）ため、「無い」を2通り扱わずに済むようにする
 */
interface PhotoFields {
  /** 画像のバイト列の SHA-256（16進・小文字 64 文字） */
  id: string;
  /** 属する旅行。どの旅行にも属さないときは null を必ず書く（欠けると c.tripId = null に一致せず一覧から消える） */
  tripId: string | null;
  contentType: string;
  fileSize: number;
  /** 撮影日時（タイムゾーン無しの YYYY-MM-DDTHH:mm:ss）。無ければ null */
  takenAt: string | null;
  takenAtSource: 'exif' | 'none';
  /** 並べ替え用の日時（utils/sortAt.ts） */
  sortAt: string;
  location: PhotoLocation | null;
  category: string | null;
  tags: string[];
  comment: string | null;
  commentSource: 'ai' | 'user' | null;
  hint: string | null;
  classification: unknown | null;
  identification: unknown | null;
  processing: PhotoProcessing;
  uploadedAt: string;
  updatedAt: string;
}

/** 写真の Cosmos DB のドキュメント */
export interface PhotoDocument extends PhotoFields {
  type: 'photo';
  /** photos コンテナの Blob 名 */
  blobName: string;
  /** サムネイルの Blob 名。無ければ null */
  thumbnailBlobName: string | null;
  /** 植物図鑑から移した写真の、元の植物の id（移行の突き合わせのためだけの項目。06 §7） */
  legacyPlantId?: string;
}

/** 写真（API の応答の形）。Blob 名の代わりに SAS 付きの URL を持つ */
export interface Photo extends PhotoFields {
  imageUrl: string;
  thumbnailUrl: string | null;
}

/** 図鑑の項目（識別済みの写真を種類と名前でまとめたもの。docs/travel-album/05_api_design.md §3.3.1） */
export interface CatalogEntry {
  kind: string;
  name: string;
  /** 以下 attributes までは、その名前の写真のうち信頼度が最も高いものの識別から取る */
  confidence: number;
  description: string | null;
  characteristics: string | null;
  attributes: Record<string, unknown>;
  /** その名前の写真の枚数 */
  photoCount: number;
  /** 見出しの写真のサムネイル（無ければ原寸）の SAS 付き URL */
  coverThumbnailUrl: string;
}

/** 検証を通った図鑑の項目の一覧のクエリ（GET /api/catalog/entries） */
export interface CatalogEntriesQuery {
  kind: CatalogKind;
  /** 何件目から（0 始まり） */
  offset: number;
  /** 何件まで */
  limit: number;
}

/** 検証を通った図鑑の項目の詳細のクエリ（GET /api/catalog/entry） */
export interface CatalogEntryQuery {
  kind: CatalogKind;
  /** 項目の名前（前後の空白を除いたもの） */
  name: string;
  /** 写真の1ページの最大枚数 */
  limit: number;
  /** 前のページの継続トークン。先頭からなら undefined */
  continuationToken: string | undefined;
}
