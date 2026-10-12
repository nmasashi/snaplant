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
- **TDD（List → Red → Green → Refactor）。** List は [08 §3・§4](./08_test_plan.md#3-段階2のシナリオ一覧api) から作る。Red は `test-writer`、Green と Refactor はメインセッション
- **レビューは作業単位ごとに 1 回**（テストリストが空になった時点）。`/code-review` は常に、`test-reviewer` はテストを書いた PR、`contract-auditor` は外から観測できる振る舞いを変えた PR、`/security-review` は入力・ストレージ・外部通信を触った PR
- **仕様書への取り込み**: 実装した振る舞いは、同じ PR で `docs/06_api_openapi.yaml`・`docs/06_api_design.md`（API）、`docs/03_screen_design.md`（画面）、`docs/04_database_design.md`（データ）へ取り込む。設計書（この一式）側の該当節は「実装済み。`docs/0N` を参照」と書き換える
- **デプロイの順序**: インフラ（apply）→ API（マージ）→ アプリ（実機）。[07 §5](./07_infrastructure_design.md#5-cicd-への影響)
- **`mobile/` の PR はマージ前に `flutter analyze` / `flutter test`。** 新規の指摘が無いことを一覧で突き合わせる（件数ではなく）
- **積まない（stacked PR を避ける）。** 前の PR がマージされてから次を切る。やむを得ず積むなら、マージ先が `main` に戻っているか確認する（`MEMORY.md` の教訓）

## 2. 段階2の PR 分割

| # | 内容 | 行数 | 依存 | 完了条件 | レビュー |
|---|---|---|---|---|---|
| 1 | **infra**: `photos` コンテナ、`temp-images` のライフサイクル、`album` コンテナ（PK `/id`）、`app_settings`、`outputs`（[07 §1](./07_infrastructure_design.md#1-段階2)） | ~150 | — | `terraform fmt`・`validate` が緑。**人間がポータルで無料枠を確認してから apply**。ポータルで `photos` が非公開 | `/code-review medium`、`/security-review`（公開設定・ライフサイクルの接頭辞） |
| 2 | **api の土台**: `ErrorCode` の追加、`createNotFoundError(code?)`、`isConnectivityError()`、`utils/blobSas.ts` の切り出し（`generateTempSasUrl()` を包みに）、`types/album.ts`、`constants/validation.ts` の追加（`TRIP_` / `PHOTO_` / `MOVE_` / `TAG_VALIDATION`）、`constants/tags.ts`、テスト用の差し替え部品の拡張（[08 §2.1](./08_test_plan.md#21-testsfakescosmosts)） | ~750 | — | 既存テスト全緑（**SAS の切り出し後も `storageService.test.ts` と `upload.test.ts` が通る**）。`blobSas`・`isConnectivityError`・差し替え部品の新しい振る舞いのテスト | `/code-review high`（既存の `upload` に触る）、`test-reviewer` |
| 3 | **api: 旅行**: `AlbumService`（旅行の CRUD と集計）、`PhotoStorageService`（削除だけ）、`trips.ts`・`tripDetail.ts`、`app.ts` の import、仕様書 | ~1,000 | 2 | TDD のリストが空。仕様書（OpenAPI・06）と一致。デプロイ後に `GET /api/trips` を手で確認 | `/code-review high`、`test-reviewer`、`contract-auditor` |
| 4a | **api: 写真**: `POST /api/photos`（ハッシュ照合・既存 200・Blob→create）、`GET /api/photos`（`tripId` / `none`、並び、SAS）、`GET` / `DELETE /api/photos/{photoId}`、仕様書 | ~1,500 | 3 | 同上。デプロイ後に SAS で表示できること、応答に `_rid` が無いこと | `/code-review high`、`test-reviewer`、`contract-auditor`、`/security-review`（multipart・ハッシュ・SAS） |
| 4b | **api: 出し入れと更新**: `POST /api/photos/move`、旅行削除の連鎖（3 の `DELETE` を写真付きに）、`PATCH /api/photos/{photoId}`（`comment`・`tags` の構造だけ）、仕様書 | ~700 | 4a | 同上。デプロイ後に `/api/photos/move` のルートと 300 枚の move を手で確認 | `/code-review high`、`test-reviewer`、`contract-auditor` |
| 5 | **mobile: 土台**: `AppRoot`（設定の読み込み・`ApiService`・`UploadQueue` の置き場）、`HomeShell`（2 タブ）、`PlantListScreen` が `ApiService` を受け取る形に、旅行タブは仮の画面 | ~800 | 2 以降いつでも | **図鑑の既存の動きが変わらない**（既存の画面テストが通る。実機で起動・一覧・設定を確認）。`flutter analyze` に新規の指摘なし | `/code-review high`（既存の画面に触る）、`test-reviewer` |
| 6 | **mobile: 旅行と写真の表示**: `Trip` / `Photo` モデル、`ApiService` の旅行・写真の取得メソッド、旅行一覧・作成・編集・削除、旅行詳細・未所属（`PhotoGrid` 表示のみ）、`cacheKey` と `CacheManager`、画面設計の取り込み | ~1,500 | 3・4a（API がデプロイ済み） | 実機で旅行の作成・一覧・削除、写真の表示（API 側で手で入れた写真） | `/code-review high`、`test-reviewer`、`contract-auditor`（画面設計） |
| 7 | **mobile: 送信**: `pickMultiImage`、`photo_metadata`（EXIF・SHA-256・サムネイル）、Geocoder、`UploadQueue`、進み具合バナー、写真ビューア、`ApiService.uploadPhoto` / `deletePhoto` | ~1,800 | 4a・6 | **最初にハッシュの決定性を実機で確認。** 300 枚の送信が完走し、実測を `docs/09_backlog.md` に記録 | `/code-review high`、`test-reviewer`、`/security-review`（ファイル・位置情報の扱い） |
| 8 | **mobile: 複数選択**: 選択モード、旅行に入れる（旅行を選ぶダイアログ）、旅行から外す、まとめて削除、`ApiService.movePhotos` | ~800 | 4b・7 | 実機で 100 枚の出し入れ | `/code-review high`、`test-reviewer` |

順序: 1 → 2 → 3 → 4a → 4b（API の列）。5 は 2 以降いつでも、6 は 3 と 4a の後、7 は 4a の後、8 は 4b の後。
API と mobile の列は並行できるが、**同時に進めるなら別のブランチで、積まない**。

PR 7 が 1,800 行で上限に近い。超えそうなら「写真ビューア」を 7b に分ける。

### 各 PR の共通の完了条件

- `npm test`（api）/ `flutter test`（mobile）が緑、`npx tsc -p tsconfig.test.json --noEmit` が通る
- テストが固定している外から観測できる振る舞いが仕様書に書かれている（`contract-auditor` で突き合わせ）
- PR 本文に `Closes #N`（閉じる Issue が無いなら理由を考える）
- 設計書（この一式）の該当節に「実装済み」の印

## 3. 段階3の PR の骨格

| # | 内容 | 依存 |
|---|---|---|
| 3-1 | infra: Storage Queue、分類用デプロイと変数、`app_settings`（[07 §2](./07_infrastructure_design.md#2-段階3)）。`host.json` の `extensions.queues` と `http` の位置 | 段階2完了 |
| 3-2 | api: `OpenAIVisionService.analyze()` の一般化（`identifyPlant()` は残す）、`catalog/kinds.ts`（定義表。段階3では分類の選択肢にだけ使う）、`PhotoClassifierService`、`tests/fakes/queue.ts` | 3-1 |
| 3-3 | api: ワーカー `processPhoto.ts`、タイマー `requeueStalePhotos.ts`、`POST /api/photos` のキュー投入、`POST /api/photos/{photoId}/process`、`GET /api/tags`、`GET /api/photos?tag=`。10 枚の実測を記録 | 3-2 |
| 3-4 | mobile: カテゴリの表示、分類の状態、やり直しダイアログ、タグ横断画面 | 3-3 |
| 3-5 | （任意）api + infra: Azure Maps の `GeocodingService` と `geocache` | 実機確認で Geocoder が不十分だったとき |

## 4. 段階4の PR の骨格

| # | 内容 | 依存 |
|---|---|---|
| 4-1 | api: 定義表からの識別スキーマ生成、`PhotoIdentifierService`、項目の併合、ワーカーの `identify` ステップ、`ENTRY_NOT_FOUND` | 段階3完了 |
| 4-2 | api: `GET /api/catalog/kinds` / `entries` / `entries/{entryId}`、`DELETE`、写真削除時の項目の掃除 | 4-1 |
| 4-3 | mobile: 図鑑画面（種類タブ・項目一覧・項目詳細）、写真ビューアのコメント編集と項目へのリンク、`PATCH` の呼び出し | 4-2 |
| 4-4 | api: 移行スクリプト `scripts/migratePlants.ts`（[06 §7](./06_processing_design.md#7-今の植物図鑑の統合と廃止段階4) 手順 2）。人間が退避（手順 1）→ 実行 → 確認（手順 3） | 4-3 |
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
- 仕様書（`docs/03`・`04`・`06`・`06_api_openapi.yaml`・`07`・`README`）が実装の写しになっている
- CLAUDE.md の「実際のルート」の表と「Cosmos のクエリを変更したら手で確認する」の表が更新されている
- Issue #22 の段階2のチェックが埋まっている
