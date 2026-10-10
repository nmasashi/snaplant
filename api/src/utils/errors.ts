/**
 * エラーを文脈付きのメッセージで包み直す
 *
 * ハンドラの catch 節は `error.code` を見て障害の種類を振り分けている
 * （`ENOTFOUND` / `ECONNREFUSED` / `ETIMEDOUT` なら 503 など）。
 * ところが `new Error(...)` で包むと元の `code` が落ちるため、
 * 実際には接続障害なのに分類に失敗して 500 を返していた。
 * メッセージを足しつつ、分類に使われるプロパティだけを引き継ぐ。
 *
 * @param message 文脈を加えた新しいメッセージ
 * @param cause 元のエラー
 * @returns `code` を引き継いだエラー
 */
export function wrapError(message: string, cause: any): Error {
  const wrapped: Error & { code?: unknown } = new Error(message);
  if (cause?.code !== undefined) {
    wrapped.code = cause.code;
  }
  return wrapped;
}
