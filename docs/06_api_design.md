# SnapPlant API設計書

## 1. 概要

植物図鑑アプリ「SnapPlant」のREST API設計書です。Azure Functions + Cosmos DBをベースとしたサーバーレスAPIを定義します。

## 2. API設計思想

### 2.1 基本方針
- **RESTful**: リソース指向の設計
- **JSON**: 全レスポンスをJSON形式で統一
- **ステートレス**: セッション状態を持たない
- **HTTP Status Code**: 適切なステータスコード使用

### 2.2 エラーハンドリング
- 一貫したエラーレスポンス形式
- 適切なHTTPステータスコード
- 日本語エラーメッセージ

### 2.3 認証・セキュリティ
- **MVP段階**: Azure Function Key認証
- **将来拡張**: Azure AD B2C認証

#### Function Key認証
- `code` クエリパラメータでAPIキーを渡す
- 例: `GET /api/plants?code={FUNCTION_KEY}`
- POSTリクエストでも同様にクエリパラメータで指定
- キーの管理はクライアント側の設定画面で行う

## 3. エンドポイント設計

### 3.1 Base URL
```
https://func-snaplant-mk0w7s38.azurewebsites.net/api
```

### 3.2 エンドポイント一覧

| Method | Endpoint | 説明 | 認証 |
|--------|----------|------|------|
| GET | `/plants?code={key}` | 植物一覧取得 | Function Key |
| GET | `/plants/{id}?code={key}` | 植物詳細取得 | Function Key |
| POST | `/plants/save?code={key}` | 植物新規登録 | Function Key |
| PUT | `/plants/{id}?code={key}` | 植物情報更新 | Function Key |
| DELETE | `/plants/{id}?code={key}` | 植物削除 | Function Key |
| POST | `/plants/identify?code={key}` | 植物識別実行 | Function Key |
| POST | `/images/upload?code={key}` | 画像アップロード | Function Key |
| GET | `/plants/check-duplicate?name={植物名}&code={key}` | 重複確認 | Function Key |

## 4. データモデル

### 4.1 Plant Model
```json
{
  "id": "string (UUID)",
  "name": "string",
  "scientificName": "string | null",
  "familyName": "string | null", 
  "description": "string | null",
  "characteristics": "string",
  "confidence": "number (0-100)",
  "imagePath": "string (URL)",
  "createdAt": "string (ISO 8601)",
  "updatedAt": "string (ISO 8601)"
}
```

### 4.2 IdentificationResult Model
```json
{
  "candidates": [
    {
      "name": "string",
      "scientificName": "string | null",
      "familyName": "string | null",
      "description": "string | null",
      "characteristics": "string",
      "confidence": "number (0-100)"
    }
  ]
}
```

### 4.3 Error Model
```json
{
  "error": {
    "code": "string",
    "message": "string",
    "details": "string | null"
  }
}
```

## 5. API詳細仕様

### 5.1 植物一覧取得
取得済みの植物データを一覧で返します。作成日時の降順でソートされます。

**リクエスト例:**
```http
GET /api/plants?code={FUNCTION_KEY}
```

**レスポンス例:**
```json
{
  "success": true,
  "data": {
    "plants": [
      {
        "id": "123e4567-e89b-12d3-a456-426614174000",
        "name": "桜",
        "characteristics": "春に美しいピンクの花を咲かせる",
        "imagePath": "https://snaplant.blob.core.windows.net/images/sakura.jpg",
        "confidence": 95.5,
        "createdAt": "2024-01-15T10:30:00Z"
      }
    ],
    "total": 1
  }
}
```

### 5.2 植物詳細取得
指定されたIDの植物詳細情報を取得します。

**リクエスト例:**
```http
GET /api/plants/123e4567-e89b-12d3-a456-426614174000?code={FUNCTION_KEY}
```

