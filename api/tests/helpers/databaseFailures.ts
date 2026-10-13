// Cosmos SDK 4.x は errno をトップレベルの code に載せた RestError を投げる。
// HTTP クライアントが fetch 系に変わると cause の奥に移るため、その形も守る
const restError = (code: string | number, message: string) =>
  Object.assign(new Error(message), { name: 'RestError', code });
const connectionFailureInDeepCause = () => {
  const root = Object.assign(new Error('getaddrinfo ENOTFOUND example.com'), { code: 'ENOTFOUND' });
  const mid = Object.assign(new TypeError('fetch failed'), { cause: root });
  return Object.assign(new Error('Connection error.'), { cause: mid });
};

type DatabaseFailureCase = [string, Error, number, string, string];

/**
 * データベースの失敗の分類の表（全5行）。接続できない障害は 503、それ以外は 500 で、
 * 500 の message だけがハンドラごとに違う。
 *
 * 分類は旅行アルバムの全エンドポイント（createDatabaseErrorResponse を通るもの）で同じ規則
 * （utils/errors.ts の isConnectivityError）なので、
 * 5行すべてを回すのは `trips.test.ts` の「旅行の作成」の1箇所だけにしている。
 * 他のエンドポイントは `databaseFailureCases()`（2行）で、ハンドラがこの分類につながっていることだけを見る
 */
export const allDatabaseFailureCases = (internalErrorMessage: string): DatabaseFailureCase[] => [
  ['名前解決に失敗したときは、接続できないエラー（503）を返す', restError('ENOTFOUND', 'getaddrinfo ENOTFOUND example.documents.azure.com'), 503, 'DATABASE_ERROR', 'データベースに接続できません'],
  ['接続を拒否されたときは、接続できないエラー（503）を返す', restError('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:8081'), 503, 'DATABASE_ERROR', 'データベースに接続できません'],
  ['接続できない原因が別のエラーに包まれていても、接続できないエラー（503）を返す', connectionFailureInDeepCause(), 503, 'DATABASE_ERROR', 'データベースに接続できません'],
  ['codeの無い想定外のエラーのときは、内部エラー（500）を返す', new Error('something went wrong'), 500, 'INTERNAL_ERROR', internalErrorMessage],
  ['Cosmos DBが500を返したときは、内部エラー（500）を返す', restError(500, 'Internal Server Error'), 500, 'INTERNAL_ERROR', internalErrorMessage]
];

/**
 * データベースの失敗の分類の表（2行）。ほとんどのエンドポイントはこちらを使う。
 * 全行を通す入口は `trips.test.ts` の「旅行の作成」で、ここは「接続できない障害は 503」と
 * 「想定外のエラーは 500（message はハンドラ固有）」の両方にハンドラが分岐することだけを見る
 */
export const databaseFailureCases = (internalErrorMessage: string): DatabaseFailureCase[] => {
  const [nameResolution, , , unexpected] = allDatabaseFailureCases(internalErrorMessage);
  return [nameResolution, unexpected];
};
