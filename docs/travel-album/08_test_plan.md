# 旅行アルバム テスト計画

## この文書の位置づけ

旅行アルバムの実装を TDD（CLAUDE.md「実装の進め方: TDD」）で進めるための、テストの方針・偽物の拡張・テストリストの元になるシナリオ・
手で確かめる項目を書く。原則は `.claude/test-principles.md`（古典学派）に従う。**未実装を含む目指す姿**で、
テストリストは List 段で各 PR のときにここから作る（この文書のシナリオをそのまま List にしてよい）。

API の契約は [05_api_design.md](./05_api_design.md)、画面の振る舞いは [03_screen_design.md](./03_screen_design.md)、
クエリと、単体テストで確かめられる範囲の限界は [04 §5](./04_data_design.md#5-クエリ) を参照する。

この文書の「偽物」は、テストで Cosmos DB・Blob Storage・Storage Queue の代わりに使う、状態を持つ差し替え部品のこと
（`api/tests/fakes/`。CLAUDE.md「偽物は `tests/fakes/` に置く」と同じ用語）。

---

## 1. 方針

| 原則 | この機能での適用 |
|---|---|
| 依存の種類でモックを決める | Cosmos DB・Blob Storage・Storage Queue は管理下にある依存 → 状態持ちの偽物（`tests/fakes/`）で差し替え、**やり取りは検証しない**。結果は `documents` / `store` / `messages` の中身で確かめる。Azure OpenAI・Azure Maps は管理外 → モックして呼び出しも検証してよい |
| 観察可能な振る舞いだけ | ハンドラはレスポンス（ステータス・`code`・`message`・`data`）と、偽物の状態。サービスは戻り値と偽物の状態 |
| `details` は固定しない | 付くか付かないかを確かめるのは可。文言を `toEqual` で固定しない |
| エラーの注入は実 SDK の形で | Cosmos: `{ code: 404 }` / `{ code: 409 }` / `{ code: 412 }`、`ENOTFOUND` は `cause` を持つ形も。Blob: `name: 'RestError'`・`statusCode`・`code`。OpenAI: 既存の3段の `cause`（CLAUDE.md「テストの流儀」の表） |
| 偽物はファイル内で再定義しない | `tests/fakes/cosmos.ts`・`blob.ts`・（段階3）`queue.ts` だけが実体 |
| SAS は例外として引数を見る | 署名は復号できないので、権限（read のみ）・`expiresOn`・`startsOn` は `generateBlobSASQueryParameters` の引数をリテラルで検証する（原則3の例外。コメントに理由を書く）。時刻は偽のタイマーで固定 |
| 環境変数を消すときは `delete` | `process.env.X = undefined` は文字列 `"undefined"` になる |
| テスト名は日本語の文 | 既存と同じ |

ディレクトリは `src/` をミラーする: `tests/functions/trips.test.ts`・`tripDetail.test.ts`・`photos.test.ts`（`photos.ts` の POST）・`photoList.test.ts`（`photos.ts` の GET。PR 4a-2 で分けた）・`photoDetail.test.ts`（`photoDetail.ts` の GET・DELETE）・`photoUpdate.test.ts`（`photoDetail.ts` の PATCH。PR 4b で分けた）・`photoMove.test.ts`、
`tests/services/albumService.test.ts`・`photoStorageService.test.ts`、`tests/utils/blobSas.test.ts`・`errors.test.ts`（`isConnectivityError`）。

## 2. テスト用の差し替え部品の拡張

### 2.1 `tests/fakes/cosmos.ts`

| 拡張 | 中身 | 理由 |
|---|---|---|
| `query` の絞り込み | `@type`・`@tripId`（`tripId` が値と厳密に等しいものだけ。未所属は `@tripId = null` で、`tripId` が `null` のものだけ。項目が無いものは含めない。SQL の null の比較自体は手で確かめる。§5.2）・`@category`（`category` の一致）・`@kind`・`@name`（`identification.kind` / `identification.name`。`@kind` だけなら `matchesKind: true` のものに絞る）のパラメータで絞る。`@name`（`plants` の名前）・`@imagePath` は残す（`type` で使い分ける） | サービスはこれらを必ずパラメータで渡す（[04 §5](./04_data_design.md#5-クエリ)）。SQL 文字列は見ない |
| `query` のページ | `fetchNext()` が `maxItemCount` 件ずつ返し、続きがあれば `continuationToken`（偽物では挿入順の位置を表す文字列）を返す。同じトークンを渡すと続きから返す。`fetchAll()` も残す | 写真一覧のページの切れ目とトークンの受け渡し（[04 §5.3](./04_data_design.md#53-旅行の写真一覧)）。`ORDER BY` は解釈しないので、**並び順は挿入順になる**（並びそのものは手で確かめる。§5.2） |
| 集計クエリ | `COUNT` / `MIN` / `MAX` / `GROUP BY` / `TOP 1 … ORDER BY` は偽物では解釈できない。集計の SQL は `services/albumQueries.ts` に集め（SQL 文字列とパラメータの組み立てだけの薄い層。取るに足らないコードとしてテストしない）、集計の行から `TripSummary` / `CatalogEntry` を組み立てる所は純粋関数（`services/tripSummaries.ts` など）に分け、行を直接渡して単体で確かめる（`albumQueries` を差し替えない。PR 3 で決めた）。SQL 自体は手で確かめる（§5.2・§5.3） | 偽物に SQL の解釈を持ち込まない（CLAUDE.md「偽物は Cosmos SQL を解釈しない」）。集計の行から応答を組み立てる所は単体で確かめられる |
| `create` の 409 | 同じ `id` があれば `{ code: 409 }` のエラーを投げる（実 SDK の `Conflict`） | 写真の冪等性は `create` の 409 で成り立つ |
| `item().patch(body, options)` | `body` が配列か `{ operations, condition }` の両方を受け、`set` / `replace` / `remove` を `path`（`/tripId` のような1段と `/processing/state` のような2段）に適用する。`id !== partitionKey` か無ければ `{ code: 404 }`。`condition` はこの設計で使う2つの形（`FROM c WHERE c.processing.state = "<値>"` と `FROM c WHERE IS_NULL(c.<path>) OR c.<path> = "<値>"`）だけを解釈し、満たさなければ `{ code: 412 }`。**それ以外の形は例外にする**（知らない条件を黙って通さない） | move・PATCH・旅行の削除（未所属へ戻す）・ワーカー（担当の条件付き patch、コメントの条件付き patch。[04 §7.4](./04_data_design.md#74-ワーカーの書き込みの決まり)）が使う。条件が実環境で意図どおりかは手で確かめる（§5.3） |
| `FakeCosmosDocument` の緩和 | `name` / `imagePath` を必須にしない（`{ id: string; type?: string; … }`）。`FakeCosmosBackend<TDoc>` の既定の型に `Trip | Photo` を足す | 旅行・写真は `name` / `imagePath` を持たない |
| 挿入順の維持 | そのまま。テストは期待する並びの順に挿入し、ページの切れ目を確かめる | `ORDER BY` を解釈しないため |

`_etag` と `accessCondition` の対応は足さない（ワーカーは `_etag` の条件を使わない。[04 §7.4](./04_data_design.md#74-ワーカーの書き込みの決まり)）。`incr` も足さない（カウンタの文書を置かない。[06 §6](./06_processing_design.md#6-費用の抑え方)）。

### 2.2 `tests/fakes/blob.ts`

`store` のキーは `photos/<blobName>`。原寸とサムネイルは同じ `photos` コンテナなので `forcedUploadErrorByContainer` では区別できず、「原寸は成功しサムネイルで失敗」は Blob 名ごとの失敗（`forcedUploadErrorByKey`。PR 4a-1 で足す）で作る。
`TEST_BLOB_HOST` で SAS 付き URL のホストを固定できる。

### 2.3 `tests/fakes/queue.ts`（段階3）

`FakeQueueBackend { messages: string[]; forcedSendError?: Error }` と `createFakeQueueClient()`。`sendMessage(text)` は `messages` に積む。
投入されたかは `messages` の中身（JSON を parse して `photoId`）で確かめ、呼び出しは検証しない。
`forcedSendError` で「投入に失敗しても応答は成功で、写真は `pending` のまま」（[04 §7.1](./04_data_design.md#71-操作ごとの表)）を作る。

### 2.4 `mobile/test/`

| 偽物 | 使い方 |
|---|---|
| `MockClient`（`package:http/testing.dart`） | `ApiService` の新メソッドと `UploadQueue`。メソッドとパスが一致したときだけ応答し、それ以外は 404。`content-type: application/json` を付ける |
| `image_picker_platform_interface` の偽物 | `pickMultiImage()` の差し替え（既存の `camera_screen_test.dart` と同じ形） |
| 小さな JPEG の資産 | EXIF（撮影日時・GPS あり/なし）を持つ数 KB の JPEG を `test/assets/` に置き、EXIF の読み取りとハッシュの固定値に使う |
| `Geocoder` | `geocoding` の `GeocodingPlatform` を差し替える（可能か要確認。できなければ `UploadQueue` に `reverseGeocode` の関数を注入する） |

## 3. 段階2のシナリオ一覧（api）

**テストリストの元。** 各 PR の List 段でここから選び、1つずつ Red → Green → Refactor。

### 3.1 `utils/errors.ts` — `isConnectivityError()`

- `ENOTFOUND` / `ECONNREFUSED` をトップレベルの `code` に持つエラーで真（`it.each`）
- 2段奥の `cause` に持つエラーでも真
- `code` が無いエラー、`404` のエラーで偽

### 3.2 `utils/blobSas.ts`

- 読み取りのみの権限、発行から 60 分の `expiresOn`、5 分前の `startsOn` で署名する。**実 SDK で作ったトークンの `sp`・`se`・`st`・`sr` を `URLSearchParams` で読んで確かめる**（`sig` 以外は平文。引数を見る原則3の例外を使わずに済む。PR 4a-1 で決めた）。`startsOn` は `generateReadSasUrl()` の引数で、写真の側（`PhotoStorageService`）が渡し、一時画像の SAS は渡さない（既存の `upload` の振る舞いを変えない）
- `PHOTO_SAS_EXPIRY_MINUTES` に正の整数を設定すると期限が変わる。読めない値なら 60
- URL の形が `https://<host>/<container>/<blob>?<sas>` になる
- `urlExpiresAt` が `expiresOn` と同じ ISO 文字列になる
- 切り出し後も `storageService.test.ts` が全部通る（既存の `upload` の振る舞いを変えない）

### 3.3 `services/albumService.ts`

旅行:
- 作成すると `type: "trip"`・`tags: []`・`description: null`・同じ `createdAt` / `updatedAt` で保存される。`name` の前後の空白が除かれる
- 一覧: 写真が無い旅行は `photoCount: 0`・期間 null・表紙 null（並び順 `createdAt` 降順は SQL なので手で確かめる。§5.2）
- 集計（`tripSummaries.ts` に行を直接渡して）: 枚数の行 `{ tripId, photoCount }` と期間の行 `{ tripId, firstTakenAt, lastTakenAt }` と表紙の `TOP 1` の結果から、各旅行の `TripSummary` が組み立てられる
  （`tripSummaries.test.ts` は枚数と期間の行だけを渡す。表紙の URL は `buildTripSummaries()` の第4引数で、PR 4a-2 では
  `queryCover()` の結果を偽物が挿入順の先頭で返すことを使い、ハンドラのテスト（`trips.test.ts`・`tripDetail.test.ts`）で確かめた）。
  期間の行が無い旅行（撮影日時のある写真が無い）は `firstTakenAt` / `lastTakenAt` が `null`
- 未所属の枚数: 枚数の行のうち `tripId` が `null` の行の `photoCount` が `unassignedPhotoCount` になる（旅行の一覧に無い id の行は数えない）
- 表紙はサムネイルが無ければ原寸
- 更新は `name`・`description`・`updatedAt` だけ変わり、`tags`・`createdAt` は変わらない
- 削除（写真も消す）: 中の写真のドキュメントと Blob（原寸・サムネイル）を消してから旅行を消し、`deletedPhotoCount` に枚数、`detachedPhotoCount` に 0 を返す
- 削除（写真は残す）: 中の写真の `tripId` が `null` になり `updatedAt` が更新され、Blob の `store` は変わらない。旅行は消え、`detachedPhotoCount` に枚数、`deletedPhotoCount` に 0 を返す
- 削除（写真も消す）で Blob の削除に失敗しても旅行と写真のドキュメントは消え、枚数を返す
- 削除で写真のドキュメントの削除（または patch）に失敗すると例外になり、旅行は残る（済んだ分はそのまま）
- 削除が読んだ射影に無かった写真（削除と重なって届いたもの）は消さない: 射影を読んだ後に同じ旅行を指す写真を偽物に足しても、`deletePhotos=true` でその写真は消えず残る（`tripId` もそのまま。未所属に戻すのは段階3の掃除のタイマー。[04 §7.3](./04_data_design.md#73-旅行の削除と重なった送信move)）

PR 4b では、旅行の削除・move・PATCH をサービスではなくハンドラのテスト（`tripDetail.test.ts`・`photoMove.test.ts`・`photoUpdate.test.ts`）で確かめた（`albumService.test.ts` には足していない）。
上の旅行の削除の項目のうち、「射影に無かった写真は消さない」と「途中で失敗したとき済んだ分はそのまま」はテストが無い（失敗の注入は全部の写真の操作に効くので、1枚目で止まり何も変わらない形だけを確かめている）。

写真:
- 作成すると `type: "photo"`・`tripId: null`（指定なし）・`category: null`・`tags: []`・`processing.state: "none"`・全項目が揃って保存される（**`tripId` キーが存在して `null`**）
- `takenAt` があれば `takenAtSource: "exif"`、無ければ `"none"`
- `sortAt`: `takenAt` があればそれと同じ。無ければ `uploadedAt` を日本時間に直した TZ 無しの文字列（例: `uploadedAt` が `2026-10-10T03:12:45.000Z` なら `2026-10-10T12:12:45`。日付をまたぐ例 `2026-10-10T20:00:00.000Z` → `2026-10-11T05:00:00` も1本）
- 緯度・経度・地名から `location` が組み立てられ、無ければ `null`
- 既に同じ id があれば既存を返し、Blob の `store` は変わらない
- Blob（原寸→サムネイル）が `store` に入ってからドキュメントが作られる（サムネイルで失敗すると原寸は残りドキュメントは無い）
- `create` が 409 を返したら既存を読んで返す
- 一覧: `@tripId` に旅行の id を渡すとその旅行の写真だけ
- 未所属: `tripId` が `null` の写真だけが返り、旅行の写真も、存在しない旅行を指す写真も返らない
  （偽物はパラメータの規則で絞るだけなので、SQL の null の比較自体は手で確かめる。§5.2）
- ページ: 3 枚の旅行で `limit: 2` なら 2 枚と `continuationToken`、そのトークンで残り 1 枚と `continuationToken: null`。`limit` を渡さなければ既定の 100。`ORDER BY c.sortAt` の並びそのものは手で確かめる（§5.2）
- 応答の Photo に `imageUrl` / `thumbnailUrl`・`sortAt`・`category` があり、`blobName` / `thumbnailBlobName` / `type` / `_rid` などが無い
- サムネイルが無い写真は `thumbnailUrl: null`
- 削除（`deletePhoto`）はドキュメントだけを消し、消したドキュメントを返す（原寸・サムネイルの Blob はハンドラが消す。§3.6）。無ければ、または読んだ後・消す前に消されていたら（404）`null`
- move: 指定した id の `tripId` が変わり `updatedAt` が更新される。`null` で外せる。無い id は `notFound` に入り残りは動く。他の項目（`comment` など）は変わらない
- PATCH: `comment` を保存して `commentSource: "user"`、`null` で消して `commentSource: null`。`tags` は置き換わり、重複は除かれる。`category`・`identification`・`processing` は変わらない（解析中の写真でも通る）

### 3.4 `functions/trips.ts` / `tripDetail.ts`

- `POST`: 201 で `data.trip` が返る。[05 §5.8](./05_api_design.md#58-post-apitrips) の 1〜7 の各検証（順序を含む。例: `name` が数値で `description` も数値なら `旅行名は文字列で指定してください`）。`description` が `null`・未指定・空文字は通り `null` で保存
- `GET /api/trips`: `data.trips`・`total`・`unassignedPhotoCount`。0 件で `[]`・`0`・`0`。
  表紙は旅行ごとにその旅行の先頭の写真のサムネイル、写真の無い旅行は `null`（写真が無ければ Blob の設定が無くても 200）
- `GET /api/trips/{tripId}`: 400（形式）・404 `TRIP_NOT_FOUND`（同じ id の写真しか無いときも）・200 で集計付き。表紙は先頭の写真のサムネイル、無ければ原寸
- `PUT`: 形式 → ボディの順で検証。404。200 で更新後の旅行。`tags` が変わらない
- `DELETE`: [05 §5.12](./05_api_design.md#512-delete-apitripstripiddeletephotostruefalse) の 1〜4 の各検証（`deletePhotos` 無しで 400、`yes` で 400）。404。
  `deletePhotos=true` で 200・`deletedPhotoCount`、偽物の `documents` から写真と旅行が消え、`store` から Blob が消える。
  `deletePhotos=false` で 200・`detachedPhotoCount`、写真は `tripId: null` で残り、`store` は変わらない。
  `deletePhotos` が `TRUE`・空文字で 400、無い旅行に `deletePhotos` を付け忘れると 400（検証が 404 より先）。同じ id のドキュメントが写真だけなら 404。
  画像の削除に失敗しても 200 で写真と旅行の文書は消える。写真の無い旅行はどちらを選んでも 0 枚で消える。結果の揃わない空のページが挟まっても全部処理する。
  最後の旅行の削除が 404 でも 200。旅行の読み取り・射影・写真の patch・写真の削除のどこで失敗しても 503 / 500 で、旅行は残る
- 各エンドポイントの 503 `DATABASE_ERROR`（`it.each(['ENOTFOUND', 'ECONNREFUSED'])`。`cause` の奥に持つ形も1本）と 500 の `message`

### 3.5 `functions/photos.ts`

`POST`:
- 201 で `data.photo` と `data.urlExpiresAt`。`imageUrl` が `https://<TEST_BLOB_HOST>/photos/<id>.jpg?` で始まる
- [05 §5.1](./05_api_design.md#51-post-apiphotos) の 1〜18 の各検証（順序を含む。例: `photoId` が不正で `image` も無ければ `写真IDの形式が無効です`）
- **`image` の SHA-256 が `photoId` と一致しないと 400 で、Blob も Cosmos も触らない**
- `photoId` が大文字の16進なら 400（小文字のみ）
- `tripId` 付きで旅行が無ければ 404 で、Blob も Cosmos も変わらない
- 既存の id を送ると 200 で既存の写真が返り、Blob は上書きされない（`store` の内容が送ったものと違うまま）
- `tripId` 付きで再送した既存（`tripId: null`）の写真は 200 で `tripId: null` のまま
- サムネイル無しで 201、`thumbnailUrl: null`
- 検証がすべて Blob の `store` と Cosmos の `documents` を変えずに終わる（1 本は明示的に確かめる）
- Blob の失敗で 502 `STORAGE_ERROR`（`RestError` の形）と 503（`it.each` の 3 code）。ドキュメントは作られない
- Cosmos の接続失敗で 503 `DATABASE_ERROR`。500 の `message`

`GET`:
- `tripId` 無しで 400 `絞り込み条件を指定してください`。`tripId=abc`・`tripId=`（空）で 400。`limit` が `0` / `201` / `-1` / `abc` / `1.5` / `01` / `1e2` / `0x10`・前に空白・空で 400。`continuationToken=`（空）で 400。
  どれも Cosmos に触る前に返す。無い旅行で 404（その旅行を指す写真が残っていても）
- `tripId=<uuid>` でその旅行の写真だけ、`tripId=none` で未所属（`tripId: null`）だけ（消えた旅行を指す写真・`tripId` の項目が無い写真は返らない）
- `limit=2` で 2 枚と `continuationToken`、同じトークンを渡すと続き、最後は `continuationToken: null`。`total` は無い。`limit` の 1 と 200 は通る
- 旅行はあるが写真が無ければ 200 で `photos: []`・`continuationToken: null`
- Cosmos が受け付けないトークンで 400 `継続トークンの形式が無効です`。トークンを渡していない要求での Cosmos の 400 は 500。トークンを渡していても接続できない障害は 503
- 旅行の確認・一覧のクエリのどちらで失敗しても、503 `DATABASE_ERROR` / 500 `写真一覧の取得に失敗しました`
- `urlExpiresAt` が返る。Photo は項目が完全一致（`blobName` / `type` / `_rid` などが無い）

### 3.6 `functions/photoDetail.ts`

- `GET`: 400（形式）・404 `PHOTO_NOT_FOUND`・200
- `DELETE`: 400・404・200 `写真が正常に削除されました`。`store` から原寸とサムネイルが消え、別の写真は残る。サムネイルの無い写真は原寸だけ消える。
  Blob の削除失敗でも 200 で、原寸で失敗してもサムネイルは消える。Cosmos の読み取り・削除の失敗（503 / 500）と、読んだ後・消す前に消されていた（404）ときは、ドキュメントも画像も変わらない
- `PATCH`（`photoUpdate.test.ts`）: [05 §5.6](./05_api_design.md#56-patch-apiphotosphotoid) の 1〜10 の各検証（順序の例を含む）。`comment` だけ・`tags` だけ（両方を送る正常系のテストは無い）。既存の `category` が変わらない。前後の空白を除いて空の `comment` は `null`。
  コメント 500 文字・タグ 30 文字は前後の空白を除いて数える（ちょうどなら通る）。前後の空白を除くと同じになるタグは1つにまとめる。解析中（`pending`）の写真でも通る。patch の失敗で 503 / 500

### 3.7 `functions/photoMove.ts`

- [05 §5.5](./05_api_design.md#55-post-apiphotosmove) の 1〜9 の各検証。201 件で 400。`tripId` のキーが無いと 400、`null` なら通る
- 2 枚を旅行に入れると `moved` に 2 つ、`documents` の `tripId` が変わる
- `null` で外すと `tripId: null` になる
- 一部が無いと `notFound` に入り、残りは動く
- 重複した id は 1 回だけ数える
- 無い旅行で 404。偽物の状態が変わらない
- 既にその旅行にある写真も `moved` に入る。移した写真は `tripId`・`updatedAt` 以外が変わらない
- 旅行の確認・写真の patch の失敗で 503 / 500（`photoMove.test.ts` は1枚目で止まり何も変わらない形だけを確かめる。途中まで移った状態はテストが無い）

### 3.8 `response.ts` の拡張

- `createNotFoundError(message, ErrorCode.TRIP_NOT_FOUND)` で 404・`TRIP_NOT_FOUND`・渡した `message` になる（`tests/utils/response.test.ts`。実装済み）
- `code` は必須で既定値が無い（型で強制されるのでテストは書かない。[05 §7.1](./05_api_design.md#71-エラーコード一覧追加分)）

### 3.9 段階3・4で足すシナリオ（骨格）

整合性の表（[04 §7](./04_data_design.md#7-整合性途中で失敗したら何が残るか)）の「直り方」が成り立つことを、偽物の状態で確かめる。

- `process`: 写真に `pending`・`step`・`hint`・`attempts: 0` が書かれ（`failed`・`attempts: 3` の写真でも）、`comment` / `commentSource` が `null` になり、`messages` に `{ photoId }` が積まれる。**投入に失敗しても 202** で写真は `pending` のまま。`tags`・`tripId` は変わらない
- ワーカー（分類）: `category` が書かれ、`classification` が書かれ、`identification` が `null` になる。`tags`・`comment`・`tripId` は変わらない。識別対象なら `pending`・`step: "identify"` で `messages` に積まれ、投入に失敗しても写真はそのまま。`other` なら `done`
- ワーカー（識別）: `identification` が `{ kind, matchesKind, name（trim 済み）, … }` で書かれ、`done`。`matchesKind: false` なら `name: null` で `comment` は変わらない
- ワーカーは `commentSource: "user"` の `comment` を書き換えず、`identification`・`processing` は書く（コメントの条件付き patch が 412 でも結果の patch に進む）。`commentSource` が `null` / `"ai"` なら書く
- ワーカーが読んだ後に利用者が `tags`・`tripId` を変えても（偽物の文書を途中で書き換える）、結果の patch で利用者の変更が残る
- ワーカーは `state` が `pending` でない写真（担当の条件付き patch が 412。古い重複メッセージ）には何もしない。`done` / `failed` / `none` でも何もしない
- タイマー（再投入）: 10 分以上更新されていない `pending` / `classifying` / `identifying` の写真が `{ photoId }` で積まれ、`attempts` が上限なら `failed` になる。**`failed` と `none` は拾わない**（`failed` の写真は何度タイマーが走っても `messages` に積まれない）
- 掃除のタイマー: 文書の無い Blob のうち1日より古いものだけが `store` から消え、新しいものと文書のある Blob は残る。存在しない旅行を指す写真が `tripId: null` になる（消えない）。Blob の無い文書は消えない
- 図鑑のまとめ（組み立ての純粋関数に行を直接渡して）: 枚数の行 `{ name, photoCount }` と項目ごとの `TOP 1` の結果から `CatalogEntry` が組み立てられ、名前の文字列順に並ぶ
- 図鑑の API（形は案。段階4の詳しい設計で決める。[05 §5.14](./05_api_design.md#514-図鑑段階4)）: `kind` 無効で 400。該当する写真が無いときの応答、`name` の渡し方、ページの方式は決まってから書く
- 移行スクリプト: 2 回流して `documents` の件数が変わらない。`imagePath` の Blob が無い植物は飛ばして一覧に出る。写真の `category` が `"plant"`、`tags` が `[]`、`identification.kind` が `"plant"` で `model: "migration"`、`sortAt` が `uploadedAt` を日本時間に直したもの

## 4. 段階2のシナリオ一覧（mobile）

### 4.1 `services/api_service_test.dart`

[05 §8](./05_api_design.md#8-クライアントmobilelibservicesapi_servicedartに足すメソッド) の各メソッドについて、既存と同じ形で:
- 封筒の `data` を剥がして型に変換できる（宛先のメソッドとパスが一致したときだけ応答する）
- 非 2xx で `ApiException` になり、`code`・`message` が入る（`TRIP_NOT_FOUND` → `isTripNotFound`）
- `uploadPhoto` が multipart で `photoId`・`image`・`thumbnail`・`tripId`・`takenAt`・`latitude`・`longitude`・`placeName` を送る（送る内容は管理外ではないが、サーバとの契約なので `MockClient` が受けたリクエストの中身で確かめる）。`tripId` 無しなら `tripId` パートを送らない。201 と 200 を区別して返す
- `movePhotos` が `tripId: null` を JSON の `null` で送る（キーを省かない）
- `deleteTrip` が `deletePhotos=true` / `false` をクエリに必ず載せる。`getPhotos` が `continuationToken` を URL エンコードして載せ、応答の `continuationToken`（`null` を含む）を返す

### 4.2 `services/photo_metadata_test.dart`

- 既知のバイト列の SHA-256 が固定値（小文字16進 64 文字）になる
- EXIF ありの JPEG から `takenAt` が `YYYY-MM-DDTHH:mm:ss` で読める。GPS から緯度・経度（南緯・西経の符号を含む）
- EXIF なしの JPEG で `takenAt: null`・位置情報 null
- サムネイルが長辺 320px 以下の JPEG になる

### 4.3 `services/upload_queue_test.dart`（`MockClient` + `fakeAsync`）

- 3 枚を入れると同時に 2 本までしか送らない
- 201 で完了に数え、進み具合（完了数/全体）が更新される
- 200 で応答の `tripId` が宛先と違えば「送信済み（別の場所）」に数える
- 0 / 429 / 503 で 2 → 4 → 8 秒の間隔で 3 回送り直し、4 回目は失敗にする
- 400 / 413 / 500 / 502 は送り直さず失敗にする
- 404 `TRIP_NOT_FOUND` で同じ宛先の残りも失敗にする
- 「送り直す」で失敗した項目だけが再び送られる。「閉じる」で消える
- 全部完了すると完了の通知が 1 回出る（`ChangeNotifier` の通知回数ではなく、完了の状態で確かめる）
- 地名の変換が失敗しても `placeName: null` で送る

### 4.4 画面（`screens/*_test.dart`）

表示サイズを実機に合わせ（CLAUDE.md「mobile/」の注意点）、`ensureVisible()` の後に `pump` する。

- 旅行一覧: 一覧・0 件・失敗・再試行の表示。先頭の行の枚数（`unassignedPhotoCount`）。旅行を作るダイアログの検証（空の旅行名）と成功後の再読み込み
- 旅行詳細: 一覧・0 件・失敗。404 で「この旅行は削除されています」。削除ダイアログの文言に枚数が入り、既定が「写真は残す」で、選んだ方が `deletePhotos` に載る（`MockClient` が受けたクエリ）。0 枚なら選択肢が無い。削除成功で戻る。削除失敗で留まる
- ページ: 1 ページ目の応答に `continuationToken` があれば下端で 2 ページ目を取り、`null` なら取らない。下に引っ張ると先頭から取り直す
- 未所属: 「旅行から外す」が無い
- 写真ビューア: 撮影日時・地名・緯度経度・なしの表示。削除で次の写真へ、最後なら戻る
- `PhotoGrid`: 長押しで選択モード、タップで切り替え、「すべて選択」、「×」で解除。操作ボタンは 0 枚で押せない
- 旅行に入れる: 旅行を選ぶダイアログに今の旅行が出ない。成功のスナックバーに枚数と旅行名。`notFound` があれば文言が足される。200 件を超えると分けて送られる（`MockClient` が受けた回数と中身）
- 削除（複数）: 1 枚ずつ送られ、404 は成功に数える

## 5. 単体テストで確かめられず手で確かめる項目

### 5.1 実機（SC-03K、段階2）

| 順 | 確かめること | 手順 | 崩れたときの症状 |
|---|---|---|---|
| 1 | **ハッシュの決定性**（最初に） | 同じ写真をギャラリーから 2 回選び、`photoId` が一致するか。一致しなければ縮小なしに切り替える | 同じ写真が 2 枚入る |
| 2 | `pickMultiImage` での EXIF と向き | 複数選択した写真の撮影日時・位置情報が読め、表示の向きが正しい | 日時なし・横倒し |
| 3 | 端末の Geocoder | 位置情報のある写真で市区町村まで出るか。機内モードで `null` になり送信が止まらないか | 地名が出ない・送信が止まる |
| 4 | SAS で表示できる | 旅行詳細のサムネイルと原寸が出る。61 分放置して 403 になった後、下に引っ張れば復帰する | 画像が出ない |
| 5 | 300 枚の送信 | 完走する時間、失敗の枚数、電池。画面を移っても続く。結果を `docs/09_backlog.md` に記録 | 途中で止まる |
| 6 | 300 枚の move | `POST /api/photos/move` を 200 + 100 件で。Cosmos の 429 が出ても 5 分に収まるか | 500・タイムアウト |
| 7 | 100 枚の出し入れ | 旅行に入れる → 外す → 別の旅行に入れる。未所属の枚数が合う | 枚数がずれる |
| 8 | 旅行の削除 | 「写真も削除する」で写真と Blob が消える（ポータルで `photos` を確認）。「写真は残す」で写真が「旅行に属さない写真」に移り Blob が残る | Blob が残る・写真が消える |
| 9 | ページ | 300 枚の旅行で下までスクロールし、重複・欠落なく 300 枚出る。撮影日時の無い写真がアップロード日時の位置にある | 二重に出る・抜ける |

### 5.2 デプロイ後（API、段階2）

| 確かめること | 手順 | 崩れたときの症状 |
|---|---|---|
| `c.tripId = @tripId`（`@tripId = null`）の絞り込み | `GET /api/photos?tripId=none` が未所属だけを返し、旅行の写真が混ざらない | 一覧が空か混ざる |
| `GROUP BY` の集計（旅行一覧） | `GET /api/trips` の `photoCount`・期間・表紙・`unassignedPhotoCount` が実際の写真と合う。`tripId` が `null` の写真が `unassignedPhotoCount` に数えられる（`null` の鍵がグループになるか）。撮影日時の無い写真があっても期間が `null` にならない | 枚数ずれ・未所属が 0・期間が `null` |
| `ORDER BY c.sortAt` とページ | `GET /api/photos?tripId=…&limit=50` を `continuationToken` でめくり、撮影日時順で重複・欠落が無い。撮影日時の無い写真がアップロード日時（日本時間）の位置にある。別の `tripId` のトークンを渡すと 400。トークンの大きさの上限（2KB）でも 300 枚をめくり切れる | 順が崩れる・二重に出る・抜ける |
| 表紙の `TOP 1 … ORDER BY c.sortAt` | `GET /api/trips` と `GET /api/trips/{tripId}` の `coverThumbnailUrl` が、その旅行の撮影日時で最初の写真のサムネイル（無ければ原寸）を指す | 別の写真が表紙になる |
| 旅行一覧の並び | 新しく作った旅行が先頭 | 古いのが先頭 |
| `/api/photos/move` のルート | `POST /api/photos/move` が 200 で `moved` を返す（400 `写真IDの形式が無効です` なら `{photoId}` に取られている） | move が 400 |
| 応答に `_rid` などが出ない | `GET /api/photos/{photoId}` の JSON を目で見る | 余分なキー |
| ライフサイクル | `temp-images` に Blob を置いて 2 日後に消えている。`photos`・`images`・`azure-webjobs-*` が消えていない | 消えない・消えすぎ |
| 関数の登録 | ポータルの「関数」に、旅行の `listTrips`・`createTrip`・`getTrip`・`updateTrip`・`deleteTrip`（`app.http` の第1引数。ファイル名ではない）と、写真の `listPhotos`・`createPhoto`・`getPhoto`・`deletePhoto`・`updatePhoto`・`movePhotos` がある | 404（`app.ts` の import 忘れ） |

### 5.3 段階3・4で足すもの

- `c.category = @category` の絞り込み、タイマーの再投入クエリ（**`failed` の写真が拾われない**こと）、図鑑の `GROUP BY c.identification.name` と `c.identification.kind` の絞り込み、複合インデックスでの `TOP 1 … ORDER BY confidence DESC, at DESC`（[04 §5](./04_data_design.md#5-クエリ)）
- Patch の `condition`: 写真にコメントを書いてからやり直しを頼み、結果でコメントが置き換わる（受付で消しているため）。写真を送った直後（自動の解析中）にコメントを書き、解析が終わっても利用者のコメントが残る。解析中にタグ・旅行を変えても結果と両方残る
- 永遠に回り続けないこと: AI が必ず失敗する入力（例: 分類のスキーマ検証に通らない応答を返すモック、または壊れた画像）で 3 回失敗した写真が `failed` になり、タイマーが 10 分×数回走っても再投入されない。「やり直す」でもう一度 3 回だけ試す
- キューの直列化（`batchSize: 1`）と poison の挙動（3 回失敗したメッセージが `photo-processing-poison` に落ち、写真は `failed` になってアプリに「やり直す」が出る。poison の中身には触らない。[06 §5](./06_processing_design.md#5-失敗と再試行のまとめ)）
- 10 枚のトークン使用量の実測（[06 §6](./06_processing_design.md#6-費用の抑え方)）。容量は今のまま（150）でよく、下げるかの判断材料にする
- 図鑑の1種類の1ページを開く RU と時間の実測（識別済みの枚数・項目の数と一緒に `docs/09_backlog.md` へ。[04 §3.1](./04_data_design.md#31-項目は写真からまとめる) の見積もりと比べる）
- 掃除のタイマー: `photos` に文書の無い Blob を手で置き、翌日消えている。文書のある Blob と、置いたばかりの Blob は残る
- 旅行の削除中に送信: 数百枚の旅行の削除を押した直後に同じ旅行へ送信し、残った写真が消えておらず（ポータルで文書と Blob を確認）、掃除のタイマーの翌日に未所属に出る（[04 §7.3](./04_data_design.md#73-旅行の削除と重なった送信move)）
- 移行スクリプトの冪等性（2 回流して件数が変わらない）。実環境でしか分からない「`imagePath` の Blob が無い植物」の一覧

CLAUDE.md の「Cosmos のクエリを変更したら手で確認する」の表に、5.2 の該当行を足す。
