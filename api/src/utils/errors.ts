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
 * 接続できない（503 にする）とみなす errno
 *
 * Cosmos DB（isConnectivityError）と AI の判定（utils/response.ts）が共有する。
 * ストレージだけは ETIMEDOUT も含めている（docs/09_backlog.md で揃えるか判断待ち）。
 * 一覧を別々に持つと片方だけ直されて分類がずれるので、ここを唯一の実体にする
 */
export const UNREACHABLE_ERRNOS: readonly string[] = ['ENOTFOUND', 'ECONNREFUSED'];

/**
 * Cosmos DB に接続できない障害（503 にするもの）かを判定する
 *
 * すべてのハンドラが使う（createDatabaseErrorResponse）。Cosmos SDK 4.x は接続の失敗を RestError に包み、errno を
 * トップレベルの `code` に載せる（@typespec/ts-http-runtime の nodeHttpClient）。それでも
 * `hasCauseCode()` で `cause` までたどるのは、HTTP クライアントが fetch 系に変わると OpenAI SDK と
 * 同じく errno が `cause` の奥に移るため。errno の集合は UNREACHABLE_ERRNOS（ストレージの判定と共有）
 * @param error 判定するエラー
 */
export function isConnectivityError(error: unknown): boolean {
  return hasCauseCode(error, UNREACHABLE_ERRNOS);
}

/**
 * JSON としては読めるが、Cosmos が受け付けない継続トークン（別の絞り込みのものなど。Cosmos は 400 で拒む。推測）
 *
 * トークンを渡した写真のページのクエリ（AlbumService.listPhotos）の 400 だけをこれにする。同じ要求の別のクエリ
 * （図鑑の見出しや枚数）の 400 は、複合インデックスが無いときなどのサーバの失敗で、トークンの不正ではない
 */
export class InvalidContinuationTokenError extends Error {
  constructor(readonly cause: unknown) {
    super('継続トークンを Cosmos が受け付けませんでした');
    this.name = 'InvalidContinuationTokenError';
  }
}
