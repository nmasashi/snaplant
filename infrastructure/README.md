# SnapPlant Infrastructure

このディレクトリにはSnapPlantアプリケーションのインフラストラクチャコード（Terraform）が含まれています。

## ディレクトリ構成

```
infrastructure/
├── README.md                 # このファイル
├── main.tf                   # 全リソースの定義（モジュール分割はしていない）
├── variables.tf              # 変数定義
├── outputs.tf                # 出力値定義
├── terraform.tfvars.example  # 設定例（terraform.tfvars は .gitignore 済み）
└── scripts/                  # デプロイ・管理スクリプト
    ├── deploy.sh              # terraform init → plan → apply
    ├── deploy-functions.sh    # Function App のコードデプロイ
    ├── destroy.sh             # terraform destroy
    ├── tf.cmd / tf.js         # 通信の切れる日でも terraform を回す（IPv4 でつながれば IPv4 の中継を通す）
    └── get-publish-profile.sh # GitHub Secrets 用の Publish Profile 取得
```

リソースは `main.tf` 1ファイルにまとめている（再利用可能なモジュールには分割していない）。
定義しているのは、リソースグループ / Storage Account（`images`・`temp-images`・`photos` の3コンテナと、`temp-images` を1日で消すライフサイクル管理）/
Cosmos DB（`snaplant-db`・`plants`・`album`）/ App Service Plan / Linux Function App /
Application Insights / Azure OpenAI（`gpt-6-luna` デプロイメント）。
Azure API Management と Key Vault は**定義していない**。

## CI での静的チェック

`.github/workflows/terraform.yml` が `infrastructure/` の変更時に走る。

```bash
terraform fmt -check -recursive   # 整形崩れがあると失敗する
terraform init -backend=false
terraform validate
```

**`.tf` を編集したら `terraform fmt` をかけてからコミットすること。**
CI は Azure へ通信せず認証情報も使わないため、`terraform plan` は回らない。

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

# azurerm プロバイダ v4 からはサブスクリプション ID の指定が必須。
# terraform を直接実行するときは環境変数で渡す（scripts/deploy.sh・destroy.sh は自動で設定する）
export ARM_SUBSCRIPTION_ID=$(az account show --query id -o tsv)
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

`variables.tf` で宣言している変数は次の12個。`terraform.tfvars` で上書きする。

```hcl
# 基本設定
project_name = "snaplant"
# 実際の本番デプロイ先は West Europe（variables.tf の既定値 Japan East を上書きしている）
location = "West Europe"

# Cosmos DB設定
cosmos_db_consistency_level = "Session"
cosmos_db_throughput        = 400

# Functions設定
functions_plan_tier = "Y1"  # Consumption plan

# Storage設定
storage_account_tier     = "Standard"
storage_replication_type = "LRS"

# Application Insights設定
application_insights_type = "web"

# Azure OpenAI設定
openai_location    = "East US"
openai_sku         = "S0"
openai_api_version = "2024-12-01-preview"

# タグ設定
tags = {
  Project   = "SnapPlant"
  ManagedBy = "Terraform"
}
```

Azure OpenAI の**APIキーは入力値ではない**。Terraform が作成した
`azurerm_cognitive_account.openai` の `primary_access_key` を Function App の
`app_settings` に流し込む。

`terraform.tfvars.example` は `variables.tf` の宣言12個と一致している。
以前は宣言の無い `openai_api_key` と `cognitive_services_sku` が残っていて、
**本物のキーを書かせておいて一切使わない**という誘導になっていた。
逆に `openai_location` が無く、OpenAI のリージョンを変える手段がなかった。

`openai_location` は `location` とは別物。使うモデル（今は `gpt-6-luna`）が使えるリージョンが
限られているため、OpenAI だけ別リージョンに置いている。

## この PC からの実行（`scripts/tf.cmd`）

