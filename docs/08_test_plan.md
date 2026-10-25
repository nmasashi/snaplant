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
| 依存の種類でモックを決める | Cosmos DB・Blob Storage・Storage Queue は管理下にある依存 → 状態持ちの偽物（`tests/fakes/`）で差し替え、**やり取りは検証しない**。結果は `documents` / `store` / `queues` の中身で確かめる。Azure OpenAI・Azure Maps は管理外 → モックして呼び出しも検証してよい |
| 観察可能な振る舞いだけ | ハンドラはレスポンス（ステータス・`code`・`message`・`data`）と、偽物の状態。サービスは戻り値と偽物の状態 |
| `details` は固定しない | 付くか付かないかを確かめるのは可。文言を `toEqual` で固定しない |
| エラーの注入は実 SDK の形で | Cosmos: `{ code: 404 }` / `{ code: 409 }` / `{ code: 412 }`、`ENOTFOUND` は `cause` を持つ形も。Blob: `name: 'RestError'`・`statusCode`・`code`。OpenAI: 既存の3段の `cause`（CLAUDE.md「テストの流儀」の表） |
| 偽物はファイル内で再定義しない | `tests/fakes/cosmos.ts`・`blob.ts`・（段階3）`queue.ts` だけが実体 |
| SAS は例外として引数を見る | 署名は復号できないので、権限（read のみ）・`expiresOn`・`startsOn` は `generateBlobSASQueryParameters` の引数をリテラルで検証する（原則3の例外。コメントに理由を書く）。時刻は偽のタイマーで固定 |
| 環境変数を消すときは `delete` | `process.env.X = undefined` は文字列 `"undefined"` になる |
| テスト名は日本語の文 | 既存と同じ |

ディレクトリは `src/` をミラーする: `tests/functions/trips.test.ts`・`tripDetail.test.ts`・`photos.test.ts`（`photos.ts` の POST）・`processPhoto.test.ts`（解析のワーカー。3-3a）・`photoList.test.ts`（`photos.ts` の GET。PR 4a-2 で分けた）・`photoDetail.test.ts`（`photoDetail.ts` の GET・DELETE）・`photoUpdate.test.ts`（`photoDetail.ts` の PATCH。PR 4b で分けた）・`photoMove.test.ts`・`photoProcess.test.ts`（やり直しの受付。3-3b）・`requeueStalePhotos.test.ts`・`sweepAlbum.test.ts`（タイマー。3-3b）・`catalogKinds.test.ts`・`catalogEntries.test.ts`（図鑑の種類と項目一覧。4-2a）・`catalogEntry.test.ts`（図鑑の項目の詳細。4-2b）、手で回すスクリプトの `tests/scripts/enqueueUnidentified.test.ts`（4-1b。スクリプトの関数が入口。CLAUDE.md の「テストの入口」）、
`tests/services/tripSummaries.test.ts`・`tests/services/catalogEntries.test.ts`（4-2a）（入口から入力を作れないので残す。CLAUDE.md の名簿）。3-2 で期限付きで置いた `tests/services/photoClassifier.test.ts` は、3-3a で入口のワーカーのテスト（`processPhoto.test.ts`）へ寄せて消した。ほかのサービスと `utils/` は単体のテストを持たず、入口（ハンドラ）のテストが通す（#44 で決めた「テストの入口」。#46 で入口へ寄せた）。

## 2. テスト用の差し替え部品の拡張

### 2.1 `tests/fakes/cosmos.ts`

