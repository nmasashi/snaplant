import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';

/**
 * 標高のデータ（国土地理院の標高タイル dem_png）を日本の分だけ取り出し、手元のフォルダに置くスクリプト（C-7a。docs/06_processing_design.md §11.2）。
 * 山の段のワーカーが撮影の向きの照合に読む（ズーム 14 と 12）。置いたフォルダは人が Blob の dem コンテナに上げる（DEPLOYMENT.md）。
 *
 * 日本を覆う範囲のズーム 8 から始め、あるタイルの子だけをズーム 10・12・14 とたどる（海だけのタイルはサーバが 404 を返す）。
 * 範囲の全部のズーム 14 を頼むと 200 万回近くになり、ほとんどが海の 404 になるため。
 * 国土地理院のサーバに負荷をかけないよう、1本ずつ、頼むたびに間を置く（利用規約は、運用を妨げる程度の負荷の通信を予告なく遮断しうるとしている）。
 * 1日ほどかかるので、取ったタイルと無かったタイルを置き場に残し、止まっても続きから取れるようにする。
 *
 * 使い方（ビルドしてから）: node dist/src/scripts/fetchDemTiles.js --out <フォルダ>
 */

/** タイルの番号（ズームと、そのズームでの x・y） */
export interface DemTile {
  z: number;
  x: number;
  y: number;
}

/** 取ったタイルの置き場。無かったタイル（404）も覚え、続きから取るときに頼み直さない */
export interface TileStore {
  /** 置いてあれば found、無かったと覚えていれば missing、まだ頼んでいなければ null */
  state(tile: DemTile): 'found' | 'missing' | null;
  saveFound(tile: DemTile, body: Buffer): void;
  saveMissing(tile: DemTile): void;
}

/** 取る範囲（緯度・経度の度） */
export interface DemBounds {
  south: number;
  north: number;
  west: number;
  east: number;
}

/** 日本を覆う範囲（沖ノ鳥島の北緯 20.4 度・南鳥島の東経 154.0 度まで） */
export const JAPAN_BOUNDS: DemBounds = { south: 20, north: 46, west: 122, east: 154 };

/** たどるズーム。最初のズームの範囲を覆うタイルから始め、あるタイルの子を次のズームで頼む */
const ZOOMS = [8, 10, 12, 14];

/** 頼むたびに置く間（ミリ秒）。1秒に 2〜3 枚 */
const DEFAULT_INTERVAL_MS = 400;

/** 404 でない失敗のときに、取り直す前に置く間（ミリ秒）。使い切っても失敗すれば止める */
const DEFAULT_RETRY_DELAYS_MS = [5_000, 15_000, 45_000, 120_000];

/** ズームごとの、あったタイルと無かったタイルの数 */
export type DemSummary = Record<number, { found: number; missing: number }>;

/** 取り出しに渡すもの */
export interface FetchDemTilesOptions {
  /** 1枚を頼む。404 なら null、それ以外の失敗は投げる */
  fetchTile: (tile: DemTile) => Promise<Buffer | null>;
  store: TileStore;
  /** 間を置く（テストでは時間を進めずに記録する） */
  wait: (ms: number) => Promise<void>;
  bounds?: DemBounds;
  intervalMs?: number;
  retryDelaysMs?: number[];
}

/** 緯度・経度を、ズーム z のタイルの番号にする（ウェブメルカトル） */
function tileAt(lat: number, lon: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const s = Math.sin((lat * Math.PI) / 180);
  return {
    x: Math.floor(((lon + 180) / 360) * n),
    y: Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n)
  };
}

/** 範囲を覆う、ズーム z のタイル */
function coveringTiles(bounds: DemBounds, z: number): DemTile[] {
  const northWest = tileAt(bounds.north, bounds.west, z);
  const southEast = tileAt(bounds.south, bounds.east, z);
  const tiles: DemTile[] = [];
  for (let x = northWest.x; x <= southEast.x; x++) {
    for (let y = northWest.y; y <= southEast.y; y++) tiles.push({ z, x, y });
  }
  return tiles;
}

/** タイルの、ズーム z の子孫（ズームが 2 上がれば 4 × 4 枚） */
function childrenOf(tile: DemTile, z: number): DemTile[] {
  const scale = 2 ** (z - tile.z);
  const tiles: DemTile[] = [];
  for (let dx = 0; dx < scale; dx++) {
    for (let dy = 0; dy < scale; dy++) tiles.push({ z, x: tile.x * scale + dx, y: tile.y * scale + dy });
  }
  return tiles;
}

