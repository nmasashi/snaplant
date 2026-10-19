# 旅行アルバム API 設計

## この文書の位置づけ

旅行アルバムの REST API を書く。書き方は [docs/06_api_design.md](../06_api_design.md)（実装の写し）に合わせ、
エラーの契約（ステータス・`code`・`message`）は文言まで決める。**未実装を含む目指す姿**で、
実装したエンドポイントは `docs/06_api_design.md`・`docs/06_api_openapi.yaml`・`README.md` のエンドポイント表へ取り込む（開発中はこの一式を正として都度直し、取り込みは機能が固まってから後でまとめて行う。2026-10-12 に人間が決定）。

データの形は [04_data_design.md](./04_data_design.md)、裏の処理は [06_processing_design.md](./06_processing_design.md)、
画面からの使い方は [03_screen_design.md](./03_screen_design.md) を参照する。
エラーの `message`・検証の順序・上限値は第3版に無く、この文書で既存の流儀（植物図鑑の API の `docs/06_api_design.md` §5.4・§5.8。植物図鑑の API と一緒に 4-6 で削除）に合わせて決めた。

---

## 1. 基本方針

既存の API と同じ。

- 全エンドポイントは `authLevel: 'function'`。`?code={FUNCTION_KEY}` が要る。`routePrefix` は `api`
- 応答は封筒 `{ success: true, data }` / `{ success: false, error: { code, message, details? } }`。`utils/response.ts` のヘルパー経由で作る
- **契約はステータス・`code`・`message` まで。`details` は契約外**（CLAUDE.md「レスポンス規約」）
- 入力検証は上から順に行い、最初に失敗した1件だけを返す。**Cosmos DB・Blob に触る前に全部弾く**
- Cosmos DB へ接続できない → 503 `DATABASE_ERROR`（`データベースに接続できません`）。判定は `isConnectivityError()`（`utils/errors.ts`。`hasCauseCode()` を使う述語。既存6箇所の複製を増やさない）で、
  errno が `ENOTFOUND`・`ECONNREFUSED` のものを `cause` の奥までたどって探す（一覧 `UNREACHABLE_ERRNOS` は AI 側の判定と共有する。`ETIMEDOUT` は含めないので 500 になる）。
  応答は `createDatabaseErrorResponse(error, message)`（`utils/response.ts`）が作り、接続できない以外の失敗は下の 500 にする（実装済み。旅行の API が使う）。
  `cause` をたどるのは10段までで、循環していても止まる（見つからなければ接続できない以外の失敗として下の 500）
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
| `/api/photos` | GET | `{ photos, continuationToken, urlExpiresAt }` | `tripId=<uuid>` か `tripId=none`、または `category=`（段階3。どちらか1つは要る。両方なら AND）。`sortAt` 昇順（撮影日時順、無い写真はアップロード日時）。`limit` と `continuationToken` でページ | 2 | `photos.ts` |
| `/api/photos/move` | POST | `{ moved, notFound }` | `{ photoIds, tripId }`。送り方 ③ と「外す」。1回 200 件まで | 2 | `photoMove.ts` |
| `/api/photos/{photoId}` | GET | `{ photo, urlExpiresAt }` | | 2 | `photoDetail.ts` |
| `/api/photos/{photoId}` | DELETE | `{ message }` | | 2 | `photoDetail.ts` |
| `/api/photos/{photoId}` | PATCH | `{ photo, urlExpiresAt }` | `{ comment?, tags? }`。構造は2、画面は4 | 2 | `photoDetail.ts` |
| `/api/photos/{photoId}/process` | POST | `{ photo, urlExpiresAt }` 202 | `{ step, hint? }`。写真に `step`・`hint` を書いてキューに投入 | 3（`identify` は4） | `photoProcess.ts` |
| `/api/tags` | GET | `{ tags }` | 利用者のタグの `DISTINCT` | 未定（タグを付ける画面と一緒） | `tags.ts` |
| `/api/catalog/kinds` | GET | `{ kinds }` | 定義表から（表の順） | 4（4-2a。実装済み） | `catalogKinds.ts` |
| `/api/catalog/entries` | GET | `{ entries, total }` | `kind=` 必須。`GROUP BY` で数え、項目ごとに見出しの写真を1枚読む。`offset` / `limit` でページ。各項目に `photoCount`・`coverThumbnailUrl`（`urlExpiresAt` は付けない） | 4（4-2a。実装済み） | `catalogEntries.ts` |
| `/api/catalog/entry` | GET | `{ entry, photos, continuationToken, urlExpiresAt }` | `kind=` と `name=`（URL エンコード）で1件を指定。該当する写真が無ければ `entry: null`。`photos` は `GET /api/photos` と同じページング（ページごとに `entry` も読み直す） | 4（4-2b。実装済み） | `catalogEntry.ts` |

