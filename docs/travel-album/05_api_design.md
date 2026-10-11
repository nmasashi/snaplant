# 旅行アルバム API 設計

## この文書の位置づけ

旅行アルバムの REST API を書く。書き方は [docs/06_api_design.md](../06_api_design.md)（実装の写し）に合わせ、
エラーの契約（ステータス・`code`・`message`）は文言まで決める。**未実装を含む目指す姿**で、
実装したエンドポイントはそのときに `docs/06_api_design.md`・`docs/06_api_openapi.yaml`・`README.md` のエンドポイント表へ取り込む。

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
- Blob Storage・Storage Queue の失敗 → `UpstreamError('storage')` → 502 / 503 `STORAGE_ERROR`（既存の `message`）。AI の失敗は段階3以降で `'ai'`
- それ以外 → 500 `INTERNAL_ERROR`（エンドポイントごとの固定 `message`。§7.2）
- 401 / 429 は Functions ランタイムが封筒なしで返す（既存と同じ）
- ログには `photoId`・`tripId`・件数だけを出し、`placeName`・`comment`・`hint`・ファイル名は出さない（`docs/09_backlog.md`「マスキングが無い」を新ハンドラでは踏まない）

## 2. エンドポイント一覧

| ルート | メソッド | `data` の中身 | 備考 | 段階 | ファイル（`api/src/functions/`） |
|---|---|---|---|---|---|
| `/api/trips` | POST | `{ trip }` 201 | `{ name, description? }` | 2 | `trips.ts` |
| `/api/trips` | GET | `{ trips, total }` | 各旅行に `photoCount`・`firstTakenAt`・`lastTakenAt`・`coverThumbnailUrl`。`createdAt` 降順 | 2 | `trips.ts` |
| `/api/trips/{tripId}` | GET | `{ trip }` | 集計付き | 2 | `tripDetail.ts` |
| `/api/trips/{tripId}` | PUT | `{ trip }` | `{ name, description? }` | 2 | `tripDetail.ts` |
| `/api/trips/{tripId}` | DELETE | `{ message, deletedPhotoCount }` | 中の写真と Blob も消す | 2 | `tripDetail.ts` |
| `/api/photos` | POST | `{ photo, urlExpiresAt }` 201（新規）/ 200（既存） | multipart。`tripId` は任意（送り方 ①②） | 2 | `photos.ts` |
| `/api/photos` | GET | `{ photos, total, urlExpiresAt }` | `tripId=<uuid>` か `tripId=none`。段階3で `tag=`、段階4で `entryId=`。撮影日時昇順、無しは末尾 | 2 | `photos.ts` |
| `/api/photos/move` | POST | `{ moved, notFound }` | `{ photoIds, tripId }`。送り方 ③ と「外す」。1回 200 件まで | 2 | `photoMove.ts` |
| `/api/photos/{photoId}` | GET | `{ photo, urlExpiresAt }` | | 2 | `photoDetail.ts` |
| `/api/photos/{photoId}` | DELETE | `{ message }` | | 2 | `photoDetail.ts` |
| `/api/photos/{photoId}` | PATCH | `{ photo, urlExpiresAt }` | `{ comment?, tags? }`。構造は2、画面は4 | 2 | `photoDetail.ts` |
| `/api/photos/{photoId}/process` | POST | `{ photo }` 202 | `{ step, hint? }`。キューに投入 | 3（`identify` は4） | `photoProcess.ts` |
| `/api/tags` | GET | `{ tags }` | `DISTINCT` で導く | 3 | `tags.ts` |
| `/api/catalog/kinds` | GET | `{ kinds }` | 定義表から | 4 | `catalogKinds.ts` |
| `/api/catalog/entries` | GET | `{ entries, total }` | `kind=` で絞る。各項目に `photoCount`・`coverThumbnailUrl` | 4 | `catalogEntries.ts` |
| `/api/catalog/entries/{entryId}` | GET | `{ entry, photos, urlExpiresAt }` | | 4 | `catalogEntryDetail.ts` |
| `/api/catalog/entries/{entryId}` | DELETE | `{ message }` | 写真の `entryId` を外すだけ（写真は消さない） | 4 | `catalogEntryDetail.ts` |

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
| `coverThumbnailUrl` | string \| null | 撮影日時順で先頭の写真のサムネイル（無ければ原寸）の SAS 付き URL。写真が無ければ `null` |

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
  "location": { "latitude": 43.7706, "longitude": 142.365, "placeName": "北海道旭川市", "placeSource": "device" },
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

