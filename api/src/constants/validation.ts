/**
 * バリデーション関連の定数
 */

/**
 * 環境変数から正の整数を読む
 *
 * parseInt は数値でない文字列に対して NaN を返す。NaN をそのまま上限値に
 * 使うと、比較の向きによって挙動が変わる。
 *
 * - `length > NaN` は常に false。つまり**上限が静かに消える**（fail open）
 * - `size <= NaN` は常に false。全部拒否になる（fail closed）
 *
 * 前者が危険なので、数値として読めない場合は既定値へフォールバックする。
 * あわせてエラーメッセージに NaN が出ることも防ぐ
 * @param value 環境変数の値
 * @param fallback 読めない場合に使う既定値
 * @returns 正の整数
 */
export function positiveIntFromEnv(value: string | undefined, fallback: number): number {
  const parsed = parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * 環境変数を時刻（0〜23 時）として読む。0〜23 の整数として読めなければ既定値に戻す
 *
 * positiveIntFromEnv() は 0 を受け付けない（0 は「上限なし」になりうるので既定値に戻す）が、時刻の 0（深夜0時）は正しい値。
 * parseInt は "4abc" を 4 と読むので、数字だけの値に限る
 * @param value 環境変数の値
 * @param fallback 読めないときの値
 */
export function hourFromEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || !/^\d{1,2}$/.test(value)) {
    return fallback;
  }
  const hour = Number(value);
  return hour <= 23 ? hour : fallback;
}

// ファイルアップロード制限
export const FILE_UPLOAD = {
  // 最大ファイルサイズ（バイト）
  MAX_SIZE: positiveIntFromEnv(process.env.MAX_FILE_SIZE, 10485760), // デフォルト: 10MB
  
  // サポートされる画像形式
  SUPPORTED_IMAGE_TYPES: [
    'image/jpeg',
    'image/jpg', 
    'image/png',
    'image/webp',
    'image/gif'
  ] as const,
  
  // Content-Typeから拡張子を引く表
  //
  // Blob名の拡張子はクライアントが送るファイル名から取らない。
  // ファイル名に / が含まれていると拡張子に紛れ込み、Blob名と
  // SASの署名対象（URLの最後のセグメント）がずれて、
  // SAS URLが無効になる（写真の Blob 名は <写真の id><拡張子>）。
  // SUPPORTED_IMAGE_TYPESと同じ場所に置き、許可リストを1箇所にまとめる
  EXTENSION_BY_CONTENT_TYPE: {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif'
  } as Record<string, string>,

  // エラーメッセージ
  ERROR_MESSAGES: {
    UNSUPPORTED_TYPE: 'JPEG、PNG、WebP、GIFファイルのみアップロード可能です'
  }
} as const;

// 解析のやり直しの手がかり（hint）の制限（植物図鑑の補足情報 contextInfo の頃からの名前のまま）
//
// プロンプトに直接埋め込まれ、ログにも全文が出るため、トークン消費と
// ログ量の両方に効く。クライアント側（やり直しダイアログの手がかりの入力欄）が
// 既に maxLength: 500 を強制しているが、APIはFunction Keyがあれば
// 直接叩けるのでサーバ側でも守る
export const CONTEXT_INFO_VALIDATION = {
  MAX_LENGTH: positiveIntFromEnv(process.env.CONTEXT_INFO_MAX_LENGTH, 500),

  ERROR_MESSAGES: {
    TOO_LONG: `補足情報は${positiveIntFromEnv(process.env.CONTEXT_INFO_MAX_LENGTH, 500)}文字以内で指定してください`,
    NOT_A_STRING: '補足情報は文字列で指定してください'
  }
} as const;

// その他のバリデーション定数
export const GENERAL_VALIDATION = {
  // UUID正規表現
  UUID_REGEX: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
} as const;
// 旅行アルバムの旅行の文字数制限
export const TRIP_VALIDATION = {
  MAX_LENGTH: {
    NAME: positiveIntFromEnv(process.env.TRIP_NAME_MAX_LENGTH, 100),
    DESCRIPTION: positiveIntFromEnv(process.env.TRIP_DESCRIPTION_MAX_LENGTH, 1000)
  },

  ERROR_MESSAGES: {
    NAME_NOT_A_STRING: '旅行名は文字列で指定してください',
    DESCRIPTION_NOT_A_STRING: '説明は文字列で指定してください',
    NAME_REQUIRED: '旅行名が指定されていません',
    NAME_TOO_LONG: `旅行名は${positiveIntFromEnv(process.env.TRIP_NAME_MAX_LENGTH, 100)}文字以内で指定してください`,
    DESCRIPTION_TOO_LONG: `説明は${positiveIntFromEnv(process.env.TRIP_DESCRIPTION_MAX_LENGTH, 1000)}文字以内で指定してください`
  }
} as const;

