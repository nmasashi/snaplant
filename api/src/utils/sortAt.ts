import { SORT_AT_UTC_OFFSET_MINUTES } from '../constants/album';

/**
 * 写真の並べ替え用の日時（sortAt）を決める
 *
 * 一覧は ORDER BY c.sortAt でページ送りするので、すべての写真が必ず持つ値にする。
 * 撮影日時があればそれ、無ければアップロード日時を日本時間に直した値で、
 * どちらもタイムゾーン無しの `YYYY-MM-DDTHH:mm:ss`（文字列の辞書順が時刻順と一致する）
 * @param takenAt 撮影日時（タイムゾーン無し）。無ければ null
 * @param uploadedAt アップロード日時（ISO 8601, UTC）
 */
export function computeSortAt(takenAt: string | null, uploadedAt: string): string {
  if (takenAt !== null) {
    return takenAt;
  }
  const shifted = new Date(Date.parse(uploadedAt) + SORT_AT_UTC_OFFSET_MINUTES * 60 * 1000);
  return shifted.toISOString().slice(0, 19);
}
