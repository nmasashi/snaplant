import { BlobServiceClient } from '@azure/storage-blob';
import { LANDMARK_CANDIDATE_MAX, LANDMARK_CANDIDATE_RADIUS_M } from '../constants/album';
import { LandmarkEntry, cellOf } from '../utils/landmarkCells';

/** AI に渡す名所の候補1件（撮影地から見た方角と距離を持つ） */
export interface LandmarkCandidate {
  name: string;
  /** 種類の日本語の名前（城・寺・橋など） */
  kindLabel: string;
  /** 撮影地から見た方角（8方位） */
  direction: string;
  /** 撮影地からの距離（km） */
  km: number;
}

/** 地球の半径（m）。距離（大円距離）と、読む区画を選ぶ範囲で同じ値を使う（ずれると、境のすぐ向こうの名所を取りこぼす） */
const EARTH_RADIUS_M = 6_371_000;

/** 1度の緯度の長さ（m） */
const METERS_PER_DEGREE = (EARTH_RADIUS_M * Math.PI) / 180;

/** 区画のファイルの種類を、AI に渡す日本語の名前にする */
const KIND_LABELS: Record<string, string> = {
  castle: '城',
  temple: '寺',
  shrine: '神社',
  church: '教会',
  place_of_worship: '寺社',
  tower: '塔',
  lighthouse: '灯台',
  bridge: '橋',
  waterfall: '滝',
  ruins: '遺跡',
  monument: '記念碑',
  museum: '博物館',
  viewpoint: '展望地',
  attraction: '名所',
  alpine_hut: '山小屋',
};

const DIRECTIONS = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'];

const toRad = (degrees: number) => (degrees * Math.PI) / 180;

/** 2点の距離（m。大円距離） */
function metersBetween(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const h = Math.sin(toRad(lat2 - lat1) / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lon2 - lon1) / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/** 1点目から見た2点目の方角（8方位） */
function directionOf(lat1: number, lon1: number, lat2: number, lon2: number): string {
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  const degrees = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  return DIRECTIONS[Math.round(degrees / 45) % 8];
}

/**
 * 撮影地の周りの名所を、名所のデータ（Blob の landmarks コンテナの区画のファイル）から引く（C-5。06 §10・§10.1）
 */
export class LandmarkCandidateService {
  /**
   * @param lat 撮影地の緯度
   * @param lon 撮影地の経度
   * @returns 撮影地から LANDMARK_CANDIDATE_RADIUS_M 以内の名所（山頂を除く）を、名の知れたものを先に近い順で、
   *   LANDMARK_CANDIDATE_MAX 件まで。同じ名前・種類は近い方の1つ。名所のデータのコンテナの設定が無ければ空
   * @throws 区画のファイルを読めないとき（Blob の失敗。ファイルが無いのは名所が無い区画で、失敗ではない）
   */
  async near(lat: number, lon: number): Promise<LandmarkCandidate[]> {
    const containerName = process.env.LANDMARK_STORAGE_CONTAINER_NAME;
    if (!containerName) {
      return [];
    }
    const container = BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING!).getContainerClient(containerName);

    // 撮影地の周りの四角に掛かる区画（1〜4個）を読む
    const dLat = LANDMARK_CANDIDATE_RADIUS_M / METERS_PER_DEGREE;
    // 経度の範囲は、極に近い方の端の緯度で測る（緯度が高いほど1度の経度が短くなり、範囲が広がる）
    const dLon = LANDMARK_CANDIDATE_RADIUS_M / (METERS_PER_DEGREE * Math.cos(toRad(Math.abs(lat) + dLat)));
    const cells = new Set<string>();
    for (const cornerLat of [lat - dLat, lat + dLat]) {
      for (const cornerLon of [lon - dLon, lon + dLon]) {
        cells.add(cellOf(cornerLat, cornerLon));
      }
    }
    const entries: LandmarkEntry[] = [];
    // 区画のファイルは同時に読む（1〜4個）
    const read = await Promise.all([...cells].map((cell) => readCell(container.getBlockBlobClient(`cells/${cell}.json`))));
    entries.push(...read.flat());

    const nearby = entries
      .filter((entry) => entry.kind !== 'peak')
      .map((entry) => ({ entry, meters: metersBetween(lat, lon, entry.lat, entry.lon) }))
      .filter(({ meters }) => meters <= LANDMARK_CANDIDATE_RADIUS_M)
      .sort((a, b) => a.meters - b.meters);
    // 区画のファイルには、長い橋の遠い区切りなどで同じ名前・種類が残る（06 §10.1）。近い方の1つにし、
    // どれかが名の知れたものなら名の知れたものとして並べる（名の知れた区切りが遠い方にあることもある）
    const kept = new Map<string, { entry: LandmarkEntry; meters: number; known: boolean }>();
    for (const { entry, meters } of nearby) {
      const key = `${entry.kind}|${entry.name}`;
      const first = kept.get(key);
      if (first) {
        first.known ||= entry.known;
      } else {
        kept.set(key, { entry, meters, known: entry.known });
      }
    }
    return [...kept.values()]
      .sort((a, b) => Number(b.known) - Number(a.known) || a.meters - b.meters)
      .slice(0, LANDMARK_CANDIDATE_MAX)
      .map(({ entry, meters }) => ({
        name: entry.name,
        kindLabel: KIND_LABELS[entry.kind] ?? '名所',
        direction: directionOf(lat, lon, entry.lat, entry.lon),
        km: meters / 1000,
      }));
  }
}

/** 区画のファイルを読む。無ければ空（名所の無い区画） */
async function readCell(blob: { download: () => Promise<{ readableStreamBody?: NodeJS.ReadableStream }> }): Promise<LandmarkEntry[]> {
  let response;
  try {
    response = await blob.download();
  } catch (error: any) {
    if (error?.statusCode === 404) {
      return [];
    }
    throw error;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of response.readableStreamBody!) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as LandmarkEntry[];
}
