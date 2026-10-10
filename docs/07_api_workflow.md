# SnapPlant APIワークフロー設計書

## 1. 概要

植物図鑑アプリ「SnapPlant」におけるAPI呼び出しの実行順序とデータフローを定義します。
ユーザーが画像をアップロードしてから植物一覧で確認されるまでの完全なワークフローを示します。

## 2. メインワークフロー：植物登録フロー

### 2.1 システム全体フロー図

```mermaid
sequenceDiagram
    participant Client as クライアント<br/>（Android App）  
    participant API as Azure Functions<br/>API
    participant Blob as Azure Blob Storage<br/>（画像ストレージ）
    participant AI as OpenAI Vision<br/>（AI識別サービス）
    participant DB as Cosmos DB<br/>（植物データ）

    Note over Client,DB: 1. 画像アップロード・植物判定・保存
    Client->>API: POST /images/upload<br/>（画像ファイル + コンテキスト情報）
    API->>Blob: 一時保存<br/>（一時コンテナ temp-images）
    Blob-->>API: 一時URL生成
    API->>AI: 植物判定リクエスト<br/>（一時URL + コンテキスト情報）
    
    alt 植物の場合
        AI-->>API: isPlant: true<br/>（植物候補・信頼度）
        API->>Blob: 永続保存に移動<br/>（temp-images → images）
        Blob-->>API: 永続URL生成
        API-->>Client: imagePath + candidates[]<br/>（永続URL + 識別結果）
    else 植物でない場合
        AI-->>API: isPlant: false<br/>（植物ではない）
        API->>Blob: 一時ファイル削除<br/>（temp-images から削除）
        API-->>Client: エラー<br/>「植物ではありません」
    end

    Note over Client,DB: 2. ユーザーの植物選択（クライアント処理）
    Note over Client: 識別候補から保存する植物を選択

    Note over Client,DB: 3. 重複確認（データベース検索）
    Client->>API: GET /plants/check-duplicate<br/>?name=選択植物名
    API->>DB: SELECT文実行<br/>WHERE name = @name
    DB-->>API: 検索結果<br/>（既存植物データ or 空）
    API-->>Client: exists, plant?<br/>（重複有無・既存データ）

    alt 重複なし（新規登録）
        Note over Client,DB: 4a. 新規植物データ保存
        Client->>API: POST /plants/save<br/>（植物データ）
        API->>DB: imagePathの重複確認<br/>WHERE imagePath = @imagePath
        DB-->>API: 既存レコード or 空

        alt imagePathが未使用
            API->>DB: INSERT文実行<br/>（新規ドキュメント作成）
            DB-->>API: 作成完了<br/>（保存されたドキュメント）
            API-->>Client: plant<br/>（保存完了データ）
        else imagePathが既に保存済み（リトライ）
            API-->>Client: 409 IMAGE_ALREADY_SAVED<br/>「この画像は既に保存されています」
        end
    else 重複あり（既存植物の画像更新）
        Note over Client,DB: 4b. 既存植物の画像・信頼度更新
        Client->>API: PUT /plants/{id}<br/>（新しい画像・信頼度）
        API->>DB: imagePath の重複確認<br/>（自分以外が使っていないか）
        DB-->>API: 既存レコード or 空
        alt 他レコードが同じimagePathを使用
            API-->>Client: 409 IMAGE_ALREADY_SAVED<br/>「この画像は既に保存されています」
        else 未使用（自分自身は除外）
            API->>DB: 既存ドキュメント取得<br/>（旧imagePathを保存）
            DB-->>API: 既存データ<br/>（旧imagePath含む）
            API->>DB: UPDATE文実行<br/>（imagePath, confidence更新）
            DB-->>API: 更新完了<br/>（更新されたドキュメント）
            API->>Blob: 旧画像ファイル削除<br/>（old-sakura.jpg削除）
            Blob-->>API: 削除完了
            API-->>Client: plant<br/>（更新完了データ）
        end
    end

    Note over Client,DB: 5. 最新植物一覧取得
    Client->>API: GET /plants
    API->>DB: SELECT文実行<br/>ORDER BY createdAt DESC
    DB-->>API: 植物一覧<br/>（作成日時降順）
    API-->>Client: plants[]<br/>（最新一覧データ）
```

