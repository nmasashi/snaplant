# SnapPlant 🌱

植物図鑑モバイルアプリ - Flutter + Azure Functions + Azure OpenAI による最新アーキテクチャ

> **美しいUI × 高精度AI識別** でスマートフォンから植物を瞬時に識別・保存

## 🌱 概要

SnapPlant は、Flutter で構築された植物図鑑モバイルアプリです。Azure OpenAI（デプロイメント `gpt-6-luna`）を活用した高精度な植物識別機能と、Material Design 3.0 による美しいユーザーインターフェースを提供します。

### 主な機能
- 🧳 **旅行アルバム** - 旅行を作り、ギャラリーから選んだ写真をまとめて送る（撮影日時・位置・地名を添える）。旅行ごとに撮影日時の順で見る・移す・消す
- 🤖 **AIによる分類と識別** - 送った写真を、サーバの裏の処理が Azure OpenAI（`gpt-6-luna`）で植物・食べ物・風景・その他に分け、植物・食べ物・風景は名前まで識別する
- 📚 **図鑑** - 識別した写真を種類と名前ごとにまとめて見る
- ⚙️ **設定管理** - APIキーとエンドポイントのセキュア保存・接続テスト

カメラ撮影には対応していない。写真の取得経路はギャラリー選択のみ。
植物の写真を1枚ずつ識別して登録する以前の植物図鑑の API は 4-6 で削除した（`docs/05_api_design.md` §9.1）。
要件と設計は [docs/](./docs/01_requirements.md)。

## 🏗️ アーキテクチャ

### フロントエンド
- **Flutter 3.16+**: Material Design 3.0 による美しいUI
- **Dart 3.2+**: 型安全な開発言語
- **image_picker**: ギャラリーからの画像選択（カメラ撮影は画面から呼び出していない）
- **http**: Azure Functions API連携
- **flutter_secure_storage**: セキュアなAPIキー管理

### バックエンド
- **Azure Functions**: サーバーレス API ホスティング
- **Azure Cosmos DB**: 旅行と写真の情報の永続化（無料枠活用）
- **Azure Blob Storage**: 写真の保存（非公開。SAS URL で渡す）と、解析の待ちのキュー（Storage Queue）
- **Azure OpenAI Service**: `gpt-6-luna` デプロイメントによる写真の分類と識別（画像入力）と、タイムラインの区切り案と文（文字だけ）
- **Application Insights**: 監視・ログ・分析

## 🚀 CI/CD

このプロジェクトは GitHub Actions による CI/CD パイプラインを使用しています。
ワークフローは5本です。

| ワークフロー | 対象 | 内容 |
|---|---|---|
| `.github/workflows/ci.yml` | `api/` | テスト・ビルド・CodeQL |
| `.github/workflows/audit.yml` | `api/package.json`・`api/package-lock.json` | `npm audit --audit-level=high`（開発用の依存も含む）。high 以上の脆弱性があれば失敗します。毎週月曜 9:00（日本時間）の定期実行と手動実行もあります。デプロイの前提にはしていないため、失敗してもデプロイは止まりません |
| `.github/workflows/terraform.yml` | `infrastructure/` | `terraform fmt -check -recursive` と `terraform validate`（`-backend=false`）。Azure へは通信せず認証情報も不要で、`plan` は回しません |
| `.github/workflows/deploy-functions.yml` | `api/` | main ブランチへのプッシュで ci.yml を呼び、成功後に本番デプロイ |
| `.github/workflows/flutter.yml` | `mobile/` | Flutter 3.32.8 で `flutter pub get` → `flutter analyze`（info も含めて指摘があれば失敗します）→ `flutter test`（`TZ=Asia/Tokyo`）。手動実行もあります。デプロイの前提にはしていないため、失敗してもデプロイは止まりません |

詳細は [DEPLOYMENT.md](./DEPLOYMENT.md) を参照してください。

## 📝 API エンドポイント

