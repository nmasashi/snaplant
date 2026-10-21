import { HttpResponseInit } from '@azure/functions';
import { ApiResponse, ErrorResponse, HttpStatusCode, ErrorCode } from '../types/api';
import { GENERAL_VALIDATION } from '../constants/validation';
import { UNREACHABLE_ERRNOS, UpstreamError, UpstreamService, hasCauseCode, isConnectivityError } from './errors';

/**
 * 上流のサービスごとの、接続できない（到達していない）とみなす errno と応答
 *
 * ストレージだけ ETIMEDOUT を含む（AI の失敗は今は応答にならない。下の ai の行）
 */
const UPSTREAM_ERROR_RESPONSES: Record<UpstreamService, {
  code: ErrorCode;
  unreachableCodes: readonly string[];
  unreachableMessage: string;
  failedMessage: string;
}> = {
  ai: {
    code: ErrorCode.AI_SERVICE_ERROR,
    unreachableCodes: UNREACHABLE_ERRNOS,
    // 今の API で応答にするのはストレージの失敗だけ（写真の送信）。AI の失敗はワーカーが写真の lastError に書き、応答にはならない。
    // UpstreamService の種類ごとに持つ表なので残している
    unreachableMessage: 'AIサービスに接続できません',
    failedMessage: 'AIサービスでエラーが発生しました'
  },
  storage: {
    code: ErrorCode.STORAGE_ERROR,
    unreachableCodes: [...UNREACHABLE_ERRNOS, 'ETIMEDOUT'],
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
 * @param message エラーメッセージ
 * @param code 見つからなかったものを表すエラーコード。既定値は置かない（旅行や写真の 404 で
 *   渡し忘れると別のもののコードが返り、クライアントの分岐を誤らせるため）
 */
export function createNotFoundError(
  message: string,
  code: ErrorCode
): HttpResponseInit {
  return createErrorResponse(
    code,
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
 */
export function isPresentNonString(value: unknown): boolean {
  return value !== undefined && value !== null && typeof value !== 'string';
}

/**
 * Cosmos DB の操作の失敗を応答にする（すべてのハンドラが使う）
 *
 * 接続できない障害は 503 DATABASE_ERROR、それ以外は 500 INTERNAL_ERROR。
 * @param error 捕まえたエラー
 * @param internalMessage 接続できない以外の失敗（500）で返す文言
 */
export function createDatabaseErrorResponse(error: any, internalMessage: string): HttpResponseInit {
  if (isConnectivityError(error)) {
    return createErrorResponse(
      ErrorCode.DATABASE_ERROR,
      'データベースに接続できません',
      HttpStatusCode.SERVICE_UNAVAILABLE,
      error.message
    );
  }
  return createInternalError(internalMessage, error.message);
}
