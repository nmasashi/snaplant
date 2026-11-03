import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

/** 区画のファイルの1件（docs/06_processing_design.md §10.1） */
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
const CELL_DEGREES = 0.25;

/** 行頭の区切りの文字（osmium の geojsonseq は Feature ごとに RS を付ける） */
const RECORD_SEPARATOR = String.fromCharCode(0x1e);

/**
 * 地図のタグから種類を決める（名所でも山頂でもなければ null）。
 * 寺社は religion で寺・神社・教会に分け、分からなければ place_of_worship
 */
function kindOf(tags: Record<string, string>): string | null {
  if (tags.natural === 'peak' || tags.natural === 'volcano') return 'peak';
  if (tags.historic === 'castle' || tags.building === 'castle') return 'castle';
  if (tags.amenity === 'place_of_worship' || ['temple', 'shrine', 'church', 'cathedral', 'pagoda'].includes(tags.building)) {
    return ({ buddhist: 'temple', shinto: 'shrine', christian: 'church' } as Record<string, string>)[tags.religion] ?? 'place_of_worship';
  }
  if (tags.man_made === 'tower') return 'tower';
  if (tags.man_made === 'lighthouse') return 'lighthouse';
  if (tags.man_made === 'bridge' || tags.bridge !== undefined) return 'bridge';
  if (tags.natural === 'waterfall' || tags.waterway === 'waterfall') return 'waterfall';
  if (tags.historic === 'ruins' || tags.historic === 'archaeological_site') return 'ruins';
  if (tags.historic === 'monument' || tags.historic === 'memorial') return 'monument';
  if (tags.tourism === 'museum') return 'museum';
  if (tags.tourism === 'viewpoint') return 'viewpoint';
  if (tags.tourism === 'attraction') return 'attraction';
  if (tags.tourism === 'alpine_hut' || tags.tourism === 'wilderness_hut') return 'alpine_hut';
  return null;
}

/** GeoJSON の座標（入れ子の配列）から [経度, 緯度] の組を全部取り出す */
function positionsOf(coordinates: unknown): Array<[number, number]> {
  if (Array.isArray(coordinates) && typeof coordinates[0] === 'number') {
    return [[coordinates[0], coordinates[1] as number]];
  }
  return Array.isArray(coordinates) ? coordinates.flatMap(positionsOf) : [];
}

/** 同じ名前・種類の名所を1件にまとめる距離（m）。区切って載っている橋の道や、城の点と敷地の形はこの内に収まる */
const MERGE_DISTANCE_METERS = 500;