ドキュメントとの違い: `blobName` / `thumbnailBlobName` の代わりに `imageUrl` / `thumbnailUrl`（SAS 付き。§6）。`thumbnailUrl` はサムネイルが無ければ `null`。
`takenAt` は**タイムゾーン無し**の文字列のまま返す（クライアントは変換しない）。

### 3.4 Error

既存と同じ（`docs/06_api_design.md` §4.3）。

## 4. 入力検証の定数

`api/src/constants/validation.ts` に既存と同じ形（`positiveIntFromEnv()`、`ERROR_MESSAGES` に上限値を埋め込む）で追加する。
**正の整数として読めない値は既定値にフォールバックする**（既存の方針）。

| 定数 | 環境変数 | 既定値 | 使う所 |
|---|---|---|---|
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
| `tag` | × | タグ（`category:plant` など）。`tripId` と両方あれば AND | 3 |
| `entryId` | × | 図鑑の項目の id | 4 |

| 順 | 条件 | ステータス・コード | `message` |
|----|------|-------------------|-----------|
| 1 | `tripId`・`tag`・`entryId` のどれも無い | 400 `INVALID_REQUEST` | `絞り込み条件を指定してください` |
| 2 | `tripId` が `none` でも UUID でもない | 400 `INVALID_REQUEST` | `旅行IDの形式が無効です` |
| 3 | `tripId` の旅行が無い | 404 `TRIP_NOT_FOUND` | `指定された旅行が見つかりません` |

