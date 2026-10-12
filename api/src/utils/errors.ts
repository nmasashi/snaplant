/**
 * エラーの `cause` をたどり、指定した `code`（errno）を持つものがあるかを判定する
 *
 * SDK の接続エラーは errno を深い位置に持つ。OpenAI SDK（openai 7.x / Node の native fetch）の実測:
 *
 *   深さ0  APIConnectionError   code=undefined  "Connection error."
 *   深さ1  TypeError            code=undefined  "fetch failed"
 *   深さ2  Error                code="ENOTFOUND"
 *
 * トップレベルの `code` だけを見ると、接続できない障害を見逃して 502 / 500 に分類してしまう。
 * 循環した `cause` で止まらないよう、たどる深さに上限を設ける
 *
 * @param error 判定するエラー
 * @param codes 探す errno（`ENOTFOUND` など）
 */
export function hasCauseCode(error: unknown, codes: readonly string[]): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 10 && current !== null && current !== undefined; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && codes.includes(code)) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** 失敗した上流のサービス */
export type UpstreamService = 'ai' | 'storage';

/**
 * 上流のサービス（AI など）の呼び出しで起きたエラー
 *
 * ハンドラは、どこで失敗したかで 502 / 503 / 500 を振り分ける。
 * 以前は `error.message` に `OpenAI` や `Storage` といった英単語を含むかで振り分けていたが、
 * SDK のエラーのメッセージにその単語は入らないため、上流の失敗が 500 になっていた。
 */
export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly service: UpstreamService,
    readonly cause: unknown
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

/**
 * Cosmos DB に接続できない障害（503 にするもの）かを判定する
 *
 * 旅行アルバムのハンドラが使う。植物図鑑の6つのハンドラはトップレベルの `code` だけを
 * 手で比べているが、SDK は errno を `cause` の奥に持つことがあるので、こちらは
 * `hasCauseCode()` でたどる。errno の集合は植物図鑑側と同じにしてある。
 * `ETIMEDOUT` を含めるかはバックログで判断待ち（docs/09_backlog.md）
 * @param error 判定するエラー
 */
export function isConnectivityError(error: unknown): boolean {
  return hasCauseCode(error, ['ENOTFOUND', 'ECONNREFUSED']);
}
