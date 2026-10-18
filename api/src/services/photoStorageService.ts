import { BlobServiceClient, ContainerClient } from '@azure/storage-blob';
import { generateReadSasUrl } from '../utils/blobSas';
import { UpstreamError } from '../utils/errors';
import { PHOTO_SAS_START_SKEW_MINUTES } from '../constants/album';
import { positiveIntFromEnv } from '../constants/validation';

/**
 * 旅行アルバムの写真の Blob（photos コンテナ）を扱うサービス
 *
 * photos コンテナは非公開で、読み取りは Blob 単位の SAS 付き URL で渡す
 */
export class PhotoStorageService {
  private containerClient: ContainerClient;
  private containerName: string;
  private accountName: string;
  private accountKey: string;

  constructor() {
    const connectionString = process.env.STORAGE_CONNECTION_STRING!;
    this.containerName = process.env.PHOTO_STORAGE_CONTAINER_NAME!;
    this.accountName = connectionString.match(/AccountName=([^;]+)/)?.[1] ?? '';
    this.accountKey = connectionString.match(/AccountKey=([^;]+)/)?.[1] ?? '';
    // 鍵が無いと空の鍵で署名した URL を返し、Blob は 403 で拒む（API は成功に見える）。
    // コンテナ名が無いと undefined という名前のコンテナを指す。どちらも静かに壊れるので、ここで失敗させる
    if (!this.accountName || !this.accountKey || !this.containerName) {
      throw new Error('写真の保存先の設定（アカウント名・鍵・コンテナ名）が足りません');
    }
    this.containerClient = BlobServiceClient.fromConnectionString(connectionString).getContainerClient(this.containerName);
  }

  /**
   * Blob を上書きで書く
   * @param blobName Blob 名
   * @param data 中身
   * @param contentType Content-Type
   */
  async upload(blobName: string, data: Buffer, contentType: string): Promise<void> {
    try {
      await this.containerClient.getBlockBlobClient(blobName).upload(data, data.length, {
        blobHTTPHeaders: { blobContentType: contentType },
      });
    } catch (error: any) {
      throw new UpstreamError(`写真の保存に失敗しました: ${error.message}`, 'storage', error);
    }
  }

  /**
   * コンテナの Blob の名前と最終更新の時刻を順に返す（掃除のタイマー）
   */
  async *listBlobs(): AsyncGenerator<{ name: string; lastModified: Date }> {
    for await (const item of this.containerClient.listBlobsFlat()) {
      yield { name: item.name, lastModified: item.properties.lastModified };
    }
  }

  /**
   * Blob を消す。既に無ければ成功とみなす
   * @param blobName Blob 名
   */
  async delete(blobName: string): Promise<void> {
    try {
      await this.containerClient.getBlockBlobClient(blobName).delete();
    } catch (error: any) {
      if (error.statusCode === 404) {
        return;
      }
      throw new UpstreamError(`写真の削除に失敗しました: ${error.message}`, 'storage', error);
    }
  }

  /**
   * 写真の原寸とサムネイルの Blob を消す。失敗はログに渡すだけで投げない
   *
   * 写真のドキュメントを消した後に呼ぶ。ドキュメントはもう無いので、残った Blob は掃除のタイマー（段階3）が消す。
   * 原寸で失敗してもサムネイルは消しにいく
   * @param photo 写真の id と Blob 名
   * @param log 失敗を記録する関数
   */
  async deletePhotoBlobs(
    photo: { id: string; blobName: string; thumbnailBlobName: string | null },
    log: (message: string, error: unknown) => void
  ): Promise<void> {
    for (const blobName of [photo.blobName, photo.thumbnailBlobName]) {
      if (!blobName) {
        continue;
      }
      try {
        await this.delete(blobName);
      } catch (error: any) {
        log(`写真の Blob の削除に失敗しました（ドキュメントは削除済み）: ID=${photo.id}`, error);
      }
    }
  }

  /**
   * 読み取り専用の SAS を付けた URL を作る
   * @param blobName Blob 名
   * @param expiresOn 有効期限
   */
  readUrl(blobName: string, expiresOn: Date): string {
    return generateReadSasUrl({
      accountName: this.accountName,
      accountKey: this.accountKey,
      blobUrl: this.containerClient.getBlockBlobClient(blobName).url,
      containerName: this.containerName,
      blobName,
      expiresOn,
      startsOn: new Date(Date.now() - PHOTO_SAS_START_SKEW_MINUTES * 60 * 1000),
    });
  }
}

/**
 * 今から発行する写真の URL の有効期限
 */
export function photoUrlExpiresOn(): Date {
  // 呼ぶたびに読む（モジュールの読み込み時に固定しない）
  const minutes = positiveIntFromEnv(process.env.PHOTO_SAS_EXPIRY_MINUTES, 60);
  const expiresAt = Date.now() + minutes * 60 * 1000;
  // SAS の期限（se）は秒で書かれる。ミリ秒を残すと応答の urlExpiresAt が実際の期限より最大1秒遅れ、
  // ぎりぎりまで使ったクライアントが 403 を受ける
  return new Date(Math.floor(expiresAt / 1000) * 1000);
}
