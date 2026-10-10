/**
 * エラーを文脈付きのメッセージで包み直す
 *
 * ハンドラの catch 節は `error.code` を見て障害の種類を振り分けている
 * （`ENOTFOUND` / `ECONNREFUSED` / `ETIMEDOUT` なら 503 など）。
 * ところが `new Error(...)` で包むと元の `code` が落ちるため、
 * 実際には接続障害なのに分類に失敗して 500 を返していた。
 * メッセージを足しつつ、分類に使われるプロパティだけを引き継ぐ。
 *
 * `cause` が `code` を持たない場合は `cause.cause` を**一段だけ**辿る。
 * SDK が transport のエラーを自前のエラー型で包むとき、errno が
 * 一段内側に入る形があるため。
 *
 * - Azure Storage: `RestError` に `code: err.code ?? ...` で errno が
 *   **直接**載る（`@typespec/ts-http-runtime` の `nodeHttpClient.js`）
 * - OpenAI: `APIConnectionError` は
 *   `super(undefined, undefined, 'Connection error.', undefined)` を呼び、
 *   `APIError` が `this.code = data?.['code']` とするため **`code` は常に
 *   `undefined`**。errno を持つ元エラーは `cause` に入る
 *
 * 一段で止めるのは、際限なく辿ると無関係な内側のエラーの `code` を
 * 拾って誤分類する恐れがあるため。`??` なので直接 `code` を持つ
 * Azure Storage 側の挙動は変わらない。
 *
 * @param message 文脈を加えた新しいメッセージ
 * @param cause 元のエラー
 * @returns `code` を引き継いだエラー
 */
export function wrapError(message: string, cause: any): Error {
  const wrapped: Error & { code?: unknown } = new Error(message);
  const code = cause?.code ?? cause?.cause?.code;
  if (code !== undefined) {
    wrapped.code = code;
  }
  return wrapped;
}
