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

# 画像保存用Blobコンテナの作成
resource "azurerm_storage_container" "images" {
  name                  = "images"
  storage_account_name  = azurerm_storage_account.main.name
  container_access_type = "blob"
}

# 一時画像保存用Blobコンテナの作成
resource "azurerm_storage_container" "temp_images" {
  name                  = "temp-images"
  storage_account_name  = azurerm_storage_account.main.name
  container_access_type = "private"
}

# 旅行アルバムの写真（原寸・サムネイル）用 Blob コンテナ。
# images と違い公開しない。読み取りは Blob 単位の SAS（有効期限は PHOTO_SAS_EXPIRY_MINUTES）
resource "azurerm_storage_container" "photos" {
  name                  = "photos"
  storage_account_name  = azurerm_storage_account.main.name
  container_access_type = "private"
}

# temp-images に残った Blob を最終更新から1日で消す。
# upload が途中で失敗すると一時 Blob が残り、コードの後片付けでは拾えない場合がある
# （関数のタイムアウト・プロセスの停止・削除自体の失敗）
resource "azurerm_storage_management_policy" "main" {
  storage_account_id = azurerm_storage_account.main.id

  rule {
    name    = "delete-temp-images"
    enabled = true
    filters {
      # 接頭辞で必ず絞る。同じアカウントを AzureWebJobsStorage が使っており、
      # 絞らないと Functions の鍵（azure-webjobs-secrets）や images・photos まで消える
      prefix_match = ["${azurerm_storage_container.temp_images.name}/"]
      blob_types   = ["blockBlob"]
    }
    actions {
      base_blob {
        delete_after_days_since_modification_greater_than = 1
      }
    }
  }
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

  # 無料枠を有効化 (400 RU/s + 25GB ストレージ)
  free_tier_enabled = true

  tags = var.tags
}

# Cosmos DB SQLデータベースの作成
resource "azurerm_cosmosdb_sql_database" "main" {
  name                = "snaplant-db"
  resource_group_name = azurerm_resource_group.main.name
  account_name        = azurerm_cosmosdb_account.main.name
}

# 植物データ用Cosmos DB SQLコンテナの作成
resource "azurerm_cosmosdb_sql_container" "plants" {
  name                = "plants"
  resource_group_name = azurerm_resource_group.main.name
  account_name        = azurerm_cosmosdb_account.main.name
  database_name       = azurerm_cosmosdb_sql_database.main.name
  partition_key_paths = ["/id"]

  # 無料枠の共有スループットを使用
  throughput = var.cosmos_db_throughput

  indexing_policy {
    indexing_mode = "consistent"

    included_path {
      path = "/*"
    }

    # `/"_etag"/?` の除外は Cosmos がシステム側で自動的に付ける。azurerm v4 は読み戻すときに
    # これを取り除くため、ここに書くと apply しても plan に「追加する」差分が出続ける
  }
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
    "COSMOS_DB_ENDPOINT"  = azurerm_cosmosdb_account.main.endpoint
    "COSMOS_DB_KEY"       = azurerm_cosmosdb_account.main.primary_key
    "COSMOS_DB_DATABASE"  = azurerm_cosmosdb_sql_database.main.name
    "COSMOS_DB_CONTAINER" = azurerm_cosmosdb_sql_container.plants.name

    # 旅行アルバム
    "COSMOS_DB_ALBUM_CONTAINER"    = azurerm_cosmosdb_sql_container.album.name
    "PHOTO_STORAGE_CONTAINER_NAME" = azurerm_storage_container.photos.name
    "PHOTO_SAS_EXPIRY_MINUTES"     = "60"

    # ストレージ接続設定
    "STORAGE_CONNECTION_STRING"   = azurerm_storage_account.main.primary_connection_string
    "STORAGE_CONTAINER_NAME"      = azurerm_storage_container.images.name
    "TEMP_STORAGE_CONTAINER_NAME" = azurerm_storage_container.temp_images.name

    # Azure OpenAI設定
    "AZURE_OPENAI_ENDPOINT"        = azurerm_cognitive_account.openai.endpoint
    "AZURE_OPENAI_API_KEY"         = azurerm_cognitive_account.openai.primary_access_key
    "AZURE_OPENAI_DEPLOYMENT_NAME" = azurerm_cognitive_deployment.gpt5_luna.name
    "AZURE_OPENAI_API_VERSION"     = var.openai_api_version
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

# GPT-5.6 Luna モデルのデプロイ (Vision機能含む)
# 注: gpt-5.6-luna は Standard SKU 非対応のため GlobalStandard を使用
resource "azurerm_cognitive_deployment" "gpt5_luna" {
  name                 = "gpt-5.6-luna"
  cognitive_account_id = azurerm_cognitive_account.openai.id

  model {
    format  = "OpenAI"
    name    = "gpt-5.6-luna"
    version = "2026-07-09"
  }

  sku {
    name = "GlobalStandard"
    # 1分あたりのトークン数の上限（千単位）。省略すると既定値の 1（= 1K TPM）になり、
    # 画像1枚の識別でも上限に達しうる。本番の値（150 = 150K TPM）を明示している
    capacity = 150
  }
}

