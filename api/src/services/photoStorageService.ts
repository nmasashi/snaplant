import { BlobServiceClient, ContainerClient } from '@azure/storage-blob';
import { generateReadSasUrl } from '../utils/blobSas';
import { UpstreamError } from '../utils/errors';
import { PHOTO_SAS_START_SKEW_MINUTES } from '../constants/album';

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
  const minutes = parseInt(process.env.PHOTO_SAS_EXPIRY_MINUTES ?? '', 10);
  return new Date(Date.now() + (minutes > 0 ? minutes : 60) * 60 * 1000);
}