並びは撮影日時の昇順、撮影日時が無い写真は末尾（[04 §5.3](./04_data_design.md#53-旅行の写真一覧)）。ページングは無い。

```json
{ "success": true, "data": { "photos": [ { "...": "Photo" } ], "total": 12, "urlExpiresAt": "2026-10-10T04:12:45.000Z" } }
```

500 の `message`: `写真一覧の取得に失敗しました`。

### 5.3 `GET /api/photos/{photoId}`

| 順 | 条件 | ステータス・コード | `message` |
|----|------|-------------------|-----------|
| 1 | `photoId` が小文字16進 64 文字でない | 400 `INVALID_REQUEST` | `写真IDの形式が無効です` |
| 2 | 無い | 404 `PHOTO_NOT_FOUND` | `指定された写真が見つかりません` |

`{ photo, urlExpiresAt }`。500 の `message`: `写真詳細の取得に失敗しました`。

### 5.4 `DELETE /api/photos/{photoId}`

検証は 5.3 と同じ。ドキュメントを消してから原寸とサムネイルの Blob を消す。Blob の削除の失敗はログだけで 200。
段階4では、`entryId` があり、その項目の写真が 0 枚になったら項目も消す（ベストエフォート）。

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
| 9 | `tags` の要素に `category:` で始まるものがある | 400 `INVALID_REQUEST` | `category:で始まるタグは指定できません` |
| 10 | `tags` の要素に、前後の空白を除いて空か 30 文字を超えるか `:` を含むものがある | 400 `INVALID_REQUEST` | `タグは1〜30文字で、「:」を含めずに指定してください` |
| 11 | 写真が無い | 404 `PHOTO_NOT_FOUND` | `指定された写真が見つかりません` |

- `comment`: 文字列なら保存して `commentSource: "user"`。`null` なら消して `commentSource: null`。前後の空白は除く（除いて空なら `null` と同じ）
- `tags`: 利用者のタグを指定したものに**置き換える**。サーバは既存の `category:` のタグを残して結合する。重複は除く
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
| 8 | `step: "identify"` だが写真のカテゴリが識別対象でない（`category:other` か未分類） | 400 `INVALID_REQUEST` | `この写真は識別の対象ではありません` |

処理: `processing.state = "pending"`・`attempts = 0`・`hint` を保存し、キューに `{ photoId, step, hint }` を投入して **202** `{ photo }`。
キューへの投入の失敗は 502 / 503 `STORAGE_ERROR`。500 の `message`: `解析のやり直しの受付に失敗しました`。
詳細は [06 §1](./06_processing_design.md#1-キューとワーカー段階3)。

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

`{ trips: TripSummary[], total }`。`createdAt` 降順。集計は [04 §5.1](./04_data_design.md#51-旅行一覧)。
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

### 5.12 `DELETE /api/trips/{tripId}`

検証は 5.10 と同じ。中の写真を1枚ずつ消し（ドキュメント → Blob。Blob の失敗はログだけ）、最後に旅行を消す。
写真のドキュメントの削除に失敗したら中断して 500（消せた分は消えている。再送で続きができる）。

```json
{ "success": true, "data": { "message": "旅行が正常に削除されました", "deletedPhotoCount": 12 } }
```

500 の `message`: `旅行の削除に失敗しました`。

### 5.13 `GET /api/tags`（段階3）

`{ tags: string[] }`。写真の `tags` の `DISTINCT`（`category:` を含む）。文字列順。500 の `message`: `タグ一覧の取得に失敗しました`。

### 5.14 図鑑（段階4）

| エンドポイント | 内容 | エラー |
|---|---|---|
| `GET /api/catalog/kinds` | `{ kinds: [{ kind, label, fields: [{ key, label, type }] }] }`。定義表から。DB に触らない | 500 `図鑑の種類の取得に失敗しました` |
| `GET /api/catalog/entries?kind=` | `{ entries: [{ ...entry, photoCount, coverThumbnailUrl }], total }`。`kind` 必須、定義表に無ければ 400 `図鑑の種類が無効です`。`name` の文字列順 | 500 `図鑑の一覧の取得に失敗しました` |
| `GET /api/catalog/entries/{entryId}` | `{ entry, photos, urlExpiresAt }`。`entryId` の形式は `<kind>-<16進64文字>`、合わなければ 400 `図鑑の項目IDの形式が無効です`。無ければ 404 `ENTRY_NOT_FOUND` `指定された図鑑の項目が見つかりません` | 500 `図鑑の項目の取得に失敗しました` |
| `DELETE /api/catalog/entries/{entryId}` | 写真の `entryId` を `null` にして項目を消す。`{ message: "図鑑の項目が正常に削除されました" }` | 500 `図鑑の項目の削除に失敗しました` |

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
| 404 | `ENTRY_NOT_FOUND` | 図鑑の項目が見つからない（段階4） | `/api/catalog/entries/{entryId}` |
| 400 / 413 / 415 / 500 / 502 / 503 | 既存のコード | 既存と同じ意味 | |

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
| `getTrips()` | `GET /api/trips` | `data['trips']`・`data['total']` |
| `getTrip(tripId)` | `GET /api/trips/{tripId}` | `data['trip']` |
| `updateTrip(tripId, name, description)` | `PUT /api/trips/{tripId}` | `data['trip']` |
| `deleteTrip(tripId)` | `DELETE /api/trips/{tripId}` | `data['deletedPhotoCount']` |
| `uploadPhoto(...)` | `POST /api/photos` | `data['photo']`・`data['urlExpiresAt']`。201 / 200 を呼び出し側に返す |
| `getPhotos({tripId, tag, entryId})` | `GET /api/photos` | `data['photos']`・`data['total']`・`data['urlExpiresAt']` |
| `getPhoto(photoId)` | `GET /api/photos/{photoId}` | `data['photo']` |
| `deletePhoto(photoId)` | `DELETE /api/photos/{photoId}` | 読まない |
| `movePhotos(photoIds, tripId)` | `POST /api/photos/move` | `data['moved']`・`data['notFound']` |
| `updatePhoto(photoId, {comment, tags})` | `PATCH /api/photos/{photoId}` | `data['photo']` |

`_parseResponse()` はボディ全体をコールバックに渡すので、各メソッドが `json['data']` を剥がす（CLAUDE.md「クライアント実装で踏みやすい罠」）。
`ApiException` に `isTripNotFound`（`code == 'TRIP_NOT_FOUND'`）を足す。
