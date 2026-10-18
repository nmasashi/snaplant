import { CatalogEntry } from '../types/album';
import type { CoverUrlOf } from './albumService';
import { CatalogHeadPhoto, CatalogNameCountRow } from './catalogQueries';

/**
 * 図鑑の項目のページを、名前ごとの枚数の行と見出しの写真から組み立てる純粋な関数
 * （docs/travel-album/04_data_design.md §3.1 の「規模の注意」の 2 段と 3 段）
 *
 * 集計とその並びは偽物では作れないので、入口ではなく catalogPageOf() を単体で確かめる（CLAUDE.md の名簿）
 */

/** 名前の決まった、名前ごとの枚数の行 */
interface CatalogNameCount {
  name: string;
  photoCount: number;
}

/**
 * 名前ごとの枚数の行を名前順に並べ、offset から limit 件を切る
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
  const named = rows
    .filter((row): row is CatalogNameCount => typeof row.name === 'string')
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { page: named.slice(offset, offset + limit), total: named.length };
}

/**
 * 1つの項目を、名前ごとの枚数の行と見出しの写真（その名前で信頼度が最も高い1枚）から組み立てる
 * @param kind 図鑑の種類
 * @param row 名前ごとの枚数の行
 * @param head 見出しの写真。数えてから読むまでに無くなっていれば null
 * @param coverUrlOf Blob 名から表紙の URL（SAS 付き）を作る
 * @returns 項目。見出しの写真が無ければ null（そのページから外す）
 */
export function catalogEntryOf(
  kind: string,
  row: CatalogNameCount,
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
    photoCount: row.photoCount,
    coverThumbnailUrl: coverUrlOf(head.thumbnailBlobName ?? head.blobName),
  };
}

/**
 * 項目の一覧の1ページを作る（2 段: 名前順に切る → 3 段: ページの項目ごとに見出しの写真を読む → 項目にする）
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
