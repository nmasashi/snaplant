import { CosmosClient } from '@azure/cosmos';
import { BlobServiceClient, ContainerClient } from '@azure/storage-blob';
import { createHash } from 'crypto';
import { CATALOG_KINDS } from '../catalog/kinds';
import { CATALOG_VALIDATION, FILE_UPLOAD } from '../constants/validation';
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
 * @returns 植物の件数（found）・移した件数（migrated。読むだけなら移す件数）・飛ばした植物（skipped）
 */
export async function migratePlants(options: {
  apply: boolean;
  log: (...args: unknown[]) => void;
}): Promise<{ found: number; migrated: number; skipped: SkippedPlant[] }> {
  const config = readConfig();
  // 読むだけの実行でも作る: 先にある写真を書き込むときと同じに確かめ、書く先の設定が足りなければ植物を読む前に止める
  const album = new AlbumService();
  const photoStorage = new PhotoStorageService();
  const plants = await readPlants(config);
  const images = BlobServiceClient.fromConnectionString(config.storageConnectionString).getContainerClient(
    config.imagesContainer
  );
  const now = new Date().toISOString();
  const skipped: SkippedPlant[] = [];
  let migrated = 0;
  // 読むだけの実行で移すと数えた写真の id。写真を作らないので、同じ画像の2つ目の植物を --apply と同じく先にあるとして飛ばすために覚える
  const countedPhotoIds = new Set<string>();
  options.log(`植物図鑑の記録: ${plants.length} 件`);

  for (const plant of plants) {
    const skip = (reason: string) => {
      skipped.push({ plantId: plant.id, name: plant.name, reason });
      options.log(`飛ばしました: ${plant.name}（植物 ID=${plant.id}）: ${reason}`);
    };
    // 名前は図鑑の項目の鍵。識別のワーカーと同じく前後の空白を除いて 1〜100 文字だけを認める（04 §3.1）
    const name = plant.name?.trim() ?? '';
    if (name === '' || name.length > CATALOG_VALIDATION.NAME_MAX_LENGTH) {
      skip(`名前が空か、${CATALOG_VALIDATION.NAME_MAX_LENGTH}文字を超える`);
      continue;
    }
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
    const photoId = sha256(image.data);
    if (countedPhotoIds.has(photoId) || (await album.getPhoto(photoId))) {
      skip(`同じ写真が先にある（写真 ID=${photoId}）`);
      continue;
    }
    if (!options.apply) {
      // 読むだけなら、移す植物として数えるだけ
      countedPhotoIds.add(photoId);
      migrated += 1;
      continue;
    }
    const doc = photoDocumentOf(plant, name, photoId, image, `${photoId}${extension}`, now);
    await photoStorage.upload(doc.blobName, image.data, image.contentType);
    const { created } = await album.createPhoto(doc);
    if (!created) {
      // 読んだ後に同じ写真が送られた。先の写真はそのまま残す
      skip(`同じ写真が先にある（写真 ID=${doc.id}）`);
      continue;
    }
    migrated += 1;
  }
  options.log(
    options.apply
      ? `移した植物: ${migrated} 件、飛ばした植物: ${skipped.length} 件`
      : `移す植物: ${migrated} 件、飛ばす植物: ${skipped.length} 件（--apply が無いので、何も書いていません）`
  );
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

/** 書く先の設定。読むのは AlbumService・PhotoStorageService で、ここでは足りないことを読む元と一緒に言うためだけに確かめる */
const WRITE_SETTINGS = ['COSMOS_DB_ALBUM_CONTAINER', 'PHOTO_STORAGE_CONTAINER_NAME'];

/** 読む元（植物・images）と書く先（写真）の設定を読む。足りなければ、足りない設定の名前をまとめて言って止める */
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
  const missing = [
    ...Object.entries(names)
      .filter(([key]) => values[key as keyof MigrationConfig] === '')
      .map(([, name]) => name),
    ...WRITE_SETTINGS.filter((name) => (process.env[name]?.trim() ?? '') === ''),
  ];
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
  const host = `${account}.blob.${suffix}`;
  const segments = url.pathname.split('/');
  if (
    url.protocol !== 'https:' ||
    url.host !== host ||
    segments.length !== 3 ||
    segments[1] !== config.imagesContainer ||
    segments[2] === '' ||
    // new URL() はクエリ・ホストの大文字小文字などを吸収するので、最後に生の文字列が正規形と完全一致することを求める
    // （StorageService.isValidImagePath と同じ考え方。パースした結果だけを見ると、同じ Blob を指す別の文字列が通る）
    imagePath !== `https://${host}/${config.imagesContainer}/${segments[2]}`
  ) {
    return null;
  }
  let name: string;
  try {
    name = decodeURIComponent(segments[2]);
  } catch {
    // 壊れたパーセントエンコード。この植物だけを飛ばし、移行全体は止めない
    return null;
  }
  // 解いた名前が階層を持つ（/・\ を含む）か、. / .. なら読まない。ここまでの条件は解く前のセグメントを見ているので、
  // ..%2Fphotos%2Fx.jpg は通る。SDK は名前を / で分けて URL に入れ .. を正規化するので、読めば別のコンテナの Blob になる
  if (/[/\\]/.test(name) || name === '.' || name === '..') {
    return null;
  }
  return name;
}

