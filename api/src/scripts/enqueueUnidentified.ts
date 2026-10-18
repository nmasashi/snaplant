import { readFileSync } from 'fs';
import { join } from 'path';
import { isCatalogKind } from '../catalog/kinds';
import { AlbumService } from '../services/albumService';

/**
 * 段階3で分類まで済んだ写真（図鑑の種類で、識別の無いもの）を、識別の待ちにする一度だけのスクリプト
 * （docs/travel-album/06_processing_design.md §1、02 §5 #30）
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
    (photo) => photo.processing.state === 'done' && photo.identification === null && isCatalogKind(photo.category)
  );
  options.log(`識別の対象（分類まで済んで識別の無い写真）: ${targets.length} 枚`);
  if (!options.apply) {
    options.log('--apply が無いので、何も書きません');
    return { found: targets.length, marked: 0 };
  }

  let marked = 0;
  for (const photo of targets) {
    // 読んだときのままのときだけ書く。読んだ後にやり直しの受付やワーカーが書いた写真は飛ばす
    const written = await album.resetStalePhotoProcessing(photo.id, photo.processing, {
      state: 'pending',
      step: 'identify',
      attempts: 0,
      lastError: null,
      updatedAt: now,
    });
    if (written) {
      marked += 1;
    } else {
      options.log(`読んだ後に解析の進み具合が変わったので飛ばしました: ID=${photo.id}`);
    }
  }
  options.log(`識別の待ちにした写真: ${marked} 枚（再投入のタイマーが 10〜20 分後に積みます）`);
  return { found: targets.length, marked };
}

/**
 * 手元の local.settings.json の Values を、まだ設定されていない環境変数に入れる（無ければ何もしない）
 *
 * 秘密の値を含むファイルなので、中身はログに出さない
 */
function loadLocalSettings(): void {
  let values: Record<string, string>;
  try {
    values = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'local.settings.json'), 'utf8')).Values ?? {};
  } catch {
    return;
  }
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

// 使い方（api/ で）: npm run build && node dist/src/scripts/enqueueUnidentified.js [--apply]
if (require.main === module) {
  loadLocalSettings();
  enqueueUnidentifiedPhotos({ apply: process.argv.includes('--apply'), log: console.log }).catch((error) => {
    console.error('識別の待ちにするスクリプトが失敗しました:', error);
    process.exitCode = 1;
  });
}
