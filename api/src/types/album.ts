import { CatalogKind, PhotoKind } from '../catalog/kinds';

/**
 * 旅行アルバムの型定義
 *
 * 旅行と写真は Cosmos DB の album コンテナに type で区別して置く
 * （docs/04_data_design.md §1）。
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
  /** 緯度。利用者が地名だけを書いた写真（位置情報の無い写真。C-2）は null */
  latitude: number | null;
  /** 経度。緯度と同じく null のことがある */
  longitude: number | null;
  /** 地名（市区町村など）。無ければ null */
  placeName: string | null;
  /** 地名の出どころ。段階2は端末の Geocoder（device）か null。利用者が解析を頼むときに直したら user（C-2） */
  placeSource: 'device' | 'server' | 'user' | null;
}

/** 写真の解析（分類・識別・タグの提案）の進み具合。段階2の写真は state: none、段階3から送った写真は pending から始まる。tagging と tag は C-4 */
export interface PhotoProcessing {
  state: 'none' | 'pending' | 'classifying' | 'identifying' | 'tagging' | 'done' | 'failed';
  step: 'classify' | 'identify' | 'tag' | null;
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
  takenAtSource: 'exif' | 'user' | 'none';
  /** 並べ替え用の日時（utils/sortAt.ts） */
  sortAt: string;
  location: PhotoLocation | null;
  category: string | null;
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
  /**
   * 利用者が写真の中の場所に付けたタグ（04 §2）。C-3a より前は文字列の配列で、その頃に付けた文字列が残りうる
   * （画面が無かったので本番は空のはず）。欄の無い文書もありうる。C-4 より前のタグには出どころが無い。読むときは応答の形（photoView.ts）で揃える
   */
  tags?: (StoredPhotoTag | string)[];
  /** photos コンテナの Blob 名 */
  blobName: string;
  /** サムネイルの Blob 名。無ければ null */
  thumbnailBlobName: string | null;
  /** 利用者がカテゴリを手で決めたら user（02 §5 #53）。C-1 より前の写真には項目が無い（無いのは null と同じ） */
  categorySource?: 'user' | null;
  /** お気に入り（02 §5 #63）。F より前の写真には項目が無い（無いのは false と同じ） */
  favorite?: boolean;
}

/** 写真（API の応答の形）。Blob 名の代わりに SAS 付きの URL を持つ */
export interface Photo extends PhotoFields {
  /** 利用者が写真の中の場所に付けたタグ（名前・種類・位置の形のものだけ） */
  tags: PhotoTag[];
  /** 利用者がカテゴリを手で決めたら user。無ければ null */
  categorySource: 'user' | null;
  /** お気に入りか */
  favorite: boolean;
  imageUrl: string;
  thumbnailUrl: string | null;
}

/** 図鑑の項目（識別済みの写真を種類と名前でまとめたもの。docs/05_api_design.md §3.3.1） */
export interface CatalogEntry {
  kind: string;
  name: string;
  /** 以下 attributes までは、その名前の写真のうち信頼度が最も高いものの識別から取る */
  confidence: number;
  description: string | null;
  characteristics: string | null;
  attributes: Record<string, unknown>;
  /** 属の学名（ラテン語の1語。図鑑の一覧はこれでまとめる。02 §5 #56）。分からなければ、または属を持たない種類は null */
  genus: string | null;
  /** 属名（日本語。属の見出しに出す）。分からなければ null */
  genusName: string | null;
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

/** 写真の中の場所に付けるタグ（04 §2。02 §5 #57。C-3） */
export interface PhotoTag {
  /** 名前（前後の空白を除き、TAG_VALIDATION.MAX_LENGTH 文字まで。同じ名前のタグが写真に何個あってもよい） */
  name: string;
  /** 種類（カテゴリと同じ plant・food・landscape・other） */
  kind: PhotoKind;
  /** 向きを直した後の画像の中の位置の割合（左上が 0、右下が 1） */
  x: number;
  y: number;
  /** 出どころ（AI が提案したか、利用者が付けた・直したか。C-4。02 §5 #61）。C-4 より前のタグには無い（user として扱う） */
  source: TagSource;
}

/** 保存してあるタグ（C-4 より前のタグには出どころが無い） */
export type StoredPhotoTag = Omit<PhotoTag, 'source'> & { source?: TagSource };

/** タグの出どころ（04 §2） */
export type TagSource = 'ai' | 'user';
