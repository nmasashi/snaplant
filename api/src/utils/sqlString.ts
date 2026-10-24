/**
 * patch の condition に埋める文字列のリテラル
 *
 * condition はパラメータを取れないので値を埋め込む。埋める値はどれもサーバが書いた列挙・時刻・UUID だが、
 * 引用符が混ざっても条件が壊れないよう、JSON の文字列としてエスケープする（Cosmos SQL の文字列リテラルと同じ書き方）
 * @param value 埋める文字列
 */
export function sqlString(value: string): string {
  return JSON.stringify(value);
}