| 拡張 | 中身 | 理由 |
|---|---|---|
| `query` の絞り込み | `@type`・`@tripId`（`tripId` が値と厳密に等しいものだけ。未所属は `@tripId = null` で、`tripId` が `null` のものだけ。項目が無いものは含めない。SQL の null の比較自体は手で確かめる。§5.2）・`@category`（`category` の一致）・`@kind`・`@entryName`（`identification.kind` / `identification.name` が値と厳密に等しいもの。`identification` が無い・`null` の写真は外れる。**`matchesKind` は見ない**（`matchesKind: false` の写真は名前が `null` なので `@entryName` で外れるが、`@kind` だけの絞り込みには残る）。4-2b で足した。項目の詳細の見出し・枚数・写真のページが使う。項目一覧の `GROUP BY` も `@kind` を渡すが、集計なので絞っても偽物では行を作れない）のパラメータで絞る。項目の名前を `@name` にしなかったのは、偽物が `@name` を植物図鑑の `plants` の名前の絞り込みに使っていたため（[04 §5.6](./04_data_design.md#56-図鑑のまとめ段階4)。偽物の `@name`・`@imagePath` の扱いは植物図鑑と一緒に 4-6 で消した） | サービスはこれらを必ずパラメータで渡す（[04 §5](./04_data_design.md#5-クエリ)）。SQL 文字列は見ない |
| `query` のページ | `fetchNext()` が `maxItemCount` 件ずつ返し、続きがあれば `continuationToken`（偽物では挿入順の位置を表す文字列）を返す。同じトークンを渡すと続きから返す。`fetchAll()` も残す | 写真一覧のページの切れ目とトークンの受け渡し（[04 §5.3](./04_data_design.md#53-旅行の写真一覧)）。`ORDER BY` は解釈しないので、**並び順は挿入順になる**（並びそのものは手で確かめる。§5.2） |
| 集計クエリ | `COUNT` / `MIN` / `MAX` / `GROUP BY` / `TOP 1 … ORDER BY` は偽物では解釈できない（`TOP 1` は絞り込んだ文書を挿入順で返すので先頭の1枚が見出しになり、`SELECT VALUE COUNT(1)` は数の代わりに文書を返す。項目の詳細の入口のテストは `photoCount` を見ず、見出しになる写真を先に入れる）。集計の SQL は `services/albumQueries.ts`（図鑑は `services/catalogQueries.ts`。4-2a）に集め（SQL 文字列とパラメータの組み立てだけの薄い層。取るに足らないコードとしてテストしない）、集計の行から `TripSummary` / `CatalogEntry` を組み立てる所は純粋関数（`services/tripSummaries.ts`・`services/catalogEntries.ts`）に分け、行を直接渡して単体で確かめる（`albumQueries` を差し替えない。PR 3 で決めた）。SQL 自体は手で確かめる（§5.2・§5.3） | 偽物に SQL の解釈を持ち込まない（CLAUDE.md「偽物は Cosmos SQL を解釈しない」）。集計の行から応答を組み立てる所は単体で確かめられる |
| `create` の 409 | 同じ `id` があれば `{ code: 409 }` のエラーを投げる（実 SDK の `Conflict`） | 写真の冪等性は `create` の 409 で成り立つ |
| `item().patch(body, options)` | `body` が配列か `{ operations, condition }` の両方を受け、`set` / `replace` / `remove` を `path`（`/tripId` のような1段と `/processing/state` のような2段）に適用する。`id !== partitionKey` か無ければ `{ code: 404 }`。`condition` はこの設計で使う2つの形（担当の `FROM c WHERE c.processing.state = "<文字列>" AND c.processing.step = "<文字列>" AND c.processing.attempts = <整数> AND c.processing.updatedAt = "<同じときの processing.updatedAt>"` と、コメントの「担当の条件 AND `(IS_NULL(c.<path>) OR c.<path> = "<値>")`」）だけを解釈し、満たさなければ `{ code: 412 }`（3-3a で1つ目の形（`c.<path> = "<文字列>"` と `c.<path> = <整数>` を `AND` でつないだもの）を足した。2つ目は担当の条件と `AND` でつないだ `(IS_NULL(c.commentSource) OR c.commentSource = "ai")` の形で、コメントを書く 4-1a で足す）。「読んだ後・patch の直前に他の操作が書き換えた」は `beforePatch` で作る。**それ以外の形は例外にする**（知らない条件を黙って通さない） | move・PATCH・旅行の削除（未所属へ戻す）・やり直しの受付・掃除のタイマー（未所属へ戻す）・ワーカー（担当の条件付き patch、結果と失敗の条件付き patch（3-3b）、コメントの条件付き patch。[04 §7.4](./04_data_design.md#74-ワーカーの書き込みの決まり)）・再投入のタイマー（読んだときの `processing` の条件付き patch。3-3b）・識別に回すスクリプト（同じ。4-1b）が使う。条件が実環境で意図どおりかは手で確かめる（§5.3） |
| `FakeCosmosDocument` の緩和 | `name` / `imagePath` を必須にしない（`{ id: string; type?: string; … }`）。`FakeCosmosBackend<TDoc>` の既定の型に `Trip | Photo` を足す | 旅行・写真は `name` / `imagePath` を持たない |
| 挿入順の維持 | そのまま。テストは期待する並びの順に挿入し、ページの切れ目を確かめる | `ORDER BY` を解釈しないため |

`_etag` と `accessCondition` の対応は足さない（ワーカーは `_etag` の条件を使わない。[04 §7.4](./04_data_design.md#74-ワーカーの書き込みの決まり)）。`incr` も足さない（カウンタの文書を置かない。[06 §6](./06_processing_design.md#6-費用の抑え方)）。

### 2.2 `tests/fakes/blob.ts`

`store` のキーは `photos/<blobName>`。原寸とサムネイルは同じ `photos` コンテナなので `forcedUploadErrorByContainer` では区別できず、「原寸は成功しサムネイルで失敗」は Blob 名ごとの失敗（`forcedUploadErrorByKey`。PR 4a-1 で足す）で作る。
`TEST_BLOB_HOST` で SAS 付き URL のホストを固定できる。
コンテナの `listBlobsFlat()`（掃除のタイマー。3-3b）は、そのコンテナの Blob の名前と最終更新の時刻を挿入順に返す（ページは分けない）。最終更新は `store` の各 Blob の `lastModified` で、省略すると列挙した時点（新しい Blob）になる。

### 2.3 `tests/fakes/queue.ts`（段階3）

`FakeQueueBackend { queues: Map<キューの名前, string[]>; forcedSendError?: Error }` と `createFakeQueueClient(backend, queueName)`。`sendMessage(text)` はそのキューの配列に積む（宛先のキューの取り違えを見分けるため、名前ごとに持つ）。
投入されたかは中身を `decodeQueueMessage()`（Functions のトリガーと同じく base64 として読み、JSON を parse する）で読み戻して確かめ、呼び出しは検証しない。
`forcedSendError` で「投入に失敗しても応答は成功で、写真は `pending` のまま」（[04 §7.1](./04_data_design.md#71-操作ごとの表)）を作る。

### 2.4 `mobile/test/`

| 偽物 | 使い方 |
|---|---|
| `MockClient`（`package:http/testing.dart`） | `ApiService` の新メソッドと `UploadQueue`。メソッドとパスが一致したときだけ応答し、それ以外は 404。`content-type: application/json` を付ける |
| `image_picker_platform_interface` の偽物 | `pickMultiImage()` の差し替え（`test/helpers/gallery_test_helpers.dart` の `FakeMultiGallery`。元にした `camera_screen_test.dart` は 4-5 で画面と一緒に消した） |
| 小さな JPEG の資産 | EXIF（撮影日時・GPS あり/なし）を持つ数 KB の JPEG を `test/assets/` に置き、EXIF の読み取りとハッシュの固定値に使う |
| `Geocoder` | `geocoding_platform_interface` の `GeocodingPlatformFactory.instance` を偽物に差し替える（`test/helpers/geocoding_test_helpers.dart`。知っている場所の近くには結果を返し、知らない場所には空のリスト。失敗・応答しないも作れる。引いた座標を残す） |
| 画像の圧縮（サムネイル） | `flutter_image_compress` の `FlutterImageCompressPlatform.instance` を偽物に差し替える（`test/helpers/image_compress_test_helpers.dart`。Android の実装と同じ規則で、渡された最小の幅・高さから作る寸法を決め、寸法・画質・形式を結果として残す。EXIF の回転は再現しない） |

## 3. 段階2のシナリオ一覧（api）

**テストリストの元。** 各 PR の List 段でここから選び、1つずつ Red → Green → Refactor。

### 3.1 `utils/errors.ts` — `isConnectivityError()`

- `ENOTFOUND` / `ECONNREFUSED` をトップレベルの `code` に持つエラーで真（`it.each`）
- 2段奥の `cause` に持つエラーでも真
- `code` が無いエラー、`404` のエラーで偽

### 3.2 `utils/blobSas.ts`

- 読み取りのみの権限、発行から 60 分の `expiresOn`、5 分前の `startsOn` で署名する。**実 SDK で作ったトークンの `sp`・`se`・`st`・`sr` を `URLSearchParams` で読んで確かめる**（`sig` 以外は平文。引数を見る原則3の例外を使わずに済む。PR 4a-1 で決めた）。`startsOn` は `generateReadSasUrl()` の引数で、写真の側（`PhotoStorageService`）が渡す（植物図鑑の一時画像の SAS は渡していなかった。4-6 で一時画像の SAS ごと削除）
- `PHOTO_SAS_EXPIRY_MINUTES` に正の整数を設定すると期限が変わる。読めない値なら 60
- URL の形が `https://<host>/<container>/<blob>?<sas>` になる
- `urlExpiresAt` が `expiresOn` と同じ ISO 文字列になる
- 切り出し後も `upload.test.ts` が全部通る（既存の `upload` の振る舞いを変えない。一時 URL の SAS の署名もここで見る）。`upload` とそのテストは 4-6 で削除した

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
- 作成すると `type: "photo"`・`tripId: null`（指定なし）・`category: null`・`tags: []`・`processing.state: "none"`（段階3からは `pending`・`step: "classify"`。§3.9）・全項目が揃って保存される（**`tripId` キーが存在して `null`**）
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
- `tripId` も `category` も無しで 400 `絞り込み条件を指定してください`。`tripId=abc`・`tripId=`（空）で 400。`limit` が `0` / `201` / `-1` / `abc` / `1.5` / `01` / `1e2` / `0x10`・前に空白・空で 400。`continuationToken=`（空）で 400。
  どれも Cosmos に触る前に返す。無い旅行で 404（その旅行を指す写真が残っていても）
- `tripId=<uuid>` でその旅行の写真だけ、`tripId=none` で未所属（`tripId: null`）だけ（消えた旅行を指す写真・`tripId` の項目が無い写真は返らない）
- `limit=2` で 2 枚と `continuationToken`、同じトークンを渡すと続き、最後は `continuationToken: null`。`total` は無い。`limit` の 1 と 200 は通る
- 旅行はあるが写真が無ければ 200 で `photos: []`・`continuationToken: null`
- Cosmos が受け付けないトークンで 400 `継続トークンの形式が無効です`。トークンを渡していない要求での Cosmos の 400 は 500。トークンを渡していても接続できない障害は 503
- 旅行の確認・一覧のクエリのどちらで失敗しても、503 `DATABASE_ERROR` / 500 `写真一覧の取得に失敗しました`
- `urlExpiresAt` が返る。Photo は項目が完全一致（`blobName` / `type` / `_rid` などが無い）
- カテゴリ（3-3b）: `category` だけで、旅行をまたいで（旅行に属さない写真も）そのカテゴリの写真だけ（旅行の確認はしない）。`tripId` と両方で、その旅行のそのカテゴリだけ。
  `category` が定義表に無い（`animal`）・大文字（`FOOD`）・空で 400 `カテゴリが無効です`。検証の順は `tripId` → `category` → `limit`

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

- `process`（3-3b。`photoProcess.test.ts`）: 202 で `{ photo, urlExpiresAt }`。写真に `pending`・`step`・`hint`・`attempts: 0`・`updatedAt` が書かれ（`failed`・`attempts: 3` の写真でも）、`comment` / `commentSource` が `null` になり、キュー（`queues`）に `{ photoId }` が積まれる。
  前回の `category`・`classification`・`tags`・`tripId` は変わらない。`hint` は前後の空白を除いて書き、送らない・空白だけ・`null` なら前回の `hint` が消えて `null`。**投入に失敗しても 202** で写真は `pending` のまま。
  `step: "identify"`（4-1b）でも同じく 202 で、写真が `pending`・`step: "identify"` になり、前回の `identification` は残る。
  [05 §5.7](./05_api_design.md#57-post-apiphotosphotoidprocess段階3) の 1〜8 の各検証（4 は `classify` / `identify` 以外の文字列も。順序の例: 写真 ID も処理の種類も不正なら写真 ID、処理の種類も手がかりも不正なら処理の種類。`identify` で写真が無ければ 8 ではなく 404。8 は `category` が `other` と `null`）で、写真も変えずキューにも積まない。書き込みの失敗で 503 / 500 で、写真もキューも変わらない
- 識別に回すスクリプト（4-1b。`tests/scripts/enqueueUnidentified.test.ts`）: `--apply` 相当（`apply: true`）なら、`done`・`category` が図鑑の種類（植物・食べ物・風景）・`identification: null` の写真が `pending`・`step: "identify"`・`attempts: 0`・`lastError: null`・`updatedAt` が今になり、ほかの欄は変わらない。キューには積まない。
  `other`・識別済み・分類の待ち・識別中・`failed`・`none` の写真は変えない（クエリの絞り込みを偽物が解釈しないので、コードの見直しで確かめる）。`apply: false` なら枚数を数えるだけで何も変えない。
  読んだ後・書く前にやり直しの受付が入った写真は書かず（受付の状態のまま）、ほかの写真は書く。戻り値の `found`（対象の枚数）・`marked`（待ちにした枚数）
- ワーカーの手がかり（3-3b）: 写真に `hint` があれば、分類の AI へのテキストに含める
- ワーカーの条件付きの書き込み（3-3b・4-1a）: 分類・識別の間にやり直しの受付が入ったら（AI の応答を待つ間に写真を受付の状態に書き換える）、古い結果も失敗も（識別なら AI のコメントも）書かず、例外も投げない（写真は受付の状態のまま）
- 分類の AI に送るもの（[06 §2.1](./06_processing_design.md#21-モデルとサービス)・§2.2。管理外の依存なのでモックの受けた要求で確かめる）: 画像（`detail: "low"`）とテキストの2パート、strict な `json_schema` の選択肢が定義表の種類 + `other`、`max_completion_tokens`（`max_tokens` と `temperature` は送らない）、撮影地があればテキストに含む。分類用のデプロイ名があればそのデプロイ（`baseURL` と `model`）に送り、今のデプロイ名が無くても分類できる。未設定・空・空白だけなら今のデプロイに送る。デプロイ名が決まらないときと、AI のクライアントを作れないとき（API キーが無い）は、AI を呼ばずに失敗し、`UpstreamError` にしない。種類が選択肢に無い・信頼度が数値でないか 0〜100 の外（0 と 100 は可）・空・JSON として読めない・SDK のエラーは `UpstreamError("ai")`
- ワーカー（分類）: `category` が書かれ、`classification` が書かれ、`identification` が `null` になる。`tags`・`comment`・`tripId` は変わらない。識別対象（定義表の3種類）なら `pending`・`step: "identify"`・`attempts: 0`・`lastError: null` になって（分類の失敗の回数を持ち越さない）キューに `{ photoId }` が積まれ、投入に失敗しても写真はそのままで例外を投げない。`other` なら `done` で積まない
- ワーカー（識別。4-1a）: 処理中は `identifying`（`attempts` +1）。`identification` が `{ kind, matchesKind: true, name（trim 済み）, confidence, description, characteristics, attributes, reason: null, model, at }` で書かれ、`comment` が AI の一言（trim 済み）・`commentSource: "ai"` になり、`done`・`step: "identify"`。キューには積まない。
  `matchesKind: false` なら名前が無くても受け付け、`name`・`description`・`characteristics` が `null`、`attributes` が `{}`、`reason` が AI の一言で、`comment` は変わらない。
  AI の一言が空白だけならコメントを書かずに結果は書く。前回の AI のコメント（`commentSource: "ai"`）は書き直す。`attributes` は定義表のキーだけを書く（定義に無いキーは捨てる）。信頼度 0 と 100 は受け付ける
- 識別の AI に送るもの（[06 §3.1](./06_processing_design.md#31-契約)。モックの受けた要求で確かめる）: 画像（原寸の読み取り 15 分の SAS、`detail: "low"`）とテキストの2パート、strict な `json_schema` の共通項目（型と `required`、`additionalProperties: false`）と `attributes`（写真の種類の `fields` の全キーが `required`、`string` は `["string","null"]`、`string[]` は `["array","null"]` で `items` が string）、`max_completion_tokens`（`max_tokens` と `temperature` は送らない）。
  分類用のデプロイ名があっても今のデプロイ（`baseURL`・`model`・`identification.model`）。プロンプトに種類の `namingRule` と、ある手がかり（`hint`・撮影地・撮影日時 `YYYY-MM-DD HH:mm`）を含み、無い値（`null`）は含まない
- 識別の失敗（4-1a）: 応答の検証違反（`matchesKind` が真偽値でない、信頼度が数値でないか 0〜100 の外、写っているのに名前が無い・空白だけ・100 文字超、`attributes` の値の型が合わない）と SDK のエラーは、識別の待ち（`step: "identify"`）に戻して `lastError: "ai"`・例外。上限の回は `failed`・`step: "identify"` で例外を投げない。
  `matchesKind: false` でも信頼度は検証する。写っていて名前がちょうど 100 文字、`attributes` の値が `null`（特定できない）は受け付ける。
  写真の `category` が図鑑の種類でない識別の待ちと、識別の設定の誤り（デプロイ名が無い）は、AI を呼ばずに `lastError: "internal"`
- ワーカーは `commentSource: "user"` の `comment` を書き換えず（担当の後に利用者が書いたものも）、`identification`・`processing` は書く（コメントの条件付き patch が 412 でも結果の patch に進む）。`commentSource` が `null` / `"ai"` なら書く
- ワーカーが読んだ後に利用者が `tags`・`tripId` を変えても（偽物の文書を途中で書き換える）、結果の patch で利用者の変更が残る
- ワーカーは `state` が `pending` でない写真（担当の条件付き patch が 412。古い重複メッセージ）には何もしない。`done` / `failed` / `none` / 処理中でも何もしない。読んだ後・担当の直前に別のインスタンスが担当したときも、担当して失敗し `pending` に戻していたとき（`attempts` が変わっている）も何もしない（回数を数え直さない）
- ワーカー（3-3a・4-1a）: `step` が `classify` でも `identify` でもなければ（`none` の写真の `null`）、AI を呼ばず写真も変えない。読んだ後・担当の前に別の処理が `step` を変えていたら（分類の待ちを読んだ後に識別の待ちになった）、AI を呼ばず写真も変えない
- ワーカー（3-3a）: 写真が無い・メッセージに文字列の `photoId` が無い（JSON のオブジェクトでないものを含む）ときは何もせずに終える。写真を読めなければ写真を変えずに例外を投げる
- ワーカーの失敗（3-3a）: AI の失敗（SDK のエラー・応答の検証違反）は `pending` に戻して `lastError: "ai"`・`attempts` +1 を書き、例外を投げる。結果の欄は書かない。上限（既定 3、`PHOTO_PROCESSING_MAX_ATTEMPTS` で変わる）の回の失敗は `failed` にして例外を投げない。設定の誤り（デプロイ名が無い・AI のクライアントを作れない）は `lastError: "internal"`。成功すると `lastError: null` に戻り、`attempts` は数え続ける
- 写真の送信（3-3a）: 作ったときだけ `PHOTO_QUEUE_NAME` のキューに、base64 の本文で `{ photoId }` が1つ積まれる。既存を返す 200（読み取りで見つけたとき・`create` の 409）では積まない。投入に失敗しても、`PHOTO_QUEUE_NAME` が無くても 201 で、写真は `pending`・`classify` のまま
- タイマー（再投入。3-3b。`requeueStalePhotos.test.ts`）: 10 分より前から更新されていない `pending` / `classifying` / `identifying` の写真が `{ photoId }` で積まれ（処理中の写真は `pending` に戻ってから。`step`・`attempts`・`lastError` はそのまま、`updatedAt` は今。戻さないとワーカーが担当しない）、`attempts` が上限なら積まずに `failed` になる。
  **`failed`・`none`・`done` と、まだ 10 分たっていない写真は拾わない**（写真も変えず、積まない）。旅行の文書は拾わない。読んだ後にワーカーが担当していたら触らない。
  投入に失敗しても残りの写真を続け、写真は `pending` のまま残る。写真を読めなければ例外を投げ、何も積まない
- 掃除のタイマー（3-3b。`sweepAlbum.test.ts`）: 文書の無い Blob のうち最終更新から1日より古いものだけが `store` から消え（原寸もサムネイルも）、ちょうど1日・新しいもの・文書のある Blob・別のコンテナの Blob は残る。
  名前が写真 ID（小文字16進 64 文字）+ `.` で始まらない Blob（大文字、65 文字、`readme.txt`）は古くても残る。存在しない旅行を指す写真が `tripId: null`・`updatedAt` が今になる（消えない。ある旅行の写真と未所属の写真は変わらない）。Blob の無い文書は消えない。
  写真の文書を読めなければ、Blob を消さずに例外を投げる
- 図鑑のまとめ（4-2a で実装済み。組み立ての純粋関数に行を直接渡して。`tests/services/catalogEntries.test.ts`）: 枚数の行 `{ name, photoCount }` と項目ごとの `TOP 1` の結果から `CatalogEntry` が組み立てられる
  （`confidence`・`description`・`characteristics`・`attributes` は見出しの写真の識別から、`photoCount` は行から、`kind` は渡した種類、表紙はサムネイルの URL で、サムネイルが無ければ原寸の URL）。
  名前の文字列順（符号単位）に並べて `offset` から `limit` 件を切り、`total` はページに依らない。`offset` が項目の数を超えれば空のページで `total` はそのまま。名前が `null` の行は項目にも `total` にも数えない。
  見出しの写真が無くなっていた項目はページから外し、`total` はそのまま
- 図鑑の API の置き場（4-2a で決めた）: 偽物は `GROUP BY` も `ORDER BY` も解釈しないので、名前ごとの枚数の行と見出しの写真（信頼度の高い1枚）を入口から作れない。
  旅行一覧と同じく、行と見出しの写真から項目のページを組み立てる所を純粋な関数（`catalogEntries.ts`）に分けて `tests/services/catalogEntries.test.ts` で確かめ（CLAUDE.md の名簿）、
  入口のテストは検証・0件・データベースの障害を見る。SQL の絞り込み・並び・集計は §5.3 で手で確かめる
- 図鑑の種類の一覧（4-2a で実装済み。`catalogKinds.test.ts`）: 200 で、定義表の種類が表の順に、種類ごとの項目（`key`・`label`・`type`）と一緒に返る。`prompt`・`namingRule` は返さない
- 図鑑の項目一覧（4-2a で実装済み。`catalogEntries.test.ts`。[05 §5.14](./05_api_design.md#514-図鑑段階4)）: 識別された写真が無ければ 200 で `{ entries: [], total: 0 }`。
  `offset=0`・`limit=100`（上限）・`limit=1` は受け付ける。`kind` が無い・`other`・`constructor` で 400 `図鑑の種類が無効です`、`offset` が負・小数・空、`limit` が `0`・`101`・数でない・小数・空で 400 `ページの指定が無効です`。
  `kind` もページも不正なら `kind` の指摘。データベースの読み取りの失敗で 503 `DATABASE_ERROR` / 500 `図鑑の一覧の取得に失敗しました`（`tests/helpers/databaseFailures.ts` の表）
- 図鑑の項目の詳細（4-2b で実装済み。`catalogEntry.test.ts`。[05 §5.14](./05_api_design.md#514-図鑑段階4)）: 種類と名前で開くと 200 で、見出しの写真の識別からの `entry`（`kind`・`name`・`confidence`・`description`・`characteristics`・`attributes`・表紙はサムネイルの URL）と、その種類・その名前の写真の1ページ（サムネイルの無い写真は `thumbnailUrl: null`）・`continuationToken: null`・`urlExpiresAt`（今から 60 分）。
  同じ名前でも別の種類の写真と、写っていない（名前が `null`）写真は含めず、種類を替えればその種類の項目と写真になる。名前は前後の空白を除いて比べる。100 文字ちょうどは受け付ける。
  その種類と名前の写真が無ければ 200 で `entry: null`・`photos: []`・`continuationToken: null`。`limit=1` で継続トークンを渡して2ページ目を読み、2枚が重複・欠落なく出て最後のトークンが `null`。
  `kind` が無い・`other` で 400 `図鑑の種類が無効です`、`name` が無い・空白だけで 400 `図鑑の項目の名前が指定されていません`、前後の空白を除いて 101 文字で 400 `図鑑の項目の名前は100文字以内で指定してください`、`limit=201` で 400 `1ページの枚数は1〜200で指定してください`、継続トークンが JSON でない・Cosmos が受け付けない JSON（偽物は自分が作った形でないトークンに `code` 400 を投げる）で 400 `継続トークンの形式が無効です`。
  順の例: 種類も名前も不正なら種類、名前もページも不正なら名前。データベースの読み取りの失敗で 503 `DATABASE_ERROR` / 500 `図鑑の項目の取得に失敗しました`（`tests/helpers/databaseFailures.ts` の2行）。
  偽物は `ORDER BY`・`COUNT`・`matchesKind` を解釈しないので、見出しの選び方・写真の並び・`photoCount`・`matchesKind: false` で名前の残った写真の除外は入口では見ない（§5.3 で手で確かめる）
- Cosmos の設定の不足（4-2a で実装済み。`tests/scripts/enqueueUnidentified.test.ts`）: `COSMOS_DB_ENDPOINT`・`COSMOS_DB_KEY`・`COSMOS_DB_DATABASE`・`COSMOS_DB_ALBUM_CONTAINER` のどれかが無い・空白だけなら、識別に回すスクリプトはその設定の名前を含む例外で止まる（`AlbumService` を作るときに確かめる）
- 移行スクリプト（4-4 で作ったテスト `tests/scripts/migratePlants.test.ts`）: 旧図鑑の植物を移さないと決めたので、スクリプトと一緒に 4-6 で削除した（[06 §7.1](./06_processing_design.md#71-移行スクリプト手順-2削除した)）

### 3.10 段階5（タイムライン）で足すシナリオ（骨格）

**実装済み**（5-1a。`tests/functions/timeline.test.ts`・`timelineDraft.test.ts`・`requeueStalePhotos.test.ts`・`tripDetail.test.ts`）: 「作る」、「再投入のタイマー」、「旅行の削除」の前半（タイムラインと控えが消える）、下書きの読み取り（確かめ中の日と場面、消えた写真）とやめる（[05 §5.15](./05_api_design.md#515-タイムライン段階5)）。
**実装済み**（5-1b。`tests/functions/processTimeline.test.ts`）: 「区切り案」、「AI に渡すもの」、「失敗」、「並行」のワーカーの分、旅行の無いタイムラインのメッセージ。
**実装済み**（5-1c。`tests/functions/timelineDraft.test.ts`・`timeline.test.ts`）: 「区切りの保存」、「完成版を読む」。
**実装済み**（5-2a。`tests/functions/timelineDraft.test.ts`・`processTimeline.test.ts`）: 「文を書く受付」、「文」。
**実装済み**（5-2b。`tests/functions/timelineCurrent.test.ts`）: 「区切りを直し始める」、「文の編集」、「残せなかった文を閉じる」、「完成版の操作の共通」。
**実装済み**（5-3b。`tests/functions/timelineDraft.test.ts`）: 「下書きの読み取り」の、文を書くのに失敗した下書きの日と場面。
**実装済み**（5-4a。`tests/functions/timelineDraft.test.ts`・`timeline.test.ts`）: 「区切りの保存」の、写真が全部消えた場面の区切りの補い。「作る」の、控えのコメントの切り方。

入口はエンドポイント（`api/tests/functions/`）とワーカー（`processTimeline`）。AI はモックし、渡したもの（[06 §8.4](./06_processing_design.md#84-ai-に渡すもの) の要素）と応答の検証を確かめる。

- 作る: 解析中の写真があれば 409、撮影日時のある写真が無ければ 409、それ以外は 202 で控えができて下書きが `proposing`、キューに `{ tripId, draftId }`。作っている途中は 409。控えのコメントは先頭 100 文字をコードポイントで数えて切る（100 文字目が絵文字でも途中で切れない。5-4a）
- 区切り案: 応答の番号から区切りができ（重なり・順の乱れは除く）、各日の最初の写真が入り、確かめ中になる（下書きのほかの欄と完成版は変わらない）。作り直しでは完成版で利用者が足した・消した区切りが当たり（控えに無い写真の区切りは捨てる）、日の最初は最後にもう一度足される。処理中は `job` が `running`・`attempts + 1`
- AI に渡すもの: 画像を渡さず、撮影日時のある写真ごとに番号・何日目・撮影時刻・カテゴリの表示名（図鑑の種類でなければ「その他」、分類していなければ書かない）・名前・地名・コメントの1行と、日の区切り。Structured Outputs（strict）の区切りの番号の配列、`max_completion_tokens` 4,000、`temperature` を送らない。送り先はタイムライン用のデプロイ（無い・空白だけなら今のデプロイ）。400 枚を超える旅行は日の境目で分けて順に呼び（ちょうど 400 枚なら1回）、1日で超える日は切れ目を区切りにする
- 失敗: AI のエラー・範囲外・負・整数でない・番号でない・配列でない応答は AI の失敗、控えが無いなどは内部の失敗で、待ちに戻して例外を投げる。上限（`PHOTO_PROCESSING_MAX_ATTEMPTS`）で `failed` にして例外を投げない。分けて呼ぶ途中の失敗は途中までの結果を書かない。区切り案の間に下書きをやめていたら失敗も書かない
- 何もしないメッセージ: id が無い・UUID の形でない・本文が読めない、タイムライン・下書きが無い、別の下書き、処理中・失敗・確かめ中の下書き
- 下書きの読み取り: 下書きが無ければ `null`。確かめ中と、文を書くのに失敗した下書きは、状態に日と場面と日時なしの写真を付ける（控えを取った後に消えた写真・写真が全部消えた場面と日は出さない）。それ以外の下書きは状態だけ
- 区切りの保存: 区切りが無い・文字列の配列でないと 400（`区切りは写真IDの配列で指定してください`）、控えに無い・日時の無い写真を含む・重なる・順でない区切りは 400（`区切りが無効です`）で、どれも書かない。各日の最初の写真が無ければ補って保存する（消えた写真でも、今もある写真でも。日は下書きの日付の切り替えの時刻で分ける。5-3b）。今の区切りのうち写真が全部消えた場面の区切りも、送られなければ補う。ただし、同じ日でその次の見える場面の区切りを外した（前の場面とつなげた）ときは補わない（5-4a）。下書きが無ければ 404、区切り案を作っている・区切り案に失敗した・文を書いている下書きは 409。
  保存すると区切りだけが変わり（ほかの欄と完成版はそのまま）、応答は確かめ中の日と場面（消えた写真は出さない）。文を書くのに失敗した下書きでも保存でき、`reviewing` に戻る（`job` は消える）。読んでから書くまでに他が書いたら 409 で、他が書いたもののまま
- 完成版を読む: タイムラインが無ければ `null` で、解析中の枚数は返す（別の旅行の写真と `none`・`done`・`failed` は数えない）。完成版は日ごと・場面ごとに文と写真（区切りを入れた主・食べ物の印・地名と名前）、日時の無い写真は別にまとめる。日は完成版の日付の切り替えの時刻で分ける。
  消えた写真・写真が全部消えた場面と日は出さず、増えた・消えた枚数（日時の無い写真も、解析中の写真も数える）を返す。下書きは状態だけ。完成版が無く下書きだけなら完成版と写真の変化は `null`
- 文を書く受付: 確かめ中か、文を書くのに失敗した下書きは 202 で文を書く待ち（`attempts` は 0）になり、キューに `{ tripId, draftId }`（区切りと完成版はそのまま）。下書きが無ければ 404、区切り案を作っている・区切り案に失敗した・文を書く順番を待っている・文を書いている下書きは 409 で、どれも書かずキューに積まない。読んでから書くまでに他が書いたら 409 で、他が書いたもののまま。投入に失敗しても 202
- 文: 完成版が無ければ全部の日と場面を AI が書き、完成版（下書きの控え・日付の切り替えの時刻・区切り）に入れ替わって下書きが消える。AI には画像を渡さず、写真の行と日の区切りに加えて今の区切りと書かせる場面・日を渡し、Structured Outputs（strict）の日と場面の文、`max_completion_tokens` 16,000。頼んだ日・場面が無い・重なる・頼んでいない、空白だけの文、配列でない応答は AI の失敗（完成版は作らない）。文は前後の空白を除いて上限で切り詰める。
  400 枚を超える旅行は日の境目（1日で超える日は場面の境目）で分けて順に呼び、その呼び出しの場面と日だけを頼む（日の文はその日の最初の場面を含む呼び出し。頼むものが無い呼び出しは飛ばす）。途中で失敗したら途中までの文は書かない。
  作り直しでは、変わらなかった場面と日は AI に頼まず、引き継ぐ文と利用者が書いた文を文脈として渡す（書き直す欄の AI の前の文は渡さない）。利用者の文は残り、AI の元の文だけが新しくなる。書いている間に利用者が完成版の文を直したら、直した後の文が残る。無くなった場面・日の利用者の文が `droppedEdits` に足される（重なりは除く）。書かせるものが無ければ AI を呼ばない。
  書き終えると前の完成版の控えが消える（`recut` は同じ控えなので消さない。消すのに失敗しても入れ替えは済む）
- 並行: ワーカーの置き換えが 412 のとき、下書きが自分のもので `job` が担当したときのままなら当て直し（3回まで。4回続けば内部の失敗）、やめた・出し直した・タイマーが待ちに戻した下書きや消えたタイムラインなら書かない。担当の前に別のインスタンスが担当していたら AI を呼ばない。古い `draftId` のメッセージは何もしない
- 再投入のタイマー: `running` のまま止まった下書きを `pending` に戻して積み、上限なら `failed`
- 区切りを直し始める: 完成版の控え・日付の切り替えの時刻・AI の案・区切りを写した確かめ中の下書き（`recut`）ができ（完成版はそのまま。AI は呼ばない）、応答は確かめ中の日と場面（区切りを入れた主は完成版と同じ。完成版を作った後に消えた写真は出さない）。タイムラインが無い・下書きだけなら 404、下書きがあれば 409 で、どれも書かない。完成版を読んだ後に旅行が消された（控えも消えた）ら 404 `TRIP_NOT_FOUND` で下書きを作らない
- 文の編集: 写真 ID の形・ボディ・項目が無い・型・上限（上限値を埋め込んだ文言。前後の空白を除いて数える）の 400 で何も書かない。日付の形が違う・暦に無い日付・完成版に無い日・場面は 404（`その日は…`・`その場面は…`）、タイムラインが無い・下書きだけなら 404（`タイムラインが見つかりません`）。前後の空白を除いて保存して書いた主が利用者になり（送らなかった欄はそのまま）、空白だけ・空・`null` なら AI の文に戻って書いた主が AI になる。下書きがあっても直せ（下書きはそのまま）、応答は完成版を読んだ形
- 残せなかった文を閉じる: `droppedEdits` が空になり（完成版と下書きはそのまま）、応答は完成版を読んだ形。完成版が無く下書きだけでも閉じられる。既に空なら書き込まない（更新日時も変わらない）。タイムラインが無ければ 404
- 完成版の操作の共通: 旅行 ID の形の 400、旅行が無い 404（タイムラインは変わらない）、読んでから書くまでに他が書いたら 409 で他が書いたもののまま、置き換えの失敗の 503 / 500（`message` は 05 §7.2）
- 旅行の削除でタイムラインと控えが消える。旅行の無いタイムラインのメッセージは、タイムラインと控えを消して終える

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
- `PhotoGrid`: 長押しで選択モード、タップで切り替え、「表示中をすべて選択」、「×」で解除。操作ボタンは 0 枚で押せない
- 旅行に入れる: 旅行を選ぶダイアログに今の旅行が出ない。成功のスナックバーに枚数と旅行名。`notFound` があれば文言が足される。200 件を超えると分けて送られる（`MockClient` が受けた回数と中身）
- 削除（複数）: 1 枚ずつ送られ、404 は成功に数える

## 5. 単体テストで確かめられず手で確かめる項目

### 5.1 実機（SC-03K、段階2）

| 順 | 確かめること | 手順 | 崩れたときの症状 |
|---|---|---|---|
| 1 | **ハッシュの決定性**（最初に） | 同じ写真をギャラリーから 2 回選び、`photoId` が一致するか。一致しなければ縮小なしに切り替える | 同じ写真が 2 枚入る |
| 2 | `pickMultiImage` での EXIF と向き | 複数選択した写真の撮影日時・位置情報が読め、表示の向きが正しい。縦で撮った写真のサムネイルが縦長（240×320）で、長辺が 320 を超えない（向きの補正の前後で縦横を取り違えると 320×426 になる。テストの偽物は回転を再現しない） | 日時なし・横倒し・サムネイルが大きい |
| 3 | 端末の Geocoder | 位置情報のある写真で市区町村まで出るか。機内モードで `null` になり送信が止まらないか | 地名が出ない・送信が止まる |
| 4 | SAS で表示できる | 旅行詳細のサムネイルと原寸が出る。61 分放置して 403 になった後、下に引っ張れば復帰する | 画像が出ない |
| 5 | 300 枚の送信 | 完走する時間、失敗の枚数、電池。画面を移っても続く。結果を `docs/09_backlog.md` に記録 | 途中で止まる |
| 6 | 300 枚の move | `POST /api/photos/move` を 200 + 100 件で。Cosmos の 429 が出ても 5 分に収まるか | 500・タイムアウト |
| 7 | 100 枚の出し入れ | 旅行に入れる → 外す → 別の旅行に入れる。未所属の枚数が合う | 枚数がずれる |
| 8 | 旅行の削除 | 「写真も削除する」で写真と Blob が消える（ポータルで `photos` を確認）。「写真は残す」で写真が「旅行に属さない写真」に移り Blob が残る | Blob が残る・写真が消える |
| 9 | ページ | 300 枚の旅行で下までスクロールし、重複・欠落なく 300 枚出る。撮影日時の無い写真がアップロード日時の位置にある | 二重に出る・抜ける |
| 10 | 表紙と原寸の代わり | 旅行一覧の行に表紙（先頭の写真のサムネイル）が出る。サムネイルの無い写真は原寸がサムネイルの大きさで出る（テスト環境では画像を出せないので、単体テストでは見ていない） | アイコンのまま・「画像を読み込めません」 |

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
| 匿名で読めない（4-7 の apply の後） | ポータルのストレージアカウントの「BLOB の匿名アクセスを許可する」が無効。アプリの旅行詳細と図鑑でサムネイルと原寸が出る（SAS 付きの URL で読める）。`photos` の Blob の URL から `?` 以降を外して開くと読めない（[07 §3.2](./07_infrastructure_design.md#32-植物図鑑の廃止)） | 写真が出ない・SAS 無しで読める |
| 関数の登録 | ポータルの「関数」に、旅行の `listTrips`・`createTrip`・`getTrip`・`updateTrip`・`deleteTrip`（`app.http` の第1引数。ファイル名ではない）と、写真の `listPhotos`・`createPhoto`・`getPhoto`・`deletePhoto`・`updatePhoto`・`movePhotos` がある | 404（`app.ts` の import 忘れ） |

### 5.3 段階3・4で足すもの

- カテゴリの絞り込み（3-3b。[04 §5](./04_data_design.md#5-クエリ) の 5.4）: `GET /api/photos?category=food` が旅行をまたいで（旅行に属さない写真も）食べ物の写真だけを `sortAt` 順で返す。`tripId=<uuid>&category=food`・`tripId=none&category=food` がその旅行（未所属）の食べ物だけを返す。
  `continuationToken` でめくって重複・欠落が無い（`c.category = @category` と `c.tripId = @tripId` の AND・`ORDER BY c.sortAt`）
- 再投入のクエリ（3-3b。5.8）: `pending` / `classifying` / `identifying` で `processing.updatedAt` が 10 分より前の写真だけが拾われる（`IN` と、ISO 文字列の `<` の比較）。**`failed`・`none`・`done` の写真が拾われない**こと（コードでも同じ条件を見直すので、SQL が崩れても写真は変わらないが、ログの「止まっていた写真」の枚数で SQL の結果が分かる）
- 掃除の射影のクエリ（3-3b。5.9）: `SELECT c.id, c.tripId, c.blobName`（写真）と `SELECT c.id`（旅行）が全件を返す。文書のある写真の Blob が消されず、消えた旅行を指す写真だけが未所属に戻ることで確かめる（射影が欠けると、文書のある写真の Blob を孤児として消す）
- タイマーの登録とスケジュール（3-3b）: ポータルの「関数」に `requeueStalePhotos`・`sweepAlbum`（`app.timer` の第1引数）がある。`requeueStalePhotos` が 10 分ごとに、`sweepAlbum` が日本時間の午前3時（UTC 18 時）に走ったことを実行の履歴（ログの件数の行）で確かめる
- やり直しの受付のルート（3-3b）: ポータルの「関数」に `requestPhotoProcessing` があり、`POST /api/photos/{photoId}/process` が 202 を返し、写真の `processing.state` が `pending` → `done` に進む
- 識別に回すスクリプトのクエリ（4-1b。[04 §5](./04_data_design.md#5-クエリ) の 5.11）: デプロイ後、`--apply` を付けずに回し（`api/README.md`「手で回すスクリプト」）、出た対象の枚数が、ポータルのデータエクスプローラーで数えた「`done`・`category` が `plant` / `food` / `landscape`・`identification` が `null`」の写真の枚数と合う（`IS_NULL(c.identification)` と `ARRAY_CONTAINS(@kinds, c.category)`。コードでも同じ条件を見直すので、SQL が崩れても書き換える写真は変わらないが、多く拾えば読む RU が、少なく拾えば識別の漏れが出る）。`--apply` の後 10〜20 分で、待ちにした写真が `identifying` → `done`（`step: "identify"`）に進む
- 図鑑の項目一覧のつなぎ目（4-2a。[04 §5](./04_data_design.md#5-クエリ) の 5.6・[05 §5.14](./05_api_design.md#514-図鑑段階4)）。偽物は SQL の絞り込み・集計・並びを解釈せず、純粋な関数のテストには行を直接渡しているので、次はデプロイ後にしか確かめられない
  - 関数の登録: ポータルの「関数」に `listCatalogKinds`・`listCatalogEntries`（`app.http` の第1引数）があり、`GET /api/catalog/kinds` が定義表の3種類を返す
  - 種類での絞り込み（`c.identification.kind = @kind`・`matchesKind = true`）: `GET /api/catalog/entries?kind=plant` に食べ物・風景の写真の名前が混ざらない。`kind=food`・`kind=landscape` も同じ。
    同じ名前が別の種類にもあれば、それぞれの種類で別の項目になり枚数も分かれる。識別で「分類と合わない」（`matchesKind: false`）になった写真は、どの項目にも数えられない
  - 枚数の集計（`GROUP BY c.identification.name`・`COUNT(1)`）: 各項目の `photoCount` が、ポータルのデータエクスプローラーで数えたその種類・その名前の写真の枚数と合い、`total` が名前の数と合う。`null` の鍵の行が項目に出ない
  - 名前順とページの切り方: `limit` を省くと `min(50, total)` 件（既定 50 件）。項目が少ないうちは `limit=2` で `offset` を 0・2・4…とめくり、名前の符号単位の順で重複・欠落が無く、最後のページの先は `[]` で `total` が変わらない
  - 表紙の URL: `coverThumbnailUrl`（SAS 付き）をブラウザで開いて画像が出る（サムネイルの無い写真が見出しなら原寸）。期限（60 分）を過ぎると 403
  - 見出しの選び方（複合インデックスでの `TOP 1 … ORDER BY c.identification.confidence DESC, c.identification.at DESC`）: 同じ名前の写真が2枚以上ある項目で、`confidence`・`description` と表紙が、
    データエクスプローラーで見たその名前の写真のうち `identification.confidence` が最も高いもの（同点なら `identification.at` が新しいもの）と一致する。複合インデックスが無いと 400 になる（推測）ので、500 `図鑑の一覧の取得に失敗しました` が出たら 4-0 の apply を確かめる
- 図鑑の項目の詳細のつなぎ目（4-2b。[04 §5](./04_data_design.md#5-クエリ) の 5.7・[05 §5.14](./05_api_design.md#514-図鑑段階4)）。偽物は `ORDER BY`・`COUNT`・`matchesKind` を解釈しないので、次はデプロイ後にしか確かめられない
  - 関数の登録: ポータルの「関数」に `getCatalogEntry`（`app.http` の第1引数）があり、`GET /api/catalog/entry?kind=plant&name=<一覧に出た名前>` が 200 で `entry` を返す（404 なら `app.ts` の import 忘れ）
  - 見出しの選び方: 同じ名前の写真が2枚以上ある項目で、`entry` の `confidence`・`description`・表紙が、項目一覧（`GET /api/catalog/entries`）の同じ項目と一致し、データエクスプローラーで見たその名前の写真のうち `identification.confidence` が最も高いもの（同点なら `identification.at` が新しいもの）と一致する
  - 枚数（`SELECT VALUE COUNT(1)`）: `entry.photoCount` が数（オブジェクトや配列でない）で、項目一覧の同じ項目の `photoCount` と、`continuationToken` が `null` になるまでめくった `photos` の枚数の合計と合う
  - 絞り込み（`@kind`・`matchesKind = true`・`@entryName`）: 別の種類の同じ名前の写真と、`matchesKind: false` の写真が `photos` に混ざらない
  - 写真の並びとページ（`ORDER BY c.sortAt ASC`）: `limit=2` で `continuationToken` をめくり、撮影日時順（撮影日時の無い写真はアップロード日時（日本時間）の位置）で重複・欠落が無い。別の名前の項目のトークンを渡すと 400 `継続トークンの形式が無効です`（Cosmos が 400 で拒むかは推測。500 になったら §5.14 の 6 を見直す）
  - 名前の URL エンコード: `/`・`?`・`#`・`&`・`+`・空白を含む名前（例「サーモン/イクラ丼」。そうした名前の写真が無ければ、データエクスプローラーで写真の `identification.name` を一時的に書き換えて作り、終わったら戻す）を、アプリと同じく `Uri.encodeQueryComponent()`（`curl` なら `--data-urlencode name=… -G`）で載せて開き、その項目が返る（`entry.name` が書き換えた名前と一致する）
  - 表紙と写真の URL: `entry.coverThumbnailUrl` と `photos` の `imageUrl` / `thumbnailUrl` をブラウザで開いて画像が出る
- Patch の `condition`（コメントは担当の条件と `(IS_NULL(c.commentSource) OR c.commentSource = "ai")` の `AND`。4-1a。偽物は条件を自前で評価している）: 写真にコメントを書いてからやり直しを頼み、結果でコメントが置き換わる（受付で消しているため）。写真を送った直後（自動の解析中）にコメントを書き、解析が終わっても利用者のコメントが残る。解析中にタグ・旅行を変えても結果と両方残る
- 永遠に回り続けないこと: AI が必ず失敗する入力（例: 分類のスキーマ検証に通らない応答を返すモック、または壊れた画像）で 3 回失敗した写真が `failed` になり、タイマーが 10 分×数回走っても再投入されない。「やり直す」でもう一度 3 回だけ試す
- キューの直列化（`batchSize: 1`）と poison の挙動（AI が 3 回失敗した写真は、3 回目でワーカーが `failed` にして例外を投げないので poison には落ちず、アプリに「やり直す」が出る。担当の前に 3 回失敗したメッセージ（写真の読み取りの失敗など）だけが `photo-processing-poison` に落ちる。poison の中身には触らない。[06 §5](./06_processing_design.md#5-失敗と再試行のまとめ)）
- 関数の登録とキューのつながり（3-3a）: ポータルの「関数」に `processPhoto`（`app.storageQueue` の第1引数）がある。写真を1枚送り、`GET /api/photos/{photoId}` の `processing.state` が `done`・`category` が入る（投入の本文の base64・キューの名前・接続（`AzureWebJobsStorage`）は偽物では確かめられない。本文が読めなければ `photo-processing-poison` に落ち、写真は `pending` のまま）
- 担当の `condition`（`FROM c WHERE c.processing.state = "pending" AND c.processing.step = "<読んだ step>" AND c.processing.attempts = <読んだ回数> AND c.processing.updatedAt = "<同じときの processing.updatedAt>"`）が、実環境で `pending` でない写真と回数の違う写真に 412 を返す（偽物は条件を自前で評価している）。
  結果・失敗の `condition`（`state = "classifying"`（識別は `"identifying"`）`AND step = <step> AND attempts = <担当した回数> AND updatedAt = <担当したときの時刻>`）と再投入のタイマー・識別に回すスクリプトの `condition`（`state = "<読んだ state>" AND step = <読んだ step> AND attempts = <読んだ回数> AND updatedAt = <読んだ時刻>`）も同じ形なので、担当の確認で併せて確かめたことにしてよい。
  分類の間にやり直しを頼んだ写真が、やり直しの手がかり付きの結果になる（古い結果で上書きされない）
- 10 枚のトークン使用量の実測（[06 §6](./06_processing_design.md#6-費用の抑え方)）。容量は今のまま（150）でよく、下げるかの判断材料にする
- 図鑑の1種類の1ページを開く RU と時間の実測（4-2a のデプロイ後。識別済みの枚数・項目の数と一緒に `docs/09_backlog.md` へ。[04 §3.1](./04_data_design.md#31-項目は写真からまとめる) の見積もりと比べる）。
  API は RU をログにも応答にも出さないので、次の手順で測る
  1. 時間: `GET /api/catalog/entries?kind=<一番写真の多い種類>`（`limit` は省いて既定の 50 件）を続けて数回呼び、2回目以降の応答時間（`curl` の `-w '%{time_total}'` など）を記録する（1回目はコールドスタートを含むので分けて書く）
  2. RU（クエリごと）: ポータルのデータエクスプローラーで [04 §5.6](./04_data_design.md#56-図鑑のまとめ段階4) の 1（`GROUP BY`）と 3（`TOP 1`。パラメータを実際の値に置き換え、1項目分）を回し、「Query Stats」の Request Charge を読む。1ページの RU ≒ 1 の RU + 3 の RU × ページの項目数
  3. RU（全体の確かめ）: 他の処理が動いていない時間（再投入のタイマーは 10 分ごとに走る）に `GET /api/catalog/entries` を1回だけ呼び、Cosmos のメトリック「Total Request Units」（1 分粒度）の増分が 2 の見積もりと大きく違わないかを見る
  4. 目安（[04 §3.1](./04_data_design.md#31-項目は写真からまとめる)）: 1ページの体感が 3 秒以上なら「まとめの控え」を考える
- 掃除のタイマー: `photos` に文書の無い Blob（名前は小文字16進 64 文字 + `.jpg`）を手で置き、置いてから1日たった後の最初の午前3時の回で消えている（それより前の回では、1日たっていないので残す）。文書のある Blob と、置いたばかりの Blob は残る
- 旅行の削除中に送信: 数百枚の旅行の削除を押した直後に同じ旅行へ送信し、残った写真が消えておらず（ポータルで文書と Blob を確認）、掃除のタイマーの翌日に未所属に出る（[04 §7.3](./04_data_design.md#73-旅行の削除と重なった送信move)）
- カメラの権限を外した後の写真の追加（2026-10-22。[02 §5](./02_design_overview.md#5-人間に決めてもらう点推奨付き) #38・[03 §6.4](./03_screen_design.md#64-植物図鑑の廃止に伴う画面の削除)）: `AndroidManifest.xml` から `android.permission.CAMERA` を外した版を実機（SC-03K）に入れ、旅行詳細の「写真を追加」で写真の選択画面が開き、複数選んで送れて、撮影日時・位置情報・地名が外す前と同じに出る（マニフェストは単体テストに現れないので手で確かめる）。権限の一覧（端末の設定のアプリ情報）にカメラが出ない


### 5.4 段階5（タイムライン）で足すもの

- クエリ（[04 §5](./04_data_design.md#5-クエリ) の 5.12〜5.15）: 旅行1つ分の写真の射影が控えになり、撮影日時の無い写真が「日時なし」に入る。写真の id と解析の状態のクエリ（5.13。5-1c で `{ "state": c.processing.state } AS processing` のオブジェクトの射影を足した）で、増えた・消えた枚数が合い、解析中の写真の数が `pendingPhotoCount` に出る（`none`・`failed` は数えない。オブジェクトの射影が実環境で `{ processing: { state } }` の形で返らないと、解析中の枚数が 0 になる。偽物は SELECT を解釈しないので、ここだけは手で確かめる）。止まった下書きを再投入のタイマーが積み直す
- 区切り案と文の質（デプロイ後に、実際の旅行1つで）: 食事・食べ歩き・店内の写真がそれらしく区切られるか。見出しと一言が手がかりや判断の過程に触れていないか。渡していないことを作っていないか。気になった例は `docs/09_backlog.md` に記録して、プロンプトの要素を見直す
- トークン使用量と時間の実測（[06 §8.5](./06_processing_design.md#85-費用)）: 写真の多い旅行で、区切り案・文それぞれの入力・出力のトークンと、押してから表示まで
- 日の区切り: 深夜（0〜4時）に撮った写真が前の日に入る。`TIMELINE_DAY_START_HOUR` を `0` にして作り直すと、日付どおりに分かれる
- 作り直し: 区切りと文を手で直してから写真を1枚足して作り直し、確かめている間も完成版が出ている。書き終えると、直した区切りと文（同じ日・同じ場面のもの）が残り、残せなかった文が知らされる。途中で「やめる」と完成版のまま
- 使われなくなった控え: 作り直しを書き終えた後・やめた後に、ポータルで前の `timeline-photos-<tripId>-…` が消えている（失敗はログだけなので、残っていても害は無い）
- 旅行の削除でタイムラインと控えも消える（ポータルで `timeline-<tripId>`・`timeline-photos-<tripId>-…` が無い）
- 関数の登録（5-1a）: ポータルの「関数」に `createTimeline`・`getTimelineDraft`・`deleteTimelineDraft`（`app.http` の第1引数）がある（404 なら `app.ts` の import 忘れ）。`GET /api/trips/{tripId}/timeline/draft` と `DELETE` が同じルートで別の関数に届く
- 関数の登録（5-1c）: ポータルの「関数」に `getTimeline`・`putTimelineDraftScenes` がある。`GET /api/trips/{tripId}/timeline` と `POST` が同じルートで別の関数に届き、`PUT …/timeline/draft/scenes` が `…/timeline/draft` の関数に取られない
- 書き込みの条件（5-1a。偽物は `_etag` の IfMatch と patch の `condition` を自前で評価している）: 実環境で、既にタイムラインがある旅行で作り直す（`POST …/timeline`）・やめる（`DELETE …/timeline/draft`）が 202 / 200 で通る（読んだ `_etag` の渡し方が違えば、重なっていなくても常に 409 `TIMELINE_STATE_CONFLICT` になる）。区切りの保存（`PUT …/draft/scenes`。5-1c）も同じく、確かめ中の下書きで 200 になる。
  再投入のタイマーの patch の `condition`（`c.draft.id = "<id>" AND c.draft.job.state = … AND c.draft.job.updatedAt = …`。入れ子の項目）が実環境で通る: ワーカーが無い間（5-1b のデプロイ前）に作ると下書きが `pending` のまま止まるので、10〜20 分後のタイマーの回で、ログの「止まっていたタイムラインの下書き」の件数に出て、下書きの `job.updatedAt` が進む（`attempts` を増やすのはワーカーなので、ワーカーが無い間は `failed` にならず、10 分ごとに積み続けてキューにメッセージが溜まる。確かめたら下書きをやめる）
- ワーカー（5-1b）: ポータルの「関数」に `processTimeline`（`app.storageQueue` の第1引数）がある（無ければ `app.ts` の import 忘れで、`timeline-processing` にメッセージが溜まる）。作る（`POST …/timeline`）と、数十秒で `GET …/timeline/draft` が `reviewing` になり日と場面が出る（ログに「タイムラインの区切り案が済みました」）。
  担当の patch の `condition`（`c.draft.id`・`c.draft.job.*` の入れ子の項目）と結果の IfMatch の置き換えが実環境で通る（通らなければ、担当できずに何もしないか、結果を書けずに4回重なった内部の失敗として `lastError: "internal"` になる）。
  `AZURE_OPENAI_TIMELINE_DEPLOYMENT_NAME` が無い今の設定で、文字だけの要求（画像のパートが無い）が今のデプロイで 400 にならずに通る
- 関数の登録（5-2a）: ポータルの「関数」に `postTimelineDraftWrite` がある。`POST …/timeline/draft/write` が `…/timeline/draft` の関数に取られない
- 文（5-2a）: 確かめ中の下書きで `POST …/draft/write` を押すと、数十秒で `GET …/timeline` に完成版が出て下書きが消える（ログに「タイムラインの文が済みました」）。文の要求（`timeline_texts` のスキーマ、`max_completion_tokens` 16,000）が今のデプロイで 400 にならずに通る。作り直しを書き終えた後に、前の `timeline-photos-<tripId>-…` が消えている（上の「使われなくなった控え」）
- 関数の登録（5-2b）: ポータルの「関数」に `postTimelineRecut`・`patchTimelineDay`・`patchTimelineScene`・`deleteTimelineDroppedEdits` がある。`POST …/timeline/recut`・`DELETE …/timeline/dropped-edits` が `…/timeline/draft` などほかの関数に取られない
- 書き込みの条件（5-2b）: 実環境で、完成版のある旅行で区切りを直し始める（`POST …/recut`）・文を直す（`PATCH …/days/{date}`・`…/scenes/{photoId}`）・残せなかった文を閉じる（`DELETE …/dropped-edits`。残せなかった文があるときだけ書く）が、重なっていなければ 200 で通る（IfMatch の渡し方が違えば常に 409）

CLAUDE.md の「Cosmos のクエリを変更したら手で確認する」は、旅行アルバムの項目としてこの節を指す（クエリを変えたら、ここの該当する行を手で確かめる）。
