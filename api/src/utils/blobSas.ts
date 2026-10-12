import { BlobSASPermissions, generateBlobSASQueryParameters, StorageSharedKeyCredential } from '@azure/storage-blob';

/** 読み取り専用の SAS を作るのに要るもの */
export interface ReadSasParams {
  /** ストレージアカウント名（共有キーの署名に使う） */
  accountName: string;
  /** ストレージアカウントのキー */
  accountKey: string;
  /** SAS を付ける前の Blob の URL */
  blobUrl: string;
  /** Blob のあるコンテナ名 */
  containerName: string;
  /** Blob 名 */
  blobName: string;
  /** 有効期限 */
  expiresOn: Date;
  /** 有効になる時刻。省略すると発行した時点から（トークンに st が付かない） */
  startsOn?: Date;
}

/**
 * Blob 1つに読み取り専用の SAS を付けた URL を作る
 *
 * 一時画像（AI 識別サービスが読む）と旅行アルバムの写真（非公開コンテナ）の両方で使うため、
 * StorageService から切り出した。有効期限の決め方と失敗の扱いは呼び出し側が持つ。
 * 署名はローカルの計算だけで、Blob Storage へは通信しない
 * @param params 署名に要るもの
 * @returns `<blobUrl>?<SAS>` の形の URL
 */
export function generateReadSasUrl(params: ReadSasParams): string {
  const permissions = new BlobSASPermissions();
  permissions.read = true;

  const sasToken = generateBlobSASQueryParameters(
    {
      containerName: params.containerName,
      blobName: params.blobName,
      permissions,
      expiresOn: params.expiresOn,
      startsOn: params.startsOn,
    },
    new StorageSharedKeyCredential(params.accountName, params.accountKey)
  ).toString();

  return `${params.blobUrl}?${sasToken}`;
}
