import { CatalogEntry } from '../types/album';
import type { CoverUrlOf } from './albumService';
import { CatalogHeadPhoto, CatalogNameCountRow } from './catalogQueries';

/**
 * 図鑑の項目のページを、名前ごとの枚数の行と見出しの写真から組み立てる純粋な関数
 * （docs/04_data_design.md §3.1 の「規模の注意」の 2 段と 3 段）
 *
 * 集計とその並びは偽物では作れないので、入口ではなく catalogPageOf() を単体で確かめる（CLAUDE.md の名簿）
 */

/** 名前の決まった、名前ごとの枚数の行（属は名前ごとに1つに決めたもの） */
interface CatalogNameCount {
  name: string;
  genus: string | null;
  genusName: string | null;
  photoCount: number;
}

/** 前後の空白を除いた文字列。文字列でないか空なら null */
const trimmedOrNull = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);

/** 文字列の符号単位の順（ロケールに依らず、どの環境でも同じ。05 §5.14） */
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * 属の学名をまとめる鍵に揃える（前後の空白を除き、先頭だけ大文字。空なら null）。
 * AI の答えの揺れ（「 aconitum」など）で、同じ属が別の見出しに分かれないように
 */
function genusKeyOf(value: unknown): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed === '' ? null : trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}

/** 枚数の最も多い鍵（同じ枚数なら符号単位の順で先）。無ければ null */
function mostCounted(counts: Map<string, number>): string | null {
  const [top] = [...counts].sort(([a, countA], [b, countB]) => countB - countA || byCodeUnit(a, b));
  return top?.[0] ?? null;
}

/** 鍵ごとの枚数に足す */
function addCount(counts: Map<string, number>, key: string, photoCount: number): void {
  counts.set(key, (counts.get(key) ?? 0) + photoCount);
}

/**
 * GROUP BY の行（名前・属の学名・属名の組ごと）を名前ごとに合わせる。枚数は足し、属はその名前の写真の多い属
 * （同じ枚数なら属の学名の順で先）にする。属の分からない行（属を書く前に識別した写真など）は、属の分かる行があれば属に使わない。
 * 属名（日本語）は属ごとに1つに揃える（その属の写真で最も多い書き方。項目ごとに取ると、同じ属の見出しの名前が揺れる）
 */
function countsByName(rows: CatalogNameCountRow[]): CatalogNameCount[] {
  const byName = new Map<string, { photoCount: number; genera: Map<string, number> }>();
  const genusNames = new Map<string, Map<string, number>>();
  for (const row of rows) {
    if (typeof row.name !== 'string') {
      continue;
    }
    const counted = byName.get(row.name) ?? { photoCount: 0, genera: new Map<string, number>() };
    counted.photoCount += row.photoCount;
    const genus = genusKeyOf(row.genus);
    if (genus !== null) {
      addCount(counted.genera, genus, row.photoCount);
      const genusName = trimmedOrNull(row.genusName);
      if (genusName !== null) {
        const names = genusNames.get(genus) ?? new Map<string, number>();
        addCount(names, genusName, row.photoCount);
        genusNames.set(genus, names);
      }
    }
    byName.set(row.name, counted);
  }
  return [...byName].map(([name, { photoCount, genera }]) => {
    const genus = mostCounted(genera);
    const names = genus === null ? undefined : genusNames.get(genus);
    return { name, genus, genusName: names ? mostCounted(names) : null, photoCount };
  });
}

/**
 * 名前ごとの枚数の行を属の学名の順（同じ属は名前の順、属が分からない項目は最後）に並べ、offset から limit 件を切る
 *
 * 並びは文字列の符号単位の順（ロケールに依らず、どの環境でも同じ。05 §5.14）。
 * GROUP BY の鍵が null の行は項目にしない（写っていると判断した写真は必ず名前を持つが、集計の鍵の null に頼らない）
 * @param rows GROUP BY の行（順不同）
 * @param offset 何件目から（0 始まり）
 * @param limit 何件まで
 * @returns ページの行と、項目の総数（ページに依らない）
 */