| エンドポイント | メソッド | 説明 |
|---------------|----------|------|
| `/api/trips` | POST | 旅行の作成 |
| `/api/trips` | GET | 旅行一覧（旅行に属さない写真の枚数も返す） |
| `/api/trips/{tripId}` | GET | 旅行詳細 |
| `/api/trips/{tripId}` | PUT | 旅行の更新 |
| `/api/trips/{tripId}` | DELETE | 旅行の削除（`deletePhotos` が `true` なら中の写真も消し、`false` なら未所属に移す） |
| `/api/photos` | POST | 写真の保存（multipart） |
| `/api/photos` | GET | 写真一覧（旅行・未所属・カテゴリで絞り、ページで返す） |
| `/api/photos/move` | POST | 写真を旅行へ移す・旅行から外す |
| `/api/photos/{photoId}` | GET | 写真の詳細 |
| `/api/photos/{photoId}` | PATCH | 写真のコメント・タグの更新 |
| `/api/photos/{photoId}` | DELETE | 写真の削除 |
| `/api/photos/{photoId}/process` | POST | 写真の解析（分類・識別）のやり直しの受付 |
| `/api/catalog/kinds` | GET | 図鑑の種類の一覧 |
| `/api/catalog/entries` | GET | 図鑑の項目の一覧（種類ごと） |
| `/api/catalog/entry` | GET | 図鑑の項目の詳細（種類と名前で指定） |
| `/api/trips/{tripId}/timeline` | GET | タイムライン（完成版の日と場面、下書きの状態、写真の増えた・消えた枚数）と、解析中の写真の枚数 |
| `/api/trips/{tripId}/timeline` | POST | タイムラインを作る・作り直す（区切り案の下書きを作ってキューに積む。202） |
| `/api/trips/{tripId}/timeline/draft` | GET | タイムラインの下書きの状態（確かめ中か、文を書くのに失敗した下書きなら日と場面も） |
| `/api/trips/{tripId}/timeline/draft` | DELETE | タイムラインの下書きをやめる |
| `/api/trips/{tripId}/timeline/draft/scenes` | PUT | タイムラインの下書きの区切りを保存する（確かめ中の日と場面を返す） |
| `/api/trips/{tripId}/timeline/draft/write` | POST | タイムラインの下書きの区切りで文を書く（文を書く待ちにしてキューに積む。202。書き終えると下書きが完成版に入れ替わる） |
| `/api/trips/{tripId}/timeline/recut` | POST | タイムラインの完成版の区切りを直し始める（完成版の区切りを写した確かめ中の下書きを作り、その日と場面を返す） |
| `/api/trips/{tripId}/timeline/days/{date}` | PATCH | タイムラインの完成版の日のタイトル・まとめを直す（空か `null` なら AI の文に戻す） |
| `/api/trips/{tripId}/timeline/scenes/{photoId}` | PATCH | タイムラインの完成版の場面の見出し・一言を直す（`photoId` は場面の最初の写真。空か `null` なら AI の文に戻す） |
| `/api/trips/{tripId}/timeline/dropped-edits` | DELETE | タイムラインの残せなかった文の知らせを閉じる |

全エンドポイントは Function Key 認証（`?code={FUNCTION_KEY}`）が必要です。
レスポンスは `{ "success": true, "data": {...} }` 形式の共通封筒で返ります。
詳細は [API 設計](./docs/05_api_design.md) を参照してください
（OpenAPI の仕様書は置いていません。API 設計が正です）。
植物図鑑の API（`/api/images/upload`・`/api/plants/*`）は 4-6 で削除しました。

HTTP 以外に、2つのワーカー（Storage Queue のトリガー。写真の解析とタイムラインの区切り案・文）と2つのタイマー（止まった解析とタイムラインの下書きの再投入・孤児の掃除）があります（`api/README.md`）。

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
- 入力値検証（画像の形式・サイズ、写真 ID と画像のハッシュの照合、文字数上限）
- 写真の Blob は非公開で、読み取り専用の SAS 付き URL を応答のたびに作って渡す（クライアントから URL を受け取る API は無い）
- 依存パッケージの脆弱性検査（`audit.yml` の `npm audit --audit-level=high`。high 以上で失敗しますが、デプロイは止めません）
- CodeQL による静的解析（`ci.yml`。解析ステップは `continue-on-error: true` のため、失敗してもワークフローは失敗しません）
- CORS は Function App 側で**全オリジンを許可**（`infrastructure/main.tf` の `allowed_origins = ["*"]`）。オリジンの制限はしていません

## 📈 監視

- Application Insights による詳細な監視
- GitHub Actions による自動デプロイ監視
- エラー追跡とパフォーマンス分析

## 📄 ドキュメント

**設計・仕様:**
設計書は目指す姿を書き、実装した節に「実装済み」の印を付ける（README と DEPLOYMENT は実装の写し）。

- [要件定義](./docs/01_requirements.md)
- [設計の全体像と決定の記録](./docs/02_design_overview.md)
- [画面設計（アプリの作りの方針を含む）](./docs/03_screen_design.md)
- [データ設計（Cosmos DB・Blob Storage）](./docs/04_data_design.md)
- [API 設計（共通の決まりを含む）](./docs/05_api_design.md)
- [裏の処理（分類・識別・タイムライン）](./docs/06_processing_design.md)
- [インフラ設計](./docs/07_infrastructure_design.md)
- [テスト計画](./docs/08_test_plan.md)
- [実装計画（PR の分け方）](./docs/11_implementation_plan.md)
- [バックログ（未実装・既知の課題）](./docs/09_backlog.md)

**運用:**
- [デプロイメントガイド](./DEPLOYMENT.md)
