/**
 * 図鑑の種類の定義表（docs/04_data_design.md §3.2）
 *
 * 種類を足すときは、この表に1行足す。分類 AI の選択肢（段階3）と、識別 AI のスキーマ・
 * `GET /api/catalog/kinds`（段階4）がこの表から追従する。段階3で使うのはキー（分類の選択肢）だけで、
 * `namingRule` と `fields` は段階4の識別で使う
 */
export const CATALOG_KINDS = {
  plant: {
    label: '植物',
    inCatalog: true,
    autoIdentify: true,
    // 種の和名に揃える（品種名にすると、同じ種が品種ごとに別の項目に分かれる。02 §5 #56）
    namingRule: '種の和名（例: ハナトリカブト）。種まで特定できなければ「〇〇属の一種」（例: トリカブト属の一種）とし、信頼度を低くする',
    fields: [
      { key: 'scientificName', label: '学名', type: 'string', prompt: '学名。特定できない場合は null' },
      { key: 'genusName', label: '属', type: 'string', prompt: '属名（日本語。例: トリカブト属）。特定できない場合は null' },
      // 図鑑は属でまとめる。日本語の属名は揺れやすい（「トリカブト属」「トリカブト」）ので、まとめる鍵はラテン語の1語にする
      { key: 'genus', label: '属の学名', type: 'string', prompt: '属の学名（ラテン語の1語。例: Aconitum）。特定できない場合は null' },
      { key: 'familyName', label: '科名', type: 'string', prompt: '科名（日本語）。特定できない場合は null' },
    ],
  },
  food: {
    label: '食べ物',
    inCatalog: false,
    autoIdentify: false,
    // 2026-11-01: 細かい料理名（名物名）が外れることが多かったので、一般的な料理名を基本にし、固有の名前は根拠のあるときだけにした（02 §5 #60）
    namingRule: '一般的な料理名（例: 味噌ラーメン・海鮮丼）か、分からなければ料理の種類（例: ラーメン）。名物名や店の看板料理などの固有の名前は、利用者の手がかりや写真の中の文字（メニュー・看板など）で分かるときだけにし、見た目や撮影地だけで推し量らない',
    fields: [
      { key: 'genre', label: '料理のジャンル', type: 'string', prompt: '和食・中華・洋食など' },
      { key: 'mainIngredients', label: '主な食材', type: 'string[]', prompt: '主な食材を日本語で' },
    ],
  },
  landscape: {
    label: '風景',
    inCatalog: false,
    autoIdentify: false,
    namingRule: '固有名（函館山・金閣寺）→ 一般名 + 地域（〇〇の海岸）→ 場所の種類（海岸）の順に、分かる最も細かい粒度',
    fields: [
      { key: 'placeType', label: '場所の種類', type: 'string', prompt: '山・海・寺社・街並みなど' },
      { key: 'placeName', label: '場所の名前', type: 'string', prompt: '固有名。特定できない場合は null' },
      { key: 'region', label: '地域', type: 'string', prompt: '都道府県や国など' },
    ],
  },
} as const;

/** 図鑑に載せる種類 */
export type CatalogKind = keyof typeof CATALOG_KINDS;

/** どの種類にも当てはまらない写真の分類（図鑑には載せない） */
export const OTHER_KIND = 'other';

/** 分類 AI が選ぶ種類（写真の `category` に入る値） */
export type PhotoKind = CatalogKind | typeof OTHER_KIND;

/** 写真の `category` に入りうる値の一覧（定義表の種類と other） */
export const PHOTO_KINDS: readonly string[] = [...Object.keys(CATALOG_KINDS), OTHER_KIND];

/** 写真の `category` に入りうる値（[PHOTO_KINDS] のどれか）か。大文字小文字も区別する */
export function isPhotoKind(value: unknown): value is PhotoKind {
  return typeof value === 'string' && PHOTO_KINDS.includes(value);
}

/**
 * 分類の後に自動で詳しく識別する種類か（02 §5 #51。植物だけ。ほかの種類は利用者がやり直しで頼んだときだけ識別する）
 */
export function identifiesAutomatically(kind: unknown): boolean {
  return isCatalogKind(kind) && CATALOG_KINDS[kind].autoIdentify;
}

/**
 * 図鑑に載せる種類か（02 §5 #51。植物だけ。食べ物・風景は識別はできるが図鑑には載せない）
 */
export function isListedInCatalog(kind: unknown): boolean {
  return isCatalogKind(kind) && CATALOG_KINDS[kind].inCatalog;
}

/**
 * 図鑑の種類（定義表のキー）か
 *
 * `in` は継承したキー（constructor など）にも真になるので、自分のキーだけを見る
 */
export function isCatalogKind(value: unknown): value is CatalogKind {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CATALOG_KINDS, value);
}
