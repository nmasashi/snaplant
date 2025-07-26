# Azureプロバイダーの設定
terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~>3.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~>3.1"
    }
  }
  required_version = ">= 1.0"
}

# Microsoft Azureプロバイダーの設定
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
  location                = azurerm_resource_group.main.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
  account_kind            = "StorageV2"

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
  enable_free_tier = true

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
  partition_key_path  = "/id"

  # 無料枠の共有スループットを使用
  throughput = var.cosmos_db_throughput

  indexing_policy {
    indexing_mode = "consistent"

    included_path {
      path = "/*"
    }

    excluded_path {
      path = "/\"_etag\"/?"
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
  service_plan_id           = azurerm_service_plan.main.id

  site_config {
    application_stack {
      node_version = "20"
    }
    cors {
      allowed_origins = ["*"]
    }
  }

  app_settings = {
    "FUNCTIONS_WORKER_RUNTIME" = "node"
    "WEBSITE_NODE_DEFAULT_VERSION" = "~20"
    
    # Cosmos DB接続設定
    "COSMOS_DB_ENDPOINT" = azurerm_cosmosdb_account.main.endpoint
    "COSMOS_DB_KEY"      = azurerm_cosmosdb_account.main.primary_key
    "COSMOS_DB_DATABASE" = azurerm_cosmosdb_sql_database.main.name
    "COSMOS_DB_CONTAINER" = azurerm_cosmosdb_sql_container.plants.name
    
    # ストレージ接続設定
    "STORAGE_CONNECTION_STRING" = azurerm_storage_account.main.primary_connection_string
    "STORAGE_CONTAINER_NAME"    = azurerm_storage_container.images.name
    "TEMP_STORAGE_CONTAINER_NAME" = azurerm_storage_container.temp_images.name
    
    # OpenAI設定
    "OPENAI_API_KEY" = var.openai_api_key
    
    # Application Insights設定
    "APPINSIGHTS_INSTRUMENTATIONKEY" = azurerm_application_insights.main.instrumentation_key
    "APPLICATIONINSIGHTS_CONNECTION_STRING" = azurerm_application_insights.main.connection_string
    
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

