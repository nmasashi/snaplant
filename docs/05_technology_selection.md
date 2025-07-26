# SnapPlant 技術選定・アーキテクチャ設計書

## 1. 概要

植物図鑑アプリ「SnapPlant」のMVP版をAzureサービスを活用して構築するための技術選定とアーキテクチャ設計を行います。

## 2. アーキテクチャ概要図

```mermaid
graph TB
    %% Frontend
    App[Android App<br/>React Native + TypeScript]
    
    %% API Gateway
    APIM[Azure API Management<br/>認証・レート制限・監視]
    
    %% Backend Services
    Functions[Azure Functions<br/>サーバーレスAPI]
    
    %% Data Storage
    CosmosDB[(Azure Cosmos DB<br/>植物データ保存<br/>無料枠利用)]
    BlobStorage[(Azure Blob Storage<br/>画像ファイル保存)]
    
    %% AI Services
    OpenAIVision[OpenAI Vision API<br/>GPT-4 Vision<br/>植物識別AI]
    
    %% Monitoring
    AppInsights[Application Insights<br/>監視・ログ・分析]
    
    %% Connections
    App -->|HTTPS REST API| APIM
    APIM -->|リクエスト転送| Functions
    
    Functions -->|植物データCRUD| CosmosDB
    Functions -->|画像アップロード| BlobStorage
    Functions -->|AI識別リクエスト| OpenAIVision
    
    Functions -->|ログ・メトリクス| AppInsights
    App -->|テレメトリ| AppInsights
    
    %% Styling
    classDef frontend fill:#e1f5fe
    classDef backend fill:#f3e5f5
    classDef storage fill:#e8f5e8
    classDef ai fill:#fff3e0
    classDef monitoring fill:#fce4ec
    
    class App frontend
    class APIM,Functions backend
    class CosmosDB,BlobStorage storage
    class OpenAIVision ai
    class AppInsights monitoring
```

## 3. 技術選定

### 3.1 フロントエンド（モバイルアプリ）

#### 選定：React Native + TypeScript
- **理由**:
  - クロスプラットフォーム対応（iOS展開時の拡張性）
  - TypeScriptによる型安全性
  - 豊富なライブラリとコミュニティサポート
  - Azureとの親和性が高い

#### 主要ライブラリ
- **React Native CLI**: 0.72.x
- **TypeScript**: 5.x
- **React Navigation**: 画面遷移管理
- **react-native-image-picker**: 画像選択・撮影
- **@azure/storage-blob**: Blob Storage連携
- **react-native-vector-icons**: アイコン表示

### 3.2 バックエンド

#### 選定：Azure Functions (Node.js + TypeScript)
- **理由**:
  - サーバーレスでコスト効率が良い
  - 自動スケーリング
  - 開発・運用の簡易性
  - 従量課金でMVPに適している

#### Functions構成
- **HTTP Trigger**: REST API提供
- **Timer Trigger**: 定期処理（将来的なデータ整理等）
- **Blob Trigger**: 画像処理の非同期実行

### 3.3 データベース

#### 選定：Azure Cosmos DB (無料枠)
- **理由**:
  - **永続無料枠**: 1,000 RU/s + 25 GB ストレージ
  - MVPの小規模利用には十分
  - 自動スケーリング・高可用性
  - JSON形式でReact Nativeとの親和性が高い
  - グローバル分散可能

#### データ構造調整
```json
// plantsコンテナのドキュメント構造
{
  "id": "uuid",
  "name": "桜",
  "scientificName": "Prunus serrulata", 
  "familyName": "バラ科",
  "description": "詳細説明",
  "characteristics": "春に美しいピンクの花を咲かせる",
  "confidence": 95.5,
  "imagePath": "https://storage.../image.jpg",
  "createdAt": "2024-01-15T10:30:00Z",
  "updatedAt": "2024-01-15T10:30:00Z"
}
```

### 3.4 画像ストレージ

#### 選定：Azure Blob Storage (Hot Tier)
- **理由**:
  - 大容量画像ファイルの効率的な保存
  - CDN連携可能
  - REST API経由でのアクセス
  - コスト効率が良い

### 3.5 植物識別AI

#### 選定：OpenAI Vision API (GPT-4 Vision)
- **理由**:
  - 高精度な画像認識・植物識別能力
  - 専門知識による詳細な植物情報提供
  - REST API経由での利用
  - Azure OpenAI ServiceまたはOpenAI APIで利用可能
  - カスタムプロンプトによる柔軟な応答制御

### 3.6 API管理・セキュリティ

#### MVP段階：Azure Functions 標準機能
- **認証方式**: Function Key認証
  - 追加コストなし（APIMの月額¥7,000を回避）
  - 個人開発に適した単純な認証
  - クエリパラメータでの認証（`?code={key}`）

- **セキュリティ対策**:
  - HTTPS通信強制（Azure Functions標準）
  - CORS設定による呼び出し元制限
  - Application Insightsでの監視・ログ

#### 将来検討：Azure API Management
- **移行タイミング**: 商用化・大規模化時
- **追加機能**: レート制限、高度な認証、API バージョニング

### 3.7 監視・ログ

#### 選定：Azure Application Insights
- **機能**:
  - アプリケーション パフォーマンス監視
  - エラー追跡
  - ユーザー行動分析
  - カスタムイベント追跡

## 4. 詳細技術仕様

### 4.1 Azure Functions 構成

