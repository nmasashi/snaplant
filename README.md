# SnapPlant

植物識別アプリケーション - Azure Functions ベースのサーバーレス API

## 🌱 概要

SnapPlant は、画像から植物を識別し、詳細情報を提供する Web API です。OpenAI の Vision API を活用した高精度な植物識別機能を提供します。

## 🏗️ アーキテクチャ

- **Azure Functions**: サーバーレス API ホスティング
- **Azure Cosmos DB**: 植物データの永続化
- **Azure Blob Storage**: 画像ファイルの保存
- **Azure OpenAI Service**: GPT-4o による植物識別
- **Application Insights**: 監視・ログ

## 🚀 自動デプロイ

このプロジェクトは GitHub Actions による CI/CD パイプラインを使用しています。

- **CI**: テスト、ビルド、セキュリティスキャン
- **CD**: main ブランチへのプッシュで自動本番デプロイ

詳細は [DEPLOYMENT.md](./DEPLOYMENT.md) を参照してください。

## 📝 API エンドポイント

| エンドポイント | メソッド | 説明 |
|---------------|----------|------|
| `/api/upload` | POST | 画像アップロード |
| `/api/identify` | POST | 植物識別 |
| `/api/save` | POST | 識別結果の保存 |
| `/api/plants` | GET | 保存済み植物一覧 |
| `/api/plants/{id}` | GET | 植物詳細取得 |
| `/api/plants/{id}` | PUT | 植物情報更新 |
| `/api/checkDuplicate` | POST | 重複チェック |

## 🛠️ 開発

### 前提条件

- Node.js 20.x
- Azure Functions Core Tools
- Azure CLI

### ローカル開発

```bash
# 依存関係のインストール
cd api
npm install

# ローカル実行
npm start

# テスト実行
npm test

# テストカバレッジ
npm run test:coverage
```

## 📊 テスト

- **Unit Tests**: Jest によるサービス層テスト
- **Integration Tests**: Function エンドポイントテスト
- **Coverage**: 88.7% のテストカバレッジ

## 🔒 セキュリティ

- API キーの安全な管理
- CORS 設定による制限
- 入力値検証
- セキュリティスキャンの自動実行

## 📈 監視

- Application Insights による詳細な監視
- GitHub Actions による自動デプロイ監視
- エラー追跡とパフォーマンス分析

## 📄 ドキュメント

- [デプロイメントガイド](./DEPLOYMENT.md)
- [API設計書](./docs/06_api_design.md)
- [OpenAPI仕様書](./docs/06_api_openapi.yaml)

## 🤝 コントリビューション

1. フォークを作成
2. フィーチャーブランチを作成 (`git checkout -b feature/amazing-feature`)
3. 変更をコミット (`git commit -m 'Add amazing feature'`)
4. ブランチにプッシュ (`git push origin feature/amazing-feature`)
5. プルリクエストを作成