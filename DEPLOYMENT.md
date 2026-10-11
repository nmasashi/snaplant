# SnapPlant デプロイメントガイド

## 概要

SnapPlant は Azure Functions を使用した植物識別 API です。このガイドでは、GitHub Actions を使用した自動デプロイの設定方法を説明します。

## アーキテクチャ

- **Azure Functions**: サーバーレス API ホスティング
- **Azure Cosmos DB**: 植物データストレージ
- **Azure Blob Storage**: 画像ストレージ
- **Application Insights**: 監視・ログ
- **Azure OpenAI**: 植物識別AI（Vision + Structured Outputs）

## 初回セットアップ

### 1. インフラストラクチャのデプロイ

```bash
# 1. terraform.tfvars を設定
cd infrastructure
cp terraform.tfvars.example terraform.tfvars
# プロジェクト名・リージョン・SKU などを環境に合わせて編集する

# 2. インフラストラクチャをデプロイ
./scripts/deploy.sh
```

Azure OpenAI のキーは入力値ではない。Terraform が `azurerm_cognitive_account.openai` を
作成し、その `primary_access_key` を Function App の `app_settings`
（`AZURE_OPENAI_API_KEY`）へ流し込む。`terraform.tfvars.example` にある
`openai_api_key` はどの変数定義にも対応していないため、値を入れても使われない
（Terraform は「宣言されていない変数」として警告を出して無視する）。

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
  - `api/` または `.github/workflows/` 配下のファイル変更時
  - `deploy-functions.yml` からの `workflow_call`

- **Dependency Audit** (`/.github/workflows/audit.yml`):
  - `main` ブランチへのプッシュ
  - `main` ブランチへのプルリクエスト
  - プッシュ・プルリクエストとも、`api/package.json`・`api/package-lock.json`・
    `.github/workflows/audit.yml` の変更時のみ
  - 毎週月曜 0:00 UTC（日本時間 9:00）の定期実行（コードを触っていない間に公表された脆弱性を拾うため）
  - 手動実行（workflow_dispatch）
  - `api/` で `npm audit --audit-level=high` を実行する。`npm ci` はしない（`package-lock.json` だけを読む）。
    開発用の依存も対象に含む
  - high 以上の脆弱性があれば失敗する（`continue-on-error` は付けていない）。moderate を失敗条件に
    含めないのは、Jest の間接依存の `sprintf-js` に修正版が出ておらず、含めると常に失敗するため
  - 定期実行が失敗すると、GitHub がワークフローの cron を最後に変更した人へメールで通知する
  - ci.yml とは別ワークフローにしている。`deploy-functions.yml` が ci.yml の成功を
    デプロイの前提にしているため、ここが失敗しても**デプロイは止まらない**（検知はするが止めるまではしない判断）

- **Terraform 静的チェック** (`/.github/workflows/terraform.yml`):
  - `main`, `develop` ブランチへのプッシュ
  - `main` ブランチへのプルリクエスト
  - `infrastructure/` または `.github/workflows/terraform.yml` の変更時
  - `terraform fmt -check -recursive` と `terraform init -backend=false` → `terraform validate` のみ。
    **Azure へは通信せず、認証情報も GitHub Secrets も不要**
  - `terraform plan` は回さない（認証情報が必要になるうえ、ローカルの
    `terraform.tfstate` が実態と乖離していると誤った差分を出す）
  - ci.yml とは別ワークフローにしている。`deploy-functions.yml` が ci.yml の成功を
    デプロイの前提にしているため、ci.yml に足すとインフラ定義の整形崩れが
    API のデプロイを止めてしまう

- **Production Deploy** (`/.github/workflows/deploy-functions.yml`):
  - `main` ブランチへのプッシュ
  - `api/` または `.github/workflows/` 配下のファイル変更時
  - 手動実行（workflow_dispatch）

`mobile/`（Flutter）を対象にしたワークフローは存在しない。`flutter analyze` と
`flutter test` は自動実行されず、PR を出す前にローカルで手動実行する運用。

### ワークフロー

1. **テスト & ビルド**（ci.yml）:
   - 依存関係のインストール（`npm ci`）
   - テスト実行（`npm test` / `npm run test:coverage`）
   - ビルド（`npm run build`）とビルド成果物のアーカイブ
   - `npm run lint` は存在しないためスキップされる（リンター未設定）
   - 上とは別ジョブ（Security Scan）で CodeQL を並列に実行する。解析ステップは
     `continue-on-error: true` なので、解析が失敗してもワークフローは失敗しない
   - `npm audit` はここでは実行しない（audit.yml に分けている）