#### API エンドポイント設計
```typescript
// GET /api/plants - 植物一覧取得
// GET /api/plants/{id} - 植物詳細取得
// POST /api/plants - 植物新規登録
// PUT /api/plants/{id} - 植物情報更新
// DELETE /api/plants/{id} - 植物削除
// POST /api/identify - 植物識別
```

#### 使用パッケージ
- **@azure/functions**: Azure Functions ランタイム
- **@azure/cosmos**: Cosmos DB接続
- **@azure/storage-blob**: Blob Storage操作
- **openai**: OpenAI Vision API連携
- **multer**: ファイルアップロード処理

### 4.2 React Native アプリ構成

#### フォルダ構造
```
src/
├── components/     # 共通コンポーネント
├── screens/        # 画面コンポーネント（設定画面含む）
├── services/       # API通信・ビジネスロジック
├── types/          # TypeScript型定義
├── utils/          # ユーティリティ関数
├── security/       # セキュア保存・認証管理
└── navigation/     # 画面遷移設定
```

#### セキュリティ関連パッケージ
- **@react-native-async-storage/async-storage**: 設定データ保存
- **react-native-keychain**: APIキーのセキュア保存
- **@react-native-community/netinfo**: ネットワーク状態監視

#### API通信設定
- **認証**: Function Keyをクエリパラメータで送信
- **エラーハンドリング**: 401認証エラーの適切な処理
- **リトライ機能**: ネットワークエラー時の自動再試行

### 4.3 データフロー

#### 植物識別フロー
1. **認証確認**: 設定画面からAPIキー取得
2. **画像選択**: React Native → Blob Storage (Function Key認証)
3. **AI識別**: Azure Functions → OpenAI Vision API (Function Key認証)
4. **結果表示**: API Response → React Native
5. **データ保存**: React Native → Azure Functions → Cosmos DB (Function Key認証)

#### 認証フロー
1. **初回設定**: ユーザーが設定画面でAPIキー入力
2. **セキュア保存**: Keychainにキーを暗号化保存
3. **API呼び出し**: 全リクエストでクエリパラメータに認証キー付与
4. **エラー処理**: 401エラー時は設定画面への誘導

## 5. コスト見積もり（月額・東日本リージョン）

### 5.1 MVP段階（月間100ユーザー想定）
- **Azure Functions**: ¥500-800
- **Azure Cosmos DB**: **¥0** (無料枠内)
- **Azure Blob Storage (Hot)**: ¥200-400
- **Azure API Management (Developer)**: ¥4,500
- **OpenAI Vision API**: ¥1,500-3,000
- **Application Insights**: ¥300-500

**月額合計**: 約¥6,500-7,200 (**¥600-800の節約**)

### 5.2 成長段階（月間1,000ユーザー想定）
- **Azure Cosmos DB**: 無料枠超過で¥1,000-2,000追加
- その他サービスのスケールアップが必要
- **月額合計**: 約¥12,000-15,000

## 6. 開発・デプロイ戦略

### 6.1 CI/CD パイプライン

#### 選定：Azure DevOps
- **Azure Pipelines**: ビルド・テスト・デプロイ自動化
- **Azure Repos**: ソースコード管理（GitHubとの連携も可能）

#### デプロイフロー
```
開発者 → Git Push → Azure Pipelines → 
自動テスト → Azure Functions Deploy → 
Cosmos DB Setup → 完了
```

### 6.2 環境構成
- **開発環境**: ローカル + Azure Dev/Test サブスクリプション
- **ステージング環境**: Azure（本番同等構成）
- **本番環境**: Azure（高可用性構成）

## 7. セキュリティ設計

### 7.1 認証・認可

#### MVP段階: Azure Function Key認証
- **選定理由**:
  - Azure Functionsの標準機能で追加実装不要
  - アプリ設定画面でのユーザー管理が可能
  - 個人開発に適したシンプルな認証方式
  - API呼び出し時のクエリパラメータで認証

- **実装方式**:
  ```
  GET /api/plants?code={FUNCTION_KEY}
  POST /api/plants/identify?code={FUNCTION_KEY}
  ```

- **キー管理**:
  - Azure Portalでの手動生成・取得
  - モバイルアプリの設定画面で設定
  - React Native Keychainでのセキュア保存

#### 将来拡張: Azure Active Directory B2C
- **段階的移行計画**:
  - Phase 1: Function Key（MVP）
  - Phase 2: ユーザー登録・ログイン機能追加時にAAD B2C導入
  - Phase 3: OAuth 2.0 / OpenID Connect対応

- **HTTPS通信**: 全API通信の暗号化必須

### 7.2 データ保護
- **Azure Cosmos DB**: 保存時暗号化・ネットワーク暗号化
- **Azure Blob Storage**: アクセス制御・暗号化
- **Application Insights**: 個人情報のマスキング

## 8. 将来拡張性

### 8.1 スケーラビリティ対応
- **Azure Functions Premium Plan**: 高負荷時の対応
- **Azure Cosmos DB**: 無料枠から有料プランへの移行・自動スケーリング
- **Azure Content Delivery Network**: グローバル配信

### 8.2 機能拡張
- **プッシュ通知**: Azure Notification Hubs
- **リアルタイム通信**: Azure SignalR Service
- **機械学習強化**: Azure Machine Learning

## 9. リスク評価

### 9.1 技術リスク
- **OpenAI Vision API**: APIコストと利用制限
- **React Native**: ネイティブ機能制限
- **Azure Functions**: コールドスタート問題

### 9.2 対策
- **コスト最適化**: Azure OpenAI Serviceの利用検討
- **ハイブリッド開発**: 必要に応じてネイティブコード併用
- **Premium Plan**: パフォーマンス要件に応じた移行