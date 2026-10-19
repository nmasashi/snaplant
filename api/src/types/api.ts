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
  ACCEPTED = 202,
  BAD_REQUEST = 400,
  NOT_FOUND = 404,
  PAYLOAD_TOO_LARGE = 413,
  UNSUPPORTED_MEDIA_TYPE = 415,
  INTERNAL_SERVER_ERROR = 500,
  BAD_GATEWAY = 502,
  SERVICE_UNAVAILABLE = 503
}

// エラーコード
export enum ErrorCode {
  INVALID_REQUEST = 'INVALID_REQUEST',
  TRIP_NOT_FOUND = 'TRIP_NOT_FOUND',
  PHOTO_NOT_FOUND = 'PHOTO_NOT_FOUND',
  FILE_TOO_LARGE = 'FILE_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE = 'UNSUPPORTED_MEDIA_TYPE',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  AI_SERVICE_ERROR = 'AI_SERVICE_ERROR',
  DATABASE_ERROR = 'DATABASE_ERROR',
  STORAGE_ERROR = 'STORAGE_ERROR'
}