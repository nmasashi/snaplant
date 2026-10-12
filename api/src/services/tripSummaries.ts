import { Trip, TripSummary } from '../types/album';

/**
 * 旅行の一覧に、写真の集計を足して TripSummary にする
 * @param trips 旅行
 * @param counts 旅行ごとの写真の枚数の行
 * @param ranges 旅行ごとの撮影期間の行
 */
export function buildTripSummaries(
  trips: Trip[],
  counts: { tripId: string | null; photoCount: number }[],
  ranges: { tripId: string | null; firstTakenAt: string; lastTakenAt: string }[]
): { trips: TripSummary[]; unassignedPhotoCount: number } {
  const countByTrip = new Map(counts.map((row) => [row.tripId, row.photoCount]));
  const rangeByTrip = new Map(ranges.map((row) => [row.tripId, row]));
  return {
    trips: trips.map((trip) => ({
      ...trip,
      photoCount: countByTrip.get(trip.id) ?? 0,
      firstTakenAt: rangeByTrip.get(trip.id)?.firstTakenAt ?? null,
      lastTakenAt: rangeByTrip.get(trip.id)?.lastTakenAt ?? null,
      coverThumbnailUrl: null,
    })),
    unassignedPhotoCount: countByTrip.get(null) ?? 0,
  };
}
