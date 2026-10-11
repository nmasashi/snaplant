# SnapPlant 🌱

植物図鑑モバイルアプリ - Flutter + Azure Functions + Azure OpenAI による最新アーキテクチャ

> **美しいUI × 高精度AI識別** でスマートフォンから植物を瞬時に識別・保存

## 🌱 概要

SnapPlant は、Flutter で構築された植物図鑑モバイルアプリです。Azure OpenAI（デプロイメント `gpt-5.6-luna`）を活用した高精度な植物識別機能と、Material Design 3.0 による美しいユーザーインターフェースを提供します。

### 主な機能
- 🖼️ **画像選択** - ギャラリーから写真を選び、補足情報（最大500文字）を添えて送信
- 🤖 **AI植物識別** - Azure OpenAI（`gpt-5.6-luna`）による識別。候補は最大3件
- 📚 **植物図鑑** - 識別結果の保存・一覧表示・詳細表示・削除
- 🔍 **重複チェック** - 同名の植物があれば既存レコードの画像・信頼度を更新
- ⚙️ **設定管理** - APIキーとエンドポイントのセキュア保存・接続テスト

カメラ撮影には対応していない。写真の取得経路はギャラリー選択のみ。

## 🏗️ アーキテクチャ

### フロントエンド
- **Flutter 3.16+**: Material Design 3.0 による美しいUI
- **Dart 3.2+**: 型安全な開発言語
- **image_picker**: ギャラリーからの画像選択（カメラ撮影は画面から呼び出していない）
- **http**: Azure Functions API連携
- **flutter_secure_storage**: セキュアなAPIキー管理

### バックエンド
- **Azure Functions**: サーバーレス API ホスティング
- **Azure Cosmos DB**: 植物データの永続化（無料枠活用）
- **Azure Blob Storage**: 画像ファイルの保存（SAS URL対応）
- **Azure OpenAI Service**: `gpt-5.6-luna` デプロイメントによる植物識別（画像入力）
- **Application Insights**: 監視・ログ・分析

## 🚀 CI/CD

このプロジェクトは GitHub Actions による CI/CD パイプラインを使用しています。
ワークフローは5本です。

| ワークフロー | 対象 | 内容 |
|---|---|---|
| `.github/workflows/ci.yml` | `api/` | テスト・カバレッジ・ビルド・CodeQL |
| `.github/workflows/audit.yml` | `api/package.json`・`api/package-lock.json` | `npm audit --audit-level=high`（開発用の依存も含む）。high 以上の脆弱性があれば失敗します。毎週月曜 9:00（日本時間）の定期実行と手動実行もあります。デプロイの前提にはしていないため、失敗してもデプロイは止まりません |
| `.github/workflows/terraform.yml` | `infrastructure/` | `terraform fmt -check -recursive` と `terraform validate`（`-backend=false`）。Azure へは通信せず認証情報も不要で、`plan` は回しません |
| `.github/workflows/deploy-functions.yml` | `api/` | main ブランチへのプッシュで ci.yml を呼び、成功後に本番デプロイ |
| `.github/workflows/flutter.yml` | `mobile/` | Flutter 3.32.8 で `flutter pub get` → `flutter analyze`（info も含めて指摘があれば失敗します）→ `flutter test`（`TZ=Asia/Tokyo`）。手動実行もあります。デプロイの前提にはしていないため、失敗してもデプロイは止まりません |

詳細は [DEPLOYMENT.md](./DEPLOYMENT.md) を参照してください。

## 📝 API エンドポイント

| エンドポイント | メソッド | 説明 |
|---------------|----------|------|
| `/api/images/upload` | POST | 画像アップロード＋AI識別（統合） |
| `/api/plants/identify` | POST | 植物識別（既存画像URLから） |
| `/api/plants/check-duplicate` | GET | 重複チェック |
| `/api/plants/save` | POST | 識別結果の保存 |
| `/api/plants` | GET | 保存済み植物一覧 |
| `/api/plants/{id}` | GET | 植物詳細取得 |
| `/api/plants/{id}` | PUT | 植物情報更新 |
| `/api/plants/{id}` | DELETE | 植物削除 |

全エンドポイントは Function Key 認証（`?code={FUNCTION_KEY}`）が必要です。
レスポンスは `{ "success": true, "data": {...} }` 形式の共通封筒で返ります。
詳細は [OpenAPI 仕様書](./docs/06_api_openapi.yaml) を参照してください。

## 🛠️ 開発

### 前提条件

**バックエンド開発:**
- Node.js 22.x
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
- **Coverage**: `npm run test:coverage` で計測（計測結果は `api/coverage/` に出力）

## 🔒 セキュリティ

- Function Key 認証（クライアントは flutter_secure_storage にキーを保存）
- 入力値検証（画像の形式・サイズ、文字数上限、`imagePath` のスキーム・ホスト・パス形）
- 依存パッケージの脆弱性検査（`audit.yml` の `npm audit --audit-level=high`。high 以上で失敗しますが、デプロイは止めません）
- CodeQL による静的解析（`ci.yml`。解析ステップは `continue-on-error: true` のため、失敗してもワークフローは失敗しません）
- CORS は Function App 側で**全オリジンを許可**（`infrastructure/main.tf` の `allowed_origins = ["*"]`）。オリジンの制限はしていません

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
- [バックログ（未実装・既知の課題）](./docs/09_backlog.md)

**運用:**
- [デプロイメントガイド](./DEPLOYMENT.md)
