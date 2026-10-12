# 旅行アルバム データ設計

## この文書の位置づけ

旅行アルバムの Cosmos DB と Blob Storage のデータの形、クエリ、無料枠と RU の見積もりを書く。
書き方は [docs/04_database_design.md](../04_database_design.md)（実装の写し）に合わせる。**未実装を含む目指す姿**で、
実装した部分は `docs/04_database_design.md` へ取り込む（開発中はこの一式を正として都度直し、取り込みは機能が固まってから後でまとめて行う。2026-10-12 に人間が決定）。

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
| インデックス | 既定（`/*`）。段階4で複合インデックス（`/identification/confidence` 降順, `/identification/at` 降順）を足す | `plants` と同じ。絞り込みは `type`・`tripId`・`tags`・`identification.kind`・`identification.name`・`processing.state` で、どれも `/*` に含まれる。`ORDER BY c.sortAt`（§5.3）は単一項目なので既定のインデックスで引ける。2項目の `ORDER BY`（図鑑の見出しの写真。§5.6）だけ複合インデックスが要る（[07 §3](./07_infrastructure_design.md#3-段階4)） |
| TTL | 無し | 削除は明示的に行う |

ドキュメントは `type` で区別する。

| `type` | 中身 | 段階 | id の決め方 |
|---|---|---|---|
| `trip` | 旅行 | 2 | UUID v4（サーバが `uuid` パッケージで振る） |
| `photo` | 写真 | 2 | 画像バイト列の SHA-256（16進・小文字 64 文字。クライアントが計算し、サーバが照合する） |
| `geocache` | 丸めた座標ごとの地名（Azure Maps を入れる場合だけ） | 3・任意 | `"geo-" + "<緯度3桁>_<経度3桁>"` |

**図鑑の項目は文書として持たない**（2026-10-12 に人間が決定。[02 §5](./02_design_overview.md#5-人間に決めてもらう点推奨付き) #18 の案 B）。
識別の結果は写真の `identification` の中にだけ置き、図鑑は写真からまとめる（§3）。

単一ドキュメントの操作は `container.item(id, id)` と id を2回渡す（`plants` と同じ）。
**type の違うドキュメントが同じ id を持つことは無い**（UUID・64文字の16進・接頭辞付きで形が違う）。
別パーティションの文書をまとめて原子的に書くことはできない（PK が `/id` なので文書ごとに別パーティション）。
複数の文書や Blob にまたがる操作が途中で止まったときに何が残るかは §7。

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

枚数・撮影期間・表紙は**保存しない**。写真から導く（§5.1。枚数と期間は `GROUP BY` の集計、表紙は旅行ごとの `TOP 1`。写真を全部読まない）。
カウンタを持つと同時更新で狂い、move のたびに2つの旅行を更新することになる。

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
  "sortAt": "2026-10-05T12:30:15",
  "location": {
    "latitude": 43.7706,
    "longitude": 142.3650,
    "placeName": "北海道旭川市",
    "placeSource": "device"
  },
  "category": null,
  "tags": [],
  "comment": null,
  "commentSource": null,
  "hint": null,
  "classification": null,
  "identification": null,
  "processing": { "state": "none", "step": null, "attempts": 0, "lastError": null, "updatedAt": null },
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
| `sortAt` | string | ○ | 2 | **並べ替え用の日時。** `takenAt` と同じ TZ 無しの `YYYY-MM-DDTHH:mm:ss`。`takenAt` があればその値、無ければ `uploadedAt` を日本時間（UTC+9）に直して TZ を外した文字列（下の説明）。サーバが作成時に必ず入れ、`null` にはならない。一覧は `ORDER BY c.sortAt` で並べる（§5.3） |
| `location` | object \| null | ○（null 可） | 2 | 位置情報。無ければ `null`（要件 5.2「位置情報は必須にしない」） |
| `location.latitude` / `longitude` | number | ○ | 2 | 緯度（-90〜90）・経度（-180〜180） |
| `location.placeName` | string \| null | ○（null 可） | 2 | 地名（市区町村など）。1〜100 文字（`PHOTO_PLACE_NAME_MAX_LENGTH`） |
| `location.placeSource` | `"device"` \| `"server"` \| null | ○（null 可） | 2 | 地名の出どころ。段階2は `"device"`（端末の Geocoder）か `null`。段階3で Azure Maps が埋めたら `"server"` |
| `category` | string \| null | ○（null 可） | 2（値は3） | AI が付けた大分類（要件 5.4）。`CATALOG_KINDS` のキー（`plant` / `food` / `landscape`）か `other`。分類前は `null`。**専用の欄にする**（2026-10-12 に人間が決定。タグに `category:` 接頭辞で混ぜない）。分類のワーカーだけが書く。横断は `c.category = @category`（§5 の 5.4） |
| `tags` | string[] | ○ | 2 | 利用者が付けるタグだけ（§2）。段階2は `[]`。AI は書かない |
| `comment` | string \| null | ○（null 可） | 2（値は4） | 一言コメント。500 文字まで（`PHOTO_COMMENT_MAX_LENGTH`） |
| `commentSource` | `"ai"` \| `"user"` \| null | ○（null 可） | 2（値は4） | コメントの出どころ |
| `hint` | string \| null | ○（null 可） | 2（値は3） | 最後のやり直しで利用者が渡した手がかり。500 文字まで（`CONTEXT_INFO_VALIDATION`） |
| `classification` | object \| null | ○（null 可） | 3 | `{ kind, confidence, model, at }`。[06 §2](./06_processing_design.md#2-分類段階3) |
| `identification` | object \| null | ○（null 可） | 4 | `{ kind, matchesKind, name, confidence, description, characteristics, attributes, reason, model, at }`（§3.1）。**図鑑はこの項目からまとめる**。「種類ごとの1件に写真が複数」（要件 5.5）は `identification.kind` と `identification.name` が同じ写真の集まりとして表す。[06 §3](./06_processing_design.md#3-識別段階4) |
| `processing` | object | ○ | 2（値は3） | `{ state, step, attempts, lastError, updatedAt }`。`state` は `none` / `pending` / `classifying` / `identifying` / `done` / `failed`、`step` は `null` / `classify` / `identify`（次にやる、またはやっている処理。タイマーが再投入するときに見る。[06 §1.3](./06_processing_design.md#13-状態と失敗)）。段階2は `state: "none"`・`step: null` 固定 |
| `uploadedAt` / `updatedAt` | string (ISO 8601, UTC) | ○ | 2 | サーバが付ける |

段階2から**全項目を書く**（段階3・4で使う項目も `null` で）。項目が無いドキュメントと `null` のドキュメントは Cosmos SQL で振る舞いが違う
（`IS_NULL` は欠損で偽、`IS_DEFINED` は null で真）ので、後から項目を足すときに「無い」を2通り扱わずに済むようにする。

Blob 名に旅行の id を含めない。旅行への出し入れで Blob を触らないため。

#### `sortAt` の決め方（撮影日時が無い写真はアップロード日時を使う）

撮影日時順の一覧（要件 5.3）は Cosmos の `ORDER BY` とページングで少しずつ読む（§5.3）。そのために、**すべての写真が必ず持つ**並べ替え用の日時 `sortAt` を置く。

| `takenAt` | `sortAt` | 例 |
|---|---|---|
| ある | `takenAt` そのまま | `takenAt: "2026-10-05T12:30:15"` → `sortAt: "2026-10-05T12:30:15"` |
| 無い | `uploadedAt`（UTC）を UTC+9 にずらし、TZ の表記を外した `YYYY-MM-DDTHH:mm:ss` | `uploadedAt: "2026-10-10T03:12:45.000Z"` → `sortAt: "2026-10-10T12:12:45"` |

- `takenAt` は TZ 無しの「撮影した土地での時刻」、`uploadedAt` は UTC で、そのまま文字列で比べると最大 9 時間ずれる。
  利用者は日本在住で、国内の旅行では `takenAt` が日本時間なので、**`uploadedAt` を日本時間に直して揃える**（ずらす量はコードの定数 `SORT_AT_UTC_OFFSET_MINUTES = 540`。[07 §6](./07_infrastructure_design.md#6-設定値の一覧)）。
  海外の旅行では撮影地の時刻と日本時間が混ざるが、撮影日時の無い写真は「その旅行の中でアップロードした順の位置」に入れば足りる（撮影日時の無い写真どうしの順は揃う）
- `sortAt` は文字列として比べる（`YYYY-MM-DDTHH:mm:ss` は辞書順が時刻順と一致する）。同値の並びは Cosmos に任せる（固定したければ複合インデックス（`sortAt`, `id`）を足す。段階2では入れない）
- **`null` の扱いの問題が無くなる。** Cosmos の `ORDER BY` が null を先頭に置くか、項目が無いドキュメントを結果から外すか（推測）を気にせずに済む。`sortAt` は常に文字列で、欠けることが無い
- `takenAt` は `POST /api/photos` の後に変わらない（段階2〜4に `takenAt` を直す API は無い）ので、`sortAt` を作成時に1回決めれば食い違わない。
  段階6で出どころが増えて `takenAt` を後から直す API を足すなら、同じ patch で `sortAt` も書き直す
- 要件 5.2「撮影日時順に並べるときは末尾に置くなど」は、「撮影日時の無い写真はアップロード日時の位置に置く」で満たす。
  ふつうは旅行中の撮影日時よりアップロードが後なので、結果として末尾付近に並ぶ

### 1.4 図鑑の項目（段階4）

文書としては持たない。写真の `identification` からまとめる（§3）。

### 1.5 地名のキャッシュ（`type: "geocache"`、段階3・任意）

Azure Maps を入れる場合だけ。`{ "id": "geo-43.771_142.365", "type": "geocache", "placeName": "北海道旭川市", "createdAt": "..." }`。
丸めた座標（小数3桁 ≒ 100 m）ごとに1件。TTL は付けない（地名は変わらない）。

## 2. カテゴリとタグ

**カテゴリ（AI が付ける大分類）は写真の専用の欄 `category` に、タグ（`tags`）は利用者が付けるものだけにする**（2026-10-12 に人間が決定）。
以前の案（`tags` に `category:<kind>` の予約名を混ぜる）は採らない。書く主体が欄で分かれるので、ワーカーと利用者が同じ配列を編集し合う処理（接頭辞で選り分けて結合する）が要らない。

| 欄 | 形 | 付ける主体 | 例 |
|---|---|---|---|
| `category`（写真だけ） | `CATALOG_KINDS` のキー（§3）または `other`（`OTHER_KIND`。`api/src/catalog/kinds.ts`）。分類前は `null` | 分類 AI（段階3）。**写真にちょうど1つ** | `"food"`、`"other"` |
| `tags`（旅行・写真） | 1〜30 文字（`TAG_MAX_LENGTH`）の文字列の配列。前後の空白を除く。重複は保存前に除き、並びは保存順 | 利用者（`PATCH /api/photos/{photoId}`。画面は後の段階） | `favorite`、`お気に入り` |

- 分類の確信度やモデル名は `classification` に別に持つ。`category` は「横断して見るための索引」、`classification` は「根拠」
- 再分類は `category` を書き換えるだけで、`tags` には触らない
- 横断は `WHERE c.category = @category`（§5 の 5.4）。利用者のタグでの横断（`ARRAY_CONTAINS(c.tags, @tag)`）は、タグを付ける画面を入れる段階で足す

## 3. 図鑑の項目と定義表（段階4）

図鑑の項目は「種類（`kind`）ごとに、名前1つにつき1件」。`kind` は図鑑の種類で、今は `plant`（植物）・`food`（食べ物）・`landscape`（風景）の3つ。
種類の一覧は §3.2 の定義表 `CATALOG_KINDS` が持ち、表の1行が1種類になる。

**項目を文書としては持たない**（2026-10-12 に人間が決定。[02 §5](./02_design_overview.md#5-人間に決めてもらう点推奨付き) #18 の案 B。
持つ案との比較はそこに記録として残してある）。識別の結果は写真の `identification` の中にだけ置き、
図鑑の画面は写真を `identification.kind` と `identification.name` でまとめて作る。

### 3.1 項目は写真からまとめる

写真の `identification`（§1.3）。識別のワーカー（[06 §3](./06_processing_design.md#3-識別段階4)）が書く。

```json
"identification": {
  "kind": "plant",
  "matchesKind": true,
  "name": "ソメイヨシノ",
  "confidence": 92,
  "description": "日本で最も広く植えられているサクラの栽培品種。",
  "characteristics": "淡い桃色の花を葉より先に咲かせる",
  "attributes": { "scientificName": "Prunus × yedoensis", "familyName": "バラ科" },
  "reason": null,
  "model": "gpt-5.6-luna",
  "at": "2026-10-10T03:20:00.000Z"
}
```

| 項目 | 型 | 説明 |
|---|---|---|
| `kind` | string | 識別したときの種類（`CATALOG_KINDS` のキー）。写真の `category` と同じ値になるはずだが、分類のやり直しの途中では食い違いうるので、図鑑はこちらを見る |
| `matchesKind` | boolean | 分類どおりの種類が写っているか。`false` なら図鑑には出さない（`name` 以下は `null`、`reason` に理由） |
| `name` | string \| null | 名前。ワーカーが `trim()` して保存（NFKC は当面入れない。[02 §5](./02_design_overview.md#5-人間に決めてもらう点推奨付き) #7）。1〜100 文字 |
| `confidence` | number | 0〜100（要件 5.5） |
| `description` / `characteristics` | string \| null | 種類の説明と、見た目の特徴（一言。要件 5.5 の共通項目）。写真ごとの一言は写真の `comment` |
| `attributes` | object | 種類ごとの項目の「名前と値の組の入れ物」。キーは定義表の `fields[].key`。無い項目はアプリが「—」で出す |
| `reason` | string \| null | `matchesKind: false` のときの理由。`true` なら `null` |
| `model` / `at` | string | 使ったデプロイ名と日時 |

図鑑の項目は、この `identification` を持つ写真を `kind` と `name` でまとめたもの（要件 5.5「同じ種類で同じ名前のものは1件。当面は名前の完全一致」）。

| 項目の見出し | 導き方（クエリは §5.6） |
|---|---|
| 名前 | `identification.name`。`matchesKind: true` の写真だけを数える |
| 説明・特徴・属性・信頼度 | その名前の写真のうち **`identification.confidence` が最も高いもの**の値（[02 §5](./02_design_overview.md#5-人間に決めてもらう点推奨付き) #8）。同点なら `identification.at` が新しい方（新しいモデルの結果を優先）。名前ごとに `TOP 1 … ORDER BY c.identification.confidence DESC, c.identification.at DESC` で1枚だけ読む |
| 枚数 | `GROUP BY c.identification.name` の `COUNT(1)`（写真を読まずに数える） |
| 表紙 | 見出しに使った写真のサムネイル（無ければ原寸） |
| 項目の中の写真の並び | §5.3 と同じ（`sortAt` 昇順、継続トークンでページング） |

この形で成り立つこと:

- やり直しで種類や名前が変わっても、写真の `identification` を書き換えるだけ（§3.3）。項目の作成・併合・付け替え・0枚になった項目の削除は無い
- 写真を消せば図鑑からも消える。0枚の項目は存在しえない
- まとめる鍵に種類を含めるのは、同じ名前が別の種類で現れうるため（畑のメロンは植物、皿のメロンは食べ物）。名前だけでまとめると別の種類の写真が1件に混ざる
- 項目そのものにコメントやお気に入りを付けたくなったら、そのときに項目の文書を足す。写真の側は変えなくてよい

#### 規模の注意（図鑑は写真を全部読まずにまとめる）

図鑑を開くたびに写真からまとめる（案 B）が、**その種類の写真を全部読んでサーバでまとめる形はとらない**（2026-10-12 のレビューで、規模が大きくなると困ると判断）。
1種類の項目一覧は次の3段で作る（クエリは §5.6）。

| 段 | 何を読むか | 読む量 |
|---|---|---|
| 1. 名前ごとの枚数 | `GROUP BY c.identification.name` で `COUNT(1)`。結果は項目の数（数十〜数百行、1行 100 B 程度）だけ | 写真の枚数に依らず小さい。RU はインデックスを走査する分（推測） |
| 2. 名前順に並べて1ページ分に切る | 1 の結果をサーバで `name` の文字列順に並べ、`offset` / `limit`（既定 50 件。`CATALOG_PAGE_SIZE`）で切る。`GROUP BY` と `ORDER BY` は同じクエリに書けない（推測）ので並べ替えはサーバで行うが、並べるのは項目の行だけで写真は読まない | 同上 |
| 3. ページの項目ごとに見出しの写真 | 項目ごとに `TOP 1 … ORDER BY c.identification.confidence DESC, c.identification.at DESC` で1枚だけ読む（`identification` 全体・Blob 名）。1ページ 50 件なら 50 クエリを並列に投げる | 1項目 1 KB × ページの件数。写真の総数に依らない |

項目の詳細も同じで、`COUNT(1)`・`TOP 1`・写真のページ（`sortAt` 順の継続トークン）の3クエリ。**どれも読む量が写真の総数に比例しない。**

見積もり（**すべて推測**。段階4の最初に実測して `docs/09_backlog.md` に記録する）:

| 写真の総数 | 1種類の識別済み写真 | 項目の数 | 1ページを開くときの RU | 体感 |
|---|---|---|---|---|
| 数千枚（年に数回の旅行 × 数百枚 × 数年） | 数百〜2,000 枚 | 数十〜数百 | `GROUP BY` 数十 + `TOP 1` 50 件 × 数 RU ≒ 200〜300 | 1 秒前後。400 RU/s の枠に収まる。往復は並列なので件数ほど遅くならない |
| 数万枚 | 1 万枚前後 | 数百〜千 | `GROUP BY` 100 前後 + 同上 ≒ 300〜400 | 同上。項目が増えてもページの大きさは同じ |

代償は、1ページを開くのに `limit` + 2 本のクエリを投げること。写真を全部読む形（1種類 2,000 枚で 1〜2 MB・100〜200 RU、1 万枚で 10 MB・1,000 RU）と比べ、
小さな規模では RU がやや多く、大きな規模では桁で少ない。個人の規模でも 400 RU/s の枠に収まるので、最初からこの形にする。

- 読むのは開いた種類のタブの分だけ（3種類をまとめて読まない）。旅行の画面は図鑑の読み取りをしない
- 段 1 の `GROUP BY` は Cosmos SQL の集計で、null の鍵や `ORDER BY` との併用の制約がある（推測）。段階4の最初に手で確かめる（[08 §5.3](./08_test_plan.md#53-段階34で足すもの)）
- 段 3 の2項目の `ORDER BY` には複合インデックス（`/identification/confidence` 降順, `/identification/at` 降順）が要る（[07 §3](./07_infrastructure_design.md#3-段階4)）。
  無いと 400 になる（推測）ので、インフラの PR を API より先に apply する

**それでも重くなったら「写真から作り直せるまとめの控え（キャッシュ）」を足す。** `type: "catalogSummary"`、id `"catalog-<kind>"` の文書に項目一覧（名前・枚数・見出し）を保存し、
ワーカーが識別結果を書くたび（と写真を消すたび）にその種類の控えを作り直す。API は控えを読み、無ければ写真から作って保存する。

- 正は写真のまま。控えは消して作り直せるので、**足すときも外すときもデータの移し替えは要らない**
- 目安: 図鑑の1ページを開くのに 3 秒以上かかるようになったら（`TOP 1` の並列が効かない場合）
- 作り直しに失敗しても古い控えが残るだけで、次の識別で作り直される。`updatedAt` を持たせ、一定時間より古ければ API 側で作り直す

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
| 図鑑の API | `kind` が表に無ければ 400。API の形は案で、段階4の詳しい設計で決める（[05 §5.14](./05_api_design.md#514-図鑑段階4)） | 4 |
| Flutter | 起動時に取得して保持。項目詳細は `fields` を順に回して `attributes[key]` を出す（無ければ「—」）。種類タブも `kinds` から作る | 4 |
| `PATCH` の検証 | 段階4では `attributes` を利用者が直す機能は入れない。入れるときは `fields` の `type` で検証 | — |

種類を足す手順: 表に1行足す → 分類の選択肢・識別のスキーマ・`GET /api/catalog/kinds` が追従 → アプリは再ビルド不要（タブと項目はサーバから）。
種類ごとのアイコンや色など見た目を足すならアプリの更新が要る。

### 3.3 やり直しで種類や名前が変わったとき

写真の `identification` を書き換えるだけ（[06 §3.2](./06_processing_design.md#32-書き込み)）。項目の文書が無いので、
項目を探す・作る・併合する・写真を付け替える・0枚になった項目を消す、という手順は無い。

| きっかけ | 段階 | どう起きるか |
|---|---|---|
| 写真の解析のやり直し（要件 5.5.1） | 4 | 分類のやり直しは、まず `identification` を `null` にしてから識別し直す（種類が変わったのに古い名前の下に残らないように。§7.4）。識別の結果で新しい種類・名前の項目に現れ、古い名前の写真が0枚になればその項目は自然に消える |
| 名前の揺れをそろえる（要件 §8 の未決の論点） | 未定 | 「ソメイヨシノ」の写真の `identification.name` を「サクラ」に書き換える（写真1枚につき Patch 1回）。付け替える先を作る手順は要らない |

項目の種類や名前を利用者が直接書き換える操作は、段階4では入れない（要件 5.5.1 はやり直しで直すのが基本）。入れるときも写真ごとの Patch で書ける。
個人の規模では1項目の写真は数枚〜数十枚なので、書き換えの回数が問題になることは無い（推測）。

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

- 写真の削除: ドキュメントを消してから原寸とサムネイルを消す。Blob の削除の失敗はログだけで、ドキュメント操作は成功扱い（`plants` と同じ方針）。404 は成功とみなす。
  残った Blob（孤児）は掃除のタイマーが消す（§7.2）
- 旅行の削除: 利用者が「写真も消す」を選んだときだけ、中の写真を1枚ずつ上の手順で消す。「写真は残す」なら写真の `tripId` を `null` にして未所属に移す（Blob は触らない）。
  どちらも最後に旅行を消す。削除と重なって届いた送信・move の写真は消さず、掃除のタイマー（段階3。§7.2）が未所属に戻す（§7.3）
- URL の検証による二層防御は要らない。削除する Blob 名はドキュメントの `blobName` / `thumbnailBlobName` から取り、クライアントから URL を受け取らない

## 5. クエリ

**単体テストは Cosmos SQL を解釈しない。** WHERE 句・ORDER BY・射影・集計（`COUNT`・`MIN` / `MAX`・`GROUP BY`・`TOP 1`）は単体テストで検証できないため、
下の表で「手で確認」の印が付いたものは、デプロイ後に手で確かめる（[08 §5](./08_test_plan.md#5-単体テストで確かめられず手で確かめる項目)）。
サービスは絞り込みの値を**必ずパラメータ**で渡す（SQL に値を文字列で埋め込まない）。

**写真を全部読むクエリを置かない**（2026-10-12 のレビュー）。一覧は `ORDER BY` と継続トークンで少しずつ読み、枚数・期間は `GROUP BY` で数え、表紙は `TOP 1` で1枚だけ読む。
例外は掃除のタイマー（5.9）で、1日1回の一括処理なので全写真の薄い射影をページで読む。

| # | 画面・処理 | クエリ | 単体テストで検証 | 手で確認 |
|---|---|---|---|---|
| 5.1 | 旅行一覧（集計） | 枚数: `SELECT c.tripId, COUNT(1) AS photoCount FROM c WHERE c.type = @type GROUP BY c.tripId`／期間: `SELECT c.tripId, MIN(c.takenAt) AS firstTakenAt, MAX(c.takenAt) AS lastTakenAt FROM c WHERE c.type = @type AND IS_STRING(c.takenAt) GROUP BY c.tripId`／表紙: 旅行ごとに `SELECT TOP 1 c.thumbnailBlobName, c.blobName FROM c WHERE c.type = @type AND c.tripId = @tripId ORDER BY c.sortAt ASC` | 集計の行から `TripSummary` と未所属の枚数を組み立てる所は○ | `GROUP BY`（`null` の鍵）・`MIN` / `MAX`・`TOP 1` |
| 5.2 | 旅行一覧（旅行） | `SELECT * FROM c WHERE c.type = @type ORDER BY c.createdAt DESC` | `@type` の絞り込みのみ | 並び順 |
| 5.3 | 旅行の写真一覧・未所属 | 旅行あり: `WHERE c.type = @type AND c.tripId = @tripId ORDER BY c.sortAt ASC`／未所属: `WHERE c.type = @type AND IS_NULL(c.tripId) ORDER BY c.sortAt ASC`。`maxItemCount` と継続トークンでページ | `@tripId` で絞る（未所属は `tripId` が `null` のもの）。ページの切れ目と継続トークンの受け渡し | `IS_NULL`・`ORDER BY c.sortAt` の並び・継続トークンでページが続くこと |
| 5.4 | カテゴリ横断（段階3） | `WHERE c.type = @type AND c.category = @category ORDER BY c.sortAt ASC`。ページは 5.3 と同じ | `@category` で絞る | — |
| 5.5 | タグ一覧（段階3。タグを付ける画面を入れるときに使う） | `SELECT DISTINCT VALUE t FROM c JOIN t IN c.tags WHERE c.type = @type` | × | 全部 |
| 5.6 | 図鑑の項目一覧（段階4） | 枚数: `SELECT c.identification.name AS name, COUNT(1) AS photoCount FROM c WHERE c.type = @type AND c.identification.kind = @kind AND c.identification.matchesKind = true GROUP BY c.identification.name`／見出し: 項目ごとに `SELECT TOP 1 c.id, c.identification, c.thumbnailBlobName, c.blobName FROM c WHERE … AND c.identification.name = @name ORDER BY c.identification.confidence DESC, c.identification.at DESC` | 集計の行と見出しの写真から `CatalogEntry` を組み立て、名前順に並べてページに切る所は○ | `GROUP BY`・複合インデックスの `ORDER BY` |
| 5.7 | 項目の写真（段階4） | `WHERE c.type = @type AND c.identification.kind = @kind AND c.identification.name = @name ORDER BY c.sortAt ASC`。ページは 5.3 と同じ。枚数は `SELECT VALUE COUNT(1) FROM c WHERE …` | `@kind`・`@name` で絞る | `COUNT` |
| 5.8 | 再投入のタイマー（段階3） | `WHERE c.type = @type AND c.processing.state IN ('pending','classifying','identifying') AND c.processing.updatedAt < @before`（**`failed` は含めない**。[06 §1.3](./06_processing_design.md#13-状態と失敗)） | × | 全部 |
| 5.9 | 掃除のタイマー（段階3） | `SELECT c.id, c.tripId, c.blobName FROM c WHERE c.type = @type`（全写真の薄い射影。ページで読む）と、旅行の id の一覧（5.2） | 突き合わせは○ | 射影 |
| 5.10 | 旅行の削除（段階2） | `SELECT c.id, c.blobName, c.thumbnailBlobName FROM c WHERE c.type = @type AND c.tripId = @tripId`（ページで読み、1枚ずつ消す、または `tripId` を `null` に patch する。§5.7） | `@tripId` で絞る。消える・未所属になる結果は○ | 射影 |

### 5.1 旅行一覧

旅行ごとの枚数・撮影期間・表紙を、**写真を全部読まずに**導く。

```sql
-- 枚数（旅行ごと。tripId が null の写真も1つのグループになる。推測）
SELECT c.tripId, COUNT(1) AS photoCount FROM c WHERE c.type = @type GROUP BY c.tripId
-- 撮影期間（撮影日時のある写真だけ。MIN / MAX が null をどう扱うかに依存しないよう IS_STRING で絞る）
SELECT c.tripId, MIN(c.takenAt) AS firstTakenAt, MAX(c.takenAt) AS lastTakenAt
FROM c WHERE c.type = @type AND IS_STRING(c.takenAt) GROUP BY c.tripId
-- 表紙（旅行ごとに1枚。sortAt 順で先頭）
SELECT TOP 1 c.thumbnailBlobName, c.blobName FROM c WHERE c.type = @type AND c.tripId = @tripId ORDER BY c.sortAt ASC
```

`@type = 'photo'`。`GROUP BY` の結果は旅行の数（数十行）だけで、写真の枚数に依らず小さい。表紙は旅行の一覧（§5.2）の各旅行について `TOP 1` を並列に投げる
（数十クエリ。1本 数 RU。推測）。表紙の `thumbnailBlobName` が `null` なら `blobName` を使う。

**未所属の枚数も同じ集計から出す。** 枚数の `GROUP BY` の行のうち、`tripId` が `null` の行の `photoCount` がそれになる。
`GET /api/trips` はこれを `unassignedPhotoCount` として返す（[05 §5.9](./05_api_design.md#59-get-apitrips)）ので、一覧の画面は `GET /api/photos` を別に呼ばない。
旅行の一覧に無い id の行（消えた旅行を指す写真。§7.3）があっても未所属には数えない（段階3の掃除のタイマーが `null` に戻してから数えられるようになる）。

`GROUP BY` は Cosmos SQL の制約で `ORDER BY` と同じクエリに書けず、`null` の鍵がグループになるかも推測（[08 §5.2](./08_test_plan.md#52-デプロイ後api段階2) で手で確かめる）。
`null` がグループにならなければ、未所属の枚数だけ `SELECT VALUE COUNT(1) FROM c WHERE c.type = @type AND IS_NULL(c.tripId)` を1本足す。

### 5.2 旅行の詳細

`container.item(tripId, tripId).read()`。無ければ `resource` が無い応答（`plants` と同じ。`resource || null`）。
集計は §5.1 と同じ形を `tripId` で絞って行う（枚数 `SELECT VALUE COUNT(1) …`、期間 `SELECT MIN(c.takenAt) …, MAX(c.takenAt) … WHERE … AND IS_STRING(c.takenAt)`、表紙 `TOP 1`）。

### 5.3 旅行の写真一覧

```sql
-- 旅行の写真
SELECT * FROM c WHERE c.type = @type AND c.tripId = @tripId ORDER BY c.sortAt ASC
-- 旅行に属さない写真
SELECT * FROM c WHERE c.type = @type AND IS_NULL(c.tripId) ORDER BY c.sortAt ASC
```

**未所属は「`tripId` が `null`」の写真だけ**（2026-10-12 に人間が決定。[02 §5](./02_design_overview.md#5-人間に決めてもらう点推奨付き) #19）。
以前の案では「存在しない旅行を指す写真」（旅行の削除と送信・move が重なって残るもの。§7.3）も未所属に含め、旅行の id の配列を `NOT ARRAY_CONTAINS(@tripIds, c.tripId)` で引いていたが、
めったに起きないケースのためにクエリと旅行の一覧の先読みを足さない。残った写真は段階3の掃除のタイマー（§7.2）が `null` に戻し、それまでは一覧に出ない。

`c.tripId = null` は Cosmos SQL では偽になるので、`null` は `IS_NULL` で書く。`tripId` は写真の作成時に必ず `null` を明示して書く
（項目が欠けていると `IS_NULL` も偽になり、一覧から静かに外れる）。

**並び順は Cosmos の `ORDER BY c.sortAt ASC` で付け、継続トークンでページに分けて読む。** `sortAt`（§1.3）は全写真が必ず持つ文字列なので、
`ORDER BY` が null を先頭に置くか・項目の無いドキュメントを外すかという問題が無い。撮影日時の無い写真はアップロード日時（日本時間）の位置に入る。
同値の並びは固定しない（固定したければ複合インデックス（`sortAt`, `id`）を足す）。

- 1ページは `maxItemCount`（`limit`。既定 100、上限 200。`PHOTO_PAGE_SIZE`）。SDK の `fetchNext()` が返す `continuationToken` をそのまま応答に載せ、クライアントは次の要求にそのまま返す（[05 §5.2](./05_api_design.md#52-get-apiphotos)）
- 継続トークンは Cosmos が作る不透明な文字列で、クエリ本文とパラメータが同じときだけ有効。数 KB になることがある（推測）ので、クエリ文字列ではなくヘッダか POST にする案もあるが、
  まず `continuationToken` クエリパラメータで作り、長さが問題になったら変える（[02 §5](./02_design_overview.md#5-人間に決めてもらう点推奨付き) #21）
- ページの途中で写真が増減しても、継続トークンは「並びの中の位置」を指すので、次のページが重複・欠落することは無い（推測。同じ `sortAt` の写真が同時に入った場合は除く）。
  一覧を取り直せば最新になる
- 1旅行数百枚（要件 §2）なら数ページで、クライアントは下までスクロールするたびに次のページを読む（[03 §4.4](./03_screen_design.md#44-旅行詳細画面)）。
  規模が大きくなっても1ページの読む量は変わらない

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

read-then-replace ではなく Patch にする。同時に PATCH（コメント）やワーカーの書き込みが来ても、互いの項目を上書きしない。
存在しない id への patch は 404 の例外になり、呼び出し側は `notFound` に入れる。同じ値を何度 patch しても結果は同じなので、途中で止まっても再送で続きができる（§7.1）。

### 5.5 写真の作成（冪等）

1. `container.item(photoId, photoId).read()` → あれば既存を返す
2. Blob を上書きアップロード（原寸 → サムネイル）
3. `container.items.create(photo)` → 409（1 と 3 の間に並行リクエストが作った）なら既存を読んで返す

Blob を先、ドキュメントを後。逆だと「壊れた表示の写真」が一覧に出る。途中で止まったときに残るものは §7.1。詳細は [05 §5.1](./05_api_design.md#51-post-apiphotos)。

### 5.6 図鑑のまとめ（段階4）

写真を全部読まずにまとめる（§3.1 の「規模の注意」）。

```sql
-- 1. 名前ごとの枚数（結果は項目の数だけ）
SELECT c.identification.name AS name, COUNT(1) AS photoCount
FROM c WHERE c.type = @type AND c.identification.kind = @kind AND c.identification.matchesKind = true
GROUP BY c.identification.name
-- 2.（サーバで name の文字列順に並べ、offset / limit で1ページ分に切る）
-- 3. ページの項目ごとに見出しの写真を1枚（信頼度が最も高く、同点なら識別の日時が新しいもの。複合インデックスが要る）
SELECT TOP 1 c.id, c.identification, c.thumbnailBlobName, c.blobName
FROM c WHERE c.type = @type AND c.identification.kind = @kind AND c.identification.matchesKind = true AND c.identification.name = @name
ORDER BY c.identification.confidence DESC, c.identification.at DESC
```

`@type = 'photo'`。1 の行と 3 の写真から、§3.1 の表のとおり `CatalogEntry`（名前・説明・特徴・属性・信頼度・枚数・表紙）を組み立てる。
項目の詳細（§5 の 5.7）は、3 と同じ `TOP 1`（見出し）、`SELECT VALUE COUNT(1)`（枚数）、`@kind`・`@name` で絞って `ORDER BY c.sortAt ASC` の写真のページ（§5.3 と同じ継続トークン）の3本。

識別結果の書き込みは**写真1枚への patch 1回**（[06 §3.2](./06_processing_design.md#32-書き込み)）。項目の文書が無いので、`create` の 409 も、
信頼度を比べて項目を書き換える処理も、写真の付け替えも無い。

### 5.7 その他の単一ドキュメント操作

| 操作 | SDK |
|---|---|
| 旅行の作成 | `items.create(trip)` |
| 旅行の更新 | `item(id, id).replace({ ...existing, name, description, updatedAt })` |
| 旅行の削除（写真も消す） | 中の写真の射影（5.10）をページで読み、1枚ずつ `item(id, id).delete()` + Blob 削除 → `item(tripId, tripId).delete()` |
| 旅行の削除（写真は残す） | 中の写真の射影（5.10）をページで読み、1枚ずつ `item(id, id).patch([{ op: 'set', path: '/tripId', value: null }, { op: 'set', path: '/updatedAt', value: now }])`（move の「外す」と同じ）→ `item(tripId, tripId).delete()` |
| 写真の削除 | `item(id, id).delete()` → Blob 削除（失敗はログ） |
| コメント・タグの更新 | `item(id, id).patch([{ op: 'set', path: '/comment', ... }, ...])` |
| 処理状態の更新（段階3） | `item(id, id).patch([{ op: 'set', path: '/processing', ... }])` |
| ワーカーが写真を担当する（段階3） | `item(id, id).patch({ operations: [processing の set], condition: 'FROM c WHERE c.processing.state = "pending"' })`。412 なら別のインスタンスが先に担当した（重複配信）ので何もしない（§7.4） |
| ワーカーの結果の書き込み（段階3・4） | AI の担当の欄（`category`・`classification`・`identification`・`processing`）だけを `set` する patch。`_etag` の条件は付けない（§7.4）。コメントだけは `item(id, id).patch({ operations: [comment・commentSource の set], condition: 'FROM c WHERE IS_NULL(c.commentSource) OR c.commentSource = "ai"' })` の**条件付き patch** で、412（利用者のコメントがある）なら書かずに進む |
| 消えた旅行を指す写真を未所属へ戻す（掃除のタイマー。段階3。§7.2） | `item(id, id).patch([{ op: 'set', path: '/tripId', value: null }, ...])` |

## 6. 無料枠と RU の見積もり

### 6.1 無料枠

Cosmos DB の無料枠は**アカウントで最初の 1000 RU/s と 25 GB**（Microsoft のドキュメント。ポータルや CLI には数値が出ず、`enableFreeTier: true` だけが分かる）。
2026-10-12 に `album` を apply した。数日後にポータルの「コスト管理」で Cosmos DB の請求が 0 円のままかを人間が確認する。

| 時期 | コンテナ | 合計 RU/s | 枠内か |
|---|---|---|---|
| 段階2〜4の移行前 | `plants` 400 + `album` 400 | 800 | 1000 なら枠内。400 なら超過（`album` の 400 RU/s 分で月 3,000〜3,500 円程度。100 RU/s あたり 1 時間 $0.008 からの推測） |
| 段階4の移行後 | `album` 400 | 400 | 枠内 |

`catalog` を別コンテナにすると移行中に 1200 になり枠を超えうるのが、`album` 1コンテナにした理由の1つ。
データベース共有スループットへの変更は作り直しになる（推測）ので採らない。

### 6.2 RU の見積もり（推測。実測して `docs/09_backlog.md` に記録する）

| 操作 | 想定 RU | 頻度 | 備考 |
|---|---|---|---|
| 写真の作成（read 1 + create 1） | 約 1 + 10 | 1枚ごと | ドキュメント約 2 KB。300 枚で約 3,300 RU。同時 2 本なら数十秒に分散 |
| 旅行の写真一覧（`ORDER BY c.sortAt` で 1 ページ 100 件） | 約 50〜100 | ページを読むたび | 横断クエリ。個人規模では物理パーティションは1つ（推測）。1ページの RU は旅行の枚数に依らない |
| 旅行一覧（`GROUP BY` 2 本 + 旅行ごとの `TOP 1`） | `GROUP BY` 各 10〜50 + 旅行 1 件あたり 3〜5 | 画面を開くたび | `GROUP BY` はインデックスを走査するので写真の枚数に緩やかに比例（推測）。旅行 30 件で 150 前後 |
| move（patch 1 件） | 約 10 | 1枚ごと | 300 枚で約 3,000 RU。**400 RU/s を数秒超えるので SDK の再試行（429）が入る。関数の 5 分に収まるかは要実測**（[02 §6](./02_design_overview.md#6-リスク)） |
| 旅行の削除（300 枚。写真も消す） | 約 3,000 + 射影の読み取り | まれ | 同上。「写真は残す」は patch 300 件で同程度 |
| 図鑑の1種類の1ページを開く（`GROUP BY` + `TOP 1` 50 件。段階4） | 約 200〜400 | 種類のタブ・ページを開くたび | 写真の枚数に依らない。§3.1 の「規模の注意」 |
| 掃除のタイマー（全写真の薄い射影 + 旅行の一覧。段階3） | 約 100〜500 | 1日1回 | 唯一の全件読み。ページで読む。Blob の列挙は Cosmos の RU とは別 |

ストレージ: 写真 1 枚あたり原寸 1〜3 MB + サムネイル 30 KB。25 GB なら 1 万枚前後（Blob は Cosmos の枠とは別で、Blob は従量課金）。

## 7. 整合性（途中で失敗したら何が残るか）

Cosmos DB は**別パーティションの文書をまとめて原子的に書けない**。`album` の PK は `/id` なので文書ごとに別パーティションで、
2つ以上の文書や、文書と Blob にまたがる操作は、途中で止まると食い違った状態が残りうる。
ここでは書き込みを伴うすべての操作について、「途中で失敗したら何が残るか」「利用者から何が見えるか」「どう直るか」を表にする。
方針は3つ。

1. **書く順を「残っても害が小さい方が先」にする。** Blob → 文書（文書が無ければ一覧に出ない）、写真 → 旅行（旅行が残れば再実行で続きができる）
2. **再送で直る形（冪等）にする。** 写真の id が中身から決まり、Blob 名が id から決まる。move と処理状態は patch。旅行の削除は再実行で続きができる
3. **それでも残るものは掃除で直す。** 孤児 Blob は掃除のタイマー（段階3）で消し、消えた旅行を指す写真は同じタイマーで未所属に戻す（§7.2）。
   めったに起きないケースのために、未所属の定義を広げたり、旅行の削除の最後に見直しを足したりはしない（§7.3。2026-10-12 に人間が決定）

直り方の分類: **再送**（利用者が同じ操作をやり直せば直る）/ **自動**（タイマーや次の処理で直る）/ **掃除**（§7.2 のタイマー）/ **手**（人間が直す）。

### 7.1 操作ごとの表

**写真の送信**（`POST /api/photos`。[05 §5.1](./05_api_design.md#51-post-apiphotos)。順: 文書を読む → 原寸 → サムネイル → `create`）

| 途中で失敗した所 | 残るもの | 利用者から見えるもの | 直り方 |
|---|---|---|---|
| 原寸の Blob | 何も残らない（10 MB 以下の `uploadData` は1回の書き込みで、途中の状態は見えない。推測） | 送信の失敗 | 再送 |
| サムネイルの Blob | 原寸の Blob だけ。文書は無い | 送信の失敗。一覧に出ない | 再送（同じ Blob 名に上書き）。送り直さなければ孤児 Blob → 掃除 |
| `create`（409 以外） | 原寸・サムネイルの Blob。文書は無い | 同上 | 同上 |
| `create` の後、応答が届かない | 正しい状態 | 送信の失敗に見える | 再送で 200（既存） |
| `tripId` の旅行が、存在の検査の後に消された（旅行の削除との競合） | 消えた旅行を指す写真 | どの一覧にも出ない（写真は消えていない） | 掃除（段階3のタイマーが未所属に戻す。段階2の間は見えないまま）。アプリは削除の前に送信を止める（[03 §4.4](./03_screen_design.md#44-旅行詳細画面)）のでまれ（§7.3） |
| 同じ写真の削除と重なる（削除が文書を消した後に送信が文書を作り、削除が Blob を消す） | Blob の無い文書 | 「画像を読み込めません」 | **手**（写真を削除して送り直す。再送は既存を返すので直らない）。削除の文書の削除と Blob の削除の間に送信の読み取り・Blob・`create` が全部挟まる必要があり、1人で使う限り実質起きない。掃除のタイマーが検出してログに出す |

**写真の削除**（`DELETE /api/photos/{photoId}`。順: 文書 → 原寸 → サムネイル）

| 途中で失敗した所 | 残るもの | 利用者から見えるもの | 直り方 |
|---|---|---|---|
| 文書の削除 | 何も変わらない | 失敗 | 再送。文書が既に無ければ 404 → アプリは成功扱い |
| Blob の削除 | 孤児 Blob（文書は消えている） | 無し（200） | 掃除 |

**旅行の作成・更新**（`POST` / `PUT /api/trips`。文書1つ）

| 途中で失敗した所 | 残るもの | 利用者から見えるもの | 直り方 |
|---|---|---|---|
| `create` の後、応答が届かない | 旅行はできている | 失敗に見える。押し直すと同じ名前の旅行が2つ | **手**（空の方を消す）。アプリは自動で再試行しない（[03 §3](./03_screen_design.md#3-全画面共通)）ので、利用者が押し直したときだけ。写真と同じくクライアントが id を振れば冪等になるが、段階2では入れない（§7.5） |
| `replace` | 何も変わらない | 失敗 | 再送（同じ値なので冪等） |

**旅行の削除**（`DELETE /api/trips/{tripId}?deletePhotos=true|false`。[05 §5.12](./05_api_design.md#512-delete-apitripstripiddeletephotostruefalse)。
順: 写真を1枚ずつ（`deletePhotos=true` は文書 → Blob、`false` は `tripId` を `null` に patch）→ 旅行の文書）

| 途中で失敗した所 | 残るもの | 利用者から見えるもの | 直り方 |
|---|---|---|---|
| 写真の文書の削除（`true`） | 写真が減った旅行 | 500。枚数が減った旅行が残る | 再送（続きから。`deletedPhotoCount` は残りの分） |
| 写真の Blob の削除（`true`） | 孤児 Blob | 無し（続行する） | 掃除 |
| 写真の patch（`false`） | 一部だけ未所属になった旅行 | 500。枚数が減った旅行が残る | 再送（続きから。`detachedPhotoCount` は残りの分。patch は同じ値なら結果が同じ） |
| 旅行の文書の削除 | 0枚の旅行 | 500。0枚の旅行 | 再送 |
| 削除の途中・直後に送信や move がその旅行に届く | 消えた旅行を指す写真 | どの一覧にも出ない。写真は消えていない（`deletePhotos=true` でも、削除が読んだ射影に無かった写真は消さない） | 掃除（段階3のタイマーが未所属に戻す。段階2の間は見えないまま。§7.3） |

逆順（旅行を先に消す）にしない理由: 途中で止まると、存在しない旅行を指す写真が数百枚残り、利用者が再実行する手段（旅行は 404）が無い。
写真を先に処理すれば、残るのは「写真が減った旅行」で、同じ削除をもう一度押せば続きができる。

**move**（`POST /api/photos/move`。写真1枚ずつ patch）

| 途中で失敗した所 | 残るもの | 利用者から見えるもの | 直り方 |
|---|---|---|---|
| 途中の patch | 一部だけ移った | 500。一部が移っている | 再送（patch は無条件で、同じ値なら結果は同じ） |
| 宛先の旅行が、存在の検査の後に消された | 消えた旅行を指す写真 | どの一覧にも出ない（写真は消えていない） | 掃除（段階3。§7.3） |
| 写真が同時に消された | 404 → `notFound` | 文言に「見つかりませんでした」 | — |

**PATCH**（`PATCH /api/photos/{photoId}`。文書1つ）

| 途中で失敗した所 | 残るもの | 利用者から見えるもの | 直り方 |
|---|---|---|---|
| patch | 何も変わらない | 失敗 | 再送 |
| ワーカーの書き込みと重なる | patch は項目単位で、利用者が書く欄（`comment`・`tags`・`tripId`）と AI が書く欄（`category`・`classification`・`identification`・`processing`）が分かれているので、互いを消すことは無い。`comment` だけは両方が書くので、ワーカーは「`commentSource` が `"user"` でなければ」の条件付き patch で書き、412 なら書かない（§7.4）。「解析中」で利用者の更新を止めるロックは置かない | — | 自動 |

**やり直しの受付**（`POST /api/photos/{photoId}/process`。[05 §5.7](./05_api_design.md#57-post-apiphotosphotoidprocess段階3)。順: patch → キューに投入）

| 途中で失敗した所 | 残るもの | 利用者から見えるもの | 直り方 |
|---|---|---|---|
| patch | 何も変わらない | 失敗 | 再送 |
| キューへの投入 | `pending`・`step` の付いた写真。メッセージは無い | 「解析中...」のまま最大 10 分 | 自動（タイマーが `processing.step` を見て再投入）。応答は 202（投入の失敗で失敗を返さない。返すと「失敗したのに後で勝手に走る」ことになる） |

投入を先にしない理由: 投入の後に patch で失敗すると、ワーカーが古い `step`・`hint` で走る。

**ワーカーの分類・識別**（[06 §1](./06_processing_design.md#1-キューとワーカー段階3)・[06 §3](./06_processing_design.md#3-識別段階4)。順: 写真を読む → `state` を処理中に（条件付き patch）→ AI → コメントを条件付き patch → 結果と `state` を patch）

| 途中で失敗した所 | 残るもの | 利用者から見えるもの | 直り方 |
|---|---|---|---|
| `state` を `classifying` / `identifying` にした後に落ちる | 処理中のまま | 「分類中...」 | 自動（10 分後にタイマーが再投入。`attempts` が上限（3 回）なら `failed`） |
| AI の呼び出しが成功した後、結果の patch の前に落ちる | 結果が無い | 同上 | 自動（再実行。AI の費用が1回分無駄になる） |
| 分類の後、識別の投入に失敗 | `pending`・`step: "identify"` | 「識別中...」 | 自動（タイマー） |
| **同じ画像で AI が毎回失敗する**（応答の検証違反・内容による拒否など、再試行しても直らない失敗） | `attempts: 3`・`failed`・`lastError` | 「分類に失敗しました」と「やり直す」 | **自動では直らず、永遠に回り続けもしない。** キューの再試行は `maxDequeueCount` 3 回で poison に落ち、タイマーは `attempts` が上限なら `failed` にし、**`failed` は再投入のクエリ（§5 の 5.8）に含めない**。利用者が `process` を頼んだときだけ `attempts` を 0 に戻してもう一度試す。やり直しの回数に上限は置かず、費用は AI のデプロイの容量と予算アラートで抑える（[06 §6](./06_processing_design.md#6-費用の抑え方)） |
| 分類で種類が変わったのに、識別が上限まで失敗 | `identification: null`（分類が先に消す）・`failed` | 「失敗」。図鑑に出ない | 利用者がやり直す。**古い種類・名前の下に残り続けることは無い** |
| コメントの条件付き patch が 412（AI の処理中に利用者がコメントを書いた） | 利用者のコメントが残る。AI のコメントは書かれない | 利用者の文 | 意図どおり（§7.4）。結果の patch には進む |
| AI の処理中に利用者が `tags`・`tripId` を変えた（解析中に写真を編集した） | 利用者の変更と AI の結果の両方が残る | 両方 | 書く欄が分かれているので衝突しない。ロックも読み直しも要らない |
| コメントの patch の後、結果の patch の前に落ちる | AI のコメントだけ書かれ、`state` は処理中のまま | 「分類中...」 | 自動（タイマーが再投入。AI がもう一度走り、コメントも書き直される） |
| 同じメッセージが2回届く（可視性タイムアウト後の重複配信） | — | — | 担当の patch を `FROM c WHERE c.processing.state = "pending"` の条件付きにする（§5.7）。412 なら別のインスタンスが担当済みなので何もしない。読んだ `state` が `done` / `failed` / `none` でも何もしない |
| 地名のキャッシュ（`geocache`）の `create` が 409 | 既に同じ座標の地名がある | — | 無視する |

**移行スクリプト**（[06 §7](./06_processing_design.md#7-今の植物図鑑の統合と廃止段階4) 手順 2。植物1件ずつ: 旧 Blob を読む → `photos` に上げる → 写真の `create`）

| 途中で失敗した所 | 残るもの | 利用者から見えるもの | 直り方 |
|---|---|---|---|
| Blob を上げた後、`create` の前 | 孤児 Blob | 無し | 再実行（冪等。`create` は既にあれば飛ばす） |
| `plants` の `imagePath` の Blob が無い（既存の「保存しなかった画像が残る」不具合の裏返し） | その植物は移らない | 旧図鑑の件数と合わない | **手**（スクリプトが一覧に出す。人間が捨てるか手で入れる） |
| 同じ画像がアルバムに先にある（`create` が 409） | アルバムの写真に植物の記録は乗らない | 突き合わせで `legacyPlantId` が無い | **手**（一覧に出す。その写真の `identification` が `null` なら乗せるかを人間が決める） |
| 移行の後、`plants` を消す前 | 両方に同じ記録 | 旧図鑑と新図鑑の両方に出る（意図どおり） | 手順 4〜6 で旧を消す |

**ライフサイクル**（[07 §1.2](./07_infrastructure_design.md#12-ライフサイクル管理temp-images-の孤児の軽減)）

| 失敗 | 残るもの | 利用者から見えるもの | 直り方 |
|---|---|---|---|
| `prefix_match` の付け忘れ | Function App の鍵・`photos`・`images` が消える | 全部止まる | **手**（復旧できない）。CI の `validate` では検出できないので、`plan` の差分を目で見る |
| 削除が1日遅れる（Azure の仕様。推測） | 一時 Blob が長く残る | 無し | 自動 |

### 7.2 掃除のタイマー（段階3）

`api/src/functions/sweepAlbum.ts`。`app.timer`、1日1回（深夜）。`requeueStalePhotos` と同じ PR で入れる（[09 §3](./09_implementation_plan.md#3-段階3の-pr-の骨格)）。

1. **孤児 Blob**: `photos` コンテナの Blob を列挙し、名前の先頭 64 文字を `photoId` として、全写真の薄い射影（§5 の 5.9。ページで読む）の id の集合と突き合わせる。
   文書が無く、**最終更新から1日より古い** Blob を消す（新しいものは送信の途中かもしれない。1日は [07 §1.2](./07_infrastructure_design.md#12-ライフサイクル管理temp-images-の孤児の軽減) と同じ根拠）
2. **消えた旅行を指す写真**: 同じ射影の `tripId` を旅行の id の集合と突き合わせ、無いものを `null` に patch する（**消さない。** 旅行の削除で「写真も消す」を選んでいても、削除と重なって残った写真は未所属にする。§7.3）。
   これが、旅行の削除と重なって残った写真を拾う唯一の仕組み（未所属の定義にも旅行の削除にも、そのための処理は無い）
3. **Blob の無い文書**: 突き合わせで原寸の Blob が無い写真をログに出す（消さない。手で直す）

全写真の射影を読むのはこのタイマーだけ（1日1回の一括処理で、1万枚でも 1 MB 程度の射影）。画面から呼ばれる API には全件読みを置かない（§5）。

件数と `photoId` をログに出す（[05 §1](./05_api_design.md#1-基本方針) の方針どおり、ファイル名や地名は出さない）。
段階2の間は孤児 Blob を放置する（容量の費用だけで、利用者からは見えない）。気になれば同じ突き合わせを手でする。
列挙は 1 万 Blob でも数秒（推測）。

### 7.3 旅行の削除と重なった送信・move

旅行の削除の途中・直後に、同じ旅行への送信や move が届く（旅行の存在の検査は通ったが、書き込みは削除が射影を読んだ後）と、
消えた旅行を指す写真が残る。**このケースのためのリッチな対応はしない**（2026-10-12 に人間が決定。[02 §5](./02_design_overview.md#5-人間に決めてもらう点推奨付き) #19・#25）。
利用者が旅行を消しながら同じ旅行に写真を入れることは、ユースケースとしてほぼ無い。

| 扱い | 内容 |
|---|---|
| 段階2の間 | 残った写真はどの一覧にも出ないが、**消えてはいない**（`deletePhotos=true` でも、削除が読んだ射影に無かった写真は消さない）。許容する |
| 段階3から | 掃除のタイマー（§7.2）が1日1回、消えた旅行を指す写真を `tripId: null` に戻す。以後は未所属の一覧に出る |
| アプリ側 | 削除の前に、その旅行宛ての送信を止める（[03 §4.4](./03_screen_design.md#44-旅行詳細画面)）ので、重なること自体がまれ |

以前の案（未所属の定義に「存在しない旅行を指す写真」を含める `NOT ARRAY_CONTAINS(@tripIds, c.tripId)` のクエリと、旅行の削除の最後に残った写真を見直して `null` に戻す「掃き戻し」）は、
めったに起きないケースのために入口のクエリと削除の手順を増やすので採らない。

### 7.4 ワーカーの書き込みの決まり

**AI は担当の欄だけを部分更新（Patch）し、「解析中」で利用者の更新を止めるロックは置かない**（2026-10-12 に人間が決定）。
ロックを置くと解析の間は利用者が何も変えられず、処理が落ちると解析中のまま残る。欄を分けて Patch する方が単純で、落ちても利用者の操作は妨げない。

| 欄 | 書く主体 |
|---|---|
| `category`・`classification`・`identification`・`processing` | AI（ワーカー）と、やり直しの受付（`processing`・`hint`） |
| `comment`・`commentSource` | **両方**（利用者の `PATCH` と AI）。衝突はここだけ |
| `tags`・`tripId`・`updatedAt` | 利用者（`PATCH`・move・旅行の削除）。`updatedAt` はワーカーも書く |

- メッセージを受けたら写真を読み直し、`processing.step` を信じる（メッセージは「この写真を見ろ」という合図に過ぎない。`hint` も写真から読む）
- 担当するときは `processing` を処理中にする patch に `FROM c WHERE c.processing.state = "pending"` の条件を付ける。412 なら別のインスタンスが担当済み（重複配信）で、何もしない
- 結果の書き込みは2回の patch。**(1) コメント**: `comment`・`commentSource: "ai"` を `FROM c WHERE IS_NULL(c.commentSource) OR c.commentSource = "ai"` の条件付きで `set`。
  412 なら利用者がその間にコメントを書いたので、書かずに進む（送信直後の自動の解析が、利用者のコメントを消さないように）。
  **(2) 結果**: `category`・`classification`（分類）または `identification`（識別）と `processing`・`updatedAt` を `set`。条件は付けない（他に書く主体が無い）。
  項目の文書が無いので、これで図鑑も同時に更新される
- **`_etag` の条件と「412 なら読み直し」は置かない。** 欄が分かれているので、読んでから書くまでに利用者が `tags`・`tripId` を変えても（解析中に写真を編集しても）、Patch は互いの欄を上書きしない。
  唯一の衝突である `comment` は、上の条件付き patch を Cosmos が原子的に評価するので、読み直しが要らない
- `condition` の比較は `null` を `!=` で扱えない（`null != "user"` は未定義になる。推測）ので、`IS_NULL(...) OR ... = "ai"` の形で書く
- やり直し（`process`）は受付の時点でコメントを消す（[05 §5.7](./05_api_design.md#57-post-apiphotosphotoidprocess段階3)）ので、やり直しの結果のコメントは必ず書かれる
- 分類は `identification` を `null` に戻してから識別を投入する。種類が変わったのに古い識別が残り、図鑑の別の種類に出続けることを防ぐ

### 7.5 残すと決めた食い違い

| 食い違い | 残す理由 |
|---|---|
| 孤児 Blob（掃除のタイマーが入る段階3まで） | 容量の費用だけで、利用者からは見えない。名前から機械的に見つけられる |
| 旅行の二重作成（応答が届かず押し直したとき） | 見えるし、空の旅行を消せば直る。クライアントが id を振る形は段階2の契約を広げるので、起きて困ってから |
| 写真の削除と送信の競合で Blob の無い文書が残る | 1人で使う限り実質起きない。掃除のタイマーが検出してログに出す |
| 旅行の削除と送信・move の競合で、消えた旅行を指す写真が残る（段階3の掃除が入るまで見えない） | まれで、写真は消えない。掃除のタイマー（§7.2）が入れば未所属に戻る。めったに起きないケースのために未所属の定義や削除の手順を増やさない（§7.3） |
