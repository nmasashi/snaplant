# Azureプロバイダーの設定
terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~>4.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~>3.1"
    }
  }
  required_version = ">= 1.0"
}

# Microsoft Azureプロバイダーの設定
# v4 からサブスクリプション ID の指定が必須。ここには書かず、環境変数 ARM_SUBSCRIPTION_ID で渡す
# （scripts/deploy.sh・destroy.sh が az login 中のサブスクリプションから設定する）
provider "azurerm" {
  features {}
}

# リソース名の一意性確保のためのランダム文字列生成
resource "random_string" "suffix" {
  length  = 8
  upper   = false
  special = false
}

# リソースグループの作成
resource "azurerm_resource_group" "main" {
  name     = "rg-${var.project_name}-${random_string.suffix.result}"
  location = var.location
  tags     = var.tags
}

# 汎用ストレージアカウントの作成
resource "azurerm_storage_account" "main" {
  name                     = "st${var.project_name}${random_string.suffix.result}"
  resource_group_name      = azurerm_resource_group.main.name
  location                 = azurerm_resource_group.main.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
  account_kind             = "StorageV2"

  blob_properties {
    cors_rule {
      allowed_headers    = ["*"]
      allowed_methods    = ["GET", "HEAD", "POST", "PUT"]
      allowed_origins    = ["*"]
      exposed_headers    = ["*"]
      max_age_in_seconds = 3600
    }
  }

  tags = var.tags
}

# 旅行アルバムの写真（原寸・サムネイル）用 Blob コンテナ。
# 公開しない。読み取りは Blob 単位の SAS（有効期限は PHOTO_SAS_EXPIRY_MINUTES）
resource "azurerm_storage_container" "photos" {
  name                  = "photos"
  storage_account_name  = azurerm_storage_account.main.name
  container_access_type = "private"
}

# 旅行アルバムの写真の処理（段階3の分類・段階4の識別）のキュー。API の写真の送信が { photoId } を入れ、ワーカーが1件ずつ取る。
# 3回失敗した要求は Functions が自動で作る photo-processing-poison に落ちる（host.json の maxDequeueCount）。
# docs/travel-album/07_infrastructure_design.md §2・06_processing_design.md §1
resource "azurerm_storage_queue" "photo_processing" {
  name               = "photo-processing"
  storage_account_id = azurerm_storage_account.main.id
}

# Cosmos DBアカウントの作成
resource "azurerm_cosmosdb_account" "main" {
  name                = "cosmos-${var.project_name}-${random_string.suffix.result}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  offer_type          = "Standard"
  kind                = "GlobalDocumentDB"

  consistency_policy {
    consistency_level       = var.cosmos_db_consistency_level
    max_interval_in_seconds = 10
    max_staleness_prefix    = 200
  }

  geo_location {
    location          = azurerm_resource_group.main.location
    failover_priority = 0
  }

  # 無料枠を有効化。コンテナ（album）ごとに cosmos_db_throughput を確保するので、
  # 合計 RU/s が無料枠を超えないこと（docs/travel-album/04_data_design.md §6）
  free_tier_enabled = true

  tags = var.tags
}

# Cosmos DB SQLデータベースの作成
resource "azurerm_cosmosdb_sql_database" "main" {
  name                = "snaplant-db"
  resource_group_name = azurerm_resource_group.main.name
  account_name        = azurerm_cosmosdb_account.main.name
}

# 旅行アルバムの Cosmos DB コンテナ。旅行と写真を type で区別して置く。
# 写真が旅行をまたいで移動するので、PK は tripId ではなく /id。
# コンテナごとに RU/s を確保するため、種類ごとに分けず1つにまとめている（docs/travel-album/04 §6）
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

    # 図鑑の見出しの写真（信頼度が最も高く、同点なら識別の日時が新しいもの）を TOP 1 で引くため。
    # 2項目の ORDER BY は複合インデックスが無いと失敗するので、図鑑の API より先に apply する
    # （docs/travel-album/07_infrastructure_design.md §3.1）
    composite_index {
      index {
        path  = "/identification/confidence"
        order = "Descending"
      }
      index {
        path  = "/identification/at"
        order = "Descending"
      }
    }
  }
}


# Azure Functions用App Service Planの作成
resource "azurerm_service_plan" "main" {
  name                = "asp-${var.project_name}-${random_string.suffix.result}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  os_type             = "Linux"
  sku_name            = var.functions_plan_tier

  tags = var.tags
}

