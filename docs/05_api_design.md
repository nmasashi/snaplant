# 旅行アルバム API 設計

## この文書の位置づけ

SnapPlant の REST API を書く。エラーの契約（ステータス・`code`・`message`）は文言まで決める。**未実装を含む目指す姿**で、実装したエンドポイントには「実装済み」の印を付ける（2026-10-25 に、旅行アルバムの設計一式（以前の `docs/`）をこの `docs/` に移し、植物図鑑の頃の文書を置き換えた。人間が決定）。
この文書が API の正（OpenAPI の仕様書は 2026-10-25 にやめた）。実装したエンドポイントは `README.md` のエンドポイント表にも書く。認証・応答の封筒・エラーの共通の決まり・AI への接続は §9（以前の `docs/06_api_design.md` から移した）。

データの形は [04_data_design.md](./04_data_design.md)、裏の処理は [06_processing_design.md](./06_processing_design.md)、
画面からの使い方は [03_screen_design.md](./03_screen_design.md) を参照する。
エラーの `message`・検証の順序・上限値は第3版に無く、この文書で既存の流儀（以前の植物図鑑の API 設計の §5.4・§5.8。植物図鑑の API と一緒に 4-6 で削除）に合わせて決めた。

---

## 1. 基本方針

既存の API と同じ。

