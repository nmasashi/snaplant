/**
 * バリデーション関連の定数
 */

// ファイルアップロード制限
export const FILE_UPLOAD = {
  // 最大ファイルサイズ（バイト）
  MAX_SIZE: parseInt(process.env.MAX_FILE_SIZE || '10485760'), // デフォルト: 10MB
  
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
  // SAS URLが無効になったうえ一時コンテナに孤児Blobが残る。
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
    SIZE_EXCEEDED: `ファイルサイズは${Math.floor(parseInt(process.env.MAX_FILE_SIZE || '10485760') / 1024 / 1024)}MB以下にしてください`,
    UNSUPPORTED_TYPE: 'JPEG、PNG、WebP、GIFファイルのみアップロード可能です'
  }
} as const;

// 植物データの文字数制限
export const PLANT_VALIDATION = {
  // 各フィールドの最大文字数
  MAX_LENGTH: {
    NAME: parseInt(process.env.PLANT_NAME_MAX_LENGTH || '100'),
    SCIENTIFIC_NAME: parseInt(process.env.PLANT_SCIENTIFIC_NAME_MAX_LENGTH || '150'),
    FAMILY_NAME: parseInt(process.env.PLANT_FAMILY_NAME_MAX_LENGTH || '100'),
    DESCRIPTION: parseInt(process.env.PLANT_DESCRIPTION_MAX_LENGTH || '1000'),
    CHARACTERISTICS: parseInt(process.env.PLANT_CHARACTERISTICS_MAX_LENGTH || '500')
  },
  
  // 信頼度の範囲
  CONFIDENCE: {
    MIN: 0,
    MAX: 100
  },
  
  // エラーメッセージ
  ERROR_MESSAGES: {
    NAME_TOO_LONG: `植物名は${parseInt(process.env.PLANT_NAME_MAX_LENGTH || '100')}文字以内で指定してください`,
    SCIENTIFIC_NAME_TOO_LONG: `学名は${parseInt(process.env.PLANT_SCIENTIFIC_NAME_MAX_LENGTH || '150')}文字以内で指定してください`,
    FAMILY_NAME_TOO_LONG: `科名は${parseInt(process.env.PLANT_FAMILY_NAME_MAX_LENGTH || '100')}文字以内で指定してください`,
    DESCRIPTION_TOO_LONG: `説明は${parseInt(process.env.PLANT_DESCRIPTION_MAX_LENGTH || '1000')}文字以内で指定してください`,
    CHARACTERISTICS_TOO_LONG: `特徴は${parseInt(process.env.PLANT_CHARACTERISTICS_MAX_LENGTH || '500')}文字以内で指定してください`,
    CONFIDENCE_OUT_OF_RANGE: '信頼度は0から100の間の数値で指定してください'
  }
} as const;

// 補足情報（contextInfo）の制限
//
// プロンプトに直接埋め込まれ、ログにも全文が出るため、トークン消費と
// ログ量の両方に効く。クライアント側（camera_screen.dart の入力欄）が
// 既に maxLength: 500 を強制しているが、APIはFunction Keyがあれば
// 直接叩けるのでサーバ側でも守る
export const CONTEXT_INFO_VALIDATION = {
  MAX_LENGTH: parseInt(process.env.CONTEXT_INFO_MAX_LENGTH || '500'),

  ERROR_MESSAGES: {
    TOO_LONG: `補足情報は${parseInt(process.env.CONTEXT_INFO_MAX_LENGTH || '500')}文字以内で指定してください`
  }
} as const;

// その他のバリデーション定数
export const GENERAL_VALIDATION = {
  // UUID正規表現
  UUID_REGEX: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  
  // エラーメッセージ
  ERROR_MESSAGES: {
    INVALID_UUID: 'UUID形式で指定してください',
    INVALID_URL: '有効なURL形式で指定してください',
    // 期待するホストやコンテナ名は応答に含めない（構成情報を漏らさないため）
    IMAGE_PATH_NOT_ALLOWED: '画像アップロードAPIが返したURLを指定してください'
  }
} as const;