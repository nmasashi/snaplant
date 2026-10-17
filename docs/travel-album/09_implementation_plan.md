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
- **設計書は都度直し、`docs/` 直下への取り込みは後でまとめて行う**（2026-10-12 に人間が決定）。開発中に設計と実装が食い違ったら、同じ PR でこの一式（`docs/travel-album/`）を直す。`docs/06_api_openapi.yaml`・`docs/06_api_design.md`・`docs/03_screen_design.md`・`docs/04_database_design.md`・`DEPLOYMENT.md` などへの取り込みは、機能が固まってから行う（開発中に何度も変わるため）。実装した節には「実装済み」の印を付ける
  - **既存の画面の振る舞いを変えたもの**（取り込むときに `docs/` 直下も直す）: PR 5 で、API キーが未設定・設定を読めないときは下のタブも「画像選択」ボタンも出さず、設定を促す表示だけにした（`docs/03_screen_design.md` §1 の起動時の挙動は、図鑑の画面に「画像選択」が出たままの旧仕様）
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
| 3-3b | api: タイマー `requeueStalePhotos.ts`（`failed` は拾わない。処理中の写真は `pending` に戻してから投入する。[06 §1.1](./06_processing_design.md#11-構成)）・`sweepAlbum.ts`（[04 §7.2](./04_data_design.md#72-掃除のタイマー段階3)）、`POST /api/photos/{photoId}/process`（受付でコメントを消し `attempts` を 0 に。投入に失敗しても 202。ワーカーの結果・失敗の書き込みを、担当したときの `state` と `attempts` の条件付きにするか（やり直しの受付と重なったとき、古い処理の結果でやり直しを上書きしないため。[05 §5.7](./05_api_design.md#57-post-apiphotosphotoidprocess段階3)）を決める）、`GET /api/photos?category=`。10 枚の実測を記録する（容量は今のまま。[06 §6](./06_processing_design.md#6-費用の抑え方)） | 3-3a |
| 3-4 | mobile: カテゴリの表示、分類の状態（`failed` と「やり直す」）、やり直しダイアログ、カテゴリ横断画面、旅行詳細画面のカテゴリの絞り込み | 3-3 |
| 3-5 | （任意）api + infra: Azure Maps の `GeocodingService` と `geocache` | 実機確認で Geocoder が不十分だったとき |

## 4. 段階4の PR の骨格

| # | 内容 | 依存 |
|---|---|---|
| 4-0 | infra: `album` に複合インデックス（`/identification/confidence`, `/identification/at` の降順。[07 §3.1](./07_infrastructure_design.md#31-図鑑の前に足すもの複合インデックス)）。人間が apply。**4-2 より先** | 段階3完了 |
| 4-1 | api: 定義表からの識別スキーマ生成、`PhotoIdentifierService`、ワーカーの `identify` ステップ（写真の `identification` への patch だけ。項目の文書は無い。[06 §3.2](./06_processing_design.md#32-書き込み)）、分類の後の `identification` のクリアと `step: "identify"` の投入 | 段階3完了 |
| 4-2 | api: 図鑑の API（まとめ方は `GROUP BY` + 項目ごとの `TOP 1`。[04 §5.6](./04_data_design.md#56-図鑑のまとめ段階4)。**API の形は着手時に決める**。[02 §5](./02_design_overview.md#5-人間に決めてもらう点推奨付き) #20。案は [05 §5.14](./05_api_design.md#514-図鑑段階4)）。デプロイ後に1種類の1ページを開く RU と時間を実測して記録（[04 §3.1](./04_data_design.md#31-項目は写真からまとめる) の見積もりと比べる） | 4-0・4-1 |
| 4-3 | mobile: 図鑑画面（種類タブ・項目一覧（`offset` でページ）・項目詳細（写真はページ）。項目は `kind` と `name` で開く）、写真ビューアのコメント編集と項目へのリンク、`PATCH` の呼び出し | 4-2 |
| 4-4 | api: 移行スクリプト `scripts/migratePlants.ts`（[06 §7](./06_processing_design.md#7-今の植物図鑑の統合と廃止段階4) 手順 2。`plants` の記録を写真の `identification` に移すだけ）。人間が退避（手順 1）→ 実行 → 確認（手順 3。飛ばした植物の一覧を見る） | 4-3 |
| 4-5 | mobile: 図鑑タブの差し替え、植物専用の画面・モデル・メソッド・テストの削除（手順 4） | 4-4 の確認 |
| 4-6 | api: 植物専用の関数・サービス・型・テストの削除、`app.ts`、`docs/06`・`07`・`README`（手順 5） | 4-5 |
| 4-7 | infra: `images`・`plants`・`temp-images`・関連 `app_settings` の削除（手順 6）。人間が apply | 4-6 |

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