**レスポンス例:**
```json
{
  "success": true,
  "data": {
    "plant": {
      "id": "123e4567-e89b-12d3-a456-426614174000",
      "name": "桜",
      "scientificName": "Prunus serrulata",
      "familyName": "バラ科",
      "description": "日本を代表する花木で、春に美しい花を咲かせる。",
      "characteristics": "春に美しいピンクの花を咲かせる",
      "confidence": 95.5,
      "imagePath": "https://snaplant.blob.core.windows.net/images/sakura.jpg",
      "createdAt": "2024-01-15T10:30:00Z",
      "updatedAt": "2024-01-15T10:30:00Z"
    }
  }
}
```

### 5.3 植物識別実行
アップロードされた画像とコンテキスト情報から植物を識別し、候補を返します。

**リクエスト例:**
```http
POST /api/plants/identify?code={FUNCTION_KEY}
Content-Type: application/json

{
  "imagePath": "https://snaplant.blob.core.windows.net/images/temp/uploaded.jpg",
  "contextInfo": "〇〇山の標高1300m、日当たりの良い場所"
}
```

**レスポンス例:**
```json
{
  "success": true,
  "data": {
    "result": {
      "isPlant": true,
      "candidates": [
        {
          "name": "桜",
          "scientificName": "Prunus serrulata",
          "familyName": "バラ科", 
          "description": "日本を代表する花木",
          "characteristics": "春に美しいピンクの花を咲かせる",
          "confidence": 95.5
        },
        {
          "name": "桜桃",
          "scientificName": "Prunus pseudocerasus",
          "familyName": "バラ科",
          "description": "桜に似た花を咲かせる",
          "characteristics": "冬〜早春に芳香のある花を咲かせる", 
          "confidence": 78.2
        },
        {
          "name": "梨",
          "scientificName": "Pyrus pyrifolia",
          "familyName": "バラ科",
          "description": "白い花を咲かせる果樹",
          "characteristics": "春に白い花を咲かせ、秋に果実をつける",
          "confidence": 65.1
        }
      ]
    }
  }
}
```

### 5.4 植物新規登録
識別結果から選択した植物を図鑑に保存します。

**リクエスト例:**
```http
POST /api/plants/save?code={FUNCTION_KEY}
Content-Type: application/json

{
  "name": "桜",
  "scientificName": "Prunus serrulata",
  "familyName": "バラ科",
  "description": "日本を代表する花木で、春に美しい花を咲かせる。",
  "characteristics": "春に美しいピンクの花を咲かせる",
  "confidence": 95.5,
  "imagePath": "https://snaplant.blob.core.windows.net/images/sakura.jpg"
}
```

**レスポンス例:**
```json
{
  "success": true,
  "data": {
    "plant": {
      "id": "123e4567-e89b-12d3-a456-426614174000",
      "name": "桜",
      "scientificName": "Prunus serrulata",
      "familyName": "バラ科",
      "description": "日本を代表する花木で、春に美しい花を咲かせる。",
      "characteristics": "春に美しいピンクの花を咲かせる",
      "confidence": 95.5,
      "imagePath": "https://snaplant.blob.core.windows.net/images/sakura.jpg",
      "createdAt": "2024-01-15T10:30:00Z",
      "updatedAt": "2024-01-15T10:30:00Z"
    }
  }
}
```

### 5.5 植物情報更新（重複時の画像置き換え）
既存植物の画像と信頼度を更新します。処理中に旧画像ファイルもBlob Storageから削除されます。

**リクエスト例:**
```http
PUT /api/plants/123e4567-e89b-12d3-a456-426614174000?code={FUNCTION_KEY}
Content-Type: application/json

{
  "imagePath": "https://snaplant.blob.core.windows.net/images/sakura_new.jpg",
  "confidence": 97.8
}
```

**処理詳細:**
1. 既存ドキュメント取得（旧imagePathを保存）
2. ドキュメント更新（新しいimagePath・confidence）
3. 旧画像ファイル削除（ストレージコスト最適化）
4. レスポンス返却

