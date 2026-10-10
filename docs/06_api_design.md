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
| POST | `/images/upload?code={key}` | 画像アップロード＋AI識別（一時保存→判定→永続化） | Function Key |
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
  "isPlant": "boolean",
  "confidence": "number (0-100)",
  "reason": "string",
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
`isPlant: false` の場合、`candidates` は空配列になります。

### 4.3 Error Model
失敗時も成功時と同じ封筒に包まれます（`success: false` + `error`）。

```json
{
  "success": false,
  "error": {
    "code": "string",
    "message": "string",
    "details": "string | null"
  }
}
```
`details` は省略されることがあります（`createErrorResponse()` に渡されなかった場合、
JSON にキー自体が現れません）。

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

`imagePath` は**URLとしてパースできれば受け付けます**。`POST /api/plants/save` や
`PUT /api/plants/{id}` の `imagePath` に課しているスキーム・ホスト・パス形の制約
（5.4 参照）は、このエンドポイントでは適用していません。
指定されたURLはそのままAI識別サービスへ渡されます。

`contextInfo` は文字列で、500文字以内です。
- 文字列以外（数値・配列・オブジェクトなど）→ 400 `INVALID_REQUEST`（`補足情報は文字列で指定してください`）
- 500文字超過 → 400 `INVALID_REQUEST`（`補足情報は500文字以内で指定してください`）

`null` と未指定は「補足情報なし」として扱います。
上限値は環境変数 `CONTEXT_INFO_MAX_LENGTH` で変更できます
（正の整数として読めない値を設定した場合は既定の 500 が使われます）。

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
`imagePath` には `POST /api/images/upload` が返したURLを指定します。
次のすべてを満たさないURLは 400 `INVALID_REQUEST`
（`画像アップロードAPIが返したURLを指定してください`）になります。

- スキームが `https:`（`http:` やその他のスキームは不可）
- ホストが自ストレージアカウントのBlobエンドポイント（外部ホストは不可）
- パスがちょうど `/<永続コンテナ名>/<Blob名>` の2セグメント
  （一時コンテナ、中間に余分なセグメントを挟んだURL、コンテナまでしか指していないURLは不可）
- 送られた文字列が `https://<Blobエンドポイントのホスト>/<永続コンテナ名>/<Blob名>` と
  **完全一致**すること。同じBlobを指す別表記はすべて不可
  （クエリ文字列 `?...`、フラグメント `#...`、`https://user:pass@...` の認証情報、
  ホスト名の大文字、先頭の空白など）

最後の条件があるのは、保存されるのが正規化後のURLではなく**送られた文字列そのもの**
だからです。表記の違うURLが保存されると、文字列の完全一致に頼っている2箇所
（`save` の `imagePath` 重複チェックと、更新時に旧画像を消すかの判定）が誤作動します。

#### 同じ画像の二重保存（409）

同じ `imagePath` を持つレコードが既に存在する場合は保存せず、
409 `IMAGE_ALREADY_SAVED`（`この画像は既に保存されています`、`details` なし）を返します。

```json
{
  "success": false,
  "error": {
    "code": "IMAGE_ALREADY_SAVED",
    "message": "この画像は既に保存されています"
  }
}
```

これは「保存には成功したがレスポンスが届かず、クライアントが同じ `imagePath` で
再送する」リトライを冪等にするためです。同じ `imagePath` のレコードが2件あると、
一方の削除や画像更新でもう一方の画像まで消えてしまいます。

応答に既存レコードの `id` は含めません。クライアントは 409 を受けたら
「既に保存済み」と解釈し、`GET /api/plants` から該当レコードを探します。

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
`imagePath` の形の制約は 5.4 と同じです（`https:` スキーム・自ストレージアカウントの
Blobエンドポイント・ちょうど `/<永続コンテナ名>/<Blob名>` の2セグメント・正規形との完全一致）。
旧画像の削除が発火するため、保存前にスキーム・ホスト・パスの形を検証しています。

