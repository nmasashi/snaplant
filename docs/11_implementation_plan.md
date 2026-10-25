# 旅行アルバム 実装計画

## この文書の位置づけ

旅行アルバムを段階ごとに実装する手順を書く。段階2の PR 分割（順序・依存・完了条件・回すレビュー）、段階3・4の PR の骨格、
Issue の切り方、最初に実機で確かめることをまとめる。**未実装を含む計画**で、進み具合は Issue #22 で追う（ここには書かない）。

PR の粒度・レビュー・Issue の基準は CLAUDE.md（「PR と Issue の運用」「レビューのタイミング」）に従う。
各 PR の中身は [05_api_design.md](./05_api_design.md)・[03_screen_design.md](./03_screen_design.md)・[07_infrastructure_design.md](./07_infrastructure_design.md)、
テストリストの元は [08_test_plan.md](./08_test_plan.md) を参照する。行数は推測。

---

## 1. 進め方の原則

- **1作業単位 = 1 PR、差分は 2,000 行以内。** 溜めない。`main` へのマージは本番デプロイを起動する
- **TDD（List → Red → Green → Refactor）。** List は [08 §3・§4](./08_test_plan.md#3-段階2のシナリオ一覧api) から作る。List・Red・Green・Refactor ともメインセッション（2026-10-17 に test-writer を使わない形に変えた）
- **レビューは作業単位ごとに 1 回**（テストリストが空になった時点）。`/code-review` は常に、`test-reviewer` はテストを書いた PR、`contract-auditor` は外から観測できる振る舞いを変えた PR、`/security-review` は入力・ストレージ・外部通信を触った PR
- **設計書は都度直す。** 開発中に設計と実装が食い違ったら、同じ PR で `docs/` の設計書を直す。実装した節には「実装済み」の印を付け、API を変えたら `README.md` のエンドポイント表も直す（2026-10-25 に旅行アルバムの設計一式を `docs/` 直下に移し、以前の「後でまとめて取り込む」はやめた。人間が決定）
- **デプロイの順序**: インフラ（apply）→ API（マージ）→ アプリ（実機）。[07 §5](./07_infrastructure_design.md#5-cicd-への影響)
- **`mobile/` の PR はマージ前に `flutter analyze` / `flutter test`。** 新規の指摘が無いことを一覧で突き合わせる（件数ではなく）
- **積まない（stacked PR を避ける）。** 前の PR がマージされてから次を切る。やむを得ず積むなら、マージ先が `main` に戻っているか確認する（`MEMORY.md` の教訓）

## 2. 段階2の PR 分割

| # | 内容 | 行数 | 依存 | 完了条件 | レビュー |
|---|---|---|---|---|---|
| 1 | **infra**: Blob Storage の `photos` コンテナ（画像ファイル）、`temp-images` のライフサイクル、Cosmos DB の `album` コンテナ（旅行・写真の情報。PK `/id`）、`app_settings`、`outputs`（[07 §1](./07_infrastructure_design.md#1-段階2)） | ~150 | — | `terraform fmt`・`validate` が緑。**人間がポータルで無料枠を確認してから apply**。ポータルで `photos` が非公開 | `/code-review medium`、`/security-review`（公開設定・ライフサイクルの接頭辞） |
| 2 | **api の土台**（実装済み）: PR 3 から使う小さな部品（`ErrorCode.TRIP_NOT_FOUND`、`createNotFoundError(message, code)` の `code` を必須に、`isConnectivityError()` と errno の一覧 `UNREACHABLE_ERRNOS` の共有）と、`utils/blobSas.ts` の切り出し（`generateTempSasUrl()` は Blob 名の取り出し・有効期限の計算・失敗の扱いを持ち、署名は `generateReadSasUrl()`）。**定数（`TRIP_` / `PHOTO_` など）・`types/album.ts`・`constants/album.ts`・差し替え部品の拡張・写真用の SAS の方針（60 分・`startsOn`・`urlExpiresAt`）は、使う PR（3 以降）でテストから足す**（2026-10-12。使われない部品を先に作らない） | ~300 | — | 既存テスト全緑（**SAS の切り出し後も `storageService.test.ts` と `upload.test.ts` が通る**）。`isConnectivityError`・`createNotFoundError` のテスト | `/code-review high`（既存の `upload` に触る）、`test-reviewer` |
| 3 | **api: 旅行**（実装済み）: `POST` / `GET /api/trips`・`GET` / `PUT /api/trips/{tripId}`（`trips.ts`・`tripDetail.ts`）、`AlbumService`（旅行の作成・取得・更新・一覧）、`albumQueries.ts`（集計の SQL。テストしない）、`tripSummaries.ts`（集計の行から `TripSummary` と未所属の枚数を組み立てる純粋関数。`albumQueries` を差し替えずに単体で確かめる）、`utils/tripInput.ts`（POST と PUT のボディの検証）、`createDatabaseErrorResponse()`。**旅行の削除は 4b、表紙（`coverThumbnailUrl`）は 4a に回した**（削除は `deletePhotos` が必須の契約なので写真の API と一緒に作る。表紙は写真の SAS が要る） | ~1,500 | 2 | TDD のリストが空。設計書（05）と一致。デプロイ後に `GET /api/trips` と `GROUP BY` の集計（`null` の鍵・`MIN` / `MAX`）を手で確認 | `/code-review high`、`test-reviewer`、`contract-auditor` |
| 4a-1 | **api: 写真の保存と1枚の取得**（実装済み）: `POST /api/photos`（`photos.ts`。検証は `utils/photoInput.ts`、ハッシュの照合・`sortAt`・再送と競合は 200・Blob→create・Blob の失敗は 502 / 503）、`GET /api/photos/{photoId}`（`photoDetail.ts`）、`PhotoStorageService`（上書きアップロードと SAS。発行の5分前から有効）、`photoView.ts`（応答の形）。4a を2つに分けた（差分を 2,000 行以内に収めるため） | ~1,900 | 3 | 同上。デプロイ後に SAS で表示できること、応答に `_rid` が無いこと | `/code-review high`、`test-reviewer`、`contract-auditor`、`/security-review`（multipart・ハッシュ・SAS） |
| 4a-2 | **api: 写真の一覧・削除と旅行の表紙**（実装済み）: 旅行の表紙（`coverThumbnailUrl`。旅行ごとの `TOP 1` と写真の SAS。PR 3 から持ち越し）、`GET /api/photos`（`tripId` / `none`。`none` は同じ SQL に `@tripId = null`。`ORDER BY c.sortAt` と継続トークンのページ、SAS。`total` の有無と継続トークンの受け渡し方は着手時に決める [02 §5](./02_design_overview.md#5-人間に決めてもらう点推奨付き) #27）、`DELETE /api/photos/{photoId}`、設計書（05）の食い違いの修正 | ~1,500 | 3 | 同上。デプロイ後に SAS で表示できること、応答に `_rid` が無いこと、300 枚をページでめくって重複・欠落が無いこと | `/code-review high`、`test-reviewer`、`contract-auditor`、`/security-review`（multipart・ハッシュ・SAS・継続トークンの受け渡し） |
| 4b | **api: 出し入れと更新**（実装済み）: `POST /api/photos/move`、旅行の削除（`DELETE /api/trips/{tripId}` そのものを足す。PR 3 から持ち越し。`deletePhotos=true\|false` は必須。写真を消す／未所属に patch してから旅行を消す。消した後の見直しは無し [04 §7.3](./04_data_design.md#73-旅行の削除と重なった送信move)）、`PATCH /api/photos/{photoId}`（`comment`・`tags` の構造だけ）、設計書（05）の食い違いの修正 | ~800 | 4a | 同上。デプロイ後に `/api/photos/move` のルートと 300 枚の move（1回200枚までなので2回に分ける）、両方の削除を手で確認 | `/code-review high`、`test-reviewer`、`contract-auditor` |
| 5 | **mobile: 土台**（実装済み）: `AppRoot`（設定の読み込み・`ApiService` の置き場）、`HomeShell`（2 タブ）、`PlantListScreen` が `ApiService` を受け取る形に、旅行タブは仮の画面。**`UploadQueue` は使う PR 7 で足す**（使われない部品を先に作らない） | ~800 | 2 以降いつでも | **図鑑の既存の動きが変わらない**（既存の画面テストが通る。実機で起動・一覧・設定を確認）。`flutter analyze` に新規の指摘なし | `/code-review high`（既存の画面に触る）、`test-reviewer` |
| 6a | **mobile: 旅行**（実装済み）: `Trip` / `TripSummary` モデル、`ApiService` の旅行のメソッド、旅行一覧（先頭に旅行に属さない写真の枚数）・作成・旅行詳細の見出し・編集・削除（写真をどうするかのダイアログ） | ~1,800 | 3・4b（API がデプロイ済み） | 実機で旅行の作成・一覧・編集・両方の削除 | `/code-review high`、`test-reviewer` |
| 6b | **mobile: 写真の表示**（実装済み）: `Photo` モデル、`getPhotos`（ページ）、旅行詳細の `PhotoGrid` と下端での続きの読み込み、旅行に属さない写真の画面、`cacheKey` と `CacheManager` | ~1,000 | 4a・6a | 実機で写真の表示とページ（API 側で手で入れた写真） | `/code-review high`、`test-reviewer` |
| 7 | **mobile: 送信**: `pickMultiImage`、`photo_metadata`（EXIF・SHA-256・サムネイル）、Geocoder、`UploadQueue`、進み具合バナー、写真ビューア、`ApiService.uploadPhoto` / `deletePhoto` | ~1,800 | 4a・6 | **最初にハッシュの決定性を実機で確認。** 300 枚の送信が完走し、実測を `docs/09_backlog.md` に記録 | `/code-review high`、`test-reviewer`、`/security-review`（ファイル・位置情報の扱い） |
| 8 | **mobile: 複数選択**: 選択モード、旅行に入れる（旅行を選ぶダイアログ）、旅行から外す、まとめて削除、`ApiService.movePhotos` | ~800 | 4b・7 | 実機で 100 枚の出し入れ | `/code-review high`、`test-reviewer` |

順序: 1 → 2 → 3 → 4a → 4b（API の列）。5 は 2 以降いつでも、6 は 4b の後（旅行の削除のダイアログが `deletePhotos` を要るため）、7 は 4a の後、8 は 4b の後。
API と mobile の列は並行できるが、**同時に進めるなら別のブランチで、積まない**。


**PR 7 は5つに分ける**（2026-10-14 に3つ、2026-10-15 に 7b の範囲が 2,000 行を超える見込みのため4つに、2026-10-16 に 7d の範囲が 2,000 行に近づく見込みのため5つに。PR 8 が試験込みで 1,800 行になったため、7 を1つにすると上限を超える見込み）。

| PR | 中身 |
|---|---|
| 7a | （実装済み）「写真を追加」→ `pickMultiImage` → 準備（SHA-256・EXIF の撮影日時と GPS）→ `UploadQueue`（同時2本）→ `POST /api/photos`、進み具合バナー（送信中・完了・失敗と「送り直す」「閉じる」）、送信が一区切りついたときの読み直し |
| 7b | （実装済み）送信の列の強化: 準備が済んだ順に送る（7a は全部を準備してから送り始める）と進み具合バナーの準備中の表示、自動の送り直し（0 / 429 / 503 を 2・4・8 秒）、404 `TRIP_NOT_FOUND`、200（送信済み・別の場所）、失敗の理由の文言（`ApiException.userMessage`） |
| 7c | （実装済み）サムネイル（`flutter_image_compress`）、地名（`geocoding`。minSdk 24・compileSdk 36 に上げる） |
| 7d | （実装済み）写真ビューア（§4.6）。開いた一覧と読み込み済みの写真を共有し、末尾で一覧に続きを読ませる。削除、戻ったときの読み直し |
| 7e | （実装済み）送信中・失敗の写真をグリッドの後ろに端末の画像として並べる（§4.4。ビューアで開けない・選べない）、送信中の写真がある旅行の削除の確認（§4.4）。旅行が無いと分かって「この旅行は削除されています」にした画面でも、その旅行宛ての進み具合バナーを出す（PR 7d の `/code-review` の指摘） |

### 各 PR の共通の完了条件

- `npm test`（api）/ `flutter test`（mobile）が緑、`npx tsc -p tsconfig.test.json --noEmit` が通る
- テストが固定している外から観測できる振る舞いが、この設計書一式に書かれている（食い違えば設計書を直す）
- PR 本文に `Closes #N`（閉じる Issue が無いなら理由を考える）
- 設計書（この一式）の該当節に「実装済み」の印

## 3. 段階3の PR の骨格

| # | 内容 | 依存 |
|---|---|---|
| 3-1 | （実装済み）infra: Storage Queue、予算アラート、`app_settings`（[07 §2](./07_infrastructure_design.md#2-段階3)。分類用のデプロイは当面足さず、今の `gpt6_luna` を使う）。`host.json` の `extensions.queues` と `http` の位置 | 段階2完了 |
| 3-2 | api: `OpenAIVisionService.analyze()` の一般化（`identifyPlant()` は残す）、`catalog/kinds.ts`（定義表と `OTHER_KIND`。段階3では分類の選択肢にだけ使う）、`PhotoClassifierService`（`tests/fakes/queue.ts` は使い始める 3-3 で足す） | 3-1 |
| 3-3 | 2,000 行に収めるため 3-3a・3-3b に分ける（2026-10-18） | 3-2 |
| 3-3a | api: `tests/fakes/queue.ts`（と Cosmos の偽物の条件付き patch）、`POST /api/photos` のキュー投入（`pending`・`step: "classify"`。投入に失敗しても 201）、ワーカー `processPhoto.ts`（分類だけ。写真の `processing.step` を見る。担当は `state = "pending"` の条件付き patch。結果は AI の担当の欄だけの patch。段階3は分類の後すべて `done`。[04 §7.4](./04_data_design.md#74-ワーカーの書き込みの決まり)）。3-2 の `tests/services/photoClassifier.test.ts` をワーカーのテストへ寄せて消し、CLAUDE.md の名簿の期限付きの行も消す（作業単位の終わりの test-consolidator に頼む） | 3-2 |
| 3-3b | （実装済み。Issue #71）api: タイマー `requeueStalePhotos.ts`（10 分ごと。`failed` は拾わない。処理中の写真は `pending` に戻してから投入する。読んだときの `state`・`attempts` の条件付き patch。[06 §1.1](./06_processing_design.md#11-構成)）・`sweepAlbum.ts`（日本時間の午前3時。[04 §7.2](./04_data_design.md#72-掃除のタイマー段階3)）、`POST /api/photos/{photoId}/process`（受付でコメントを消し `attempts` を 0 に。投入に失敗しても 202。`hint` を分類の AI に渡す。ワーカーの結果・失敗の書き込みは、担当したときの `state` と `attempts` の条件付きにした（やり直しの受付と重なったとき、古い処理の結果でやり直しを上書きしないため。[05 §5.7](./05_api_design.md#57-post-apiphotosphotoidprocess段階3)））、`GET /api/photos?category=`。デプロイ後に 10 枚の実測を記録する（容量は今のまま。[06 §6](./06_processing_design.md#6-費用の抑え方)）と、[08 §5.3](./08_test_plan.md#53-段階34で足すもの) の手での確認 | 3-3a |
| 3-4 | 2,000 行に収めるため 3-4a・3-4b に分ける（2026-10-18） | 3-3 |
| 3-4a | （実装済み。Issue #71）mobile: 写真ビューアのカテゴリと分類の状態（`failed` と「やり直す」）、やり直しダイアログ、サムネイルの分類の印（[03 §5.1・§5.4・§5.5](./03_screen_design.md#5-段階3の画面骨格)）。カテゴリの表示名は段階3ではアプリが持つ | 3-3 |
| 3-4b | （実装済み。Issue #71）mobile: 旅行詳細画面のカテゴリの絞り込み、カテゴリ横断画面（[03 §5.2・§5.3](./03_screen_design.md#5-段階3の画面骨格)）、`getPhotos` の `category`（[05 §8](./05_api_design.md#8-クライアントmobilelibservicesapi_servicedartに足すメソッド)）。カテゴリの一覧は段階3ではアプリが持つ。カテゴリ横断画面は 2026-10-24 に消した（02 §5 #40） | 3-4a |
| 3-5 | （見送り。2026-10-18 に人間が判断）api + infra: Azure Maps の `GeocodingService` と `geocache` | 実機確認で Geocoder が不十分だったとき |

## 4. 段階4の PR の骨格

| # | 内容 | 依存 |
|---|---|---|
| 4-0 | （定義済み。apply は人間）infra: `album` に複合インデックス（`/identification/confidence`, `/identification/at` の降順。[07 §3.1](./07_infrastructure_design.md#31-図鑑の前に足すもの複合インデックス)）。人間が apply。**4-2 より先** | 段階3完了 |
| 4-1 | 2,000 行に収めるため 4-1a・4-1b に分ける（2026-10-18） | 段階3完了 |
| 4-1a | （実装済み）api: 定義表からの識別スキーマ生成、`PhotoIdentifierService`、ワーカーの `identify` ステップ（写真の `identification` への patch だけ。項目の文書は無い。[06 §3.2](./06_processing_design.md#32-書き込み)）、分類の後の `identification` のクリアと `step: "identify"` の投入、Cosmos の偽物のコメントの条件 | 段階3完了 |
| 4-1b | （実装済み。デプロイ後の実測とスクリプトの実行は人間）api: `POST /api/photos/{photoId}/process` の `step: "identify"`（[05 §5.7](./05_api_design.md#57-post-apiphotosphotoidprocess段階3) の 8）、段階3で分類まで済んだ写真を識別の待ちにする一度だけのスクリプト `api/src/scripts/enqueueUnidentified.ts`（人間が実行。積むのは再投入のタイマー。[06 §1](./06_processing_design.md#1-キューとワーカー段階3)・[02 §5](./02_design_overview.md#5-人間に決めてもらう点推奨付き) #30）。デプロイ後に識別の実測を記録 | 4-1a |
| 4-2 | 2,000 行に収めるため 4-2a・4-2b に分ける（2026-10-18） | 4-0・4-1 |
| 4-2a | （実装済み。デプロイ後の手での確認と実測は人間）api: `GET /api/catalog/kinds` と `GET /api/catalog/entries`（項目一覧）。集計の SQL は `catalogQueries.ts`（テストせず手で確かめる）、行から項目のページを組み立てる所は `catalogEntries.ts`（純粋な関数。`tripSummaries.ts` と同じ分け方）。`AlbumService` は Cosmos の設定（`COSMOS_DB_ENDPOINT`・`COSMOS_DB_KEY`・`COSMOS_DB_DATABASE`・`COSMOS_DB_ALBUM_CONTAINER`）が無い・空白だけなら、足りない設定の名前を言って止まる。デプロイ後に [08 §5.3](./08_test_plan.md#53-段階34で足すもの) の図鑑の項目一覧のつなぎ目を手で確かめ、1種類の1ページを開く RU と時間を実測して記録（[04 §3.1](./04_data_design.md#31-項目は写真からまとめる) の見積もりと比べる。手順は 08 §5.3） | 4-0・4-1 |
| 4-2b | （実装済み。デプロイ後の手での確認は人間）api: 図鑑の API（まとめ方は `GROUP BY` + 項目ごとの `TOP 1`。[04 §5.6](./04_data_design.md#56-図鑑のまとめ段階4)。API の形は [05 §5.14](./05_api_design.md#514-図鑑段階4)（2026-10-18 に決定。[02 §5](./02_design_overview.md#5-人間に決めてもらう点推奨付き) #20））のうち `GET /api/catalog/entry`（項目の詳細と写真のページ）。見出しは 4-2a の `queryCatalogHead()`、枚数は `SELECT VALUE COUNT(1)`（`catalogQueries.ts`）、写真のページは `AlbumService.listPhotos()` に項目（種類・名前）の絞り込みを足して使う。デプロイ後に [08 §5.3](./08_test_plan.md#53-段階34で足すもの) の図鑑の項目の詳細のつなぎ目を手で確かめる | 4-2a |
| 4-3 | 2,000 行に収めるため 4-3a・4-3b・4-3c に分ける（2026-10-18） | 4-2 |
| 4-3a | （実装済み）mobile: 3つ目のタブ「図鑑（新）」・種類のタブ・項目の一覧（[03 §6.1](./03_screen_design.md#61-図鑑タブ種類タブ--項目一覧)）、`ApiService` の `getCatalogKinds`・`getCatalogEntries`。「その他」を旅行詳細のチップ・カテゴリの一覧・写真ビューアから外す（[02 §5](./02_design_overview.md#5-人間に決めてもらう点推奨付き) #33） | 4-2 |
| 4-3b | （実装済み）mobile: 項目詳細（[03 §6.2](./03_screen_design.md#62-図鑑の項目詳細画面)。見出しと写真のページ）、`getCatalogEntry`。`PhotoGrid` がページを読む先を外から渡せる形にする（`loadPage`。読み込み中と失敗の文言も画面ごとに渡す）。信頼度のバッジを `widgets/confidence_badge.dart` にまとめる（一覧の行と共用） | 4-3a |
| 4-3c | （実装済み）mobile: 写真ビューアのコメント編集・項目へのリンク・分類と合わない写真（[03 §6.3](./03_screen_design.md#63-写真ビューアへの追加)）、`PATCH` の呼び出し、解析の状態の表示を `step` で分ける、やり直しダイアログで `step` を選べる（02 §5 #32） | 4-3b |
| 4-3（元の行） | mobile: 図鑑画面（一時的な3つ目のタブ「図鑑（新）」に置く。[03 §6.1](./03_screen_design.md#61-図鑑タブ種類タブ--項目一覧)。種類タブ・項目一覧（`offset` でページ）・項目詳細（写真はページ）。項目は `kind` と `name` で開く）、写真ビューアのコメント編集と項目へのリンク、`PATCH` の呼び出し、解析の状態の表示を `step` で分ける（「識別中...」「識別に失敗しました」。[03 §5.1](./03_screen_design.md#5-段階3の画面骨格)）、やり直しダイアログで `step`（「カテゴリから」/「名前だけ」）を選べる（[03 §5.4](./03_screen_design.md#5-段階3の画面骨格)。2026-10-18 に決定。[02 §5](./02_design_overview.md#5-人間に決めてもらう点推奨付き) #32） | 4-2 |
| 4-4 | （実装済み。ただし旧図鑑の植物は移さないと決めたので回さず、4-6 で消した。2026-10-19、02 §5 #34）api: 移行スクリプト `api/src/scripts/migratePlants.ts`（[06 §7](./06_processing_design.md#7-今の植物図鑑の統合と廃止段階4) 手順 2。[06 §7.1](./06_processing_design.md#71-移行スクリプト手順-2削除した)。`plants` の記録を写真の `identification` に移すだけ）。写真の文書に `legacyPlantId`（4-6 で消した）。手で回すスクリプトの設定の読み込みと宛先の表示は `api/src/scripts/scriptSettings.ts` にまとめた（`enqueueUnidentified.ts` と共有していた） | 4-3 |
| 4-5 | （実装済み）mobile: 図鑑タブの差し替え（3つ目のタブ「図鑑（新）」を消す。起動時のタブが図鑑になり、起動するとすぐ種類の一覧を読む。[03 §4.1](./03_screen_design.md#41-ホーム下のタブ)）、植物専用の画面・モデル・メソッド・テストの削除（手順 4。[03 §6.4](./03_screen_design.md#64-植物図鑑の廃止に伴う画面の削除)）。設定画面の接続テストの宛先を `GET /api/plants` から写真の一覧の1件（`GET /api/photos?category=plant&limit=1`）に変えた（4-6 で植物の API が消えても接続テストが通り、データベースに届くかまで確かめるように） | 4-4 の確認（旧図鑑の植物は移さないと決めたので、確認は待たない。02 §5 #34） |
| 4-6 | （実装済み）api: 植物専用の関数・サービス・型・テストの削除、移行スクリプトと `legacyPlantId` の削除、`app.ts`、`docs/06`・`07`・`README`（手順 5。消したものの一覧は [06 §7](./06_processing_design.md#7-今の植物図鑑の統合と廃止段階4) の手順 5） | 4-5 |
| 4-7 | （実装済み。apply は人間がマージの後に行う）infra: `images`・`temp-images`・`temp-images` のライフサイクル管理（`azurerm_storage_management_policy.main` ごと）・`plants`・関連 `app_settings`（`COSMOS_DB_CONTAINER`・`STORAGE_CONTAINER_NAME`・`TEMP_STORAGE_CONTAINER_NAME`）・`outputs` の削除（手順 6。[07 §3.2](./07_infrastructure_design.md#32-植物図鑑の廃止)）。`plan` で見るものも 07 §3.2 | 4-6 |

## 5. Issue の切り方（案）

CLAUDE.md「Issue を作る基準」: 作るのは「判断が済んでいて着手できる作業」で、担当や環境が分かれるもの・複数の PR にまたがるもの・前提になっているもの。
Issue は状態とポインタ、実体は設計書と `docs/09_backlog.md`。

| Issue | 種類 | 本文（ポインタ + 完了条件） | label |
|---|---|---|---|
| #22（既存） | ロードマップ | 段階ごとのチェックリスト。各段階の Issue へのリンク | — |
| 段階2: インフラの apply（PR 1） | 人間の作業 | [07 §1.4](./07_infrastructure_design.md#14-apply-の前に人間が確認すること) へのリンク。完了条件: 無料枠の確認、apply、`photos` が非公開 | `infra` |
| 段階2: API（PR 2〜4b） | 複数 PR | [05](./05_api_design.md) へのリンク。完了条件: 各 PR のマージと [08 §5.2](./08_test_plan.md#52-デプロイ後api段階2) の手での確認 | `api` |
| 段階2: アプリ（PR 5〜8） | 複数 PR | [03](./03_screen_design.md) へのリンク。完了条件: 各 PR のマージと `flutter analyze` の新規指摘なし | `flutter`, `windows` |
| 段階2: 実機確認 | 人間の作業 | [08 §5.1](./08_test_plan.md#51-実機sc-03k段階2) へのリンク。完了条件: 8 項目のチェックと `docs/09_backlog.md` への実測の記録 | `flutter`, `windows` |
| 段階2: 人間に決めてもらう点 | 判断 | **作らない。** `docs/09_backlog.md` の方針どおり、判断待ちは [02 §5](./02_design_overview.md#5-人間に決めてもらう点推奨付き) に置き、決まったら各 Issue に反映する | — |

- PR 本文には閉じる Issue を `Closes #N` で書く。複数 PR にまたがる Issue は最後の PR で閉じる（途中の PR は `Refs #N`）
- `docs/09_backlog.md` の「`upload` で AI の呼び出しが例外で失敗すると、一時保存した Blob が残る」の対処 2（ライフサイクル）は PR 1 で入る。
  バックログの該当項目のうち対処 2 の記述を削除するコミットに Issue 番号を書く（対処 1 は別作業として残す）
- 段階3・4の Issue は段階2が終わってから切る（設計が変わりうるため）

## 6. 最初に実機で確かめること

PR 7 の着手前（PR 6 のブランチでも可）に、**実装の前提**を実機で確かめる。順序はこのとおり。

1. **ハッシュの決定性**: `image_picker` の `pickMultiImage()`（画質 85・最大 1920px）で同じ写真を 2 回選び、SHA-256 が一致するか。
   一致しなければ `imageQuality` / `maxWidth` を外す（段階1の B で EXIF は残ることを確認済み）。結果は `docs/09_backlog.md` の「段階1の結果」の下に「段階2の結果」として記録
2. **`pickMultiImage()` の EXIF**: 段階1は `pickImage()` で確かめた。複数選択でも撮影日時・GPS が残るか
3. **端末の Geocoder**: SC-03K で `geocoding` パッケージが動くか、市区町村まで返るか、機内モードで止まらないか。
   動かなければ Azure Maps を段階3に繰り上げ（PR 3-5 を先に）、段階2は緯度・経度の表示だけにする
4. **写真の大きさ**: 1 枚の縮小後のバイト数（10MB の上限と、300 枚の送信時間の見積もりに使う）

ここで前提が崩れたら、該当する設計書の節（[02 §6](./02_design_overview.md#6-リスク)・[06 §4](./06_processing_design.md#4-地名への変換)）を直してから PR 7 に進む。

## 7. 段階2の完了の定義

- 要件定義書 §5.1・§5.1.1・§5.2・§5.3（段階2の印のもの）がすべて実機で動く
- [08 §5.1・§5.2](./08_test_plan.md#5-単体テストで確かめられず手で確かめる項目) の手での確認が済み、実測が `docs/09_backlog.md` に残っている
- CLAUDE.md の「実際のルート」の表と「Cosmos のクエリを変更したら手で確認する」の表が更新されている
- Issue #22 の段階2のチェックが埋まっている

## 8. 段階5（タイムライン）の PR の骨格

要件は [01 §5.3.1](./01_requirements.md#531-タイムライン)、決定は [02 §5](./02_design_overview.md#5-人間に決めてもらう点推奨付き) #41〜#47。
1 PR は差分 2,000 行以内。API を先に作り、画面は API ができてから足す（アプリが無くても API のテストで確かめられる）。

| # | 内容 | 依存 |
|---|---|---|
| 5-0 | （定義済み。apply は人間）infra: キュー `timeline-processing` と `app_settings` の `TIMELINE_QUEUE_NAME`（[07 §7](./07_infrastructure_design.md#7-段階5タイムライン)）。**apply は人間**（5-1 のデプロイより先） | — |
| 5-1 | 2,000 行に収めるため 5-1a・5-1b・5-1c に分ける（2026-10-25。5-1a の差分が 2,500 行になったので、5-1b をさらに分けた） | 5-0 |
| 5-1a | **実装済み**（5-1a。Issue #97）。api: タイムラインと控えの文書（[04 §1.6](./04_data_design.md#16-タイムラインtype-timeline-と-timelinephotos段階5)）、`POST …/timeline`（作る・作り直す）、`GET …/draft`・`DELETE …/draft`、再投入のタイマーにタイムラインの下書きを足す（投入に失敗しても進むように、`POST` と同じ PR に入れる）、`timelineDayStartHour()`、旅行の削除でタイムラインと控えも消す。偽物の Cosmos に `_etag` と IfMatch の置き換え | 5-0 |
| 5-1b | **実装済み**（5-1b。Issue #97）。api: ワーカー `processTimeline` の `propose`（担当・結果の当て直し・失敗・旅行の無いタイムラインの後始末。作り直しで完成版の区切りの差を当てる決まりまで。[06 §8.1・§8.2](./06_processing_design.md#82-区切り案step-propose)）と、AI に文字だけを渡す呼び出し | 5-1a |
| 5-1c | api: `PUT …/draft/scenes`（区切りの保存）、`GET …/timeline`（完成版の表示・写真の変化・解析中の枚数） | 5-1b |
| 5-2 | api: `POST …/draft/write`・`POST …/recut` とワーカーの `write`（文の引き継ぎ・残せなかった文・下書きと完成版の入れ替え。[06 §8.3](./06_processing_design.md#83-文を書くstep-write)）、`PATCH` の2つと `DELETE …/dropped-edits` | 5-1 |
| 5-3 | mobile: 旅行詳細の切り替え、完成版が無いときの表示（[03 §8.1・§8.2](./03_screen_design.md#81-旅行詳細の切り替え)）、区切りの確認画面（[03 §8.4](./03_screen_design.md#84-区切りの確認画面)）、`ApiService` のタイムラインのメソッド | 5-2 |
| 5-4 | mobile: 完成したタイムラインの表示と下書きの案内（[03 §8.3](./03_screen_design.md#83-完成したタイムライン)）、編集シート（§8.5）、区切りを直す・作り直す・写真が変わった案内・残せなかった文（§8.3・§8.6） | 5-3 |

デプロイ後に [08 §5.4](./08_test_plan.md#54-段階5タイムラインで足すもの) を手で確かめる（5-1・5-2 のクエリ、区切り案と文の質、トークンの実測）。