この環境からは IPv4 か IPv6 の片方の接続が、日によって確立した直後に切られる。HashiCorp（`registry.terraform.io`・
`releases.hashicorp.com`）にも Azure の管理 API（`management.azure.com`）にも起きる。Terraform（Go）は IPv6 を先に使い、
切られても IPv4 に切り替えない。再送しない POST（`listKeys` など）だけが `connection may have been reset` で失敗し、
`plan` / `apply` が通らない。Windows の IPv4 優先の設定（`netsh interface ipv6 set prefixpolicy ::ffff:0:0/96 60 4`）は
Terraform には効かなかった（2026-10-12）。

そのため `plan` / `apply` は `infrastructurescripts	f.cmd plan` / `apply` で回す（コマンドプロンプト・Git Bash のどちらからでも、
どこからでも可）。IPv4 で Azure と HashiCorp につながれば IPv4 だけでつなぐ中継（`tf.js`。TLS は中身を見ずに転送する）を通し、
つながらなければそのまま `terraform` を実行する。2026-10-12 以降の apply はこれで通している。

`terraform init` のプロバイダのダウンロードもこれで通るはずだが未確認。通らなければ、`curl -4` で再試行しながら
プロバイダの zip を落とし、公開されている `SHA256SUMS` と照合したうえで
`<dir>/registry.terraform.io/hashicorp/<name>/terraform-provider-<name>_<ver>_windows_amd64.zip` に置いて
`terraform init -plugin-dir=<dir>` で読み込ませる。`terraform validate` は Azure と通信しないので、そのまま実行できる
（CI の `terraform.yml` でも回る）。

## セキュリティ

### 機密情報の管理
- `terraform.tfvars` ファイルは `.gitignore` に追加済み（`*.tfvars` を除外）
- Azure OpenAI のキーなどは Terraform が Function App の `app_settings` に直接流し込む。
  Azure Key Vault は**導入していない**

### 状態ファイル管理

現状はローカルの `terraform.tfstate` だけで、リモートバックエンドは設定していない。
`*.tfstate` は `.gitignore` 済みなのでリポジトリには含まれない（＝クローンした環境には
state が無い）。

```bash
# リモートストレージ設定（未適用・推奨構成）
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
- **Cosmos DB**: 無料枠（`enable_free_tier = true`、400 RU/s）を活用
- **Functions**: Consumption Plan（`Y1`）使用
- **Storage**: Standard / LRS（アクセス層は既定のまま）
- **Azure OpenAI**: `S0` SKU、`gpt-6-luna` を GlobalStandard でデプロイ
- **API Management**: 未導入（固定費を避けるため Function Key 認証で代替）

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

### OpenAIモデル移行（gpt-5.6-luna → gpt-6-luna、2026-10-17）

リソース名を `azurerm_cognitive_deployment.gpt5_luna` から `gpt6_luna` に替え、`moved` ブロックで state の上でも続きとして扱う。
デプロイ名（`gpt-6-luna`）が変わるので作り直しになるが、`create_before_destroy` で新しいデプロイを先に作り、
Function App の `AZURE_OPENAI_DEPLOYMENT_NAME` を替えてから古い `gpt-5.6-luna` を消す（植物図鑑の識別が止まる時間を作らない）。
`plan` では `gpt6_luna` の作り直し（`+/-`、create before destroy）と Function App の設定の更新が出る。

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

なお `backend` 設定は無く、`*.tfstate` は `.gitignore` 済みでリポジトリに含まれない。
state を持たない環境で `apply` すると全リソースを新規作成しようとするため、
先に「状態ファイル管理」セクションのリモートbackendを設定するか、
既存の state を手元に用意すること。

## 参考リンク

- [Azure Provider Documentation](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs)
- [Terraform Best Practices](https://www.terraform.io/docs/cloud/guides/recommended-practices/index.html)
- [Azure Naming Conventions](https://docs.microsoft.com/en-us/azure/cloud-adoption-framework/ready/azure-best-practices/naming-and-tagging)