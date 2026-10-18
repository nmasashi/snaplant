import { readFileSync } from 'fs';
import { join } from 'path';

// 手で回すスクリプト（src/scripts/）が共有する、設定の読み込みと宛先の表示

/**
 * api/ の local.settings.json の Values を、まだ設定されていない環境変数に入れる
 *
 * ビルドしたスクリプト（dist/src/scripts）から数えて探すので、どこから回しても同じファイルを読む。
 * 秘密の値を含むファイルなので、中身はログに出さない。ファイルが無ければその旨を出して環境変数だけで続け、
 * JSON として読めなければ止める（読めないまま続けると、残っていた別の環境の値で書きうる）
 */
export function loadLocalSettings(): void {
  const path = join(__dirname, '..', '..', '..', 'local.settings.json');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error: any) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
    console.log(`${path} が無いので、環境変数だけを使います`);
    return;
  }
  let values: Record<string, string>;
  try {
    values = JSON.parse(text).Values ?? {};
  } catch {
    // JSON.parse のエラーは壊れた箇所の前後の文字列を含むので、そのまま投げない（秘密の値が出うる）
    throw new Error(`${path} を JSON として読めません`);
  }
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

/** Cosmos のエンドポイントのホスト（宛先の表示用）。無い・URL として読めないときはそう出す */
export function endpointHost(endpoint: string | undefined): string {
  if (!endpoint) {
    return '（COSMOS_DB_ENDPOINT が無い）';
  }
  try {
    return new URL(endpoint).host;
  } catch {
    return '（COSMOS_DB_ENDPOINT が URL として読めない）';
  }
}
