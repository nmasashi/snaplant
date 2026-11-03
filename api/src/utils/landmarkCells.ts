/**
 * 名所のデータの区画のファイル（docs/06_processing_design.md §10.1）の決まり。
 * 書く側（取り出しのスクリプト buildLandmarkCells.ts）と読む側（名所の候補 landmarkCandidates.ts）で同じものを使う（ずれると候補を引けない）
 */

/** 区画のファイルの1件 */
export interface LandmarkEntry {
  name: string;
  kind: string;
  lat: number;
  lon: number;
  /** Wikidata か Wikipedia が付いている（名の知れた）もの。候補を並べるときに先にする */
  known: boolean;
  /** 山頂の標高（m）。山頂でないもの・読めないものは null */
  ele: number | null;
}

/** 区画の大きさ（度）。撮影地の周り 2 km の四角は、多くても 4 つの区画に掛かる */
export const CELL_DEGREES = 0.25;

/** 区画の名前（南端の緯度と西端の経度。小数2桁。例 36.00_137.75）。区画の境の上の点は北・東の区画に入る */
export function cellOf(lat: number, lon: number): string {
  const floor = (value: number) => (Math.floor(value / CELL_DEGREES) * CELL_DEGREES).toFixed(2);
  return `${floor(lat)}_${floor(lon)}`;
}
