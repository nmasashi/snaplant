import { Container } from '@azure/cosmos';

/**
 * 旅行の集計に使う Cosmos SQL
 *
 * SQL 文字列とパラメータの組み立てだけの薄い層。集計（GROUP BY・COUNT・MIN / MAX）は
 * テスト用の偽物では解釈できないため、ここはテストせず、デプロイ後に手で確かめる
 * （docs/travel-album/08_test_plan.md §5.2）。集計の行から応答を組み立てる所は
 * tripSummaries.ts に分けてあり、そちらを単体で確かめる。
 *
 * GROUP BY は Cosmos SQL の制約で ORDER BY と同じクエリに書けない。
 * tripId が null の写真（旅行に属さない写真）も1つのグループになる想定（推測。手で確かめる）
 */

/** 旅行ごとの写真の枚数の行 */
export interface PhotoCountRow {
  tripId: string | null;
  photoCount: number;
}

/** 旅行ごとの撮影期間の行（撮影日時のある写真だけ） */
export interface TakenAtRangeRow {
  tripId: string | null;
  firstTakenAt: string;
  lastTakenAt: string;
}

/**
 * 旅行ごとの写真の枚数を数える
 * @param container album コンテナ
 * @param tripId 指定すればその旅行だけ。省略すれば全部（旅行に属さない写真の行も含む）
 */
export async function queryPhotoCounts(container: Container, tripId?: string): Promise<PhotoCountRow[]> {
  const { resources } = await container.items
    .query<PhotoCountRow>({
      query:
        'SELECT c.tripId, COUNT(1) AS photoCount FROM c WHERE c.type = @type' +
        (tripId ? ' AND c.tripId = @tripId' : '') +
        ' GROUP BY c.tripId',
      parameters: [{ name: '@type', value: 'photo' }, ...(tripId ? [{ name: '@tripId', value: tripId }] : [])],
    })
    .fetchAll();
  return resources;
}

/**
 * 旅行ごとの撮影期間を求める
 *
 * MIN / MAX が null をどう扱うかに依存しないよう、撮影日時が文字列の写真だけに絞る
 * @param container album コンテナ
 * @param tripId 指定すればその旅行だけ
 */
export async function queryTakenAtRanges(container: Container, tripId?: string): Promise<TakenAtRangeRow[]> {
  const { resources } = await container.items
    .query<TakenAtRangeRow>({
      query:
        'SELECT c.tripId, MIN(c.takenAt) AS firstTakenAt, MAX(c.takenAt) AS lastTakenAt FROM c' +
        ' WHERE c.type = @type AND IS_STRING(c.takenAt)' +
        (tripId ? ' AND c.tripId = @tripId' : '') +
        ' GROUP BY c.tripId',
      parameters: [{ name: '@type', value: 'photo' }, ...(tripId ? [{ name: '@tripId', value: tripId }] : [])],
    })
    .fetchAll();
  return resources;
}

/** 表紙にする写真の Blob 名 */
export interface CoverRow {
  blobName: string;
  thumbnailBlobName: string | null;
}

/**
 * 旅行の表紙にする写真（並べ替え用の日時で最初の1枚）を読む
 *
 * 旅行ごとに TOP 1 を投げる（旅行は数十件。1本数 RU）。並び順は手で確かめる
 * @param container album コンテナ
 * @param tripId 旅行 ID
 * @returns 表紙の写真の Blob 名。写真が無ければ null
 */
export async function queryCover(container: Container, tripId: string): Promise<CoverRow | null> {
  const { resources } = await container.items
    .query<CoverRow>({
      query:
        'SELECT TOP 1 c.blobName, c.thumbnailBlobName FROM c WHERE c.type = @type AND c.tripId = @tripId ORDER BY c.sortAt ASC',
      parameters: [
        { name: '@type', value: 'photo' },
        { name: '@tripId', value: tripId },
      ],
    })
    .fetchAll();
  return resources[0] ?? null;
}
