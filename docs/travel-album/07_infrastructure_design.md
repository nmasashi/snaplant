# 旅行アルバム インフラ設計

## この文書の位置づけ

旅行アルバムのために `infrastructure/`（Terraform）・`api/host.json`・CI/CD に加える変更を、段階ごとに書く。
**未実装を含む目指す姿**で、実装したときに `infrastructure/README.md`・`DEPLOYMENT.md`・`docs/04_database_design.md` へ取り込む。

`terraform plan` / `apply` には作業マシンにしか無い `terraform.tfstate` と `terraform.tfvars` が要り、**apply は人間が行う**（CLAUDE.md「開発環境」）。
CI（`terraform.yml`）は `fmt -check` と `validate` だけで、Azure へは通信しない。`.tf` を編集したら `terraform fmt` をかける。

データの形は [04_data_design.md](./04_data_design.md)、裏の処理は [06_processing_design.md](./06_processing_design.md)、
PR の順序は [09_implementation_plan.md](./09_implementation_plan.md) を参照する。リソース名・変数名はこの文書で決めた。

---

## 1. 段階2

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

# 旅行・写真・図鑑の項目を type で区別して置く Cosmos DB コンテナ。PK は /id
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
| `PHOTO_SAS_EXPIRY_MINUTES` | `"60"` | `utils/blobSas.ts` |

既存の `COSMOS_DB_CONTAINER`（`plants`）・`STORAGE_CONTAINER_NAME`・`TEMP_STORAGE_CONTAINER_NAME` は段階4まで残す。
検証の上限（`TRIP_NAME_MAX_LENGTH` など。[05 §4](./05_api_design.md#4-入力検証の定数)）は既定値で動くので `app_settings` には書かない（変えたいときだけ足す）。

`outputs.tf` に `photos_container_name`・`album_container_name` を足す。`deployment_summary` は変えない。

### 1.4 apply の前に人間が確認すること

- Cosmos DB の無料枠が「アカウントで 1000 RU/s」か「400 RU/s」か（ポータルの「無料枠」の表示）。400 なら `album` を足すと課金される（[04 §6](./04_data_design.md#6-無料枠と-ru-の見積もり)）
- `plan` で `plants`・`images`・`temp-images`・Function App に replace や予期しない差分が出ないこと
- apply 後にポータルで `photos` が非公開（匿名アクセスなし）であること

## 2. 段階3

| リソース | 名前 | 設定 | 注意 |
|---|---|---|---|
| `azurerm_storage_queue.photo_processing` | `photo-processing` | 既存のストレージアカウント | poison キュー（`photo-processing-poison`）は Functions が自動で作る |
| `azurerm_cognitive_deployment.classifier` | `var.openai_classify_deployment_name` | `model { name = var.openai_classify_model_name, version = var.openai_classify_model_version }`、`sku { name = "GlobalStandard", capacity = var.openai_classify_capacity }` | モデルは人間が価格表を見て決める。既存の `gpt5_luna` と同じ `cognitive_account` |
| `azurerm_maps_account.main`（任意） | `maps-${var.project_name}-${suffix}` | `sku_name = "G2"` | 端末の Geocoder で足りれば作らない |
| `azurerm_consumption_budget_resource_group.main`（任意） | — | 月額の上限と通知先メール | AI の費用の安全弁。人間が決める |

`variables.tf` に `openai_classify_deployment_name`（既定 `"classifier"`）・`openai_classify_model_name`・`openai_classify_model_version`・`openai_classify_capacity`（既定 `50`）を足す。

| `app_settings` | 値 |
|---|---|
| `PHOTO_QUEUE_NAME` | `azurerm_storage_queue.photo_processing.name` |
| `AZURE_OPENAI_CLASSIFY_DEPLOYMENT_NAME` | `azurerm_cognitive_deployment.classifier.name` |
| `AZURE_OPENAI_IDENTIFY_DEPLOYMENT_NAME` | `azurerm_cognitive_deployment.gpt5_luna.name`（段階4で使う。段階3で先に入れてよい） |
| `PHOTO_PROCESSING_MAX_ATTEMPTS` | `"3"` |
| `AI_DAILY_CALL_LIMIT` | 実測後に決める |
| `AZURE_MAPS_KEY`・`GEOCODING_DAILY_LIMIT` | Azure Maps を入れる場合だけ |

`AzureWebJobsStorage` は `azurerm_linux_function_app` が `storage_account_name` / `storage_account_access_key` から自動で設定する（既存）。キューのトリガーはこれを使う。

## 3. 段階4

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
| `mobile/` | **CI の対象外のまま。** PR のマージ前にローカルで `flutter analyze` / `flutter test` を通す。段階0で CI に入れるのが先（`docs/09_backlog.md`） |

- デプロイの順序: **インフラ（apply）→ API（マージでデプロイ）→ アプリ（実機にインストール）**。API が先だと `COSMOS_DB_ALBUM_CONTAINER` が無く起動時に失敗する。
  段階2の API は `AlbumService` のコンストラクタで環境変数を読むので、`album` が無い状態でデプロイすると旅行・写真の関数だけが 500 になり、植物図鑑は動く
- Function Key は変わらない（同じ Function App に関数を足すだけ）
- 新しい関数が登録されたことは、デプロイ後にポータルの「関数」一覧か `GET /api/trips` で確かめる（`app.ts` の import 忘れはここで分かる）