### 2.2 データ更新詳細

各APIでどのストレージに何が保存・更新されるかの詳細：

| API | ストレージ | 操作 | 更新内容 |
|-----|-----------|------|----------|
| `POST /images/upload` | **Blob Storage**<br/>**OpenAI Vision** | CREATE<br/>READ | ①一時保存→植物判定→永続保存 or 削除<br/>②画像+コンテキスト情報で解析・植物識別実行 |
| `GET /plants/check-duplicate` | **Cosmos DB** | READ | name条件でのドキュメント検索（データ変更なし） |
| `POST /plants/save` | **Cosmos DB** | READ<br/>CREATE | ①`imagePath` の重複確認（既存なら 409 `IMAGE_ALREADY_SAVED` で保存しない）<br/>②新規植物ドキュメントを作成・保存 |
| `PUT /plants/{id}` | **Cosmos DB**<br/>**Blob Storage** | READ<br/>UPDATE<br/>DELETE | ①`imagePath` の重複確認（自分以外が使っていれば 409 `IMAGE_ALREADY_SAVED` で更新しない）<br/>②既存ドキュメントのimagePath・confidenceを更新<br/>③旧画像ファイルを削除（`imagePath` が変わった場合のみ。ゴミファイル防止） |
| `GET /plants` | **Cosmos DB** | READ | 全植物ドキュメントの取得（データ変更なし） |
| `GET /plants/{id}` | **Cosmos DB** | READ | 単一ドキュメントの取得（データ変更なし） |
| `DELETE /plants/{id}` | **Cosmos DB**<br/>**Blob Storage** | DELETE<br/>DELETE | ①ドキュメントを削除<br/>②`imagePath` が指す画像を削除（画像削除の失敗はログのみで、削除は成功扱い） |

### 2.3 ストレージ状態変化

#### ステップ1処理中: Blob Storageの状態変化

コンテナ名は環境変数で決まります（永続: `STORAGE_CONTAINER_NAME`、
一時: `TEMP_STORAGE_CONTAINER_NAME`）。Terraform が作成するのは
`images`（公開読み取り）と `temp-images`（非公開・SAS必須）の2つです。

**①一時保存:**
```
Azure Blob Storage Container: temp-images
├── 12345678-uuid-1.jpg  ← 一時保存（SASトークン付きURLを返す）
└── existing-temp-files.jpg
```

**②植物判定結果による分岐:**

**植物の場合（永続保存）:**
```
Azure Blob Storage Container: images
├── 12345678-uuid-1.jpg  ← temp-images から移動
├── 87654321-uuid-2.jpg  
└── existing-files.jpg

Azure Blob Storage Container: temp-images
└── existing-temp-files.jpg  ← 対象ファイルは削除済み
```

**植物でない場合（削除）:**
```
Azure Blob Storage Container: temp-images
└── existing-temp-files.jpg  ← 対象ファイル削除済み

※ images コンテナには何も追加されない
```

#### ステップ4a後: Cosmos DB新規保存の状態
```json
// 新規ドキュメントが追加される
{
  "id": "123e4567-e89b-12d3-a456-426614174000",  ← 新規作成
  "name": "桜",
  "imagePath": "https://snaplant.blob.core.windows.net/images/12345678-uuid-1.jpg",
  "confidence": 95.5,
  "createdAt": "2024-01-15T10:30:00Z",  ← 新規作成
  "updatedAt": "2024-01-15T10:30:00Z"   ← 新規作成
}
```

#### ステップ4b後: Cosmos DB更新 + Blob Storage削除の状態

**Cosmos DB:**
```json
// 既存ドキュメントが更新される
{
  "id": "123e4567-e89b-12d3-a456-426614174000",   // 変更なし
  "name": "桜",                                    // 変更なし
  "imagePath": "https://snaplant.blob.core.windows.net/images/12345678-uuid-1.jpg", ← 更新
  "confidence": 95.5,                             ← 更新（85.0→95.5）
  "createdAt": "2024-01-10T14:20:00Z",           // 変更なし
  "updatedAt": "2024-01-15T10:30:00Z"            ← 更新
}
```