- 全エンドポイントは `authLevel: 'function'`。関数キーが要る（ヘッダ `x-functions-key`。§9.1）。`routePrefix` は `api`
- 応答は封筒 `{ success: true, data }` / `{ success: false, error: { code, message, details? } }`。`utils/response.ts` のヘルパー経由で作る
- **契約はステータス・`code`・`message` まで。`details` は契約外**（CLAUDE.md「レスポンス規約」）
- 入力検証は上から順に行い、最初に失敗した1件だけを返す。**Cosmos DB・Blob に触る前に全部弾く**
- Cosmos DB へ接続できない → 503 `DATABASE_ERROR`（`データベースに接続できません`）。判定は `isConnectivityError()`（`utils/errors.ts`。`hasCauseCode()` を使う述語。Cosmos DB の判定はこれだけで、ハンドラごとに複製しない）で、
  errno が `ENOTFOUND`・`ECONNREFUSED`・`ETIMEDOUT` のもの、または Cosmos SDK が自分の待ち時間で打ち切ったエラー（`code` が `TimeoutError`）を `cause` の奥までたどって探す（一覧 `UNREACHABLE_ERRNOS` はストレージ・AI 側の判定と共有する。`ETIMEDOUT` は 2026-11-01 に足した。それまでは 500）。
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
| `/api/trips` | GET | `{ trips, total, unassignedPhotoCount }` | 各旅行に `photoCount`・`firstTakenAt`・`lastTakenAt`・`coverThumbnailUrl`。最初の撮影日時の新しい順（§5.9）。旅行に属さない写真の枚数も返す | 2 | `trips.ts` |
| `/api/trips/{tripId}` | GET | `{ trip }` | 集計付き | 2 | `tripDetail.ts` |
| `/api/trips/{tripId}` | PUT | `{ trip }` | `{ name, description? }` | 2 | `tripDetail.ts` |
| `/api/trips/{tripId}` | DELETE | `{ message, deletedPhotoCount, detachedPhotoCount }` | `deletePhotos=true|false`（必須）。`true` なら中の写真と Blob も消す、`false` なら写真を未所属に移す | 2 | `tripDetail.ts` |
| `/api/photos` | POST | `{ photo, urlExpiresAt }` 201（新規）/ 200（既存） | multipart。`tripId` は任意（送り方 ①②） | 2 | `photos.ts` |
| `/api/photos` | GET | `{ photos, continuationToken, urlExpiresAt }` | `tripId=<uuid>` か `tripId=none`、または `category=`（段階3。どちらか1つは要る。両方なら AND）。`sortAt` 昇順（撮影日時順、無い写真はアップロード日時）。`limit` と `continuationToken` でページ | 2 | `photos.ts` |
| `/api/photos/move` | POST | `{ moved, notFound }` | `{ photoIds, tripId }`。送り方 ③ と「外す」。1回 200 件まで | 2 | `photoMove.ts` |
| `/api/photos/{photoId}` | GET | `{ photo, urlExpiresAt }` | | 2 | `photoDetail.ts` |
| `/api/photos/{photoId}` | DELETE | `{ message }` | | 2 | `photoDetail.ts` |
| `/api/photos/{photoId}` | PATCH | `{ photo, urlExpiresAt }` | `{ comment?, takenAt?, tags?, category? }`。構造は2、画面は4。`category`（手で決めるカテゴリ）は C-1（実装済み）。`tags` の形（`{ name, kind, x, y }`）は C-3a、タグの画面は C-3b（どちらも実装済み）。`takenAt`（撮影日時を手で付ける。カメラの撮影日時の写真は 409）は D-1（実装済み）、画面は D-2（実装済み） | 2 | `photoDetail.ts` |
| `/api/photos/{photoId}/process` | POST | `{ photo, urlExpiresAt }` 202 | `{ step, hint?, placeName? }`。写真に `step`・`hint` を書いてキューに投入。`placeName`（撮影地の地名を直す）は C-2（実装済み） | 3（`identify` は4） | `photoProcess.ts` |
| `/api/tags` | GET | `{ tags }` | 利用者のタグの名前の `DISTINCT` | 未定（C-3 には入れない。[02 §5](./02_design_overview.md#5-人間に決めてもらう点推奨付き) #57） | `tags.ts` |
| `/api/catalog/kinds` | GET | `{ kinds }` | 定義表のうち図鑑に載せる種類（`inCatalog`。今は植物だけ）を表の順に | 4（4-2a。図鑑に載せる種類だけにしたのは B-2。実装済み） | `catalogKinds.ts` |
| `/api/catalog/entries` | GET | `{ entries, total }` | `kind=` 必須（図鑑に載せる種類だけ。食べ物・風景は 400）。`GROUP BY` で数え、項目ごとに見出しの写真を1枚読む。属の学名の順（同じ属は名前の順、属が分からない項目は最後。P-1）に並べ、`offset` / `limit` でページ。各項目に `genus`・`genusName`（P-1）・`photoCount`・`coverThumbnailUrl`（`urlExpiresAt` は付けない） | 4（4-2a。食べ物・風景を断るのは B-2。実装済み） | `catalogEntries.ts` |
| `/api/catalog/entry` | GET | `{ entry, photos, continuationToken, urlExpiresAt }` | `kind=` と `name=`（URL エンコード）で1件を指定（`kind` は図鑑に載せる種類だけ。食べ物・風景は 400）。該当する写真が無ければ `entry: null`。`photos` は `GET /api/photos` と同じページング（ページごとに `entry` も読み直す） | 4（4-2b。食べ物・風景を断るのは B-2。実装済み） | `catalogEntry.ts` |
| `/api/trips/{tripId}/timeline` | GET | `{ timeline, pendingPhotoCount, urlExpiresAt }` | 完成版と下書きの状態。無ければ `timeline: null`。§5.15 | 5（5-1c。実装済み） | `timeline.ts` |
| `/api/trips/{tripId}/timeline` | POST | `{ draft, urlExpiresAt }` 202 | 作る・作り直す（区切り案の下書きから）。解析中の写真があれば 409 | 5（5-1a。実装済み） | `timeline.ts` |
| `/api/trips/{tripId}/timeline/excluded-photos` | POST | `{ timeline, pendingPhotoCount, urlExpiresAt }` | `{ photoIds }`。完成版から写真を外す（戻さない）。`data` は `GET …/timeline` と同じ形 | 5（T-1。実装済み） | `timelineCurrent.ts` |
| `/api/trips/{tripId}/timeline/recut` | POST | `{ draft, urlExpiresAt }` | 完成版の区切りを直し始める（下書きを作る）。`draft` は `GET …/draft` の確かめ中と同じ形 | 5（5-2b。実装済み） | `timelineCurrent.ts` |
| `/api/trips/{tripId}/timeline/draft` | GET | `{ draft, urlExpiresAt }` | 下書きの状態と、確かめ中か文を書くのに失敗した下書きなら区切り | 5（5-1a。実装済み） | `timelineDraft.ts` |
| `/api/trips/{tripId}/timeline/draft` | DELETE | `{ draft: null }` | 下書きをやめる | 5（5-1a。実装済み） | `timelineDraft.ts` |
| `/api/trips/{tripId}/timeline/draft/scenes` | PUT | `{ draft, urlExpiresAt }` | `{ sceneStarts, sceneComments? }`。下書きの区切りと場面のコメントを保存。`draft` は `GET …/draft` の確かめ中と同じ形 | 5（5-1c。`sceneComments` は 5-7。実装済み） | `timelineDraft.ts` |
| `/api/trips/{tripId}/timeline/draft/excluded-photos` | POST | `{ draft, urlExpiresAt }` | `{ photoIds }`。下書きから写真を外す（戻さない）。`draft` は `GET …/draft` の確かめ中と同じ形 | 5（T-1。実装済み） | `timelineDraft.ts` |
| `/api/trips/{tripId}/timeline/draft/write` | POST | `{ draft, urlExpiresAt }` 202（区切りを直している下書きは `{ draft: null, urlExpiresAt }` 200） | 確かめた区切りで文を書く（文を書く待ちにしてキューに積む）。区切りを直している下書き（`recut`）は、キューに積まずその場で完成版に当てる | 5（5-2a。`recut` は 5-5a。実装済み） | `timelineDraft.ts` |
| `/api/trips/{tripId}/timeline/days/{date}` | PATCH | `{ timeline, pendingPhotoCount, urlExpiresAt }` | `{ title?, summary? }`。完成版の文。`data` は `GET …/timeline` と同じ形 | 5（5-2b。実装済み） | `timelineCurrent.ts` |
| `/api/trips/{tripId}/timeline/scenes/{photoId}` | PATCH | 同上 | `{ label?, note? }`。完成版の文 | 5（5-2b。実装済み） | `timelineCurrent.ts` |

図鑑の項目は文書として持たず、写真の `identification` からまとめる（[04 §3](./04_data_design.md#3-図鑑の項目と定義表段階4)）。
そのため項目の id は無く、項目は `kind` と `name` で指定する。項目を削除する API は置かない。項目は写真の集まりに過ぎず、
「この項目を消す」に当たる操作は、写真を消す（`DELETE /api/photos/{photoId}`）か、識別をやり直す（`process`。要件 5.5.1）で足りる。

- 同じルートを複数ファイルが別々のメソッドで登録してもよい（植物図鑑の `plants/{id}` はそうしていた。4-6 で削除）が、ここでは `photoDetail.ts` が GET / DELETE / PATCH を、
  `tripDetail.ts` が GET / PUT / DELETE を1つのファイルで登録する。
  実装済みの旅行と写真の関数は**メソッドごとに別の `app.http`** で登録している（`trips.ts` が `listTrips`（GET）・`createTrip`（POST）、`tripDetail.ts` が `getTrip`（GET）・`updateTrip`（PUT）・`deleteTrip`（DELETE）、
  `photos.ts` が `listPhotos`（GET）・`createPhoto`（POST）、`photoDetail.ts` が `getPhoto`（GET）・`deletePhoto`（DELETE）・`updatePhoto`（PATCH）、`photoMove.ts` が `movePhotos`（POST）、`photoProcess.ts` が `requestPhotoProcessing`（POST。段階3）、`catalogKinds.ts` が `listCatalogKinds`（GET。4-2a）、`catalogEntries.ts` が `listCatalogEntries`（GET。4-2a）、`catalogEntry.ts` が `getCatalogEntry`（GET。4-2b）、`timeline.ts` が `getTimeline`（GET。5-1c）・`createTimeline`（POST。5-1a）、`timelineDraft.ts` が `getTimelineDraft`（GET）・`deleteTimelineDraft`（DELETE。どちらも 5-1a）・`putTimelineDraftScenes`（PUT。`…/draft/scenes`。5-1c）・`postTimelineDraftWrite`（POST。`…/draft/write`。5-2a）・`postTimelineDraftExcludedPhotos`（POST。`…/draft/excluded-photos`。T-1）、`timelineCurrent.ts` が `postTimelineRecut`（POST。`…/recut`）・`patchTimelineDay`（PATCH。`…/days/{date}`）・`patchTimelineScene`（PATCH。`…/scenes/{photoId}`。どれも 5-2b）・`postTimelineExcludedPhotos`（POST。`…/excluded-photos`。T-1）。
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
  "categorySource": null,
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
`location` は位置情報が無ければ `null`。写真の送信（§5.1）で作った `location` は `latitude`・`longitude` が必ず数値で、`placeName`・`placeSource` は `null` になりうる（緯度・経度だけを送ったとき）。
**実装済み**（C-2）: 利用者が解析を頼むときに場所（撮影地の地名）を直す（§5.7）と、`placeSource` が `"user"` になる。位置情報の無い写真に地名を書いたときは `latitude`・`longitude` が `null` の `location`（地名だけの撮影地。`{ "latitude": null, "longitude": null, "placeName": "函館朝市", "placeSource": "user" }`）になる。
`placeSource` は `"device"`（送信のときに端末が引いた地名）・`"user"`（利用者が直した地名と、利用者が地名を消した緯度・経度だけの撮影地（`placeName: null`）。C-2）・`null`（送信のときに地名が無かった）のどれか（`"server"` は Azure Maps で埋める設計の値で、まだ書く処理が無い。[04 §1.3](./04_data_design.md#13-写真type-photo)）。
クライアントは `latitude`・`longitude`・`placeName` を読み（`latitude`・`longitude` は `null` 可として読む。`location` が `null` のときと地名だけの撮影地のとき）、写真ビューアの下の情報に地名（無ければ緯度・経度、`location` が `null` なら「位置情報なし」）を出す（[03 §4.6](./03_screen_design.md#46-写真ビューア)）。`placeSource` は読まない。
C-2 からは `placeName`・`latitude` を、解析を頼むダイアログの「場所」の欄の事前入力と、欄の下の案内の出し分けにも使う（[03 §5.4](./03_screen_design.md#54-やり直しダイアログ)）。
段階3からは `category`・`processing.state`（`processing` が無ければ `none` とみなす）・`comment`・`commentSource`・`hint` も読み、写真ビューアのカテゴリと分類の状態、サムネイルの印、やり直しダイアログの事前入力に使う（[03 §5.1・§5.4・§5.5](./03_screen_design.md#5-段階3の画面骨格)）。段階4（4-3c）からは `processing.step`（無ければ `null`。状態の表示を「分類中...」「識別中...」に分ける）と `identification` の `kind`・`matchesKind`・`name`（図鑑の項目へのリンクと、分類と合わない写真の案内。[03 §6.3](./03_screen_design.md#63-写真ビューアへの追加)）も読む。`processing` のほかの項目、`classification`、`identification` のほかの項目は読まない。
`takenAt` は**タイムゾーン無し**の文字列のまま返す（クライアントは変換しない）。`takenAtSource` は撮影日時の出どころで、`"exif"`（送信のときにカメラの記録から読んだ）・`"user"`（利用者が手で付けた。§5.6。**実装済み**（D-1））・`"none"`（撮影日時が無い）のどれか（[04 §1.3](./04_data_design.md#13-写真type-photo)）。`sortAt`（並べ替え用。[04 §1.3](./04_data_design.md#13-写真type-photo)）もそのまま返す（クライアントは表示に使わない）。
`category` は AI の大分類（`plant` / `food` / `landscape` / `other`、分類前は `null`。利用者が手で直せる。§5.6）、`tags` は利用者のタグだけ（[04 §2](./04_data_design.md#2-カテゴリとタグ)。C-3a から各要素は `{ name, kind, x, y }`）。
**実装済み**（C-3b。`models/photo.dart` の `PhotoTag`）: クライアントは `tags` を読み（無い・`null` なら空）、各要素の `name`・`kind`（文字列）と `x`・`y`（数）を必須として読む。写真ビューアの写真の上と下の情報にタグを出す（[03 §5.7](./03_screen_design.md#57-写真のタグ)）。
`categorySource`（**実装済み**（C-1））は、利用者がカテゴリを手で決めた（§5.6）なら `"user"`、それ以外は `null`。ドキュメントに項目が無い写真（C-1 より前の写真と、手で決めたことも分類からやり直したことも無い写真。[04 §1.3](./04_data_design.md#13-写真type-photo)）も `null` で返す。写真を返すすべての応答（`POST /api/photos`・`GET /api/photos`・`GET` / `PATCH /api/photos/{photoId}`・`process`・`GET /api/catalog/entry` の `photos`）に付く。
クライアントは C-1 から `categorySource` も読み、写真ビューアのカテゴリのボタンに「（変更済み）」を付ける（[03 §5.6](./03_screen_design.md#56-カテゴリを手で直す)）。
`commentSource` はカテゴリのシートでも読み、AI のコメント（`"ai"`）なら、保存すると消えることを知らせる（[03 §5.6](./03_screen_design.md#56-カテゴリを手で直す)。カテゴリの変更で AI のコメントを消す、で実装済み）。
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
  "attributes": { "scientificName": "Prunus × yedoensis", "genusName": "サクラ属", "genus": "Prunus", "familyName": "バラ科" },
  "genus": "Prunus",
  "genusName": "サクラ属",
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
| `genus` | string \| null | 属の学名（ラテン語の1語。例 `Aconitum`）。前後の空白を除いた最初の1語（AI が学名や「sp.」まで答えても属にする）を、先頭だけ大文字・残りを小文字に揃えた形（AI が `" aconitum"` と答えても `Aconitum`）。図鑑の一覧はこれでまとめて並べる（§5.14）。項目一覧では名前ごとに決めた属（写真の多い属。[04 §3.1](./04_data_design.md#31-項目は写真からまとめる) の「属でまとめる」）、項目の詳細では見出しの写真の `attributes.genus`。分からない（どの写真も属を持たない、属を書く前に識別した写真だけ、空、属を持たない種類）なら `null`。キーは常にある。**実装済み**（P-1） |
| `genusName` | string \| null | 属（日本語の属名。例「トリカブト属」。前後の空白を除いたもの）。項目一覧では属ごとに揃えた1つの書き方（その属の写真で最も多い書き方。同じ属の項目には同じ値）、項目の詳細では見出しの写真の `attributes.genusName`（揃えない）。`genus` があっても `null` のことがある（その属の写真が日本語の属名を持たない）。キーは常にある。**実装済み**（P-1） |
| `photoCount` | integer | その名前の写真の枚数（項目一覧は `GROUP BY` の `COUNT(1)`（P-1 から名前・属の組の行を名前ごとに足したもの。属が分かれても1つの項目の枚数）、項目の詳細は `SELECT VALUE COUNT(1)`。[04 §5.6](./04_data_design.md#56-図鑑のまとめ段階4)） |
| `coverThumbnailUrl` | string | 見出しの写真のサムネイル（無ければ原寸）の SAS 付き URL。`null` にはならない |

`GET /api/catalog/entries`（4-2a）と `GET /api/catalog/entry`（4-2b）が実装済み（型は `api/src/types/album.ts` の `CatalogEntry`。`genus`・`genusName` は P-1 で足した。P-2 の前のアプリは読まず、P-2 のアプリは null 可で読んで一覧の属の見出しに使う。§8）。項目一覧は、ページに項目が1つも無ければ写真の保存先の設定を読まない（表紙の URL を作らないため。旅行の表紙と同じ）。項目の詳細も、該当する写真が無い（`entry: null`）ときは設定を読まない（§5.14）。

### 3.4 Error

§9.2。

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
| `PHOTO_VALIDATION.MAX_LENGTH.PLACE_NAME` | `PHOTO_PLACE_NAME_MAX_LENGTH` | 100 | `POST /api/photos`・`process` の `placeName`（C-2。実装済み） |
| `PHOTO_VALIDATION.MAX_LENGTH.COMMENT` | `PHOTO_COMMENT_MAX_LENGTH` | 500 | `PATCH /api/photos/{photoId}` |
| `PHOTO_VALIDATION.THUMBNAIL_MAX_SIZE` | `THUMBNAIL_MAX_SIZE` | 1048576（1MB） | `POST /api/photos` |
| `MOVE_VALIDATION.MAX_IDS` | `MOVE_MAX_IDS` | 200 | `POST /api/photos/move` |
| `TAG_VALIDATION.MAX_LENGTH` | `TAG_MAX_LENGTH` | 30 | `PATCH /api/photos/{photoId}`（タグの名前 `tags[].name`） |
| `TAG_VALIDATION.MAX_COUNT` | `TAG_MAX_COUNT` | 20 | `PATCH /api/photos/{photoId}`（1枚の写真のタグの数。同じ名前も数える） |
| `FILE_UPLOAD.MAX_SIZE`・`SUPPORTED_IMAGE_TYPES`（既存） | `MAX_FILE_SIZE` | 10MB | `POST /api/photos` の原寸 |
| `CONTEXT_INFO_VALIDATION.MAX_LENGTH`（既存） | `CONTEXT_INFO_MAX_LENGTH` | 500 | `process` の `hint` |
| `photoUrlExpiresOn()`（`services/photoStorageService.ts`。定数ではなく、応答を作るたびに環境変数を読む） | `PHOTO_SAS_EXPIRY_MINUTES` | 60 | §6 |
| `GENERAL_VALIDATION.UUID_REGEX`（既存） | — | | 旅行 id |
| `TIMELINE_VALIDATION.MAX_LENGTH.TITLE` / `SUMMARY` / `LABEL` / `NOTE` | `TIMELINE_TITLE_MAX_LENGTH` / `TIMELINE_SUMMARY_MAX_LENGTH` / `TIMELINE_LABEL_MAX_LENGTH` / `TIMELINE_NOTE_MAX_LENGTH` | 40 / 400 / 30 / 200 | `PATCH /api/trips/{tripId}/timeline/days/{date}`・`scenes/{photoId}`（段階5）。AI が書いた文は上限で切り詰める（[06 §8](./06_processing_design.md#8-タイムライン段階5)。U-3 から AI は一言を書かないので、`NOTE` は `PATCH` だけが使う） |
| `TIMELINE_VALIDATION.MAX_LENGTH.SCENE_COMMENT` | `TIMELINE_SCENE_COMMENT_MAX_LENGTH` | 100 | `PUT /api/trips/{tripId}/timeline/draft/scenes` の `sceneComments`（場面のコメント。前後の空白を除いて数える（§9.6）。5-7 で実装済み） |
| `TIMELINE_VALIDATION.DATE_REGEX` | — | `/^\d{4}-\d{2}-\d{2}$/`（加えて実在する日付であること） | 同上の `date` |

実装済みは `TRIP_VALIDATION` の2つ、`PHOTO_VALIDATION` の `ID_REGEX`・`TAKEN_AT_REGEX`・`COORDINATE_REGEX`・`MAX_LENGTH.PLACE_NAME`・`MAX_LENGTH.COMMENT`・`THUMBNAIL_MAX_SIZE`・`PAGE_SIZE`・`MAX_PAGE_SIZE`、`MOVE_VALIDATION.MAX_IDS`、`TAG_VALIDATION.MAX_LENGTH`、`PHOTO_SAS_EXPIRY_MINUTES` と既存のもの（PR 4b 時点）。`TAG_VALIDATION.MAX_COUNT` は PR 4b のレビューの指摘への対応で足した（実装済み）。
`CATALOG_VALIDATION` は、使うエンドポイント（段階4）と一緒に足す。`NAME_MAX_LENGTH` は識別の応答の検証で使うので 4-1a で、`PAGE_SIZE`・`MAX_PAGE_SIZE` は `GET /api/catalog/entries` と一緒に 4-2a で足した（どちらも実装済み）。
図鑑の 400 の `message`（`図鑑の種類が無効です`・`ページの指定が無効です`。`CATALOG_VALIDATION.ERROR_MESSAGES` の `KIND_INVALID`・`PAGE_INVALID`）は上限値を埋め込まない固定の文言。
コメント・タグ・move の上限も `message` に値を埋め込む（`コメントは500文字以内で指定してください`・`タグの名前は1〜30文字で指定してください`・`タグは20個までです`・`一度に移動できる写真は200枚までです`）。
`PHOTO_SAS_EXPIRY_MINUTES` は定数にせず、`photoUrlExpiresOn()` が応答を作るたびに `positiveIntFromEnv()` で読む（正の整数として読めない値（数字でない・0・負）は 60）。
`limit` の 400 の `message`（`1ページの枚数は1〜200で指定してください`）は `PHOTO_MAX_PAGE_SIZE` の値を埋め込む。
`TIMELINE_VALIDATION.MAX_LENGTH` は 5-2a で足した（実装済み。タイムラインのワーカーが AI の文を上限で切り詰める。[06 §8.3](./06_processing_design.md#83-文を書くstep-write)）。5-2b からは `PATCH` の2つも同じ値を 400 の上限に使う（実装済み。`message` に上限値を埋め込む。§5.15）。`TIMELINE_VALIDATION.DATE_REGEX` は `PATCH …/days/{date}` と一緒に 5-2b で足した（実装済み。形に加えて、暦にある日付かも見る）。`constants/validation.ts` には、入力検証ではないが時刻（0〜23）の環境変数を読む `hourFromEnv()` も置いた（5-1a。実装済み。`TIMELINE_DAY_START_HOUR` を読む。読み方は [07 §6.1](./07_infrastructure_design.md#61-api-の環境変数)）。

利用者が書く文（旅行名・説明・写真のコメント・タグ・手がかり・タイムラインの完成版の文・場面のコメント、C-2 からは解析を頼むときの場所 `placeName`）の文字数は、見た目の1文字（書記素）を1と数える（§9.6。#128 で実装済み。場所は C-2 で実装済み）。
それ以外（写真の送信の地名 `placeName`、図鑑の項目の名前 `name`、AI が返す識別の名前の検証とタイムラインの文の切り詰め）は `String.length`（UTF-16 のコード単位）で数える（§9.6 の「対象にしないもの」）。

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

`takenAtSource` は受け取らない。サーバが `takenAt` の有無から `exif` / `none` を入れる（手で付けた `user` は `PATCH /api/photos/{photoId}` の `takenAt` で。§5.6）。
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
「送信済み（別の場所）」と扱う（[03 §4.7.3](./03_screen_design.md#473-送信)）。

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
| 13 | `takenAt` があり、`YYYY-MM-DDTHH:mm:ss` でないか実在しない日時（日付だけ・タイムゾーン付き（`Z`）・日付と時刻の間が `T` でなく空白・2月30日・25時・60分を含む） | 400 `INVALID_REQUEST` | `撮影日時の形式が無効です` |
| 14 | `latitude` と `longitude` の片方だけがある | 400 `INVALID_REQUEST` | `緯度と経度は両方指定してください` |
| 15 | `latitude` / `longitude` が数値でない、または範囲外（緯度 -90〜90、経度 -180〜180） | 400 `INVALID_REQUEST` | `位置情報の形式が無効です` |
| 16 | `placeName` があり、緯度・経度が無い | 400 `INVALID_REQUEST` | `地名は緯度・経度と一緒に指定してください` |
| 17 | `placeName` が空・空白のみ・ファイル、または 100 文字を超える | 400 `INVALID_REQUEST` | `地名は100文字以内で指定してください` |
| 18 | `image` の SHA-256 が `photoId` と一致しない | 400 `INVALID_REQUEST` | `写真IDが画像の内容と一致しません` |

1・1.5・4〜7 は植物図鑑の `POST /api/images/upload`（4-6 で削除）と同じ順序・同じ `message` だった（間に `photoId` の 2・3 が入る）。`details` は付く行（1・1.5・4・5・9）と付かない行があり、契約外。
`tripId`・`takenAt` がファイルで送られたときも 12・13 になる。
18 はバイト列を読む必要があるので最後。1.5 は植物図鑑の `upload` と同じ `message` だが、エラーの文字列では判定せず `formData()` の失敗をそのまま 400 にする。
緯度・経度は10進（`-?数字(.数字)?`。`PHOTO_VALIDATION.COORDINATE_REGEX`）で範囲内のものだけを受け入れる（16進・2進・8進・指数表記・前後の空白・先頭の `+`・`Infinity`・`NaN`・空文字は 15。`Number()` に任せるとこれらが数値として通るため）。
`placeName` は送られたまま保存する（前後の空白も除かずに数える。端末が住所から作る値で利用者が書く文ではないので、UTF-16 のコード単位で数える。§9.6 の対象外）。サムネイルは JPEG を想定するが、対応形式なら受け付け、Blob 名は `.thumb.jpg`、Content-Type は送られたものにする。空白だけの `placeName` は「指定なし」ではなく 400 にする（地名が無ければクライアントはパートを省く。multipart に null は無く、文字列 `null` を送るとその文字列が地名として保存される）。

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

**実装済み**（PR 4b。`photoDetail.ts`、検証は `readPhotoUpdateInput`）。コメントの500文字とタグの名前の30文字は前後の空白を除いた後で数える。文字数の数え方（見た目の1文字）と前後の空白（U+0085 を含む）は §9.6（コメントの U+0085 は #127、タグの U+0085 と数え方は #128 で実装済み）。C-3a からタグは名前・種類・位置の形で、同じ名前のタグも除かない（下の `tags` の項目）。

**実装済み**（C-1。`photoDetail.ts`・`AlbumService.updatePhoto()`、検証は `readPhotoUpdateInput`）: `category`（利用者がカテゴリを手で決める。[02 §5](./02_design_overview.md#5-人間に決めてもらう点推奨付き) #53）。表の 4 の条件と 9.6、下の `category` の項目、書き込みとキューへの投入。

**実装済み**（カテゴリの変更で AI のコメントを消す。`AlbumService.updatePhoto()`）: `category` で AI が書いたコメント（`commentSource: "ai"`）を条件付き patch で消すこと（下の `category` の項目の2つ目の中ほどと、「書き込みは」の項目）。

**実装済み**（D-1。`photoDetail.ts`・`AlbumService.updatePhoto()`、検証は `readPhotoUpdateInput`）: `takenAt`（利用者が撮影日時を手で付ける・直す・消す。[02 §5](./02_design_overview.md#5-人間に決めてもらう点推奨付き) #59）。表の 4 の条件と 9.7・11、下の `takenAt` の項目、「書き込みは」の項目の撮影日時の分。

利用者のコメント・タグ・カテゴリ・撮影日時（D-1。画面は D-2（実装済み）の [03 §5.8](./03_screen_design.md#58-撮影日時を手で付ける)）を直す。構造は段階2で作り、画面は段階4（コメント。4-3c で実装済み。[03 §6.3](./03_screen_design.md#63-写真ビューアへの追加)）・C-1（カテゴリ。[03 §5.6](./03_screen_design.md#56-カテゴリを手で直す)）・C-3b（タグ。[03 §5.7](./03_screen_design.md#57-写真のタグ)）。

**リクエスト:** `{ "comment"?: string | null, "takenAt"?: string | null, "tags"?: { "name": string, "kind": "plant" | "food" | "landscape" | "other", "x": number, "y": number }[], "category"?: "plant" | "food" | "landscape" | "other" }`（タグの形は C-3a から。それまでは文字列の配列）

| 順 | 条件 | ステータス・コード | `message` |
|----|------|-------------------|-----------|
| 1 | `photoId` の形式が無効 | 400 `INVALID_REQUEST` | `写真IDの形式が無効です` |
| 2 | ボディが JSON としてパースできない | 400 `INVALID_REQUEST` | `リクエストボディの形式が無効です` |
| 3 | ボディが `null` | 400 `INVALID_REQUEST` | `リクエストボディが指定されていません` |
| 4 | `comment`・`takenAt`・`tags`・`category` のどれも無い | 400 `INVALID_REQUEST` | `更新する項目が指定されていません` |
| 5 | `comment` が文字列でも `null` でもない | 400 `INVALID_REQUEST` | `コメントは文字列で指定してください` |
| 6 | `comment` が前後の空白を除いて 500 文字を超える（数え方は §9.6） | 400 `INVALID_REQUEST` | `コメントは500文字以内で指定してください` |
| 7 | `tags` が配列でない | 400 `INVALID_REQUEST` | `タグは配列で指定してください` |
| 8 | `tags` の要素にオブジェクトでないもの（`null`・配列・文字列を含む）がある | 400 `INVALID_REQUEST` | `タグの形式が無効です` |
| 9 | `tags` の要素の `name` が文字列でないか、前後の空白を除いて空か 30 文字を超える（数え方は §9.6。U+0085 だけの名前も空） | 400 `INVALID_REQUEST` | `タグの名前は1〜30文字で指定してください` |
| 9.1 | `tags` の要素の `kind` が `plant` / `food` / `landscape` / `other` のどれでもない（大文字小文字の違い（`Food`）を含む） | 400 `INVALID_REQUEST` | `タグの種類が無効です` |
| 9.2 | `tags` の要素の `x`・`y` が、0 以上 1 以下の数でない（文字列・`null`・無い・範囲の外） | 400 `INVALID_REQUEST` | `タグの位置が無効です` |
| 9.5 | `tags` が 20 個を超える（`TAG_MAX_COUNT`。同じ名前も数える） | 400 `INVALID_REQUEST` | `タグは20個までです` |
| 9.6 | `category` があり、`plant` / `food` / `landscape` / `other`（定義表 `CATALOG_KINDS` のキーと `other`。`PHOTO_KINDS`）のどれでもない（文字列でない・`null`・大文字小文字の違い（`Plant`）を含む） | 400 `INVALID_REQUEST` | `カテゴリが無効です` |
| 9.7 | `takenAt` があり、`null` でも、実在する日時の `YYYY-MM-DDTHH:mm:ss`（タイムゾーン無し。写真の送信と同じ検証）の文字列でもない（数値・配列のように文字列でない値は、文字列に直すと正しい日時になる値（`["2026-10-05T12:00:00"]`）でも当たる。2月30日のような実在しない日時も当たる） | 400 `INVALID_REQUEST` | `撮影日時の形式が無効です` |
| 10 | 写真が無い | 404 `PHOTO_NOT_FOUND` | `指定された写真が見つかりません` |
| 11 | `takenAt` があり、写真の撮影日時がカメラの記録（EXIF）から読んだもの（`takenAtSource` が `"exif"`） | 409 `TAKEN_AT_FROM_CAMERA` | `カメラが記録した撮影日時は変えられません` |

検証は `photoId`（1）→ ボディ（2〜9.7。`comment` の 5・6 → `tags` の 7〜9.5 → `category` の 9.6 → `takenAt` の 9.7 の順）→ 写真があるか（10）→ カメラが記録した撮影日時か（11。`takenAt` を送ったときだけ。写真を読んで分かる）の順。写真があるかはボディの検証の後に見るので、無い写真に不正なボディを送ると 400。
タグの要素の 8〜9.2 は要素ごとに先頭から見て、1つの要素の中では 8 → 9 → 9.1 → 9.2 の順に確かめ、最初に当たった条件の `message` を返す（例: 1つ目の要素の種類が無効で2つ目が文字列なら、9.1 の `タグの種類が無効です`）。ただし数の上限（9.5）は要素の中身より先に見る（20 個を超える配列は、要素を確かめずに 9.5 で断る。大きな配列を全部確かめてから断らないため。/code-review の指摘）（**実装済み**（C-3a））。
ボディがオブジェクトでない JSON（配列・数値・文字列・真偽値）は `comment`・`takenAt`・`tags`・`category` のどれも無いものとして扱い、4 になる。`comment`・`takenAt`・`tags`・`category` 以外のキー（`hint` など）は無視し、それだけなら 4。
11 で断るときは何も書かない（`comment`・`tags`・`category` を一緒に送っても、どれも書かない）。
`category` は `null` で消せない（分類の前に戻す操作は無い。9.6 になる）。

- `comment`: 文字列なら前後の空白を除いて保存して `commentSource: "user"`。`null` なら消して `commentSource: null`。除いて空なら `null` と同じ（消して `commentSource: null`）。送らなければ `comment`・`commentSource` に触らない
- `takenAt`（**実装済み**（D-1。`AlbumService.updatePhoto()`、検証は `readPhotoUpdateInput`、409 は `TakenAtFromCameraError`）。[02 §5](./02_design_overview.md#5-人間に決めてもらう点推奨付き) #59）: 利用者が撮影日時を手で付ける・直す・消す。写真を読んでから書く（11 の確かめのため）。
  文字列なら `takenAt`（送った値）・`takenAtSource: "user"`・`sortAt`（`takenAt` と同じ値。[04 §1.3](./04_data_design.md#13-写真type-photo)）を書く。`null` なら `takenAt: null`・`takenAtSource: "none"`・`sortAt`（`uploadedAt` から作る。写真の送信と同じ決め方）を書く。
  撮影日時の無い写真に `null` を送っても受け付ける（書く値は今と同じ）。送らなければ `takenAt`・`takenAtSource`・`sortAt` に触らない
- `tags`: 利用者のタグを指定したものに**置き換える**（空の配列なら全部消える）。各要素は `{ name, kind, x, y }` だけを保存し（ほかのキーは捨てる）、`name` は前後の空白を除く。
  同じ名前のタグも除かずに残し、並びは送った順（**実装済み**（C-3a。`utils/photoInput.ts` の `readPhotoTag()`）。C-3。[02 §5](./02_design_overview.md#5-人間に決めてもらう点推奨付き) #57。C-3a より前は文字列の配列で、重複を除いていた）。送らなければ `tags` に触らない。`category` は別の欄なので `tags` には混ざらず、サーバが選り分けて結合する処理は無い
- `category`（C-1）: 利用者が手で決めたカテゴリにする（AI を通さない）。写真を読んでから、次のように書く。送らなければ `category`・`categorySource`・`identification`・`processing`・コメントに触らない
  - いつも `categorySource: "user"` を書く（今と同じカテゴリでも）
  - 今のカテゴリと違うか、写真の分類が済んでいない（`processing.step` が `classify` で `state` が `pending`・`classifying`・`failed`）ときは、さらに `category`（送った値）・`identification: null`（前の識別を消す。植物から変えれば図鑑から外れる）・`processing` を書く。
    `processing` は、送ったカテゴリが自動で識別する種類（定義表の `autoIdentify`。植物だけ）なら `{ state: "pending", step: "identify", attempts: 0, lastError: null, updatedAt: <今> }`（品種を調べる待ち）、それ以外（食べ物・風景・`other`）なら `{ state: "done", step: "classify", attempts: 0, lastError: null, updatedAt: <今> }`。
    分類を待っている・している写真を同じカテゴリでも書き換えるのは、分類を止めないと後で AI の分類がカテゴリを書き換え、手で決めたカテゴリが消えるため。`failed` の写真もこれで `done`（植物なら識別の待ち）になる
    コメントが AI の書いたもの（`commentSource: "ai"`）なら、同じ書き込みで `comment`・`commentSource` も `null` にする（前のカテゴリで書いたもので、新しいカテゴリの写真には合わない。植物に変えれば識別が書き直す。利用者のコメントは残す）。
    この書き込みは読んだときのコメントの出どころを条件にし、読んだ後に他がコメントを書いていたら読み直して書き直す（3回まで。続けて合わなければ 500。読んだ後に利用者が書いたコメントは残り、読んだ後に AI が書いたコメントも消える）。
  - 今と同じカテゴリで、分類が済んでいれば（待っても・しても・失敗してもいなければ）、`categorySource` だけを書く（`identification`・`processing`・コメントは残る。識別を待っている・している植物の写真なら、識別はそのまま続く）
  - 書いた後の写真が識別の待ち（`processing` が `pending`・`step: "identify"`）なら、キューに `{ photoId }` を投入する（植物に変えたとき。今と同じカテゴリで既に識別を待っていた写真にも積み直すが、重複したメッセージは担当の条件で何もせずに終わる。[04 §7.4](./04_data_design.md#74-ワーカーの書き込みの決まり)）。
    **投入に失敗してもログだけ出して 200 を返す**（`PHOTO_QUEUE_NAME` が無いときも同じ。写真は識別の待ちのまま残り、再投入のタイマーが拾う。[04 §7.1](./04_data_design.md#71-操作ごとの表)）
  - `classification`（AI の分類の根拠）は書き換えない（手で直した後は `category` と食い違いうる）
  - 走っている分類・識別の結果は、`processing` を書き換えたので担当の条件（[06 §1.3](./06_processing_design.md#13-状態と失敗)）に合わず捨てられ、手で決めたカテゴリを上書きしない。ワーカーは `categorySource` を見ない
- 書き込みは1回の patch（`category` か `takenAt` を送ったときは、その前に写真を1回読む（両方送っても1回）。`takenAt` の分は条件を付けない。カテゴリが変わるか分類を止めるときは、コメントの出どころを条件にし、合わなければ読むところからやり直す）。`comment`・`tags` だけなら `comment`・`commentSource`・`tags`・`updatedAt` だけの patch（AI が書く欄には触らない。[04 §7.4](./04_data_design.md#74-ワーカーの書き込みの決まり)）。`updatedAt` は毎回更新する。
  **解析中（`processing.state` が `pending` / `classifying` / `identifying`）でも受け付ける**（ロックは無い）
- 応答は 200 `{ photo, urlExpiresAt }`（§5.3 と同じ形。更新後の写真で、URL と `urlExpiresAt` はこの応答で発行したもの）
- Cosmos へ接続できなければ 503 `DATABASE_ERROR`（`データベースに接続できません`）、それ以外の失敗は 500 で `message` は `写真の更新に失敗しました`。
  写真の保存先の設定（`STORAGE_CONNECTION_STRING` のアカウント名・鍵、`PHOTO_STORAGE_CONTAINER_NAME`）が足りなければ、写真を書き換える前に同じ 500

### 5.7 `POST /api/photos/{photoId}/process`（段階3）

**実装済み**（3-3b で `step: "classify"`、4-1b で `step: "identify"` と 8。`photoProcess.ts`、検証は `utils/photoInput.ts` の `readProcessRequestInput`）。
**実装済み**（#128）: `hint` の文字数を見た目の1文字で数えることと、前後の空白に U+0085 を含めること（表の 6 と、処理の順の 1 の `hint`。§9.6）。
**実装済み**（C-1）: `step: "classify"` の受付で `categorySource` を `null` にすること（処理の順の 1）。
**実装済み**（C-2。`photoProcess.ts` の `relocated()`、検証は `readProcessRequestInput`）: 場所（撮影地の地名）を受け取って写真の撮影地を直すこと（`placeName`。表の 6.1・6.2、写真を読む条件、処理の順の 1 の `location`。[02 §5](./02_design_overview.md#5-人間に決めてもらう点推奨付き) #53）。

AI の解析をやり直す（要件 5.5.1）。アプリは C-1 から、カテゴリが識別の対象（植物・食べ物・風景）の写真には `identify` を、それ以外（分類の前）の写真には `classify` を頼む（カテゴリは手で直す。[03 §5.4](./03_screen_design.md#54-やり直しダイアログ)）。API はどちらも今までどおり受け付ける。
C-2 からアプリは、ダイアログの「場所」の欄を利用者が直したときだけ `placeName` を送る（直していなければキーを省くので、サーバは写真を読まずに受け付け、撮影地を変えない。手元の古い地名で別の端末の直しを戻さないため）。

**リクエスト:** `{ "step": "classify" | "identify", "hint"?: string | null, "placeName"?: string | null }`

| 順 | 条件 | ステータス・コード | `message` |
|----|------|-------------------|-----------|
| 1 | `photoId` の形式が無効 | 400 `INVALID_REQUEST` | `写真IDの形式が無効です` |
| 2 | ボディが JSON としてパースできない | 400 `INVALID_REQUEST` | `リクエストボディの形式が無効です` |
| 3 | ボディが `null` | 400 `INVALID_REQUEST` | `リクエストボディが指定されていません` |
| 4 | `step` が `classify` / `identify` でない | 400 `INVALID_REQUEST` | `やり直す処理の種類が無効です` |
| 5 | `hint` が文字列でも `null` でもない | 400 `INVALID_REQUEST` | `補足情報は文字列で指定してください`（既存） |
| 6 | `hint` が前後の空白を除いて 500 文字を超える（数え方は §9.6） | 400 `INVALID_REQUEST` | `補足情報は500文字以内で指定してください`（既存） |
| 6.1 | `placeName` があり、文字列でも `null` でもない（C-2） | 400 `INVALID_REQUEST` | `地名は文字列で指定してください` |
| 6.2 | `placeName` が前後の空白を除いて 100 文字を超える（数え方は §9.6。C-2） | 400 `INVALID_REQUEST` | `地名は100文字以内で指定してください`（`POST /api/photos` の 17 と同じ文言） |
| 7 | 写真が無い | 404 `PHOTO_NOT_FOUND` | `指定された写真が見つかりません` |
| 8 | `step: "identify"` だが写真のカテゴリが識別対象でない（`category` が `CATALOG_KINDS` のどれでもない。`other` か `null`） | 400 `INVALID_REQUEST` | `この写真は識別の対象ではありません` |

4 は `step` が文字列の `"classify"` か `"identify"` のときだけ通す（未指定・ほかの文字列・文字列でないものは 4）。
ボディがオブジェクトでない JSON（配列・数値・文字列・真偽値）は `step` が無いものとして扱い、4 になる。`step`・`hint`・`placeName` 以外のキーは無視する。
6 の上限（`CONTEXT_INFO_MAX_LENGTH`）と 5・6 の `message` は植物図鑑の補足情報（`contextInfo`。4-6 で削除）と共用していた定数 `CONTEXT_INFO_VALIDATION` のもので、上限の値は `message` に埋め込まれる。
6.2 の上限と `message` は写真の送信の地名と同じ `PHOTO_PLACE_NAME_MAX_LENGTH`（上限の値は `message` に埋め込まれる）。ただし数え方と空白の扱いは送信の地名と違い、利用者が書く文として前後の空白（U+0085 を含む）を除いて見た目の1文字で数え（§9.6）、
除いて空（`""`・空白だけ）なら `null`（地名を消す）として扱う（送信の 17 のように 400 にはしない）。キーが無ければ撮影地を変えない（`null` を送ると地名を消すのと区別する）。
検証の順は、写真 ID（1）→ ボディ（2・3）→ 処理の種類（4）→ 手がかり（5・6）→ 場所（6.1・6.2）→ 写真（7・8）。
写真があるか（7）はボディの検証の後に見るので、無い写真に不正なボディを送ると 400。
`step: "identify"` のときと `placeName` を送ったとき（C-2。`classify` でも）は、書く前に写真を読んで 7（`identify` なら続けて 8）をこの順に見る（無い写真は 8 ではなく 404）。`placeName` を送らない `step: "classify"` は読まずに下の patch を当て、404 なら 7。
どちらも写真を読む・書く前に写真の保存先の設定を確かめる（下の 500）。読んでから書くまでに分類のワーカーがカテゴリを `other` に変えることはまれにありえ、そのときは受け付けた識別の待ちをワーカーが AI を呼ばずに内部の失敗として数える（[06 §3.1](./06_processing_design.md#31-契約)）。

処理の順:

1. 写真に patch: `processing = { state: "pending", step, attempts: 0, lastError: null, updatedAt: now }`（**`attempts` を 0 に戻す。** `failed` の写真をもう一度試せるのはこの操作だけ。[06 §1.3](./06_processing_design.md#13-状態と失敗)）、
   `hint`（前後の空白（§9.6。U+0085 を含む）を除いたもの。送らない・`null`・除いて空なら `null` で、前回の `hint` は消える）、
   **`comment: null`・`commentSource: null`**（やり直しの結果で置き換えるため、受付の時点で消す。[02 §5](./02_design_overview.md#5-人間に決めてもらう点推奨付き) #9。
   利用者が書いたコメントは、アプリが `hint` に事前入力してから頼む設計なので失われない）、`updatedAt: now`。
   `step: "classify"` なら **`categorySource: null`** も書く（C-1。分類からやり直すならカテゴリは AI に任せ直す。手で決めた印を残すと、AI の決めたカテゴリが「手で決めた」と表示される）。`step: "identify"` は `categorySource` を変えない。
   `placeName` を送ったら（C-2）、前後の空白を除いた地名（空なら `null`）を、読んだ写真の今の地名（`location.placeName`。`location` が `null` なら `null`）と比べ、違えば同じ patch で **`location`** も書く（直した地名は写真の撮影地として残る。[02 §5](./02_design_overview.md#5-人間に決めてもらう点推奨付き) #53）:
   - 地名がある: `{ latitude: <今の値か null>, longitude: <今の値か null>, placeName: <地名>, placeSource: "user" }`（緯度・経度は残す。位置情報の無い写真は緯度・経度の無い撮影地になる）
   - 地名を消す（`null`・空）: 今の `location` に緯度・経度があれば `{ ...今の location, placeName: null, placeSource: "user" }`（緯度・経度と、手で消した印を残す。`null` にすると「まだ地名を引いていない」と区別できない。[04 §1.3](./04_data_design.md#13-写真type-photo)）、無ければ（`location` が `null` か、地名だけの撮影地なら）`location: null`
   - 今と同じ地名なら書かない（端末が引いた地名（`placeSource: "device"`）を、変えていないのに手で直したものにしない）。`placeName` を送らなければ `location` に触らない

   `location` の書き込みに条件は付けない（読んでから書くまでの間に `location` を書きうるのは同じ写真への別の受付だけで、後から書いた方が残る。送信は既存の写真を書き換えず、ワーカー・`PATCH`・move は `location` に触らない）。
   それ以外の項目（`category`・`classification`・`identification`・`tags`・`tripId`）は変えない（前回の結果はやり直しの結果が出るまで残る）。
   解析中（`pending` / `classifying` / `identifying`）の写真にも受け付ける（最新の依頼で上書きされる。走っている分類・識別の結果と失敗は、担当したときの `processing`（`state`・`step`・`attempts`・`updatedAt`）の条件付き patch で書かれずに捨てられる。[06 §1.3](./06_processing_design.md#13-状態と失敗)）。
   やり直しの回数に上限は置かない（費用は AI のデプロイの容量で抑える。[06 §6](./06_processing_design.md#6-費用の抑え方)）
2. キューに `{ photoId }` を投入する（`step`・`hint` はワーカーが写真から読む）
3. **202** `{ photo, urlExpiresAt }`（§5.3 と同じ形。受け付けた後の写真で、URL と `urlExpiresAt` はこの応答で発行したもの）

投入に失敗してもログだけ出して 202 を返す（写真は `pending` のまま残り、タイマーが 10 分以上たってから `processing.step` を見て再投入する。
失敗を返すと「失敗したのに後で勝手に走る」ことになる。[04 §7.1](./04_data_design.md#71-操作ごとの表)）。
Cosmos へ接続できなければ（写真の読み取り・patch のどちらでも）503 `DATABASE_ERROR`（`データベースに接続できません`）、それ以外の失敗は 500 で `message` は `解析のやり直しの受付に失敗しました`。どちらも写真は変わらず、キューにも積まない。
写真の保存先の設定（`STORAGE_CONNECTION_STRING` のアカウント名・鍵、`PHOTO_STORAGE_CONTAINER_NAME`）が足りなければ、写真を書き換える前に同じ 500。詳細は [06 §1](./06_processing_design.md#1-キューとワーカー段階3)。

### 5.8 `POST /api/trips`

**実装済み**（PR 3。`trips.ts`、検証は `utils/tripInput.ts`）。
**実装済み**（#128）: `name`・`description` の文字数を見た目の1文字で数えることと、`name` の前後の空白に U+0085 を含めること（表の 5〜7。§9.6）。

**リクエスト:** `{ "name": string, "description"?: string | null }`

| 順 | 条件 | ステータス・コード | `message` |
|----|------|-------------------|-----------|
| 1 | ボディが JSON としてパースできない | 400 `INVALID_REQUEST` | `リクエストボディの形式が無効です` |
| 2 | ボディが `null` | 400 `INVALID_REQUEST` | `リクエストボディが指定されていません` |
| 3 | `name` が文字列でない | 400 `INVALID_REQUEST` | `旅行名は文字列で指定してください` |
| 4 | `description` が文字列でない（`null`・未指定は可） | 400 `INVALID_REQUEST` | `説明は文字列で指定してください` |
| 5 | `name` が未指定・`null`・空・空白のみ（U+0085 だけも。§9.6） | 400 `INVALID_REQUEST` | `旅行名が指定されていません` |
| 6 | `name` が前後の空白を除いて 100 文字を超える（数え方は §9.6） | 400 `INVALID_REQUEST` | `旅行名は100文字以内で指定してください` |
| 7 | `description` が 1000 文字を超える（数え方は §9.6） | 400 `INVALID_REQUEST` | `説明は1000文字以内で指定してください` |

ボディがオブジェクトでない JSON（配列・数値・文字列・真偽値）は `name` が無いものとして扱い、5 になる。`name`・`description` 以外のキー（`tags` など）は無視する。
`description` の文字数は前後の空白を除かずに数える。

`name` は前後の空白を除いて保存。`description` はそのまま（空文字は `null` にする。空白だけの文字列はそのまま保存する）。`tags` は `[]`。
`createdAt` と `updatedAt` は同じ値。201 `{ trip }`（§3.1。集計は付かない）。
500 の `message`: `旅行の作成に失敗しました`。

### 5.9 `GET /api/trips`

**実装済み**（PR 3。`trips.ts`。表紙は PR 4a-2）。

`{ trips: TripSummary[], total, unassignedPhotoCount }`。並びは最初の撮影日時（`firstTakenAt`）の新しい順。撮影日時のある写真が無い旅行は先頭に `createdAt` の新しい順。撮影日時が同じなら `createdAt` の新しい順（集計を足した後にコードで並べる。2026-10-27。実装済み）。`total` は旅行の数。
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
**実装済み**（#128）: 文字数の数え方と前後の空白（§9.6）も 5.8 と同じ（同じ検証を通る）。

`name`（必須）と `description`（任意）の全体置き換え。検証は `tripId` の形式（5.10 の 1）→ 5.8 の 1〜7 の順。無ければ 404 `TRIP_NOT_FOUND`（読んだ後・置き換える前に旅行が消された場合も 404）
（旅行があるかはボディの検証の後に見るので、無い旅行に不正なボディを送ると 400）。
保存のしかたは 5.8 と同じ（`name` は前後の空白を除く、`description` の空文字は `null`）。**全体置き換えなので、`description` を省略するか `null` を送ると説明は消える。**
`tags` と `createdAt` は変えず、`updatedAt` を更新する。200 `{ trip }`（§3.1。集計無し）。500 の `message`: `旅行の更新に失敗しました`。

### 5.12 `DELETE /api/trips/{tripId}?deletePhotos=true|false`

**実装済み**（PR 4b。`tripDetail.ts`、写真と旅行の処理は `AlbumService.deleteTrip()`、画像の削除は `PhotoStorageService.deletePhotoBlobs()`（`DELETE /api/photos/{photoId}` と共用））。

中の写真をどうするかを利用者が選ぶ（2026-10-12 に人間が決定。画面のダイアログは [03 §4.4.3](./03_screen_design.md#443-削除)）。

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
4. （段階5。5-1a で実装済み。`TimelineService.deleteTripTimeline()`）旅行の写真の控え（`timelinePhotos`）の id を `tripId` で読み、タイムライン（`timeline-<tripId>`）→ 控えの順に1件ずつ消す。無い（404）なら何もしない。`deletePhotos` の値によらず消す。失敗したら中断する（旅行は残り、再送で続きができる。Cosmos に届かなければ 503、それ以外は 500。写真の削除と同じ）
5. 旅行を消す。他の操作が先に消していた（404）なら成功とする

旅行の読み取り・写真の射影の読み取り・写真の削除や patch・タイムラインと控えの読み取りや削除・旅行の削除のどこで失敗しても、Cosmos へ接続できなければ 503 `DATABASE_ERROR`（`データベースに接続できません`）、それ以外は 500。
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

`{ tags: string[] }`。写真の `tags`（利用者のタグ）の名前（`tags[].name`）の `DISTINCT`。文字列順。タグの名前の入力の候補を出すときに入れる（タグを付ける画面（C-3）には入れない。#57）（カテゴリは `GET /api/catalog/kinds` + `other` で分かるので、ここには含めない）。
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
| `GET /api/catalog/kinds` | `{ kinds: [{ kind, label, fields: [{ key, label, type }] }] }`。定義表（[04 §3.2](./04_data_design.md#32-定義表-catalog_kindsapisrccatalogkindsts)）のうち図鑑に載せる種類（`inCatalog` が true。今は植物だけ）と項目を表の順に返す。識別はできても図鑑に載せない種類（食べ物・風景。[02 §5](./02_design_overview.md#5-人間に決めてもらう点推奨付き) #51）は返さない。AI に渡す指示（`prompt`・`namingRule`・`commentRule`）と `inCatalog`・`autoIdentify` は返さない。DB にも Blob にも触らない。**実装済み（4-2a。図鑑に載せる種類だけにしたのは B-2）** | なし（定義表を返すだけで、失敗する経路が無い。例外を捕まえて封筒の 500 にする処理も置いていない） |
| `GET /api/catalog/entries?kind=&offset=&limit=` | `{ entries: CatalogEntry[], total }`（§3.3.1）。`kind` 必須、図鑑に載せる種類でなければ（定義表に無い、または食べ物・風景）400 `図鑑の種類が無効です`。属の学名（`genus`）の文字列順に並べ（同じ属は `name` の文字列順、属が分からない項目は最後。下の「並び順」。P-1 から。それまでは `name` の文字列順）、`offset`（既定 0）から `limit`（既定 50、上限 100。`CATALOG_PAGE_SIZE` / `CATALOG_MAX_PAGE_SIZE`）件。`total` は項目の総数（ページに依らない）。0 件なら `[]`・`0`。`offset` が項目の数以上なら `[]` で `total` はそのまま。検証は下の表。**実装済み（4-2a。食べ物・風景を断るのは B-2）** | 503 `DATABASE_ERROR`（接続できない。§1）、500 `図鑑の一覧の取得に失敗しました`（それ以外。表紙の URL を作れない（写真の保存先の設定が足りない）ときも） |
| `GET /api/catalog/entry?kind=&name=&limit=&continuationToken=` | `{ entry: CatalogEntry \| null, photos, continuationToken, urlExpiresAt }`。`photos` はその名前の写真の1ページ（`sortAt` 順。`limit` / `continuationToken` は §5.2 と同じ）。`entry.photoCount` は `COUNT` で数えた総数。該当する写真が無ければ **200** で `entry: null`・`photos: []`・`continuationToken: null`。検証は下の表。**実装済み（4-2b。食べ物・風景を断るのは B-2）** | 400（下の表）、503 `DATABASE_ERROR`（接続できない。§1）、500 `図鑑の項目の取得に失敗しました`（それ以外。写真の保存先の設定が足りないときも） |

項目一覧のページを `offset` / `limit` にするのは、`GROUP BY` の結果（項目の行）をサーバで合わせて並べてから切るためで、Cosmos の継続トークンが使えない。

**並び順**（**実装済み**（P-1。[02 §5](./02_design_overview.md#5-人間に決めてもらう点推奨付き) #56）。それまでは名前順だけ）:

- 属の学名（項目の `genus`。最初の1語を先頭だけ大文字に揃えた形）の文字列順。同じ属の中は名前の文字列順。属が分からない（`genus` が `null`）項目は最後に、名前の文字列順で並べる
- 項目の属は写真の多い属で決めるので、写真が増えると項目が別の属の並びへ移ることがある（ページを読み進める間に移ると、その項目が重なる・抜けることがある。名前だけの並びで新しい名前が増えたときと同じく、読み直せば揃う）
- 文字列順はどれも符号単位の順（JavaScript の `<` の比べ方。ロケールに依らず、どの環境でも同じ並びになる）
- 項目一覧の項目の属は、同じ名前の写真で AI の答えた属が分かれたとき、写真の多い属（同じ枚数なら属の学名の文字列順で先）にする。属の学名は揃えた形で数える（大文字小文字・前後の空白の違い、日本語の属名の書き方の違いでは分かれない）。
  属の分からない写真（属を書く前に識別した写真、属の学名が空の写真など）は、属の分かる写真が1枚でもあれば属に使わない。枚数は属によらず名前ごとに足す（属が分かれても項目は1つ）
- 項目一覧の `genusName` は属ごとに1つに揃える（その属の写真で最も多い書き方。同じ枚数なら文字列順で先）。同じ属の項目には同じ `genusName` が付く（[04 §3.1](./04_data_design.md#31-項目は写真からまとめる) の「属でまとめる」）
- 項目の詳細（`GET /api/catalog/entry`）の `genus`・`genusName` は見出しの写真の識別から取るので、項目一覧の同じ項目の属と違うことがある（属が分かれた名前で、見出しの写真が少ない方の属のとき。`genusName` は属ごとに揃えないので、書き方が一覧と違うときも）
- 属の見出しを出すのはアプリ（P-2。**実装済み**。[03 §6.1](./03_screen_design.md#61-図鑑タブ種類タブ--項目一覧)）。P-2 の前のアプリは `genus`・`genusName` を読まないので、見出しの無いまま並びだけが属の順になる
数えてから見出しの写真を読むまでの間に、その名前の写真が無くなった（消された・やり直しで名前が変わった）項目は、そのページから外す（`total` は数えたときのまま）。まれで、次に開けば数え直される。
そのため `entries` の件数は、続きがあっても `limit` より少ないことがある。
項目の行は小さいので、ページごとに `GROUP BY` をやり直しても読む量は写真の枚数に依らない（[04 §3.1](./04_data_design.md#31-項目は写真からまとめる) の「規模の注意」）。

`GET /api/catalog/entries` の検証（順に。最初に失敗した1件だけ返す。Cosmos に触る前に弾く）:

| 順 | 条件 | ステータス・コード | `message` |
|----|------|-------------------|-----------|
| 1 | `kind` が無い、定義表に無い（`other` や、`constructor` などの継承したキーも）、または定義表にあっても図鑑に載せない種類（`food`・`landscape`。`inCatalog` が false。B-2） | 400 `INVALID_REQUEST` | `図鑑の種類が無効です` |
| 2 | `offset` が 0 以上の整数の10進表記（`0` か、先頭が `0` でない数字の並び）でない（空・負・小数・数字以外を含む）、または安全な整数（2^53 − 1）を超える | 400 `INVALID_REQUEST` | `ページの指定が無効です` |
| 2 | `limit` が 1 以上の整数の10進表記（先頭が `0` でない数字の並び）でない（空・`0`・小数・数字以外を含む）、または上限（`CATALOG_MAX_PAGE_SIZE`。既定 100）を超える | 400 `INVALID_REQUEST` | `ページの指定が無効です` |

- 「無い」と「空」を分ける。`offset` が無ければ 0、`limit` が無ければ既定（`CATALOG_PAGE_SIZE`。既定 50。上限より大きく設定されていても上限で止める）。空の文字列は 400（写真の一覧の `limit` と同じ）
- `offset` と `limit` は同じ `message` で、どちらが悪いかは言わない。`kind` もページも不正なら `kind` の指摘を返す
- `kind` は前後の空白を除かずに定義表のキーと比べる（大文字小文字も区別する）
- 食べ物・風景の写真も識別の結果（`identification`）を持ちうる（やり直しの `step: "identify"`。§5.7）が、図鑑には載せないので一覧も項目も 400 で断る（B-2。項目の詳細も同じ）。定義表に無い種類と同じ `message` で、どちらかは言わない

`GET /api/catalog/entry` の検証（順に。最初に失敗した1件だけ返す。1〜5 は Cosmos に触る前に弾く。`utils/catalogInput.ts` の `readCatalogEntryQuery`）:

| 順 | 条件 | ステータス・コード | `message` |
|----|------|-------------------|-----------|
| 1 | `kind` が無い、定義表に無い（`other` や、`constructor` などの継承したキーも）、または図鑑に載せない種類（`food`・`landscape`。B-2）。項目一覧と同じ | 400 `INVALID_REQUEST` | `図鑑の種類が無効です` |
| 2 | `name` が無い、または前後の空白を除いて空 | 400 `INVALID_REQUEST` | `図鑑の項目の名前が指定されていません` |
| 3 | `name` が前後の空白を除いて 100 文字（`CATALOG_VALIDATION.NAME_MAX_LENGTH`）を超える（利用者が書く文ではないので UTF-16 のコード単位で数える。§9.6 の対象外） | 400 `INVALID_REQUEST` | `図鑑の項目の名前は100文字以内で指定してください` |
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

### 5.15 タイムライン（段階5）

**実装済み**（5-1a。`timeline.ts`・`timelineDraft.ts`、文書の操作は `services/timelineService.ts`、日と場面の組み立ては `services/timelineView.ts`）: 「共通」（ボディの行を除く）、「応答の形」のうち `draft`（状態）、`GET …/timeline/draft`・`POST …/timeline`・`DELETE …/timeline/draft`。
**実装済み**（5-1c。`timeline.ts` の `getTimeline`・`timelineDraft.ts` の `putTimelineDraftScenes`、完成版の組み立ては `services/timelineView.ts` の `currentTimelineOf()`）: 「共通」のボディの行（`PUT` の分）、「応答の形」の全部（`timeline`・`current`・`changes`・`pendingPhotoCount`）、`GET …/timeline`・`PUT …/draft/scenes`。
**実装済み**（5-2a。`timelineDraft.ts` の `postTimelineDraftWrite`）: `POST …/draft/write`。完成版（`current`）は、文を書くワーカー（[06 §8.3](./06_processing_design.md#83-文を書くstep-write)）が書き終えたときに書く。区切りを直している下書き（`recut`）は、AI を使わずその場で完成版に当てる（5-5a で実装済み）。
**実装済み**（5-2b。`timelineCurrent.ts` の `postTimelineRecut`・`patchTimelineDay`・`patchTimelineScene`、完成版を読んだ形（`GET …/timeline` の `data`）を組むのは `services/timelineRead.ts` の `readTimelineBody()`（応答にするのは `readTimelineResponse()`）、確かめ中の下書きの形は `services/timelineView.ts` の `reviewingDraftOf()`）: 「共通」のボディの行（`PATCH` の分）、`POST …/recut`・`PATCH` の2つ。
**実装済み**（5-5b。ワーカーの `functions/processTimeline.ts`・`services/timelineProposal.ts`・`services/timelineWriting.ts`）: 作り直し（`rebuild`）で前の完成版の文と区切りを使わないこと（書き終えたときに完成版をまるごと置き換える）。
**実装済み**（5-5d。`services/timelineRead.ts` の `readTimelineBody()`・`timeline.ts` の `createTimeline`・`services/timelineService.ts`）: 応答に `droppedEdits`（文を書き直したときに残せなかった利用者の文）を返さないこと。以前は応答の `timeline.droppedEdits` と、それを閉じる `DELETE …/timeline/dropped-edits` があったが、作り直しが前の文を使わなくなり（5-5b）残せなかった文が無くなったので、5-5d で消した（2026-10-27 に人間が決定。それを読まない 5-5c のアプリを入れた後に消した）。5-5d より前に書いた文書に `droppedEdits` が残っていても返さない（[04 §1.6](./04_data_design.md#16-タイムラインtype-timeline-と-timelinephotos段階5)）。
**実装済み**（T-1。受付は `timelineDraft.ts` の `postTimelineDraftExcludedPhotos`・`timelineCurrent.ts` の `postTimelineExcludedPhotos`、ボディは `utils/timelineInput.ts`、表示は `services/timelineView.ts` の `visiblePhotoIdsOf()`・`withExcludedPhotos()`）: 写真をタイムラインから外すこと（[02 §5](./02_design_overview.md#5-人間に決めてもらう点推奨付き) #52。下の「外した写真」の段落と、各エンドポイントの外した写真の行、`POST …/draft/excluded-photos`・`POST …/excluded-photos`）。
**実装済み**（T-2b。`services/timelineView.ts` の `layoutTimeline()`）: 応答に撮影日時の無い写真を入れないこと（[02 §5](./02_design_overview.md#5-人間に決めてもらう点推奨付き) #54。以前は完成版と確かめ中の下書きの `undatedPhotos` に、撮影日時の無い写真を日と場面と同じ形で返していた。それを読まない T-2 のアプリを入れた後に外した）。
**実装済み**（U-3。文を書くワーカーの `services/timelineWriting.ts` の `assembleCurrent()`）: AI が書いた場面の `note`・`noteSource` が `null` になること（「応答の形」の `current` の行と、`PATCH` の表の 8。[02 §5](./02_design_overview.md#5-人間に決めてもらう点推奨付き) #55）。応答の `note` と `PATCH` の `note` は変えていない（前に書いた一言をどうするかは判断待ち。[09](./09_backlog.md)）。

旅行ごとのタイムライン（[02 §4.11](./02_design_overview.md#411-タイムラインは区切りで持ちai-の案を人が確かめてから文を書く要件-531段階5)、文書は [04 §1.6](./04_data_design.md#16-タイムラインtype-timeline-と-timelinephotos段階5)）。
完成版（`current`）と下書き（`draft`）を分けて持つ。区切りを直している（`recut`）間は、当てるまで完成版は変わらない（[02 §5](./02_design_overview.md#5-人間に決めてもらう点推奨付き) #48）。
作り直しは、始めたときに今の完成版を消す（`POST …/timeline`。2026-10-28 に人間が決定。#48 の「作り直しの間も完成版を見せ続ける」を改めた。5-6b で実装済み。5-6 のアプリを入れた後に出した）。
5-6b までは、作り直しでも完成版を残したまま `reason: "rebuild"` の下書きを作り、書き終えたときに完成版を置き換えていた（5-1a〜5-5b。5-6 のアプリは、作り直しを始めたら完成版を出さない。[03 §8.2](./03_screen_design.md#82-作っている間完成版が無いとき)）。
**AI を使うのは、作るときと、最初から作り直すときだけ。** 作り直しは前の完成版の文と区切りを使わずに一から作り、区切りを直す（`recut`）ときは AI を使わずに直した区切りを完成版に当てる（[06 §8](./06_processing_design.md#8-タイムライン段階5)。2026-10-27 に人間が決定。区切りを直すときは 5-5a、作り直しで前の完成版の文と区切りを使わないのは 5-5b で実装済み）。

**外した写真**（T-1 で実装済み。[02 §5](./02_design_overview.md#5-人間に決めてもらう点推奨付き) #52。2026-10-29〜30 に人間が決定）

- 旅行には残したまま、タイムラインには出したくない写真を、利用者が外せる（案の確認画面と完成版の両方から。下書きは `POST …/draft/excluded-photos`、完成版は `POST …/excluded-photos`）。外した写真は下書き・完成版の `excludedPhotoIds` に足すだけで、**戻さない**（戻す操作は無い）。作る・作り直す（`POST …/timeline`）と、新しい下書きは何も外していない（覚えておかない）
- 外した写真は、控えを取った後に消えた写真と同じに扱う: 応答の日・場面に出さず、写真を全部外した場面と日も出さない。何日目かと場面の分け方は外した写真も含めた控えで決めるので、場面の最初の写真を外しても場面の id（`startPhotoId`）は控えの最初の写真のままで、場面は次の写真から出し、見出し・一言・場面のコメントもその id に付いたまま残る。場面の `hasFood`・`firstTakenAt`・`lastTakenAt`・`placeNames`・`names` は出す写真だけから作る
- 外した写真は、完成版の `changes.removed`（作った後に消えた写真）に数えない（外した後に旅行から消しても知らせない）
- 文を書く AI には外した写真を渡さず、写真を全部外した場面と日の文は頼まない（[06 §8.4](./06_processing_design.md#84-ai-に渡すもの)）
- 外した写真の id は、区切り（`sceneStarts`）にも、場面のコメントの鍵にもそのまま使える（消えた写真と同じ）

**共通**

- どのエンドポイントも、`tripId` が UUID の形でなければ 400 `旅行IDの形式が無効です`、旅行が無ければ 404 `TRIP_NOT_FOUND`（旅行の API と同じ。先に判定する）
- データベースに届かなければ 503 `DATABASE_ERROR`、それ以外の失敗は 500 `INTERNAL_ERROR`（`message` は §7.2）
- 下書き・完成版が指す写真の控え（`timelinePhotos`）が読めないときは、空の日と場面や「区切りが無効です」は返さない（5-1c）。控えを消すのはタイムラインの書き込みの後なので、読んだ後に他の操作（下書きをやめる・作り直す・旅行の削除）と重なると控えだけが先に無くなる。`GET …/timeline`・`GET …/draft` は最初から読み直して（3回まで）今の状態を返す（旅行が消えていれば 404）。`PATCH` の2つの応答（書いた後に `GET …/timeline` と同じ形を組む）も同じく読み直す（5-2b）。`POST …/recut` は `PUT …/draft/scenes` と同じく読み直して保存はせず（下書きを書かない）、旅行が消えていれば 404 `TRIP_NOT_FOUND`、完成版が変わっていれば（`current.snapshotId` が違う・完成版が無い）409 `TIMELINE_STATE_CONFLICT`、同じ完成版のまま控えが無ければ壊れているので 500 `INTERNAL_ERROR`（5-2b）。`PUT …/draft/scenes` は読み直して保存はせず（出し直した新しい下書きに前の直しを書かないため）、旅行が消えていれば 404 `TRIP_NOT_FOUND`、下書きが変わっていれば 409 `TIMELINE_STATE_CONFLICT`。読み直しても控えが無い・下書きが同じままなら壊れているので 500 `INTERNAL_ERROR`。
  写真を外す2つ（T-1）は、`POST …/draft/excluded-photos` が `PUT …/draft/scenes` と、`POST …/excluded-photos` が `POST …/recut` と同じ扱いで書かない。`POST …/excluded-photos` の応答（書いた後に `GET …/timeline` と同じ形を組む）は `PATCH` の2つと同じく読み直す
- ボディを受けるもの（`PUT`・`PATCH`、写真を外す2つの `POST`（T-1））は、JSON として読めなければ 400 `リクエストボディの形式が無効です`、`null` なら 400 `リクエストボディが指定されていません`（写真の `PATCH` と同じ）
- 書き込みは読んだ文書の `_etag` 付きの置き換えで、読んでから書くまでに他（ワーカー・別の操作）が書いていたら 409 `TIMELINE_STATE_CONFLICT` `タイムラインが変わったか、作っている途中です。読み直してください`。下の表の「状態が合わない」も同じコードと文言
- 「作っている途中」は、下書きの `job.state` が `pending` / `running` のとき

**応答の形**

```json
{
  "timeline": {
    "current": {
      "writtenAt": "2026-10-08T12:14:00.000Z",
      "days": [
        {
          "date": "2026-10-05", "dayNumber": 1,
          "title": "小樽の運河と寿司", "titleSource": "user", "summary": "…", "summarySource": "ai",
          "scenes": [
            {
              "startPhotoId": "9f86d0…", "startedBy": "ai", "hasFood": true,
              "label": "朝ごはん", "labelSource": "ai", "note": null, "noteSource": null,
              "firstTakenAt": "2026-10-05T07:50:12", "lastTakenAt": "2026-10-05T07:58:40",
              "placeNames": ["北海道千歳市"], "names": ["海鮮丼"],
              "photos": [{ "id": "9f86d0…", "takenAt": "2026-10-05T07:50:12", "category": "food", "name": "海鮮丼", "placeName": "北海道千歳市", "thumbnailUrl": "…?sig=…" }]
            }
          ]
        }
      ]
    },
    "draft": { "id": "0b8e1c5a-…", "reason": "recut", "phase": "reviewing", "job": null, "startedAt": "2026-10-09T09:00:00.000Z" },
    "changes": { "added": 5, "removed": 2 }
  },
  "pendingPhotoCount": 0,
  "urlExpiresAt": "2026-10-10T04:12:45.000Z"
}
```

- `timeline` は完成版も下書きも無ければ `null`（そのときも `pendingPhotoCount` と `urlExpiresAt` は返す）
- `current`（完成版）: 完成版が無ければ `null`（下書きだけのとき）。`days`・`scenes` は撮影の順。日の分け方・場面の組み方は `GET …/timeline/draft` と同じ（[04 §1.6](./04_data_design.md#16-タイムラインtype-timeline-と-timelinephotos段階5) の決まり。日の切り替えは完成版の `dayStartHour`。`startPhotoId` は場面の最初の写真が消えていても控えの最初の写真の id のまま）。
  日の `title`・`titleSource`・`summary`・`summarySource` と、場面の `label`・`labelSource`・`note`・`noteSource` は完成版の文（日は日付、場面は `startPhotoId` で引く）で、その日・場面の文が完成版に無ければ4つとも `null`。区切りを直して新しくできた場面は文が空で、`label`・`labelSource`・`note`・`noteSource` が `null`（5-5a で実装済み。編集で片方だけ書くと、書いた欄だけ埋まる）。
  AI が書いた場面は、U-3 から一言を書かないので `note`・`noteSource` が `null`（`PATCH` で利用者が書けば埋まる。U-3 より前に AI か利用者が書いた一言は残っていて、そのまま返す。返し続けるかは判断待ち。[09](./09_backlog.md)。U-3 で実装済み。[06 §8.3](./06_processing_design.md#83-文を書くstep-write)）。`startedBy` は区切りを入れた主（`day`: その日の最初の写真、`ai`: AI の案、`user`: 利用者）。`hasFood` は場面に食べ物（`category: "food"`）の写真が1枚でもあるか（画面の印の色）。
  `names` は場面の写真の識別の名前、`placeNames` は地名（どちらも重なりを除いて撮影の順）。`photos` は控えから作り、**その後に消えた写真と、外した写真（完成版の `excludedPhotoIds`）は出さない**（写真が全部消えた・外した場面と日も出さない。上の「外した写真」）。
  `thumbnailUrl` はサムネイル（無ければ原寸）の読み取りの SAS（§6）。撮影日時の無い写真は出さない（タイムラインに入れない。02 §5 #54。T-2b で実装済み）
- `draft`（下書き）は状態だけ（`id`・`reason`・`phase`・`job`（`step`・`state`・`lastError`）・`startedAt`）。区切りの中身は `GET …/timeline/draft` で読む
- `changes` は、完成版の控えと今の写真の差（`added` は旅行の今の写真のうち控えに無いもの（解析中の写真も数える）、`removed` は控えの写真のうち旅行に今は無いもの（消えた・別の旅行へ移した）の枚数で、外した写真は数えない（T-1）。どちらも撮影日時の無い写真は数えない（タイムラインに入れないので。T-2 で実装済み。02 §5 #54。それまでは数えていた）。控えでは撮影日時が無く、今は撮影日時がある写真（作った後に撮影日時を手で付けた写真）も `added` に数える（完成版から外した写真は除く。日時のある写真を外したときと同じ。作り直すと入るので。D-3 で実装済み。`timelineRead.ts`。02 §5 #59）。手で付けた撮影日時を作った後に消した写真は、完成版には控えの日時のまま出し、`removed` には数えない）。完成版が無ければ `null`
- `timeline` の欄は `current`・`draft`・`changes` の3つ（`droppedEdits` は 5-5d で外した。上の 5-5d の印）

**`GET /api/trips/{tripId}/timeline`** → 200 `{ timeline, pendingPhotoCount, urlExpiresAt }`

**実装済み**（5-1c。`timeline.ts` の `getTimeline`）。

- `pendingPhotoCount` は、旅行の写真のうち解析が済んでいない（`processing.state` が `pending`・`classifying`・`identifying`）ものの枚数（`none`・`done`・`failed` は数えない。タイムラインが無くても数える）。0 でなければ作れない（画面は「解析中の写真があと N 枚あります」）
- 読むのは、タイムラインの文書と旅行の写真（[04 §5](./04_data_design.md#5-クエリ) の 5.13。id と解析の状態）を並べて、完成版があればその控え。増えた・消えた枚数と `pendingPhotoCount` は同じ 5.13 の結果から数える。下書きの控えは読まない（`draft` は状態だけ）
- 500 の `message` は `タイムラインの取得に失敗しました`（§7.2）

**`GET /api/trips/{tripId}/timeline/draft`** → 200 `{ draft, urlExpiresAt }`

**実装済み**（5-1a。`timelineDraft.ts` の `getTimelineDraft`。文を書くのに失敗した下書きにも `days` を付けるのは 5-3b）。

- 下書きが無ければ `draft: null`（タイムラインが無いときも、完成版だけのときも）。あれば状態（上と同じ）に加えて、`phase` が `reviewing` のときと、文を書くのに失敗した（`writing` で `job.state: "failed"`）ときだけ `days`（`date`・`dayNumber`・`scenes`。`scenes` は文の無い形で `startPhotoId`・`startedBy`・`hasFood`・`firstTakenAt`・`lastTakenAt`・`placeNames`・`names`・`photos`、それに場面のコメントの `comment`（下書きの `sceneComments` を `startPhotoId` で引いたもの。無ければ `null`。5-7 で実装済み。`services/timelineView.ts` の `reviewingDraftOf()`。同じ形を返す `POST …/recut`・`PUT …/draft/scenes` の応答にも付く））を付ける（案の確認画面が読む。撮影日時の無い写真は出さない。T-2b）。
  日と場面の組み方は完成版と同じ（[04 §1.6](./04_data_design.md#16-タイムラインtype-timeline-と-timelinephotos段階5) の決まり。日の切り替えは下書きの `dayStartHour`）で、控えを取った後に消えた写真と、下書きで外した写真（`excludedPhotoIds`）は出さず、写真が全部消えた・外した場面と日も出さない。
  何日目かと場面の分け方は、消えた写真も含めた控えで決める（写真を消しても日の番号や区切りが動かない）。そのため `startPhotoId` は、場面の最初の写真が消えていても控えの最初の写真の id のまま（`photos` の先頭とは限らない）
- 下書きを作っている間に画面が 5 秒ごとに読み直すのはこちら（写真の変化を数えない。[04 §5](./04_data_design.md#5-クエリ) の 5.13）。確かめ中と文を書くのに失敗したときだけ、控えと、消えた写真を見分けるための旅行の写真（5.13 のクエリ。id だけを使う）を読み、写真の保存先の設定を読む（それ以外では読まない。文を書くのに失敗した下書きも、案の確認画面（[03 §8.4](./03_screen_design.md#84-案の確認画面タイムラインを編集)）で直してから書き直せる。5-3b）
- 500 の `message` は `タイムラインの取得に失敗しました`（§7.2）

**`POST /api/trips/{tripId}/timeline`**（作る・作り直す。区切り案から）→ 202 `{ draft, urlExpiresAt }`

**実装済み**（5-1a。`timeline.ts` の `createTimeline`）。「完成版があれば消す」（表の 4 の太字と、下の「5-6b から」の行）は 5-6b で実装済み。

| # | 条件 | 応答 |
|---|---|---|
| 1 | 作っている途中 | 409 `TIMELINE_STATE_CONFLICT` |
| 2 | 解析が済んでいない写真（`processing.state` が `pending`・`classifying`・`identifying`）がある。`none`・`done`・`failed` は済んだものとして扱う | 409 `TIMELINE_PHOTOS_PROCESSING` `解析中の写真があります。終わってから作ってください` |
| 3 | 撮影日時のある写真が1枚も無い（写真が無い旅行も） | 409 `TIMELINE_NO_DATED_PHOTOS` `撮影日時のある写真がありません` |
| 4 | それ以外 | 202。写真の控えを取り（`TIMELINE_DAY_START_HOUR` もこのときに読む）、新しい下書き（`reason: "create"`・`phase: "proposing"`・`job: { step: "propose", state: "pending", attempts: 0, lastError: null }`・`proposedStarts` と `sceneStarts` は空）を書いてキューへ投入。**完成版があれば消す**（`current: null`。作り直しは今のタイムラインを消して一から作る。5-6b から。それより前は下の「5-6b まで」の行）。前の下書き（確かめ途中・失敗。区切りを直している途中の `recut` も）は置き換える。投入に失敗しても 202（再投入のタイマーが拾う。写真の `process` と同じ） |

- 1〜3 のどれかで返すときは、控えも下書きも作らず、キューにも積まない
- 置き換えても `createdAt` は変えない
- 5-6b から: 消した完成版の控えと、置き換えた下書きの控えを消す（失敗はログだけ。区切りの直しの下書きは完成版と同じ控えを指すので、1回だけ消す）。読んでから書くまでに他が書いた（下の 409 の行）ときは、完成版と前の下書きの控えも消さない。
  作り直しで完成版を消すのは、2026-10-28 に人間が決定（確かめのダイアログで「元には戻せません」と伝え、作り直しの間は完成版を出さない。[03 §8.6](./03_screen_design.md#86-作り直す)）。5-5d までのアプリが「書き終えるまでは今のタイムラインのままです」と伝えていたので、5-6 のアプリを入れた後に変えた（5-6b）
- **5-6b まで**（5-1a〜5-5b。5-6b でやめた）: 完成版があれば、新しい下書きは `reason: "rebuild"` で、完成版（`current`）は変えない（作り直しの下書きが書き終えたときに、完成版をまるごと置き換える。前の完成版の文と、利用者が直した区切りは新しい完成版に残らない。5-5b で実装済み）。置き換えた下書きの控えは、完成版から指されていなければ消す（失敗はログだけ）。
  5-6b より前に作った `rebuild` の下書きは、5-6b の後も、書き終えたときに完成版を置き換える
- 読んでから書くまでに他がタイムラインを書いた・同時に作られた（共通の行の 409 `TIMELINE_STATE_CONFLICT`）ときは、作った控えを消し（失敗はログだけ）、下書きを変えず、キューにも積まない
- 応答の `draft` は状態だけ（上の「応答の形」の `draft`）。`urlExpiresAt` は URL を含まないが他の応答と同じく付ける
- 500 の `message` は `タイムラインの作成の受付に失敗しました`（§7.2）

**`POST /api/trips/{tripId}/timeline/recut`**（完成版の区切りを直し始める）→ 200 `{ draft, urlExpiresAt }`

**実装済み**（5-2b。`timelineCurrent.ts` の `postTimelineRecut`）。ボディは読まない。

- 完成版が無ければ（タイムラインが無いときも、下書きだけのときも）404 `TIMELINE_NOT_FOUND` `タイムラインが見つかりません`。下書きがあれば（作り直し・区切りの直しの途中。`phase` によらない）409 `TIMELINE_STATE_CONFLICT`。どちらも何も書かない
- それ以外は、完成版の控え・区切りを写した下書きを作る: `id` は新しい UUID、`reason: "recut"`・`phase: "reviewing"`・`job: null`、`snapshotId`・`dayStartHour`・`proposedStarts`・`sceneStarts` と外した写真（`excludedPhotoIds`。完成版にあれば。T-1）は完成版のもの（AI の案も写すので、場面の `startedBy` は完成版と同じになる）、`startedAt` は今。タイムラインの `updatedAt` を今にし、完成版（`current`）は変えない。AI は呼ばず、キューにも積まない
- 書く前に完成版の控えと旅行の写真（[04 §5](./04_data_design.md#5-クエリ) の 5.13。id だけを使う）を読み、写真の保存先の設定も読む（設定が足りなければ下書きを書かずに 500）。控えが読めないとき（旅行の削除と重なった）は共通の行のとおり 404 / 409 / 500 で、下書きを書かない
- 応答の `draft` は `GET …/timeline/draft` の確かめ中と同じ形（状態に、写した区切りで組んだ `days`。完成版を作った後に消えた写真は出さない）
- 読んでから書くまでに他が書いていたら（共通の行）409 `TIMELINE_STATE_CONFLICT` で、書かない
- 500 の `message` は `タイムラインの作成の受付に失敗しました`（§7.2）

**`PUT /api/trips/{tripId}/timeline/draft/scenes`**（下書きの区切りと場面のコメントを保存する）`{ sceneStarts: string[], sceneComments?: { [photoId]: string } }` → 200 `{ draft, urlExpiresAt }`

**実装済み**（5-1c。`timelineDraft.ts` の `putTimelineDraftScenes`）: `sceneComments` の行（表の 4・5・7）を除く全部。
**実装済み**（5-7。`timelineDraft.ts` の `putTimelineDraftScenes`・`savedCommentsOf()`）: `sceneComments`（場面のコメント。[03 §8.7](./03_screen_design.md#87-場面のコメント)）の行（表の 4・5・7、8 の `sceneComments`、下の `sceneComments` と `recut` の行）。
**実装済み**（#127。`utils/userText.ts` の `trimUserText()`）: 場面のコメントの前後の空白に U+0085 を含めること（表の 5 と、下の `sceneComments` の行）。
**実装済み**（#128。`utils/userText.ts` の `exceedsLength()`）: 場面のコメントの文字数を見た目の1文字で数えること（表の 5。§9.6）。

判定の順は、`tripId` の形 → ボディ（共通の行。JSON として読めない・`null`）→ 旅行が無い（404 `TRIP_NOT_FOUND`）→ 下の表の 1〜7。表の 3〜7 はタイムラインを読んだ後に見る（6・7 は控えが要る。§1 の「Cosmos DB に触る前に全部弾く」の例外）。

| # | 条件 | 応答 |
|---|---|---|
| 1 | 下書きが無い（タイムラインが無いときも、完成版だけのときも） | 404 `TIMELINE_NOT_FOUND` `タイムラインの下書きが見つかりません` |
| 2 | `phase` が `reviewing` でも、文を書くのに失敗した（`writing` で `job.state: "failed"`）のでもない（区切り案を作っている・区切り案に失敗した・文を書いている） | 409 `TIMELINE_STATE_CONFLICT` |
| 3 | `sceneStarts` が無いか、文字列の配列でない | 400 `INVALID_REQUEST` `区切りは写真IDの配列で指定してください` |
| 4 | `sceneComments` があり、オブジェクトでない（配列・`null` も）か、値に文字列でないものがある | 400 `INVALID_REQUEST` `場面のコメントは写真IDと文字列の組で指定してください` |
| 5 | `sceneComments` の値が、前後の空白を除いて `TIMELINE_VALIDATION.MAX_LENGTH.SCENE_COMMENT`（100）文字を超える（数え方と前後の空白は §9.6） | 400 `INVALID_REQUEST` `場面のコメントは100文字以内で指定してください`（上限値を埋め込む） |
| 6 | 控えに無い・日時の無い写真の id を含む、重なる、撮影の順でない | 400 `INVALID_REQUEST` `区切りが無効です` |
| 7 | `sceneComments` の鍵が、保存する区切り（下の補ったものを含む）に無い | 400 `INVALID_REQUEST` `場面のコメントは場面の最初の写真に付けてください` |
| 8 | それ以外 | 200。下書きの `sceneStarts` と `sceneComments` を置き換え、`updatedAt` を今にする（下書きのほかの欄・完成版は変えない）。文を書くのに失敗した下書きなら `phase: "reviewing"`・`job: null` に戻す |

- 1〜7 のどれかで返すときは何も書かない
- `sceneComments` の値は前後の空白を除いて保存し、空になったもの（空・空白だけ）は持たない（その場面のコメントを消す）。
  前後の空白は §9.6 のもの（U+0085 を含む。U+0085 だけのコメントもアプリと同じく空として持たない。#127）。100 文字の検証（表の 5）も同じ除き方で除いた後に数える。
  `sceneComments` を送らなければ、今のコメントのうち保存する区切りに鍵があるものを残す（区切りだけを送る 5-6 までのアプリでも、場面ごと消えたコメントだけが消える）。
  場面をつなげたときにどちらのコメントを残すかは、画面が決めて送る（[03 §8.7](./03_screen_design.md#87-場面のコメント)）
- 区切りを直している下書き（`recut`）でも保存するが、使わない（文を書く AI を呼ばないため。画面はコメントの欄を出さない）
- 6 は控えで見るので、控えを取った後に消えた写真の id も区切りに使える（表示では消えた写真を出さず、場面の `startPhotoId` はその id のまま）
- 各日の最初の写真（日は下書きの `dayStartHour` で分ける）が入っていなければ、補って保存する（場面は日をまたがない。5-3b）。案の確認画面は写真が全部消えた日や場面を見ず、その区切りを送れないため（以前は 400 にしていて、日の最初の場面の写真を全部消すと区切りを直せなくなった）
- 同じく、今の下書きの区切りのうち、その場面の写真が全部消えている（旅行に今は無いか、下書きで外した。外したものは T-1）区切りも、送られなければ補う（5-4a）。補わないと、見えない場面の写真が前の場面に混ざる（区切りを直して当てるときに、見えない場面の文が消える。[06 §8.6](./06_processing_design.md#86-直した区切りを完成版に当てるrecutai-を使わない)）。
  ただし、同じ日でその次にある見える場面（今もある写真を含む場面）の区切りが送られていない（利用者がその場面を前の場面とつなげた）ときは補わない（補うと、つなげた場面が見えない場面に付く）。同じ日にその後の見える場面が無ければ補う。場面の分け方（どの区切りが見えない場面か）は、今の下書きの `sceneStarts` と各日の最初の写真で見る
- 応答の `draft` は `GET …/timeline/draft` の確かめ中と同じ形（状態に、保存した区切りで組んだ `days`。控えを取った後に消えた写真は出さない）
- 読んでから書くまでに他が書いていたら（共通の行）409 `TIMELINE_STATE_CONFLICT` で、書かない
- 500 の `message` は `タイムラインの区切りの保存に失敗しました`（§7.2）

画面は区切りを1つ直すたびに送る（途中でやめても残る。[02 §5](./02_design_overview.md#5-人間に決めてもらう点推奨付き) #46）。

**`POST /api/trips/{tripId}/timeline/draft/excluded-photos`**（下書きから写真を外す。案の確認画面）`{ photoIds: string[] }` → 200 `{ draft, urlExpiresAt }`

**実装済み**（T-1。`timelineDraft.ts` の `postTimelineDraftExcludedPhotos`）。
**実装済み**（T-2c）: 表の 5（外すと出す写真が無くなるときの 409）。

判定の順は、`tripId` の形 → ボディ（共通の行。JSON として読めない・`null`）→ 下の表の 1 → 旅行が無い（404 `TRIP_NOT_FOUND`）→ 表の 2〜5。表の 1 はデータベースに触る前に見る（§1）。表の 4 は控えが要るので、タイムラインと控えを読んだ後に見る（§1 の「Cosmos DB に触る前に全部弾く」の例外。`PUT …/draft/scenes` の 6 と同じ）。

| # | 条件 | 応答 |
|---|---|---|
| 1 | `photoIds` が無い・配列でない・空・文字列でない値を含む | 400 `INVALID_REQUEST` `外す写真は写真IDの配列で指定してください` |
| 2 | 下書きが無い（タイムラインが無いときも、完成版だけのときも） | 404 `TIMELINE_NOT_FOUND` `タイムラインの下書きが見つかりません` |
| 3 | `phase` が `reviewing` でも、文を書くのに失敗した（`writing` で `job.state: "failed"`）のでもない | 409 `TIMELINE_STATE_CONFLICT` |
| 4 | 下書きの控えに無い写真の id を含む | 400 `INVALID_REQUEST` `外す写真が無効です` |
| 5 | 外す写真が増え、外すと出す写真（撮影日時があり、旅行に今もあり、外していない写真）が1枚も無くなる | 409 `TIMELINE_NO_DATED_PHOTOS` `撮影日時のある写真がありません`（完成版で外すときと同じ。2026-10-31 に人間が決定。区切りの直しの途中で全部外すと「やめる」しか残らないため。外す写真が増えない送り直しは断らない。区切りを直している下書き（`recut`）は、当てるとき（`POST …/draft/write`）と同じく完成版と下書きの外した写真を合わせて見る） |
| 6 | それ以外 | 200。下書きの `excludedPhotoIds` に足して（重なりなし。並びに意味は無い（04 §1.6）。前に外した写真も残す）、`updatedAt` を今にする。区切り・場面のコメントなど下書きのほかの欄・完成版は変えない。文を書くのに失敗した下書きなら `phase: "reviewing"`・`job: null` に戻す（区切りの保存と同じ）。送った写真がどれももう外してあれば（外した写真が増えなければ）、文を書くのに失敗した下書きでない限り書かずに、今の下書きで同じ形を返す（書くと同じときに読んだ他の操作が 409 になる。文の `PATCH` と同じ） |

- 1〜5 のどれかで返すときは何も書かない
- 4 は控えで見るので、控えを取った後に消えた写真・もう外した写真の id を含んでもよい（何も変わらない写真がある）
- 控えが読めないとき（他の操作との重なり）は区切りの保存と同じ（共通の行。旅行が消えていれば 404 `TRIP_NOT_FOUND`、下書きが変わっていれば 409、同じ下書きのまま控えが無ければ 500）。写真の保存先の設定が足りなければ、書かずに 500（表の 5 の後に確かめるので、5 に当たれば 409）
- 応答の `draft` は `GET …/timeline/draft` の確かめ中と同じ形（外した写真を除いた `days`）
- 区切りを直している下書き（`recut`）で外した写真は、当てるときに完成版に入る（`POST …/draft/write`）。「やめる」と捨てる
- 読んでから書くまでに他が書いていたら（共通の行）409 `TIMELINE_STATE_CONFLICT` で、書かない
- 500 の `message` は `タイムラインの更新に失敗しました`（§7.2）

**`POST /api/trips/{tripId}/timeline/draft/write`**（この区切りで文を書く）→ 202 `{ draft, urlExpiresAt }`（区切りを直している下書きは 200 `{ draft: null, urlExpiresAt }`。下の行）

**実装済み**（5-2a。`timelineDraft.ts` の `postTimelineDraftWrite`）。ボディは読まない。
**実装済み**（T-2。`timelineDraft.ts` の `postTimelineDraftWrite`、判定は `services/timelineView.ts` の `hasShownPhotos()`）: 下の「出す写真が1枚も無ければ」の行。

- **出す写真（撮影日時があり、旅行に今もあり、外していない写真）が1枚も無ければ 409 `TIMELINE_NO_DATED_PHOTOS` `撮影日時のある写真がありません`**（作る受付の表の 3 と同じ。何も書かず、キューにも積まない。[02 §5](./02_design_overview.md#5-人間に決めてもらう点推奨付き) #54）。区切りを直している下書き（`recut`）は、完成版と下書きの外した写真を合わせて見る。
  そのために下書きの控えと旅行の写真（[04 §5](./04_data_design.md#5-クエリ) の 5.13）を読む（控えが読めないときは区切りの保存と同じ。共通の行）。判定は下の 404・409 の後

- 下書きが無ければ（タイムラインが無いときも、完成版だけのときも）404 `TIMELINE_NOT_FOUND`（上と同じ文言 `タイムラインの下書きが見つかりません`）。`phase` が `reviewing` でも、文を書くのに失敗した（`writing` で `job.state: "failed"`）下書きでもなければ（区切り案を作っている・区切り案に失敗した・文を書く順番を待っている・文を書いている）409 `TIMELINE_STATE_CONFLICT`
- それ以外は `phase: "writing"`・`job: { step: "write", state: "pending", attempts: 0, lastError: null, updatedAt: <今> }`（文を書くのに失敗した下書きでも `attempts` は 0 から数え直す）、`updatedAt` を今にして書き、キューへ `{ tripId, draftId }` を投入して 202。区切り（`proposedStarts`・`sceneStarts`）など下書きのほかの欄・完成版は変えない。投入に失敗しても 202（下書きは待ちのまま残り、再投入のタイマーが積む。`POST …/timeline` と同じ）。書き終えると、下書きが完成版に入れ替わる（[06 §8.3](./06_processing_design.md#83-文を書くstep-write)）
- **区切りを直している下書き（`reason: "recut"`）は、キューに積まずその場で完成版に当てて 200 `{ draft: null, urlExpiresAt }`**（AI を使わない。[06 §8.6](./06_processing_design.md#86-直した区切りを完成版に当てるrecutai-を使わない)。5-5a で実装済み）。確かめ中の下書きでも、文を書くのに失敗した下書き（5-5a より前に文を書く段に進んだもの）でも同じ。完成版の区切りを下書きのものにし、残った場面の文はそのまま、新しくできた場面の文は空、つなげて消えた場面の文は捨てる。日の文と `writtenAt` は変えない。外した写真は、下書きのもの（編集を始めたときに完成版から写し、編集で外したもの）と完成版のもの（編集の間に完成版で外したもの）を合わせる（どちらも戻さないので和。T-1）。下書きは消す。画面は続けて `GET …/timeline` を読み直す
- 404・409 で返すときは何も書かず、キューにも積まない
- 読んでから書くまでに他が書いていたら（共通の行）409 `TIMELINE_STATE_CONFLICT` で、書かずキューにも積まない
- 応答の `draft` は状態だけ（上の「応答の形」の `draft`。`phase: "writing"`・`job: { step: "write", state: "pending", lastError: null }`。区切りを直している下書きは `null`）。`urlExpiresAt` は URL を含まないが他の応答と同じく付ける
- 500 の `message` は `タイムラインの作成の受付に失敗しました`（§7.2）

**`DELETE /api/trips/{tripId}/timeline/draft`**（下書きをやめる）→ 200 `{ draft: null }`（画面は続けて `GET …/timeline` を読み直す。完成版の表示を組むのは `GET …/timeline` の1か所にする。2026-10-25、5-1a）

**実装済み**（5-1a。`timelineDraft.ts` の `deleteTimelineDraft`）。

- 下書きが無ければ（タイムラインが無いときも、完成版だけのときも）404 `TIMELINE_NOT_FOUND`（上と同じ文言 `タイムラインの下書きが見つかりません`）。作っている途中でもやめられる（ワーカーはやめた下書きに書かない。[06 §8.1](./06_processing_design.md#81-構成)）
- 下書きを消し（`draft: null`・`updatedAt` を今に。完成版はそのまま）、その控え（完成版から指されていなければ）を消す（失敗はログだけ）。完成版も無ければタイムラインの文書ごと消す
- 読んでから書く（消す）までに他が書いていたら 409 `TIMELINE_STATE_CONFLICT`（何も消さない）
- 500 の `message` は `タイムラインの更新に失敗しました`（§7.2）

**`PATCH /api/trips/{tripId}/timeline/days/{date}`** `{ title?, summary? }`・**`PATCH /api/trips/{tripId}/timeline/scenes/{photoId}`** `{ label?, note? }`（完成版の文を直す）→ 200 `{ timeline, pendingPhotoCount, urlExpiresAt }`

**実装済み**（5-2b。`timelineCurrent.ts` の `patchTimelineDay`・`patchTimelineScene`）。
**実装済み**（#128）: 文字数を見た目の1文字で数えることと、前後の空白に U+0085 を含めること（表の 5・8。§9.6）。

判定の順は、`tripId` の形 → 下の表の 1〜5 → 旅行が無い（404 `TRIP_NOT_FOUND`）→ 表の 6・7。1〜5 は Cosmos DB に触る前に見る。

| # | 条件 | 応答 |
|---|---|---|
| 1 | `photoId` の形式が無効（`scenes` のとき） | 400 `INVALID_REQUEST` `写真IDの形式が無効です` |
| 2 | ボディ（共通の行） | 400 |
| 3 | どちらの項目も無い（日は `title`・`summary`、場面は `label`・`note` だけを見る。ほかのキーは無視するので、場面に `title` だけを送ってもこの行） | 400 `INVALID_REQUEST` `更新する項目が指定されていません` |
| 4 | 項目が文字列でも `null` でもない | 400 `INVALID_REQUEST` `タイトルは文字列で指定してください`（`まとめ`・`見出し`・`一言` も同じ形） |
| 5 | 前後の空白を除いて上限を超える（上限は §4、数え方と前後の空白は §9.6） | 400 `INVALID_REQUEST` `タイトルは40文字以内で指定してください`（上限値を埋め込む。`まとめ` 400・`見出し` 30・`一言` 200） |
| 6 | 完成版が無い（タイムラインが無いときも、下書きだけのときも） | 404 `TIMELINE_NOT_FOUND` `タイムラインが見つかりません` |
| 7 | その日・その場面が完成版に無い（日は完成版の `dayTexts` の日付、場面は `sceneTexts` の鍵、つまり場面の最初の写真の id で引く。場面の途中の写真の id はこの行） | 404 `TIMELINE_NOT_FOUND` `その日はタイムラインにありません` ／ `その場面はタイムラインにありません`（`date` が `YYYY-MM-DD` の形でないとき（`TIMELINE_VALIDATION.DATE_REGEX`）と、暦に無い日付（`2026-02-30` など）も `その日はタイムラインにありません`） |
| 8 | それ以外 | 200。前後の空白を除いて保存し、書いた主を `user` にする。**空（除いて空。U+0085 だけも）か `null` なら AI が書いた文（`aiTitle` などの欄）に戻し、書いた主を `ai` にする**（区切りを直して新しくできた場面は AI の文が無いので、空（`null`）に戻り、書いた主も `null` になる。5-5a で実装済み。U-3 から AI が書いた場面の一言も AI の文が無いので、`note` は同じく `null` に戻る）。送らなかった欄はそのまま。タイムラインの `updatedAt` を今にする |

- 4・5 は欄ごとに見る（日は `title` → `summary`、場面は `label` → `note` の順に、その欄の 4 → 5）。最初に当たった1件を返す
- 1〜7 のどれかで返すときは何も書かない
- 8 で、直しても完成版の文が変わらなければ（AI の文のままの欄に `null` を送ったなど）書かずに 200 を返す（`updatedAt` も変えない。書くと `_etag` が変わり、同じときに読んだ他の操作が 409 になるため）
- 下書きがあっても直せる（下書きは変えない）。区切りを直している途中（`recut`）なら、直した文は当てるときに残る（同じ場面なら）。作り直しの途中（`rebuild`。5-6b まで）なら、書き終えたときに新しい完成版に置き換わって消える（5-5b で実装済み。5-6 のアプリは作り直しの間に完成版を出さないので、アプリからは直せない。5-6b からは作り直しを始めると完成版が消えるので、直す文が無い）
- 応答は書いた後に読み直した `GET …/timeline` と同じ形（`{ timeline, pendingPhotoCount, urlExpiresAt }`。画面は直した後の完成版を描き直す）。読み直したときに旅行が消えていれば 404 `TRIP_NOT_FOUND`
- 読んでから書くまでに他が書いていたら（共通の行）409 `TIMELINE_STATE_CONFLICT` で、書かない
- 500 の `message` は `タイムラインの更新に失敗しました`（§7.2）

**`POST /api/trips/{tripId}/timeline/excluded-photos`**（完成版から写真を外す）`{ photoIds: string[] }` → 200 `{ timeline, pendingPhotoCount, urlExpiresAt }`

**実装済み**（T-1。`timelineCurrent.ts` の `postTimelineExcludedPhotos`）。

- 判定の順は `tripId` の形 → ボディ（共通の行）→ `photoIds`（下書きの表の 1 と同じ 400）→ 旅行が無い（404 `TRIP_NOT_FOUND`）→ 完成版が無い（タイムラインが無いときも、下書きだけのときも）404 `TIMELINE_NOT_FOUND` `タイムラインが見つかりません` → 完成版の控えに無い写真の id を含む 400 `外す写真が無効です`。どれも何も書かない
- 外すと出す写真（撮影日時があり、旅行に今もあり、外していない写真）が1枚も無くなるなら 409 `TIMELINE_NO_DATED_PHOTOS` `撮影日時のある写真がありません`（何も書かない。T-2 で実装済み。02 §5 #54）。タイムラインを編集している途中なら、編集中の下書きで外した写真と合わせて見る（完成版に写真が残っても、編集中の下書きが空になると保存できなくなるため）。外した写真が増えない送り直し（下の行）は断らない。そのために完成版の控えと一緒に旅行の写真（5.13）も読む
- それ以外は、完成版の `excludedPhotoIds` に足して（重なりなし。並びに意味は無い）、タイムラインの `updatedAt` を今にする。区切り・文・作成日時は変えない。応答は `GET …/timeline` と同じ形（外した写真を除いた完成版）。送った写真がどれも完成版で（編集中の下書きがあればそこでも）もう外してあれば書かない（下書きの外すと同じ）
- 下書きがあっても外せる。タイムラインを編集している途中（`recut` で、完成版と同じ控えを指す下書き）なら、下書きの `excludedPhotoIds` にも同じ写真を足す（案の確認画面にも出さない。当てるときも合わせる。`POST …/draft/write`）。それ以外の下書きは変えない。5-6b より前に作った作り直し（`rebuild`）の下書きは、書き終えたときに完成版を置き換えるので、そのとき外した写真は残らない
- 控えが読めないとき（他の操作との重なり）は `POST …/recut` と同じ（共通の行。旅行が消えていれば 404、完成版が変わっていれば 409、同じ完成版のまま控えが無ければ 500）
- 応答は書いた後に読み直した `GET …/timeline` と同じ形（`PATCH` の2つと同じ。読み直したときに旅行が消えていれば 404 `TRIP_NOT_FOUND`）。写真の保存先の設定は書く前にも確かめ、足りなければ書かずに 500（`POST …/draft/excluded-photos`・`POST …/recut` と同じ。書いた後だと、外したのに失敗と返す）
- 読んでから書くまでに他が書いていたら（共通の行）409 `TIMELINE_STATE_CONFLICT` で、書かない
- 500 の `message` は `タイムラインの更新に失敗しました`（§7.2）

旅行を消すとタイムラインと控えも消す（5-1a で実装済み。§5.12。[04 §5.7](./04_data_design.md#57-その他の単一ドキュメント操作)）。写真の削除・move・やり直しではタイムラインは変えない（`changes` で知らせ、作り直してもらう）。

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
| 404 | `TIMELINE_NOT_FOUND` | タイムライン・下書き・その日や場面が無い | `/api/trips/{tripId}/timeline` 系（段階5。§5.15） |
| 409 | `TIMELINE_STATE_CONFLICT` | 作っている途中、状態が合わない、または読んでから書くまでに他が書いた（読み直してもらう） | 同上 |
| 409 | `TIMELINE_PHOTOS_PROCESSING` | 解析が済んでいない写真がある | `POST /api/trips/{tripId}/timeline` |
| 409 | `TIMELINE_NO_DATED_PHOTOS` | 撮影日時のある写真が無い（写真を外すと出す写真が無くなるときも） | `POST /api/trips/{tripId}/timeline`、`POST …/timeline/draft/write`・`POST …/timeline/excluded-photos`・`POST …/timeline/draft/excluded-photos`（出す写真が無くなるとき。§5.15） |
| 409 | `TAKEN_AT_FROM_CAMERA` | カメラが記録した撮影日時（`takenAtSource: "exif"`）の写真に、撮影日時を手で付けようとした（D-1） | `PATCH /api/photos/{photoId}`（§5.6） |
| 400 / 413 / 415 / 500 / 502 / 503 | 既存のコード | 既存と同じ意味 | |

段階5の4つのコードと 409（`HttpStatusCode.CONFLICT`）は 5-1a で `types/api.ts` に足した（実装済み）。今返すのは、`TIMELINE_NOT_FOUND` が `DELETE …/timeline/draft`・`PUT …/draft/scenes`（5-1c）・`POST …/draft/write`（5-2a。どれも `タイムラインの下書きが見つかりません`）と `POST …/recut`・`PATCH` の2つ（5-2b。`タイムラインが見つかりません`、`PATCH` はほかに `その日はタイムラインにありません`・`その場面はタイムラインにありません`）、`POST …/draft/excluded-photos`（T-1。`タイムラインの下書きが見つかりません`）・`POST …/excluded-photos`（T-1。`タイムラインが見つかりません`）、`TIMELINE_STATE_CONFLICT` が `POST …/timeline`・`DELETE …/timeline/draft`・`PUT …/draft/scenes`・`POST …/draft/write`・`POST …/recut`・`PATCH` の2つ・`POST …/draft/excluded-photos`・`POST …/excluded-photos`（T-1）（文言は `utils/response.ts` の `createTimelineStateConflict()` で共有）、`TIMELINE_PHOTOS_PROCESSING` が `POST …/timeline`、`TIMELINE_NO_DATED_PHOTOS` が `POST …/timeline`・`POST …/draft/write`・`POST …/excluded-photos`・`POST …/draft/excluded-photos`（後の3つは出す写真が無くなるとき。T-2・T-2c。文言は `utils/response.ts` の `createNoDatedPhotosError()` で共有）。`GET …/timeline`・`GET …/timeline/draft` はタイムラインのコードを返さない（無ければ `null`）。§5.15 のタイムラインのエンドポイントは全部実装済み（5-2b。写真を外す2つは T-1）。
`TAKEN_AT_FROM_CAMERA` は D-1 で `types/api.ts` に足し、`PATCH /api/photos/{photoId}` だけが返す（`カメラが記録した撮影日時は変えられません`。§5.6 の 11。**実装済み**（D-1））。

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
| `GET /api/trips/{tripId}/timeline`・`GET …/timeline/draft` | `タイムラインの取得に失敗しました`（段階5） |
| `POST /api/trips/{tripId}/timeline`・`POST …/recut`・`POST …/draft/write` | `タイムラインの作成の受付に失敗しました` |
| `PUT …/draft/scenes` | `タイムラインの区切りの保存に失敗しました` |
| `DELETE …/draft`・`PATCH …/days/{date}`・`PATCH …/scenes/{photoId}`・`POST …/draft/excluded-photos`・`POST …/excluded-photos`（T-1） | `タイムラインの更新に失敗しました` |

段階5の行は全部実装済み（`GET …/timeline/draft`・`POST …/timeline`・`DELETE …/draft` は 5-1a、`GET …/timeline`・`PUT …/draft/scenes` は 5-1c、`POST …/draft/write` は 5-2a、`POST …/recut`・`PATCH …/days/{date}`・`PATCH …/scenes/{photoId}` は 5-2b、`POST …/draft/excluded-photos`・`POST …/excluded-photos` は T-1）。

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
| `getPhotos({tripId, category, continuationToken})` | `GET /api/photos` | `data['photos']`・`data['continuationToken']`（null 可）。`urlExpiresAt` は読まない。`continuationToken` は省略でき、`tripId` は必須（`required`。省くとコンパイルできない）。渡したものだけをクエリに載せる（`Uri(queryParameters:)` で組み立てるので URL エンコードされる）。`tripId` は旅行の id か `none`。`category` は旅行の中の絞り込み（API は `tripId` を省いて `category` だけでも取れるが、アプリはその形で呼ばない。カテゴリ横断画面は 2026-10-24 に消した。[03 §5.2](./03_screen_design.md#52-カテゴリ横断画面削除した)）。`limit` は送らない（サーバの既定 100）。**`category` は実装済み**（3-4b）。呼び出し側の `PhotoGrid` は、読む先（`loadPage`）が無ければ `tripId` を渡す（`tripId` も読む先も無い `PhotoGrid` は、デバッグ版では `assert` が組み立てたところで止め、リリース版では読み込みの失敗になる） |
| `getPhoto(photoId)` | `GET /api/photos/{photoId}` | `data['photo']`。**実装済み**（5-4a。タイムラインのサムネイルから写真ビューアを開くとき。`urlExpiresAt` は読まない） |
| `getTimeline(tripId)` | `GET /api/trips/{tripId}/timeline` | `data['timeline']`（null 可）・`data['pendingPhotoCount']`（段階5）。**実装済み**（5-3a。`models/timeline.dart` の `TimelineOverview`）: `draft` は状態（下の `getTimelineDraft` と同じ）。`urlExpiresAt` は読まない。**`changes` は実装済み**（5-4b。`TimelineChanges`）: `changes` は null 可で、あれば `added`・`removed` を必須として読む。`droppedEdits` は読まない（5-5c から。5-4b〜5-5b のアプリは必須の配列として読んでいた。API は 5-5d で返さなくなった。§5.15）。**`current` の中身は実装済み**（5-4a。`TimelineCurrent`。5-3a では有る・無いだけを読んでいた）: `writtenAt`・`days` を必須として読む（`undatedPhotos` は T-2 から読まない。撮影日時の無い写真はタイムラインに出さない。02 §5 #54。T-2 より前のアプリは必須として読むので、API は T-2 のアプリを入れた後の T-2b で返さなくなった）。日は `getTimelineDraft` の `days` と同じ欄に加えて `title`・`titleSource`・`summary`・`summarySource`（null 可）、場面は同じ欄に加えて `label`・`note`（null 可。`labelSource`・`noteSource`・`startedBy`・`firstTakenAt`・`lastTakenAt` は読まない）。写真の `category`・`name`・`placeName` は読まない |
| `getTimelineDraft(tripId)` | `GET …/timeline/draft` | `data['draft']`（null 可）。**実装済み**（5-3a。`TimelineDraftStatus`）: 状態の `id`・`reason`・`phase`・`job`（null 可。`step`・`state`）を必須として読む。`startedAt`・`job.lastError` は読まない。区切りを確かめられる下書きの `days`（`date`・`dayNumber`・`scenes` の `startPhotoId`・`placeNames`・`hasFood`・`photos`（`id`・`takenAt`・`thumbnailUrl`））は、あれば読む（`undatedPhotos` は T-2 から読まない）（5-3b。案の確認画面。`hasFood` を必須として読むのは 5-4a から。完成版と同じ `TimelineDay`・`TimelineScene` で読むため、下書きにも要る）。場面の `names` は U-1b から読まない（完成版も下書きも。画面に出さなくなった。[03 §8.3](./03_screen_design.md#83-完成したタイムライン)。5-4a〜U-1a のアプリは必須として読む）。場面の `comment`（null 可）も読む（5-7。完成版の場面には無いので null） |
| `createTimeline(tripId)` | `POST …/timeline` | `data['draft']`。**実装済み**（5-3a。読み方は `getTimelineDraft` と同じで、null は受け付けない） |
| `recutTimeline(tripId)` | `POST …/timeline/recut` | `data['draft']`。**実装済み**（5-4a。読み方は `saveTimelineScenes` と同じ。画面は応答の下書きを使わず、案の確認画面が読み直す） |
| `excludeCurrentTimelinePhotos(tripId, photoIds)` | `POST …/timeline/excluded-photos` | `data`。**実装済み**（U-2。`getTimeline` と同じ形・同じ読み方）。ボディは `{ photoIds }`（場面の写真の一覧は1枚ずつ送る。[03 §8.8](./03_screen_design.md#88-場面の写真の一覧)。U-2） |
| `excludeTimelinePhotos(tripId, photoIds)` | `POST …/timeline/draft/excluded-photos` | `data['draft']`。**実装済み**（T-2。読み方は `saveTimelineScenes` と同じで、null は受け付けない）。ボディは `{ photoIds }`（案の確認画面は1枚ずつ送る。[03 §8.4](./03_screen_design.md#84-案の確認画面タイムラインを編集)） |
| `saveTimelineScenes(tripId, sceneStarts, {sceneComments})` | `PUT …/timeline/draft/scenes` | `data['draft']`。**実装済み**（5-3b。読み方は `getTimelineDraft` と同じで、null は受け付けない）。ボディは `{ sceneStarts }`（渡したリストをそのまま。中身の決め方は [03 §8.4](./03_screen_design.md#84-案の確認画面タイムラインを編集)）。**`sceneComments` は実装済み**（5-7）: 渡したときだけ `sceneComments`（場面の最初の写真の id → コメント。入力をそのまま。前後の空白を除くのと空を持たないのはサーバ）をボディに足し、渡さなければキーごと省く（サーバが残る区切りのコメントを残す。どちらで呼ぶかは [03 §8.7](./03_screen_design.md#87-場面のコメント)） |
| `writeTimeline(tripId)` | `POST …/timeline/draft/write` | `data['draft']`（null 可）。**実装済み**（5-3a。読み方は `getTimelineDraft` と同じ）。null を受け付けるのは 5-5a から（区切りを直している下書きはその場で完成版に当たり、応答の `draft` が `null`。戻り値も null になり、画面は続けて `getTimeline` で読み直す。[03 §8.3](./03_screen_design.md#83-完成したタイムライン)・[§8.4](./03_screen_design.md#84-案の確認画面タイムラインを編集)） |
| `discardTimelineDraft(tripId)` | `DELETE …/timeline/draft` | 読まない（続けて `getTimeline` で読み直す）。**実装済み**（5-3a）。呼ぶのは、タイムラインを編集している途中（`recut`）の「やめる」と、失敗した下書き（案を作れなかった・見出しとまとめを書けなかった）の「やめる」（02 §5 #58）。作る・作り直す途中の「やめる」は 5-6 で無くした（[03 §8.2](./03_screen_design.md#82-作っている間完成版が無いとき)） |
| `updateTimelineDay(tripId, date, changes)`・`updateTimelineScene(tripId, photoId, changes)` | `PATCH …/days/{date}`・`PATCH …/scenes/{photoId}` | `data`（`getTimeline` と同じ読み方の `TimelineOverview`。画面は直した後の完成版で描き直す）。**実装済み**（5-4b）。ボディは `changes` をそのまま JSON にしたもの（変えた欄だけ。`title`・`summary` / `label`・`note`。空にした欄は `null`。中身の決め方は [03 §8.5](./03_screen_design.md#85-編集シート)）。場面は最初の写真の id（`startPhotoId`）で指す |
| `deletePhoto(photoId)` | `DELETE /api/photos/{photoId}` | 読まない |
| `movePhotos(photoIds, tripId)` | `POST /api/photos/move` | `data['moved']`・`data['notFound']` |
| `updatePhotoComment(photoId, comment)` | `PATCH /api/photos/{photoId}` | `data['photo']`（`urlExpiresAt` は読まない）。**実装済み**（4-3c。コメントだけ）。ボディは `{ comment }` で、入力をそのまま送る（前後の空白を除くのと、空・空白だけを `null` と同じに扱うのはサーバ。§5.6）。タグは下の `updatePhotoTags`（C-3b） |
| `updatePhotoTags(photoId, tags)` | `PATCH /api/photos/{photoId}` | `data['photo']`（`urlExpiresAt` は読まない）。**実装済み**（C-3b）。ボディは `{ tags }`（付ける・消すのどちらも、今のタグに足した・除いた配列ごと。[03 §5.7](./03_screen_design.md#57-写真のタグ)）。写真の `tags`（`name`・`kind`・`x`・`y`）は C-3b から読む |
| `updatePhotoTakenAt(photoId, takenAt)` | `PATCH /api/photos/{photoId}` | `data['photo']`。送るのは `{ takenAt }`（タイムゾーン無しの日時か null）。**実装済み**（D-2。[03 §5.8](./03_screen_design.md#58-撮影日時を手で付ける)）。写真の `takenAtSource`・`uploadedAt` を読む（`Photo`。シートの手がかりと「手で付けた日時」に使う） |
| `updatePhotoCategory(photoId, category)` | `PATCH /api/photos/{photoId}` | `data['photo']`（`urlExpiresAt` は読まない）。**実装済み**（C-1）。ボディは `{ category }`（`plant` / `food` / `landscape` / `other`）だけ。植物に変えたら、応答の写真は識別の待ち（§5.6） |
| `requestPhotoProcessing(photoId, {hint, step, placeName})` | `POST /api/photos/{photoId}/process` | `data['photo']`（`urlExpiresAt` は読まない）。**実装済み**（3-4a。`step` は 4-3c、`placeName` は C-2）。ボディは `{ step, hint, placeName }` で、`step` は省くと `'classify'`（やり直しダイアログは、写真のカテゴリが識別の対象（植物・食べ物・風景）で分類が済んでいれば `'identify'`、それ以外なら `'classify'` を渡す。C-1。それまではダイアログの「名前だけ」で `'identify'`）。`hint` は前後の空白を除き、空なら `hint` のキーごと省く。`placeName` は渡したとき（null でないとき）だけ、そのまま（前後の空白を除かず、空でも）送る。null なら `placeName` のキーごと省く（撮影地を変えない）。ダイアログは「場所」の欄を利用者が直したときだけ渡す（直していなければ null。C-2。[03 §5.4](./03_screen_design.md#54-やり直しダイアログ)） |
| `getCatalogKinds()` | `GET /api/catalog/kinds` | `data['kinds']`（各要素の `kind`・`label`・`fields`（`key`・`label`・`type`）。`models/catalog.dart` の `CatalogKind`・`CatalogField`）。**実装済み**（4-3a） |
| `getCatalogEntries(kind, {required offset, required limit})` | `GET /api/catalog/entries?kind=&offset=&limit=` | `data['entries']`・`data['total']`（`CatalogEntryPage`。項目は `CatalogEntry`）。**実装済み**（4-3a）。`kind`・`offset`・`limit` を毎回クエリに載せる（`Uri(queryParameters:)`。図鑑の画面は `limit` に 50 を渡す）。`entries` の件数は続きがあっても `limit` より少ないことがある（§5.14）ので、次の `offset` は呼び出し側が `limit` だけ進め、`total` 以上なら読み切り（[03 §6.1](./03_screen_design.md#61-図鑑タブ種類タブ--項目一覧)）。`CatalogEntry` は `description`・`characteristics` を null 可、`attributes` が無ければ空、それ以外の欄は必須として読む。P-1 で足した `genus`・`genusName` は null 可で読む（キーが無くても `null`。**実装済み**（P-2）。図鑑の一覧の属の見出しに使う。[03 §6.1](./03_screen_design.md#61-図鑑タブ種類タブ--項目一覧)） |
| `getCatalogEntry(kind, name, {continuationToken})` | `GET /api/catalog/entry?kind=&name=&continuationToken=` | `data['entry']`（null 可。`CatalogEntry`）・`data['photos']`・`data['continuationToken']`（null 可）（`models/catalog.dart` の `CatalogEntryDetail`。写真は `PhotoPage`）。**実装済み**（4-3b）。`kind`・`name` を毎回、`continuationToken` は渡したときだけクエリに載せる（`Uri(queryParameters:)` で組み立てるので、記号や空白を含む名前も URL エンコードされる）。`limit` は送らない（サーバの既定 100）。`urlExpiresAt` は読まない（`getPhotos` と同じ）。`photos` は `entry` が null でも必須として読む（サーバは `[]` を返す）。`CatalogEntry` の読み方は `getCatalogEntries` と同じ |

`_parseResponse()` はボディ全体をコールバックに渡すので、各メソッドが `json['data']` を剥がす（CLAUDE.md「クライアント実装で踏みやすい罠」）。
既存の `testConnection()`（設定画面の接続テスト）は 4-5 で宛先を `GET /api/plants` から、旅行をまたぐ写真の一覧を1件だけ読む `GET /api/photos?category=plant&limit=1` に変えた（データベースに届かなければ失敗として出る）。ステータスが 2xx かだけを見て、ボディは読まない（通信の失敗も含めて例外を投げず `false` を返す。[03 §6.4](./03_screen_design.md#64-植物図鑑の廃止に伴う画面の削除)）。
植物図鑑のメソッド（`uploadAndIdentifyImage`・`checkDuplicate`・`savePlant`・`getPlants`・`getPlant`・`updatePlant`・`deletePlant`）は 4-5 で削除した。
`ApiException` に `isTripNotFound`（`code == 'TRIP_NOT_FOUND'`）と `isPhotoNotFound`（`code == 'PHOTO_NOT_FOUND'`。複数選択の削除で既に無い写真を消せたと数える。ステータスだけで見ると宛先の誤りの 404 まで含むのでコードで見る）を足す。
段階5では `isTimelineChanged`（`code` が `TIMELINE_STATE_CONFLICT` か `TIMELINE_NOT_FOUND`。読んだ後にタイムラインが変わったので読み直す）と `isTimelineNotCreatable`（`code` が `TIMELINE_PHOTOS_PROCESSING` か `TIMELINE_NO_DATED_PHOTOS`）を足した（**実装済み**。5-3a。画面の扱いは [03 §8.1](./03_screen_design.md#81-旅行詳細の切り替え)。案の確認画面（5-3b。5-5d までの名前は区切りの確認画面）は `isTimelineChanged` なら旅行詳細に戻る。[03 §8.4](./03_screen_design.md#84-案の確認画面タイムラインを編集)。編集シート（5-4b）は `isTimelineChanged`・`isTripNotFound` なら閉じる。[03 §8.5](./03_screen_design.md#85-編集シート)）。
`uploadPhoto` は **実装済み**（PR 7a。`thumbnail`・`placeName` は PR 7c）。`multipart/form-data` で次のパートを送る。

- `photoId`: 画像のバイト列の SHA-256（16進・小文字）。`image` と同じバイト列から求める（§5.1 の 18 を通るように）
- `image`: 画像のバイト列。ファイル名は `photo`、Content-Type は拡張子ではなく先頭のバイト列（シグネチャ）で決める（PNG / JPEG / GIF / WebP。どれでもなければ `image/jpeg`）
- `tripId`・`takenAt`: 値があるときだけ。無ければパートごと省く（空文字のパートは §5.1 の 12・13 で 400 になる）
- `latitude`・`longitude`: 両方があるときだけ、両方を送る（片方だけは §5.1 の 14）。10進の小数 6 桁の文字列（`toStringAsFixed(6)`。指数表記にならない。§5.1 の 15）
- `thumbnail`: サムネイル（[03 §4.7.2](./03_screen_design.md#472-準備) の準備で作った長辺 320px・画質 70 の JPEG）があるときだけ。ファイル名は `thumbnail.jpg`、Content-Type は `image/jpeg`。作れなかったらパートごと省く（空のパートは §5.1 の 10 で 400）
- `placeName`: 地名（[06 §4.2](./06_processing_design.md#42-段階2端末)）があり、緯度・経度も送るときだけ（§5.1 の 16）。無ければパートごと省く（空・空白のみは §5.1 の 17 で 400）

`movePhotos` は 200 件（§5.5 の 5）を超える分を分けて順に送り、`moved`・`notFound` を合わせて返す。旅行から外すときも `tripId` のキーを省かずに `null` を送る。

## 9. 共通の決まり

API 全体に共通する、認証・応答の封筒・エラー・AI 識別サービスへの接続・利用者が書く文の数え方の決まり（以前の `docs/06_api_design.md` と `docs/05_technology_selection.md` §3.5 から移した。2026-10-25）。
**実装済み**。

### 9.1 認証と宛先

- Function Key 認証。キーはヘッダ `x-functions-key` で渡す（Azure Functions は `code` クエリパラメータでも受け付けるが、アプリはヘッダで送る。URL は例外の文言やログに出やすく、キーが漏れるため。2026-10-27）。キーはアプリの設定画面で入れる（[03 §4.9](./03_screen_design.md#49-設定画面)）
- HTTP の関数はすべて `authLevel: 'function'`。キューとタイマーの関数は HTTP では呼べない
- Base URL は `https://<Function App>.azurewebsites.net/api`（アプリは本番の URL を持たない。設定画面で入れる）
- 消した植物図鑑のルート（`/api/plants` 系・`/api/images/upload`。4-6 で削除）には関数が登録されていないので、呼ぶと 404 になる（封筒の無い、Functions のランタイムの応答）

### 9.2 応答の封筒とエラーの形

成功は `{ "success": true, "data": { ... } }` で、`data` の中身はエンドポイントごとに違う（§2 の表）。失敗も同じ封筒に包む。

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "エラーの説明（日本語）",
    "details": "string | null"
  }
}
```

- `details` は省略されることがある（`createErrorResponse()` に渡されなかった場合、JSON にキー自体が現れない）
- 500 `INTERNAL_ERROR`・502・503 では、`details` にサーバ内部で起きた例外のメッセージ（`error.message`）がそのまま入る。SDK 由来の英語のこともあり内容は安定しないので、クライアントは表示や分岐に使わない
- **契約の範囲**: HTTP ステータス・`code`・`message` は契約で、エンドポイントの仕様に文言まで書く。`message` はアプリが画面にそのまま出すので、変えるときは仕様も変える。`details` は契約外で、文言を保証しない（2026-10-11 に人間が決定）

### 9.3 エラーコード

`code` は `api/src/types/api.ts` の `ErrorCode` の値。どのエンドポイントがどのステータス・`message` で返すかは、各エンドポイントの節と §7 にある。

| `code` | HTTP ステータス | 説明 |
|---|---|---|
| `INVALID_REQUEST` | 400 | リクエストの形が不正 |
| `TRIP_NOT_FOUND` | 404 | 旅行が見つからない |
| `PHOTO_NOT_FOUND` | 404 | 写真が見つからない |
| `FILE_TOO_LARGE` | 413 | ファイルの大きさが上限を超えた（0 バイトは 400 `INVALID_REQUEST`） |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | 受け付けないファイル形式 |
| `INTERNAL_ERROR` | 500 | サーバー内部エラー。`message` はエンドポイントごとに固定（§7.2。失敗の原因によって変わらない） |
| `STORAGE_ERROR` | 502 / 503 | Blob Storage の操作の失敗（§9.4） |
| `DATABASE_ERROR` | 503 | Cosmos DB へ接続できない（`データベースに接続できません`） |
| `AI_SERVICE_ERROR` | 502 / 503 | AI 識別サービスの呼び出しの失敗。今は返すエンドポイントが無い（AI を呼ぶのは裏のワーカーだけで、ワーカーは応答を返さない） |

段階5のタイムラインのコード（`TIMELINE_NOT_FOUND` 404・`TIMELINE_STATE_CONFLICT`・`TIMELINE_PHOTOS_PROCESSING`・`TIMELINE_NO_DATED_PHOTOS` 409。5-1a で `ErrorCode` に足した）と、撮影日時を手で付けるときのコード（`TAKEN_AT_FROM_CAMERA` 409。D-1 で足した。**実装済み**）は §7.1。

**401 はこの表に載せていない。** Function Key が未指定・無効な場合は Azure Functions のランタイムが 401 を返し、アプリケーションのコードに届かない。
そのため応答は封筒にならず、`ErrorCode` にも対応する定義を持たない（以前は `UNAUTHORIZED` / `INVALID_API_KEY` が定義されていたが、生成箇所が構造的に無いため削除した）。

**429 もこの表に載せていない。** 過負荷時に Azure Functions のランタイムが 429（"Too Busy"）を返すことがあり、これも 401 と同じく封筒なしの応答になる。
従量課金プランでは `host.json` の `extensions.http.dynamicThrottlesEnabled`（既定 `true`）と `extensions.http.maxOutstandingRequests`（既定 200）でこの拒否が有効になっており、`api/host.json` はどちらも変えていない。
アプリケーションのレート制限（未実装。`docs/09_backlog.md`）とは別物。

### 9.4 502 / 503 の振り分け

上流（Blob Storage・AI 識別サービス）の呼び出しの失敗は、**失敗した場所**でコードを決め、**接続できたかどうか**で 502 と 503 を分ける
（`api/src/utils/response.ts` の `createUpstreamErrorResponse()`）。エラーメッセージの文言は判定に使わない。

| 失敗した場所 | 原因 | ステータス・コード | `message` |
|---|---|---|---|
| Blob Storage の操作 | 接続できない（`ENOTFOUND` / `ECONNREFUSED` / `ETIMEDOUT`） | 503 `STORAGE_ERROR` | `ストレージサービスに接続できません` |
| Blob Storage の操作 | 上記以外（接続できたうえでの失敗） | 502 `STORAGE_ERROR` | `ストレージサービスでエラーが発生しました` |
| AI 識別の呼び出し | 接続できない（`ENOTFOUND` / `ECONNREFUSED` / `ETIMEDOUT`） | 503 `AI_SERVICE_ERROR` | `AIサービスに接続できません` |
| AI 識別の呼び出し | 上記以外 | 502 `AI_SERVICE_ERROR` | `AIサービスでエラーが発生しました` |

AI 識別の行は、今は返すエンドポイントが無い（§9.3）。`UpstreamError` の種類ごとに持つ表なので、コードに残っている。

- **接続できない**の判定は、SDK が包んだエラーの奥にある原因までたどって行う（OpenAI SDK の接続エラーは errno を直接持たず、2段奥の原因に持つため）。
  たどるのは10段までで、原因が循環していても止まる（見つからなければ接続できない以外の失敗として扱う）
- Cosmos DB へ接続できない場合（`ENOTFOUND` / `ECONNREFUSED` / `ETIMEDOUT`、と Cosmos SDK が応答を待ちきれずに打ち切った `TimeoutError`。同じく原因までたどる）は 503 `DATABASE_ERROR`（`createDatabaseErrorResponse()`）。SDK の打ち切りは要求を送った後なので書けていることもあるが、500 でも利用者は押し直すので変わらない（アプリは書き込みを自動で送り直さない。写真の送信は同じ写真が1枚にまとまる。2026-11-01 に人間が決定）。どの判定も同じ errno の一覧を使う（`ETIMEDOUT` は以前 Blob Storage の操作だけで、Cosmos DB では 500 `INTERNAL_ERROR` だった。2026-11-01 に揃えた。**実装済み**（Cosmos の時間切れの 503））

### 9.5 AI 識別サービスへの接続

写真の分類と識別（裏のワーカー。[06 §2・§3](./06_processing_design.md#2-分類段階3)）と、タイムラインの区切り案（段階5。5-1b）と文（5-2a。[06 §8](./06_processing_design.md#8-タイムライン段階5)）は、同じサービス（`api/src/services/openAIVisionService.ts`）を通して
AI 識別サービス（Azure OpenAI Service の Chat Completions）へ、1回の分類・識別につき1回の要求を送る（区切り案・文はそれぞれ1回の作成につき1回。写真の多い旅行は分けて複数回。文は作り直しでも全部の場面と日を書かせる（5-5b。それまでは書かせるものが無ければ呼ばなかった）。[06 §8.3・§8.4](./06_processing_design.md#84-ai-に渡すもの)）。
管理外の依存へ送るものは外部との契約なので、要素をここに書く。ここに書くのは共通の要素で、
送り先のデプロイの選び方・スキーマ・プロンプトが指示すること・渡す画像（タイムラインは写真ごとの行）は [06 §2.1・§2.2・§3.1・§8.4](./06_processing_design.md#21-モデルとサービス) にある。

**プロンプトの文言は契約外。** ここにも 06 にも写さず、テストでも完全一致で固定しない。

| 要素 | 内容 |
|---|---|
| 接続先 | `AZURE_OPENAI_ENDPOINT` があれば Azure OpenAI Service。このとき送り先のデプロイ名は必須で、決まらない（空文字列・空白だけを含む）なら要求を送らずに失敗する（表の下）。`baseURL` は `<AZURE_OPENAI_ENDPOINT>/openai/deployments/<デプロイ名>`（デプロイ名は前後の空白を取り除いたもの）、クエリ `api-version` は `AZURE_OPENAI_API_VERSION`（未設定なら `2024-12-01-preview`）、ヘッダ `api-key` は `AZURE_OPENAI_API_KEY`。無ければ OpenAI API（`OPENAI_API_KEY`。`baseURL`・`api-version`・`api-key` ヘッダは付けない） |
| デプロイ名 | サービスを作るときに渡したもの。省略・空・空白だけなら `AZURE_OPENAI_DEPLOYMENT_NAME`（前後の空白を取り除いたもの）。分類は `AZURE_OPENAI_CLASSIFY_DEPLOYMENT_NAME`、タイムラインは `AZURE_OPENAI_TIMELINE_DEPLOYMENT_NAME` を渡し、識別は何も渡さない（06 §2.1・§3.1・§8.1） |
| モデル | デプロイ名。Azure OpenAI Service では `baseURL` のデプロイ名と常に一致する。OpenAI API に直接つなぐとき（`AZURE_OPENAI_ENDPOINT` が無いとき）だけ、デプロイ名が決まらなければ `gpt-5.6-luna` を使う |
| メッセージ | `user` ロールの1件。分類・識別はテキスト（プロンプト）と画像の2パート、タイムラインはテキストの1パートだけ（画像を渡さない。06 §8.4） |
| 画像 | 分類・識別だけ。`image_url` パート。`detail: "low"`（トークン節約）。URL は写真の原寸の Blob の読み取り SAS（06 §2.1） |
| 応答の形 | Structured Outputs（`response_format: json_schema`、`strict: true`）。スキーマの名前とスキーマは呼び出し側が渡す（分類は `photo_classification`、識別は `photo_identification`、タイムラインの区切り案は `timeline_proposal`、文は `timeline_texts`） |
| トークン上限 | `max_completion_tokens`（`max_tokens` は送らない）。分類・識別は 4000、タイムラインの区切り案は `TIMELINE_PROPOSE_MAX_TOKENS`（4000）、文は `TIMELINE_WRITE_MAX_TOKENS`（16000。06 §8.4） |
| 送らないパラメータ | `temperature` |

応答が空・JSON として読めない場合は、AI の失敗として扱う。応答の中身の検証は呼び出し側が行う（06 §2.1・§3.1）。

`AZURE_OPENAI_ENDPOINT` があるのに送り先のデプロイ名が決まらない場合と、AI 識別サービスのクライアントを作れない設定
（API キーが無いなど、SDK がクライアントを作る時点で例外を投げる場合）は、設定の誤りとして AI 識別サービスへ要求を送らずに失敗する。
AI 識別サービスの障害とは扱わない（ワーカーは `lastError: "internal"` として数える。06 §2.1・§5）。
Terraform は `AZURE_OPENAI_DEPLOYMENT_NAME` を必ず設定する（`DEPLOYMENT.md` の「環境変数」）。

**要求の形を縛っている制約（なぜそうなっているか）**

- **推論モデルの制約**: トークン上限は `max_completion_tokens` で指定する（`max_tokens` を送ると 400 `Unsupported parameter`）。
  推論トークンもここから消費するため、値には余裕を持たせている。`temperature` は既定値 1 のみサポートで、それ以外を送ると 400 `Unsupported value` になるため送らない
- **strict モードの制約**: Structured Outputs の `strict: true` は、全プロパティを `required` に列挙し `additionalProperties: false` にすることを求める。
  そのため任意項目（識別の `name` / `description` / `characteristics` や、定義表の各項目）は `["string", "null"]` のように null 許容で表す。
  `minimum` / `maximum` / `maxItems` は使えないため、信頼度の範囲はサーバ側で検証する（範囲外は AI の失敗。06 §2.1・§3.1）
- **トークン節約**: 画像は `detail: "low"` で渡す
- モデル名は `AZURE_OPENAI_DEPLOYMENT_NAME` から取り、Terraform の `azurerm_cognitive_deployment.gpt6_luna`（`gpt-6-luna` / GlobalStandard SKU。2026-10-17 に `gpt-5.6-luna` から切り替え）と一致させる。
  `AZURE_OPENAI_ENDPOINT` も `AZURE_OPENAI_DEPLOYMENT_NAME` も無いときの既定値（OpenAI 公式 API へのフォールバック）は、コードの中で `gpt-5.6-luna` のまま

### 9.6 利用者が書く文の文字数と前後の空白

**実装済み**（#128。`api/src/utils/userText.ts` の `exceedsLength()`・`trimUserText()`。写真のコメントと場面のコメントの前後の U+0085 は #127）。

利用者がアプリで書く文の欄は、上限の文字数の数え方と、前後の空白の除き方を同じ規則で扱う。
各エンドポイントの検証の表にある「N 文字を超える」「前後の空白を除いて」は、この節の数え方と除き方を指す。

| 欄 | エンドポイント | 上限（既定。§4） | 前後の空白 |
|---|---|---|---|
| 旅行名 `name` | `POST /api/trips`・`PUT /api/trips/{tripId}`（§5.8・§5.11） | 100 | 除いて数え、除いて保存する |
| 説明 `description` | 同上 | 1000 | 除かない（そのまま数え、そのまま保存する） |
| 写真のコメント `comment` | `PATCH /api/photos/{photoId}`（§5.6） | 500 | 除く |
| タグの名前 `tags[].name` | 同上 | 30 | 除く |
| 手がかり `hint` | `POST /api/photos/{photoId}/process`（§5.7） | 500 | 除く |
| 場所 `placeName`（C-2。実装済み） | 同上 | 100 | 除く |
| 完成版の文 `title`・`summary`・`label`・`note` | `PATCH /api/trips/{tripId}/timeline/days/{date}`・`scenes/{photoId}`（§5.15） | 40・400・30・200 | 除く |
| 場面のコメント `sceneComments` の値 | `PUT /api/trips/{tripId}/timeline/draft/scenes`（§5.15） | 100 | 除く |

- **文字数は見た目の1文字（書記素。`Intl.Segmenter` の `grapheme`）を1と数える。** つないだ絵文字（👨‍👩‍👧 は UTF-16 で8単位）・国旗・サロゲートペアの文字も1文字。
  アプリの入力欄（Flutter の `maxLength`）と同じ数え方なので、入力欄が上限で止めた文はサーバでも上限を超えない（上限の値が同じとき。
  サーバの上限を環境変数で変えたときの差は `docs/09_backlog.md`「アプリの入力欄の上限の文字数が、サーバの環境変数と連動しない（Dart）」）。
  #128 より前は UTF-16 のコード単位（`String.length`）で数えていて、絵文字を含む文が入力欄では収まってもサーバで 400 になった
- **UTF-16 の長さにも上限がある。** 上限の文字数 × 32（UTF-16 のコード単位。`USER_TEXT_VALIDATION.MAX_UNITS_PER_CHARACTER`）を超える文は、見た目の文字数が上限以内でも、文字数の上限を超えたときと同じ 400 と `message` にする
  （例: 写真のコメントは 16,000 単位まで。超えると `コメントは500文字以内で指定してください`）。見た目の1文字には結合文字をいくらでも重ねられ、見た目の文字数だけでは文の大きさに上限が無くなるため
  （文書の大きさの上限や AI に渡す文の大きさ）。1文字が長い絵文字（肌の色を付けた家族の絵文字で 19 単位）を上限の文字数まで並べても、この上限には当たらない
- **前後の空白**は、JavaScript の `trim()` が除くもの（空白・タブ・改行・全角空白など）に U+0085（次の行）を足したもの。アプリの `trim()`（Dart）と同じ。
  前後の空白を除く欄は、除いた後の文で数え、除いた後の文を保存する
- 除いて空になった文（空白だけ・U+0085 だけ）の扱いは欄ごとに違い、各節に書いてある。旅行名は 400 `旅行名が指定されていません`、タグの名前は 400 `タグの名前は1〜30文字で指定してください`、
  写真のコメントと手がかりは `null`、場所は `null`（撮影地の地名を消す。§5.7）、完成版の文は AI が書いた文に戻す、場面のコメントは持たない
- 上限を超えたときの 400 の `message` は欄ごとに固定で、上限の値を埋め込む（各節）

**対象にしないもの**（利用者が書く文ではない）。文字数は UTF-16 のコード単位（`String.length`）で数え、空白の判定に U+0085 を含めない。

- 写真の送信の地名 `placeName`（`POST /api/photos`。端末が住所から作る。§5.1）。利用者が解析を頼むときに直す `placeName`（`process`。§5.7）は上の表のとおり対象にする
- 図鑑の項目の名前 `name`（`GET /api/catalog/entry` の引数。AI が付けた名前で引く。§5.14）
- AI が返す文: 識別の名前の検証（[06 §3.1](./06_processing_design.md#31-契約)）と、タイムラインの文の上限での切り詰め（[06 §8.3](./06_processing_design.md#83-文を書くstep-write)。見た目の1文字の途中では切らない）
