# 旅行アルバム 裏の処理の設計

## この文書の位置づけ

送信を待たせずに裏で行う処理（分類・識別・地名の埋め直し）の設計を書く。段階3・4が中心で、
段階2に関係するのは地名変換（§4 の端末側）だけ。**未実装を含む目指す姿**で、骨格の粒度。
実装したときに `docs/07_api_workflow.md`（ワークフロー）・`docs/06_api_design.md` へ取り込む。

データの項目は [04_data_design.md](./04_data_design.md)、やり直しの API は [05 §5.7](./05_api_design.md#57-post-apiphotosphotoidprocess段階3)、
インフラは [07_infrastructure_design.md](./07_infrastructure_design.md) を参照する。
キューの名前・再試行の回数・タイマーの間隔・モデルの環境変数名は第3版に無く、この文書で決めた。

---

## 1. キューとワーカー（段階3）

### 1.1 構成

| 項目 | 値 | 理由 |
|---|---|---|
| キュー | Azure Storage Queue `photo-processing`（既存のストレージアカウント。`AzureWebJobsStorage` と同じ） | 追加のリソースが要らず、Functions のトリガーが標準で使える。Service Bus は過剰 |
| メッセージ | `{ "photoId": "<id>", "step": "classify" \| "identify", "hint": string \| null }`（JSON） | ワーカーは写真を読み直すので、メッセージには最小限だけ |
| 投入 | HTTP 関数から `@azure/storage-queue` の `QueueClient.sendMessage()`（**`dependencies` に置く**） | 投入の失敗を握って応答を変えない、という制御をコードで書ける（出力バインディングは関数の戻り値で送るので、失敗時の扱いを制御しにくい）。`devDependencies` だと本番で読み込めない（CLAUDE.md「CI/CD」） |
| ワーカー | `api/src/functions/processPhoto.ts`。`app.storageQueue('processPhoto', { queueName, connection: 'AzureWebJobsStorage', handler })` | HTTP 関数と同じ Function App に同居 |
| 直列化 | `host.json` の `extensions.queues` で `batchSize: 1`・`newBatchThreshold: 0` | AI のレート上限（TPM）と費用を抑える。1回の旅行で数百枚を一気に投入しても、順に流れる |
| 可視性タイムアウト・再試行 | `visibilityTimeout: 00:01:00`、`maxDequeueCount: 3`。3回失敗すると `photo-processing-poison` に落ちる | 一時的な失敗（429・503）は自動で再試行され、恒久的な失敗は止まる |
| 再投入のタイマー | `api/src/functions/requeueStalePhotos.ts`。`app.timer`、10 分ごと。`processing.state` が `pending` / `classifying` / `identifying` のまま 10 分以上更新されていない写真を再投入 | poison に落ちたもの、投入前にプロセスが落ちたものを拾う。`attempts` が上限なら `failed` にする |

キュー名は環境変数 `PHOTO_QUEUE_NAME`（既定 `photo-processing`）。Terraform で作る（[07 §2](./07_infrastructure_design.md#2-段階3)）。

### 1.2 流れ

```mermaid
sequenceDiagram
    participant C as クライアント
    participant H as HTTP 関数<br/>POST /api/photos
    participant Q as Storage Queue
    participant W as ワーカー
    participant DB as Cosmos album
    participant B as Blob photos
    participant AI as Azure OpenAI

    C->>H: 写真を送る
    H->>B: 原寸・サムネイル
    H->>DB: create（processing.state = pending）
    H->>Q: { photoId, step: classify }
    H-->>C: 201

    Q->>W: メッセージ
    W->>DB: 写真を読む。state = classifying
    W->>B: 原寸の読み取り SAS を発行
    W->>AI: 分類（安価なモデル・detail low）
    AI-->>W: { kind, confidence, reason }
    W->>DB: tags に category:<kind>、classification、state = done
    alt kind が CATALOG_KINDS にある（段階4）
        W->>Q: { photoId, step: identify }
        Q->>W: メッセージ
        W->>DB: state = identifying
        W->>AI: 識別（定義表のスキーマ・手がかり付き）
        W->>DB: entry を作る／併合、写真に identification・entryId・comment
        W->>DB: state = done
    end
```

- 段階2の `POST /api/photos` は `processing.state: "none"` で保存し、キューには投入しない。段階3で `pending` + 投入に変える
- 段階3で、段階2に送った既存の写真（`state: "none"`）を分類するには、`POST /api/photos/{photoId}/process` を1枚ずつ呼ぶか、
  一度だけ走らせる手動のスクリプト（`api/scripts/enqueueUnclassified.ts`）で投入する。タイマーには `none` を拾わせない（意図せず全件に課金しないため）
- `step: "classify"` のやり直しは、結果の種類が識別対象なら続けて `identify` も投入する（要件 5.5.1「カテゴリの分類も、図鑑の項目の識別も対象」）

### 1.3 状態と失敗

`processing` の遷移。

| 状態 | 意味 | 次 |
|---|---|---|
| `none` | 裏の処理の対象になっていない（段階2の写真） | `process` で `pending` |
| `pending` | キューに入っている（または入れようとした） | ワーカーが取ると `classifying` / `identifying` |
| `classifying` / `identifying` | 処理中 | 成功で `done`、失敗で `pending`（再試行）か `failed` |
| `done` | 済み | `process` で `pending` |
| `failed` | 上限まで失敗した | `process` で `pending`（`attempts` を 0 に戻す） |

- ワーカーは取り出すたびに `attempts` を +1 し、`updatedAt` を更新する。失敗したら `lastError` に `{ service, status }` 程度を書く（例外のメッセージは入れない。SDK 由来の文言が残り続けるため）
- `attempts >= 3`（`PHOTO_PROCESSING_MAX_ATTEMPTS`、環境変数）で `failed`。それ未満は例外を投げてキューの再試行に任せる
- AI の 429 は `UpstreamError('ai')` のまま投げ、キューの再試行（可視性タイムアウト後）で吸収する
- ワーカーの 1 回の処理は `functionTimeout`（5 分）に収める。AI の呼び出しは 1 枚 1 回なので十分
- 画面は `state` を見て「分類中...」「分類に失敗しました」「やり直す」を出す（[03 §5.1](./03_screen_design.md#51-写真ビューアへの追加)）

## 2. 分類（段階3）

### 2.1 モデルとサービス

| 項目 | 値 |
|---|---|
| デプロイ | `AZURE_OPENAI_CLASSIFY_DEPLOYMENT_NAME`（Terraform の `azurerm_cognitive_deployment.classifier` の名前と一致させる）。モデルは安価なもの（**人間が価格表を見て決める**。要確認） |
| 画像 | 原寸の Blob の読み取り SAS（15 分。既存の `TEMP_SAS_EXPIRY_MINUTES` と同じ理由）を `image_url` に、`detail: "low"` |
| サービス | `api/src/services/photoClassifierService.ts`。`OpenAIVisionService` を一般化した `analyze({ deployment, schema, prompt, imageUrl, detail })` を呼ぶ |
| 失敗 | `UpstreamError('ai')`。応答の検証違反も同じ（既存の `identifyPlant()` と同じ扱い） |

`OpenAIVisionService` の一般化: `identifyPlant()` を残したまま、デプロイ名・スキーマ・プロンプトを引数で受ける `analyze()` を足す。
Azure / OpenAI API の分岐、`api-version`、`max_completion_tokens`、`temperature` を指定しない点はそのまま。
`baseURL` にデプロイ名を埋め込む形（`openAIVisionService.ts` 96行）は、デプロイごとにクライアントを作る形に直す。

### 2.2 契約（Structured Outputs）

```json
{
  "type": "object",
  "properties": {
    "kind": { "type": "string", "enum": ["plant", "food", "landscape", "other"],
              "description": "写真の主題のカテゴリ。植物・食べ物・風景のどれでもなければ other" },
    "confidence": { "type": "number", "description": "分類の信頼度（0-100）" },
    "reason": { "type": "string", "description": "判定理由（日本語で簡潔に）" }
  },
  "required": ["kind", "confidence", "reason"],
  "additionalProperties": false
}
```

- `enum` は `Object.keys(CATALOG_KINDS)` + `'other'` から組み立てる（定義表に種類を足すと追従する）
- strict モードの制約（`openAIVisionService.ts` 5〜14行）はそのまま: `minimum` / `maximum` が使えないので 0〜100 はコードで検証する
- プロンプトは「主題を1つ選ぶ。人や動物、建物の内装など当てはまらないものは other」。撮影地（`placeName`）があれば手がかりとして渡す

### 2.3 書き込み

- `tags` から `category:` で始まるものを除き、`category:<kind>` を1つ足す（利用者のタグは触らない）
- `classification = { kind, confidence, model: <デプロイ名>, at: <ISO> }`
- `kind` が `CATALOG_KINDS` にあれば（段階4）`{ step: "identify" }` を投入。`other` なら `done`

## 3. 識別（段階4）

### 3.1 契約

名前は AI が確定し、第2候補以降は残さない（要件 5.5）。

```
{
  matchesKind: boolean,            // 分類どおりの種類が写っているか。false なら以下は null 可
  name: string | null,             // 命名規則どおりの最も細かい粒度
  confidence: number,              // 0〜100（範囲はコードで検証）
  description: string | null,      // 種類の説明
  characteristics: string | null,  // 見た目の特徴（一言）
  comment: string,                 // この写真への一言。確証が無いときは「〇〇の可能性もある」と補足
  attributes: { <CATALOG_KINDS[kind].fields から> }
}
```

- スキーマは `kind` ごとに定義表から組み立てる（[04 §3.2](./04_data_design.md#32-定義表-catalog_kindsapisrccatalogkindsts)）。`attributes` の各項目は `required` に入れ、任意は `["string","null"]`、`string[]` は `["array","null"]`
- `candidates` は無い。プロンプトで「候補を列挙せず1つに決める。信頼度が低いときは `comment` で補足する」と指示する
- 命名規則は定義表の `namingRule` をプロンプト本文に入れる
- 手がかりは既存の `contextSection`（`openAIVisionService.ts` 137〜141行）と同じ形で渡す:

  ```
  追加情報：
  利用者からの手がかり: <hint>
  撮影地: 北海道旭川市
  撮影日時: 2026-10-05 12:30
  この情報を参考にして、識別の精度を向上させてください。
  ```

  `hint` は `POST /api/photos/{photoId}/process` が保存したもの。無い行は出さない

### 3.2 書き込みと項目の併合

1. `matchesKind: false` → `identification = { matchesKind: false, reason: comment, model, at }` を保存し、`entryId` は付けない。`done`。画面は「分類と合わない」と出す
2. `matchesKind: true` → `entryId = "<kind>-" + sha256(name.trim())`
   - `create` で項目を作る（`description`・`characteristics`・`attributes`・`confidence`）
   - 409 なら既存を読み、新しい `confidence` が高ければ `_etag` 条件付きで `replace`（説明・特徴・属性・信頼度を更新）。412 なら読み直して再試行（最大 3 回）
3. 写真に `patch`: `identification = { matchesKind: true, name, confidence, model, at }`、`entryId`、`comment`、`commentSource: "ai"`、`processing.state = done`

やり直しの結果は `comment` を上書きし `commentSource: "ai"` に戻す（[02 §5](./02_design_overview.md#5-人間に決めてもらう点推奨付き) #9）。
利用者の文を失わないよう、アプリのやり直し画面は `commentSource == "user"` なら現在のコメントを `hint` に事前入力する。

### 3.3 既存の `identifyPlant()` との関係

`PLANT_IDENTIFICATION_SCHEMA`（`openAIVisionService.ts` 15〜84行）と `identifyPlant()` は、植物図鑑の廃止（§7）と同時に消す。
それまでは `analyze()` と並存する。`validateAnalysisResult()` の「範囲はコードで検証」の方針は新しい検証にも引き継ぐ。

## 4. 地名への変換

要件 5.3「緯度・経度を地名（市区町村など）に変換して表示する」と §8「段階と方法は設計で決める」。

### 4.1 比較

| 案 | 費用（推測。要確認） | どこで・いつ | 利点 | 欠点 |
|---|---|---|---|---|
| **a. 端末の Geocoder**（`geocoding` パッケージ → Android `Geocoder.getFromLocation`） | 0 円。API キー不要 | クライアント、送る前（段階2） | 追加のインフラ・秘密情報が無い。端末のロケール（日本語）で返る（推測） | Google Play 開発者サービスが要る（要実測）。応答が無い・遅いことがある。サーバで後から埋め直せない。結果の文字列をクライアントから受け取る（長さの検証のみ） |
| **b. Azure Maps Search（Reverse Geocode）** | Gen2 で月 1,000 トランザクションまで無料、超過は 1,000 件あたり数百円（推測。価格表で確認） | サーバのワーカー、段階3 | Terraform で同じ請求にまとまる。`language=ja-JP`。既存の写真も裏で埋められる | アカウントとキーが増える。1旅行 300 枚で丸めキャッシュ無しだと無料枠に迫る |
| c. OpenStreetMap Nominatim | 無料 | サーバのワーカー | キー不要 | 1 req/s・一括利用禁止で、裏の処理の一斉実行と相性が悪い。稼働率の保証が無い |
| d. 分類 LLM に座標から地名を答えさせる | LLM の費用に含まれる | 段階3 | 追加サービス無し | 市区町村の精度は信頼できない。却下 |
| e. 国土数値情報の行政区域をサーバに同梱 | 0 円 | サーバ | 外部通信無し | データが数十 MB、海外が無い、更新の手間。個人規模には重い |

**推奨: 段階2で a、段階3で b を「地名が無い写真だけ裏で埋める」補助として足す（b は任意。a の品質が十分なら入れない）。**

### 4.2 段階2（端末）

- 送信キューの準備で、EXIF から緯度・経度を読んだ後、小数3桁（≒ 100 m）に丸めた座標をキーにした端末内のキャッシュ（`shared_preferences`）を引き、無ければ `Geocoder` を呼ぶ
- 市区町村の粒度: `Placemark` の `administrativeArea`（都道府県）+ `locality`（市区町村）を連結する（例: 「北海道旭川市」）。どちらも空なら `null`
- 失敗・空応答・タイムアウト（5 秒）は `placeName: null` で送る（**送信を止めない**）。`placeSource: "device"`
- サーバは `placeName` を 1〜100 文字として検証して保存するだけ。写真ビューアに `placeName` を出し、無ければ緯度・経度を出す
- **要実測**: a が SC-03K で動くか、市区町村まで返すか。段階2の PR 7 の実機確認で確かめ、ダメなら b を段階3に繰り上げる

### 4.3 段階3（サーバ・任意）

- `api/src/services/geocodingService.ts` の interface `reverse(lat, lon): Promise<{ placeName: string } | null>` と、Azure Maps の実装
- ワーカーの `classify` の前に、`location` があり `placeName` が無い写真だけ呼ぶ。結果は `type: "geocache"`（[04 §1.5](./04_data_design.md#15-地名のキャッシュtype-geocache段階3任意)）に置いて使い回す
- 1日あたりの呼び出し上限 `GEOCODING_DAILY_LIMIT`（環境変数。既定 100）。超えたら呼ばずに進む（地名無しのまま）
- `UpstreamService` に `'geocoding'` を足す。失敗しても分類は続ける（地名は手がかりに過ぎない）
- キー `AZURE_MAPS_KEY` は Terraform の `azurerm_maps_account` から `app_settings` へ

### 4.4 段階4

識別のプロンプトに「撮影地: 北海道旭川市、撮影日時: 2026-10-05 12:30」を `contextSection` と同じ形で入れる（§3.1）。特に風景で効く（要件 5.5）。

## 5. 失敗と再試行のまとめ

| 失敗 | どこで | 扱い |
|---|---|---|
| キューへの投入の失敗（HTTP 関数） | `POST /api/photos`・`process` | `POST /api/photos` は写真を保存した後なので、投入に失敗しても 201 を返し、`state: "pending"` のままタイマーが拾う。`process` は 502 / 503 `STORAGE_ERROR` |
| AI の 429 / 503 | ワーカー | 例外を投げてキューの再試行。3 回で poison → タイマーが `failed` に |
| AI の応答の検証違反 | ワーカー | 同上（内容が変わる可能性があるので再試行する価値がある） |
| Blob の SAS 生成の失敗 | ワーカー | 同上 |
| Cosmos の 412（併合の競合） | ワーカー | 読み直して最大 3 回 |
| 地名変換の失敗 | ワーカー | ログだけ。分類は続ける |
| 10 分以上 `pending` / `classifying` のまま | タイマー | 再投入（`attempts` 未満）か `failed` |

## 6. 費用の見積もり方と上限

- **実測してから見積もる。** 段階3の最初に 10 枚を分類し、応答の `usage`（プロンプト・補完のトークン数）をログに出して `docs/09_backlog.md` の「旅行アルバム（ロードマップ）」に記録する。段階4の識別も同じ
- 見積もりの式: 1 枚あたりのトークン × 単価 × 1 旅行の枚数（数百）× 旅行の回数。識別は分類で絞った枚数（`other` を除く）だけ
- 上限: 1 日あたりの AI 呼び出し回数 `AI_DAILY_CALL_LIMIT`（環境変数。既定は実測後に決める）。ワーカーはカウンタ（`type: "counter"` のドキュメント、id は日付）を見て、超えたら処理を翌日に回す（`pending` のまま。タイマーが再投入する）
- Azure 側の予算アラート（`azurerm_consumption_budget_resource_group`）を Terraform に足すかは人間が決める（[07 §2](./07_infrastructure_design.md#2-段階3)）
- 費用に効く設計: 分類は安価なモデルで `detail: "low"`、識別は必要な写真だけ、直列で流す（TPM の上限超えによる再試行の無駄を減らす）

## 7. 今の植物図鑑の統合と廃止（段階4）

要件 5.8。前提: 段階4の新しい図鑑（`entry`・`GET /api/catalog/*`・Flutter の図鑑画面）が先に動いていること。

| 手順 | 内容 | 担当 |
|---|---|---|
| 1. 退避 | `images` を作業マシンに落とし、`plants` の全ドキュメントを JSON で書き出す（手順は `infrastructure/README.md` に書く） | 人間 |
| 2. 移行 | `api/scripts/migratePlants.ts`（ローカルで実行。冪等）: `plants` を全件読み → `imagePath` の Blob を読んで SHA-256 → `photos/<hash>.jpg` に上げる → `photo`（`tripId: null`、`tags: ["category:plant"]`、`takenAt: null`・`takenAtSource: "none"`、`uploadedAt = plant.createdAt`、`comment = plant.characteristics`・`commentSource: "ai"`、`legacyPlantId`）を `create`（既にあれば飛ばす）→ `entry`（`kind: "plant"`、`name`、`description`、`characteristics`、`attributes: { scientificName, familyName }`、`confidence`）を `create` または信頼度で併合 → 写真に `identification`・`entryId` を `patch` | メインセッション（スクリプト）、人間（実行） |
| 3. 確認 | アプリの図鑑（種類 = 植物）に旧図鑑の件数が揃うこと。`legacyPlantId` で突き合わせ | 人間 |
| 4. アプリ | 図鑑タブを新しい図鑑画面に差し替え、`camera_screen`・`identification_screen`・`plant_detail_screen` と `Plant` 系のモデル、`ApiService` の植物メソッドとテストを削除 | PR |
| 5. API | `upload.ts`・`identify.ts`・`checkDuplicate.ts`・`save.ts`・`updatePlant.ts`・`plants.ts`・`plantDetail.ts`・`cosmosService.ts`・`storageService.ts`（SAS は `utils/blobSas.ts` に移っている）・`types/plant.ts` とテストを削除。`app.ts` の import を外す。`docs/06`・`07`・`README` を更新 | PR |
| 6. インフラ | `images`・`plants` と `STORAGE_CONTAINER_NAME`・`TEMP_STORAGE_CONTAINER_NAME`・`COSMOS_DB_CONTAINER` の `app_settings` を削除。`temp-images` も不要。`plan` で `album`・`photos` に replace が出ないことを確かめる | PR + 人間が apply |

4〜6 は別々の PR。順序は 1→2→3→4→5→6。`legacyPlantId` は移行の突き合わせのためだけの項目で、確認が済んだら残しても消してもよい。
azurerm v5 で `images` の公開設定が落ちる懸念は、6 で `images` が無くなれば消える。
