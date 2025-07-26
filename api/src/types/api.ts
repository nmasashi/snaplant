// API共通レスポンス型
export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: ErrorResponse;
}

// エラーレスポンス
export interface ErrorResponse {
  code: string;
  message: string;
  details?: string;
}

// HTTPステータスコード
export enum HttpStatusCode {
  OK = 200,
  CREATED = 201,
  BAD_REQUEST = 400,
  UNAUTHORIZED = 401,
  NOT_FOUND = 404,
  CONFLICT = 409,
  PAYLOAD_TOO_LARGE = 413,
  UNSUPPORTED_MEDIA_TYPE = 415,
  INTERNAL_SERVER_ERROR = 500,
  BAD_GATEWAY = 502,
  SERVICE_UNAVAILABLE = 503
}

// エラーコード
export enum ErrorCode {
  INVALID_REQUEST = 'INVALID_REQUEST',
  NOT_A_PLANT = 'NOT_A_PLANT',
  UNAUTHORIZED = 'UNAUTHORIZED',
  INVALID_API_KEY = 'INVALID_API_KEY',
  PLANT_NOT_FOUND = 'PLANT_NOT_FOUND',
  PLANT_ALREADY_EXISTS = 'PLANT_ALREADY_EXISTS',
  FILE_TOO_LARGE = 'FILE_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE = 'UNSUPPORTED_MEDIA_TYPE',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  AI_SERVICE_ERROR = 'AI_SERVICE_ERROR',
  DATABASE_ERROR = 'DATABASE_ERROR',
  STORAGE_ERROR = 'STORAGE_ERROR'
}