**Blob Storage:**
```
Azure Blob Storage Container: images
├── 12345678-uuid-1.jpg  ← 新しい画像（残存）
├── 87654321-uuid-2.jpg  
└── existing-files.jpg   

// old-sakura.jpg は削除済み（ゴミファイル削除）
```

### 2.4 ステップ詳細

#### ステップ1: 画像アップロード・植物判定・保存
```http
POST /api/images/upload?code={FUNCTION_KEY}
Content-Type: multipart/form-data

{
  image: [binary data],
  contextInfo: "〇〇山の標高1300m、日当たりの良い場所"
}
```
画像は `image` フィールドで送信します。`contextInfo` はテキストフィールドで送る
500文字以内の文字列で、文字列でない場合（`補足情報は文字列で指定してください`）と
500文字超過の場合（`補足情報は500文字以内で指定してください`）は、
いずれも一時保存とAI呼び出しの前に 400 `INVALID_REQUEST` で弾かれます。

**レスポンス（植物の場合）:**
```json
{
  "success": true,
  "data": {
    "imagePath": "https://snaplant.blob.core.windows.net/images/12345678-uuid.jpg",
    "fileName": "plant.jpg",
    "contentType": "image/jpeg",
    "fileSize": 1048576,
    "identificationResult": {
      "isPlant": true,
      "confidence": 95.5,
      "candidates": [
        {
          "name": "桜",
          "scientificName": "Prunus serrulata",
          "familyName": "バラ科",
          "description": "日本を代表する花木",
          "characteristics": "春に美しいピンクの花を咲かせる",
          "confidence": 95.5
        }
      ]
    }
  }
}
```

**レスポンス（植物でない場合）:**
```json
{
  "success": false,
  "error": {
    "code": "NOT_A_PLANT",
    "message": "アップロードされた画像は植物ではありません",
    "details": "植物の画像を選択して再度お試しください"
  }
}
```

#### ステップ3: 重複確認
```http
GET /api/plants/check-duplicate?name=桜&code={FUNCTION_KEY}
```

**レスポンス（重複なし）:**
```json
{
  "success": true,
  "data": {
    "exists": false
  }
}
```

**レスポンス（重複あり）:**
```json
{
  "success": true,
  "data": {
    "exists": true,
    "plant": {
      "id": "123e4567-e89b-12d3-a456-426614174000",
      "name": "桜",
      "imagePath": "https://snaplant.blob.core.windows.net/images/old-sakura.jpg",
      "confidence": 85.0,
      "createdAt": "2024-01-10T14:20:00Z"
    }
  }
}
```

`imagePath` には `POST /images/upload` が返したURLを**そのまま**指定します
（ステップ4a・4b共通）。`https:` スキーム・自ストレージアカウントのBlobエンドポイント・
ちょうど `/<永続コンテナ名>/<Blob名>` の2セグメント・正規形との文字列完全一致の
すべてを満たさないURLは 400 `INVALID_REQUEST` になります。
クエリ文字列やフラグメントを足す、ホスト名を大文字にするといった加工をすると
受け付けられません（同じBlobを指していても別の文字列として保存され、
重複チェックと旧画像削除の判定が文字列比較で誤作動するため）。

#### ステップ4a: 新規植物保存（重複なしの場合）
```http
POST /api/plants/save?code={FUNCTION_KEY}
Content-Type: application/json

{
  "name": "桜",
  "scientificName": "Prunus serrulata",
  "familyName": "バラ科",
  "description": "日本を代表する花木",
  "characteristics": "春に美しいピンクの花を咲かせる",
  "confidence": 95.5,
  "imagePath": "https://snaplant.blob.core.windows.net/images/12345678-uuid.jpg"
}
```

同じ `imagePath` のレコードが既にある場合は保存せず 409 を返します。
保存に成功したがレスポンスが届かず、クライアントが同じ `imagePath` で再送した場合
（リトライ）がこの経路です。

```json
{
  "success": false,
  "error": {
    "code": "IMAGE_ALREADY_SAVED",
    "message": "この画像は既に保存されています"
  }
}
```

