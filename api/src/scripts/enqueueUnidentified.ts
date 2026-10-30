import { identifiesAutomatically } from '../catalog/kinds';
import { AlbumService } from '../services/albumService';
import { endpointHost, loadLocalSettings } from './scriptSettings';

/**
 * 段階3で分類まで済んだ写真（図鑑の種類で、識別の無いもの）を、識別の待ちにする一度だけのスクリプト
 * （docs/06_processing_design.md §1、02 §5 #30）
 *
 * キューには積まない。識別の待ちにした写真は、再投入のタイマーが 10〜20 分後に積む（待ちのまま 10 分たった写真を拾う）。
 * 手元から本番のキューにつながなくて済む（手元の設定の AzureWebJobsStorage はローカルの偽物を指していることがある）
 * @param options apply が false なら数えるだけで書かない。log はログの出し先
 * @returns 対象の写真の枚数（found）と、識別の待ちにした枚数（marked）
 */
export async function enqueueUnidentifiedPhotos(options: {
  apply: boolean;
  log: (...args: unknown[]) => void;
}): Promise<{ found: number; marked: number }> {
  const album = new AlbumService();
  const now = new Date().toISOString();
  // クエリと同じ条件をコードでも見る（クエリの絞り込みはテストで確かめられない）。崩れても、識別済みや解析中の写真を書き換えない
  const targets = (await album.listUnidentifiedPhotos()).filter(
    (photo) => photo.processing?.state === 'done' && photo.identification === null && identifiesAutomatically(photo.category)
  );
  options.log(`識別の対象（分類まで済んで識別の無い、自動で識別する種類（植物）の写真）: ${targets.length} 枚`);
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
        step: 'identify',
        attempts: 0,
        lastError: null,
        updatedAt: now,
      });
    } catch (error) {
      // もう一度回しても、識別の待ちにした写真は対象から外れる（done ではなくなる）ので、続きからになる
      options.log(`書き込みに失敗したので止めます（ここまでに ${marked} 枚を識別の待ちにしました）: ID=${photo.id}`);
      throw error;
    }
    if (written) {
      marked += 1;
    } else {
      options.log(`読んだ後に解析の進み具合が変わったか、写真が消されたので飛ばしました: ID=${photo.id}`);
    }
  }
  options.log(`識別の待ちにした写真: ${marked} 枚（再投入のタイマーが 10〜20 分後に積みます）`);
  return { found: targets.length, marked };
}

// 使い方（api/ で）: npm run build && node dist/src/scripts/enqueueUnidentified.js [--apply]
if (require.main === module) {
  run().catch((error) => {
    console.error('識別の待ちにするスクリプトが失敗しました:', error);
    process.exitCode = 1;
  });
}

/** 設定を読み、宛先を出してから、識別の待ちにする（手で回すときの入口） */
async function run(): Promise<void> {
  loadLocalSettings();
  // 書く前に宛先を人間が確かめられるように出す（鍵は出さない）。手元の設定が別の DB を指していることがある
  console.log(
    `宛先: ${endpointHost(process.env.COSMOS_DB_ENDPOINT?.trim())} / ` +
      `${process.env.COSMOS_DB_DATABASE?.trim() || '（データベース名が無い）'} / ${process.env.COSMOS_DB_ALBUM_CONTAINER?.trim() || '（コンテナ名が無い）'}`
  );
  await enqueueUnidentifiedPhotos({ apply: process.argv.includes('--apply'), log: console.log });
}