図鑑の項目は文書として持たず、写真の `identification` からまとめる（[04 §3](./04_data_design.md#3-図鑑の項目と定義表段階4)）。
そのため項目の id は無く、項目は `kind` と `name` で指定する。項目を削除する API は置かない。項目は写真の集まりに過ぎず、
「この項目を消す」に当たる操作は、写真を消す（`DELETE /api/photos/{photoId}`）か、識別をやり直す（`process`。要件 5.5.1）で足りる。

- 同じルートを複数ファイルが別々のメソッドで登録してもよい（植物図鑑の `plants/{id}` はそうしていた。4-6 で削除）が、ここでは `photoDetail.ts` が GET / DELETE / PATCH を、
  `tripDetail.ts` が GET / PUT / DELETE を1つのファイルで登録する。
  実装済みの旅行と写真の関数は**メソッドごとに別の `app.http`** で登録している（`trips.ts` が `listTrips`（GET）・`createTrip`（POST）、`tripDetail.ts` が `getTrip`（GET）・`updateTrip`（PUT）・`deleteTrip`（DELETE）、
  `photos.ts` が `listPhotos`（GET）・`createPhoto`（POST）、`photoDetail.ts` が `getPhoto`（GET）・`deletePhoto`（DELETE）・`updatePhoto`（PATCH）、`photoMove.ts` が `movePhotos`（POST）、`photoProcess.ts` が `requestPhotoProcessing`（POST。段階3）、`catalogKinds.ts` が `listCatalogKinds`（GET。4-2a）、`catalogEntries.ts` が `listCatalogEntries`（GET。4-2a）、`catalogEntry.ts` が `getCatalogEntry`（GET。4-2b）。
  植物図鑑の `plantDetail.ts`（4-6 で削除）のように1つの登録で複数のメソッドを受けてハンドラの中で振り分ける形ではない）。Azure ポータルの「関数」にはこの名前で出る
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

すべて実装済み（集計は PR 3、表紙は PR 4a-2）。表紙の URL は写真の URL と同じく SAS 付きで期限があるが、**旅行の一覧・詳細の応答には `urlExpiresAt` を付けない**（旅行の画面は開くたびに取り直すので、期限切れになりにくい。2026-10-12 に決めた）。表紙の写真が無ければ写真の保存先の設定を読まない。

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
  "processing": { "state": "pending", "step": "classify", "attempts": 0, "lastError": null, "updatedAt": "2026-10-10T03:12:45.000Z" },
  "uploadedAt": "2026-10-10T03:12:45.000Z",
  "updatedAt": "2026-10-10T03:12:45.000Z"
}
```

ドキュメントとの違い: `blobName` / `thumbnailBlobName` の代わりに `imageUrl` / `thumbnailUrl`（SAS 付き。§6）。`thumbnailUrl` はサムネイルが無ければ `null`。
`location` は位置情報が無ければ `null`。あれば `latitude`・`longitude` は必ず数値で、`placeName`・`placeSource` は `null` になりうる（緯度・経度だけを送ったとき。§5.1）。
クライアントは `latitude`・`longitude`・`placeName` を読み、写真ビューアの下の情報に地名（無ければ緯度・経度、`location` が `null` なら「位置情報なし」）を出す（[03 §4.6](./03_screen_design.md#46-写真ビューア)）。`placeSource` は読まない。
段階3からは `category`・`processing.state`（`processing` が無ければ `none` とみなす）・`comment`・`commentSource`・`hint` も読み、写真ビューアのカテゴリと分類の状態、サムネイルの印、やり直しダイアログの事前入力に使う（[03 §5.1・§5.4・§5.5](./03_screen_design.md#5-段階3の画面骨格)）。段階4（4-3c）からは `processing.step`（無ければ `null`。状態の表示を「分類中...」「識別中...」に分ける）と `identification` の `kind`・`matchesKind`・`name`（図鑑の項目へのリンクと、分類と合わない写真の案内。[03 §6.3](./03_screen_design.md#63-写真ビューアへの追加)）も読む。`processing` のほかの項目、`classification`、`identification` のほかの項目は読まない。
`takenAt` は**タイムゾーン無し**の文字列のまま返す（クライアントは変換しない）。`sortAt`（並べ替え用。[04 §1.3](./04_data_design.md#13-写真type-photo)）もそのまま返す（クライアントは表示に使わない）。
`category` は AI の大分類（`plant` / `food` / `landscape` / `other`、分類前は `null`）、`tags` は利用者のタグだけ（[04 §2](./04_data_design.md#2-カテゴリとタグ)）。
`classification`（段階3）はドキュメントのまま返す（分類前は `null`、分類の後は `{ kind, confidence, model, at }`。`model` は要求を送ったデプロイ名。[06 §2.3](./06_processing_design.md#23-書き込み)）。
`processing` もドキュメントのまま返す（`{ state, step, attempts, lastError, updatedAt }`。送った直後は上の例の `pending`・`classify`、段階2に送った写真は `{ state: "none", step: null, attempts: 0, lastError: null, updatedAt: null }`。`lastError` は `null` か、どこで失敗したかの `"ai"` / `"internal"` で、例外の文言は入らない。[06 §1.3](./06_processing_design.md#13-状態と失敗)）。
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

`confidence` 以下 `attributes` までは、その名前の写真のうち信頼度が最も高いもの（同点なら `identification.at` が新しいもの）の `identification` から取る。`coverThumbnailUrl` はその写真のサムネイル（無ければ原寸）の SAS 付き URL（期限は §6。項目一覧では旅行の表紙と同じく、応答に `urlExpiresAt` は付けない。項目の詳細の `urlExpiresAt` は、表紙と `photos` の URL の共通の期限。§5.14）。

| 項目 | 型 | 説明 |
|---|---|---|
| `kind` | string | 図鑑の種類（要求の `kind`） |
| `name` | string | 項目の名前（写真の `identification.name`） |
| `confidence` | number | 見出しの写真の信頼度（0〜100） |
| `description` / `characteristics` | string \| null | 見出しの写真の説明・特徴。AI が返さなければ `null`（識別の応答では検査しない。[06 §3.1](./06_processing_design.md#31-契約)） |
| `attributes` | object | 見出しの写真の種類ごとの項目。キーは定義表の `fields[].key`、値は `string` / `string[]` / `null` |
| `photoCount` | integer | その名前の写真の枚数（項目一覧は `GROUP BY` の `COUNT(1)`、項目の詳細は `SELECT VALUE COUNT(1)`。[04 §5.6](./04_data_design.md#56-図鑑のまとめ段階4)） |
| `coverThumbnailUrl` | string | 見出しの写真のサムネイル（無ければ原寸）の SAS 付き URL。`null` にはならない |

`GET /api/catalog/entries`（4-2a）と `GET /api/catalog/entry`（4-2b）が実装済み（型は `api/src/types/album.ts` の `CatalogEntry`）。項目一覧は、ページに項目が1つも無ければ写真の保存先の設定を読まない（表紙の URL を作らないため。旅行の表紙と同じ）。項目の詳細も、該当する写真が無い（`entry: null`）ときは設定を読まない（§5.14）。

### 3.4 Error

既存と同じ（`docs/06_api_design.md` §4.1）。

## 4. 入力検証の定数

`api/src/constants/validation.ts` に既存と同じ形（`positiveIntFromEnv()`、`ERROR_MESSAGES` に上限値を埋め込む）で追加する。
**正の整数として読めない値は既定値にフォールバックする**（既存の方針）。
環境変数・コードの定数・クライアントの定数を1か所にまとめた一覧は [07 §6](./07_infrastructure_design.md#6-設定値の一覧)。ここには入力検証に使うものだけを挙げる。

| 定数 | 環境変数 | 既定値 | 使う所 |
|---|---|---|---|
| `PHOTO_VALIDATION.PAGE_SIZE` / `MAX_PAGE_SIZE` | `PHOTO_PAGE_SIZE` / `PHOTO_MAX_PAGE_SIZE` | 100 / 200 | `GET /api/photos`・`GET /api/catalog/entry` の `limit` |
| `CATALOG_VALIDATION.PAGE_SIZE` / `MAX_PAGE_SIZE` | `CATALOG_PAGE_SIZE` / `CATALOG_MAX_PAGE_SIZE` | 50 / 100 | `GET /api/catalog/entries` の `limit` |
| `CATALOG_VALIDATION.NAME_MAX_LENGTH` | —（AI が返す値の上限なので環境変数では変えない） | 100 | `GET /api/catalog/entry` の `name` と、識別の応答の検証（ワーカー。[06 §3.1](./06_processing_design.md#31-契約)） |
| `TRIP_VALIDATION.MAX_LENGTH.NAME` | `TRIP_NAME_MAX_LENGTH` | 100 | `POST` / `PUT /api/trips` |
| `TRIP_VALIDATION.MAX_LENGTH.DESCRIPTION` | `TRIP_DESCRIPTION_MAX_LENGTH` | 1000 | 同上 |
| `PHOTO_VALIDATION.ID_REGEX` | — | `/^[0-9a-f]{64}$/`（小文字のみ） | 写真 id を受けるすべて |
| `PHOTO_VALIDATION.TAKEN_AT_REGEX` | — | `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/`（加えて実在する日時であること） | `POST /api/photos` |
| `PHOTO_VALIDATION.COORDINATE_REGEX` | — | `/^-?[0-9]+(\.[0-9]+)?$/`（加えて緯度 ±90・経度 ±180 の範囲内） | `POST /api/photos` |
| `PHOTO_VALIDATION.MAX_LENGTH.PLACE_NAME` | `PHOTO_PLACE_NAME_MAX_LENGTH` | 100 | `POST /api/photos` |
| `PHOTO_VALIDATION.MAX_LENGTH.COMMENT` | `PHOTO_COMMENT_MAX_LENGTH` | 500 | `PATCH /api/photos/{photoId}` |
| `PHOTO_VALIDATION.THUMBNAIL_MAX_SIZE` | `THUMBNAIL_MAX_SIZE` | 1048576（1MB） | `POST /api/photos` |
| `MOVE_VALIDATION.MAX_IDS` | `MOVE_MAX_IDS` | 200 | `POST /api/photos/move` |
| `TAG_VALIDATION.MAX_LENGTH` | `TAG_MAX_LENGTH` | 30 | `PATCH /api/photos/{photoId}` |
| `FILE_UPLOAD.MAX_SIZE`・`SUPPORTED_IMAGE_TYPES`（既存） | `MAX_FILE_SIZE` | 10MB | `POST /api/photos` の原寸 |
| `CONTEXT_INFO_VALIDATION.MAX_LENGTH`（既存） | `CONTEXT_INFO_MAX_LENGTH` | 500 | `process` の `hint` |
| `photoUrlExpiresOn()`（`services/photoStorageService.ts`。定数ではなく、応答を作るたびに環境変数を読む） | `PHOTO_SAS_EXPIRY_MINUTES` | 60 | §6 |
| `GENERAL_VALIDATION.UUID_REGEX`（既存） | — | | 旅行 id |

実装済みは `TRIP_VALIDATION` の2つ、`PHOTO_VALIDATION` の `ID_REGEX`・`TAKEN_AT_REGEX`・`COORDINATE_REGEX`・`MAX_LENGTH.PLACE_NAME`・`MAX_LENGTH.COMMENT`・`THUMBNAIL_MAX_SIZE`・`PAGE_SIZE`・`MAX_PAGE_SIZE`、`MOVE_VALIDATION.MAX_IDS`、`TAG_VALIDATION.MAX_LENGTH`、`PHOTO_SAS_EXPIRY_MINUTES` と既存のもの（PR 4b 時点）。
`CATALOG_VALIDATION` は、使うエンドポイント（段階4）と一緒に足す。`NAME_MAX_LENGTH` は識別の応答の検証で使うので 4-1a で、`PAGE_SIZE`・`MAX_PAGE_SIZE` は `GET /api/catalog/entries` と一緒に 4-2a で足した（どちらも実装済み）。
図鑑の 400 の `message`（`図鑑の種類が無効です`・`ページの指定が無効です`。`CATALOG_VALIDATION.ERROR_MESSAGES` の `KIND_INVALID`・`PAGE_INVALID`）は上限値を埋め込まない固定の文言。
コメント・タグ・move の上限も `message` に値を埋め込む（`コメントは500文字以内で指定してください`・`タグは1〜30文字で指定してください`・`一度に移動できる写真は200枚までです`）。
`PHOTO_SAS_EXPIRY_MINUTES` は定数にせず、`photoUrlExpiresOn()` が応答を作るたびに `positiveIntFromEnv()` で読む（正の整数として読めない値（数字でない・0・負）は 60）。
`limit` の 400 の `message`（`1ページの枚数は1〜200で指定してください`）は `PHOTO_MAX_PAGE_SIZE` の値を埋め込む。

文字数は既存と同じく `String.length`（UTF-16 コードユニット）で数える（`docs/09_backlog.md`「contextInfo の文字数の数え方」と同じ扱い）。

## 5. API 詳細仕様

### 5.1 `POST /api/photos`

**実装済み**（PR 4a-1。`photos.ts`、検証は `utils/photoInput.ts`）。

写真を1枚保存する。**冪等**で、同じ写真（同じ `photoId`）を何度送っても1枚になる。

**リクエスト（`multipart/form-data`）:**

| パート | 種類 | 必須 | 内容 |
|---|---|---|---|
| `photoId` | テキスト | ○ | 画像のバイト列の SHA-256（16進・小文字 64 文字）。サーバが計算し直して照合する |
| `image` | ファイル | ○ | 原寸。`image/jpeg` / `image/jpg` / `image/png` / `image/webp` / `image/gif`、10MB 以下 |
| `thumbnail` | ファイル | × | サムネイル（JPEG を想定。形式は `image` と同じものを受け付ける）。1MB 以下。無ければ `thumbnailUrl: null` |
| `tripId` | テキスト | × | 送り先の旅行（UUID）。無ければ旅行に属さない写真 |
| `takenAt` | テキスト | × | 撮影日時 `YYYY-MM-DDTHH:mm:ss`（タイムゾーン無し） |
| `latitude` / `longitude` | テキスト | × | 緯度・経度（10進）。**両方そろえて送る**（片方だけは 400。下の表の 14）。どちらも無ければ `location: null` |
| `placeName` | テキスト | × | 地名。緯度・経度と一緒に送る。1〜100 文字 |

`takenAtSource` は受け取らない。サーバが `takenAt` の有無から `exif` / `none` を入れる。
`sortAt` もサーバが決める（`takenAt` があればそれ、無ければ `uploadedAt` を日本時間に直したもの。[04 §1.3](./04_data_design.md#13-写真type-photo)）。`category` は `null`、`tags` は `[]` で作る。
`location.placeSource` は `placeName` を送ったときだけ `"device"`、緯度・経度だけなら `placeName`・`placeSource` とも `null`。
`comment`・`commentSource`・`hint`・`classification`・`identification` は `null`、`processing` は段階3から `{ state: "pending", step: "classify", attempts: 0, lastError: null, updatedAt: <保存した時刻> }`（段階2は `{ state: "none", step: null, attempts: 0, lastError: null, updatedAt: null }`）、
`fileSize` は原寸のバイト数、`uploadedAt` と `updatedAt` は同じ値（保存した時刻）。

任意のパートは、値が無ければ**パートごと省く**。空文字のパートは「指定あり」として検証され 400 になる（`tripId` は 12、`takenAt` は 13、`latitude` / `longitude` は 15（片方だけなら 14）、`placeName` は 17（緯度・経度が無ければ 16））。

**処理の順序:**

1. 入力検証（下の表。Blob・Cosmos に触らない）
2. `image` のバイト列の SHA-256 を計算し、`photoId` と一致しなければ 400
3. `item(photoId, photoId).read()`。既にあれば **200** で既存を返す（Blob には触らない。`tripId` も変えない。既存にサムネイルが無ければ、送ったサムネイルも足さず `thumbnailUrl: null` のまま）
4. `tripId` があれば旅行を読み、無ければ 404 `TRIP_NOT_FOUND`。**保存済みの確認（3）の後に見る**ので、保存済みの写真の再送は、送り先の旅行が消えていても 200
   （先に見ると、保存に成功して応答が届かず、その間に旅行が消されたときの再送が 404 になり、冪等でなくなる）
5. 原寸を `photos/<photoId><拡張子>` に上書きアップロード。サムネイルがあれば `photos/<photoId>.thumb.jpg` に上書き
6. ドキュメントを `create`。409（3 と 6 の間に並行リクエストが作った）なら既存を読んで 200
7. （段階3）キューに `{ photoId }` を投入する（[06 §1](./06_processing_design.md#1-キューとワーカー段階3)）。**投入に失敗してもログだけ出して 201 を返す**（キューの名前の設定 `PHOTO_QUEUE_NAME` が無い・空・空白だけのときも投入の失敗として同じ扱い。写真は `pending` のまま残り、再投入のタイマーが拾う。[04 §7.1](./04_data_design.md#71-操作ごとの表)）。200 で既存を返すとき（3 と 6）は投入しない
8. **201** で `{ photo, urlExpiresAt }`

`tripId` を付けて送ったが既存だった（`tripId: null` または別の旅行）とき: 既存をそのまま 200 で返し、旅行は変えない。
送信は「入れる」ではなく「送る」で、入れたければ `move` を使う。クライアントは応答の `tripId` が送ったものと違えば
「送信済み（別の場所）」と扱う（[03 §4.7](./03_screen_design.md#47-写真の追加と送信の進み具合)）。

#### 入力検証（400 / 413 / 415）

| 順 | 条件 | ステータス・コード | `message` |
|----|------|-------------------|-----------|
| 1 | リクエストの Content-Type が `multipart/form-data` で始まらない（ヘッダが無い場合を含む） | 400 `INVALID_REQUEST` | `Content-Typeがmultipart/form-dataではありません` |
| 1.5 | multipart の本文を読めない（`request.formData()` が失敗する） | 400 `INVALID_REQUEST` | `ファイルの読み取りに失敗しました` |
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
| 17 | `placeName` が空・空白のみ・ファイル、または 100 文字を超える | 400 `INVALID_REQUEST` | `地名は100文字以内で指定してください` |
| 18 | `image` の SHA-256 が `photoId` と一致しない | 400 `INVALID_REQUEST` | `写真IDが画像の内容と一致しません` |

1・1.5・4〜7 は植物図鑑の `POST /api/images/upload`（4-6 で削除）と同じ順序・同じ `message` だった（間に `photoId` の 2・3 が入る）。`details` は付く行（1・1.5・4・5・9）と付かない行があり、契約外。
`tripId`・`takenAt` がファイルで送られたときも 12・13 になる。
18 はバイト列を読む必要があるので最後。1.5 は植物図鑑の `upload` と同じ `message` だが、エラーの文字列では判定せず `formData()` の失敗をそのまま 400 にする。
緯度・経度は10進（`-?数字(.数字)?`。`PHOTO_VALIDATION.COORDINATE_REGEX`）で範囲内のものだけを受け入れる（16進・2進・8進・指数表記・前後の空白・先頭の `+`・`Infinity`・`NaN`・空文字は 15。`Number()` に任せるとこれらが数値として通るため）。
`placeName` は送られたまま保存する（前後の空白も除かずに数える）。サムネイルは JPEG を想定するが、対応形式なら受け付け、Blob 名は `.thumb.jpg`、Content-Type は送られたものにする。空白だけの `placeName` は「指定なし」ではなく 400 にする（地名が無ければクライアントはパートを省く。multipart に null は無く、文字列 `null` を送るとその文字列が地名として保存される）。

#### 検証の後

| 条件 | ステータス・コード | `message` |
|---|---|---|
| `tripId` の旅行が無い | 404 `TRIP_NOT_FOUND` | `指定された旅行が見つかりません` |
| 原寸・サムネイルのアップロードが、Blob Storage に接続できずに失敗（`cause` をたどって `ENOTFOUND`・`ECONNREFUSED`・`ETIMEDOUT`） | 503 `STORAGE_ERROR` | `ストレージサービスに接続できません` |
| 原寸・サムネイルのアップロードが、それ以外で失敗（Blob Storage のエラー応答など） | 502 `STORAGE_ERROR` | `ストレージサービスでエラーが発生しました` |
| Cosmos へ接続できない（旅行の読み取り・写真の読み取り・作成のどれでも） | 503 `DATABASE_ERROR` | `データベースに接続できません` |
| それ以外 | 500 `INTERNAL_ERROR` | `写真の保存に失敗しました` |

Blob の失敗はどれも、写真のドキュメントを作る前に止まる（残るものは [04 §7.1](./04_data_design.md#71-操作ごとの表)）。

**レスポンス例（201）:**

```json
{ "success": true, "data": { "photo": { "...": "§3.3 の Photo" }, "urlExpiresAt": "2026-10-10T04:12:45.000Z" } }
```

既存を返す 200（処理の順序の 3・6）も同じ形で、`photo` は保存済みの内容、URL と `urlExpiresAt` はこの応答で発行し直したもの。

### 5.2 `GET /api/photos`

**実装済み**（PR 4a-2。`photos.ts`、クエリの検証は `utils/photoInput.ts` の `readPhotoListQuery`。`category` は 3-3b）。
`limit` は先頭がゼロでない10進の整数だけを受け付け、空（`limit=`）・先頭のゼロ（`01`）・符号・小数・指数表記・16進・前後の空白は 4 の 400。`tripId=` （空）は 2 の 400、`category=`（空）は 3 の 400。
`category` は大文字小文字を区別する（`FOOD` は 3 の 400）。
`tripId=none` のときと、`tripId` を付けずに `category` だけで絞るときは、旅行の確認（6）をしない。継続トークンの大きさは 2KB に抑える（`PHOTO_CONTINUATION_TOKEN_LIMIT_KB`）。
トークンを渡していない要求で Cosmos が 400 を返したら 500。トークンを渡していても、Cosmos へ接続できない障害は 7 にせず 503 `DATABASE_ERROR`（`データベースに接続できません`）。

| クエリ | 必須 | 内容 | 段階 |
|---|---|---|---|
| `tripId` | △（`tripId`・`category` のどちらか1つは要る） | 旅行の id（UUID）、または `none`（旅行に属さない写真） | 2 |
| `limit` | × | 1ページの枚数。既定 100、上限 200（`PHOTO_PAGE_SIZE` / `PHOTO_MAX_PAGE_SIZE`） | 2 |
| `continuationToken` | × | 前の応答の `continuationToken` をそのまま返す。無ければ先頭から | 2 |
| `category` | △（同上） | カテゴリ（定義表 `CATALOG_KINDS` のキー（`plant` / `food` / `landscape`）か `other`）。`tripId` と両方あれば AND（`tripId=none` とも組み合わせられる）。`tripId` 無しなら旅行をまたぎ、旅行に属さない写真も含む | 3 |

`tripId=none` は「`tripId` が `null` の写真」を返す（同じ SQL に `@tripId = null`。[04 §5.3](./04_data_design.md#53-旅行の写真一覧)）。
旅行の削除と送信・移動が重なって残った「存在しない旅行を指す写真」は含めない（段階3の掃除のタイマーが `null` に戻してから出る。[04 §7.3](./04_data_design.md#73-旅行の削除と重なった送信move)）。
`category` だけで絞るときは旅行の項目を見ないので、そうした写真もカテゴリが合えば含む。
図鑑の項目の写真は `GET /api/catalog/entry`（§5.14）で取る。

| 順 | 条件 | ステータス・コード | `message` |
|----|------|-------------------|-----------|
| 1 | `tripId`・`category` のどちらも無い | 400 `INVALID_REQUEST` | `絞り込み条件を指定してください` |
| 2 | `tripId` が `none` でも UUID でもない | 400 `INVALID_REQUEST` | `旅行IDの形式が無効です` |
| 3 | `category` があり、定義表のキーでも `other` でもない | 400 `INVALID_REQUEST` | `カテゴリが無効です` |
| 4 | `limit` があり、1〜200 の整数でない | 400 `INVALID_REQUEST` | `1ページの枚数は1〜200で指定してください` |
| 5 | `continuationToken` があり、空か JSON として読めない（Cosmos の継続トークンは JSON。読めないものを SDK に渡すと `code` の無い Error になり 500 と区別できないので、渡す前に弾く） | 400 `INVALID_REQUEST` | `継続トークンの形式が無効です` |
| 6 | `tripId`（UUID）の旅行が無い | 404 `TRIP_NOT_FOUND` | `指定された旅行が見つかりません` |
| 7 | `continuationToken` が JSON だが Cosmos が受け付けない（別の絞り込みのトークンなど。サーバが 400 で拒む。推測。一覧のクエリの失敗だけをこれとみなす） | 400 `INVALID_REQUEST` | `継続トークンの形式が無効です` |

並びは `sortAt` の昇順（撮影日時順。撮影日時が無い写真はアップロード日時を日本時間に直した位置。[04 §1.3](./04_data_design.md#13-写真type-photo)・[04 §5.3](./04_data_design.md#53-旅行の写真一覧)）。
**`total` は返さない**（数えるには別のクエリが要り、ページごとに数えるのは無駄。旅行の枚数は `GET /api/trips` / `GET /api/trips/{tripId}` の `photoCount`、未所属の枚数は `GET /api/trips` の `unassignedPhotoCount` で取る）。
実装（PR 4a-2）は `total` を返さず、継続トークンをクエリパラメータで受け渡す（[02 §5](./02_design_overview.md#5-人間に決めてもらう点推奨付き) #27。推奨どおり 2026-10-12 に決定）。

```json
{ "success": true, "data": { "photos": [ { "...": "Photo" } ], "continuationToken": "<Cosmos の継続トークン。最後のページは null>", "urlExpiresAt": "2026-10-10T04:12:45.000Z" } }
```

- **最後のページが空のことがある**（`photos: []` で `continuationToken: null`。Cosmos の enableQueryControl の性質。2026-10-12 に本番で確認）。クライアントはトークンが `null` になるまでめくる
- `continuationToken` は Cosmos が作る不透明な文字列で、クライアントは中身を見ず、次の要求の同じ名前のクエリに URL エンコードして載せる。`null` なら最後のページ
- `limit` は1ページの上限（SDK の `maxItemCount`）で、Cosmos はそれより少なく返すことがある（継続トークンの大きさを抑えると減る。`constants/album.ts` の説明）。続きがあるかは枚数ではなく `continuationToken` が `null` かどうかで判断する
- 旅行があって写真が1枚も無ければ 200 で `photos: []`・`continuationToken: null`（404 にしない）。旅行が無ければ、その旅行を指す写真が残っていても 404
- トークンは同じ絞り込み（`tripId`・`category`）にだけ有効。絞り込みを変えるときは先頭から取り直す
- 各ページの `urlExpiresAt` は、そのページの URL の期限（ページごとに SAS を発行する）
- 500 の `message`: `写真一覧の取得に失敗しました`

### 5.3 `GET /api/photos/{photoId}`

**実装済み**（PR 4a-1。`photoDetail.ts`）。

| 順 | 条件 | ステータス・コード | `message` |
|----|------|-------------------|-----------|
| 1 | `photoId` が小文字16進 64 文字でない | 400 `INVALID_REQUEST` | `写真IDの形式が無効です` |
| 2 | 無い | 404 `PHOTO_NOT_FOUND` | `指定された写真が見つかりません` |

200 `{ photo, urlExpiresAt }`（`POST /api/photos` と同じ形）。Cosmos へ接続できなければ 503 `DATABASE_ERROR`（`データベースに接続できません`）、それ以外の失敗は 500 で `message` は `写真詳細の取得に失敗しました`。
URL は署名だけで作り、Blob があるかは確かめない（Blob の無い写真でも 200 で URL を返し、画像の取得が 404 になる。[04 §7.1](./04_data_design.md#71-操作ごとの表)）。

### 5.4 `DELETE /api/photos/{photoId}`

**実装済み**（PR 4a-2。`photoDetail.ts`）。原寸の削除が失敗してもサムネイルは消しにいく。Blob が既に無いのは成功とみなす。
読んだ後・消す前に他のリクエストが消していたら 404 `PHOTO_NOT_FOUND` で、画像には触らない（画像は先に消した側が消す）。ドキュメントの読み取り・削除に失敗したときも画像には触らない。

検証は 5.3 と同じ。ドキュメントを消してから原寸とサムネイルの Blob を消す。Blob の削除の失敗はログだけで 200（残った Blob は掃除のタイマーが消す。[04 §7.2](./04_data_design.md#72-掃除のタイマー段階3)）。
段階4でも図鑑側の後始末は無い（項目は写真からまとめるので、写真が消えれば項目からも消える）。

```json
{ "success": true, "data": { "message": "写真が正常に削除されました" } }
```

Cosmos へ接続できなければ（読み取り・削除のどちらでも）503 `DATABASE_ERROR`（`データベースに接続できません`）、それ以外の失敗は 500 で `message` は `写真の削除に失敗しました`。

### 5.5 `POST /api/photos/move`

**実装済み**（PR 4b。`photoMove.ts`、検証は `utils/photoInput.ts` の `readMoveInput`）。

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
重複した id は1つにまとめる（最初に出た位置に残す）。5 の件数は重複を除く前に数える（同じ id を 201 個並べても 400）。
ボディがオブジェクトでない JSON（配列・数値・文字列・真偽値）は `photoIds` が無いものとして扱い、3 になる。`photoIds`・`tripId` 以外のキーは無視する。
旅行があるか（9）は検証の後に1回だけ見る（`tripId: null` なら見ない）。

処理: 各写真に `patch`（`tripId`・`updatedAt` だけ。`comment`・`category`・`processing` などには触らない）を、重複を除いた `photoIds` の順に1枚ずつ。404 なら `notFound` に入れて続ける。
それ以外の失敗は中断する（送れた分は移っている。再送しても同じ結果になるので、クライアントは押し直せばよい）。
Cosmos へ接続できなければ（旅行の確認・写真の patch のどちらでも）503 `DATABASE_ERROR`（`データベースに接続できません`）、それ以外の失敗は 500。

```json
{ "success": true, "data": { "moved": ["<photoId>", "..."], "notFound": ["<photoId>"] } }
```

`moved` は移した id、`notFound` は無かった id。既にその旅行にあった写真も `moved` に入る（patch は無条件）。
500 の `message`: `写真の移動に失敗しました`。

### 5.6 `PATCH /api/photos/{photoId}`

**実装済み**（PR 4b。`photoDetail.ts`、検証は `readPhotoUpdateInput`）。コメントの500文字とタグの30文字は前後の空白を除いた後で数える。タグの重複は前後の空白を除いた後の値で、先に出たものを残す。

利用者のコメントとタグを直す。構造は段階2で作り、画面は段階4（コメント。4-3c で実装済み。[03 §6.3](./03_screen_design.md#63-写真ビューアへの追加)）・未定（タグ）。

**リクエスト:** `{ "comment"?: string | null, "tags"?: string[] }`

| 順 | 条件 | ステータス・コード | `message` |
|----|------|-------------------|-----------|
| 1 | `photoId` の形式が無効 | 400 `INVALID_REQUEST` | `写真IDの形式が無効です` |
| 2 | ボディが JSON としてパースできない | 400 `INVALID_REQUEST` | `リクエストボディの形式が無効です` |
| 3 | ボディが `null` | 400 `INVALID_REQUEST` | `リクエストボディが指定されていません` |
| 4 | `comment` も `tags` も無い | 400 `INVALID_REQUEST` | `更新する項目が指定されていません` |
| 5 | `comment` が文字列でも `null` でもない | 400 `INVALID_REQUEST` | `コメントは文字列で指定してください` |
| 6 | `comment` が前後の空白を除いて 500 文字を超える | 400 `INVALID_REQUEST` | `コメントは500文字以内で指定してください` |
| 7 | `tags` が配列でない | 400 `INVALID_REQUEST` | `タグは配列で指定してください` |
| 8 | `tags` の要素に文字列でないものがある | 400 `INVALID_REQUEST` | `タグは文字列で指定してください` |
| 9 | `tags` の要素に、前後の空白を除いて空か 30 文字を超えるものがある | 400 `INVALID_REQUEST` | `タグは1〜30文字で指定してください` |
| 9.5 | `tags` が重複を除いて 20 個を超える（`TAG_MAX_COUNT`） | 400 `INVALID_REQUEST` | `タグは20個までです` |
| 10 | 写真が無い | 404 `PHOTO_NOT_FOUND` | `指定された写真が見つかりません` |

検証は `photoId`（1）→ ボディ（2〜9。`comment` の 5・6 を `tags` の 7〜9 より先）→ 写真があるか（10）の順。写真があるかはボディの検証の後に見るので、無い写真に不正なボディを送ると 400。
ボディがオブジェクトでない JSON（配列・数値・文字列・真偽値）は `comment` も `tags` も無いものとして扱い、4 になる。`comment`・`tags` 以外のキー（`hint` など）は無視し、それだけなら 4。

- `comment`: 文字列なら前後の空白を除いて保存して `commentSource: "user"`。`null` なら消して `commentSource: null`。除いて空なら `null` と同じ（消して `commentSource: null`）。送らなければ `comment`・`commentSource` に触らない
- `tags`: 利用者のタグを指定したものに**置き換える**（空の配列なら全部消える）。各要素は前後の空白を除いて保存し、除いた後の値で重複を除く（先に出たものを残し、並びは送った順）。
  タグの数に上限は無い。送らなければ `tags` に触らない。`category` は別の欄なので `tags` には混ざらず、サーバが選り分けて結合する処理は無い
- 書き込みは `comment`・`commentSource`・`tags`・`updatedAt` だけの patch（AI が書く欄には触らない。[04 §7.4](./04_data_design.md#74-ワーカーの書き込みの決まり)）。`updatedAt` は毎回更新する。
  **解析中（`processing.state` が `pending` / `classifying` / `identifying`）でも受け付ける**（ロックは無い）
- 応答は 200 `{ photo, urlExpiresAt }`（§5.3 と同じ形。更新後の写真で、URL と `urlExpiresAt` はこの応答で発行したもの）
- Cosmos へ接続できなければ 503 `DATABASE_ERROR`（`データベースに接続できません`）、それ以外の失敗は 500 で `message` は `写真の更新に失敗しました`。
  写真の保存先の設定（`STORAGE_CONNECTION_STRING` のアカウント名・鍵、`PHOTO_STORAGE_CONTAINER_NAME`）が足りなければ、写真を書き換える前に同じ 500

### 5.7 `POST /api/photos/{photoId}/process`（段階3）

**実装済み**（3-3b で `step: "classify"`、4-1b で `step: "identify"` と 8。`photoProcess.ts`、検証は `utils/photoInput.ts` の `readProcessRequestInput`）。

AI の解析をやり直す（要件 5.5.1）。

**リクエスト:** `{ "step": "classify" | "identify", "hint"?: string | null }`

| 順 | 条件 | ステータス・コード | `message` |
|----|------|-------------------|-----------|
| 1 | `photoId` の形式が無効 | 400 `INVALID_REQUEST` | `写真IDの形式が無効です` |
| 2 | ボディが JSON としてパースできない | 400 `INVALID_REQUEST` | `リクエストボディの形式が無効です` |
| 3 | ボディが `null` | 400 `INVALID_REQUEST` | `リクエストボディが指定されていません` |
| 4 | `step` が `classify` / `identify` でない | 400 `INVALID_REQUEST` | `やり直す処理の種類が無効です` |
| 5 | `hint` が文字列でも `null` でもない | 400 `INVALID_REQUEST` | `補足情報は文字列で指定してください`（既存） |
| 6 | `hint` が前後の空白を除いて 500 文字を超える | 400 `INVALID_REQUEST` | `補足情報は500文字以内で指定してください`（既存） |
| 7 | 写真が無い | 404 `PHOTO_NOT_FOUND` | `指定された写真が見つかりません` |
| 8 | `step: "identify"` だが写真のカテゴリが識別対象でない（`category` が `CATALOG_KINDS` のどれでもない。`other` か `null`） | 400 `INVALID_REQUEST` | `この写真は識別の対象ではありません` |

4 は `step` が文字列の `"classify"` か `"identify"` のときだけ通す（未指定・ほかの文字列・文字列でないものは 4）。
ボディがオブジェクトでない JSON（配列・数値・文字列・真偽値）は `step` が無いものとして扱い、4 になる。`step`・`hint` 以外のキーは無視する。
6 の上限（`CONTEXT_INFO_MAX_LENGTH`）と 5・6 の `message` は植物図鑑の補足情報（`contextInfo`。4-6 で削除）と共用していた定数 `CONTEXT_INFO_VALIDATION` のもので、上限の値は `message` に埋め込まれる。
写真があるか（7）はボディの検証の後に見るので、無い写真に不正なボディを送ると 400。
`step: "identify"` のときは、書く前に写真を読んで 7 と 8 をこの順に見る（無い写真は 8 ではなく 404）。`step: "classify"` は読まずに下の patch を当て、404 なら 7。
どちらも写真を読む・書く前に写真の保存先の設定を確かめる（下の 500）。読んでから書くまでに分類のワーカーがカテゴリを `other` に変えることはまれにありえ、そのときは受け付けた識別の待ちをワーカーが AI を呼ばずに内部の失敗として数える（[06 §3.1](./06_processing_design.md#31-契約)）。

処理の順:

1. 写真に patch: `processing = { state: "pending", step, attempts: 0, lastError: null, updatedAt: now }`（**`attempts` を 0 に戻す。** `failed` の写真をもう一度試せるのはこの操作だけ。[06 §1.3](./06_processing_design.md#13-状態と失敗)）、
   `hint`（前後の空白を除いたもの。送らない・`null`・除いて空なら `null` で、前回の `hint` は消える）、
   **`comment: null`・`commentSource: null`**（やり直しの結果で置き換えるため、受付の時点で消す。[02 §5](./02_design_overview.md#5-人間に決めてもらう点推奨付き) #9。
   利用者が書いたコメントは、アプリが `hint` に事前入力してから頼む設計なので失われない）、`updatedAt: now`。
   それ以外の項目（`category`・`classification`・`identification`・`tags`・`tripId`）は変えない（前回の結果はやり直しの結果が出るまで残る）。
   解析中（`pending` / `classifying` / `identifying`）の写真にも受け付ける（最新の依頼で上書きされる。走っている分類・識別の結果と失敗は、担当したときの `processing`（`state`・`step`・`attempts`・`updatedAt`）の条件付き patch で書かれずに捨てられる。[06 §1.3](./06_processing_design.md#13-状態と失敗)）。
   やり直しの回数に上限は置かない（費用は AI のデプロイの容量で抑える。[06 §6](./06_processing_design.md#6-費用の抑え方)）
2. キューに `{ photoId }` を投入する（`step`・`hint` はワーカーが写真から読む）
3. **202** `{ photo, urlExpiresAt }`（§5.3 と同じ形。受け付けた後の写真で、URL と `urlExpiresAt` はこの応答で発行したもの）

投入に失敗してもログだけ出して 202 を返す（写真は `pending` のまま残り、タイマーが 10 分以上たってから `processing.step` を見て再投入する。
失敗を返すと「失敗したのに後で勝手に走る」ことになる。[04 §7.1](./04_data_design.md#71-操作ごとの表)）。
Cosmos へ接続できなければ 503 `DATABASE_ERROR`（`データベースに接続できません`）、それ以外の失敗は 500 で `message` は `解析のやり直しの受付に失敗しました`。どちらも写真は変わらず、キューにも積まない。
写真の保存先の設定（`STORAGE_CONNECTION_STRING` のアカウント名・鍵、`PHOTO_STORAGE_CONTAINER_NAME`）が足りなければ、写真を書き換える前に同じ 500。詳細は [06 §1](./06_processing_design.md#1-キューとワーカー段階3)。

### 5.8 `POST /api/trips`

**実装済み**（PR 3。`trips.ts`、検証は `utils/tripInput.ts`）。

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

ボディがオブジェクトでない JSON（配列・数値・文字列・真偽値）は `name` が無いものとして扱い、5 になる。`name`・`description` 以外のキー（`tags` など）は無視する。
`description` の文字数は前後の空白を除かずに数える。

`name` は前後の空白を除いて保存。`description` はそのまま（空文字は `null` にする。空白だけの文字列はそのまま保存する）。`tags` は `[]`。
`createdAt` と `updatedAt` は同じ値。201 `{ trip }`（§3.1。集計は付かない）。
500 の `message`: `旅行の作成に失敗しました`。

### 5.9 `GET /api/trips`

**実装済み**（PR 3。`trips.ts`。表紙は PR 4a-2）。

`{ trips: TripSummary[], total, unassignedPhotoCount }`。`createdAt` 降順。`total` は旅行の数。
集計は [04 §5.1](./04_data_design.md#51-旅行一覧)（枚数と期間は `GROUP BY`、表紙は旅行ごとの `TOP 1`。写真を全部読まない）。
`unassignedPhotoCount` は旅行に属さない写真の枚数（`tripId` が `null` のもの。`GET /api/photos?tripId=none` が返す枚数と同じ定義）で、
同じ `GROUP BY` の結果から出す。旅行一覧の画面はこれで先頭の行の枚数を出し、別のリクエストを送らない。ページングは無い（旅行は数十件）。
未所属の枚数をここで返すことは #27 の案どおり実装した（PR 3。写真の一覧（§5.2）も PR 4a-2 で案どおり `total` を返さない）。表紙（`coverThumbnailUrl`）は旅行ごとに `TOP 1` を並列に読む（PR 4a-2）。
500 の `message`: `旅行一覧の取得に失敗しました`。

### 5.10 `GET /api/trips/{tripId}`

**実装済み**（PR 3。`tripDetail.ts`。表紙（§3.2）は PR 4a-2）。

| 順 | 条件 | ステータス・コード | `message` |
|----|------|-------------------|-----------|
| 1 | `tripId` が UUID 形式でない | 400 `INVALID_REQUEST` | `旅行IDの形式が無効です` |
| 2 | 無い | 404 `TRIP_NOT_FOUND` | `指定された旅行が見つかりません` |

`{ trip: TripSummary }`。500 の `message`: `旅行詳細の取得に失敗しました`。

### 5.11 `PUT /api/trips/{tripId}`

**実装済み**（PR 3。`tripDetail.ts`、検証は 5.8 と同じ `utils/tripInput.ts`）。

`name`（必須）と `description`（任意）の全体置き換え。検証は `tripId` の形式（5.10 の 1）→ 5.8 の 1〜7 の順。無ければ 404 `TRIP_NOT_FOUND`（読んだ後・置き換える前に旅行が消された場合も 404）
（旅行があるかはボディの検証の後に見るので、無い旅行に不正なボディを送ると 400）。
保存のしかたは 5.8 と同じ（`name` は前後の空白を除く、`description` の空文字は `null`）。**全体置き換えなので、`description` を省略するか `null` を送ると説明は消える。**
`tags` と `createdAt` は変えず、`updatedAt` を更新する。200 `{ trip }`（§3.1。集計無し）。500 の `message`: `旅行の更新に失敗しました`。

### 5.12 `DELETE /api/trips/{tripId}?deletePhotos=true|false`

**実装済み**（PR 4b。`tripDetail.ts`、写真と旅行の処理は `AlbumService.deleteTrip()`、画像の削除は `PhotoStorageService.deletePhotoBlobs()`（`DELETE /api/photos/{photoId}` と共用））。

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
| 4 | 無い（同じ id のドキュメントが写真でも） | 404 `TRIP_NOT_FOUND` | `指定された旅行が見つかりません` |

`deletePhotos` の値は小文字の `true` / `false` だけを受け付ける（`TRUE`・`yes`・空文字は 3）。旅行があるか（4）は 1〜3 の後に見るので、無い旅行に `deletePhotos` を付け忘れると 400。

処理の順（[04 §7.1](./04_data_design.md#71-操作ごとの表)）:

1. 旅行を読む（無ければ 404。写真にも画像にも触らない）
2. 中の写真の射影をページで読み（[04 §5](./04_data_design.md#5-クエリ) の 5.10）、1枚ずつ、`true` ならドキュメント → 原寸とサムネイルの Blob の順に消す（Blob の失敗はログだけで続ける。原寸で失敗してもサムネイルは消しにいく。Blob が既に無いのは成功）、
   `false` なら `tripId` を `null`・`updatedAt` を今に patch する（move の「外す」と同じ。他の項目と Blob には触らない）
3. 写真のドキュメントの削除・patch に失敗したら中断する（済んだ分はそのまま。旅行は残り、再送で続きができる）
4. 旅行を消す。他の操作が先に消していた（404）なら成功とする

旅行の読み取り・写真の射影の読み取り・写真の削除や patch・旅行の削除のどこで失敗しても、Cosmos へ接続できなければ 503 `DATABASE_ERROR`（`データベースに接続できません`）、それ以外は 500。
写真の保存先の設定（`STORAGE_CONNECTION_STRING` のアカウント名・鍵、`PHOTO_STORAGE_CONTAINER_NAME`）が足りなければ、`deletePhotos=false` でも何も変える前に 500。

旅行を消した後の見直しはしない。削除の途中に届いた送信・move の写真が残っても消さず（`deletePhotos=true` でも、2 で読んだ射影に無かった写真は消さない）、
段階3の掃除のタイマーが未所属に戻す（まれで、写真は消えないので許容。[04 §7.3](./04_data_design.md#73-旅行の削除と重なった送信move)）。

```json
{ "success": true, "data": { "message": "旅行が正常に削除されました", "deletedPhotoCount": 12, "detachedPhotoCount": 0 } }
```

`deletedPhotoCount` は消した写真の数（`false` なら 0。画像の削除に失敗した写真も、ドキュメントを消せば数える）、`detachedPhotoCount` は未所属に移した数（`true` なら 0）。写真の無い旅行ならどちらも 0。
途中で失敗して再送したときは、再送で処理した分だけを数える。
500 の `message`: `旅行の削除に失敗しました`。

### 5.13 `GET /api/tags`（段階は未定）

`{ tags: string[] }`。写真の `tags`（利用者のタグ）の `DISTINCT`。文字列順。タグを付ける画面を入れる段階で一緒に入れる（カテゴリは `GET /api/catalog/kinds` + `other` で分かるので、ここには含めない）。
500 の `message`: `タグ一覧の取得に失敗しました`。

### 5.14 図鑑（段階4）

API の形（項目を `kind` と `name` で指定して名前をクエリ文字列に載せること、該当する写真が無いときに 200 で `entry: null` を返すこと、
項目一覧を `offset` / `limit`・項目の写真を `continuationToken` でページに分けること、項目の削除 API を置かないこと）は、2026-10-18 にこの節のとおりに決めた
（[02 §5](./02_design_overview.md#5-人間に決めてもらう点推奨付き) #20）。§2 の表と §3.3.1・§7.1・§8 の図鑑の記述も同じ。
まとめ方そのもの（`GROUP BY` + 項目ごとの `TOP 1`。[04 §5.6](./04_data_design.md#56-図鑑のまとめ段階4)）は決定済み（#28）。

項目は文書ではなく、識別済みの写真を `identification.kind` と `identification.name` でまとめたもの（[04 §3.1](./04_data_design.md#31-項目は写真からまとめる)）。
一覧も詳細も、呼ばれるたびに写真からまとめるが、**写真を全部読まない**（枚数は `GROUP BY`、見出しは項目ごとに `TOP 1`、写真はページ）。

| エンドポイント | 内容 | エラー |
|---|---|---|
| `GET /api/catalog/kinds` | `{ kinds: [{ kind, label, fields: [{ key, label, type }] }] }`。定義表（[04 §3.2](./04_data_design.md#32-定義表-catalog_kindsapisrccatalogkindsts)）の種類と項目を表の順に返す。AI に渡す指示（`prompt`・`namingRule`）は返さない。DB にも Blob にも触らない。**実装済み（4-2a）** | なし（定義表を返すだけで、失敗する経路が無い。例外を捕まえて封筒の 500 にする処理も置いていない） |
| `GET /api/catalog/entries?kind=&offset=&limit=` | `{ entries: CatalogEntry[], total }`（§3.3.1）。`kind` 必須、定義表に無ければ 400 `図鑑の種類が無効です`。`name` の文字列順に並べ、`offset`（既定 0）から `limit`（既定 50、上限 100。`CATALOG_PAGE_SIZE` / `CATALOG_MAX_PAGE_SIZE`）件。`total` は項目の総数（ページに依らない）。0 件なら `[]`・`0`。`offset` が項目の数以上なら `[]` で `total` はそのまま。検証は下の表。**実装済み（4-2a）** | 503 `DATABASE_ERROR`（接続できない。§1）、500 `図鑑の一覧の取得に失敗しました`（それ以外。表紙の URL を作れない（写真の保存先の設定が足りない）ときも） |
| `GET /api/catalog/entry?kind=&name=&limit=&continuationToken=` | `{ entry: CatalogEntry \| null, photos, continuationToken, urlExpiresAt }`。`photos` はその名前の写真の1ページ（`sortAt` 順。`limit` / `continuationToken` は §5.2 と同じ）。`entry.photoCount` は `COUNT` で数えた総数。該当する写真が無ければ **200** で `entry: null`・`photos: []`・`continuationToken: null`。検証は下の表。**実装済み（4-2b）** | 400（下の表）、503 `DATABASE_ERROR`（接続できない。§1）、500 `図鑑の項目の取得に失敗しました`（それ以外。写真の保存先の設定が足りないときも） |

項目一覧のページを `offset` / `limit` にするのは、`GROUP BY` の結果（項目の行）をサーバで名前順に並べてから切るためで、Cosmos の継続トークンが使えない。
名前順は文字列の符号単位の順（JavaScript の `<` の比べ方。ロケールに依らず、どの環境でも同じ並びになる）。
数えてから見出しの写真を読むまでの間に、その名前の写真が無くなった（消された・やり直しで名前が変わった）項目は、そのページから外す（`total` は数えたときのまま）。まれで、次に開けば数え直される。
そのため `entries` の件数は、続きがあっても `limit` より少ないことがある。
項目の行は小さいので、ページごとに `GROUP BY` をやり直しても読む量は写真の枚数に依らない（[04 §3.1](./04_data_design.md#31-項目は写真からまとめる) の「規模の注意」）。

`GET /api/catalog/entries` の検証（順に。最初に失敗した1件だけ返す。Cosmos に触る前に弾く）:

| 順 | 条件 | ステータス・コード | `message` |
|----|------|-------------------|-----------|
| 1 | `kind` が無い、または定義表に無い（`other` や、`constructor` などの継承したキーも） | 400 `INVALID_REQUEST` | `図鑑の種類が無効です` |
| 2 | `offset` が 0 以上の整数の10進表記（`0` か、先頭が `0` でない数字の並び）でない（空・負・小数・数字以外を含む）、または安全な整数（2^53 − 1）を超える | 400 `INVALID_REQUEST` | `ページの指定が無効です` |
| 2 | `limit` が 1 以上の整数の10進表記（先頭が `0` でない数字の並び）でない（空・`0`・小数・数字以外を含む）、または上限（`CATALOG_MAX_PAGE_SIZE`。既定 100）を超える | 400 `INVALID_REQUEST` | `ページの指定が無効です` |

- 「無い」と「空」を分ける。`offset` が無ければ 0、`limit` が無ければ既定（`CATALOG_PAGE_SIZE`。既定 50。上限より大きく設定されていても上限で止める）。空の文字列は 400（写真の一覧の `limit` と同じ）
- `offset` と `limit` は同じ `message` で、どちらが悪いかは言わない。`kind` もページも不正なら `kind` の指摘を返す
- `kind` は前後の空白を除かずに定義表のキーと比べる（大文字小文字も区別する）

`GET /api/catalog/entry` の検証（順に。最初に失敗した1件だけ返す。1〜5 は Cosmos に触る前に弾く。`utils/catalogInput.ts` の `readCatalogEntryQuery`）:

| 順 | 条件 | ステータス・コード | `message` |
|----|------|-------------------|-----------|
| 1 | `kind` が無い、または定義表に無い（`other` や、`constructor` などの継承したキーも。項目一覧と同じ） | 400 `INVALID_REQUEST` | `図鑑の種類が無効です` |
| 2 | `name` が無い、または前後の空白を除いて空 | 400 `INVALID_REQUEST` | `図鑑の項目の名前が指定されていません` |
| 3 | `name` が前後の空白を除いて 100 文字（`CATALOG_VALIDATION.NAME_MAX_LENGTH`）を超える | 400 `INVALID_REQUEST` | `図鑑の項目の名前は100文字以内で指定してください` |
| 4 | `limit` があり、1〜200 の整数でない（§5.2 の 4 と同じ規則と文言） | 400 `INVALID_REQUEST` | `1ページの枚数は1〜200で指定してください` |
| 5 | `continuationToken` があり、空か JSON として読めない（§5.2 の 5 と同じ） | 400 `INVALID_REQUEST` | `継続トークンの形式が無効です` |
| 6 | `continuationToken` が JSON だが Cosmos が受け付けない（別の項目のトークンなど。サーバが 400 で拒む。推測） | 400 `INVALID_REQUEST` | `継続トークンの形式が無効です` |

- 2 と 3 の `message` は `CATALOG_VALIDATION.ERROR_MESSAGES` の `NAME_REQUIRED`・`NAME_TOO_LONG`（3 は上限値 `NAME_MAX_LENGTH` を埋め込む）。`name` もページも不正なら `name` の指摘を返す
- 6 は、トークンを渡した写真のページのクエリが Cosmos から `code` 400 で失敗したときだけ返す（写真の一覧と同じ。`AlbumService.listPhotos()` が `InvalidContinuationTokenError` にする）。見出しや枚数のクエリの 400（複合インデックスが無いときなど）は 500。
  トークンを渡していない要求の 400 も 500。見出しの写真が無い（`entry: null`）ときは写真のページを読まないので、項目が消えた後の古いトークンでも 6 にならず 200 で `entry: null` を返す
- `limit` の既定は 100（`PHOTO_PAGE_SIZE`）、上限 200（`PHOTO_MAX_PAGE_SIZE`）。トークンの大きさの上限（2KB）、空のページを読み進める扱い、最後のページが空のことがあるのも §5.2 と同じ（`AlbumService.listPhotos()` を同じ設定で使う）
- 続きのページの要求でも、見出しの写真と枚数をそのつど読み直して `entry` に入れる。続きを読む間に写真が0枚になれば、その応答は `entry: null`・`photos: []`・`continuationToken: null`
- `urlExpiresAt` は、表紙（`entry.coverThumbnailUrl`）と `photos` の URL の共通の期限（§6 の 60 分。要求を受けたときに1回決める）
- 写真の保存先の設定（`STORAGE_CONNECTION_STRING`・`PHOTO_STORAGE_CONTAINER_NAME`）が足りなければ 500。保存先は URL を作るときに初めて作るので、項目が無い（`entry: null`）ときは保存先の設定を読まない（項目一覧と同じ）
- **名前はクエリ文字列に URL エンコードして載せる**（アプリは `Uri(queryParameters:)` で組み立てる。§8。Functions の `request.query.get('name')` が復号する）。
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
| 有効期限 | 発行から 60 分（`PHOTO_SAS_EXPIRY_MINUTES`。読めない値・0・負なら 60） | 旅行詳細を開いて眺める時間として十分で、ログに残っても長期間は読めない |
| `startsOn` | 発行の 5 分前（`PHOTO_SAS_START_SKEW_MINUTES`。`constants/album.ts`） | サーバと Blob の時計のずれで「まだ有効でない」になるのを防ぐ |
| 応答 | 各 URL と、まとめて `urlExpiresAt`（ISO, UTC。期限は SAS の `se` に合わせて秒に切り捨てるので、ミリ秒の桁は常に `.000`）。旅行の表紙（§3.2）と図鑑の項目一覧の表紙（§3.3.1）には `urlExpiresAt` を付けない（図鑑の項目の詳細の `urlExpiresAt` は、`entry` の表紙と `photos` の共通の期限。§5.14） | クライアントが期限を知って取り直せる。秒を切り捨てないと `urlExpiresAt` が実際の期限より最大1秒遅れる |

- 署名は `utils/blobSas.ts` の `generateReadSasUrl()`（植物図鑑の `storageService.ts`（4-6 で削除）から切り出したもの）。写真の URL は `PhotoStorageService.readUrl()` が `startsOn` を付けて呼び、
  期限は `photoUrlExpiresOn()`（`services/photoStorageService.ts`）が応答ごとに1回決めて、その応答のすべての URL と `urlExpiresAt` に同じ値を使う。
  植物図鑑の一時画像の `generateTempSasUrl()`（`startsOn` を渡さない薄い包み）は、`upload` と一緒に 4-6 で削除した
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

`createNotFoundError(message, code)` は第2引数の `code` が**必須**（既定値を置かない。旅行や写真の 404 で渡し忘れると別のもののコードが返り、クライアントの分岐を誤らせるため。実装済み）。
植物図鑑の `PLANT_NOT_FOUND` は、植物の API と一緒に 4-6 で削除した。

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
| `GET /api/catalog/kinds` | なし（失敗する経路が無い。§5.14） |
| `GET /api/catalog/entries` | `図鑑の一覧の取得に失敗しました`（§5.14） |
| `GET /api/catalog/entry` | `図鑑の項目の取得に失敗しました`（§5.14。4-2b） |

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
| `uploadPhoto(...)` | `POST /api/photos` | `data['photo']`（`urlExpiresAt` と 201 / 200 の区別は読まない。200（別の場所）は、呼び出し側の `UploadQueue` が応答の `photo.tripId` と送った `tripId` を比べて判断する。区別が要らないので、201 / 200 を返す目標は 2026-10-15 に外した） |
| `getPhotos({tripId, category, continuationToken})` | `GET /api/photos` | `data['photos']`・`data['continuationToken']`（null 可）。`urlExpiresAt` は読まない。`continuationToken` は省略でき、`tripId`・`category` は少なくとも一方が要る（両方無いとサーバは 400。デバッグ版では `assert` が送る前に止める）。渡したものだけをクエリに載せる（`Uri(queryParameters:)` で組み立てるので URL エンコードされる）。`tripId` は旅行の id か `none`、省くと旅行をまたぐ（カテゴリの写真の画面。`category` だけで取る）。`limit` は送らない（サーバの既定 100）。**`category` は実装済み**（3-4b）。少なくとも一方を渡すのは呼び出し側（`PhotoGrid` を置く画面）の責任 |
| `getPhoto(photoId)` | `GET /api/photos/{photoId}` | `data['photo']` |
| `deletePhoto(photoId)` | `DELETE /api/photos/{photoId}` | 読まない |
| `movePhotos(photoIds, tripId)` | `POST /api/photos/move` | `data['moved']`・`data['notFound']` |
| `updatePhotoComment(photoId, comment)` | `PATCH /api/photos/{photoId}` | `data['photo']`（`urlExpiresAt` は読まない）。**実装済み**（4-3c。コメントだけ）。ボディは `{ comment }` で、入力をそのまま送る（前後の空白を除くのと、空・空白だけを `null` と同じに扱うのはサーバ。§5.6）。タグを直すメソッドは、タグを付ける画面と一緒に足す |
| `requestPhotoProcessing(photoId, {hint, step})` | `POST /api/photos/{photoId}/process` | `data['photo']`（`urlExpiresAt` は読まない）。**実装済み**（3-4a。`step` は 4-3c）。ボディは `{ step, hint }` で、`step` は省くと `'classify'`（やり直しダイアログが「名前だけ」なら `'identify'` を渡す）。`hint` は前後の空白を除き、空なら `hint` のキーごと省く |
| `getCatalogKinds()` | `GET /api/catalog/kinds` | `data['kinds']`（各要素の `kind`・`label`・`fields`（`key`・`label`・`type`）。`models/catalog.dart` の `CatalogKind`・`CatalogField`）。**実装済み**（4-3a） |
| `getCatalogEntries(kind, {required offset, required limit})` | `GET /api/catalog/entries?kind=&offset=&limit=` | `data['entries']`・`data['total']`（`CatalogEntryPage`。項目は `CatalogEntry`）。**実装済み**（4-3a）。`kind`・`offset`・`limit` を毎回クエリに載せる（`Uri(queryParameters:)`。図鑑の画面は `limit` に 50 を渡す）。`entries` の件数は続きがあっても `limit` より少ないことがある（§5.14）ので、次の `offset` は呼び出し側が `limit` だけ進め、`total` 以上なら読み切り（[03 §6.1](./03_screen_design.md#61-図鑑タブ種類タブ--項目一覧)）。`CatalogEntry` は `description`・`characteristics` を null 可、`attributes` が無ければ空、それ以外の欄は必須として読む |
| `getCatalogEntry(kind, name, {continuationToken})` | `GET /api/catalog/entry?kind=&name=&continuationToken=` | `data['entry']`（null 可。`CatalogEntry`）・`data['photos']`・`data['continuationToken']`（null 可）（`models/catalog.dart` の `CatalogEntryDetail`。写真は `PhotoPage`）。**実装済み**（4-3b）。`kind`・`name` を毎回、`continuationToken` は渡したときだけクエリに載せる（`Uri(queryParameters:)` で組み立てるので、記号や空白を含む名前も URL エンコードされる）。`limit` は送らない（サーバの既定 100）。`urlExpiresAt` は読まない（`getPhotos` と同じ）。`photos` は `entry` が null でも必須として読む（サーバは `[]` を返す）。`CatalogEntry` の読み方は `getCatalogEntries` と同じ |

`_parseResponse()` はボディ全体をコールバックに渡すので、各メソッドが `json['data']` を剥がす（CLAUDE.md「クライアント実装で踏みやすい罠」）。
既存の `testConnection()`（設定画面の接続テスト）は 4-5 で宛先を `GET /api/plants` から、旅行をまたぐ写真の一覧を1件だけ読む `GET /api/photos?category=plant&limit=1` に変えた（データベースに届かなければ失敗として出る）。ステータスが 2xx かだけを見て、ボディは読まない（通信の失敗も含めて例外を投げず `false` を返す。[03 §6.4](./03_screen_design.md#64-植物図鑑の廃止に伴う画面の削除)）。
植物図鑑のメソッド（`uploadAndIdentifyImage`・`checkDuplicate`・`savePlant`・`getPlants`・`getPlant`・`updatePlant`・`deletePlant`）は 4-5 で削除した。
`ApiException` に `isTripNotFound`（`code == 'TRIP_NOT_FOUND'`）と `isPhotoNotFound`（`code == 'PHOTO_NOT_FOUND'`。複数選択の削除で既に無い写真を消せたと数える。ステータスだけで見ると宛先の誤りの 404 まで含むのでコードで見る）を足す。
`uploadPhoto` は **実装済み**（PR 7a。`thumbnail`・`placeName` は PR 7c）。`multipart/form-data` で次のパートを送る。

- `photoId`: 画像のバイト列の SHA-256（16進・小文字）。`image` と同じバイト列から求める（§5.1 の 18 を通るように）
- `image`: 画像のバイト列。ファイル名は `photo`、Content-Type は拡張子ではなく先頭のバイト列（シグネチャ）で決める（PNG / JPEG / GIF / WebP。どれでもなければ `image/jpeg`）
- `tripId`・`takenAt`: 値があるときだけ。無ければパートごと省く（空文字のパートは §5.1 の 12・13 で 400 になる）
- `latitude`・`longitude`: 両方があるときだけ、両方を送る（片方だけは §5.1 の 14）。10進の小数 6 桁の文字列（`toStringAsFixed(6)`。指数表記にならない。§5.1 の 15）
- `thumbnail`: サムネイル（[03 §4.7](./03_screen_design.md#47-写真の追加と送信の進み具合) の準備で作った長辺 320px・画質 70 の JPEG）があるときだけ。ファイル名は `thumbnail.jpg`、Content-Type は `image/jpeg`。作れなかったらパートごと省く（空のパートは §5.1 の 10 で 400）
- `placeName`: 地名（[06 §4.2](./06_processing_design.md#42-段階2端末)）があり、緯度・経度も送るときだけ（§5.1 の 16）。無ければパートごと省く（空・空白のみは §5.1 の 17 で 400）

`movePhotos` は 200 件（§5.5 の 5）を超える分を分けて順に送り、`moved`・`notFound` を合わせて返す。旅行から外すときも `tripId` のキーを省かずに `null` を送る。
