/**
 * 利用者が書いた文の前後の空白を除く
 *
 * String.trim は U+0085（次の行）を除かないが、アプリ（Dart の trim）は除くので、それだけの文をアプリは空として扱う。
 * そろえないと、空に見える文が残って AI に渡る（写真のコメント・場面のコメント）。
 * 正規表現（/[\s\u0085]+$/ など）で末尾を探すと、途中の長い空白の並びで2乗の時間がかかるので、両端から1文字ずつ見る
 */
export function trimUserText(text: string): string {
  const isSpace = (char: string) => char === '\u0085' || char.trim() === '';
  let start = 0;
  let end = text.length;
  while (start < end && isSpace(text[start])) start++;
  while (end > start && isSpace(text[end - 1])) end--;
  return text.slice(start, end);
}
