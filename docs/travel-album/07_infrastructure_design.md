# 旅行アルバム インフラ設計

## この文書の位置づけ

旅行アルバムのために `infrastructure/`（Terraform）・`api/host.json`・CI/CD に加える変更を、段階ごとに書く。
**未実装を含む目指す姿**で、`DEPLOYMENT.md`・`docs/04_database_design.md` へは後でまとめて取り込む（開発中はこの一式を正として都度直し、取り込みは機能が固まってから後でまとめて行う。2026-10-12 に人間が決定）。Terraform の定義の一覧である `infrastructure/README.md` は実装と一緒に直す。

`terraform plan` / `apply` には作業マシンにしか無い `terraform.tfstate` と `terraform.tfvars` が要り、**apply は人間が行う**（CLAUDE.md「開発環境」）。
CI（`terraform.yml`）は `fmt -check` と `validate` だけで、Azure へは通信しない。`.tf` を編集したら `terraform fmt` をかける。

データの形は [04_data_design.md](./04_data_design.md)、裏の処理は [06_processing_design.md](./06_processing_design.md)、
PR の順序は [09_implementation_plan.md](./09_implementation_plan.md) を参照する。リソース名・変数名はこの文書で決めた。

---

## 1. 段階2

**実装済み**（#30。`infrastructure/main.tf`・`outputs.tf`）。apply は人間が行う。

### 1.1 追加するリソース

| リソース | 名前 | 設定 | 注意 |
|---|---|---|---|
| `azurerm_storage_container.photos` | `photos` | `container_access_type = "private"` | 要件 §6「最初から非公開」。`images` と違い公開しない |
| `azurerm_storage_management_policy.main` | — | `temp-images/` の Blob を最終更新から 1 日で削除 | §1.2 |
| `azurerm_cosmosdb_sql_container.album` | `album` | `partition_key_paths = ["/id"]`、`throughput = var.cosmos_db_throughput`、`indexing_policy` は `plants` と同じ（`/*`）。一意キーは無し | 無料枠は apply の前にポータルで確認（§1.4） |

```hcl
# 写真（原寸・サムネイル）用 Blob コンテナ。非公開で、読み取りは Blob 単位の SAS
resource "azurerm_storage_container" "photos" {
  name                  = "photos"
  storage_account_name  = azurerm_storage_account.main.name
  container_access_type = "private"
}

# 旅行・写真を type で区別して置く Cosmos DB コンテナ。PK は /id
# （図鑑の項目は文書として持たず、写真の identification からまとめる）
resource "azurerm_cosmosdb_sql_container" "album" {
  name                = "album"
  resource_group_name = azurerm_resource_group.main.name
  account_name        = azurerm_cosmosdb_account.main.name
  database_name       = azurerm_cosmosdb_sql_database.main.name
  partition_key_paths = ["/id"]
  throughput          = var.cosmos_db_throughput

  indexing_policy {
    indexing_mode = "consistent"
    included_path {
      path = "/*"
    }
  }
}
```

### 1.2 ライフサイクル管理（`temp-images` の孤児の軽減）

`docs/09_backlog.md`「`upload` で AI の呼び出しが例外で失敗すると、一時保存した Blob が残る」の対処2をここで入れる。

```hcl
resource "azurerm_storage_management_policy" "main" {
  storage_account_id = azurerm_storage_account.main.id

  rule {
    name    = "delete-temp-images"
    enabled = true
    filters {
      # 接頭辞で必ず絞る。同じアカウントを AzureWebJobsStorage が使っており、
      # 絞らないと Functions の鍵やホストの情報（azure-webjobs-secrets など）まで消える
      prefix_match = ["temp-images/"]
      blob_types   = ["blockBlob"]
    }
    actions {
      base_blob {
        delete_after_days_since_modification_greater_than = 1
      }
    }
  }
}
```

