/**
 * ページの件数の指定（クエリの limit）を読む
 *
 * 「無い」と「空」を分ける: 無ければ既定の件数、空や整数でない値・0・上限を超える値は読めない（null）。
 * 既定の件数も上限を超えない（環境変数の設定の誤りで上限が破られないように）
 * @param limitParam クエリの値。無ければ null
 * @param pageSize 既定の件数
 * @param maxPageSize 上限
 * @returns 件数。読めなければ null（呼び出し側が 400 にする）
 */
export function readPageLimit(limitParam: string | null, pageSize: number, maxPageSize: number): number | null {
  if (limitParam === null) {
    return Math.min(pageSize, maxPageSize);
  }
  const limit = /^[1-9][0-9]*$/.test(limitParam) ? Number(limitParam) : NaN;
  // NaN は比較がすべて偽になるので、「上限以下」を肯定で書いて否定する
  return limit <= maxPageSize ? limit : null;
}
