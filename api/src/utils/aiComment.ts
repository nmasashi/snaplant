/**
 * AI が返した一言（分類・識別の `comment`）を、写真のコメントに書く形にする（docs/06_processing_design.md §2.1・§3.1）
 *
 * strict のスキーマでも中身は強制できないので、文字列でなければ無いものとして扱う。前後の空白を除いて空なら書かない
 * （空のコメントで前の一言を消さない）
 * @returns 前後の空白を除いた一言。無ければ null
 */
export function aiCommentOf(value: unknown): string | null {
  const comment = typeof value === 'string' ? value.trim() : '';
  return comment || null;
}