# Function Appの作成
resource "azurerm_linux_function_app" "main" {
  name                = "func-${var.project_name}-${random_string.suffix.result}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location

  storage_account_name       = azurerm_storage_account.main.name
  storage_account_access_key = azurerm_storage_account.main.primary_access_key
  service_plan_id            = azurerm_service_plan.main.id

  # HTTP の要求は HTTPS へ転送し、HTTP のまま処理しない。関数は Function Key（?code=）を URL で受け取るので、
  # HTTP で処理するとキーが平文で流れる。アプリはエンドポイントを利用者が入力し、ローカル開発（func start）の
  # http://localhost のために http も受け付けるので、本番を守るのはサーバ側のこの設定
  https_only = true

  # azurerm v4 では、ランタイム関係のアプリ設定（FUNCTIONS_WORKER_RUNTIME・WEBSITE_NODE_DEFAULT_VERSION）は
  # application_stack から、Application Insights のアプリ設定は site_config の専用項目から
  # プロバイダが設定する。app_settings に直接書くとプロバイダが読み戻すときに取り除くため、
  # plan のたびに「追加する」差分が出続け、apply のたびに再起動が起きる
  site_config {
    application_stack {
      node_version = "22"
    }
    cors {
      allowed_origins = ["*"]
    }
    application_insights_key               = azurerm_application_insights.main.instrumentation_key
    application_insights_connection_string = azurerm_application_insights.main.connection_string
  }

  app_settings = {
    # Cosmos DB接続設定
    "COSMOS_DB_ENDPOINT" = azurerm_cosmosdb_account.main.endpoint
    "COSMOS_DB_KEY"      = azurerm_cosmosdb_account.main.primary_key
    "COSMOS_DB_DATABASE" = azurerm_cosmosdb_sql_database.main.name

    # 旅行アルバム
    "COSMOS_DB_ALBUM_CONTAINER"    = azurerm_cosmosdb_sql_container.album.name
    "PHOTO_STORAGE_CONTAINER_NAME" = azurerm_storage_container.photos.name
    "PHOTO_SAS_EXPIRY_MINUTES"     = "60"

    # ストレージ接続設定
    "STORAGE_CONNECTION_STRING" = azurerm_storage_account.main.primary_connection_string

    # Azure OpenAI設定
    "AZURE_OPENAI_ENDPOINT"        = azurerm_cognitive_account.openai.endpoint
    "AZURE_OPENAI_API_KEY"         = azurerm_cognitive_account.openai.primary_access_key
    "AZURE_OPENAI_DEPLOYMENT_NAME" = azurerm_cognitive_deployment.gpt6_luna.name
    "AZURE_OPENAI_API_VERSION"     = var.openai_api_version

    # 旅行アルバムの写真の処理（段階3）。分類用のデプロイ名（AZURE_OPENAI_CLASSIFY_DEPLOYMENT_NAME）は書かない
    # （未設定なら AZURE_OPENAI_DEPLOYMENT_NAME を使う。07 §2）
    "PHOTO_QUEUE_NAME"              = azurerm_storage_queue.photo_processing.name
    "PHOTO_PROCESSING_MAX_ATTEMPTS" = "3"
  }

  # Azure がポータルの表示のために自動で付けるタグ。定義に無いので apply のたびに消そうとする差分が出る（害は無いが紛らわしい）
  lifecycle {
    ignore_changes = [tags["hidden-link: /app-insights-resource-id"]]
  }

  tags = var.tags

  depends_on = [azurerm_application_insights.main]
}

# Application Insightsの作成
resource "azurerm_application_insights" "main" {
  name                = "appi-${var.project_name}-${random_string.suffix.result}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  application_type    = "web"

  tags = var.tags
}

# Azure OpenAI Serviceの作成
resource "azurerm_cognitive_account" "openai" {
  name                = "openai-${var.project_name}-${random_string.suffix.result}"
  location            = var.openai_location
  resource_group_name = azurerm_resource_group.main.name
  kind                = "OpenAI"
  sku_name            = var.openai_sku

  tags = var.tags
}

# GPT-6 Luna モデルのデプロイ (Vision機能含む)。植物の識別と、旅行アルバムの分類・識別に使う
# （2026-10-17 に gpt-5.6-luna から切り替え。GPT-6 系で一番安く、提供の終了も 2028-03-11 と遅い。
#  分類と識別を別のモデルにするときは、分類用のデプロイを足して AZURE_OPENAI_CLASSIFY_DEPLOYMENT_NAME に書く。
#  docs/travel-album/07_infrastructure_design.md §2）
# 注: Standard SKU は無いので GlobalStandard を使用
resource "azurerm_cognitive_deployment" "gpt6_luna" {
  name                 = "gpt-6-luna"
  cognitive_account_id = azurerm_cognitive_account.openai.id

  model {
    format  = "OpenAI"
    name    = "gpt-6-luna"
    version = "2026-09-22"
  }

  sku {
    name = "GlobalStandard"
    # 1分あたりのトークン数の上限（千単位）。省略すると既定値の 1（= 1K TPM）になり、
    # 画像1枚の識別でも上限に達しうる。本番の値（150 = 150K TPM）を明示している
    capacity = 150
  }

  # デプロイ名が変わると作り直しになる。新しいデプロイを先に作り、Functions の向き先を替えてから古い方を消す
  # （写真の分類と識別が止まる時間を作らない）
  lifecycle {
    create_before_destroy = true
  }
}

# gpt5_luna（gpt-5.6-luna）から置き換えた。state の上でも同じリソースの続きとして扱う
moved {
  from = azurerm_cognitive_deployment.gpt5_luna
  to   = azurerm_cognitive_deployment.gpt6_luna
}

# 月額の予算アラート。AI の費用の安全弁（アプリの中に呼び出し回数のカウンタは置かない代わり。06 §6・07 §2）。
# 金額は請求の通貨（このサブスクリプションは米ドル）で、上限を超えても止まらず、メールで知らせるだけ
resource "azurerm_consumption_budget_resource_group" "main" {
  name              = "budget-${var.project_name}-${random_string.suffix.result}"
  resource_group_id = azurerm_resource_group.main.id

  amount     = var.monthly_budget_amount
  time_grain = "Monthly"

  time_period {
    # 月の初日。過去の月は指定できないので、作った月の初日にしている（変えると作り直しになる）
    start_date = "2026-10-01T00:00:00Z"
  }

  # 8割に達したときと、上限に達したとき（実際の利用額）に知らせる
  notification {
    enabled        = true
    threshold      = 80
    operator       = "GreaterThanOrEqualTo"
    threshold_type = "Actual"
    contact_emails = [var.budget_alert_email]
  }

  notification {
    enabled        = true
    threshold      = 100
    operator       = "GreaterThanOrEqualTo"
    threshold_type = "Actual"
    contact_emails = [var.budget_alert_email]
  }
}
