# SnapPlant API設計書

## 1. 概要

SnapPlant の REST API（Azure Functions + Cosmos DB のサーバーレス API）の共通事項を定義します。
認証・応答の封筒・エラー応答の形と分類・AI 識別サービスへの接続を書き、個々のエンドポイントはここには書きません。

**今あるエンドポイントは、すべて旅行アルバムの API です。** ルート・リクエスト・応答・エラーの文言は
[docs/travel-album/05_api_design.md](./travel-album/05_api_design.md)（実装済みの節に「実装済み」の印がある）、
裏の処理（写真の分類と識別のワーカー・タイマー）は [docs/travel-album/06_processing_design.md](./travel-album/06_processing_design.md) にあります。
旅行アルバムの文書をこの文書と `06_api_openapi.yaml` へ取り込むのは、機能が固まってから後でまとめて行います（2026-10-12 に決定）。

植物図鑑の API（`/api/plants`・`/api/plants/{id}`・`/api/plants/save`・`/api/plants/identify`・`/api/plants/check-duplicate`・
`/api/images/upload`）は、旅行アルバムの図鑑への置き換え（`docs/travel-album/06_processing_design.md` §7 の手順 5。作業単位 4-6）で削除しました。
旧図鑑の植物は新しい図鑑へ移していません。

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
- 例: `GET /api/trips?code={FUNCTION_KEY}`
- POSTリクエストでも同様にクエリパラメータで指定
- キーの管理はクライアント側の設定画面で行う

## 3. エンドポイント設計

### 3.1 Base URL
```
https://func-snaplant-mk0w7s38.azurewebsites.net/api
```

### 3.2 エンドポイント一覧

一覧は [docs/travel-album/05_api_design.md](./travel-album/05_api_design.md) §2 にあります（ルート・メソッド・`data` の中身・登録しているファイル）。
HTTP の関数はすべて `authLevel: 'function'` で、Function Key が要ります。

削除した植物図鑑のルート（§1）には関数が登録されていないので、呼ぶと 404 になります（封筒の無い、Functions のランタイムの応答）。

## 4. データモデル

### 4.1 Error Model
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

500 `INTERNAL_ERROR`・502・503 では、`details` にサーバ内部で発生した
例外のメッセージ（`error.message`）がそのまま入ります。SDK 由来の英語のこともあり
内容は安定しないので、クライアントは表示や分岐に使いません。

**契約の範囲**: HTTP ステータス・`code`・`message` は契約で、エンドポイントの仕様に文言まで記載します。
`message` は Flutter クライアントが画面にそのまま表示するため、変えるときは仕様も変えます。
`details` は契約外で、文言を保証しません。

成功時は `{ "success": true, "data": { ... } }` で、`data` の中身はエンドポイントごとに違います
（`docs/travel-album/05_api_design.md` §2 の表）。

## 5. AI 識別サービスへの接続

旅行アルバムの写真の分類と識別（裏のワーカー。`docs/travel-album/06_processing_design.md` §2・§3）は、同じサービス
（`api/src/services/openAIVisionService.ts`）を通して AI 識別サービス（Azure OpenAI Service の Chat Completions。
選定と、要求の形を縛っている制約の理由は `05_technology_selection.md` §3.5）へ、1回の分類・識別につき1回の要求を送ります。
管理外の依存へ送るものは外部との契約なので、要素をここに書きます。ここに書くのは分類と識別に共通の要素で、
送り先のデプロイの選び方・スキーマ・プロンプトが指示すること・渡す画像は、06 §2.1・§2.2・§3.1 にあります。

**プロンプトの文言は契約外です。** ここにも 06 にも写さず、テストでも完全一致で固定しません。

| 要素 | 内容 |
|---|---|
| 接続先 | `AZURE_OPENAI_ENDPOINT` があれば Azure OpenAI Service。このとき送り先のデプロイ名は必須で、決まらない（空文字列・空白だけを含む）なら要求を送らずに失敗する（表の下）。`baseURL` は `<AZURE_OPENAI_ENDPOINT>/openai/deployments/<デプロイ名>`（デプロイ名は前後の空白を取り除いたもの）、クエリ `api-version` は `AZURE_OPENAI_API_VERSION`（未設定なら `2024-12-01-preview`）、ヘッダ `api-key` は `AZURE_OPENAI_API_KEY`。無ければ OpenAI API（`OPENAI_API_KEY`。`baseURL`・`api-version`・`api-key` ヘッダは付けない） |
| デプロイ名 | サービスを作るときに渡したもの。省略・空・空白だけなら `AZURE_OPENAI_DEPLOYMENT_NAME`（前後の空白を取り除いたもの）。分類は `AZURE_OPENAI_CLASSIFY_DEPLOYMENT_NAME` を渡し、識別は何も渡さない（06 §2.1・§3.1） |
| モデル | デプロイ名。Azure OpenAI Service では `baseURL` のデプロイ名と常に一致する。OpenAI API に直接つなぐとき（`AZURE_OPENAI_ENDPOINT` が無いとき）だけ、デプロイ名が決まらなければ `gpt-5.6-luna` を使う |
| メッセージ | `user` ロールの1件。テキスト（プロンプト）と画像の2パート |
| 画像 | `image_url` パート。`detail: "low"`（トークン節約）。URL は写真の原寸の Blob の読み取り SAS（06 §2.1） |
| 応答の形 | Structured Outputs（`response_format: json_schema`、`strict: true`）。スキーマの名前とスキーマは呼び出し側が渡す（分類は `photo_classification`、識別は `photo_identification`） |
| トークン上限 | `max_completion_tokens: 4000`（`max_tokens` は送らない） |
| 送らないパラメータ | `temperature` |

