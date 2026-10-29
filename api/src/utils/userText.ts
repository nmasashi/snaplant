import { GRAPHEMES } from './graphemes';

/**
 * 見た目の1文字が UTF-16 で取りうる長さの目安の上限。
 * 1文字が長い絵文字（肌の色を付けた家族の絵文字で 19 単位）を上限の文字数まで並べても届かないよう、余裕を取っている
 */
const MAX_UNITS_PER_CHARACTER = 32;

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
 * 超えるときも、上限を1つ超えた所で数えるのをやめる（大きな本文を最後まで分けない）。
 * 見た目の1文字には結合文字をいくらでも重ねられるので、UTF-16 の長さにも上限（文字数 × MAX_UNITS_PER_CHARACTER）を設ける。
 * これが無いと、文の大きさの上限が無くなる（文書の 2 MB を超える、AI に大きな文が渡るなど）
 */
export function exceedsLength(text: string, maxLength: number): boolean {
  if (text.length <= maxLength) {
    return false;
  }
  if (text.length > maxLength * MAX_UNITS_PER_CHARACTER) {
    return true;
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