応答に既存レコードの `id` は含まれないため、クライアントは 409 を
「既に保存済み」と解釈し、ステップ5の `GET /plants` から該当レコードを探します。

#### ステップ4b: 既存植物更新（重複ありの場合）
```http
PUT /api/plants/123e4567-e89b-12d3-a456-426614174000?code={FUNCTION_KEY}
Content-Type: application/json

{
  "imagePath": "https://snaplant.blob.core.windows.net/images/12345678-uuid.jpg",
  "confidence": 95.5
}
```

**処理詳細：**
1. `imagePath` の重複確認（自分以外が同じ画像を使っていれば 409 で中断）
2. 既存ドキュメント取得（旧imagePathを保存）
3. ドキュメント更新（新しいimagePath・confidence）
4. 旧画像ファイル削除（`imagePath` が変わった場合のみ。`old-sakura.jpg`削除）
5. レスポンス返却

**レスポンス:**
```json
{
  "success": true,
  "data": {
    "plant": {
      "id": "123e4567-e89b-12d3-a456-426614174000",
      "name": "桜",
      "imagePath": "https://snaplant.blob.core.windows.net/images/12345678-uuid.jpg",
      "confidence": 95.5,
      "updatedAt": "2024-01-15T10:30:00Z"
    }
  }
}
```

#### ステップ5: 植物一覧取得
```http
GET /api/plants?code={FUNCTION_KEY}
```

**レスポンス:**
```json
{
  "success": true,
  "data": {
    "plants": [
      {
        "id": "123e4567-e89b-12d3-a456-426614174000",
        "name": "桜",
        "characteristics": "春に美しいピンクの花を咲かせる",
        "imagePath": "https://snaplant.blob.core.windows.net/images/12345678-uuid.jpg",
        "confidence": 95.5,
        "createdAt": "2024-01-15T10:30:00Z"
      }
    ],
    "total": 1
  }
}
```

## 3. サブワークフロー

### 3.1 植物詳細表示フロー

```mermaid
sequenceDiagram
    participant Client as クライアント
    participant PlantDetail as /plants/{id}

    Client->>PlantDetail: GET /plants/{id}
    PlantDetail-->>Client: plant (詳細情報)
```

### 3.2 植物削除フロー

```mermaid
sequenceDiagram
    participant Client as クライアント
    participant Delete as /plants/{id}
    participant Blob as Azure Blob Storage
    participant Plants as /plants

    Client->>Delete: DELETE /plants/{id}
    Delete->>Delete: ドキュメント削除前に imagePath を読む
    Delete->>Blob: imagePath の画像を削除
    Blob-->>Delete: 削除完了（失敗時はログのみ）
    Delete-->>Client: success message
    Client->>Plants: GET /plants
    Plants-->>Client: plants[] (更新された一覧)
```

## 4. エラーハンドリングパターン

### 4.1 各ステップでのエラー処理

#### ステップ1エラー: 画像アップロード・AI識別失敗
```json
// ストレージのエラー応答（502）
{
  "success": false,
  "error": {
    "code": "STORAGE_ERROR",
    "message": "ストレージサービスでエラーが発生しました"
  }
}

// ストレージへ接続できない（503）
{
  "success": false,
  "error": {
    "code": "STORAGE_ERROR",
    "message": "ストレージサービスに接続できません"
  }
}

// AI識別エラー（502）
{
  "success": false,
  "error": {
    "code": "AI_SERVICE_ERROR", 
    "message": "植物識別サービスでエラーが発生しました"
  }
}

// 植物ではない場合（400）
{
  "success": false,
  "error": {
    "code": "NOT_A_PLANT",
    "message": "アップロードされた画像は植物ではありません"
  }
}
```

502 と 503 の境目は**接続できたかどうか**です。名前解決・接続拒否・タイムアウト
（`ENOTFOUND` / `ECONNREFUSED` / `ETIMEDOUT`）はサービスに到達できていないので
503 `STORAGE_ERROR`、到達したうえで操作が失敗した場合が 502 になります。
このエンドポイントはネットワーク起因の失敗を AI 識別の判定より後に分類するため、
503 で返るコードは `STORAGE_ERROR` だけです（`AI_SERVICE_ERROR` の 503 は
`POST /plants/identify` 側にしかありません）。