- **`prefix_match` を付け忘れると、Function App の鍵（`azure-webjobs-secrets`）・`images`・`photos` も消える。** 絶対に絞る
- ストレージアカウントごとにポリシーは1つ。段階4で `temp-images` を消すときはこのルールも消す
- 1 日は「アップロードの1リクエスト（5 分）より十分長く、残骸が溜まらない」長さ。SAS の 15 分より長いので、正常な処理の途中で消えることは無い
- 削除は最大で 1 日程度遅れて実行される（Azure の仕様。推測）

### 1.3 `app_settings` と `outputs`

| 設定 | 値 | 使う所 |
|---|---|---|
| `COSMOS_DB_ALBUM_CONTAINER` | `azurerm_cosmosdb_sql_container.album.name` | `AlbumService` |
| `PHOTO_STORAGE_CONTAINER_NAME` | `azurerm_storage_container.photos.name` | `PhotoStorageService` |
| `PHOTO_SAS_EXPIRY_MINUTES` | `"60"` | `photoUrlExpiresOn()`（`services/photoStorageService.ts`） |

既存の `COSMOS_DB_CONTAINER`（`plants`）・`STORAGE_CONTAINER_NAME`・`TEMP_STORAGE_CONTAINER_NAME` は段階4まで残す。
検証の上限（`TRIP_NAME_MAX_LENGTH` など）やページの大きさ（`PHOTO_PAGE_SIZE` など）は既定値で動くので `app_settings` には書かない（変えたいときだけ足す）。
環境変数とコードの定数の一覧は §6。

`outputs.tf` に `photos_container_name`・`album_container_name` を足す。`deployment_summary` は変えない。

### 1.4 apply の前に人間が確認すること