// 旅行アルバムの写真の入力検証
export const PHOTO_VALIDATION = {
  // 写真 ID は画像のバイト列の SHA-256（16進・小文字のみ）。大文字を許すと同じ写真に2つの id ができる
  ID_REGEX: /^[0-9a-f]{64}$/,
  // 撮影日時はタイムゾーン無し（Z や +09:00 を付けると Flutter の toLocal() で9時間ずれる）
  TAKEN_AT_REGEX: /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/,
  // 緯度・経度は10進だけ。Number() に任せると 16進・2進・8進・指数表記・前後の空白も数値として通る
  COORDINATE_REGEX: /^-?[0-9]+(\.[0-9]+)?$/,
  MAX_LENGTH: {
    PLACE_NAME: positiveIntFromEnv(process.env.PHOTO_PLACE_NAME_MAX_LENGTH, 100),
    COMMENT: positiveIntFromEnv(process.env.PHOTO_COMMENT_MAX_LENGTH, 500)
  },
  THUMBNAIL_MAX_SIZE: positiveIntFromEnv(process.env.THUMBNAIL_MAX_SIZE, 1048576), // デフォルト: 1MB
  // 写真一覧の1ページの枚数（既定と上限）
  PAGE_SIZE: positiveIntFromEnv(process.env.PHOTO_PAGE_SIZE, 100),
  MAX_PAGE_SIZE: positiveIntFromEnv(process.env.PHOTO_MAX_PAGE_SIZE, 200),

  ERROR_MESSAGES: {
    PLACE_NAME_INVALID: `地名は${positiveIntFromEnv(process.env.PHOTO_PLACE_NAME_MAX_LENGTH, 100)}文字以内で指定してください`,
    COMMENT_TOO_LONG: `コメントは${positiveIntFromEnv(process.env.PHOTO_COMMENT_MAX_LENGTH, 500)}文字以内で指定してください`,
    LIMIT_INVALID: `1ページの枚数は1〜${positiveIntFromEnv(process.env.PHOTO_MAX_PAGE_SIZE, 200)}で指定してください`,
    CONTINUATION_TOKEN_INVALID: '継続トークンの形式が無効です'
  }
} as const;

// 旅行アルバムの写真の移動の制限
export const MOVE_VALIDATION = {
  // 1回の要求で移せる写真の数（重複を除く前の件数）
  MAX_IDS: positiveIntFromEnv(process.env.MOVE_MAX_IDS, 200),

  ERROR_MESSAGES: {
    TOO_MANY: `一度に移動できる写真は${positiveIntFromEnv(process.env.MOVE_MAX_IDS, 200)}枚までです`
  }
} as const;

// 旅行アルバムの利用者のタグの制限
export const TAG_VALIDATION = {
  MAX_LENGTH: positiveIntFromEnv(process.env.TAG_MAX_LENGTH, 30),
  // 1枚の写真に付けられるタグの数（重複を除いた後）。大量のタグでドキュメントが Cosmos の上限（2MB）に近づかないように
  MAX_COUNT: positiveIntFromEnv(process.env.TAG_MAX_COUNT, 20),

  ERROR_MESSAGES: {
    INVALID_LENGTH: `タグは1〜${positiveIntFromEnv(process.env.TAG_MAX_LENGTH, 30)}文字で指定してください`,
    TOO_MANY: `タグは${positiveIntFromEnv(process.env.TAG_MAX_COUNT, 20)}個までです`
  }
} as const;

// 図鑑の項目の名前の最大文字数（文言に埋め込むので、オブジェクトの外に置く）
const CATALOG_NAME_MAX_LENGTH = 100;

// 旅行アルバムの図鑑の項目（段階4）
export const CATALOG_VALIDATION = {
  // 項目の名前（識別の identification.name）の最大文字数。識別の応答の検証と、図鑑の項目を名前で開く API の検証で同じ値を使う
  // （docs/04_data_design.md §3.1）。AI が返す値なので環境変数では変えない
  NAME_MAX_LENGTH: CATALOG_NAME_MAX_LENGTH,
  // 項目の一覧（GET /api/catalog/entries）の1ページの件数（既定と上限）
  PAGE_SIZE: positiveIntFromEnv(process.env.CATALOG_PAGE_SIZE, 50),
  MAX_PAGE_SIZE: positiveIntFromEnv(process.env.CATALOG_MAX_PAGE_SIZE, 100),

  ERROR_MESSAGES: {
    KIND_INVALID: '図鑑の種類が無効です',
    PAGE_INVALID: 'ページの指定が無効です',
    NAME_REQUIRED: '図鑑の項目の名前が指定されていません',
    NAME_TOO_LONG: `図鑑の項目の名前は${CATALOG_NAME_MAX_LENGTH}文字以内で指定してください`
  }
} as const;

// 旅行アルバムのタイムラインの文（段階5）
export const TIMELINE_VALIDATION = {
  // 文の最大文字数。AI が書いた文はこの長さで切り詰め、利用者が直す文（5-2b の PATCH）はこれを超えると 400（docs/05_api_design.md §4）
  MAX_LENGTH: {
    TITLE: positiveIntFromEnv(process.env.TIMELINE_TITLE_MAX_LENGTH, 40),
    SUMMARY: positiveIntFromEnv(process.env.TIMELINE_SUMMARY_MAX_LENGTH, 400),
    LABEL: positiveIntFromEnv(process.env.TIMELINE_LABEL_MAX_LENGTH, 30),
    NOTE: positiveIntFromEnv(process.env.TIMELINE_NOTE_MAX_LENGTH, 200)
  }
} as const;
