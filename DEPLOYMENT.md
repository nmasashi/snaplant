# SnapPlant デプロイメントガイド

## 概要

SnapPlant は Azure Functions を使用した植物識別 API です。このガイドでは、GitHub Actions を使用した自動デプロイの設定方法を説明します。

## アーキテクチャ

- **Azure Functions**: サーバーレス API ホスティング
- **Azure Cosmos DB**: 植物データストレージ
- **Azure Blob Storage**: 画像ストレージ
- **Application Insights**: 監視・ログ
- **OpenAI API**: 植物識別AI

## 初回セットアップ

### 1. インフラストラクチャのデプロイ

```bash
# 1. terraform.tfvars を設定
cd infrastructure
cp terraform.tfvars.example terraform.tfvars
# terraform.tfvars の openai_api_key を実際の値に設定

# 2. インフラストラクチャをデプロイ
./scripts/deploy.sh
```

### 2. GitHub Actions の設定

#### 2.1 Azure Function App の Publish Profile を取得

```bash
cd infrastructure/scripts
./get-publish-profile.sh
```

このスクリプトが以下の情報を出力します：
- Function App 名
- Publish Profile (XML)

#### 2.2 GitHub Secrets の設定

GitHub リポジトリの設定で以下のシークレットを追加：

1. **Settings** > **Secrets and variables** > **Actions** に移動
2. 以下のシークレットを追加：

| Secret Name | Value |
|-------------|-------|
| `AZURE_FUNCTIONAPP_NAME` | Function App名（スクリプト出力から） |
| `AZURE_FUNCTIONAPP_PUBLISH_PROFILE` | XML形式のPublish Profile（スクリプト出力から） |

#### 2.3 Production Environment の設定（オプション）

1. **Settings** > **Environments** で `production` 環境を作成
2. 必要に応じて保護ルールを設定（レビュワー、ブランチ制限など）

## 自動デプロイ

### トリガー条件

GitHub Actions は以下の条件で自動実行されます：

- **CI Pipeline** (`/.github/workflows/ci.yml`):
  - `main`, `develop` ブランチへのプッシュ
  - `main` ブランチへのプルリクエスト
  - `api/` フォルダ内のファイル変更時

- **Production Deploy** (`/.github/workflows/deploy-functions.yml`):
  - `main` ブランチへのプッシュ
  - `api/` フォルダ内のファイル変更時
  - 手動実行（workflow_dispatch）

### ワークフロー

1. **テスト & ビルド**:
   - 依存関係のインストール
   - テスト実行
   - セキュリティスキャン
   - ビルド

2. **本番デプロイ** (mainブランチのみ):
   - 本番用ビルド
   - Azure Functions へのデプロイ
   - ヘルスチェック

## 手動デプロイ

### 手動でGitHub Actionsを実行

1. GitHub リポジトリの **Actions** タブに移動
2. **Deploy to Production** ワークフローを選択
3. **Run workflow** をクリック

### ローカルからの手動デプロイ（緊急時）

```bash
# 1. アプリケーションをビルド
cd api
npm ci
npm run build

# 2. Azure Functions Core Tools でデプロイ
func azure functionapp publish <FUNCTION_APP_NAME> --build remote
```

## 監視とログ

### Application Insights

- **Azure Portal** > **Application Insights** でパフォーマンスとエラーを監視
- ライブメトリクス、ログクエリが利用可能

### GitHub Actions

- **Actions** タブでデプロイ履歴とログを確認
- 失敗時は詳細なエラーログを確認可能

## トラブルシューティング

### よくある問題

1. **デプロイが失敗する**
   - GitHub Secrets が正しく設定されているか確認
   - Azure の認証情報が有効か確認
   - Function App が存在するか確認

2. **テストが失敗する**
   - ローカルでテストを実行して問題を特定
   - 依存関係の問題がないか確認

3. **Function App が応答しない**
   - Azure Portal で Function App のログを確認
   - Application Insights でエラーを確認
   - 環境変数が正しく設定されているか確認

### ログの確認方法

```bash
# Azure CLI でログを確認
az functionapp log tail --name <FUNCTION_APP_NAME> --resource-group <RESOURCE_GROUP_NAME>

# または Azure Portal の Function App > Monitoring > Logs
```

## セキュリティ

- OpenAI API キーは Terraform 変数として管理
- GitHub Secrets で認証情報を安全に保管
- Function App の認証は必要に応じて設定
- CORS 設定で許可オリジンを制限

## コスト最適化

- Consumption Plan（Y1）を使用してコスト最小化
- Cosmos DB Free Tier を活用
- Storage Account は LRS で冗長化を最小限に

## 環境変数

Function App に設定される主要な環境変数：

| 変数名 | 説明 |
|--------|------|
| `COSMOS_DB_ENDPOINT` | Cosmos DB エンドポイント |
| `COSMOS_DB_KEY` | Cosmos DB アクセスキー |
| `STORAGE_CONNECTION_STRING` | Storage Account 接続文字列 |
| `OPENAI_API_KEY` | OpenAI API キー |
| `APPINSIGHTS_INSTRUMENTATIONKEY` | Application Insights キー |