- Cosmos DB の無料枠が「アカウントで 1000 RU/s」か「400 RU/s」か（ポータルの「無料枠」の表示）。400 なら `album` を足すと課金される（[04 §6](./04_data_design.md#6-無料枠と-ru-の見積もり)）
- `plan` で `plants`・`images`・`temp-images`・Function App に replace や予期しない差分が出ないこと
- ポータルで、ストレージアカウントにライフサイクル管理のルールが手で足されていないこと（ポリシーはアカウントに1つで、apply で丸ごと置き換わる）
- apply 後にポータルで `photos` が非公開（匿名アクセスなし）であること

## 2. 段階3

| リソース | 名前 | 設定 | 注意 |
|---|---|---|---|
| `azurerm_storage_queue.photo_processing` | `photo-processing` | 既存のストレージアカウント | poison キュー（`photo-processing-poison`）は Functions が自動で作る |
| `azurerm_maps_account.main`（任意） | `maps-${var.project_name}-${suffix}` | `sku_name = "G2"` | 端末の Geocoder で足りれば作らない。iOS に対応するときに改めて検討（[06 §4](./06_processing_design.md#4-地名への変換)） |
| `azurerm_consumption_budget_resource_group.main` | — | 月額の上限と通知先メール（`var.monthly_budget_amount`・`var.budget_alert_email`） | AI の費用の安全弁。アプリに回数のカウンタを置かない代わりに入れる（[06 §6](./06_processing_design.md#6-費用の抑え方)）。金額は人間が決める |

`variables.tf` に `monthly_budget_amount`・`budget_alert_email` を足す。

**分類用のデプロイは当面足さない**（2026-10-12 に人間が決定。[02 §5](./02_design_overview.md#5-人間に決めてもらう点推奨付き) #17）。
分類にも識別にも、今のデプロイ `azurerm_cognitive_deployment.gpt6_luna`（`gpt-6-luna`、版 2026-09-22。`infrastructure/main.tf`）をそのまま使う。
2026-10-17 に `gpt-5.6-luna` から `gpt-6-luna` に替えた（人間が決定。GPT-6 系で一番安く、入力・出力とも `gpt-5.6-luna` の半分以下の単価。提供の終了も 2028-03-11 と遅い）。
識別の精度は、普段使いで見て決める（足りなければ、標準のデプロイを上位のモデル（`gpt-6-sol` など）に替え、分類用に `gpt-6-luna` のデプロイを足す）。
API 側はデプロイ名を環境変数 `AZURE_OPENAI_CLASSIFY_DEPLOYMENT_NAME` から読み、未設定なら `AZURE_OPENAI_DEPLOYMENT_NAME`（今のデプロイ）を使う（[06 §2.1](./06_processing_design.md#21-モデルとサービス)）。
分類と識別を別のモデルにするときは、`azurerm_cognitive_deployment` を1つ足して `app_settings` に `AZURE_OPENAI_CLASSIFY_DEPLOYMENT_NAME` を書くだけでよい。

**デプロイの容量で費用を抑える**（2026-10-12 に人間が決定。アプリの中に1日の呼び出し回数のカウンタは置かない）。
`capacity` は 1 単位 = 1,000 トークン/分（TPM）で、`capacity × 1,000 × 1,440 分 × 単価` が1日の費用の上限になる。超えた呼び出しは 429 になり、キューの再試行で翌分以降に流れる。

- 容量の値は今のデプロイのまま（`capacity = 150`）でよい（#17）。段階3の最初の実測（[06 §6](./06_processing_design.md#6-費用の抑え方)）で費用が気になれば下げる
- 植物図鑑の `upload` / `identify` も同じデプロイを使っているので、段階4より前に下げるなら既存の使い方に影響しないことを確かめる
- 容量を下げても止まらず遅くなるだけ

| `app_settings` | 値 |
|---|---|
| `PHOTO_QUEUE_NAME` | `azurerm_storage_queue.photo_processing.name` |
| `AZURE_OPENAI_CLASSIFY_DEPLOYMENT_NAME` | 当面は書かない（未設定なら API が `AZURE_OPENAI_DEPLOYMENT_NAME` を使う）。分類用のデプロイを足したときに、その名前を書く |
| `PHOTO_PROCESSING_MAX_ATTEMPTS` | `"3"` |
| `AZURE_MAPS_KEY` | Azure Maps を入れる場合だけ |

`AzureWebJobsStorage` は `azurerm_linux_function_app` が `storage_account_name` / `storage_account_access_key` から自動で設定する（既存）。キューのトリガーはこれを使う。

## 3. 段階4

### 3.1 図鑑の前に足すもの（複合インデックス）

図鑑の見出しの写真を `ORDER BY c.identification.confidence DESC, c.identification.at DESC` で1枚だけ読む（[04 §5.6](./04_data_design.md#56-図鑑のまとめ段階4)）ために、
`album` に複合インデックスを足す。2項目の `ORDER BY` は複合インデックスが無いと失敗する（推測）ので、**図鑑の API（[09 §4](./09_implementation_plan.md#4-段階4の-pr-の骨格) の 4-2）より先に apply する**。

```hcl
resource "azurerm_cosmosdb_sql_container" "album" {
  # ...（段階2の定義に足す）
  indexing_policy {
    indexing_mode = "consistent"
    included_path {
      path = "/*"
    }
    # 図鑑の見出しの写真（信頼度が最も高く、同点なら識別の日時が新しいもの）を TOP 1 で引くため
    composite_index {
      index {
        path  = "/identification/confidence"
        order = "descending"
      }
      index {
        path  = "/identification/at"
        order = "descending"
      }
    }
  }
}
```

インデックスの変更は既存のコンテナにそのまま適用され（replace にならない。`plan` で確かめる）、作り直しは裏で進む。既存の写真が少ない段階4の初めなら数分（推測）。

### 3.2 植物図鑑の廃止

植物図鑑の廃止（[06 §7](./06_processing_design.md#7-今の植物図鑑の統合と廃止段階4) の手順 6）。移行の確認（手順 3）が済んでから。

| 削除するもの | 注意 |
|---|---|
| `azurerm_storage_container.images`・`temp_images` | **`images` の中身が消える。** 手順 1 の退避と、手順 2 で `photos` へ移したことを確認してから |
| `azurerm_storage_management_policy.main` の `temp-images` のルール | ポリシー自体は残してもよい（ルールが空なら削除） |
| `azurerm_cosmosdb_sql_container.plants` | 中身が消える。手順 1 の JSON 書き出しを確認してから |
| `app_settings` の `COSMOS_DB_CONTAINER`・`STORAGE_CONTAINER_NAME`・`TEMP_STORAGE_CONTAINER_NAME` | コード側の参照（`cosmosService.ts`・`storageService.ts`）を先に消す（手順 5） |
| `outputs.tf` の `images_container_name`・`temp_images_container_name`・`cosmos_db_container_name` | |

`plan` で `album`・`photos` に replace が出ないことを確かめる。無料枠は `album` 400 だけになる。

## 4. `host.json` の変更

段階3で `extensions.queues` を足すときに、`docs/09_backlog.md`「`api/host.json` の `http` がトップレベルにある」も直す。

```json
{
  "version": "2.0",
  "logging": { "applicationInsights": { "samplingSettings": { "isEnabled": true, "excludedTypes": "Request" } } },
  "extensionBundle": { "id": "Microsoft.Azure.Functions.ExtensionBundle", "version": "[4.*, 5.0.0)" },
  "functionTimeout": "00:05:00",
  "extensions": {
    "http": { "routePrefix": "api" },
    "queues": {
      "batchSize": 1,
      "newBatchThreshold": 0,
      "maxDequeueCount": 3,
      "visibilityTimeout": "00:01:00",
      "maxPollingInterval": "00:00:10"
    }
  }
}
```

- `routePrefix: "api"` は既定値と同じなので、場所を直しても振る舞いは変わらない
- `batchSize: 1`・`newBatchThreshold: 0` で直列（[06 §1.1](./06_processing_design.md#11-構成)）。従量課金プランではインスタンスが複数に増えることがあり、完全な直列は保証されない（推測）。AI の TPM 上限（150K）に対して数並列なら問題ない
- `maxPollingInterval` は既定の 1 分だと投入から処理まで最大 1 分待つ。10 秒にして体感を縮める（ポーリングの課金は無視できる程度。推測）
- `functionTimeout` は変えない。ワーカーの 1 回は AI 呼び出し 1 回なので 5 分に収まる

段階2では `host.json` を変えない。

## 5. CI/CD への影響

| ワークフロー | 影響 |
|---|---|
| `ci.yml` | トリガー（`api/**`）はそのまま。新しい関数とテストが対象に入る。`npm test` に新しいテストが乗る |
| `deploy-functions.yml` | `main` へのマージで本番デプロイ（既存）。**`@azure/storage-queue`（段階3）は `dependencies` に置く**。`npm prune --omit=dev` で外れると本番で読み込みに失敗する |
| `terraform.yml` | `infrastructure/**` の変更で `fmt -check`・`validate`。`plan` は回らない |
| `audit.yml` | `package*.json` の変更で `npm audit`。新しい依存を足すと走る |
| `flutter.yml` | `mobile/**` の変更で `flutter analyze`（info も含めて指摘があれば失敗）と `flutter test`（`TZ=Asia/Tokyo`）。本番デプロイの前提にはしていない。PR のマージ前にローカルでも回す |

- デプロイの順序: **インフラ（apply）→ API（マージでデプロイ）→ アプリ（実機にインストール）**。API が先だと `COSMOS_DB_ALBUM_CONTAINER` が無く起動時に失敗する。
  段階2の API は `AlbumService` のコンストラクタで環境変数を読むので、`album` が無い状態でデプロイすると旅行・写真の関数だけが 500 になり、植物図鑑は動く
- Function Key は変わらない（同じ Function App に関数を足すだけ）
- 新しい関数が登録されたことは、デプロイ後にポータルの「関数」一覧か `GET /api/trips` で確かめる（`app.ts` の import 忘れはここで分かる）

## 6. 設定値の一覧

環境変数で持つもの（`app_settings` で変えられる）と、コードの定数（変えるには実装を直す）と、Flutter 側の定数を1か所にまとめる。
他の文書からはここを参照し、値の重複した記述を増やさない。既定値はすべてこの一式で決めたもので、変えるなら実装前に（[02 §5](./02_design_overview.md#5-人間に決めてもらう点推奨付き) #16）。

### 6.1 api の環境変数

`positiveIntFromEnv()` で読むものは、正の整数として読めない値なら既定値にフォールバックする（CLAUDE.md「バリデーション定数」）。

| 名前 | 既定値 | 意味 | どこで使うか | 段階 |
|---|---|---|---|---|
| `COSMOS_DB_ALBUM_CONTAINER` | （必須。Terraform が `album` を入れる） | 旅行・写真のコンテナ名 | `AlbumService` | 2 |
| `PHOTO_STORAGE_CONTAINER_NAME` | （必須。コードにフォールバックは無い。Terraform が `photos` を入れる） | 写真の Blob コンテナ名 | `PhotoStorageService` | 2 |
| `PHOTO_SAS_EXPIRY_MINUTES` | `60` | 写真の表示用 SAS の有効期限（分）。定数にせず、応答を作るたびに `positiveIntFromEnv()` で読む（読めない値・0・負なら 60）。旅行の表紙の URL も同じ期限 | `photoUrlExpiresOn()`（`services/photoStorageService.ts`。[05 §6](./05_api_design.md#6-sas-付き-url)） | 2 |
| `TEMP_SAS_EXPIRY_MINUTES`（既存） | `15` | AI に渡す読み取り SAS の有効期限（分） | ワーカー（[06 §2.1](./06_processing_design.md#21-モデルとサービス)） | 3 |
| `TRIP_NAME_MAX_LENGTH` | `100` | 旅行名の上限（文字） | `POST` / `PUT /api/trips` | 2 |
| `TRIP_DESCRIPTION_MAX_LENGTH` | `1000` | 旅行のメモの上限 | 同上 | 2 |
| `PHOTO_PLACE_NAME_MAX_LENGTH` | `100` | 地名の上限 | `POST /api/photos` | 2 |
| `PHOTO_COMMENT_MAX_LENGTH` | `500` | 写真のコメントの上限 | `PATCH /api/photos/{photoId}` | 2 |
| `THUMBNAIL_MAX_SIZE` | `1048576`（1MB） | サムネイルのバイト数の上限 | `POST /api/photos` | 2 |
| `MAX_FILE_SIZE`（既存） | `10485760`（10MB） | 原寸のバイト数の上限 | `POST /api/photos`（既存の `upload` と共用） | 2 |
| `CONTEXT_INFO_MAX_LENGTH`（既存） | `500` | やり直しの手がかり `hint` の上限 | `POST /api/photos/{photoId}/process`（既存の `contextInfo` と共用） | 3 |
| `MOVE_MAX_IDS` | `200` | move の1回の上限（件） | `POST /api/photos/move` | 2 |
| `TAG_MAX_LENGTH` | `30` | 利用者のタグの上限（文字） | `PATCH /api/photos/{photoId}` | 2 |
| `PHOTO_PAGE_SIZE` / `PHOTO_MAX_PAGE_SIZE` | `100` / `200` | 写真一覧の1ページの既定と上限（枚）。上限は `limit` の 400 の `message` にも埋め込まれる | `GET /api/photos`・`GET /api/catalog/entry` | 2 |
| `CATALOG_PAGE_SIZE` / `CATALOG_MAX_PAGE_SIZE` | `50` / `100` | 図鑑の項目一覧の1ページの既定と上限（件） | `GET /api/catalog/entries` | 4 |
| `PHOTO_QUEUE_NAME` | `photo-processing` | 分類・識別のキュー名 | 投入する API とワーカー | 3 |
| `PHOTO_PROCESSING_MAX_ATTEMPTS` | `3` | 自動の再試行の上限（回）。超えたら `failed` | ワーカー・再投入のタイマー（[06 §1.3](./06_processing_design.md#13-状態と失敗)） | 3 |
| `PHOTO_PROCESSING_STALE_MINUTES` | `10` | これより長く更新の無い処理中の写真を再投入する（分） | 再投入のタイマー | 3 |
| `ORPHAN_BLOB_MIN_AGE_DAYS` | `1` | 文書の無い Blob を消す前に待つ日数 | 掃除のタイマー（[04 §7.2](./04_data_design.md#72-掃除のタイマー段階3)） | 3 |
| `AZURE_OPENAI_DEPLOYMENT_NAME`（既存） | （必須。Terraform が `gpt6_luna` の名前を入れる） | 今のデプロイ名。植物図鑑の識別に加え、旅行アルバムの分類（段階3）と識別（段階4）にも当面はこれを使う | `OpenAIVisionService`・`PhotoClassifierService`・`PhotoIdentifierService` | 3・4 |
| `AZURE_OPENAI_CLASSIFY_DEPLOYMENT_NAME` | `AZURE_OPENAI_DEPLOYMENT_NAME` の値 | 分類用のデプロイ名。安いモデルのデプロイを足したときに設定する（#17） | `PhotoClassifierService` | 3 |
| `AZURE_OPENAI_IDENTIFY_DEPLOYMENT_NAME` | `AZURE_OPENAI_DEPLOYMENT_NAME` の値 | 識別用のデプロイ名。分類と同じく、別のモデルに変えるときに設定する | `PhotoIdentifierService` | 4 |
| `AZURE_MAPS_KEY` | （Azure Maps を入れる場合だけ） | Reverse Geocode のキー | `GeocodingService` | 3・任意 |

AI の1日の呼び出し回数の上限（`AI_DAILY_CALL_LIMIT`）と地名変換の上限（`GEOCODING_DAILY_LIMIT`）は**置かない**。費用はデプロイの容量と予算アラートで抑える（§2、[06 §6](./06_processing_design.md#6-費用の抑え方)）。

### 6.2 api のコードの定数

| 名前（置き場） | 値 | 意味 | どこで使うか | 段階 |
|---|---|---|---|---|
| `PHOTO_VALIDATION.ID_REGEX`（`constants/validation.ts`） | `/^[0-9a-f]{64}$/` | 写真 id の形（小文字16進） | 写真 id を受けるすべて | 2 |
| `PHOTO_VALIDATION.TAKEN_AT_REGEX` | `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/` + 実在する日時 | 撮影日時の形 | `POST /api/photos` | 2 |
| `PHOTO_VALIDATION.COORDINATE_REGEX` | `/^-?[0-9]+(\.[0-9]+)?$/` + 緯度 ±90・経度 ±180 | 緯度・経度の形（10進だけ） | `POST /api/photos` | 2 |
| `GENERAL_VALIDATION.UUID_REGEX`（既存） | — | 旅行 id の形 | 旅行 id を受けるすべて | 2 |
| `SORT_AT_UTC_OFFSET_MINUTES`（`constants/album.ts`） | `540`（日本時間） | 撮影日時が無い写真の `sortAt` を `uploadedAt` から作るときのずらし | `computeSortAt()`（`utils/sortAt.ts`。`POST /api/photos` のハンドラが呼ぶ。[04 §1.3](./04_data_design.md#13-写真type-photo)） | 2 |
| `PHOTO_SAS_START_SKEW_MINUTES`（`constants/album.ts`） | `5`（発行の 5 分前から有効） | SAS の `startsOn`。時計のずれの吸収 | `PhotoStorageService.readUrl()`（一時画像の SAS には付けない） | 2 |
| `PHOTO_CONTINUATION_TOKEN_LIMIT_KB`（`constants/album.ts`） | `2` | 写真一覧の継続トークンの大きさの上限（KB）。クエリパラメータで受け渡すので URL の長さに収める | `AlbumService.listPhotos()`（`GET /api/photos`。[04 §5.3](./04_data_design.md#53-旅行の写真一覧)） | 2 |
| `FILE_UPLOAD.EXTENSION_BY_CONTENT_TYPE`（既存） | — | Blob 名の拡張子 | `POST /api/photos` | 2 |
| `OTHER_KIND`・`CATALOG_KINDS`（`catalog/kinds.ts`） | `'other'`・定義表 | カテゴリと図鑑の種類 | 分類の選択肢・識別のスキーマ・`GET /api/catalog/*`（[04 §3.2](./04_data_design.md#32-定義表-catalog_kindsapisrccatalogkindsts)） | 3・4 |
| `geocache` の丸め | 小数3桁（≒ 100 m） | 地名のキャッシュの鍵 | `GeocodingService` | 3・任意 |
| `host.json` の `extensions.queues` | `batchSize: 1`・`newBatchThreshold: 0`・`maxDequeueCount: 3`・`visibilityTimeout: 00:01:00`・`maxPollingInterval: 00:00:10` | キューの直列化・再試行・待ち時間 | ワーカー（§4） | 3 |
| タイマーの間隔（`app.timer` の cron） | 再投入 10 分ごと、掃除 1日1回（深夜） | | `requeueStalePhotos.ts`・`sweepAlbum.ts` | 3 |
| ライフサイクルの日数（Terraform） | `1` | `temp-images` の Blob を消すまでの日数 | §1.2 | 2 |

### 6.3 Flutter 側の定数

| 名前（置き場） | 値 | 意味 | 根拠 |
|---|---|---|---|
| 送信の同時本数（`UploadQueue`） | `2` | `POST /api/photos` を同時に送る数 | [02 §4.7](./02_design_overview.md#47-送り方は1リクエスト1枚クライアントが同時2本まで要件-52) |
| 送信の再試行（`UploadQueue`） | 3 回、2 → 4 → 8 秒 | ステータス 0 / 429 / 503 のときだけ | [03 §4.7](./03_screen_design.md#47-写真の追加と送信の進み具合) |
| サムネイル（`UploadQueue`。`upload_queue.dart` の `_thumbnailLongSide`・`_thumbnailQuality`） | 長辺 320px・画質 70・JPEG | 一覧用の小さな画像 | [04 §4.2](./04_data_design.md#42-blob-名)・[03 §4.7](./03_screen_design.md#47-写真の追加と送信の進み具合) |
| 画像の縮小（`image_picker`） | 画質 85・最大 1920px（既存と同じ。縮小してもハッシュが決まることは実機で確かめた） | 原寸の大きさ | [09 §6](./09_implementation_plan.md#6-最初に実機で確かめること) |
| 地名の変換（`UploadQueue`。`upload_queue.dart` の `_placeNameTimeout`） | タイムアウト 5 秒、キャッシュの鍵は小数3桁（`shared_preferences`。引けた地名だけを残す） | 端末の Geocoder | [06 §4.2](./06_processing_design.md#42-段階2端末) |
| Android の `minSdkVersion` / `compileSdk`（`mobile/android/app/build.gradle`） | `24`（Android 7.0）/ `36` | アプリを入れられる端末の下限と、ビルドに使う SDK | `geocoding` 5 の要求（PR 7c で 21 / 35 から上げた。旅行で使う SC-03K は Android 10 なので影響しない） |
| 写真一覧のページ（`ApiService.getPhotos`） | `limit` を送らない（サーバの既定 100） | 下までスクロールで次のページ | [03 §4.4](./03_screen_design.md#44-旅行詳細画面) |
| 画像キャッシュ（`photo_cache_manager.dart`） | 件数の上限を既定の 200 から引き上げる（値は実装時に決める） | 数百枚の旅行で入れ替わり続けないように | [03 §3](./03_screen_design.md#3-全画面共通) |
| 旅行の削除ダイアログの既定 | 「写真は残す」 | 誤操作で写真が消えないように | [03 §4.4](./03_screen_design.md#44-旅行詳細画面) |
