import { CosmosClient } from '@azure/cosmos';
import { BlobServiceClient, ContainerClient } from '@azure/storage-blob';
import { createHash } from 'crypto';
import { FILE_UPLOAD } from '../constants/validation';
import { AlbumService } from '../services/albumService';
import { PhotoStorageService } from '../services/photoStorageService';
import { PhotoDocument } from '../types/album';
import { Plant } from '../types/plant';
import { computeSortAt } from '../utils/sortAt';
import { endpointHost, loadLocalSettings } from './scriptSettings';

/** 移さずに飛ばした植物（人間が一覧を見て、捨てるか手で入れるかを決める。06 §7 の手順 3） */
export interface SkippedPlant {
  plantId: string;
  name: string;
  reason: string;
}

/**
 * 植物図鑑の記録（plants コンテナ）を、識別の済んだ写真（album コンテナ・photos コンテナ）へ移す一度だけのスクリプト
 * （docs/travel-album/06_processing_design.md §7 の手順 2）
 *
 * 図鑑の項目は文書として持たないので、植物ごとに写真を1枚作るだけ（項目は写真の識別から組み立てる）。
 * 冪等: 写真の id は画像の SHA-256 なので、もう一度回すと移した植物は「同じ写真が先にある」として飛ばす。
 * Blob → 写真の文書の順に書く（04 §7.1）。途中で止まっても、文書の無い Blob が残るだけで、回し直すと上書きされる
 * @param options apply が false なら読むだけで書かない。log はログの出し先
 * @returns 植物の件数（found）・移した件数（migrated）・飛ばした植物（skipped）
 */
export async function migratePlants(options: {
  apply: boolean;
  log: (...args: unknown[]) => void;
}): Promise<{ found: number; migrated: number; skipped: SkippedPlant[] }> {
  const config = readConfig();
  const plants = await readPlants(config);
  const images = BlobServiceClient.fromConnectionString(config.storageConnectionString).getContainerClient(
    config.imagesContainer
  );
  const album = options.apply ? new AlbumService() : null;
  const photoStorage = options.apply ? new PhotoStorageService() : null;
  const now = new Date().toISOString();
  const skipped: SkippedPlant[] = [];
  let migrated = 0;
  options.log(`植物図鑑の記録: ${plants.length} 件`);

  for (const plant of plants) {
    const skip = (reason: string) => {
      skipped.push({ plantId: plant.id, name: plant.name, reason });
      options.log(`飛ばしました: ${plant.name}（植物 ID=${plant.id}）: ${reason}`);
    };
    const blobName = imageBlobName(plant.imagePath, config);
    if (blobName === null) {
      skip('画像の URL が images コンテナの Blob ではない');
      continue;
    }
    const image = await readImage(images, blobName);
    if (image === null) {
      skip('画像が見つからない');
      continue;
    }
    const extension = FILE_UPLOAD.EXTENSION_BY_CONTENT_TYPE[image.contentType];
    if (extension === undefined) {
      skip(`画像の形式（${image.contentType}）が写真として受け付けないもの`);
      continue;
    }
    const doc = photoDocumentOf(plant, image.data, image.contentType, `${sha256(image.data)}${extension}`, now);
    if (album === null || photoStorage === null) {
      continue;
    }
    if (await album.getPhoto(doc.id)) {
      skip(`同じ写真が先にある（写真 ID=${doc.id}）`);
      continue;
    }
    await photoStorage.upload(doc.blobName, image.data, image.contentType);
    const { created } = await album.createPhoto(doc);
    if (!created) {
      // 読んだ後に同じ写真が送られた。先の写真はそのまま残す
      skip(`同じ写真が先にある（写真 ID=${doc.id}）`);
      continue;
    }
    migrated += 1;
  }
  options.log(`移した植物: ${migrated} 件、飛ばした植物: ${skipped.length} 件${options.apply ? '' : '（--apply が無いので、何も書いていません）'}`);
  return { found: plants.length, migrated, skipped };
}

interface MigrationConfig {
  cosmosEndpoint: string;
  cosmosKey: string;
  cosmosDatabase: string;
  plantsContainer: string;
  storageConnectionString: string;
  imagesContainer: string;
}

/** 植物のコンテナと images コンテナの設定を読む。足りなければ、足りない設定の名前を言って止める */
function readConfig(): MigrationConfig {
  const names = {
    cosmosEndpoint: 'COSMOS_DB_ENDPOINT',
    cosmosKey: 'COSMOS_DB_KEY',
    cosmosDatabase: 'COSMOS_DB_DATABASE',
    plantsContainer: 'COSMOS_DB_CONTAINER',
    storageConnectionString: 'STORAGE_CONNECTION_STRING',
    imagesContainer: 'STORAGE_CONTAINER_NAME',
  } as const;
  const values = Object.fromEntries(
    Object.entries(names).map(([key, name]) => [key, process.env[name]?.trim() ?? ''])
  ) as Record<keyof MigrationConfig, string>;
  const missing = Object.entries(names)
    .filter(([key]) => values[key as keyof MigrationConfig] === '')
    .map(([, name]) => name);
  if (missing.length > 0) {
    throw new Error(`設定が足りません: ${missing.join(', ')}`);
  }
  return values;
}