function pageOfCatalogNames(
  rows: CatalogNameCountRow[],
  offset: number,
  limit: number
): { page: CatalogNameCount[]; total: number } {
  const named = countsByName(rows).sort((a, b) => {
    if (a.genus !== b.genus) {
      return a.genus === null ? 1 : b.genus === null ? -1 : byCodeUnit(a.genus, b.genus);
    }
    return byCodeUnit(a.name, b.name);
  });
  return { page: named.slice(offset, offset + limit), total: named.length };
}

/**
 * 1つの項目を、名前ごとの枚数の行と見出しの写真（その名前で信頼度が最も高い1枚）から組み立てる
 * @param kind 図鑑の種類
 * @param row 名前ごとの枚数の行。属（genus・genusName）を持たなければ（項目の詳細）、見出しの写真の識別から取る
 * @param head 見出しの写真。数えてから読むまでに無くなっていれば null
 * @param coverUrlOf Blob 名から表紙の URL（SAS 付き）を作る
 * @returns 項目。見出しの写真が無ければ null（そのページから外す）
 */
export function catalogEntryOf(
  kind: string,
  row: Pick<CatalogNameCount, 'name' | 'photoCount'> & Partial<Pick<CatalogNameCount, 'genus' | 'genusName'>>,
  head: CatalogHeadPhoto | null,
  coverUrlOf: CoverUrlOf
): CatalogEntry | null {
  if (head === null) {
    return null;
  }
  // 識別に欄が欠けていても（移行で入れた写真など）、応答のキーを消さずに null / {} にそろえる
  const identification = head.identification as {
    confidence: number;
    description?: string | null;
    characteristics?: string | null;
    attributes?: Record<string, unknown> | null;
  };
  return {
    kind,
    name: row.name,
    confidence: identification.confidence,
    description: identification.description ?? null,
    characteristics: identification.characteristics ?? null,
    attributes: identification.attributes ?? {},
    // 一覧は名前ごとに決めた属（行）、詳細は属の行を数えないので見出しの写真の識別から取る
    genus: row.genus !== undefined ? row.genus : genusKeyOf(identification.attributes?.genus),
    genusName: row.genusName !== undefined ? row.genusName : trimmedOrNull(identification.attributes?.genusName),
    photoCount: row.photoCount,
    coverThumbnailUrl: coverUrlOf(head.thumbnailBlobName ?? head.blobName),
  };
}

/**
 * 項目の一覧の1ページを作る（2 段: 名前ごとに合わせて属の学名の順・名前の順に並べて切る → 3 段: ページの項目ごとに見出しの写真を読む → 項目にする）
 *
 * 見出しの写真はページの項目の分だけを並列に読む（写真を全部は読まない。04 §3.1 の「規模の注意」）。
 * 見出しが無くなっていた項目はページから外し、総数は数えたときのまま
 * @param kind 図鑑の種類
 * @param rows 名前ごとの枚数の行（順不同）
 * @param offset 何件目から（0 始まり）
 * @param limit 何件まで
 * @param headOf 名前から見出しの写真を読む。無ければ null
 * @param coverUrlOf Blob 名から表紙の URL（SAS 付き）を作る
 * @returns ページの項目と、項目の総数
 */
export async function catalogPageOf(
  kind: string,
  rows: CatalogNameCountRow[],
  offset: number,
  limit: number,
  headOf: (name: string) => Promise<CatalogHeadPhoto | null>,
  coverUrlOf: CoverUrlOf
): Promise<{ entries: CatalogEntry[]; total: number }> {
  const { page, total } = pageOfCatalogNames(rows, offset, limit);
  const heads = await Promise.all(page.map((row) => headOf(row.name)));
  const entries = page
    .map((row, i) => catalogEntryOf(kind, row, heads[i], coverUrlOf))
    .filter((entry): entry is CatalogEntry => entry !== null);
  return { entries, total };
}