2. **本番デプロイ** (mainブランチのみ):
   - 本番用ビルド
   - Azure Functions へのデプロイ
   - ヘルスチェック

依存パッケージの脆弱性検査（audit.yml）はこの流れとは独立して走り、結果はデプロイに影響しない。

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

- Azure OpenAI のキーは Terraform が Function App の app_settings に直接流し込む（`terraform.tfvars` は Git 管理外）
- GitHub Secrets で認証情報を安全に保管
- 各関数は `authLevel: 'function'`。呼び出しには `?code={FUNCTION_KEY}` が必要
- CORS は **全オリジン許可**（`infrastructure/main.tf` の `site_config.cors.allowed_origins = ["*"]`）。
  Blob Storage 側の `cors_rule` も `allowed_origins = ["*"]`。オリジンの制限はしていない

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
| `COSMOS_DB_DATABASE` | Cosmos DB データベース名 |
| `COSMOS_DB_CONTAINER` | Cosmos DB コンテナ名 |
| `STORAGE_CONNECTION_STRING` | Storage Account 接続文字列（`BlobEndpoint=` を含む形式は未対応） |
| `STORAGE_CONTAINER_NAME` | 永続画像用 Blob コンテナ名 |
| `TEMP_STORAGE_CONTAINER_NAME` | 一時画像用 Blob コンテナ名 |
| `AZURE_OPENAI_ENDPOINT` | Azure OpenAI エンドポイント |
| `AZURE_OPENAI_API_KEY` | Azure OpenAI APIキー |
| `AZURE_OPENAI_DEPLOYMENT_NAME` | モデルデプロイメント名（モデル名として使用） |
| `AZURE_OPENAI_API_VERSION` | Azure OpenAI APIバージョン（未設定時は `2024-12-01-preview`） |
| `APPINSIGHTS_INSTRUMENTATIONKEY` | Application Insights キー |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | Application Insights 接続文字列 |

これらは `infrastructure/main.tf` の `azurerm_linux_function_app.main` で Terraform が設定します。
Application Insights の2つは `site_config` の `application_insights_key` / `application_insights_connection_string` から、
それ以外は `app_settings` から設定されます（azurerm v4 は Application Insights とランタイム関係の設定を
プロバイダ自身が管理するため、`app_settings` に直接書かない）。
ローカル開発では `api/local.settings.json` の `Values` に同じキーを置きます。

`AZURE_OPENAI_ENDPOINT` が未設定の場合のみ、コードは OpenAI 公式 API にフォールバックし
`OPENAI_API_KEY` を参照します（`api/src/services/openAIVisionService.ts`）。

`AZURE_OPENAI_ENDPOINT` が設定されている場合（Azure）の要求先は
`${AZURE_OPENAI_ENDPOINT}/openai/deployments/${AZURE_OPENAI_DEPLOYMENT_NAME}` で、
クエリの `api-version` に `AZURE_OPENAI_API_VERSION`（未設定時は `2024-12-01-preview`）を付けます。
キー（`AZURE_OPENAI_API_KEY`）は `api-key` ヘッダで送ります（`openai` SDK の `apiKey` にも
同じ値を渡しているため、SDK 既定の `Authorization: Bearer` ヘッダも付きます）。

### `STORAGE_CONNECTION_STRING` の制約

`BlobEndpoint=` を含む接続文字列を設定すると、`StorageService` のコンストラクタが
`BlobEndpointを明示した接続文字列は未対応です` で例外を投げます。
`CosmosService` は内部で `StorageService` を持つため、`POST /api/plants/identify`
以外のすべてのエンドポイントが 500 `INTERNAL_ERROR` になります。

`AccountName` と `EndpointSuffix` から Blob エンドポイントのホストを組み立てて
URL を検証しているため、`BlobEndpoint=` で別のホストを指定されると
「自分が生成した URL を自分で拒否する」状態になるためです。
静かに誤動作させるのではなく、サービスの初期化時点で失敗させる方針です
（`api/src/services/storageService.ts`）。

組み立てるホストは `<AccountName>.blob.<EndpointSuffix>` です。`EndpointSuffix` を省いた場合は
`core.windows.net` としてホストを組み立てます（`<AccountName>.blob.core.windows.net`）。

Terraform が流し込む `azurerm_storage_account.main.primary_connection_string` は
`BlobEndpoint=` を含まないため、本番でこの制約に触れることはありません。
Azurite などパス形式のエンドポイントを使うローカル開発は未対応で、
[バックログ](./docs/09_backlog.md) に判断待ちとして分離しています。
