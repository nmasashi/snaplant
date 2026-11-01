import { AlbumService } from '../services/albumService';
import { endpointHost, loadLocalSettings } from './scriptSettings';

/**
 * C-4 より前に解析が済んだ食べ物の写真（タグの無いもの）を、タグの提案の待ちにする一度だけのスクリプト
 * （docs/06_processing_design.md §9、02 §5 #61）
 *
 * キューには積まない。提案の待ちにした写真は、再投入のタイマーが 10〜20 分後に積む（待ちのまま 10 分たった写真を拾う）。
 * 手元から本番のキューにつながなくて済む（enqueueUnidentified.ts と同じ）。1枚ごとに AI（detail: high）を呼ぶので、先に件数を見てから回す
 * @param options apply が false なら数えるだけで書かない。log はログの出し先
 * @returns 対象の写真の枚数（found）と、提案の待ちにした枚数（marked）
 */
export async function enqueueUntaggedFoodPhotos(options: {
  apply: boolean;
  log: (...args: unknown[]) => void;
}): Promise<{ found: number; marked: number }> {
  const album = new AlbumService();
  const now = new Date().toISOString();
  // クエリと同じ条件をコードでも見る（クエリの絞り込みはテストで確かめられない）。崩れても、タグのある写真や解析中の写真を書き換えない
  const targets = (await album.listUntaggedFoodPhotos()).filter(
    // 手でカテゴリを食べ物に直した写真は、自動ではタグを提案しない（06 §9）ので除く
    (photo) => photo.processing?.state === 'done' && photo.category === 'food' && photo.categorySource !== 'user' && (photo.tags ?? []).length === 0
  );
  options.log(`タグの提案の対象（解析が済んでタグの無い、AI が食べ物と分類した写真）: ${targets.length} 枚`);
  if (!options.apply) {
    options.log('--apply が無いので、何も書きません');
    return { found: targets.length, marked: 0 };
  }

  let marked = 0;
  for (const photo of targets) {
    // 読んだときのままのときだけ書く。読んだ後にやり直しの受付やワーカーが書いた写真は飛ばす
    let written: boolean;
    try {
      written = await album.writeProcessing(photo.id, photo.processing, {
        state: 'pending',
        step: 'tag',
        attempts: 0,
        lastError: null,
        updatedAt: now,
      });
    } catch (error) {
      // もう一度回しても、提案の待ちにした写真は対象から外れる（done ではなくなる）ので、続きからになる
      options.log(`書き込みに失敗したので止めます（ここまでに ${marked} 枚をタグの提案の待ちにしました）: ID=${photo.id}`);
      throw error;
    }
    if (written) {
      marked += 1;
    } else {
      options.log(`読んだ後に解析の進み具合が変わったか、写真が消されたので飛ばしました: ID=${photo.id}`);
    }
  }
  options.log(`タグの提案の待ちにした写真: ${marked} 枚（再投入のタイマーが 10〜20 分後に積みます）`);
  return { found: targets.length, marked };
}

// 使い方（api/ で）: npm run build && node dist/src/scripts/enqueueUntagged.js [--apply]
if (require.main === module) {
  run().catch((error) => {
    console.error('タグの提案の待ちにするスクリプトが失敗しました:', error);
    process.exitCode = 1;
  });
}

/** 設定を読み、宛先を出してから、タグの提案の待ちにする（手で回すときの入口） */
async function run(): Promise<void> {
  loadLocalSettings();
  // 書く前に宛先を人間が確かめられるように出す（鍵は出さない）。手元の設定が別の DB を指していることがある
  console.log(
    `宛先: ${endpointHost(process.env.COSMOS_DB_ENDPOINT?.trim())} / ` +
      `${process.env.COSMOS_DB_DATABASE?.trim() || '（データベース名が無い）'} / ${process.env.COSMOS_DB_ALBUM_CONTAINER?.trim() || '（コンテナ名が無い）'}`
  );
  await enqueueUntaggedFoodPhotos({ apply: process.argv.includes('--apply'), log: console.log });
}
