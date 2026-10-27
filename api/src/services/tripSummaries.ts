import { Trip, TripSummary } from '../types/album';
import { PhotoCountRow, TakenAtRangeRow } from './albumQueries';

/**
 * 旅行に、写真の集計を足して TripSummary にする
 *
 * 集計そのもの（GROUP BY）は Cosmos がする。ここはその行を旅行に突き合わせるだけの純粋関数で、
 * 集計の SQL を解釈できないテスト用の偽物の代わりに、組み立てを単体で確かめるために分けてある。
 * 行は旅行の id で引く（行の並びは旅行の並びと一致しない）。
 * 旅行の一覧に無い id の行（消えた旅行を指す写真）はどこにも数えない。
 * 段階3の掃除のタイマーが tripId を null に戻してから、旅行に属さない写真として数えられる。
 * 旅行は最初の撮影日時の新しい順に並べ、撮影日時のある写真が無い旅行は先頭に作成日時の新しい順で並べる
 * （古い旅行を後から作っても、旅行の時期の位置に並ぶ。作ったばかりで写真の無い旅行はすぐ見つかる。docs/05_api_design.md §5.9）
 * @param trips 旅行
 * @param counts 旅行ごとの写真の枚数の行。tripId が null の行は旅行に属さない写真
 * @param ranges 旅行ごとの撮影期間の行。撮影日時のある写真が無い旅行は行が無い
 * @param coverUrls 旅行 ID ごとの表紙の URL。無い旅行は表紙なし
 * @returns 集計付きの旅行と、旅行に属さない写真の枚数
 */
export function buildTripSummaries(
  trips: Trip[],
  counts: PhotoCountRow[],
  ranges: TakenAtRangeRow[],
  coverUrls: Map<string, string> = new Map()
): { trips: TripSummary[]; unassignedPhotoCount: number } {
  const countByTrip = new Map(counts.map((row) => [row.tripId, row.photoCount]));
  const rangeByTrip = new Map(ranges.map((row) => [row.tripId, row]));
  const summaries: TripSummary[] = trips.map((trip) => ({
    ...trip,
    photoCount: countByTrip.get(trip.id) ?? 0,
    firstTakenAt: rangeByTrip.get(trip.id)?.firstTakenAt ?? null,
    lastTakenAt: rangeByTrip.get(trip.id)?.lastTakenAt ?? null,
    coverThumbnailUrl: coverUrls.get(trip.id) ?? null,
  }));
  return {
    trips: summaries.sort(byTripDate),
    unassignedPhotoCount: countByTrip.get(null) ?? 0,
  };
}

/**
 * 旅行の並び。撮影日時の無い旅行が先、撮影日時は新しい順、同じなら作成日時の新しい順
 *
 * 撮影日時は同じ形（タイムゾーン無しの YYYY-MM-DDTHH:mm:ss）、作成日時も同じ形（ISO 8601 の UTC）なので、文字列のまま比べられる
 */
function byTripDate(a: TripSummary, b: TripSummary): number {
  if (a.firstTakenAt !== b.firstTakenAt) {
    if (a.firstTakenAt === null) return -1;
    if (b.firstTakenAt === null) return 1;
    return a.firstTakenAt < b.firstTakenAt ? 1 : -1;
  }
  return a.createdAt === b.createdAt ? 0 : a.createdAt < b.createdAt ? 1 : -1;
}
