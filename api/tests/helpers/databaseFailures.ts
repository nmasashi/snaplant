// Cosmos SDK 4.x は errno をトップレベルの code に載せた RestError を投げる。
// HTTP クライアントが fetch 系に変わると cause の奥に移るため、その形も守る
const restError = (code: string | number, message: string) =>
  Object.assign(new Error(message), { name: 'RestError', code });
const connectionFailureInDeepCause = () => {
  const root = Object.assign(new Error('getaddrinfo ENOTFOUND example.com'), { code: 'ENOTFOUND' });
  const mid = Object.assign(new TypeError('fetch failed'), { cause: root });
  return Object.assign(new Error('Connection error.'), { cause: mid });
};

/**
 * データベースの失敗の分類の表（ハンドラ共通）。
 * 接続できない障害は 503、それ以外は 500 で、500 の message だけがハンドラごとに違う
 */
export const databaseFailureCases = (
  internalErrorMessage: string
): [string, Error, number, string, string][] => [
  ['名前解決に失敗したときは', restError('ENOTFOUND', 'getaddrinfo ENOTFOUND example.documents.azure.com'), 503, 'DATABASE_ERROR', 'データベースに接続できません'],
  ['接続を拒否されたときは', restError('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:8081'), 503, 'DATABASE_ERROR', 'データベースに接続できません'],
  ['接続できない原因が別のエラーに包まれていても', connectionFailureInDeepCause(), 503, 'DATABASE_ERROR', 'データベースに接続できません'],
  ['codeの無い想定外のエラーのときは', new Error('something went wrong'), 500, 'INTERNAL_ERROR', internalErrorMessage],
  ['Cosmos DBが500を返したときは', restError(500, 'Internal Server Error'), 500, 'INTERNAL_ERROR', internalErrorMessage]
];