/** images コンテナの画像を読む。無ければ null */
async function readImage(
  images: ContainerClient,
  blobName: string
): Promise<{ data: Buffer; contentType: string } | null> {
  const blob = images.getBlockBlobClient(blobName);
  try {
    // 中身と Content-Type を1回の要求で読む（2回に分けると、間に上書きされたとき別の版の中身と型を組み合わせうる）
    const response = await blob.download();
    const chunks: Buffer[] = [];
    for await (const chunk of response.readableStreamBody!) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    // 植物図鑑は送られた Content-Type をそのまま付けていた（大文字のこともある）。写真の送信と同じく小文字にそろえる
    return { data: Buffer.concat(chunks), contentType: (response.contentType ?? '').toLowerCase() };
  } catch (error: any) {
    if (error.statusCode === 404) {
      return null;
    }
    throw error;
  }
}

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

/** 植物の記録から、識別の済んだ旅行に属さない写真の文書を作る（項目は 06 §7.1）。[name] は前後の空白を除いて確かめた名前 */
function photoDocumentOf(
  plant: Plant,
  name: string,
  photoId: string,
  image: { data: Buffer; contentType: string },
  blobName: string,
  now: string
): PhotoDocument {
  // 欄は識別のワーカーと同じく植物の定義表の項目をすべて持つ（04 §3.1。「無い」がキーの欠けと null の2通りになると、Cosmos SQL での振る舞いが分かれる）。
  // 値は前後の空白を除いて空なら null にする（古い記録の空白だけの値を、AI が返さなかった値と同じに扱う）
  const orNull = (value: string | undefined): string | null => value?.trim() || null;
  const legacy = plant as unknown as Record<string, string | undefined>;
  const attributes = Object.fromEntries(
    CATALOG_KINDS.plant.fields.map((field) => [field.key, orNull(legacy[field.key])])
  );
  const characteristics = orNull(plant.characteristics);
  return {
    id: photoId,
    type: 'photo',
    tripId: null,
    blobName,
    thumbnailBlobName: null,
    contentType: image.contentType,
    fileSize: image.data.length,
    takenAt: null,
    takenAtSource: 'none',
    sortAt: computeSortAt(null, plant.createdAt),
    location: null,
    category: 'plant',
    tags: [],
    comment: characteristics,
    commentSource: characteristics === null ? null : 'ai',
    hint: null,
    // 分類 AI は通していないので、分類の信頼度は無い
    classification: { kind: 'plant', confidence: null, model: 'migration', at: plant.createdAt },
    identification: {
      kind: 'plant',
      matchesKind: true,
      name,
      confidence: plant.confidence,
      description: orNull(plant.description),
      characteristics,
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
