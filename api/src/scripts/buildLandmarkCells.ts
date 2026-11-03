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
  if (tags.man_made === 'bridge') return 'bridge';
  if (tags.natural === 'waterfall' || tags.waterway === 'waterfall') return 'waterfall';
  if (tags.historic === 'ruins' || tags.historic === 'archaeological_site') return 'ruins';
  if (tags.historic === 'monument' || tags.historic === 'memorial') return 'monument';
  if (tags.tourism === 'museum') return 'museum';
  if (tags.tourism === 'viewpoint') return 'viewpoint';
  if (tags.tourism === 'attraction') return 'attraction';
  if (tags.tourism === 'alpine_hut' || tags.tourism === 'wilderness_hut') return 'alpine_hut';
  // 道や線路の橋は最後に見る。橋の道でもある観光地などは、その種類で残す（橋にすると、名前の条件で捨てられることがある）。
  // bridge=no は橋でない（編集の跡で残っていることがある）
  if (tags.bridge !== undefined && tags.bridge !== 'no') return 'bridge';
  return null;
}

/** 囲む四角（南・北・西・東の端） */
interface Bounds {
  south: number;
  north: number;
  west: number;
  east: number;
}

/**
 * GeoJSON の座標（入れ子の配列）を囲む四角を広げる。座標が無ければ広げない。
 * 大きな敷地の形は座標が何万もあるので、配列に取り出し直さずにたどる（Math.min(...配列) は引数の数の上限で落ちる）
 */
function extendBounds(bounds: Bounds, coordinates: unknown): void {
  if (!Array.isArray(coordinates)) return;
  if (typeof coordinates[0] === 'number') {
    const [lon, lat] = coordinates as [number, number];
    bounds.south = Math.min(bounds.south, lat);
    bounds.north = Math.max(bounds.north, lat);
    bounds.west = Math.min(bounds.west, lon);
    bounds.east = Math.max(bounds.east, lon);
    return;
  }
  for (const child of coordinates) extendBounds(bounds, child);
}

/** 同じ名前・種類の名所を1件にまとめる距離（m）。まとめた名所を囲む四角からこの内にあれば、同じものとみなす */
const MERGE_DISTANCE_METERS = 500;

/**
 * 2つの四角の隙間（m。重なっていれば 0）。まとめるかを決めるだけなので、狭い範囲で十分な平面の近似にする。
 * 中心どうしでなく隙間で測るのは、区切って載っている長い橋の道や、大きな敷地の形とその中の点を1件にまとめるため
 */
function gapMeters(a: Bounds, b: Bounds): number {
  const metersPerDegree = 111_320;
  const dLat = Math.max(0, b.south - a.north, a.south - b.north);
  const dLon = Math.max(0, b.west - a.east, a.west - b.east);
  const midLat = (a.south + a.north + b.south + b.north) / 4;
  return Math.hypot(dLat * metersPerDegree, dLon * metersPerDegree * Math.cos((midLat * Math.PI) / 180));
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
  // 種類・名前ごとに、残した名所と、それにまとめた形を囲む四角（区画の境をまたいでまとめられるよう、区画では分けない）
  const keptOf = new Map<string, Array<{ entry: LandmarkEntry; bounds: Bounds }>>();
  let total = 0;
  for await (const raw of lines) {
    const text = raw.split(RECORD_SEPARATOR).join('').trim();
    if (text === '') continue;
    const feature = JSON.parse(text);
    const tags: Record<string, string> = feature.properties ?? {};
    const kind = kindOf(tags);
    // 道の橋は name に道の名前が入っていることがあるので、橋の名前を先に見る
    const name = tags['bridge:name'] ?? tags['name:ja'] ?? tags.name;
    const bounds: Bounds = { south: Infinity, north: -Infinity, west: Infinity, east: -Infinity };
    extendBounds(bounds, feature.geometry?.coordinates);
    if (kind === null || !name || bounds.south === Infinity) continue;
    // 道や線路の橋の name は道や線路の名前（東海道新幹線・国道20号など）のことが多いので、橋の名前か「橋」を含む名前のときだけ使う
    if (kind === 'bridge' && tags.man_made !== 'bridge' && !tags['bridge:name'] && !name.includes('橋')) continue;

    const lat = (bounds.south + bounds.north) / 2;
    const lon = (bounds.west + bounds.east) / 2;
    const ele = kind === 'peak' ? Number.parseFloat(tags.ele) : Number.NaN;
    const entry: LandmarkEntry = {
      name,
      kind,
      lat,
      lon,
      known: Boolean(tags.wikidata || tags.wikipedia),
      ele: Number.isFinite(ele) ? ele : null
    };
    // 道は区切って、城は点と敷地の形の両方で載っていることがあるので、同じ名前・種類で近いものは1件にまとめる（位置と区画は最初の1件）。
    // 八幡神社や丸山のように同じ名前の別の名所がいくつもあるので、離れていれば別に残す
    const key = `${kind}|${name}`;
    let sameName = keptOf.get(key);
    if (!sameName) {
      sameName = [];
      keptOf.set(key, sameName);
    }
    const seen = sameName.find((kept) => gapMeters(kept.bounds, bounds) <= MERGE_DISTANCE_METERS);
    if (seen) {
      seen.entry.known ||= entry.known;
      seen.entry.ele ??= entry.ele;
      // 区切って載っている長い橋のように、まとめるたびに伸びる形もつなげられるよう、四角を広げる
      seen.bounds.south = Math.min(seen.bounds.south, bounds.south);
      seen.bounds.north = Math.max(seen.bounds.north, bounds.north);
      seen.bounds.west = Math.min(seen.bounds.west, bounds.west);
      seen.bounds.east = Math.max(seen.bounds.east, bounds.east);
      continue;
    }
    sameName.push({ entry, bounds });
    (cells[cellOf(lat, lon)] ??= []).push(entry);
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