**レスポンス例:**
```json
{
  "success": true,
  "data": {
    "plant": {
      "id": "123e4567-e89b-12d3-a456-426614174000",
      "name": "桜",
      "imagePath": "https://snaplant.blob.core.windows.net/images/sakura_new.jpg",
      "confidence": 97.8,
      "updatedAt": "2024-01-15T10:30:00Z"
    }
  }
}
```

### 5.6 重複確認
同名の植物が既に登録されているかチェックします。

**リクエスト例:**
```http
GET /api/plants/check-duplicate?name=桜&code={FUNCTION_KEY}
```

**レスポンス例（存在する場合）:**
```json
{
  "success": true,
  "data": {
    "exists": true,
    "plant": {
      "id": "123e4567-e89b-12d3-a456-426614174000",
      "name": "桜",
      "imagePath": "https://snaplant.blob.core.windows.net/images/sakura.jpg",
      "confidence": 85.0,
      "createdAt": "2024-01-10T14:20:00Z"
    }
  }
}
```

**レスポンス例（存在しない場合）:**
```json
{
  "success": true,
  "data": {
    "exists": false
  }
}
```

### 5.7 植物削除
指定されたIDの植物を削除します。

**リクエスト例:**
```http
DELETE /api/plants/123e4567-e89b-12d3-a456-426614174000?code={FUNCTION_KEY}
```

**レスポンス例:**
```json
{
  "success": true,
  "data": {
    "message": "植物が正常に削除されました"
  }
}
```

### 5.8 画像アップロード・植物判定統合
植物画像をBlob Storageにアップロードし、コンテキスト情報と合わせてAI識別を実行します。植物でない場合は画像を削除します。

**リクエスト例:**
```http
POST /api/images/upload?code={FUNCTION_KEY}
Content-Type: multipart/form-data

{
  file: [binary data],
  contextInfo: "〇〇山の標高1300m、日当たりの良い場所"
}
```

**レスポンス例（植物の場合）:**
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

**レスポンス例（植物でない場合）:**
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

## 6. エラーレスポンス

### 6.1 共通エラー形式
```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "エラーの説明（日本語）",
    "details": "詳細情報（オプション）"
  }
}
```

### 6.2 エラーコード一覧

| HTTPステータス | エラーコード | 説明 |
|---------------|-------------|------|
| 400 | `INVALID_REQUEST` | リクエスト形式が不正 |
| 400 | `NOT_A_PLANT` | アップロードされた画像は植物ではない |
| 401 | `UNAUTHORIZED` | Function Key認証エラー |
| 401 | `INVALID_API_KEY` | APIキーが無効または期限切れ |
| 404 | `PLANT_NOT_FOUND` | 植物が見つからない |
| 409 | `PLANT_ALREADY_EXISTS` | 植物が既に存在 |
| 413 | `FILE_TOO_LARGE` | ファイルサイズ超過 |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | サポートされていないファイル形式 |
| 500 | `INTERNAL_ERROR` | サーバー内部エラー |
| 500 | `STORAGE_ERROR` | 画像ストレージエラー |
| 502 | `AI_SERVICE_ERROR` | AI識別サービスエラー |
| 503 | `DATABASE_ERROR` | データベース接続エラー |

## 7. レート制限

### 7.1 制限値
- **一般API**: 1分間に60リクエスト
- **画像アップロード**: 1分間に10リクエスト
- **植物識別**: 1分間に5リクエスト

### 7.2 制限時のレスポンス
```json
{
  "success": false,
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "リクエスト制限を超過しました。しばらく待ってから再度お試しください。",
    "details": "Retry after 60 seconds"
  }
}
```

## 8. ヘルスチェック

### 8.1 サービス状態確認
```http
GET /api/health
```

**レスポンス例:**
```json
{
  "success": true,
  "data": {
    "status": "healthy",
    "services": {
      "database": "healthy",
      "blobStorage": "healthy", 
      "aiService": "healthy"
    },
    "timestamp": "2024-01-15T10:30:00Z"
  }
}
```