`imagePath` の重複も 5.4 と同様に検査します。**更新対象自身は除外**するため、
`imagePath` を変えずに他のフィールドだけ更新しても 409 にはなりません。
自分以外のレコードが同じ `imagePath` を使っている場合は更新せず、
409 `IMAGE_ALREADY_SAVED`（`この画像は既に保存されています`、`details` なし）を返します。
save 側だけ塞いでも PUT から同じ状態を作れるため、入口を揃えています。
なお Cosmos DB 側が返す 409 はこのエンドポイントでは変換していないため 500 になります
（5.4 の新規登録だけが 409 `DATABASE_ERROR` に変換します）。

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
1. `imagePath` の重複確認（自分以外が同じ画像を使っていれば 409 で中断）
2. 既存ドキュメント取得（旧imagePathを保存。見つからなければ 404）
3. ドキュメント更新（新しいimagePath・confidence）
4. 旧画像ファイル削除（`imagePath` が変わった場合のみ。ストレージコスト最適化）
5. レスポンス返却

旧画像の削除に失敗してもエラーにはならず、ログ出力のみで 200 を返します。

**レスポンス例（抜粋。実際は更新後の Plant の全フィールドが返ります）:**
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
更新されるのは `imagePath` / `confidence` / `updatedAt` だけで、
`name` や `characteristics` などは既存ドキュメントの値がそのまま残ります。

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
Cosmos DB のドキュメントを削除した後、`imagePath` が指すBlob Storage上の画像も削除します。
画像の削除に失敗した場合はログ出力のみで、ドキュメント削除は成功として 200 を返します。

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
`contextInfo` はテキストフィールドで送る500文字以内の文字列です。
- 文字列でない（ファイルとして送られた場合など）→ 400 `INVALID_REQUEST`（`補足情報は文字列で指定してください`）
- 500文字超過 → 400 `INVALID_REQUEST`（`補足情報は500文字以内で指定してください`）

いずれも一時保存とAI呼び出しの前に弾かれます。

**リクエスト例:**
```http
POST /api/images/upload?code={FUNCTION_KEY}
Content-Type: multipart/form-data

{
  image: [binary data],
  contextInfo: "〇〇山の標高1300m、日当たりの良い場所"
}
```
画像は `image` フィールドで送信します。

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

`fileName` はクライアントが送信したファイル名をそのまま返します。
Blob 名は UUID + 検証済み Content-Type から決めた拡張子なので、`imagePath` 末尾のファイル名とは一致しません。

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

| HTTPステータス | エラーコード | 説明 | 返す箇所 |
|---------------|-------------|------|----------|
| 400 | `INVALID_REQUEST` | リクエスト形式が不正 | 全エンドポイント |
| 400 | `NOT_A_PLANT` | アップロードされた画像は植物ではない | `POST /api/images/upload` |
| 404 | `PLANT_NOT_FOUND` | 植物が見つからない | `/api/plants/{id}` 系 |
| 409 | `IMAGE_ALREADY_SAVED` | 同じ `imagePath` のレコードが既に存在する | `POST /api/plants/save`<br>`PUT /api/plants/{id}`（自分以外が使っている場合） |
| 409 | `DATABASE_ERROR` | 保存時の競合（Cosmos DBの409） | `POST /api/plants/save` |
| 413 | `FILE_TOO_LARGE` | ファイルサイズ超過 | `POST /api/images/upload` |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | サポートされていないファイル形式 | `POST /api/images/upload` |
| 500 | `INTERNAL_ERROR` | サーバー内部エラー | 全エンドポイント |
| 502 | `AI_SERVICE_ERROR` | AI識別サービスのエラー応答 | `POST /api/plants/identify`<br>`POST /api/images/upload` |
| 502 | `STORAGE_ERROR` | Blob Storageのエラー応答 | `POST /api/images/upload` |
| 503 | `AI_SERVICE_ERROR` | AI識別サービスへ接続できない | `POST /api/plants/identify` |
| 503 | `DATABASE_ERROR` | Cosmos DBへ接続できない | Cosmos DB を使う全エンドポイント |
| 503 | `STORAGE_ERROR` | Blob Storageへ接続できない | `POST /api/images/upload` |

**401 はこの表に載せていない。** Function Key が未指定・無効な場合は
Azure Functions のランタイムが 401 を返し、アプリケーションコードに到達しない。
そのため応答は `{ success, error }` の封筒にならず、`ErrorCode` にも
対応する定義を持たない（以前は `UNAUTHORIZED` / `INVALID_API_KEY` が
定義されていたが、生成箇所が構造的に存在しないため削除した）。

## 7. 未実装の仕様

レート制限とヘルスチェックエンドポイントは未実装です。
この設計書は実装済みの仕様のみを記載する方針のため、
これらは [バックログ](./09_backlog.md) に移しました。
