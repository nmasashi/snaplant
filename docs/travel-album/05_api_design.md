# 旅行アルバム API 設計

## この文書の位置づけ

旅行アルバムの REST API を書く。書き方は [docs/06_api_design.md](../06_api_design.md)（実装の写し）に合わせ、
エラーの契約（ステータス・`code`・`message`）は文言まで決める。**未実装を含む目指す姿**で、
実装したエンドポイントは `docs/06_api_design.md`・`docs/06_api_openapi.yaml`・`README.md` のエンドポイント表へ取り込む（開発中はこの一式を正として都度直し、取り込みは機能が固まってから後でまとめて行う。2026-10-12 に人間が決定）。

データの形は [04_data_design.md](./04_data_design.md)、裏の処理は [06_processing_design.md](./06_processing_design.md)、
画面からの使い方は [03_screen_design.md](./03_screen_design.md) を参照する。
エラーの `message`・検証の順序・上限値は第3版に無く、この文書で既存の流儀（`docs/06_api_design.md` §5.4・§5.8）に合わせて決めた。

---

## 1. 基本方針

既存の API と同じ。

- 全エンドポイントは `authLevel: 'function'`。`?code={FUNCTION_KEY}` が要る。`routePrefix` は `api`
- 応答は封筒 `{ success: true, data }` / `{ success: false, error: { code, message, details? } }`。`utils/response.ts` のヘルパー経由で作る
- **契約はステータス・`code`・`message` まで。`details` は契約外**（CLAUDE.md「レスポンス規約」）
- 入力検証は上から順に行い、最初に失敗した1件だけを返す。**Cosmos DB・Blob に触る前に全部弾く**
- Cosmos DB へ接続できない → 503 `DATABASE_ERROR`（`データベースに接続できません`）。判定は `isConnectivityError()`（`hasCauseCode()` を使う述語を新設。既存6箇所の複製を増やさない）
- Blob Storage の失敗 → `UpstreamError('storage')` → 502 / 503 `STORAGE_ERROR`（既存の `message`）。AI の失敗は段階3以降で `'ai'`。
  **Storage Queue への投入の失敗は応答を変えない**（ログだけ出して成功を返す。写真は保存済みで、タイマーが拾う。[04 §7](./04_data_design.md#7-整合性途中で失敗したら何が残るか)）
- 複数の文書や Blob にまたがる操作は、途中で止まったときに何が残り、どう直るかを [04 §7](./04_data_design.md#7-整合性途中で失敗したら何が残るか) に表で書いてある。
  各エンドポイントの書く順はそれに従う
- それ以外 → 500 `INTERNAL_ERROR`（エンドポイントごとの固定 `message`。§7.2）
- 401 / 429 は Functions ランタイムが封筒なしで返す（既存と同じ）
- ログには `photoId`・`tripId`・件数だけを出し、`placeName`・`comment`・`hint`・ファイル名は出さない（`docs/09_backlog.md`「マスキングが無い」を新ハンドラでは踏まない）

## 2. エンドポイント一覧

| ルート | メソッド | `data` の中身 | 備考 | 段階 | ファイル（`api/src/functions/`） |
|---|---|---|---|---|---|
| `/api/trips` | POST | `{ trip }` 201 | `{ name, description? }` | 2 | `trips.ts` |
| `/api/trips` | GET | `{ trips, total, unassignedPhotoCount }` | 各旅行に `photoCount`・`firstTakenAt`・`lastTakenAt`・`coverThumbnailUrl`。`createdAt` 降順。旅行に属さない写真の枚数も返す | 2 | `trips.ts` |
| `/api/trips/{tripId}` | GET | `{ trip }` | 集計付き | 2 | `tripDetail.ts` |
| `/api/trips/{tripId}` | PUT | `{ trip }` | `{ name, description? }` | 2 | `tripDetail.ts` |
| `/api/trips/{tripId}` | DELETE | `{ message, deletedPhotoCount, detachedPhotoCount }` | `deletePhotos=true|false`（必須）。`true` なら中の写真と Blob も消す、`false` なら写真を未所属に移す | 2 | `tripDetail.ts` |
| `/api/photos` | POST | `{ photo, urlExpiresAt }` 201（新規）/ 200（既存） | multipart。`tripId` は任意（送り方 ①②） | 2 | `photos.ts` |
| `/api/photos` | GET | `{ photos, continuationToken, urlExpiresAt }` | `tripId=<uuid>` か `tripId=none`。段階3で `category=`。`sortAt` 昇順（撮影日時順、無い写真はアップロード日時）。`limit` と `continuationToken` でページ | 2 | `photos.ts` |
| `/api/photos/move` | POST | `{ moved, notFound }` | `{ photoIds, tripId }`。送り方 ③ と「外す」。1回 200 件まで | 2 | `photoMove.ts` |
| `/api/photos/{photoId}` | GET | `{ photo, urlExpiresAt }` | | 2 | `photoDetail.ts` |
| `/api/photos/{photoId}` | DELETE | `{ message }` | | 2 | `photoDetail.ts` |
| `/api/photos/{photoId}` | PATCH | `{ photo, urlExpiresAt }` | `{ comment?, tags? }`。構造は2、画面は4 | 2 | `photoDetail.ts` |
| `/api/photos/{photoId}/process` | POST | `{ photo }` 202 | `{ step, hint? }`。写真に `step`・`hint` を書いてキューに投入 | 3（`identify` は4） | `photoProcess.ts` |
| `/api/tags` | GET | `{ tags }` | 利用者のタグの `DISTINCT` | 未定（タグを付ける画面と一緒） | `tags.ts` |
| `/api/catalog/kinds` | GET | `{ kinds }` | 定義表から | 4 | `catalogKinds.ts` |
| `/api/catalog/entries` | GET | `{ entries, total }` | `kind=` 必須。`GROUP BY` で数え、項目ごとに見出しの写真を1枚読む。`offset` / `limit` でページ。各項目に `photoCount`・`coverThumbnailUrl` | 4 | `catalogEntries.ts` |
| `/api/catalog/entry` | GET | `{ entry, photos, continuationToken, urlExpiresAt }` | `kind=` と `name=`（URL エンコード）で1件を指定。該当する写真が無ければ `entry: null`。`photos` は `GET /api/photos` と同じページング | 4 | `catalogEntry.ts` |

図鑑の項目は文書として持たず、写真の `identification` からまとめる（[04 §3](./04_data_design.md#3-図鑑の項目と定義表段階4)）。
そのため項目の id は無く、項目は `kind` と `name` で指定する。項目を削除する API は置かない。項目は写真の集まりに過ぎず、
「この項目を消す」に当たる操作は、写真を消す（`DELETE /api/photos/{photoId}`）か、識別をやり直す（`process`。要件 5.5.1）で足りる。

- `plants/{id}` と同じく、同じルートを複数ファイルが別々のメソッドで登録してよいが、ここでは `photoDetail.ts` が GET / DELETE / PATCH を、
  `tripDetail.ts` が GET / PUT / DELETE をまとめて登録する（`plantDetail.ts` 121〜134行の形）
- **新しい関数ファイルは `api/src/app.ts` に import を足す**（足さないと登録されない）
- `/api/photos/move` と `/api/photos/{photoId}` は、メソッドが違う（POST と GET / DELETE / PATCH）うえ、リテラルのセグメントは変数より優先されると思われる（推測）。
  デプロイ後に `POST /api/photos/move` が `photoMove.ts` に届くことを手で確認する。届かなければ `/api/photo-moves` に変える
- `PATCH` は `HttpMethod` として Functions v4 が受け付ける（`methods: ['PATCH']`）

写真は旅行の下（`/api/trips/{tripId}/photos`）ではなく `/api/photos` を主にする。写真はどの旅行にも属さなくてよく、旅行を移るため。

## 3. データモデル

応答に出す項目は、ドキュメント（[04 §1](./04_data_design.md#1-cosmos-db)）から**サービスが詰め替える**。
Cosmos のシステム項目（`_rid` / `_self` / `_etag` / `_attachments` / `_ts`）と `type` は出さない。

### 3.1 Trip

```json
{
  "id": "123e4567-e89b-42d3-a456-426614174000",
  "name": "北海道 2026秋",
  "description": null,
  "tags": [],
  "createdAt": "2026-10-04T09:00:00.000Z",
  "updatedAt": "2026-10-04T09:00:00.000Z"
}
```

### 3.2 TripSummary（`GET /api/trips`・`GET /api/trips/{tripId}`）

`Trip` に次を足したもの。

| 項目 | 型 | 説明 |
|---|---|---|
| `photoCount` | integer | 写真の枚数 |
| `firstTakenAt` / `lastTakenAt` | string \| null | 撮影日時のある写真の最初と最後（タイムゾーン無し）。無ければ `null` |
| `coverThumbnailUrl` | string \| null | `sortAt` 順（撮影日時順）で先頭の写真のサムネイル（無ければ原寸）の SAS 付き URL。写真が無ければ `null`。旅行ごとに `TOP 1` で1枚だけ読む |

### 3.3 Photo

```json
{
  "id": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "tripId": null,
  "imageUrl": "https://<account>.blob.core.windows.net/photos/9f86…a08.jpg?sv=…&sig=…",
  "thumbnailUrl": "https://<account>.blob.core.windows.net/photos/9f86…a08.thumb.jpg?sv=…&sig=…",
  "contentType": "image/jpeg",
  "fileSize": 1234567,
  "takenAt": "2026-10-05T12:30:15",
  "takenAtSource": "exif",
  "sortAt": "2026-10-05T12:30:15",
  "location": { "latitude": 43.7706, "longitude": 142.365, "placeName": "北海道旭川市", "placeSource": "device" },
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

ドキュメントとの違い: `blobName` / `thumbnailBlobName` の代わりに `imageUrl` / `thumbnailUrl`（SAS 付き。§6）。`thumbnailUrl` はサムネイルが無ければ `null`。
`takenAt` は**タイムゾーン無し**の文字列のまま返す（クライアントは変換しない）。`sortAt`（並べ替え用。[04 §1.3](./04_data_design.md#13-写真type-photo)）もそのまま返す（クライアントは表示に使わない）。
`category` は AI の大分類（`plant` / `food` / `landscape` / `other`、分類前は `null`）、`tags` は利用者のタグだけ（[04 §2](./04_data_design.md#2-カテゴリとタグ)）。
`identification`（段階4）はドキュメントのまま返す（`{ kind, matchesKind, name, confidence, description, characteristics, attributes, reason, model, at }`。[04 §3.1](./04_data_design.md#31-項目は写真からまとめる)）。
クライアントは `identification.kind` と `identification.name` で図鑑の項目（§5.14）へ飛ぶ。

### 3.3.1 CatalogEntry（段階4）

写真をまとめて導く項目（[04 §3.1](./04_data_design.md#31-項目は写真からまとめる) の表）。

```json
{
  "kind": "plant",
  "name": "ソメイヨシノ",
  "confidence": 92,
  "description": "日本で最も広く植えられているサクラの栽培品種。",
  "characteristics": "淡い桃色の花を葉より先に咲かせる",
  "attributes": { "scientificName": "Prunus × yedoensis", "familyName": "バラ科" },
  "photoCount": 3,
  "coverThumbnailUrl": "https://<account>.blob.core.windows.net/photos/9f86…a08.thumb.jpg?sv=…&sig=…"
}
```

`confidence` 以下 `attributes` までは、その名前の写真のうち信頼度が最も高いものの `identification` から取る。`coverThumbnailUrl` はその写真のサムネイル（無ければ原寸）。

### 3.4 Error

既存と同じ（`docs/06_api_design.md` §4.3）。

## 4. 入力検証の定数

`api/src/constants/validation.ts` に既存と同じ形（`positiveIntFromEnv()`、`ERROR_MESSAGES` に上限値を埋め込む）で追加する。
**正の整数として読めない値は既定値にフォールバックする**（既存の方針）。
環境変数・コードの定数・クライアントの定数を1か所にまとめた一覧は [07 §6](./07_infrastructure_design.md#6-設定値の一覧)。ここには入力検証に使うものだけを挙げる。

| 定数 | 環境変数 | 既定値 | 使う所 |
|---|---|---|---|
| `PHOTO_VALIDATION.PAGE_SIZE` / `MAX_PAGE_SIZE` | `PHOTO_PAGE_SIZE` / `PHOTO_MAX_PAGE_SIZE` | 100 / 200 | `GET /api/photos`・`GET /api/catalog/entry` の `limit` |
| `CATALOG_VALIDATION.PAGE_SIZE` / `MAX_PAGE_SIZE` | `CATALOG_PAGE_SIZE` / `CATALOG_MAX_PAGE_SIZE` | 50 / 100 | `GET /api/catalog/entries` の `limit` |
| `TRIP_VALIDATION.MAX_LENGTH.NAME` | `TRIP_NAME_MAX_LENGTH` | 100 | `POST` / `PUT /api/trips` |
| `TRIP_VALIDATION.MAX_LENGTH.DESCRIPTION` | `TRIP_DESCRIPTION_MAX_LENGTH` | 1000 | 同上 |
| `PHOTO_VALIDATION.ID_REGEX` | — | `/^[0-9a-f]{64}$/`（小文字のみ） | 写真 id を受けるすべて |
| `PHOTO_VALIDATION.TAKEN_AT_REGEX` | — | `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/`（加えて実在する日時であること） | `POST /api/photos` |
| `PHOTO_VALIDATION.MAX_LENGTH.PLACE_NAME` | `PHOTO_PLACE_NAME_MAX_LENGTH` | 100 | `POST /api/photos` |
| `PHOTO_VALIDATION.MAX_LENGTH.COMMENT` | `PHOTO_COMMENT_MAX_LENGTH` | 500 | `PATCH /api/photos/{photoId}` |
| `PHOTO_VALIDATION.THUMBNAIL_MAX_SIZE` | `THUMBNAIL_MAX_SIZE` | 1048576（1MB） | `POST /api/photos` |
| `MOVE_VALIDATION.MAX_IDS` | `MOVE_MAX_IDS` | 200 | `POST /api/photos/move` |
| `TAG_VALIDATION.MAX_LENGTH` | `TAG_MAX_LENGTH` | 30 | `PATCH /api/photos/{photoId}` |
| `FILE_UPLOAD.MAX_SIZE`・`SUPPORTED_IMAGE_TYPES`（既存） | `MAX_FILE_SIZE` | 10MB | `POST /api/photos` の原寸 |
| `CONTEXT_INFO_VALIDATION.MAX_LENGTH`（既存） | `CONTEXT_INFO_MAX_LENGTH` | 500 | `process` の `hint` |
| `PHOTO_SAS_EXPIRY_MINUTES`（`utils/blobSas.ts`） | `PHOTO_SAS_EXPIRY_MINUTES` | 60 | §6 |
| `GENERAL_VALIDATION.UUID_REGEX`（既存） | — | | 旅行 id |

文字数は既存と同じく `String.length`（UTF-16 コードユニット）で数える（`docs/09_backlog.md`「contextInfo の文字数の数え方」と同じ扱い）。

## 5. API 詳細仕様

### 5.1 `POST /api/photos`

写真を1枚保存する。**冪等**で、同じ写真（同じ `photoId`）を何度送っても1枚になる。

**リクエスト（`multipart/form-data`）:**

| パート | 種類 | 必須 | 内容 |
|---|---|---|---|
| `photoId` | テキスト | ○ | 画像のバイト列の SHA-256（16進・小文字 64 文字）。サーバが計算し直して照合する |
| `image` | ファイル | ○ | 原寸。`image/jpeg` / `image/jpg` / `image/png` / `image/webp` / `image/gif`、10MB 以下 |
| `thumbnail` | ファイル | × | サムネイル（JPEG）。1MB 以下。無ければ `thumbnailUrl: null` |
| `tripId` | テキスト | × | 送り先の旅行（UUID）。無ければ旅行に属さない写真 |
| `takenAt` | テキスト | × | 撮影日時 `YYYY-MM-DDTHH:mm:ss`（タイムゾーン無し） |
| `latitude` / `longitude` | テキスト | × | 緯度・経度（10進）。**両方そろったときだけ**位置情報として扱う |
| `placeName` | テキスト | × | 地名。緯度・経度と一緒に送る。1〜100 文字 |

`takenAtSource` は受け取らない。サーバが `takenAt` の有無から `exif` / `none` を入れる。
`sortAt` もサーバが決める（`takenAt` があればそれ、無ければ `uploadedAt` を日本時間に直したもの。[04 §1.3](./04_data_design.md#13-写真type-photo)）。`category` は `null`、`tags` は `[]` で作る。

**処理の順序:**

1. 入力検証（下の表。Blob・Cosmos に触らない）
2. `image` のバイト列の SHA-256 を計算し、`photoId` と一致しなければ 400
3. `tripId` があれば旅行を読み、無ければ 404 `TRIP_NOT_FOUND`
4. `item(photoId, photoId).read()`。既にあれば **200** で既存を返す（Blob には触らない。`tripId` も変えない）
5. 原寸を `photos/<photoId><拡張子>` に上書きアップロード。サムネイルがあれば `photos/<photoId>.thumb.jpg` に上書き
6. ドキュメントを `create`。409（4 と 5 の間に並行リクエストが作った）なら既存を読んで 200
7. **201** で `{ photo, urlExpiresAt }`

`tripId` を付けて送ったが既存だった（`tripId: null` または別の旅行）とき: 既存をそのまま 200 で返し、旅行は変えない。
送信は「入れる」ではなく「送る」で、入れたければ `move` を使う。クライアントは応答の `tripId` が送ったものと違えば
「送信済み（別の場所）」と扱う（[03 §4.7](./03_screen_design.md#47-写真の追加と送信の進み具合)）。

#### 入力検証（400 / 413 / 415）

| 順 | 条件 | ステータス・コード | `message` |
|----|------|-------------------|-----------|
| 1 | リクエストの Content-Type が `multipart/form-data` で始まらない | 400 `INVALID_REQUEST` | `Content-Typeがmultipart/form-dataではありません` |
| 2 | `photoId` が未指定・空（ファイルとして送られた場合を含む） | 400 `INVALID_REQUEST` | `写真IDが指定されていません` |
| 3 | `photoId` が小文字16進 64 文字でない | 400 `INVALID_REQUEST` | `写真IDの形式が無効です` |
| 4 | `image` が未指定、またはテキストフィールドで送られた | 400 `INVALID_REQUEST` | `画像ファイルが指定されていません` |
| 5 | `image` の Content-Type が対応形式でない | 415 `UNSUPPORTED_MEDIA_TYPE` | `サポートされていない画像形式です` |
| 6 | `image` が 0 バイト | 400 `INVALID_REQUEST` | `画像ファイルが空です` |
| 7 | `image` が `MAX_FILE_SIZE` を超える | 413 `FILE_TOO_LARGE` | `ファイルサイズが大きすぎます` |
| 8 | `thumbnail` があり、ファイルでない | 400 `INVALID_REQUEST` | `サムネイルはファイルで送信してください` |
| 9 | `thumbnail` の Content-Type が対応形式でない | 415 `UNSUPPORTED_MEDIA_TYPE` | `サポートされていない画像形式です` |
| 10 | `thumbnail` が 0 バイト | 400 `INVALID_REQUEST` | `サムネイルが空です` |
| 11 | `thumbnail` が `THUMBNAIL_MAX_SIZE` を超える | 413 `FILE_TOO_LARGE` | `サムネイルのサイズが大きすぎます` |
| 12 | `tripId` があり、UUID 形式でない | 400 `INVALID_REQUEST` | `旅行IDの形式が無効です` |
| 13 | `takenAt` があり、`YYYY-MM-DDTHH:mm:ss` でないか実在しない日時 | 400 `INVALID_REQUEST` | `撮影日時の形式が無効です` |
| 14 | `latitude` と `longitude` の片方だけがある | 400 `INVALID_REQUEST` | `緯度と経度は両方指定してください` |
| 15 | `latitude` / `longitude` が数値でない、または範囲外（緯度 -90〜90、経度 -180〜180） | 400 `INVALID_REQUEST` | `位置情報の形式が無効です` |
| 16 | `placeName` があり、緯度・経度が無い | 400 `INVALID_REQUEST` | `地名は緯度・経度と一緒に指定してください` |
| 17 | `placeName` が空白のみ、または 100 文字を超える | 400 `INVALID_REQUEST` | `地名は100文字以内で指定してください` |
| 18 | `image` の SHA-256 が `photoId` と一致しない | 400 `INVALID_REQUEST` | `写真IDが画像の内容と一致しません` |

1〜7 は `upload.ts` 23〜70行と同じ順序・同じ `message`。`details` は既存に倣って付けるが契約外。
18 はバイト列を読む必要があるので最後。空白だけの `placeName` は「指定なし」ではなく 400 にする（クライアントは null を送るか省く）。

#### 検証の後

| 条件 | ステータス・コード | `message` |
|---|---|---|
| `tripId` の旅行が無い | 404 `TRIP_NOT_FOUND` | `指定された旅行が見つかりません` |
| Blob の操作の失敗 | 502 / 503 `STORAGE_ERROR` | 既存の `message` |
| Cosmos へ接続できない | 503 `DATABASE_ERROR` | `データベースに接続できません` |
| それ以外 | 500 `INTERNAL_ERROR` | `写真の保存に失敗しました` |

**レスポンス例（201）:**

```json
{ "success": true, "data": { "photo": { "...": "§3.3 の Photo" }, "urlExpiresAt": "2026-10-10T04:12:45.000Z" } }
```

### 5.2 `GET /api/photos`

| クエリ | 必須 | 内容 | 段階 |
|---|---|---|---|
| `tripId` | 段階2では○ | 旅行の id（UUID）、または `none`（旅行に属さない写真） | 2 |
| `limit` | × | 1ページの枚数。既定 100、上限 200（`PHOTO_PAGE_SIZE` / `PHOTO_MAX_PAGE_SIZE`） | 2 |
| `continuationToken` | × | 前の応答の `continuationToken` をそのまま返す。無ければ先頭から | 2 |
| `category` | × | カテゴリ（`plant` / `food` / `landscape` / `other`）。`tripId` と両方あれば AND。`tripId` 無しなら旅行をまたぐ | 3 |

`tripId=none` は「`tripId` が `null` の写真」を返す（`IS_NULL(c.tripId)`。[04 §5.3](./04_data_design.md#53-旅行の写真一覧)）。
旅行の削除と送信・移動が重なって残った「存在しない旅行を指す写真」は含めない（段階3の掃除のタイマーが `null` に戻してから出る。[04 §7.3](./04_data_design.md#73-旅行の削除と重なった送信move)）。
図鑑の項目の写真は `GET /api/catalog/entry`（§5.14）で取る。

| 順 | 条件 | ステータス・コード | `message` |
|----|------|-------------------|-----------|
| 1 | `tripId`・`category` のどちらも無い | 400 `INVALID_REQUEST` | `絞り込み条件を指定してください` |
| 2 | `tripId` が `none` でも UUID でもない | 400 `INVALID_REQUEST` | `旅行IDの形式が無効です` |
| 3 | `category` があり、定義表のキーでも `other` でもない | 400 `INVALID_REQUEST` | `カテゴリが無効です` |
| 4 | `limit` があり、1〜200 の整数でない | 400 `INVALID_REQUEST` | `1ページの枚数は1〜200で指定してください` |
| 5 | `continuationToken` があり、空 | 400 `INVALID_REQUEST` | `継続トークンの形式が無効です` |
| 6 | `tripId` の旅行が無い | 404 `TRIP_NOT_FOUND` | `指定された旅行が見つかりません` |
| 7 | `continuationToken` を Cosmos が受け付けない（別の絞り込みのトークン、壊れた文字列。SDK が 400 を返す。推測） | 400 `INVALID_REQUEST` | `継続トークンの形式が無効です` |

並びは `sortAt` の昇順（撮影日時順。撮影日時が無い写真はアップロード日時を日本時間に直した位置。[04 §1.3](./04_data_design.md#13-写真type-photo)・[04 §5.3](./04_data_design.md#53-旅行の写真一覧)）。
**`total` は返さない**（数えるには別のクエリが要り、ページごとに数えるのは無駄。旅行の枚数は `GET /api/trips` / `GET /api/trips/{tripId}` の `photoCount`、未所属の枚数は `GET /api/trips` の `unassignedPhotoCount` で取る）。
`total` を外すことと、継続トークンをクエリパラメータで受け渡すことは**案**で、段階2の API の詳しい設計で決める（[02 §5](./02_design_overview.md#5-人間に決めてもらう点推奨付き) #27）。

```json
{ "success": true, "data": { "photos": [ { "...": "Photo" } ], "continuationToken": "<Cosmos の継続トークン。最後のページは null>", "urlExpiresAt": "2026-10-10T04:12:45.000Z" } }
```

- `continuationToken` は Cosmos が作る不透明な文字列で、クライアントは中身を見ず、次の要求の同じ名前のクエリに URL エンコードして載せる。`null` なら最後のページ
- トークンは同じ絞り込み（`tripId`・`category`）にだけ有効。絞り込みを変えるときは先頭から取り直す
- 各ページの `urlExpiresAt` は、そのページの URL の期限（ページごとに SAS を発行する）
- 500 の `message`: `写真一覧の取得に失敗しました`

### 5.3 `GET /api/photos/{photoId}`

| 順 | 条件 | ステータス・コード | `message` |
|----|------|-------------------|-----------|
| 1 | `photoId` が小文字16進 64 文字でない | 400 `INVALID_REQUEST` | `写真IDの形式が無効です` |
| 2 | 無い | 404 `PHOTO_NOT_FOUND` | `指定された写真が見つかりません` |

`{ photo, urlExpiresAt }`。500 の `message`: `写真詳細の取得に失敗しました`。

### 5.4 `DELETE /api/photos/{photoId}`

検証は 5.3 と同じ。ドキュメントを消してから原寸とサムネイルの Blob を消す。Blob の削除の失敗はログだけで 200（残った Blob は掃除のタイマーが消す。[04 §7.2](./04_data_design.md#72-掃除のタイマー段階3)）。
段階4でも図鑑側の後始末は無い（項目は写真からまとめるので、写真が消えれば項目からも消える）。

```json
{ "success": true, "data": { "message": "写真が正常に削除されました" } }
```

500 の `message`: `写真の削除に失敗しました`。

### 5.5 `POST /api/photos/move`

写真をまとめて旅行に入れる、または旅行から外す（`tripId: null`）。

**リクエスト:** `{ "photoIds": ["<photoId>", ...], "tripId": "<uuid>" | null }`

| 順 | 条件 | ステータス・コード | `message` |
|----|------|-------------------|-----------|
| 1 | ボディが JSON としてパースできない | 400 `INVALID_REQUEST` | `リクエストボディの形式が無効です` |
| 2 | ボディが `null` | 400 `INVALID_REQUEST` | `リクエストボディが指定されていません` |
| 3 | `photoIds` が配列でない | 400 `INVALID_REQUEST` | `写真IDは配列で指定してください` |
| 4 | `photoIds` が空 | 400 `INVALID_REQUEST` | `写真IDが指定されていません` |
| 5 | `photoIds` が 200 件を超える（重複を除く前の件数） | 400 `INVALID_REQUEST` | `一度に移動できる写真は200枚までです` |
| 6 | `photoIds` の要素に形式の合わないものがある | 400 `INVALID_REQUEST` | `写真IDの形式が無効です` |
| 7 | `tripId` が未指定（キーが無い） | 400 `INVALID_REQUEST` | `移動先の旅行が指定されていません` |
| 8 | `tripId` が `null` でも UUID でもない | 400 `INVALID_REQUEST` | `旅行IDの形式が無効です` |
| 9 | `tripId` の旅行が無い | 404 `TRIP_NOT_FOUND` | `指定された旅行が見つかりません` |

「旅行から外す」は `tripId: null` を明示する（キーを省くと 7 で 400。省略と null を区別し、取り違えを検出するため）。
重複した id は1つにまとめる。

処理: 各写真に `patch`（`tripId`・`updatedAt`）。404 なら `notFound` に入れて続ける。
それ以外の失敗は中断して 500（送れた分は移っている。再送しても同じ結果になるので、クライアントは押し直せばよい）。

```json
{ "success": true, "data": { "moved": ["<photoId>", "..."], "notFound": ["<photoId>"] } }
```

`moved` は移した id、`notFound` は無かった id。既にその旅行にあった写真も `moved` に入る（patch は無条件）。
500 の `message`: `写真の移動に失敗しました`。

### 5.6 `PATCH /api/photos/{photoId}`

利用者のコメントとタグを直す。構造は段階2で作り、画面は段階4（コメント）・未定（タグ）。

**リクエスト:** `{ "comment"?: string | null, "tags"?: string[] }`

| 順 | 条件 | ステータス・コード | `message` |
|----|------|-------------------|-----------|
| 1 | `photoId` の形式が無効 | 400 `INVALID_REQUEST` | `写真IDの形式が無効です` |
| 2 | ボディが JSON としてパースできない | 400 `INVALID_REQUEST` | `リクエストボディの形式が無効です` |
| 3 | ボディが `null` | 400 `INVALID_REQUEST` | `リクエストボディが指定されていません` |
| 4 | `comment` も `tags` も無い | 400 `INVALID_REQUEST` | `更新する項目が指定されていません` |
| 5 | `comment` が文字列でも `null` でもない | 400 `INVALID_REQUEST` | `コメントは文字列で指定してください` |
| 6 | `comment` が 500 文字を超える | 400 `INVALID_REQUEST` | `コメントは500文字以内で指定してください` |
| 7 | `tags` が配列でない | 400 `INVALID_REQUEST` | `タグは配列で指定してください` |
| 8 | `tags` の要素に文字列でないものがある | 400 `INVALID_REQUEST` | `タグは文字列で指定してください` |
| 9 | `tags` の要素に、前後の空白を除いて空か 30 文字を超えるものがある | 400 `INVALID_REQUEST` | `タグは1〜30文字で指定してください` |
| 10 | 写真が無い | 404 `PHOTO_NOT_FOUND` | `指定された写真が見つかりません` |

- `comment`: 文字列なら保存して `commentSource: "user"`。`null` なら消して `commentSource: null`。前後の空白は除く（除いて空なら `null` と同じ）
- `tags`: 利用者のタグを指定したものに**置き換える**。重複は除く。`category` は別の欄なので `tags` には混ざらず、サーバが選り分けて結合する処理は無い
- 書き込みは `comment`・`commentSource`・`tags`・`updatedAt` だけの patch（AI が書く欄には触らない。[04 §7.4](./04_data_design.md#74-ワーカーの書き込みの決まり)）。
  **解析中（`processing.state` が `pending` / `classifying` / `identifying`）でも受け付ける**（ロックは無い）
- 応答は `{ photo, urlExpiresAt }`。500 の `message`: `写真の更新に失敗しました`

### 5.7 `POST /api/photos/{photoId}/process`（段階3）

AI の解析をやり直す（要件 5.5.1）。

**リクエスト:** `{ "step": "classify" | "identify", "hint"?: string }`

| 順 | 条件 | ステータス・コード | `message` |
|----|------|-------------------|-----------|
| 1 | `photoId` の形式が無効 | 400 `INVALID_REQUEST` | `写真IDの形式が無効です` |
| 2 | ボディが JSON としてパースできない | 400 `INVALID_REQUEST` | `リクエストボディの形式が無効です` |
| 3 | ボディが `null` | 400 `INVALID_REQUEST` | `リクエストボディが指定されていません` |
| 4 | `step` が `classify` / `identify` でない（段階3では `identify` も不可） | 400 `INVALID_REQUEST` | `やり直す処理の種類が無効です` |
| 5 | `hint` が文字列でない | 400 `INVALID_REQUEST` | `補足情報は文字列で指定してください`（既存） |
| 6 | `hint` が 500 文字を超える | 400 `INVALID_REQUEST` | `補足情報は500文字以内で指定してください`（既存） |
| 7 | 写真が無い | 404 `PHOTO_NOT_FOUND` | `指定された写真が見つかりません` |
| 8 | `step: "identify"` だが写真のカテゴリが識別対象でない（`category` が `other` か `null`） | 400 `INVALID_REQUEST` | `この写真は識別の対象ではありません` |

処理の順:

1. 写真に patch: `processing = { state: "pending", step, attempts: 0, lastError: null, updatedAt: now }`（**`attempts` を 0 に戻す。** `failed` の写真をもう一度試せるのはこの操作だけ。[06 §1.3](./06_processing_design.md#13-状態と失敗)）、`hint`（無ければ `null`）、
   **`comment: null`・`commentSource: null`**（やり直しの結果で置き換えるため、受付の時点で消す。[02 §5](./02_design_overview.md#5-人間に決めてもらう点推奨付き) #9。
   利用者が書いたコメントは、アプリが `hint` に事前入力してから頼む設計なので失われない）。
   解析中（`pending` / `classifying` / `identifying`）の写真にも受け付ける（最新の依頼で上書きされ、走っている処理の結果は `state` の条件付き patch で捨てられるか、次の処理で上書きされる）。
   やり直しの回数に上限は置かない（費用は AI のデプロイの容量で抑える。[06 §6](./06_processing_design.md#6-費用の抑え方)）
2. キューに `{ photoId }` を投入する（`step`・`hint` はワーカーが写真から読む）
3. **202** `{ photo }`

投入に失敗してもログだけ出して 202 を返す（写真は `pending` のまま残り、タイマーが 10 分以内に `processing.step` を見て再投入する。
失敗を返すと「失敗したのに後で勝手に走る」ことになる。[04 §7.1](./04_data_design.md#71-操作ごとの表)）。
500 の `message`: `解析のやり直しの受付に失敗しました`。詳細は [06 §1](./06_processing_design.md#1-キューとワーカー段階3)。

### 5.8 `POST /api/trips`

**リクエスト:** `{ "name": string, "description"?: string | null }`

| 順 | 条件 | ステータス・コード | `message` |
|----|------|-------------------|-----------|
| 1 | ボディが JSON としてパースできない | 400 `INVALID_REQUEST` | `リクエストボディの形式が無効です` |
| 2 | ボディが `null` | 400 `INVALID_REQUEST` | `リクエストボディが指定されていません` |
| 3 | `name` が文字列でない | 400 `INVALID_REQUEST` | `旅行名は文字列で指定してください` |
| 4 | `description` が文字列でない（`null`・未指定は可） | 400 `INVALID_REQUEST` | `説明は文字列で指定してください` |
| 5 | `name` が未指定・`null`・空・空白のみ | 400 `INVALID_REQUEST` | `旅行名が指定されていません` |
| 6 | `name` が前後の空白を除いて 100 文字を超える | 400 `INVALID_REQUEST` | `旅行名は100文字以内で指定してください` |
| 7 | `description` が 1000 文字を超える | 400 `INVALID_REQUEST` | `説明は1000文字以内で指定してください` |

`name` は前後の空白を除いて保存。`description` はそのまま（空文字は `null` にする）。`tags` は `[]`。201 `{ trip }`（§3.1）。
500 の `message`: `旅行の作成に失敗しました`。

### 5.9 `GET /api/trips`

`{ trips: TripSummary[], total, unassignedPhotoCount }`。`createdAt` 降順。`total` は旅行の数。
集計は [04 §5.1](./04_data_design.md#51-旅行一覧)（枚数と期間は `GROUP BY`、表紙は旅行ごとの `TOP 1`。写真を全部読まない）。
`unassignedPhotoCount` は旅行に属さない写真の枚数（`tripId` が `null` のもの。`GET /api/photos?tripId=none` が返す枚数と同じ定義）で、
同じ `GROUP BY` の結果から出す。旅行一覧の画面はこれで先頭の行の枚数を出し、別のリクエストを送らない。ページングは無い（旅行は数十件）。
未所属の枚数をここで返すことは #27 の案どおり実装した（PR 3。§5.2 の `total` を外すかは写真の API で決める）。表紙（`coverThumbnailUrl`）は写真の API（PR 4a）で足すまで常に `null`。
500 の `message`: `旅行一覧の取得に失敗しました`。

### 5.10 `GET /api/trips/{tripId}`

| 順 | 条件 | ステータス・コード | `message` |
|----|------|-------------------|-----------|
| 1 | `tripId` が UUID 形式でない | 400 `INVALID_REQUEST` | `旅行IDの形式が無効です` |
| 2 | 無い | 404 `TRIP_NOT_FOUND` | `指定された旅行が見つかりません` |

`{ trip: TripSummary }`。500 の `message`: `旅行詳細の取得に失敗しました`。

### 5.11 `PUT /api/trips/{tripId}`

`name`（必須）と `description`（任意）の全体置き換え。検証は `tripId` の形式（5.10 の 1）→ 5.8 の 1〜7 の順。無ければ 404 `TRIP_NOT_FOUND`。
`tags` は変えない。`{ trip }`（集計無し）。500 の `message`: `旅行の更新に失敗しました`。

### 5.12 `DELETE /api/trips/{tripId}?deletePhotos=true|false`

中の写真をどうするかを利用者が選ぶ（2026-10-12 に人間が決定。画面のダイアログは [03 §4.4](./03_screen_design.md#44-旅行詳細画面)）。

| クエリ | 必須 | 内容 |
|---|---|---|
| `deletePhotos` | ○ | `true`: 中の写真（ドキュメントと Blob）も消す。`false`: 写真は消さず、旅行に属さない写真（`tripId: null`）に移す |

必須にするのは、省略時の既定で写真が消える（または残る）事故を防ぐため。クライアントは必ず利用者の選択を載せる。

| 順 | 条件 | ステータス・コード | `message` |
|----|------|-------------------|-----------|
| 1 | `tripId` が UUID 形式でない | 400 `INVALID_REQUEST` | `旅行IDの形式が無効です` |
| 2 | `deletePhotos` が無い | 400 `INVALID_REQUEST` | `写真を削除するかどうかを指定してください` |
| 3 | `deletePhotos` が `true` / `false` でない | 400 `INVALID_REQUEST` | `写真を削除するかどうかの指定が無効です` |
| 4 | 無い | 404 `TRIP_NOT_FOUND` | `指定された旅行が見つかりません` |

処理の順（[04 §7.1](./04_data_design.md#71-操作ごとの表)）:

1. 中の写真の射影をページで読み（[04 §5](./04_data_design.md#5-クエリ) の 5.10）、1枚ずつ、`true` ならドキュメント → Blob の順に消す（Blob の失敗はログだけ）、`false` なら `tripId` を `null` に patch する（move の「外す」と同じ）
2. 写真のドキュメントの削除・patch に失敗したら中断して 500（済んだ分はそのまま。再送で続きができる）
3. 旅行を消す

旅行を消した後の見直しはしない。削除の途中に届いた送信・move の写真が残っても消さず（`deletePhotos=true` でも、1 で読んだ射影に無かった写真は消さない）、
段階3の掃除のタイマーが未所属に戻す（まれで、写真は消えないので許容。[04 §7.3](./04_data_design.md#73-旅行の削除と重なった送信move)）。

```json
{ "success": true, "data": { "message": "旅行が正常に削除されました", "deletedPhotoCount": 12, "detachedPhotoCount": 0 } }
```

`deletedPhotoCount` は消した写真の数（`false` なら 0）、`detachedPhotoCount` は未所属に移した数（`true` なら 0）。
500 の `message`: `旅行の削除に失敗しました`。

### 5.13 `GET /api/tags`（段階は未定）

`{ tags: string[] }`。写真の `tags`（利用者のタグ）の `DISTINCT`。文字列順。タグを付ける画面を入れる段階で一緒に入れる（カテゴリは `GET /api/catalog/kinds` + `other` で分かるので、ここには含めない）。
500 の `message`: `タグ一覧の取得に失敗しました`。

### 5.14 図鑑（段階4）

**この節は案で、決定ではない。** API の形（項目を `kind` と `name` で指定して名前をクエリ文字列に載せること、該当する写真が無いときに 200 で `entry: null` を返すこと、
項目一覧を `offset` / `limit`・項目の写真を `continuationToken` でページに分けること、項目の削除 API を置かないこと）は、段階4の詳しい設計で決める
（[02 §5](./02_design_overview.md#5-人間に決めてもらう点推奨付き) #20）。§2 の表と §3.3.1・§7.1・§8 の図鑑の記述も同じ扱い。
まとめ方そのもの（`GROUP BY` + 項目ごとの `TOP 1`。[04 §5.6](./04_data_design.md#56-図鑑のまとめ段階4)）は決定済み（#28）。

項目は文書ではなく、識別済みの写真を `identification.kind` と `identification.name` でまとめたもの（[04 §3.1](./04_data_design.md#31-項目は写真からまとめる)）。
一覧も詳細も、呼ばれるたびに写真からまとめるが、**写真を全部読まない**（枚数は `GROUP BY`、見出しは項目ごとに `TOP 1`、写真はページ）。

| エンドポイント | 内容 | エラー |
|---|---|---|
| `GET /api/catalog/kinds` | `{ kinds: [{ kind, label, fields: [{ key, label, type }] }] }`。定義表から。DB に触らない | 500 `図鑑の種類の取得に失敗しました` |
| `GET /api/catalog/entries?kind=&offset=&limit=` | `{ entries: CatalogEntry[], total }`（§3.3.1）。`kind` 必須、定義表に無ければ 400 `図鑑の種類が無効です`。`name` の文字列順に並べ、`offset`（既定 0）から `limit`（既定 50、上限 100。`CATALOG_PAGE_SIZE` / `CATALOG_MAX_PAGE_SIZE`）件。`total` は項目の総数（ページに依らない）。0 件なら `[]`・`0`。`offset` / `limit` が 0 以上・1〜100 の整数でなければ 400 `ページの指定が無効です` | 500 `図鑑の一覧の取得に失敗しました` |
| `GET /api/catalog/entry?kind=&name=&limit=&continuationToken=` | `{ entry: CatalogEntry \| null, photos, continuationToken, urlExpiresAt }`。`photos` はその名前の写真の1ページ（`sortAt` 順。`limit` / `continuationToken` は §5.2 と同じ）。`entry.photoCount` は `COUNT` で数えた総数。該当する写真が無ければ **200** で `entry: null`・`photos: []`・`continuationToken: null` | 500 `図鑑の項目の取得に失敗しました` |

項目一覧のページを `offset` / `limit` にするのは、`GROUP BY` の結果（項目の行）をサーバで名前順に並べてから切るためで、Cosmos の継続トークンが使えない。
項目の行は小さいので、ページごとに `GROUP BY` をやり直しても読む量は写真の枚数に依らない（[04 §3.1](./04_data_design.md#31-項目は写真からまとめる) の「規模の注意」）。

`GET /api/catalog/entry` の検証（順に。最初に失敗した1件だけ返す）:

| 順 | 条件 | ステータス・コード | `message` |
|----|------|-------------------|-----------|
| 1 | `kind` が無い、または定義表に無い | 400 `INVALID_REQUEST` | `図鑑の種類が無効です` |
| 2 | `name` が無い、または前後の空白を除いて空 | 400 `INVALID_REQUEST` | `図鑑の項目の名前が指定されていません` |
| 3 | `name` が前後の空白を除いて 100 文字を超える | 400 `INVALID_REQUEST` | `図鑑の項目の名前は100文字以内で指定してください` |

- **名前はクエリ文字列に URL エンコードして載せる**（Dart は `Uri.encodeQueryComponent()`、Functions の `request.query.get('name')` が復号する）。
  パスのセグメント（`/entries/{kind}/{name}`）にしないのは、名前に `/`・`?`・`#` が入りうる（例: 「サーモン/イクラ丼」）ためで、
  `%2F` をルーティングの前に復号するかどうかが Functions の実装に依存する（推測）。クエリ文字列ならその不確かさが無い。100 文字の名前でもエンコード後 1 KB 弱で、URL の長さの上限には届かない
- 名前は `trim()` してから `identification.name` と完全一致で比べる（NFKC は当面入れない。[02 §5](./02_design_overview.md#5-人間に決めてもらう点推奨付き) #7）
- 0 枚のときに 404 ではなく 200 を返すのは、項目が文書ではなく「該当する写真が 0 枚」に過ぎないため。やり直しで名前が変わった直後に古い項目の画面を開いたときに起きる。
  404 にすると `code` を新設することになる（人間の決定で `ENTRY_NOT_FOUND` は置かない）。アプリは「この項目には写真がありません」と出す（[03 §6.2](./03_screen_design.md#62-図鑑の項目詳細画面)）

## 6. SAS 付き URL

| 項目 | 値 | 理由 |
|---|---|---|
| 対象 | Blob 単位（原寸・サムネイルそれぞれ） | コンテナ単位の SAS は「見せたい写真」より広い。段階2は本人だけだが、共有を足すときに写真単位で出せる形にしておく |
| 権限 | 読み取りのみ | |
| 有効期限 | 発行から 60 分（`PHOTO_SAS_EXPIRY_MINUTES`） | 旅行詳細を開いて眺める時間として十分で、ログに残っても長期間は読めない |
| `startsOn` | 発行の 5 分前 | サーバと Blob の時計のずれで「まだ有効でない」になるのを防ぐ |
| 応答 | 各 URL と、まとめて `urlExpiresAt`（ISO, UTC） | クライアントが期限を知って取り直せる |

- 生成は `utils/blobSas.ts`（`storageService.ts` 244〜286行の切り出し）。`generateTempSasUrl()` はこれを呼ぶ薄い包みにし、既存の `upload` の振る舞いを変えない
- 1応答で数百枚分を生成するが、SAS の生成はローカルの署名計算だけで Blob へは通信しない
- URL をクライアントから受け取る API は無い。クライアントは `cacheKey` に `photo-<id>` / `thumb-<id>` を使い、URL の変化に影響されない
- 期限切れの URL は Blob が 403 を返す。クライアントは一覧を取り直す

## 7. エラー

### 7.1 エラーコード一覧（追加分）

| HTTP | `code` | 説明 | 返す箇所 |
|---|---|---|---|
| 404 | `TRIP_NOT_FOUND` | 旅行が見つからない | `/api/trips/{tripId}` 系、`POST /api/photos`（`tripId` 付き）、`GET /api/photos?tripId=`、`POST /api/photos/move` |
| 404 | `PHOTO_NOT_FOUND` | 写真が見つからない | `/api/photos/{photoId}` 系 |
| 400 / 413 / 415 / 500 / 502 / 503 | 既存のコード | 既存と同じ意味 | |

図鑑の項目は文書ではないので `ENTRY_NOT_FOUND` は置かない（該当する写真が無ければ 200 で `entry: null`。§5.14）。

`createNotFoundError(message, code = ErrorCode.PLANT_NOT_FOUND)` と第2引数を足す。

### 7.2 500 `INTERNAL_ERROR` の `message`

| エンドポイント | `message` |
|---|---|
| `POST /api/trips` | `旅行の作成に失敗しました` |
| `GET /api/trips` | `旅行一覧の取得に失敗しました` |
| `GET /api/trips/{tripId}` | `旅行詳細の取得に失敗しました` |
| `PUT /api/trips/{tripId}` | `旅行の更新に失敗しました` |
| `DELETE /api/trips/{tripId}` | `旅行の削除に失敗しました` |
| `POST /api/photos` | `写真の保存に失敗しました` |
| `GET /api/photos` | `写真一覧の取得に失敗しました` |
| `GET /api/photos/{photoId}` | `写真詳細の取得に失敗しました` |
| `DELETE /api/photos/{photoId}` | `写真の削除に失敗しました` |
| `PATCH /api/photos/{photoId}` | `写真の更新に失敗しました` |
| `POST /api/photos/move` | `写真の移動に失敗しました` |
| `POST /api/photos/{photoId}/process` | `解析のやり直しの受付に失敗しました` |
| `GET /api/tags` | `タグ一覧の取得に失敗しました` |
| `GET /api/catalog/*` | §5.14 |

### 7.3 502 / 503

既存の `createUpstreamErrorResponse()` をそのまま使う。Storage Queue は Blob と同じストレージアカウントなので `'storage'` に含める。
段階3で `'ai'`（分類・識別）、Azure Maps を入れるなら `'geocoding'`（`message`: `地名変換サービスに接続できません` / `地名変換サービスでエラーが発生しました`）を足す。

## 8. クライアント（`mobile/lib/services/api_service.dart`）に足すメソッド

| メソッド | エンドポイント | 封筒の `data` から読む |
|---|---|---|
| `createTrip(name, description)` | `POST /api/trips` | `data['trip']` |
| `getTrips()` | `GET /api/trips` | `data['trips']`・`data['total']`・`data['unassignedPhotoCount']` |
| `getTrip(tripId)` | `GET /api/trips/{tripId}` | `data['trip']` |
| `updateTrip(tripId, name, description)` | `PUT /api/trips/{tripId}` | `data['trip']` |
| `deleteTrip(tripId, {required bool deletePhotos})` | `DELETE /api/trips/{tripId}?deletePhotos=` | `data['deletedPhotoCount']`・`data['detachedPhotoCount']` |
| `uploadPhoto(...)` | `POST /api/photos` | `data['photo']`・`data['urlExpiresAt']`。201 / 200 を呼び出し側に返す |
| `getPhotos({tripId, category, limit, continuationToken})` | `GET /api/photos` | `data['photos']`・`data['continuationToken']`（null 可）・`data['urlExpiresAt']`。`continuationToken` は `Uri.encodeQueryComponent()` で載せる |
| `getPhoto(photoId)` | `GET /api/photos/{photoId}` | `data['photo']` |
| `deletePhoto(photoId)` | `DELETE /api/photos/{photoId}` | 読まない |
| `movePhotos(photoIds, tripId)` | `POST /api/photos/move` | `data['moved']`・`data['notFound']` |
| `updatePhoto(photoId, {comment, tags})` | `PATCH /api/photos/{photoId}` | `data['photo']` |

`_parseResponse()` はボディ全体をコールバックに渡すので、各メソッドが `json['data']` を剥がす（CLAUDE.md「クライアント実装で踏みやすい罠」）。
`ApiException` に `isTripNotFound`（`code == 'TRIP_NOT_FOUND'`）を足す。
段階4で足すもの: `getCatalogKinds()`（`data['kinds']`）、`getCatalogEntries(kind, {offset, limit})`（`data['entries']`・`data['total']`）、
`getCatalogEntry(kind, name, {limit, continuationToken})`（`data['entry']`（null 可）・`data['photos']`・`data['continuationToken']`・`data['urlExpiresAt']`。`name` は `Uri.encodeQueryComponent()`）。
