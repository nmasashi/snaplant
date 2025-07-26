import { HttpRequest, HttpResponseInit } from '@azure/functions';
import { ApiResponse, ErrorResponse, HttpStatusCode, ErrorCode } from '../types/api';
import { GENERAL_VALIDATION } from '../constants/validation';

/**
 * 成功レスポンスを作成
 */
export function createSuccessResponse<T>(
  data: T,
  statusCode: HttpStatusCode = HttpStatusCode.OK
): HttpResponseInit {
  const response: ApiResponse<T> = {
    success: true,
    data
  };

  return {
    status: statusCode,
    jsonBody: response,
    headers: {
      'Content-Type': 'application/json'
    }
  };
}

/**
 * エラーレスポンスを作成
 */
export function createErrorResponse(
  code: ErrorCode,
  message: string,
  statusCode: HttpStatusCode,
  details?: string
): HttpResponseInit {
  const errorResponse: ErrorResponse = {
    code,
    message,
    details
  };

  const response: ApiResponse = {
    success: false,
    error: errorResponse
  };

  return {
    status: statusCode,
    jsonBody: response,
    headers: {
      'Content-Type': 'application/json'
    }
  };
}

/**
 * バリデーションエラーレスポンス
 */
export function createValidationError(message: string, details?: string): HttpResponseInit {
  return createErrorResponse(
    ErrorCode.INVALID_REQUEST,
    message,
    HttpStatusCode.BAD_REQUEST,
    details
  );
}


/**
 * Not Foundエラーレスポンス
 */
export function createNotFoundError(message: string): HttpResponseInit {
  return createErrorResponse(
    ErrorCode.PLANT_NOT_FOUND,
    message,
    HttpStatusCode.NOT_FOUND
  );
}

/**
 * 内部サーバーエラーレスポンス
 */
export function createInternalError(message: string = 'サーバー内部エラーが発生しました', details?: string): HttpResponseInit {
  return createErrorResponse(
    ErrorCode.INTERNAL_ERROR,
    message,
    HttpStatusCode.INTERNAL_SERVER_ERROR,
    details
  );
}


/**
 * UUID形式のバリデーション
 */
export function isValidUUID(uuid: string): boolean {
  return GENERAL_VALIDATION.UUID_REGEX.test(uuid);
}