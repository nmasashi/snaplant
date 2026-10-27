/**
 * 表の行を1つのテストの中で順に回す（`it.each` の代わり）。
 *
 * `it.each` は行ごとにテストを1件にするので、表が長いほどテストの件数と実行の手間が増える。
 * 1つのテストで回し、落ちた行の名前（行の先頭の要素）をエラーに添えて、どの行で落ちたかは分かるようにする。
 * 行の間でテストの状態（偽物の中身など）は戻らないので、行が状態を残さない表か、各行が自分で状態を置き直す表にだけ使う
 */
export async function forEachCase<const Row extends readonly [string, ...unknown[]]>(
  rows: readonly Row[],
  // 行の型は表から決める（本体の引数が表より少なくてもよいように、本体からは推論しない）
  body: (...row: NoInfer<[...Row]>) => Promise<void> | void
): Promise<void> {
  for (const row of rows) {
    try {
      await body(...row);
    } catch (error: any) {
      if (error instanceof Error) {
        error.message = `【${row[0]}】\n${error.message}`;
      }
      throw error;
    }
  }
}
