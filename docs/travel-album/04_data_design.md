# 旅行アルバム データ設計

## この文書の位置づけ

旅行アルバムの Cosmos DB と Blob Storage のデータの形、クエリ、無料枠と RU の見積もりを書く。
書き方は [docs/04_database_design.md](../04_database_design.md)（実装の写し）に合わせる。**未実装を含む目指す姿**で、
実装した部分はそのときに `docs/04_database_design.md` へ取り込む。

API から見た形（応答に出す項目・SAS 付き URL）は [05_api_design.md](./05_api_design.md)、裏の処理が書き込む項目の遷移は
[06_processing_design.md](./06_processing_design.md)、Terraform の定義は [07_infrastructure_design.md](./07_infrastructure_design.md) を参照する。
設計判断の比較は [02_design_overview.md §4](./02_design_overview.md#4-主な設計判断とその理由)。

---

## 1. Cosmos DB

### 1.1 コンテナ構成

| 項目 | 値 | 根拠 |
|---|---|---|
| データベース | `snaplant-db`（既存） | `infrastructure/main.tf` 99〜103行 |
| コンテナ | **`album`**（新設）。既存の `plants` は段階4まで並存 | 要件 5.8 |
| パーティションキー | `/id` | 写真が旅行をまたいで移動するため（[02 §4.1](./02_design_overview.md#41-album-を1コンテナ追加しpk-は-id写真の-id-は中身の-sha-256要件-51152)） |
| スループット | `var.cosmos_db_throughput`（400 RU/s）。専用 | `plants` と同じ形。無料枠は §6 |
| 一意キー | 無し | PK `/id` では意味が無い。id を決定的に作って `create` の 409 で代替する |
| インデックス | 既定（`/*`） | `plants` と同じ。絞り込みは `type`・`tripId`・`tags`・`entryId`・`kind` で、どれも `/*` に含まれる |
| TTL | 無し | 削除は明示的に行う |

ドキュメントは `type` で区別する。

| `type` | 中身 | 段階 | id の決め方 |
|---|---|---|---|
| `trip` | 旅行 | 2 | UUID v4（サーバが `uuid` パッケージで振る） |
| `photo` | 写真 | 2 | 画像バイト列の SHA-256（16進・小文字 64 文字。クライアントが計算し、サーバが照合する） |
| `entry` | 図鑑の項目 | 4 | `"<kind>-" + sha256(name.trim())` |
| `geocache` | 丸めた座標ごとの地名（Azure Maps を入れる場合だけ） | 3・任意 | `"geo-" + "<緯度3桁>_<経度3桁>"` |

単一ドキュメントの操作は `container.item(id, id)` と id を2回渡す（`plants` と同じ）。
**type の違うドキュメントが同じ id を持つことは無い**（UUID・64文字の16進・接頭辞付きで形が違う）。

### 1.2 旅行（`type: "trip"`）

```json
{
  "id": "123e4567-e89b-42d3-a456-426614174000",
  "type": "trip",
  "name": "北海道 2026秋",
  "description": null,
  "tags": [],
  "createdAt": "2026-10-04T09:00:00.000Z",
  "updatedAt": "2026-10-04T09:00:00.000Z"
}
```

| 項目 | 型 | 必須 | 説明 |
|---|---|---|---|
| `id` | string (UUID) | ○ | サーバが振る |
| `type` | `"trip"` | ○ | 固定 |
| `name` | string | ○ | 旅行名。前後の空白を除いて保存。1〜100 文字（`TRIP_NAME_MAX_LENGTH`） |
| `description` | string \| null | ○（null 可） | メモ。1000 文字まで（`TRIP_DESCRIPTION_MAX_LENGTH`）。無ければ `null` を明示 |
| `tags` | string[] | ○ | 利用者のタグ（§2）。段階2は常に `[]` |
| `createdAt` / `updatedAt` | string (ISO 8601, UTC) | ○ | サーバが付ける。作成時は同じ値 |

枚数・撮影期間・表紙は**保存しない**。写真から導く（§5.1）。カウンタを持つと同時更新で狂い、move のたびに2つの旅行を更新することになる。

### 1.3 写真（`type: "photo"`）

```json
{
  "id": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "type": "photo",
  "tripId": null,
  "blobName": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08.jpg",
  "thumbnailBlobName": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08.thumb.jpg",
  "contentType": "image/jpeg",
  "fileSize": 1234567,
  "takenAt": "2026-10-05T12:30:15",
  "takenAtSource": "exif",
  "location": {
    "latitude": 43.7706,
    "longitude": 142.3650,
    "placeName": "北海道旭川市",
    "placeSource": "device"
  },
  "tags": [],
  "comment": null,
  "commentSource": null,
  "hint": null,
  "classification": null,
  "identification": null,
  "entryId": null,
  "processing": { "state": "none", "attempts": 0, "lastError": null, "updatedAt": null },
  "uploadedAt": "2026-10-10T03:12:45.000Z",
  "updatedAt": "2026-10-10T03:12:45.000Z"
}
```

| 項目 | 型 | 必須 | 段階 | 説明 |
|---|---|---|---|---|
| `id` | string (SHA-256 hex 64, 小文字) | ○ | 2 | 画像の中身から決まる。同じ中身は1枚（要件 5.2） |
| `type` | `"photo"` | ○ | 2 | 固定 |
| `tripId` | string (UUID) \| null | ○（null 可） | 2 | 属する旅行。**どの旅行にも属さないときは `null` を必ず書く**（欠けていると `IS_NULL(c.tripId)` が偽になり一覧から消える） |
| `blobName` | string | ○ | 2 | `photos` コンテナの Blob 名。`<id>` + 検証済み Content-Type から引いた拡張子 |
| `thumbnailBlobName` | string \| null | ○（null 可） | 2 | サムネイルの Blob 名 `<id>.thumb.jpg`。クライアントが送らなければ `null` |
| `contentType` | string | ○ | 2 | 原寸の Content-Type（`FILE_UPLOAD.SUPPORTED_IMAGE_TYPES` のいずれか） |
| `fileSize` | number | ○ | 2 | 原寸のバイト数 |
| `takenAt` | string \| null | ○（null 可） | 2 | 撮影日時。**タイムゾーン無し**の `YYYY-MM-DDTHH:mm:ss`。EXIF に無ければ `null`。`Z` を付けない（付けると Flutter の `toLocal()` で9時間ずれる。#23 と同型） |
| `takenAtSource` | `"exif"` \| `"none"` | ○ | 2 | 撮影日時の出どころ。段階2はサーバが `takenAt` の有無から入れる。段階6で出どころが増えたら値を足す |
| `location` | object \| null | ○（null 可） | 2 | 位置情報。無ければ `null`（要件 5.2「位置情報は必須にしない」） |
| `location.latitude` / `longitude` | number | ○ | 2 | 緯度（-90〜90）・経度（-180〜180） |
| `location.placeName` | string \| null | ○（null 可） | 2 | 地名（市区町村など）。1〜100 文字（`PHOTO_PLACE_NAME_MAX_LENGTH`） |
| `location.placeSource` | `"device"` \| `"server"` \| null | ○（null 可） | 2 | 地名の出どころ。段階2は `"device"`（端末の Geocoder）か `null`。段階3で Azure Maps が埋めたら `"server"` |
| `tags` | string[] | ○ | 2 | §2。段階2は `[]`。段階3で `category:<kind>` が1つ入る |
| `comment` | string \| null | ○（null 可） | 2（値は4） | 一言コメント。500 文字まで（`PHOTO_COMMENT_MAX_LENGTH`） |
| `commentSource` | `"ai"` \| `"user"` \| null | ○（null 可） | 2（値は4） | コメントの出どころ |
| `hint` | string \| null | ○（null 可） | 2（値は3） | 最後のやり直しで利用者が渡した手がかり。500 文字まで（`CONTEXT_INFO_VALIDATION`） |
| `classification` | object \| null | ○（null 可） | 3 | `{ kind, confidence, model, at }`。[06 §2](./06_processing_design.md#2-分類段階3) |
| `identification` | object \| null | ○（null 可） | 4 | `{ matchesKind, name, confidence, model, at, reason? }`。[06 §3](./06_processing_design.md#3-識別段階4) |
| `entryId` | string \| null | ○（null 可） | 4 | 図鑑の項目の id。「種類ごとの1件に写真が複数」はこの項目で表す（要件 5.5） |
| `processing` | object | ○ | 2（値は3） | `{ state, attempts, lastError, updatedAt }`。`state` は `none` / `pending` / `classifying` / `identifying` / `done` / `failed`。段階2は `none` 固定 |
| `uploadedAt` / `updatedAt` | string (ISO 8601, UTC) | ○ | 2 | サーバが付ける |

段階2から**全項目を書く**（段階3・4で使う項目も `null` で）。項目が無いドキュメントと `null` のドキュメントは Cosmos SQL で振る舞いが違う
（`IS_NULL` は欠損で偽、`IS_DEFINED` は null で真）ので、後から項目を足すときに「無い」を2通り扱わずに済むようにする。

Blob 名に旅行の id を含めない。旅行への出し入れで Blob を触らないため。

### 1.4 図鑑の項目（`type: "entry"`、段階4）

§3。

### 1.5 地名のキャッシュ（`type: "geocache"`、段階3・任意）

Azure Maps を入れる場合だけ。`{ "id": "geo-43.771_142.365", "type": "geocache", "placeName": "北海道旭川市", "createdAt": "..." }`。
丸めた座標（小数3桁 ≒ 100 m）ごとに1件。TTL は付けない（地名は変わらない）。

## 2. タグの規約

旅行・写真の両方に `tags: string[]`。規約は `api/src/constants/tags.ts` に1か所で定義する。

| 種類 | 形 | 付ける主体 | 例 |
|---|---|---|---|
| カテゴリ | `category:<kind>`。`<kind>` は `CATALOG_KINDS` のキー（§3）または `other` | 分類 AI（段階3）。**写真にちょうど1つ**。旅行には付かない | `category:plant`、`category:other` |
| 利用者のタグ | `:` を含まない 1〜30 文字（`TAG_MAX_LENGTH`）。前後の空白を除く | 利用者（`PATCH /api/photos/{photoId}`。画面は後の段階） | `favorite`、`お気に入り` |

- `PATCH` で `category:` を含むタグを送ると 400（[05 §5.6](./05_api_design.md#56-patch-apiphotosphotoid)）。`tags` を置き換えるとき、サーバは `category:` のタグを残して結合する
- 再分類は `category:` で始まるものだけ入れ替え、利用者のタグには触らない
- 分類の確信度やモデル名は `classification` に別に持つ。タグは「横断して見るための索引」、`classification` は「根拠」
- 重複は保存前に除く。並び順は保存順（`category:` が先頭とは限らない）

`tags.ts` の中身（予定）:

```ts
export const CATEGORY_TAG_PREFIX = 'category:';
export const OTHER_KIND = 'other';
export function categoryTag(kind: string): string { return `${CATEGORY_TAG_PREFIX}${kind}`; }
export function isCategoryTag(tag: string): boolean { return tag.startsWith(CATEGORY_TAG_PREFIX); }
```

## 3. 図鑑の項目と定義表（段階4）

### 3.1 項目（`type: "entry"`）

```json
{
  "id": "plant-5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8",
  "type": "entry",
  "kind": "plant",
  "name": "ソメイヨシノ",
  "description": "日本で最も広く植えられているサクラの栽培品種。",
  "characteristics": "淡い桃色の花を葉より先に咲かせる",
  "confidence": 92,
  "attributes": { "scientificName": "Prunus × yedoensis", "familyName": "バラ科" },
  "tags": [],
  "createdAt": "2026-10-10T03:20:00.000Z",
  "updatedAt": "2026-10-10T03:20:00.000Z"
}
```

| 項目 | 型 | 必須 | 説明 |
|---|---|---|---|
| `id` | string | ○ | `"<kind>-" + sha256(name.trim())`（16進・小文字）。同じ種類・同じ名前は1件（要件 5.5「当面は名前の完全一致」） |
| `type` | `"entry"` | ○ | 固定 |
| `kind` | string | ○ | `CATALOG_KINDS` のキー（`plant` / `food` / `landscape`） |
| `name` | string | ○ | 名前。`trim()` だけ（NFKC は当面入れない。[02 §5](./02_design_overview.md#5-人間に決めてもらう点推奨付き) #7）。1〜100 文字 |
| `description` | string \| null | ○（null 可） | 説明 |
| `characteristics` | string \| null | ○（null 可） | 特徴（一言。要件 5.5 の共通項目） |
| `confidence` | number | ○ | 0〜100。この項目に付いた識別のうち最も高いもの |
| `attributes` | object | ○ | 種類ごとの項目の「名前と値の組の入れ物」。キーは定義表の `fields[].key`。無い項目はアプリが「—」で出す |
| `tags` | string[] | ○ | 利用者のタグ（構造だけ） |
| `createdAt` / `updatedAt` | string | ○ | サーバが付ける |

- 写真が複数ぶら下がる形は写真側の `entryId` で表す。`photoCount` は持たず、写真を数えて導く（§5.6）
- `description`・`characteristics`・`attributes`・`confidence` は、その項目に付いた識別のうち**信頼度が最も高いもの**で更新する（[02 §5](./02_design_overview.md#5-人間に決めてもらう点推奨付き) #8）。写真ごとの一言は写真の `comment`
- 写真を消して項目の写真が 0 枚になったら項目も消す（ベストエフォート。失敗はログだけ）
- 名前の揺れ（「ソメイヨシノ」と「サクラ」）を揃える機能を後で足すときは、id が名前から決まるので「新しい項目に写真を付け替え → 古い項目を消す」になる。
  揃える作業は本質的に併合なので、別コンテナ案でも付け替えは要る

### 3.2 定義表 `CATALOG_KINDS`（`api/src/catalog/kinds.ts`）

```ts
export const CATALOG_KINDS = {
  plant: {
    label: '植物',
    namingRule: '品種名が分かれば品種名、品種名は分からないが種名が分かれば種名、種名も特定できなければ属名',
    // openAIVisionService.ts 157〜161行の文言を移す
    fields: [
      { key: 'scientificName', label: '学名', type: 'string', prompt: '学名。特定できない場合は null' },
      { key: 'familyName',     label: '科名', type: 'string', prompt: '科名（日本語）。特定できない場合は null' },
    ],
  },
  food: {
    label: '食べ物',
    namingRule: '固有の料理名（名物名・店の看板料理）→ 一般的な料理名 → 料理の種類の順に、分かる最も細かい粒度（例: 札幌味噌ラーメン → 味噌ラーメン → ラーメン）',
    fields: [
      { key: 'genre',           label: '料理のジャンル', type: 'string',   prompt: '和食・中華・洋食など' },
      { key: 'mainIngredients', label: '主な食材',       type: 'string[]', prompt: '主な食材を日本語で' },
    ],
  },
  landscape: {
    label: '風景',
    namingRule: '固有名（函館山・金閣寺）→ 一般名 + 地域（〇〇の海岸）→ 場所の種類（海岸）の順に、分かる最も細かい粒度',
    fields: [
      { key: 'placeType', label: '場所の種類', type: 'string', prompt: '山・海・寺社・街並みなど' },
      { key: 'placeName', label: '場所の名前', type: 'string', prompt: '固有名。特定できない場合は null' },
      { key: 'region',    label: '地域',       type: 'string', prompt: '都道府県や国など' },
    ],
  },
} as const;
```

`type` は `'string' | 'string[]'` の2つから始める。数値が要る項目（標高など）が出たら `'number'` を足す。

この表から追従するもの:

| 追従先 | どう使うか | 段階 |
|---|---|---|
| 分類 AI の選択肢 | `Object.keys(CATALOG_KINDS)` + `'other'` を Structured Outputs の `enum` にする | 3 |
| 識別 AI のスキーマ | 共通項目（`matchesKind`・`name`・`description`・`characteristics`・`comment`・`confidence`）+ `attributes` を `fields` から組み立てる。strict の制約により全部 `required`、任意は `["string","null"]`（`string[]` は `["array","null"]`）。`prompt` は `description` に、`namingRule` はプロンプト本文に | 4 |
| 識別結果の検証 | `confidence` の 0〜100 と、`attributes` のキーが `fields` にあるものだけか | 4 |
| `GET /api/catalog/kinds` | `{ kinds: [{ kind, label, fields: [{ key, label, type }] }] }`。`prompt`・`namingRule` は返さない | 4 |
| Flutter | 起動時に取得して保持。項目詳細は `fields` を順に回して `attributes[key]` を出す（無ければ「—」）。種類タブも `kinds` から作る | 4 |
| `PATCH` の検証 | 段階4では `attributes` を利用者が直す機能は入れない。入れるときは `fields` の `type` で検証 | — |

種類を足す手順: 表に1行足す → 分類の選択肢・識別のスキーマ・`GET /api/catalog/kinds` が追従 → アプリは再ビルド不要（タブと項目はサーバから）。
種類ごとのアイコンや色など見た目を足すならアプリの更新が要る。

## 4. Blob Storage

### 4.1 コンテナ

| コンテナ | 公開範囲 | 用途 | 段階 |
|---|---|---|---|
| `photos`（新設） | `private` | 写真の原寸とサムネイル。読み取りは Blob 単位の SAS（[05 §6](./05_api_design.md#6-sas-付き-url)） | 2 |
| `images`（既存） | `blob`（公開） | 植物図鑑の画像。段階4で廃止 | — |
| `temp-images`（既存） | `private` | `upload` の一時保存。段階2でライフサイクル（1日で削除）を足す。段階4で廃止 | — |

コンテナ名は環境変数 `PHOTO_STORAGE_CONTAINER_NAME` から取る（`'photos'` はコードのフォールバック。Terraform が作るのも `photos`）。

### 4.2 Blob 名

| Blob | 名前 | Content-Type | 上限 |
|---|---|---|---|
| 原寸 | `<photoId><拡張子>`。拡張子は検証済みの Content-Type から `FILE_UPLOAD.EXTENSION_BY_CONTENT_TYPE` で引く（クライアントのファイル名は使わない。既存と同じ理由） | 送られたもの | `MAX_FILE_SIZE`（10MB） |
| サムネイル | `<photoId>.thumb.jpg` | `image/jpeg` 固定 | `THUMBNAIL_MAX_SIZE`（1MB） |

- 名前が `photoId` から決まるので、**同じ写真の再送は同じ Blob への上書き**（冪等）。孤児が残りうるのは「ドキュメント作成前にアプリが落ちた Blob」だけで、
  名前から機械的に見つけられる（`photos` の Blob 名の先頭 64 文字が `album` に無いもの）
- 平坦な名前にする（旅行ごとの仮想ディレクトリを作らない）。出し入れで Blob を触らないため
- サムネイルはクライアントが作って送る（長辺 320px・画質 70）。サーバで作ると画像処理の依存（sharp など）が Functions に乗り、コールドスタートが伸びる。
  サムネイルは任意扱いで、無ければ `thumbnailBlobName: null`（一覧は原寸を縮小表示する）

### 4.3 削除

- 写真の削除: ドキュメントを消してから原寸とサムネイルを消す。Blob の削除の失敗はログだけで、ドキュメント操作は成功扱い（`plants` と同じ方針）。404 は成功とみなす
- 旅行の削除: 中の写真を1枚ずつ上の手順で消し、最後に旅行を消す
- URL の検証による二層防御は要らない。削除する Blob 名はドキュメントの `blobName` / `thumbnailBlobName` から取り、クライアントから URL を受け取らない

## 5. クエリ

**偽物（`tests/fakes/cosmos.ts`）は Cosmos SQL を解釈しない。** WHERE 句・ORDER BY・射影は偽物で検証できないため、
下の表で「手で確認」の印が付いたものは、デプロイ後に手で確かめる（[08 §5](./08_test_plan.md#5-偽物で確かめられず手で確かめる項目)）。
サービスは絞り込みの値を**必ずパラメータ**で渡す（偽物はパラメータの値で絞る）。

| # | 画面・処理 | クエリ | 偽物で検証 | 手で確認 |
|---|---|---|---|---|
| 5.1 | 旅行一覧（集計） | 写真の射影 + サーバで集計 | 集計は○ | 射影 |
| 5.2 | 旅行一覧（旅行） | `SELECT * FROM c WHERE c.type = @type ORDER BY c.createdAt DESC` | `@type` の絞り込みのみ | 並び順 |
| 5.3 | 旅行の写真一覧・未所属 | `WHERE c.type = @type AND ((IS_NULL(@tripId) AND IS_NULL(c.tripId)) OR c.tripId = @tripId)` | `@tripId` の値（null 含む）で絞る | `IS_NULL` の挙動 |
| 5.4 | タグ横断（段階3） | `WHERE c.type = @type AND ARRAY_CONTAINS(c.tags, @tag)` | `@tag` で絞る | `ARRAY_CONTAINS` |
| 5.5 | タグ一覧（段階3） | `SELECT DISTINCT VALUE t FROM c JOIN t IN c.tags WHERE c.type = @type` | × | 全部 |
| 5.6 | 図鑑の項目一覧（段階4） | 項目: `WHERE c.type = @type AND c.kind = @kind`。枚数: 写真の `entryId` の射影をサーバで数える | `@kind`・`@entryId` で絞る | 射影 |
| 5.7 | 項目の写真（段階4） | `WHERE c.type = @type AND c.entryId = @entryId` | `@entryId` で絞る | — |
| 5.8 | 再投入のタイマー（段階3） | `WHERE c.type = @type AND c.processing.state IN ('pending','classifying','identifying') AND c.processing.updatedAt < @before` | × | 全部 |

### 5.1 旅行一覧

旅行ごとの枚数・撮影期間・表紙を1クエリの射影から**サーバの中で集計する**。

```sql
SELECT c.id, c.tripId, c.takenAt, c.uploadedAt, c.thumbnailBlobName, c.blobName
FROM c WHERE c.type = @type
```

`@type = 'photo'`。旅行ごとに `photoCount`（件数）、`firstTakenAt` / `lastTakenAt`（`takenAt` が null でないものの最小・最大）、
表紙（§5.3 の並びで先頭の写真の `thumbnailBlobName`、無ければ `blobName`）を導く。未所属（`tripId: null`）の件数も同じ結果から出せる。

代案は `SELECT c.tripId, COUNT(1) AS photoCount, MIN(c.takenAt) ..., MAX(c.takenAt) ... FROM c WHERE c.type = 'photo' GROUP BY c.tripId`。
RU は少ないが、表紙が取れず別クエリが要り、偽物で集計を検証できない。写真が数千枚になって射影の RU が気になったら切り替える（§6）。

### 5.2 旅行の詳細

`container.item(tripId, tripId).read()`。無ければ `resource` が無い応答（`plants` と同じ。`resource || null`）。
集計は §5.1 と同じ射影を `tripId` で絞って行う（`WHERE c.type = @type AND c.tripId = @tripId`）。

### 5.3 旅行の写真一覧

```sql
SELECT * FROM c
WHERE c.type = @type
  AND ((IS_NULL(@tripId) AND IS_NULL(c.tripId)) OR c.tripId = @tripId)
```

`@tripId` は旅行の id か `null`。`c.tripId = null` は Cosmos SQL では偽になるので `IS_NULL` を使う。
SQL を旅行あり・未所属で分けないのは、偽物がパラメータの値で分岐を検証できるようにするため（パラメータへの `IS_NULL` が使えるかは**要確認**。
使えなければ SQL を2本にし、偽物は `@tripId` の有無で分ける）。

**並び順はサーバの中で付ける。** `takenAt` 昇順、`takenAt` が null のものは末尾、同値は `uploadedAt` 昇順、さらに同値は `id` 昇順。
Cosmos の `ORDER BY c.takenAt ASC` は null を先頭に置き、項目が無いドキュメントを結果から**外す**（推測。要確認）ため、
「null は末尾」を SQL で書くと2クエリになる。1旅行数百枚（要件 §2）ならメモリで並べて困らず、偽物で並び順を検証できる。
ページングは段階2では入れない（タグ横断で件数が増える段階3で継続トークンを検討する）。

`SELECT *` には Cosmos のシステム項目（`_rid` など）が含まれるので、応答に出す項目はサービスが詰め替える（[05 §3](./05_api_design.md#3-データモデル)）。

### 5.4 旅行への出し入れ（move）

```ts
await container.item(photoId, photoId).patch({
  operations: [
    { op: 'set', path: '/tripId', value: tripId },      // 旅行の id か null
    { op: 'set', path: '/updatedAt', value: now }
  ]
});
```

read-then-replace ではなく Patch にする。同時に PATCH（コメント）が来ても、互いの項目を上書きしない。
存在しない id への patch は 404 の例外になり、呼び出し側は `notFound` に入れる。

### 5.5 写真の作成（冪等）

1. `container.item(photoId, photoId).read()` → あれば既存を返す
2. Blob を上書きアップロード（原寸 → サムネイル）
3. `container.items.create(photo)` → 409（1 と 3 の間に並行リクエストが作った）なら既存を読んで返す

Blob を先、ドキュメントを後。逆だと「壊れた表示の写真」が一覧に出る。詳細は [05 §5.1](./05_api_design.md#51-post-apiphotos)。

### 5.6 図鑑の項目の併合（段階4）

`entryId = "<kind>-" + sha256(name.trim())` で `create` → 409 なら既存を読み、新しい識別の信頼度が高ければ `_etag` 条件付きで `replace`（412 なら読み直して再試行、最大 3 回）→ 写真を `patch`（`identification`・`entryId`・`comment`・`commentSource`）。

### 5.7 その他の単一ドキュメント操作

| 操作 | SDK |
|---|---|
| 旅行の作成 | `items.create(trip)` |
| 旅行の更新 | `item(id, id).replace({ ...existing, name, description, updatedAt })` |
| 旅行の削除 | 写真を1枚ずつ `item(id, id).delete()` + Blob 削除 → `item(tripId, tripId).delete()` |
| 写真の削除 | `item(id, id).delete()` → Blob 削除（失敗はログ） |
| コメント・タグの更新 | `item(id, id).patch([{ op: 'set', path: '/comment', ... }, ...])` |
| 処理状態の更新（段階3） | `item(id, id).patch([{ op: 'set', path: '/processing', ... }])` |

## 6. 無料枠と RU の見積もり

### 6.1 無料枠

`infrastructure/main.tf` 92行のコメントは「400 RU/s + 25GB」だが、Cosmos DB の無料枠は**アカウントで最初の 1000 RU/s と 25 GB**だと思われる（推測。**人間がポータルで確認する**）。

| 時期 | コンテナ | 合計 RU/s | 枠内か |
|---|---|---|---|
| 段階2〜4の移行前 | `plants` 400 + `album` 400 | 800 | 1000 なら枠内。400 なら超過（月数百円程度の推測） |
| 段階4の移行後 | `album` 400 | 400 | 枠内 |

`catalog` を別コンテナにすると移行中に 1200 になり枠を超えうるのが、`album` 1コンテナにした理由の1つ。
データベース共有スループットへの変更は作り直しになる（推測）ので採らない。

### 6.2 RU の見積もり（推測。実測して `docs/09_backlog.md` に記録する）

| 操作 | 想定 RU | 頻度 | 備考 |
|---|---|---|---|
| 写真の作成（read 1 + create 1） | 約 1 + 10 | 1枚ごと | ドキュメント約 2 KB。300 枚で約 3,300 RU。同時 2 本なら数十秒に分散 |
| 旅行の写真一覧（`SELECT *` 300 件） | 約 100〜300 | 画面を開くたび | 横断クエリ。個人規模では物理パーティションは1つ（推測） |
| 旅行一覧の射影（全写真 3,000 件） | 約 100〜500 | 画面を開くたび | 射影は小さい。数万枚になったら `GROUP BY` に切り替える |
| move（patch 1 件） | 約 10 | 1枚ごと | 300 枚で約 3,000 RU。**400 RU/s を数秒超えるので SDK の再試行（429）が入る。関数の 5 分に収まるかは要実測**（[02 §6](./02_design_overview.md#6-リスク)） |
| 旅行の削除（300 枚） | 約 3,000 + 一覧の読み取り | まれ | 同上 |

ストレージ: 写真 1 枚あたり原寸 1〜3 MB + サムネイル 30 KB。25 GB なら 1 万枚前後（Blob は Cosmos の枠とは別で、Blob は従量課金）。
