import { GRAPHEMES } from './graphemes';

/**
 * 利用者が書いた文の前後の空白を除く
 *
 * String.trim は U+0085（次の行）を除かないが、アプリ（Dart の trim）は除くので、それだけの文をアプリは空として扱う。
 * そろえないと、空に見える文が残る（コメントなら AI にも渡る）。
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

/**
 * 利用者が書いた文が上限の文字数を超えるか。見た目の1文字（書記素）を1と数える
 *
 * アプリの入力欄（Flutter の maxLength）と同じ数え方。UTF-16 の長さで数えると、絵文字が2〜8文字に数えられ、
 * 入力欄が許した文がサーバで 400 になる。書記素は UTF-16 で1単位以上なので、UTF-16 の長さが上限以下なら分けずに済む。
 * 超えるときも、上限を1つ超えた所で数えるのをやめる（大きな本文を最後まで分けない）
 */
export function exceedsLength(text: string, maxLength: number): boolean {
  if (text.length <= maxLength) {
    return false;
  }
  let count = 0;
  for (const _segment of GRAPHEMES.segment(text)) {
    count++;
    if (count > maxLength) {
      return true;
    }
  }
  return false;
}
