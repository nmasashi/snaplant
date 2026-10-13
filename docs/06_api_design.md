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
      "scientificName": "string（省略されることがある）",
      "familyName": "string（省略されることがある）",
      "description": "string（省略されることがある）",
      "characteristics": "string",
      "confidence": "number (0-100)"
    }
  ]
}
```
`isPlant: false` の場合、`candidates` は空配列になります。
植物と判定した場合でも、AI の応答の `plantAnalysis` が `null`、または `plantAnalysis.candidates` が
`null`・未指定なら、`candidates` は空配列で返ります（エラーにはなりません）。

`confidence`（植物判定の信頼度）と `reason`（判定理由）は常に含まれます。
`confidence` は植物判定・各候補とも 0〜100（両端を含む）で、AI の応答がこの範囲外か数値でない場合は
結果を返さず 502 `AI_SERVICE_ERROR` になります（6.2 の「502 / 503 の振り分けと `message`」参照）。
候補の `scientificName` / `familyName` / `description` は、AI が特定できなかった場合
`null` ではなく**キーごと省略**されます（AI の応答に含まれる `null` をサーバ側で
`undefined` に置き換えているため、JSON にキーが現れません）。

`POST /api/images/upload` の `identificationResult` は `isPlant` / `confidence` / `candidates` の
3項目だけで、`reason` は含まれません（5.8 参照）。

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

409 `DATABASE_ERROR`・500 `INTERNAL_ERROR`・502・503 では、`details` にサーバ内部で発生した
例外のメッセージ（`error.message`）がそのまま入ります。SDK 由来の英語のこともあり
内容は安定しないので、クライアントは表示や分岐に使いません。

**契約の範囲**: HTTP ステータス・`code`・`message` は契約で、この文書と OpenAPI に文言まで記載します。
`message` は Flutter クライアントが画面にそのまま表示するため、変えるときはこの文書も変えます。
`details` は契約外で、文言を保証しません。

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
植物 ID の形式は `06_api_openapi.yaml` の `id` パラメータの説明のとおりです（UUID 形式。3つ目のグループ先頭の
バージョン桁は `1`〜`5`、4つ目のグループ先頭のバリアント桁は `8` / `9` / `a` / `b`、大文字小文字は区別しない）。
合わなければ 400 `INVALID_REQUEST`（`植物IDの形式が無効です`）で、GET / PUT / DELETE で同じ検査・同じ文言です。
形式に合う ID で該当する植物が無ければ 404 `PLANT_NOT_FOUND`（`指定された植物が見つかりません`）で、
これも GET / PUT / DELETE で同じ文言です。

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
指定されたURLはそのままAI識別サービスへ渡されます（渡すものの全体は 5.9）。

- `imagePath` が未指定（`null`・空文字を含む）→ 400 `INVALID_REQUEST`（`画像URLが指定されていません`、`details` なし）
- `imagePath` がURLとしてパースできない → 400 `INVALID_REQUEST`
  （`画像URLの形式が無効です`、`details` は `有効なURL形式で指定してください`）

検証は `imagePath`（上の2つ）→ `contextInfo`（下の2つ）の順に行い、最初に失敗した1件だけを返します。
いずれもAI呼び出しの前に弾かれます。

`contextInfo` は文字列で、500文字以内です。
- 文字列以外（数値・配列・オブジェクトなど）→ 400 `INVALID_REQUEST`（`補足情報は文字列で指定してください`）
- 500文字超過 → 400 `INVALID_REQUEST`（`補足情報は500文字以内で指定してください`）

`null` と未指定は「補足情報なし」として扱います。
上限値は環境変数 `CONTEXT_INFO_MAX_LENGTH` で変更できます
（正の整数として読めない値を設定した場合は既定の 500 が使われます）。

入力検証を通った後の失敗は、AI識別の呼び出しで起きたものが 502 / 503 `AI_SERVICE_ERROR`、
それ以外が 500 `INTERNAL_ERROR` です（6.2 の「502 / 503 の振り分けと `message`」参照）。

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
      "confidence": 95.5,
      "reason": "画像に桜の花が写っており、植物と判定しました",
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

#### 入力検証（400）

検証は下の表の上から順に行い、最初に失敗した1件だけを返します。
いずれも 400 `INVALID_REQUEST` で、Cosmos DB へのアクセス（409 の重複チェックを含む）より前に弾かれます。

| 順 | 条件 | `message` | `details` |
|----|------|-----------|-----------|
| 1 | ボディが JSON としてパースできない | `リクエストボディの形式が無効です` | `JSON形式で送信してください` |
| 2 | ボディが `null` | `リクエストボディが指定されていません` | なし |
| 3 | `name` が文字列でない | `植物名は文字列で指定してください` | なし |
| 4 | `characteristics` が文字列でない | `特徴は文字列で指定してください` | なし |
| 5 | `imagePath` が文字列でない | `画像パスは文字列で指定してください` | なし |
| 6 | `scientificName` が文字列でない | `学名は文字列で指定してください` | なし |
| 7 | `familyName` が文字列でない | `科名は文字列で指定してください` | なし |
| 8 | `description` が文字列でない | `説明は文字列で指定してください` | なし |
| 9 | `name` が未指定・`null`・空文字・空白のみ | `植物名が指定されていません` | なし |
| 10 | `characteristics` が未指定・`null`・空文字・空白のみ | `特徴が指定されていません` | なし |
| 11 | `imagePath` が未指定・`null`・空文字・空白のみ | `画像パスが指定されていません` | なし |
| 12 | `confidence` が数値でない（未指定を含む）、または 0 未満・100 超（0 と 100 は可） | `信頼度は0から100の間の数値で指定してください` | なし |
| 13 | `name` が100文字を超える | `植物名は100文字以内で指定してください` | なし |
| 14 | `scientificName` が150文字を超える | `学名は150文字以内で指定してください` | なし |
| 15 | `familyName` が100文字を超える | `科名は100文字以内で指定してください` | なし |
| 16 | `description` が1000文字を超える | `説明は1000文字以内で指定してください` | なし |
| 17 | `characteristics` が500文字を超える | `特徴は500文字以内で指定してください` | なし |
| 18 | `imagePath` が上記の形の条件を満たさない | `画像アップロードAPIが返したURLを指定してください` | なし |

3〜8行目の「文字列でない」は、数値・真偽値・配列・オブジェクトなど `null` 以外の文字列でない値です。
型の検査は他のどの項目の検査よりも先に、上の順で行います。
`null` と未指定はここでは弾かず、必須項目（`name` / `characteristics` / `imagePath`）は
9〜11行目の「指定されていません」になり、任意項目（`scientificName` / `familyName` / `description`）は
「指定なし」として受け付けます（Flutter クライアントは空の任意項目を `null` で送ります）。

文字数は前後の空白を取り除かずに数えます。ただし `name` は、保存する値（前後の空白を取り除いた後）の長さで判定します。
上限は環境変数 `PLANT_NAME_MAX_LENGTH` / `PLANT_SCIENTIFIC_NAME_MAX_LENGTH` /
`PLANT_FAMILY_NAME_MAX_LENGTH` / `PLANT_DESCRIPTION_MAX_LENGTH` / `PLANT_CHARACTERISTICS_MAX_LENGTH`
で変更でき、`message` の数値も追従します
（正の整数として読めない値を設定した場合は表の既定値が使われます）。

#### 保存される値

`name` は前後の空白を取り除いてから保存します。`GET /api/plants/check-duplicate`（5.6）が
前後の空白を取り除いて比較するので、それと揃えています。応答の `plant.name` も取り除いた後の値です。
`name` 以外の項目は送られた値をそのまま保存します（任意項目に `null` を送った場合は `null` のまま保存されます）。
保存するのは上の表の7項目だけで、ボディにそれ以外のキー（`id` や `createdAt` など）があっても無視します。

`id`・`createdAt`・`updatedAt` はサーバが付けます。`id` は保存のたびに新しく採番する UUID（小文字の v4 形式）で、
2回保存すればそれぞれ別の `id` になります（ただし同じ `imagePath` の2回目は保存されず 409。下記）。
`createdAt` と `updatedAt` は同じ値です。

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

応答に既存レコードの `id` は含めません。クライアント（Flutter アプリ）は 409 `IMAGE_ALREADY_SAVED` を
受けたら「既に保存済み」と解釈し、`message` をそのまま表示して一覧画面へ戻り、
`GET /api/plants` で一覧を取り直します（該当レコードを探す処理はしません）。

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

`imagePath` の重複も 5.4 と同様に検査します。同じ `imagePath` のレコードがあり、
**そのどれも更新対象自身ではない**場合は更新せず、
409 `IMAGE_ALREADY_SAVED`（`この画像は既に保存されています`、`details` なし）を返します。
更新対象自身が既にその画像を持っていれば通すので、`imagePath` を変えずに
他のフィールドだけ更新しても 409 にはなりません。他に同じ画像のレコードが既に
残っている場合も通します（既存の重複を理由に自分の更新を拒むと、その更新が永久にできなくなるため）。
save 側だけ塞いでも PUT から同じ状態を作れるため、入口を揃えています。
なお Cosmos DB 側が返す 409 はこのエンドポイントでは変換していないため 500 になります
（5.4 の新規登録だけが 409 `DATABASE_ERROR` に変換します）。

#### 入力検証（400）

検証は下の表の上から順に行い、最初に失敗した1件だけを返します。
植物IDの検証はボディの読み取りより前に行うため、IDが不正ならボディが壊れていてもIDのエラーになります。
いずれも 400 `INVALID_REQUEST` で、Cosmos DB へのアクセス（409 の重複チェックを含む）より前に弾かれます。

| 順 | 条件 | `message` | `details` |
|----|------|-----------|-----------|
| 1 | 植物IDの形式が無効（GET / DELETE と同じ検査・同じ文言） | `植物IDの形式が無効です` | `UUID形式で指定してください` |
| 2 | ボディが JSON としてパースできない | `リクエストボディの形式が無効です` | `JSON形式で送信してください` |
| 3 | ボディが `null` | `リクエストボディが指定されていません` | なし |
| 4 | `imagePath` が文字列でない（数値・真偽値・配列・オブジェクトなど。`null` は5行目） | `画像パスは文字列で指定してください` | なし |
| 5 | `imagePath` が未指定・`null`・空文字・空白のみ | `画像パスが指定されていません` | なし |
| 6 | `confidence` が数値でない（未指定を含む）、または 0 未満・100 超（0 と 100 は可） | `信頼度は0から100の間の数値で指定してください` | なし |
| 7 | `imagePath` が上記の形の条件を満たさない | `画像アップロードAPIが返したURLを指定してください` | なし |

`imagePath` の型の検査は、ボディの項目の検査のうち最初に行います。

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
1. `imagePath` の重複確認（同じ画像のレコードがあり、そのどれも自分でなければ 409 で中断）
2. 既存ドキュメント取得（旧imagePathを保存。見つからなければ 404）
3. ドキュメント更新（新しいimagePath・confidence）
4. 旧画像ファイル削除（`imagePath` が変わった場合のみ。ストレージコスト最適化）
5. レスポンス返却

旧画像の削除に失敗してもエラーにはならず、ログ出力のみで 200 を返します。
削除するのは、旧 `imagePath` が自ストレージアカウントの Blob エンドポイントを指し、パスの最初のセグメントが
永続コンテナ名か一時コンテナ名と完全一致する場合だけです。それ以外（別のホスト、未知のコンテナ、Blob 名を
取り出せない形）は何も削除せず、エラーにもしません。Blob が既に無い場合も成功扱いです。
消す Blob の名前は、URL のパスのうちコンテナ名より後ろの全体です（`/<永続コンテナ名>/x/a.jpg` なら `x/a.jpg`。
最後のセグメントの `a.jpg` ではないので、同じコンテナの `a.jpg` は消えません）。
コンテナ名の判定はパスの最初のセグメントで行い、ストレージアカウント名（ホスト）にコンテナ名と同じ文字列が
含まれていても影響しません。
保存時の検証で弾かれるので通常はここに来ませんが、他のレコードの画像を消さないための最後の関門として、
入口の検証とは独立に検査しています。

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
ボディにそれ以外の項目（`name` や `createdAt` など）が含まれていてもエラーにはせず、無視します
（送っても既存の値は変わりません）。

### 5.6 重複確認
同名の植物が既に登録されているかチェックします。
`name` は前後の空白を取り除いてから、保存済みの `name` と完全一致で比較します。
未指定・空文字・空白のみの場合は 400 `INVALID_REQUEST`
（`植物名が指定されていません`、`details` は `nameクエリパラメータは必須です`）を返します。

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
削除する条件は 5.5 の旧画像と同じです（自ストレージアカウントの永続コンテナか一時コンテナを指す
`imagePath` だけを削除し、それ以外は何も削除せずエラーにもしません。Blob が既に無い場合も成功扱い）。

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
AI 識別サービスへ渡すものは 5.9 にまとめています。
`contextInfo` はテキストフィールドで送る500文字以内の文字列です。

#### 入力検証（400 / 413 / 415）

検証は下の表の上から順に行い、最初に失敗した1件だけを返します。
いずれも一時保存とAI呼び出しの前に弾かれます。

| 順 | 条件 | ステータス・コード | `message` | `details` |
|----|------|-------------------|-----------|-----------|
| 1 | リクエストの Content-Type が `multipart/form-data` で始まらない（未指定を含む） | 400 `INVALID_REQUEST` | `Content-Typeがmultipart/form-dataではありません` | `multipart/form-dataでファイルを送信してください` |
| 2 | `image` が未指定、またはファイルではなくテキストフィールドで送られた | 400 `INVALID_REQUEST` | `画像ファイルが指定されていません` | `imageフィールドでファイルを送信してください` |
| 3 | `image` の Content-Type が `image/jpeg` / `image/jpg` / `image/png` / `image/webp` / `image/gif` のいずれでもない（大文字小文字は区別しない） | 415 `UNSUPPORTED_MEDIA_TYPE` | `サポートされていない画像形式です` | `JPEG、PNG、WebP、GIFファイルのみアップロード可能です` |
| 4 | `image` のサイズが 0 バイト | 400 `INVALID_REQUEST` | `画像ファイルが空です` | なし |
| 5 | `image` のサイズが上限（既定 10MB = 10485760 バイト）を超える | 413 `FILE_TOO_LARGE` | `ファイルサイズが大きすぎます` | `ファイルサイズは10MB以下にしてください` |
| 6 | `contextInfo` が文字列でない（ファイルとして送られた場合など） | 400 `INVALID_REQUEST` | `補足情報は文字列で指定してください` | なし |
| 7 | `contextInfo` が500文字を超える | 400 `INVALID_REQUEST` | `補足情報は500文字以内で指定してください` | なし |

415 は `image` の画像形式が合わない場合専用です。リクエスト自体の Content-Type が
`multipart/form-data` でない場合は 415 ではなく 400（1行目）になります。
413 は上限を超えた場合専用です。0 バイトのファイルは 413 ではなく 400（4行目）になります。
空のファイルでも形式の検査（3行目）が先なので、形式が合わなければ 415 になります。
サイズの上限は環境変数 `MAX_FILE_SIZE`（バイト）で変更でき、`details` の数値も追従します
（MB 単位に切り捨て。正の整数として読めない値を設定した場合は既定値が使われます）。
`contextInfo` の上限値は 5.3 と同じく `CONTEXT_INFO_MAX_LENGTH` で変わります。

#### 入力検証の後の失敗（500 / 502 / 503）

一時保存以降の失敗は、失敗した場所でコードが決まります（条件は 6.2 の「502 / 503 の振り分けと `message`」）。

- AI識別の呼び出し → 502 / 503 `AI_SERVICE_ERROR`。AI識別サービスへ接続できない障害も
  `AI_SERVICE_ERROR` で、`STORAGE_ERROR` にはなりません
- Blob Storage の操作（一時保存・SAS URL の生成・永続コンテナへの移動・植物でない画像の一時ファイルの削除）
  → 502 / 503 `STORAGE_ERROR`。植物でない画像の一時ファイルの削除に失敗した場合は、
  400 `NOT_A_PLANT` ではなく `STORAGE_ERROR` になります
- それ以外 → 500 `INTERNAL_ERROR`（`画像アップロード・植物判定に失敗しました`）。
  ストレージの接続文字列が未対応の形（`BlobEndpoint=` を含む、`EndpointSuffix` が無い。`DEPLOYMENT.md` の
  「`STORAGE_CONNECTION_STRING` の制約」）の場合もこれで、何も保存せず AI識別サービスも呼びません

AI識別の呼び出しが失敗した場合、一時保存した画像は削除されずに一時コンテナに残ります
（[バックログ](./09_backlog.md)の「`upload` で AI の呼び出しが例外で失敗すると、一時保存した Blob が残る」）。
一時保存の SAS URL の生成に失敗した場合は、一時保存した画像を削除してから 502 `STORAGE_ERROR` を返します
（この削除にも失敗した場合は一時コンテナに残ります）。
永続コンテナへの移動が、一時ファイルの読み出し（途中で読めなくなった場合を含む）か永続コンテナへの書き込みで
失敗した場合、永続コンテナには何も残りません（一時ファイルは残ります。`07_api_workflow.md` §2.3）。

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
UUID はアップロードのたびに新しく作るので、同じ画像を2回アップロードしても別々の `imagePath` に保存されます
（既存の画像を上書きしません）。

`identificationResult` は `isPlant` / `confidence` / `candidates` の3項目だけで、
`POST /api/plants/identify` の結果（4.2）にある `reason` は含まれません。

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

### 5.9 AI 識別サービスへ渡すもの
`POST /api/plants/identify`（5.3）と `POST /api/images/upload`（5.8）は、同じサービス
（`api/src/services/openAIVisionService.ts`）を通して AI 識別サービス（Azure OpenAI Service の
Chat Completions。選定と、要求の形を縛っている制約の理由は `05_technology_selection.md` §3.5）へ、
1リクエストにつき1回の要求を送ります。管理外の依存へ送るものは外部との契約なので、要素をここに書きます。
テストで固定するのも、この表の要素までです。

**プロンプトの文言は契約外です。** ここには写さず、テストでも完全一致で固定しません
（写すと、プロンプトを調整するたびに仕様書がプロンプトのコピーになります）。
契約にするのは、表の「プロンプトが指示すること」の要素までです。

| 要素 | 内容 |
|---|---|
| 接続先 | `AZURE_OPENAI_ENDPOINT` があれば Azure OpenAI Service。`baseURL` は `<AZURE_OPENAI_ENDPOINT>/openai/deployments/<AZURE_OPENAI_DEPLOYMENT_NAME>`、クエリ `api-version` は `AZURE_OPENAI_API_VERSION`（未設定なら `2024-12-01-preview`）、ヘッダ `api-key` は `AZURE_OPENAI_API_KEY`。無ければ OpenAI API（`OPENAI_API_KEY`。`baseURL`・`api-version`・`api-key` ヘッダは付けない） |
| モデル | `AZURE_OPENAI_DEPLOYMENT_NAME`（未設定なら `gpt-5.6-luna`）。ただし Azure OpenAI Service でデプロイ名が未設定のときは、`baseURL` のデプロイ名の部分が `undefined` になり、モデルの既定値と食い違う（[バックログ](./09_backlog.md)の「AI 識別サービスの要求で、デプロイ名が未設定のときに接続先とモデルが食い違う」。Terraform は必ず設定する） |
| メッセージ | `user` ロールの1件。テキスト（プロンプト）と画像の2パート |
| 画像 | `image_url` パート。URL は、5.3 では `imagePath` そのもの、5.8 では一時コンテナの SAS 付き URL。5.8 の SAS は、一時コンテナのその Blob 1つだけを対象にした読み取り専用で、発行から15分で切れ、開始時刻を付けない（発行した時点から有効。値の根拠は `07_api_workflow.md` §2.3）。`detail: "low"`（トークン節約） |
| コンテキスト情報 | `contextInfo` があるときだけ、プロンプトのテキストに含める。未指定・`null` のときは含めない |
| プロンプトが指示すること | 植物かどうかの判定基準、`name` の命名の優先順位（品種名 → 種名 → 属名）、候補は最大3件を信頼度の高い順に並べること、学名と科名を含めること |
| 応答の形 | Structured Outputs（`response_format: json_schema`、名前 `plant_identification`、`strict: true`）。`isPlant`（boolean）・`confidence`（number）・`reason`（string）・`plantAnalysis`（object または null。`candidates[]` の各要素は `name`・`scientificName`・`familyName`・`description`・`characteristics`・`confidence`）。全プロパティが必須で `additionalProperties: false`、任意項目は null 許容 |
| トークン上限 | `max_completion_tokens: 4000`（`max_tokens` は送らない） |
| 送らないパラメータ | `temperature` |

応答の検証（`confidence` の範囲（0 と 100 は可）、候補の必須項目、空・JSON として読めない応答）で弾かれた場合の扱いは
6.2 の「502 / 503 の振り分けと `message`」に、応答の null 項目の省略と植物でない場合の `candidates` は 4.2 にあります。

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
| 409 | `IMAGE_ALREADY_SAVED` | 同じ `imagePath` のレコードが既に存在する | `POST /api/plants/save`<br>`PUT /api/plants/{id}`（該当がいずれも更新対象自身でない場合） |
| 409 | `DATABASE_ERROR` | 保存時の競合（Cosmos DBの409） | `POST /api/plants/save` |
| 413 | `FILE_TOO_LARGE` | ファイルサイズが上限を超えた（0 バイトは 400 `INVALID_REQUEST`） | `POST /api/images/upload` |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | サポートされていないファイル形式 | `POST /api/images/upload` |
| 500 | `INTERNAL_ERROR` | サーバー内部エラー | 全エンドポイント |
| 502 | `AI_SERVICE_ERROR` | AI識別の呼び出しの失敗（エラー応答・不正な応答など。接続できない場合を除く） | `POST /api/plants/identify`<br>`POST /api/images/upload` |
| 502 | `STORAGE_ERROR` | Blob Storageの操作の失敗（接続できない場合を除く） | `POST /api/images/upload` |
| 503 | `AI_SERVICE_ERROR` | AI識別サービスへ接続できない | `POST /api/plants/identify`<br>`POST /api/images/upload` |
| 503 | `DATABASE_ERROR` | Cosmos DBへ接続できない | Cosmos DB を使う全エンドポイント |
| 503 | `STORAGE_ERROR` | Blob Storageへ接続できない | `POST /api/images/upload` |

**401 はこの表に載せていない。** Function Key が未指定・無効な場合は
Azure Functions のランタイムが 401 を返し、アプリケーションコードに到達しない。
そのため応答は `{ success, error }` の封筒にならず、`ErrorCode` にも
対応する定義を持たない（以前は `UNAUTHORIZED` / `INVALID_API_KEY` が
定義されていたが、生成箇所が構造的に存在しないため削除した）。

**429 もこの表に載せていません。** 過負荷時に Azure Functions のランタイムが 429（"Too Busy"）を
返すことがあり、これも 401 と同じくアプリケーションコードに到達せず、封筒なしの応答になります。
従量課金プランでは host.json の `extensions.http.dynamicThrottlesEnabled`（既定 `true`）と
`extensions.http.maxOutstandingRequests`（既定 200）によってこの拒否が有効になっており、
`api/host.json` はどちらも変更していません。
アプリケーションのレート制限（7 章、未実装）とは別物です。

#### 500 `INTERNAL_ERROR` の `message`

500 `INTERNAL_ERROR` の `message` はエンドポイントごとに固定で、失敗の原因によって変わりません
（原因は `details` に入りますが、4.3 のとおり内容は安定しません）。

| エンドポイント | `message` |
|---------------|-----------|
| `GET /api/plants` | `植物一覧の取得に失敗しました` |
| `GET /api/plants/{id}` | `植物詳細の取得に失敗しました` |
| `POST /api/plants/save` | `植物の保存に失敗しました` |
| `PUT /api/plants/{id}` | `植物の更新に失敗しました` |
| `DELETE /api/plants/{id}` | `植物の削除に失敗しました` |
| `POST /api/plants/identify` | `植物識別処理に失敗しました` |
| `POST /api/images/upload` | `画像アップロード・植物判定に失敗しました` |
| `GET /api/plants/check-duplicate` | `重複チェックに失敗しました` |

#### 502 / 503 の振り分けと `message`

`POST /api/plants/identify` と `POST /api/images/upload` は、**失敗した場所**でコードを決め、
**接続できたかどうか**で 502 と 503 を分けます。エラーメッセージの文言は判定に使いません。

| 失敗した場所 | 原因 | ステータス・コード | `message` |
|-------------|------|-------------------|-----------|
| AI識別の呼び出し | 接続できない（`ENOTFOUND` / `ECONNREFUSED`） | 503 `AI_SERVICE_ERROR` | `植物識別サービスに接続できません` |
| AI識別の呼び出し | 上記以外 | 502 `AI_SERVICE_ERROR` | `植物識別サービスでエラーが発生しました` |
| Blob Storage の操作（`upload` のみ） | 接続できない（`ENOTFOUND` / `ECONNREFUSED` / `ETIMEDOUT`） | 503 `STORAGE_ERROR` | `ストレージサービスに接続できません` |
| Blob Storage の操作（`upload` のみ） | 上記以外（接続できたうえでの失敗） | 502 `STORAGE_ERROR` | `ストレージサービスでエラーが発生しました` |
| 上記以外の箇所 | — | 500 `INTERNAL_ERROR` | 「500 `INTERNAL_ERROR` の `message`」のとおり |

- **AI識別の呼び出し**は、リクエストの送信から応答の検証までを指します。502 になるのは、
  AI識別サービスのエラー応答（認証エラー・利用上限・サーバエラーなど）、応答の `choices` や本文が空、
  JSON として読めない、応答が想定の形を満たさない（`isPlant` が真偽値でない、`reason` が文字列でない、
  `confidence` が数値でないか 0〜100 の範囲外、`plantAnalysis.candidates` が `null`・未指定以外の配列でない値
  （`isPlant` にかかわらず。`null`・未指定は候補なしとして扱う。4.2）、
  候補の `name` / `characteristics` が無い（空文字列を含む）、候補の `confidence` が数値でないか 0〜100 の範囲外）、
  および原因が `ENOTFOUND` / `ECONNREFUSED` でない接続の失敗です
- **接続できない**の判定は、SDK が包んだエラーの奥にある原因までたどって行います
  （OpenAI SDK の接続エラーは errno を直接持たず、2段奥の原因に持つため）。
  たどるのは10段までで、原因が循環していても止まります（見つからなければ接続できない以外の失敗として扱う）
- `ETIMEDOUT` を 503 にするのは Blob Storage の操作だけです。AI識別の呼び出しでは 502
  `AI_SERVICE_ERROR` になります（Cosmos DB を使うエンドポイントでは 500 `INTERNAL_ERROR`）
- `upload` の **Blob Storage の操作**は、一時保存（SAS URL の生成を含む）・永続コンテナへの移動・
  植物でない画像の一時ファイルの削除です
- `upload` で AI識別サービスへ接続できない障害は 503 `AI_SERVICE_ERROR` になり、`STORAGE_ERROR` にはなりません

## 7. 未実装の仕様

レート制限とヘルスチェックエンドポイントは未実装です。
この設計書は実装済みの仕様のみを記載する方針のため、
これらは [バックログ](./09_backlog.md) に移しました。
