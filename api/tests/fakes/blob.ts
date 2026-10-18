import { BlobServiceClient, BlockBlobClient } from '@azure/storage-blob';
import { Readable } from 'stream';

/**
 * 引数を見分ける状態持ちの偽物 Blob Storage。
 *
 * コンテナ名と Blob 名を組んだキーごとに内容を Map に保持する。これにより
 * 「一時→永続への移動で宛先コンテナを取り違える」「削除対象を取り違える」
 * といった不具合を検出できる。単一の共有モックだとどの引数で呼ばれても
 * 同じ値を返すため、宛先の取り違えがテストを通過してしまう。
 *
 * Blob Storage は管理下にある依存なので、モックは運用上の例外として
 * 許容するが**やり取りの検証はしない**。保存できたか・消えたかは
 * 呼び出し回数ではなく `store` の状態で確認する。
 *
 * 各テストが使う操作はテスト対象によって違う（アップロードだけ、削除だけ、など）。
 * 偽物が余分な操作を持っていてもテストは弱くならないため、必要な操作の
 * 和集合をここに1つだけ置き、各テストは使う分だけ触る。
 */
export const TEST_BLOB_HOST = 'test.blob.core.windows.net';

export interface BlobEntry {
  content: Buffer;
  /** `getProperties()` が返す Content-Type。アップロード時のヘッダから入る */
  contentType?: string;
  /** この Blob への操作を失敗させる（取得・削除の失敗経路の検証用） */
  failWith?: Error;
  /**
   * 一覧（listBlobsFlat）が返す最終更新の時刻。省略すると一覧を取った時点（新しい Blob）として返す。
   * アップロードでは付けない（既存のテストの store の比較に影響させない）
   */
  lastModified?: Date;
  /**
   * ダウンロードは成功するが、ストリームの読み出し中に失敗させる。
   * 「レスポンスが返った後に壊れる」経路は failWith では再現できない
   */
  streamErrorWith?: Error;
}

export interface FakeBlobBackend {
  store: Map<string, BlobEntry>;
  /** アップロードを失敗させる。Blob 単位ではなくバックエンド全体に効く */
  forcedUploadError?: Error | null;
  /**
   * 指定したコンテナへのアップロードだけを失敗させる（コンテナ名 → エラー）。
   * 「一時保存は成功し、永続コンテナへの移動で失敗する」経路は
   * バックエンド全体に効く forcedUploadError では再現できない。既定は未設定
   */
  forcedUploadErrorByContainer?: Record<string, Error>;
  /**
   * 指定した Blob へのアップロードだけを失敗させる（`コンテナ名/Blob名` → エラー。`store` のキーと同じ形）。
   * 写真の原寸とサムネイルは同じコンテナに置くので、コンテナ単位の forcedUploadErrorByContainer では
   * 区別できない。「原寸は成功し、サムネイルだけ失敗する」経路を作る。既定は未設定
   */
  forcedUploadErrorByKey?: Record<string, Error>;
  /**
   * アップロードで書かれる Blob のキー（`コンテナ名/Blob名`）が接頭辞で始まるとき、その Blob に failWith を持たせる
   * （接頭辞 → エラー。例 `temp/` で一時コンテナの Blob）。Blob 名がリクエストの中で決まり、テストから
   * キーを先に知れないときに、書かれた時点で「その Blob の取得・削除が失敗する」状態を作る。
   * `store.set()` で直接置いた Blob には効かない。既定は未設定
   */
  failWithByPrefix?: Record<string, Error>;
  /** failWithByPrefix の、ストリームの読み出し中に失敗させる版（streamErrorWith を持たせる） */
  streamErrorWithByPrefix?: Record<string, Error>;
}

/** キーが接頭辞のどれかで始まるとき、そのエラーを返す */
function errorForPrefix(byPrefix: Record<string, Error> | undefined, key: string): Error | undefined {
  return Object.entries(byPrefix ?? {}).find(([prefix]) => key.startsWith(prefix))?.[1];
}

/** 実 SDK が存在しない Blob への操作で投げる形に合わせたエラー */
export function blobNotFoundError(): any {
  const err: any = new Error('BlobNotFound');
  err.statusCode = 404;
  return err;
}

export function createFakeBlockBlobClient(
  backend: FakeBlobBackend,
  containerName: string,
  blobName: string
): BlockBlobClient {
  const key = `${containerName}/${blobName}`;
  const url = `https://${TEST_BLOB_HOST}/${key}`;

  return {
    url,
    upload: async (content: Buffer, _length: number, options?: any) => {
      if (backend.forcedUploadError) {
        throw backend.forcedUploadError;
      }
      const containerError = backend.forcedUploadErrorByContainer?.[containerName];
      if (containerError) {
        throw containerError;
      }
      const blobError = backend.forcedUploadErrorByKey?.[key];
      if (blobError) {
        throw blobError;
      }
      const failWith = errorForPrefix(backend.failWithByPrefix, key);
      const streamErrorWith = errorForPrefix(backend.streamErrorWithByPrefix, key);
      backend.store.set(key, {
        content,
        contentType: options?.blobHTTPHeaders?.blobContentType,
        // 仕込みが無いときはキー自体を足さない（既存のテストの比較に影響させない）
        ...(failWith && { failWith }),
        ...(streamErrorWith && { streamErrorWith })
      });
      return {};
    },
    download: async () => {
      const entry = backend.store.get(key);
      if (!entry) throw blobNotFoundError();
      if (entry.failWith) throw entry.failWith;
      const stream = new Readable({
        read() {
          if (entry.streamErrorWith) {
            this.emit('error', entry.streamErrorWith);
            return;
          }
          this.push(entry.content);
          this.push(null);
        }
      });
      return { readableStreamBody: stream };
    },
    getProperties: async () => {
      const entry = backend.store.get(key);
      if (!entry) throw blobNotFoundError();
      if (entry.failWith) throw entry.failWith;
      return { contentType: entry.contentType };
    },
    delete: async () => {
      const entry = backend.store.get(key);
      if (!entry) throw blobNotFoundError();
      if (entry.failWith) throw entry.failWith;
      backend.store.delete(key);
      return {};
    }
  } as unknown as BlockBlobClient;
}

export function createFakeBlobServiceClient(backend: FakeBlobBackend): BlobServiceClient {
  return {
    getContainerClient: (containerName: string) => ({
      getBlockBlobClient: (blobName: string) => createFakeBlockBlobClient(backend, containerName, blobName),
      // 実 SDK と同じく、そのコンテナの Blob の名前と最終更新の時刻を順に返す（ページは分けない）
      listBlobsFlat: () =>
        (async function* () {
          for (const [key, entry] of [...backend.store]) {
            if (key.startsWith(`${containerName}/`)) {
              yield {
                name: key.slice(containerName.length + 1),
                properties: { lastModified: entry.lastModified ?? new Date() }
              };
            }
          }
        })()
    })
  } as unknown as BlobServiceClient;
}

/** 返ってきたURL（SASクエリ付きの場合あり）から、偽物バックエンドのMapキーを導く */
export function keyFromUrl(url: string): string {
  return url.replace(`https://${TEST_BLOB_HOST}/`, '').split('?')[0];
}
