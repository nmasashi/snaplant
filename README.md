# SnapPlant 🌱

植物図鑑モバイルアプリ - Flutter + Azure Functions + Azure OpenAI による最新アーキテクチャ

> **美しいUI × 高精度AI識別** でスマートフォンから植物を瞬時に識別・保存

## 🌱 概要

SnapPlant は、Flutter で構築された植物図鑑モバイルアプリです。Azure OpenAI GPT-4o Vision を活用した高精度な植物識別機能と、Material Design 3.0 による美しいユーザーインターフェースを提供します。

### 主な機能
- 📷 **カメラ撮影 & 画像選択** - 直感的な撮影インターフェース
- 🤖 **AI植物識別** - Azure OpenAI GPT-4o Vision による高精度識別
- 📚 **植物図鑑** - 識別結果の保存・一覧表示
- 🔍 **重複チェック** - 既存植物との重複確認
- ⚙️ **設定管理** - APIキーのセキュア保存

## 🏗️ アーキテクチャ

### フロントエンド
- **Flutter 3.16+**: Material Design 3.0 による美しいUI
- **Dart 3.2+**: 型安全な開発言語
- **image_picker**: カメラ・ギャラリー連携
- **http**: Azure Functions API連携
- **flutter_secure_storage**: セキュアなAPIキー管理

### バックエンド
- **Azure Functions**: サーバーレス API ホスティング
- **Azure Cosmos DB**: 植物データの永続化（無料枠活用）
- **Azure Blob Storage**: 画像ファイルの保存（SAS URL対応）
- **Azure OpenAI Service**: GPT-4o Vision による植物識別
- **Application Insights**: 監視・ログ・分析

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

**バックエンド開発:**
- Node.js 20.x
- Azure Functions Core Tools
- Azure CLI

**フロントエンド開発:**
- Flutter SDK 3.16+
- Dart SDK 3.2+
- Android Studio / VS Code
- Android SDK / iOS SDK

### ローカル開発

**バックエンドAPI:**
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

**Flutterアプリ:**
```bash
# Flutter環境確認
flutter doctor

# プロジェクト作成（初回のみ）
flutter create mobile
cd mobile

# 依存関係の取得
flutter pub get

# アプリ実行（デバッグモード）
flutter run

# リリースビルド
flutter build apk --release
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

**設計・仕様:**
- [要件定義](./docs/01_requirements.md)
- [機能一覧](./docs/02_feature_list.md)  
- [画面設計](./docs/03_screen_design.md)
- [データベース設計](./docs/04_database_design.md)
- [技術選定（Flutter対応）](./docs/05_technology_selection.md)
- [API設計書](./docs/06_api_design.md)
- [OpenAPI仕様書](./docs/06_api_openapi.yaml)
- [API ワークフロー](./docs/07_api_workflow.md)
- [Flutter UI設計](./docs/08_flutter_ui_design.md)

**運用:**
- [デプロイメントガイド](./DEPLOYMENT.md)

## 🤝 コントリビューション

1. フォークを作成
2. フィーチャーブランチを作成 (`git checkout -b feature/amazing-feature`)
3. 変更をコミット (`git commit -m 'Add amazing feature'`)
4. ブランチにプッシュ (`git push origin feature/amazing-feature`)
5. プルリクエストを作成