応答が空・JSON として読めない場合は、AI の失敗として扱います。応答の中身の検証は呼び出し側が行います（06 §2.1・§3.1）。

`AZURE_OPENAI_ENDPOINT` があるのに送り先のデプロイ名が決まらない場合と、AI 識別サービスのクライアントを作れない設定
（API キーが無いなど、SDK がクライアントを作る時点で例外を投げる場合）は、設定の誤りとして AI 識別サービスへ要求を送らずに失敗します。
AI 識別サービスの障害とは扱いません（ワーカーは `lastError: "internal"` として数える。06 §2.1・§5）。
Terraform は `AZURE_OPENAI_DEPLOYMENT_NAME` を必ず設定します（`DEPLOYMENT.md` の「環境変数」）。

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

`code` は `api/src/types/api.ts` の `ErrorCode` の値です。どのエンドポイントがどのステータス・`message` で返すかは
`docs/travel-album/05_api_design.md` の各エンドポイントと §7 にあります。

| `code` | HTTPステータス | 説明 |
|-------------|---------------|------|
| `INVALID_REQUEST` | 400 | リクエスト形式が不正 |
| `TRIP_NOT_FOUND` | 404 | 旅行が見つからない |
| `PHOTO_NOT_FOUND` | 404 | 写真が見つからない |
| `FILE_TOO_LARGE` | 413 | ファイルサイズが上限を超えた（0 バイトは 400 `INVALID_REQUEST`） |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | サポートされていないファイル形式 |
| `INTERNAL_ERROR` | 500 | サーバー内部エラー。`message` はエンドポイントごとに固定（失敗の原因によって変わらない。原因は `details` に入るが、4.1 のとおり内容は安定しない） |
| `STORAGE_ERROR` | 502 / 503 | Blob Storage の操作の失敗（下の「502 / 503 の振り分け」） |
| `DATABASE_ERROR` | 503 | Cosmos DB へ接続できない（`データベースに接続できません`） |
| `AI_SERVICE_ERROR` | 502 / 503 | AI 識別サービスの呼び出しの失敗。今は返すエンドポイントが無い（AI を呼ぶのは裏のワーカーだけで、ワーカーは応答を返さない） |

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

#### 502 / 503 の振り分けと `message`

上流（Blob Storage・AI 識別サービス）の呼び出しの失敗は、**失敗した場所**でコードを決め、
**接続できたかどうか**で 502 と 503 を分けます（`api/src/utils/response.ts` の `createUpstreamErrorResponse()`）。
エラーメッセージの文言は判定に使いません。

| 失敗した場所 | 原因 | ステータス・コード | `message` |
|-------------|------|-------------------|-----------|
| Blob Storage の操作 | 接続できない（`ENOTFOUND` / `ECONNREFUSED` / `ETIMEDOUT`） | 503 `STORAGE_ERROR` | `ストレージサービスに接続できません` |
| Blob Storage の操作 | 上記以外（接続できたうえでの失敗） | 502 `STORAGE_ERROR` | `ストレージサービスでエラーが発生しました` |
| AI 識別の呼び出し | 接続できない（`ENOTFOUND` / `ECONNREFUSED`） | 503 `AI_SERVICE_ERROR` | `AIサービスに接続できません` |
| AI 識別の呼び出し | 上記以外 | 502 `AI_SERVICE_ERROR` | `AIサービスでエラーが発生しました` |

AI 識別の行は、今は返すエンドポイントがありません（6.2 の表）。`UpstreamError` の種類ごとに持つ表なので、コードに残っています。

- **接続できない**の判定は、SDK が包んだエラーの奥にある原因までたどって行います
  （OpenAI SDK の接続エラーは errno を直接持たず、2段奥の原因に持つため）。
  たどるのは10段までで、原因が循環していても止まります（見つからなければ接続できない以外の失敗として扱う）
- `ETIMEDOUT` を 503 にするのは Blob Storage の操作だけです（Cosmos DB の `ETIMEDOUT` は 500 `INTERNAL_ERROR`。
  [バックログ](./09_backlog.md)の「`ETIMEDOUT` を 503 に分類するのは Blob Storage の操作だけ」）
- Cosmos DB へ接続できない場合（`ENOTFOUND` / `ECONNREFUSED`。同じく原因までたどる）は 503 `DATABASE_ERROR` です
  （`createDatabaseErrorResponse()`。`docs/travel-album/05_api_design.md` §1）

## 7. 未実装の仕様

レート制限とヘルスチェックエンドポイントは未実装です。
この設計書は実装済みの仕様のみを記載する方針のため、
これらは [バックログ](./09_backlog.md) に移しました。

## 8. デプロイ後に手で確かめること

Cosmos DB の SQL（絞り込み・並び順・射影）を検証しているテストはありません。
ユニットテストの偽物は SQL 文字列を解釈しないため原理的に検証できず、エミュレータも E2E も導入していません
（環境が1つしかないため。[バックログ](./09_backlog.md)）。偽物は渡したドキュメントをそのまま返すので、
射影の崩れは実際の Cosmos DB でしか観測できません。

クエリを変更したらデプロイ後に手で確かめる項目は、`docs/travel-album/08_test_plan.md` §5.2・§5.3 にあります
（植物図鑑の `cosmosService.ts` のクエリの項目は、API と一緒に 4-6 で削除しました）。
