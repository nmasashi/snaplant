import { Container } from '@azure/cosmos';
import { PhotoDocument } from '../types/album';

/**
 * 図鑑のまとめに使う Cosmos SQL（docs/04_data_design.md §5.6）
 *
 * SQL 文字列とパラメータの組み立てだけの薄い層。集計（GROUP BY）と2項目の ORDER BY は
 * テスト用の偽物では解釈できないため、ここはテストせず、デプロイ後に手で確かめる
 * （docs/08_test_plan.md §5.3）。行と見出しの写真からページを組み立てる所は
 * catalogEntries.ts に分けてあり、そちらを単体で確かめる（旅行の albumQueries.ts と tripSummaries.ts と同じ分け方）
 */

/** 図鑑の項目（名前）ごとの写真の枚数の行 */
export interface CatalogNameCountRow {
  name: string | null;
  photoCount: number;
}

/** 項目の見出しに使う写真（信頼度が最も高い1枚）の項目 */
export type CatalogHeadPhoto = Pick<PhotoDocument, 'id' | 'identification' | 'thumbnailBlobName' | 'blobName'>;

/**
 * 種類ごとに、名前ごとの写真の枚数を数える（分類どおりの種類が写っている写真だけ）
 *
 * GROUP BY は Cosmos SQL の制約で ORDER BY と同じクエリに書けないので、名前順に並べるのは呼び出し側
 * @param container album コンテナ
 * @param kind 図鑑の種類
 */
export async function queryCatalogNameCounts(container: Container, kind: string): Promise<CatalogNameCountRow[]> {
  const { resources } = await container.items
    .query<CatalogNameCountRow>({
      query:
        'SELECT c.identification.name AS name, COUNT(1) AS photoCount FROM c' +
        ' WHERE c.type = @type AND c.identification.kind = @kind AND c.identification.matchesKind = true' +
        ' GROUP BY c.identification.name',
      parameters: [
        { name: '@type', value: 'photo' },
        { name: '@kind', value: kind },
      ],
    })
    .fetchAll();
  return resources;
}

/**
 * 項目の見出しの写真を1枚読む（その名前の写真のうち信頼度が最も高く、同点なら識別の日時が新しいもの）
 *
 * 2項目の ORDER BY は複合インデックス（/identification/confidence, /identification/at の降順）が要る（07 §3.1。4-0 で apply 済み）
 * @param container album コンテナ
 * @param kind 図鑑の種類
 * @param name 項目の名前
 * @returns 見出しの写真。その名前の写真が無ければ null
 */
export async function queryCatalogHead(container: Container, kind: string, name: string): Promise<CatalogHeadPhoto | null> {
  const { resources } = await container.items
    .query<CatalogHeadPhoto>({
      query:
        'SELECT TOP 1 c.id, c.identification, c.thumbnailBlobName, c.blobName FROM c' +
        ' WHERE c.type = @type AND c.identification.kind = @kind AND c.identification.matchesKind = true' +
        ' AND c.identification.name = @entryName' +
        ' ORDER BY c.identification.confidence DESC, c.identification.at DESC',
      parameters: [
        { name: '@type', value: 'photo' },
        { name: '@kind', value: kind },
        // @entryName にする（テストの偽物は @entryName を写真の identification.name で絞る）
        { name: '@entryName', value: name },
      ],
    })
    .fetchAll();
  return resources[0] ?? null;
}

/**
 * 項目の写真の枚数を数える（分類どおりの種類が写っている、その名前の写真だけ）
 * @param container album コンテナ
 * @param kind 図鑑の種類
 * @param name 項目の名前
 */
export async function queryCatalogPhotoCount(container: Container, kind: string, name: string): Promise<number> {
  const { resources } = await container.items
    .query<number>({
      query:
        'SELECT VALUE COUNT(1) FROM c' +
        ' WHERE c.type = @type AND c.identification.kind = @kind AND c.identification.matchesKind = true' +
        ' AND c.identification.name = @entryName',
      parameters: [
        { name: '@type', value: 'photo' },
        { name: '@kind', value: kind },
        { name: '@entryName', value: name },
      ],
    })
    .fetchAll();
  return resources[0] ?? 0;
}
