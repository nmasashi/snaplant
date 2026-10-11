import { HttpResponseInit } from '@azure/functions';
import { ApiResponse, ErrorResponse, HttpStatusCode, ErrorCode } from '../types/api';
import { GENERAL_VALIDATION } from '../constants/validation';
import { UpstreamError, UpstreamService, hasCauseCode } from './errors';

/**
 * 上流のサービスごとの、接続できない（到達していない）とみなす errno と応答
 *
 * ストレージだけ ETIMEDOUT を含む。AI 側のタイムアウトを 503 にするかは未決定（docs/09_backlog.md）
 */
const UPSTREAM_ERROR_RESPONSES: Record<UpstreamService, {
  code: ErrorCode;
  unreachableCodes: readonly string[];
  unreachableMessage: string;
  failedMessage: string;
}> = {
  ai: {
    code: ErrorCode.AI_SERVICE_ERROR,
    unreachableCodes: ['ENOTFOUND', 'ECONNREFUSED'],
    unreachableMessage: '植物識別サービスに接続できません',
    failedMessage: '植物識別サービスでエラーが発生しました'
  },
  storage: {
    code: ErrorCode.STORAGE_ERROR,
    unreachableCodes: ['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT'],
    unreachableMessage: 'ストレージサービスに接続できません',
    failedMessage: 'ストレージサービスでエラーが発生しました'
  }
};

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

/**
 * 上流のサービス（AI・ストレージ）の失敗を応答に変換する
 *
 * どこで失敗したか（UpstreamError の service）で分類し、接続できない（cause のチェーンに
 * 該当する errno がある）なら 503、接続できたうえでの失敗なら 502 にする。
 * identify と upload で同じ分類を使うために共通化している
 */
export function createUpstreamErrorResponse(error: UpstreamError): HttpResponseInit {
  const mapping = UPSTREAM_ERROR_RESPONSES[error.service];
  if (hasCauseCode(error, mapping.unreachableCodes)) {
    return createErrorResponse(
      mapping.code,
      mapping.unreachableMessage,
      HttpStatusCode.SERVICE_UNAVAILABLE,
      error.message
    );
  }
  return createErrorResponse(mapping.code, mapping.failedMessage, HttpStatusCode.BAD_GATEWAY, error.message);
}

/**
 * 値が指定されていて、かつ文字列でないかを判定する
 *
 * 文字列であるべき入力の型の検査に使う。null と undefined は「指定なし」として false を返し、
 * 必須かどうかの判定は呼び出し側に任せる（Flutter は空の任意項目を null で送るため）。
 * save と PUT で同じ判定を揃えるために共通化している
 */
export function isPresentNonString(value: unknown): boolean {
  return value !== undefined && value !== null && typeof value !== 'string';
}