/** 植物の記録を全件読む（保存した順。止まったときにどこまで移したかを追いやすいように） */
async function readPlants(config: MigrationConfig): Promise<Plant[]> {
  const container = new CosmosClient({ endpoint: config.cosmosEndpoint, key: config.cosmosKey })
    .database(config.cosmosDatabase)
    .container(config.plantsContainer);
  const { resources } = await container.items.query<Plant>('SELECT * FROM c').fetchAll();
  return [...resources].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * 植物の imagePath（images コンテナの Blob の URL）から Blob 名を取る。自分のアカウントの images コンテナの Blob でなければ null
 * （植物図鑑の API は保存のときに検証しているが、別のホスト・別のコンテナの Blob を読まないように、移す前にもう一度確かめる）
 */
function imageBlobName(imagePath: string, config: MigrationConfig): string | null {
  const account = config.storageConnectionString.match(/AccountName=([^;]+)/)?.[1];
  const suffix = config.storageConnectionString.match(/EndpointSuffix=([^;]+)/)?.[1] ?? 'core.windows.net';
  let url: URL;
  try {
    url = new URL(imagePath);
  } catch {
    return null;
  }
  const segments = url.pathname.split('/');
  if (
    url.protocol !== 'https:' ||
    url.host !== `${account}.blob.${suffix}` ||
    segments.length !== 3 ||
    segments[1] !== config.imagesContainer ||
    segments[2] === ''
  ) {
    return null;
  }
  return decodeURIComponent(segments[2]);
}

/** images コンテナの画像を読む。無ければ null */
async function readImage(
  images: ContainerClient,
  blobName: string
): Promise<{ data: Buffer; contentType: string } | null> {
  const blob = images.getBlockBlobClient(blobName);
  try {
    const properties = await blob.getProperties();
    const response = await blob.download();
    const chunks: Buffer[] = [];
    for await (const chunk of response.readableStreamBody!) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return { data: Buffer.concat(chunks), contentType: properties.contentType ?? '' };
  } catch (error: any) {
    if (error.statusCode === 404) {
      return null;
    }
    throw error;
  }
}

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

/** 植物の記録から、識別の済んだ旅行に属さない写真の文書を作る（項目は 06 §7 の手順 2） */
function photoDocumentOf(plant: Plant, image: Buffer, contentType: string, blobName: string, now: string): PhotoDocument {
  // 欄（植物の定義表の fields）は、値のあるものだけを入れる
  const attributes: Record<string, string> = {};
  if (plant.scientificName) attributes.scientificName = plant.scientificName;
  if (plant.familyName) attributes.familyName = plant.familyName;
  return {
    id: sha256(image),
    type: 'photo',
    tripId: null,
    blobName,
    thumbnailBlobName: null,
    contentType,
    fileSize: image.length,
    takenAt: null,
    takenAtSource: 'none',
    sortAt: computeSortAt(null, plant.createdAt),
    location: null,
    category: 'plant',
    tags: [],
    comment: plant.characteristics,
    commentSource: 'ai',
    hint: null,
    // 分類 AI は通していないので、分類の信頼度は無い
    classification: { kind: 'plant', confidence: null, model: 'migration', at: plant.createdAt },
    identification: {
      kind: 'plant',
      matchesKind: true,
      name: plant.name,
      confidence: plant.confidence,
      description: plant.description ?? null,
      characteristics: plant.characteristics,
      attributes,
      reason: null,
      model: 'migration',
      at: plant.createdAt,
    },
    processing: { state: 'done', step: 'identify', attempts: 0, lastError: null, updatedAt: plant.createdAt },
    uploadedAt: plant.createdAt,
    updatedAt: now,
    legacyPlantId: plant.id,
  };
}

// 使い方（api/ で）: npm run build && node dist/src/scripts/migratePlants.js [--apply]
if (require.main === module) {
  run().catch((error) => {
    console.error('植物図鑑の記録を移すスクリプトが失敗しました:', error);
    process.exitCode = 1;
  });
}

/** 設定を読み、宛先を出してから移す（手で回すときの入口） */
async function run(): Promise<void> {
  loadLocalSettings();
  // 書く前に宛先を人間が確かめられるように出す（鍵は出さない）。手元の設定が別の DB を指していることがある
  const account = process.env.STORAGE_CONNECTION_STRING?.match(/AccountName=([^;]+)/)?.[1] ?? '（アカウント名が無い）';
  console.log(
    `読む元: ${endpointHost(process.env.COSMOS_DB_ENDPOINT?.trim())} / ${process.env.COSMOS_DB_DATABASE?.trim() || '（データベース名が無い）'} / ` +
      `${process.env.COSMOS_DB_CONTAINER?.trim() || '（植物のコンテナ名が無い）'}、画像は ${account} / ${process.env.STORAGE_CONTAINER_NAME?.trim() || '（コンテナ名が無い）'}`
  );
  console.log(
    `書く先: ${process.env.COSMOS_DB_ALBUM_CONTAINER?.trim() || '（写真のコンテナ名が無い）'}、画像は ` +
      `${process.env.PHOTO_STORAGE_CONTAINER_NAME?.trim() || '（写真の保存先のコンテナ名が無い）'}`
  );
  await migratePlants({ apply: process.argv.includes('--apply'), log: console.log });
}