/**
 * 標高タイルをたどって取り、置き場に置く。ズームごとの、あったタイルと無かったタイルの数を返す（置き場に前からあったものも数える）。
 * 404 でない失敗が取り直しても続けば投げる（それまでに置いたタイルは残り、もう一度回せば続きから進む）
 */
export async function fetchDemTiles(options: FetchDemTilesOptions): Promise<DemSummary> {
  const { fetchTile, store, wait } = options;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;

  /** 404 でない失敗を、間を置いて取り直す */
  const fetchWithRetry = async (tile: DemTile): Promise<Buffer | null> => {
    for (let attempt = 0; ; attempt++) {
      try {
        const body = await fetchTile(tile);
        await wait(intervalMs);
        return body;
      } catch (error) {
        if (attempt >= retryDelaysMs.length) throw error;
        await wait(retryDelaysMs[attempt]);
      }
    }
  };

  /** タイルがあるか。置き場にあればそれを使い、無ければ頼んで置く */
  const exists = async (tile: DemTile): Promise<boolean> => {
    const state = store.state(tile);
    if (state !== null) return state === 'found';
    const body = await fetchWithRetry(tile);
    if (body === null) {
      store.saveMissing(tile);
      return false;
    }
    store.saveFound(tile, body);
    return true;
  };

  const summary: DemSummary = {};
  let level = coveringTiles(options.bounds ?? JAPAN_BOUNDS, ZOOMS[0]);
  for (let i = 0; i < ZOOMS.length; i++) {
    const counts = { found: 0, missing: 0 };
    const next: DemTile[] = [];
    for (const tile of level) {
      if (await exists(tile)) {
        counts.found++;
        if (i + 1 < ZOOMS.length) next.push(...childrenOf(tile, ZOOMS[i + 1]));
      } else {
        counts.missing++;
      }
    }
    summary[ZOOMS[i]] = counts;
    level = next;
  }
  return summary;
}

/**
 * 手元のフォルダの置き場。取ったタイルは <ズーム>/<x>/<y>.png（Blob に上げるときの名前と同じ）、無かったタイルは <ズーム>/<x>/<y>.none（空のファイル）。
 * 書いている途中で止まったファイルを取れたものと見なさないよう、別の名前に書いてから名前を変える
 */
function folderStore(root: string): TileStore {
  const file = (tile: DemTile, ext: string): string => path.join(root, String(tile.z), String(tile.x), `${tile.y}.${ext}`);
  const write = (target: string, body: Buffer): void => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(`${target}.part`, body);
    fs.renameSync(`${target}.part`, target);
  };
  return {
    state: (tile) => (fs.existsSync(file(tile, 'png')) ? 'found' : fs.existsSync(file(tile, 'none')) ? 'missing' : null),
    saveFound: (tile, body) => write(file(tile, 'png'), body),
    saveMissing: (tile) => write(file(tile, 'none'), Buffer.alloc(0))
  };
}

/** 国土地理院の標高タイルを1枚頼む。404 なら null。User-Agent は使い道の分からない汎用の名前にする */
function fetchFromGsi(tile: DemTile): Promise<Buffer | null> {
  const url = `https://cyberjapandata.gsi.go.jp/xyz/dem_png/${tile.z}/${tile.x}/${tile.y}.png`;
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'User-Agent': 'dem-tile-fetch/1.0' }, timeout: 30_000 }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        if (response.statusCode === 200) resolve(Buffer.concat(chunks));
        else if (response.statusCode === 404) resolve(null);
        else reject(new Error(`HTTP ${response.statusCode}（${url}）`));
      });
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error(`応答がありません（${url}）`)));
    request.on('error', reject);
  });
}

/** 引数 --<名前> の次の値 */
function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/** 手で回す入口。--out の置き場に取り、1,000 枚ごとと終わりに進み具合を出す */
async function run(): Promise<void> {
  const out = argument('out');
  if (!out) throw new Error('--out <フォルダ> を指定してください');
  let requests = 0;
  const started = Date.now();
  const summary = await fetchDemTiles({
    fetchTile: async (tile) => {
      requests++;
      if (requests % 1000 === 0) console.log(`${requests} 枚を頼みました（ズーム ${tile.z}、${Math.round((Date.now() - started) / 60_000)} 分）`);
      return fetchFromGsi(tile);
    },
    store: folderStore(out),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  });
  console.log(`このたび頼んだのは ${requests} 枚、${Math.round((Date.now() - started) / 60_000)} 分`);
  for (const [z, counts] of Object.entries(summary)) console.log(`ズーム ${z}: あった ${counts.found} 枚・無かった ${counts.missing} 枚`);
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
