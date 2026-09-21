# SnapPlant Infrastructure

このディレクトリにはSnapPlantアプリケーションのインフラストラクチャコード（Terraform）が含まれています。

## ディレクトリ構成

```
infrastructure/
├── README.md                 # このファイル
├── main.tf                   # メインのTerraform設定
├── variables.tf              # 変数定義
├── outputs.tf                # 出力値定義
├── terraform.tfvars.example  # 設定例
├── modules/                  # 再利用可能なTerraformモジュール
│   ├── cosmos-db/           # Cosmos DB モジュール
│   ├── storage/             # Blob Storage モジュール
│   ├── functions/           # Azure Functions モジュール
│   ├── cognitive-services/  # Cognitive Services モジュール
│   └── api-management/      # API Management モジュール
└── scripts/                # デプロイ・管理スクリプト
    ├── deploy.sh
    └── destroy.sh
```

## 前提条件

### 必要なツール
- [Terraform](https://www.terraform.io/downloads.html) >= 1.0
- [Azure CLI](https://docs.microsoft.com/en-us/cli/azure/install-azure-cli) >= 2.0

### Azure認証
```bash
# Azure CLIでログイン
az login

# サブスクリプション確認
az account show

# 必要に応じてサブスクリプション変更
az account set --subscription "your-subscription-id"
```

## 使用方法

### 1. インフラのデプロイ

```bash
# infrastructureディレクトリに移動
cd infrastructure

# 設定ファイルをコピー
cp terraform.tfvars.example terraform.tfvars

# terraform.tfvarsを編集（後述）

# 初期化
terraform init

# プラン確認
terraform plan

# デプロイ実行
terraform apply
```

### 2. 設定

`terraform.tfvars` ファイルで以下を設定：

```hcl
# 基本設定
project_name = "snaplant"
location     = "Japan East"

# Cosmos DB設定
cosmos_db_consistency_level = "Session"
cosmos_db_throughput       = 400

# Functions設定
functions_plan_tier = "Y1"  # Consumption plan

# タグ設定
tags = {
  Project   = "SnapPlant"
  ManagedBy = "Terraform"
}
```

## セキュリティ

### 機密情報の管理
- `terraform.tfvars` ファイルは `.gitignore` に追加済み
- Azure Key Vaultを使用して機密情報を管理
- 本番環境では最小権限の原則を適用

### 状態ファイル管理
```bash
# リモートストレージ設定（推奨）
terraform {
  backend "azurerm" {
    resource_group_name  = "rg-terraform-state"
    storage_account_name = "stterraformstate"
    container_name       = "terraform-state"
    key                  = "snaplant/terraform.tfstate"
  }
}
```

## コスト管理

### コスト最適化
- **Cosmos DB**: 無料枠（400 RU/s）を活用
- **Functions**: Consumption Plan使用
- **Storage**: 使用量に応じてCool/Hot tier選択
- **API Management**: Developer tier使用
- **Cognitive Services**: 無料枠を最大活用

## トラブルシューティング

### よくある問題

1. **Azure Provider認証エラー**
   ```bash
   az login
   az account set --subscription "your-subscription-id"
   ```

2. **リソース名の競合**
   - `terraform.tfvars`でユニークな名前を設定
   - `random_string`リソースを活用

3. **権限不足**
   - Contributor以上の権限が必要
   - Service Principalの場合は適切なロール割り当て

## メンテナンス

### 定期作業
- Terraformバージョンの更新
- Providerバージョンの更新
- セキュリティパッチの適用
- 不要なリソースのクリーンアップ

### OpenAIモデル移行時のstate整合（gpt-4o → gpt-5.6-luna）

モデル移行に伴い、Terraformリソース名を `azurerm_cognitive_deployment.gpt4o` から
`azurerm_cognitive_deployment.gpt5_luna` にリネームしている。また `gpt-5.6-luna` は
`Standard` SKU非対応のため `scale.type` を `GlobalStandard` に変更している。

`gpt-5.6-luna` デプロイは既にAzure上に手動作成済みのため、**stateを突き合わせずに
apply するとリソース重複エラーになる**。既存stateがある環境では以下の手順で整合させる。

```bash
# 1. 既存の gpt-4o デプロイをstate管理から外す
#    （Azure上のリソースは削除されない。後述の判断後に手動削除する）
terraform state rm azurerm_cognitive_deployment.gpt4o

# 2. 手動作成済みの gpt-5.6-luna デプロイをstateに取り込む
terraform import azurerm_cognitive_deployment.gpt5_luna \
  "/subscriptions/<SUBSCRIPTION_ID>/resourceGroups/<RG_NAME>/providers/Microsoft.CognitiveServices/accounts/<OPENAI_ACCOUNT_NAME>/deployments/gpt-5.6-luna"

# 3. 差分が出ないことを確認（capacity の差分が出る場合は変数側を実態に合わせる）
terraform plan
```

なお、このリポジトリには `backend` 設定とローカルstateファイルが存在しない。
state管理が未設定の環境で `apply` すると全リソースを新規作成しようとするため、
先に「状態ファイル管理」セクションのリモートbackendを設定すること。

### 旧 gpt-4o デプロイの扱い（未対応）

Azure上に残っている `gpt-4o` という名前のデプロイは、中身が `gpt-5.1` に
差し替わっており名前と実体が食い違っている。削除する場合は、**先に Function App の
`AZURE_OPENAI_DEPLOYMENT_NAME` を `gpt-5.6-luna` に切り替えること**。
この設定が `gpt-4o` を指したままデプロイを削除すると本番APIが即座に停止する。

## 参考リンク

- [Azure Provider Documentation](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs)
- [Terraform Best Practices](https://www.terraform.io/docs/cloud/guides/recommended-practices/index.html)
- [Azure Naming Conventions](https://docs.microsoft.com/en-us/azure/cloud-adoption-framework/ready/azure-best-practices/naming-and-tagging)