import { CosmosClient, Container } from '@azure/cosmos';

/** album コンテナにつなぐのに要る設定（Terraform が Function App に入れる。手で回すスクリプトは local.settings.json から） */
const COSMOS_SETTINGS = ['COSMOS_DB_ENDPOINT', 'COSMOS_DB_KEY', 'COSMOS_DB_DATABASE', 'COSMOS_DB_ALBUM_CONTAINER'] as const;

/**
 * album コンテナ（旅行・写真・タイムライン）を開く
 *
 * 足りない設定の名前を言って止める。SDK に任せると、エンドポイントが無いときは TypeError（Invalid URL）になり、
 * 何が足りないか分からない（手で回すスクリプトを、手元の設定が無いまま回したときに起きた）。
 * 確かめた値（前後の空白を除いたもの）で使う。空白の付いた値が確かめを通って SDK で分かりにくく落ちないように
 */
export function openAlbumContainer(): Container {
  const setting = (name: (typeof COSMOS_SETTINGS)[number]) => process.env[name]?.trim() ?? '';
  const missing = COSMOS_SETTINGS.filter((name) => setting(name) === '');
  if (missing.length > 0) {
    throw new Error(`Cosmos の設定がありません: ${missing.join(', ')}`);
  }
  const client = new CosmosClient({
    endpoint: setting('COSMOS_DB_ENDPOINT'),
    key: setting('COSMOS_DB_KEY'),
  });
  return client.database(setting('COSMOS_DB_DATABASE')).container(setting('COSMOS_DB_ALBUM_CONTAINER'));
}
