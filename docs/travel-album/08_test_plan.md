# 旅行アルバム テスト計画

## この文書の位置づけ

旅行アルバムの実装を TDD（CLAUDE.md「実装の進め方: TDD」）で進めるための、テストの方針・偽物の拡張・テストリストの元になるシナリオ・
手で確かめる項目を書く。原則は `.claude/test-principles.md`（古典学派）に従う。**未実装を含む目指す姿**で、
テストリストは List 段で各 PR のときにここから作る（この文書のシナリオをそのまま List にしてよい）。

API の契約は [05_api_design.md](./05_api_design.md)、画面の振る舞いは [03_screen_design.md](./03_screen_design.md)、
クエリと偽物の限界は [04 §5](./04_data_design.md#5-クエリ) を参照する。

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

ディレクトリは `src/` をミラーする: `tests/functions/trips.test.ts`・`tripDetail.test.ts`・`photos.test.ts`・`photoDetail.test.ts`・`photoMove.test.ts`、
`tests/services/albumService.test.ts`・`photoStorageService.test.ts`、`tests/utils/blobSas.test.ts`・`errors.test.ts`（`isConnectivityError`）。

## 2. 偽物の拡張

### 2.1 `tests/fakes/cosmos.ts`

| 拡張 | 中身 | 理由 |
|---|---|---|
| `query` の絞り込み | `@type`・`@tripId`（**値が `null` のときは `tripId === null` のものに絞る**）・`@tag`（`tags.includes`）・`@entryId`・`@kind` のパラメータで絞る。`@name`・`@imagePath` は残す | サービスはこれらを必ずパラメータで渡す（[04 §5](./04_data_design.md#5-クエリ)）。SQL 文字列は見ない |
| `create` の 409 | 同じ `id` があれば `{ code: 409 }` のエラーを投げる（実 SDK の `Conflict`） | 写真と項目の冪等性は `create` の 409 で成り立つ |
| `item().patch(body)` | `body` が配列か `{ operations, condition }` の両方を受け、`set` / `replace` / `remove` を `path`（`/tripId` のような1段と `/processing/state` のような2段）に適用する。`id !== partitionKey` か無ければ `{ code: 404 }` | move・PATCH・ワーカーが使う |
| `replace` の `_etag` 条件 | `options.accessCondition` が渡され、ドキュメントの `_etag` と違えば `{ code: 412 }`。`create` / `replace` のたびに `_etag` を振る | 段階4の併合 |
| `FakeCosmosDocument` の緩和 | `name` / `imagePath` を必須にしない（`{ id: string; type?: string; … }`）。`FakeCosmosBackend<TDoc>` の既定の型に `Trip | Photo | Entry` を足す | 旅行・写真は `name` / `imagePath` を持たない |
| 挿入順の維持 | そのまま（並び順はサーバの中で付けるので偽物の順に依存しない） | |

### 2.2 `tests/fakes/blob.ts`

そのまま使える（`store` のキーは `photos/<blobName>`）。`forcedUploadErrorByContainer` で「原寸は成功しサムネイルで失敗」を作れる。
`TEST_BLOB_HOST` で SAS 付き URL のホストを固定できる。

### 2.3 `tests/fakes/queue.ts`（段階3）

`FakeQueueBackend { messages: string[]; forcedSendError?: Error }` と `createFakeQueueClient()`。`sendMessage(text)` は `messages` に積む。
投入されたかは `messages` の中身（JSON を parse して `photoId`・`step`）で確かめ、呼び出しは検証しない。

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

- 読み取りのみの権限、発行から 60 分の `expiresOn`、5 分前の `startsOn` で署名する（偽のタイマー。引数をリテラルで検証。原則3の例外）
- `PHOTO_SAS_EXPIRY_MINUTES` に正の整数を設定すると期限が変わる。読めない値なら 60
- URL の形が `https://<host>/<container>/<blob>?<sas>` になる
- `urlExpiresAt` が `expiresOn` と同じ ISO 文字列になる
- 切り出し後も `storageService.test.ts` が全部通る（既存の `upload` の振る舞いを変えない）

### 3.3 `services/albumService.ts`

旅行:
- 作成すると `type: "trip"`・`tags: []`・`description: null`・同じ `createdAt` / `updatedAt` で保存される。`name` の前後の空白が除かれる
- 一覧は `createdAt` 降順で返る（サーバの中で並べる場合）。写真が無い旅行は `photoCount: 0`・期間 null・表紙 null
- 集計: 3 枚（撮影日時あり 2・なし 1）の旅行で `photoCount: 3`、`firstTakenAt` / `lastTakenAt` が撮影日時のある 2 枚の最小・最大、表紙が撮影日時順で先頭の写真のサムネイル
- 表紙はサムネイルが無ければ原寸
- 更新は `name`・`description`・`updatedAt` だけ変わり、`tags`・`createdAt` は変わらない
- 削除は中の写真のドキュメントと Blob（原寸・サムネイル）を消してから旅行を消し、枚数を返す
- 削除で Blob の削除に失敗しても旅行と写真のドキュメントは消え、枚数を返す
- 削除で写真のドキュメントの削除に失敗すると例外になり、旅行は残る

写真:
- 作成すると `type: "photo"`・`tripId: null`（指定なし）・`processing.state: "none"`・全項目が揃って保存される（**`tripId` キーが存在して `null`**）
- `takenAt` があれば `takenAtSource: "exif"`、無ければ `"none"`
- 緯度・経度・地名から `location` が組み立てられ、無ければ `null`
- 既に同じ id があれば既存を返し、Blob の `store` は変わらない
- Blob（原寸→サムネイル）が `store` に入ってからドキュメントが作られる（サムネイルで失敗すると原寸は残りドキュメントは無い）
- `create` が 409 を返したら既存を読んで返す
- 一覧: `@tripId` に旅行の id を渡すとその旅行の写真だけ、`null` を渡すと未所属だけ
- 並び: 撮影日時昇順、無しは末尾、同じ撮影日時は `uploadedAt` 昇順
- 応答の Photo に `imageUrl` / `thumbnailUrl` があり、`blobName` / `thumbnailBlobName` / `type` / `_rid` などが無い
- サムネイルが無い写真は `thumbnailUrl: null`
- 削除はドキュメントと原寸・サムネイルを消す。Blob の削除に失敗してもドキュメントは消え、真を返す。無ければ偽
- move: 指定した id の `tripId` が変わり `updatedAt` が更新される。`null` で外せる。無い id は `notFound` に入り残りは動く。他の項目（`comment` など）は変わらない
- PATCH: `comment` を保存して `commentSource: "user"`、`null` で消して `commentSource: null`。`tags` は `category:` を残して置き換わり、重複は除かれる

### 3.4 `functions/trips.ts` / `tripDetail.ts`

- `POST`: 201 で `data.trip` が返る。[05 §5.8](./05_api_design.md#58-post-apitrips) の 1〜7 の各検証（順序を含む。例: `name` が数値で `description` も数値なら `旅行名は文字列で指定してください`）。`description` が `null`・未指定・空文字は通り `null` で保存
- `GET /api/trips`: `data.trips` と `total`。0 件で `[]`・`0`
- `GET /api/trips/{tripId}`: 400（形式）・404 `TRIP_NOT_FOUND`・200 で集計付き
- `PUT`: 形式 → ボディの順で検証。404。200 で更新後の旅行。`tags` が変わらない
- `DELETE`: 404。200 で `deletedPhotoCount`。偽物の `documents` から写真と旅行が消え、`store` から Blob が消える
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
- `tripId` 無しで 400 `絞り込み条件を指定してください`。`tripId=abc` で 400。無い旅行で 404
- `tripId=<uuid>` でその旅行の写真だけ、`tripId=none` で未所属だけ。並び順。`total`
- `urlExpiresAt` が返る

### 3.6 `functions/photoDetail.ts`

- `GET`: 400（形式）・404 `PHOTO_NOT_FOUND`・200
- `DELETE`: 400・404・200 `写真が正常に削除されました`。`store` から原寸とサムネイルが消える。Blob の削除失敗でも 200
- `PATCH`: [05 §5.6](./05_api_design.md#56-patch-apiphotosphotoid) の 1〜11 の各検証。`comment` だけ・`tags` だけ・両方。`category:` を送ると 400。既存の `category:plant` が残る。前後の空白を除いて空の `comment` は `null`

### 3.7 `functions/photoMove.ts`

- [05 §5.5](./05_api_design.md#55-post-apiphotosmove) の 1〜9 の各検証。201 件で 400。`tripId` のキーが無いと 400、`null` なら通る
- 2 枚を旅行に入れると `moved` に 2 つ、`documents` の `tripId` が変わる
- `null` で外すと `tripId: null` になる
- 一部が無いと `notFound` に入り、残りは動く
- 重複した id は 1 回だけ数える
- 無い旅行で 404。偽物の状態が変わらない
- patch の予期しない失敗で 500（送れた分は変わっている）

### 3.8 `response.ts` の拡張

- `createNotFoundError(message)` は従来どおり `PLANT_NOT_FOUND`
- `createNotFoundError(message, ErrorCode.TRIP_NOT_FOUND)` で `code` が変わる

## 4. 段階2のシナリオ一覧（mobile）

### 4.1 `services/api_service_test.dart`

[05 §8](./05_api_design.md#8-クライアントmobilelibservicesapi_servicedartに足すメソッド) の各メソッドについて、既存と同じ形で:
- 封筒の `data` を剥がして型に変換できる（宛先のメソッドとパスが一致したときだけ応答する）
- 非 2xx で `ApiException` になり、`code`・`message` が入る（`TRIP_NOT_FOUND` → `isTripNotFound`）
- `uploadPhoto` が multipart で `photoId`・`image`・`thumbnail`・`tripId`・`takenAt`・`latitude`・`longitude`・`placeName` を送る（送る内容は管理外ではないが、サーバとの契約なので `MockClient` が受けたリクエストの中身で確かめる）。`tripId` 無しなら `tripId` パートを送らない。201 と 200 を区別して返す
- `movePhotos` が `tripId: null` を JSON の `null` で送る（キーを省かない）

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

- 旅行一覧: 一覧・0 件・失敗・再試行の表示。先頭の行の枚数。旅行を作るダイアログの検証（空の旅行名）と成功後の再読み込み
- 旅行詳細: 一覧・0 件・失敗。404 で「この旅行は削除されています」。削除確認の文言に枚数が入る。削除成功で戻る。削除失敗で留まる
- 未所属: 「旅行から外す」が無い
- 写真ビューア: 撮影日時・地名・緯度経度・なしの表示。削除で次の写真へ、最後なら戻る
- `PhotoGrid`: 長押しで選択モード、タップで切り替え、「すべて選択」、「×」で解除。操作ボタンは 0 枚で押せない
- 旅行に入れる: 旅行を選ぶダイアログに今の旅行が出ない。成功のスナックバーに枚数と旅行名。`notFound` があれば文言が足される。200 件を超えると分けて送られる（`MockClient` が受けた回数と中身）
- 削除（複数）: 1 枚ずつ送られ、404 は成功に数える

## 5. 偽物で確かめられず手で確かめる項目

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
| 8 | 旅行の削除 | 写真と Blob が消える（ポータルで `photos` を確認） | Blob が残る |

### 5.2 デプロイ後（API、段階2）

| 確かめること | 手順 | 崩れたときの症状 |
|---|---|---|
| `IS_NULL(c.tripId)` の絞り込み（パラメータへの `IS_NULL`） | `GET /api/photos?tripId=none` が未所属だけを返し、旅行の写真が混ざらない | 一覧が空か混ざる |
| 射影（旅行一覧の集計） | `GET /api/trips` の `photoCount`・期間・表紙が実際の写真と合う | 枚数ずれ |
| 旅行一覧の並び | 新しく作った旅行が先頭 | 古いのが先頭 |
| `/api/photos/move` のルート | `POST /api/photos/move` が 200 で `moved` を返す（400 `写真IDの形式が無効です` なら `{photoId}` に取られている） | move が 400 |
| 応答に `_rid` などが出ない | `GET /api/photos/{photoId}` の JSON を目で見る | 余分なキー |
| ライフサイクル | `temp-images` に Blob を置いて 2 日後に消えている。`photos`・`images`・`azure-webjobs-*` が消えていない | 消えない・消えすぎ |
| 関数の登録 | ポータルの「関数」に `trips`・`tripDetail`・`photos`・`photoDetail`・`photoMove` がある | 404（`app.ts` の import 忘れ） |

### 5.3 段階3・4で足すもの

- `ARRAY_CONTAINS` のタグ絞り込み、`DISTINCT` のタグ一覧、タイマーの再投入クエリ（[04 §5](./04_data_design.md#5-クエリ)）
- キューの直列化（`batchSize: 1`）と poison の挙動
- 10 枚のトークン使用量の実測（[06 §6](./06_processing_design.md#6-費用の見積もり方と上限)）
- 項目の併合（同じ名前の写真 2 枚で項目が 1 件、信頼度の高い方で説明が更新される）
- 移行スクリプトの冪等性（2 回流して件数が変わらない）

CLAUDE.md の「Cosmos のクエリを変更したら手で確認する」の表に、5.2 の該当行を足す。