/** 2点の距離（m）。まとめるかを決めるだけなので、狭い範囲で十分な平面の近似にする */
function metersBetween(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const metersPerDegree = 111_320;
  const dy = (a.lat - b.lat) * metersPerDegree;
  const dx = (a.lon - b.lon) * metersPerDegree * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

/** 区画の名前（南端の緯度と西端の経度。小数2桁） */
function cellOf(lat: number, lon: number): string {
  const floor = (value: number) => (Math.floor(value / CELL_DEGREES) * CELL_DEGREES).toFixed(2);
  return `${floor(lat)}_${floor(lon)}`;
}

/**
 * osmium export の GeoJSON の行から、区画ごとの名所と山頂の一覧を作る（C-5a。06 §10.1）
 *
 * 敷地の形（way・relation）は、それを囲む四角の中心の点にする（Overpass の out center と同じ）。
 * 件数が下限を下回ったら失敗にする（Geofabrik の不調や取り出しの誤りで、空に近いデータを置かないため）
 * @param lines geojsonseq の行
 * @param options minCount は名所と山頂の件数の下限
 */
export async function buildLandmarkCells(
  lines: AsyncIterable<string> | Iterable<string>,
  options: { minCount: number }
): Promise<{ cells: Record<string, LandmarkEntry[]>; total: number; byKind: Record<string, number> }> {
  // 「120,000」などが NaN になると、件数 < NaN は常に false で、下限の確かめが黙って消える
  if (!Number.isInteger(options.minCount) || options.minCount < 0) {
    throw new Error(`件数の下限が無効です（0 以上の整数にしてください）: ${options.minCount}`);
  }
  const cells: Record<string, LandmarkEntry[]> = {};
  const byKind: Record<string, number> = {};
  // 区画・種類・名前ごとに、残した名所
  const firstOf = new Map<string, LandmarkEntry[]>();
  let total = 0;
  for await (const raw of lines) {
    const text = raw.split(RECORD_SEPARATOR).join('').trim();
    if (text === '') continue;
    const feature = JSON.parse(text);
    const tags: Record<string, string> = feature.properties ?? {};
    const kind = kindOf(tags);
    // 道の橋は name に道の名前が入っていることがあるので、橋の名前を先に見る
    const name = tags['bridge:name'] ?? tags['name:ja'] ?? tags.name;
    const positions = positionsOf(feature.geometry?.coordinates);
    if (kind === null || !name || positions.length === 0) continue;
    // 道や線路の橋の name は道や線路の名前（東海道新幹線・国道20号など）のことが多いので、橋の名前か「橋」を含む名前のときだけ使う
    if (kind === 'bridge' && tags.man_made !== 'bridge' && !tags['bridge:name'] && !name.includes('橋')) continue;

    // 大きな敷地の形は座標が何万もあり、Math.min(...配列) は引数の数の上限で落ちるので、1つずつ見る
    let [south, north, west, east] = [Infinity, -Infinity, Infinity, -Infinity];
    for (const [lon, lat] of positions) {
      south = Math.min(south, lat);
      north = Math.max(north, lat);
      west = Math.min(west, lon);
      east = Math.max(east, lon);
    }
    const lat = (south + north) / 2;
    const lon = (west + east) / 2;
    const ele = kind === 'peak' ? Number.parseFloat(tags.ele) : Number.NaN;
    const entry: LandmarkEntry = {
      name,
      kind,
      lat,
      lon,
      known: Boolean(tags.wikidata || tags.wikipedia),
      ele: Number.isFinite(ele) ? ele : null
    };
    // 道は区切って、城は点と敷地の形の両方で載っていることがあるので、同じ区画の同じ名前・種類で近いものは1件にまとめる。
    // 八幡神社や丸山のように同じ名前の別の名所が同じ区画にいくつもあるので、離れていれば別に残す
    const cell = cellOf(lat, lon);
    const key = `${cell}|${kind}|${name}`;
    const sameName = firstOf.get(key) ?? [];
    const seen = sameName.find((other) => metersBetween(other, entry) <= MERGE_DISTANCE_METERS);
    if (seen) {
      seen.known ||= entry.known;
      continue;
    }
    firstOf.set(key, [...sameName, entry]);
    (cells[cell] ??= []).push(entry);
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    total += 1;
  }
  if (total < options.minCount) {
    throw new Error(`名所と山頂が ${total} 件しかありません（下限 ${options.minCount} 件）`);
  }
  return { cells, total, byKind };
}

/** 引数の `--名前 値` を読む */
function argOf(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/**
 * ファイルを読み、区画のファイル（<out>/cells/<区画>.json）と件数（<out>/summary.json）を書く。
 * 取り出しのワークフローが回す（.github/workflows/landmarks-extract.yml）
 */
async function run(): Promise<void> {
  const input = argOf('input');
  const out = argOf('out');
  if (!input || !out) {
    throw new Error('使い方: node dist/src/scripts/buildLandmarkCells.js --input <geojsonseq> --out <出力先> [--min-count <件数>]');
  }
  const minCount = Number(argOf('min-count') ?? '120000');
  const lines = readline.createInterface({ input: fs.createReadStream(input, 'utf8'), crlfDelay: Infinity });
  const { cells, total, byKind } = await buildLandmarkCells(lines, { minCount });

  fs.mkdirSync(path.join(out, 'cells'), { recursive: true });
  for (const [cell, entries] of Object.entries(cells)) {
    fs.writeFileSync(path.join(out, 'cells', `${cell}.json`), JSON.stringify(entries));
  }
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ total, cells: Object.keys(cells).length, byKind }, null, 2));
  console.log(`名所と山頂 ${total} 件、区画 ${Object.keys(cells).length} 個:`, byKind);
}

// 使い方（api/ で）: npm run build && node dist/src/scripts/buildLandmarkCells.js --input <geojsonseq> --out <出力先> [--min-count <件数>]
if (require.main === module) {
  run().catch((error) => {
    console.error('区画のファイルを作るスクリプトが失敗しました:', error);
    process.exitCode = 1;
  });
}