**対応**: ユーザーに再アップロードを促す

#### ステップ3エラー: 重複確認失敗
```json
{
  "success": false,
  "error": {
    "code": "DATABASE_ERROR",
    "message": "データベースに接続できません"
  }
}
```
**対応**: 重複確認をスキップして新規保存を試行

#### ステップ4エラー: 保存/更新失敗
```json
// 新規保存失敗
{
  "success": false,
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "植物の保存に失敗しました"
  }
}

// 更新失敗
{
  "success": false,
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "植物の更新に失敗しました"
  }
}

// 同じ画像が既に保存済み（409・新規保存と更新の両方）
{
  "success": false,
  "error": {
    "code": "IMAGE_ALREADY_SAVED",
    "message": "この画像は既に保存されています"
  }
}
```
**対応**: データの再送信または後で再試行。
ただし 409 `IMAGE_ALREADY_SAVED` は再送しても解消しないため、
「既に保存済み」として扱い、`GET /plants` から該当レコードを探す

なお旧画像の削除に失敗しても**エラーにはなりません**。`PUT /plants/{id}` も
`DELETE /plants/{id}` も、Blob 削除の失敗はサーバ側のログ出力だけで、
ドキュメント操作は成功として 200 を返します（応答に `details` は付きません）。

## 5. パフォーマンス考慮事項

### 5.1 実行時間見積もり

| ステップ | 想定時間 | 重要度 |
|---------|---------|-------|
| 1. 画像アップロード | 2-5秒 | 高 |
| 2. AI植物識別 | 3-8秒 | 最高 |
| 3. 重複確認 | 0.1-0.5秒 | 中 |
| 4. 保存/更新 | 0.2-1秒 | 高 |
| 5. 一覧取得 | 0.1-0.5秒 | 中 |

**総実行時間**: 約5-15秒

### 5.2 最適化ポイント

1. **並列処理**: ステップ2の識別処理中にステップ3の重複確認を並行実行可能
2. **キャッシュ活用**: 一覧データのクライアントサイドキャッシュ
3. **プログレス表示**: 長時間処理のユーザーフィードバック
4. **リトライ機能**: ネットワークエラー時の自動再試行

## 6. 実装上の注意点

### 6.1 状態管理

- 各ステップの実行状態をクライアントで適切に管理
- エラー発生時の状態リセット処理
- 途中キャンセル時のクリーンアップ処理

### 6.2 セキュリティ

- 全てのAPI呼び出しでFunction Key認証を実施
- アップロードファイルの形式・サイズ検証
- XSS対策としてのレスポンスデータサニタイズ

### 6.3 ユーザビリティ

- 各ステップでの適切なローディング表示
- エラー時の分かりやすいメッセージ表示
- 長時間処理の途中キャンセル機能

## 7. テストシナリオ

### 7.1 正常系テスト

1. **完全フロー**: 画像アップロード → 識別 → 重複なし → 新規保存 → 一覧確認
2. **重複フロー**: 画像アップロード → 識別 → 重複あり → 画像更新 → 一覧確認
3. **キャンセルフロー**: 各ステップでのキャンセル操作

### 7.2 異常系テスト

1. **ネットワークエラー**: 各ステップでの通信障害
2. **サービス障害**: AI識別サービス、データベース障害
3. **不正データ**: 無効な画像、不正なリクエストデータ

### 7.3 パフォーマンステスト

1. **大容量画像**: 制限値ギリギリの画像ファイル
2. **同時実行**: 複数ユーザーの同時利用
3. **長時間実行**: 識別処理の最大実行時間

## 8. 運用監視

### 8.1 メトリクス

- 各ステップの成功率・実行時間
- エラー発生頻度・種別
- ユーザーの離脱ポイント

### 8.2 アラート

- AI識別サービスの応答時間異常
- データベース接続エラー急増
- 画像アップロード失敗率上昇

このワークフロー設計書により、SnapPlant APIの実行順序と各ステップの詳細が明確になり、フロントエンド実装・テスト設計・運用監視の指針となります。