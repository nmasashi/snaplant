# SnapPlant データベース設計書（Azure Cosmos DB）

## 1. 概要

植物図鑑アプリ「SnapPlant」で使用するAzure Cosmos DBのデータベース設計を定義します。
NoSQLドキュメントデータベースとして設計され、JSONドキュメントとしてデータを保存します。

## 2. Cosmos DB コンテナ設計

### 2.1 データベース構成
- **データベース**: snaplant-db
- **コンテナ**: plants
- **パーティションキー**: `/id` (UUIDを使用)

### 2.2 ドキュメント構造
```json
{
  "id": "123e4567-e89b-12d3-a456-426614174000",
  "name": "桜",
  "scientificName": "Prunus serrulata",
  "familyName": "バラ科",
  "description": "日本を代表する花木",
  "characteristics": "春に美しいピンクの花を咲かせる",
  "confidence": 95.5,
  "imagePath": "https://snaplant.blob.core.windows.net/images/sakura.jpg",
  "createdAt": "2024-01-15T10:30:00Z",
  "updatedAt": "2024-01-15T10:30:00Z"
}
```

## 3. フィールド定義

### 3.1 Plantドキュメント

植物の基本情報と識別結果を保存するメインドキュメント

| フィールド名 | データ型 | 必須 | 説明 |
|----------|----------|------|------|
| id | string (UUID) | ○ | 主キー（UUID v4形式） |
| name | string | ○ | 植物名（日本語）例：「桜」 |
| scientificName | string | × | 学名 例：「Prunus serrulata」 |
| familyName | string | × | 科名 例：「バラ科」 |
| description | string | × | 植物の詳細説明 |
| characteristics | string | ○ | 特徴（画面表示用の短い説明） |
| confidence | number | ○ | AI識別の信頼度（0.0-100.0） |
| imagePath | string | ○ | 画像URL（Azure Blob Storage） |
| createdAt | string (ISO 8601) | ○ | 作成日時 |
| updatedAt | string (ISO 8601) | ○ | 更新日時 |

### 3.2 インデクシングポリシー

Terraform（`infrastructure/main.tf` の `azurerm_cosmosdb_sql_container.plants`）で
定義している実際のポリシーは、全パスをインデックス対象にする既定構成です。

```json
{
  "indexingMode": "consistent",
  "includedPaths": [
    {"path": "/*"}
  ],
  "excludedPaths": [
    {"path": "/\"_etag\"/?"}
  ]
}
```

`name` / `createdAt` だけを含める形には絞っていません（`/*` に含まれるため
重複確認と並び替えのクエリは機能します）。パスを絞るのはドキュメント数が
増えて書き込み RU が問題になってからで十分という判断です。

## 4. データ要件

### 4.1 データサイズ見積もり
- **想定ドキュメント数**: 1ユーザーあたり平均50種類の植物
- **ドキュメントサイズ**: 1ドキュメントあたり約2KB（画像はBlob Storageに別保存）
- **RU消費量**: 読み取り1RU/ドキュメント、書き込み5RU/ドキュメント

### 4.2 データ制約
- **id**: UUID v4形式、一意性必須
- **name**: 必須項目、最大100文字。新規登録時に前後の空白を取り除いて保存する
  （重複確認の `WHERE c.name = @name` に渡す値も前後の空白を取り除いたものなので、それと揃えている）。
  更新（`PUT /api/plants/{id}`）では変更されない
- **characteristics**: 必須項目、最大500文字
- **confidence**: 0.0以上100.0以下の数値
- **imagePath**: 必須項目、画像アップロードAPIが返したURL（自ストレージアカウントの永続コンテナを指すURLのみ受け付ける）。
  表記は正規形に限定され、同じBlobを指す別表記（クエリ文字列やフラグメント付きなど）は
  保存できない。保存されるのは送られた文字列そのもので、下記の一意性確認も
  文字列の完全一致で行うため。
  新規登録時と更新時はアプリケーション側で一意性も確認する（既存レコードと重複する場合は 409 `IMAGE_ALREADY_SAVED`）
- **createdAt/updatedAt**: ISO 8601形式の日時文字列

## 5. 機能別Cosmos DBクエリ

### 5.1 植物一覧画面
```sql
-- 植物一覧取得（作成日時降順）
SELECT c.id, c.name, c.characteristics, c.imagePath, c.confidence, c.createdAt
FROM c 
ORDER BY c.createdAt DESC
```

### 5.2 植物詳細画面

SQLは発行せず、SDKのPoint Readを使います。パーティションキーが `/id` のため
idを2回渡します。

```typescript
// ID指定でのドキュメント取得（Point Read）
const { resource } = await container.item(plantId, plantId).read<Plant>();
```

対象が存在しない場合、`@azure/cosmos` の `Item.read()` は例外ではなく
`resource` なしのレスポンスを返すため、アプリ側は `resource || null` で判定します。

### 5.3 重複確認機能
```sql
-- 同名植物の存在確認
SELECT TOP 1 c.id, c.name, c.imagePath, c.confidence, c.createdAt
FROM c 
WHERE c.name = @name
```

### 5.4 画像パスの重複確認（新規登録・更新の前段）
```sql
-- 同じ画像を参照するドキュメントの一覧
SELECT * FROM c WHERE c.imagePath = @imagePath
```
`POST /api/plants/save` はこのクエリを登録前に実行し、1件でも該当すれば
409 `IMAGE_ALREADY_SAVED` を返して保存しません。
`PUT /api/plants/{id}` も更新前に実行し、該当があり、そのどれも更新対象自身でなければ
同じく 409 を返します（自分が既にその画像を持っていれば通す）。
同じ `imagePath` のドキュメントが2件あると、一方の削除や画像更新で
もう一方の画像まで消えてしまうためです（`CosmosService.getPlantsByImagePath()`）。

### 5.5 植物識別結果保存
```typescript
// 呼び出し側（save.ts）: id と日時は設定しない
const newPlant: PlantCreateRequest = {
  name: "桜",
  scientificName: "Prunus serrulata",
  familyName: "バラ科",
  description: "日本を代表する花木",
  characteristics: "春に美しいピンクの花を咲かせる",
  confidence: 95.5,
  imagePath: "https://snaplant.blob.core.windows.net/images/sakura.jpg"
};
const savedPlant = await cosmosService.createPlant(newPlant);

// CosmosService.createPlant(): id と日時を付与して登録（SDK使用）
const now = new Date().toISOString();
const plant: Plant = {
  id: this.generateId(),
  ...plantData,
  createdAt: now,
  updatedAt: now
};
const { resource } = await this.container.items.create<Plant>(plant);
```

id と日時は `CosmosService.createPlant()` が付与します。引数の型 `PlantCreateRequest` は
id も日時も持たず、呼び出し側は設定しません。id は `generateId()`（v4 形式）で採番し、
`createdAt` と `updatedAt` には共通の `now` を入れるため、新規登録時の両者は一致します。

### 5.6 植物情報更新
```typescript
// 既存植物の画像更新（SDK使用）
const updatedPlant = {
  ...existingPlant,
  imagePath: "https://snaplant.blob.core.windows.net/images/sakura_new.jpg",
  confidence: 97.8,
  updatedAt: new Date().toISOString()
};
await container.item(plantId, plantId).replace(updatedPlant);
```

## 6. データ整合性

### 6.1 制約条件
- **一意性制約**: id（UUIDで一意性保証）、imagePath（DBの制約ではなく
  `POST /api/plants/save` と `PUT /api/plants/{id}` がクエリで確認し、重複すれば 409 `IMAGE_ALREADY_SAVED`）
- **必須フィールド**: name, characteristics, confidence, imagePath, createdAt, updatedAt
- **バリデーション**: アプリケーションレベルで実装
  - confidence: 0.0 ≤ confidence ≤ 100.0
  - imagePath: URLとしてパースできること、かつスキームが `https:`、
    ホストが自ストレージアカウントのBlobエンドポイント、パスがちょうど
    `/<永続コンテナ名>/<Blob名>` の2セグメントであること。さらに送られた文字列が
    `https://<ホスト>/<永続コンテナ名>/<Blob名>` と**完全一致**すること
    （外部ホスト、`https:` 以外のスキーム、一時コンテナ、中間に余分なセグメントを
    挟んだURL、クエリ文字列・フラグメント・`user:pass@` 付き・ホスト名の大文字・
    先頭の空白はいずれも 400 で拒否）
  - UUID（`GET` / `PUT` / `DELETE /api/plants/{id}` のパスの id）: 形式を正規表現でチェックする
    （`8-4-4-4-12` 桁の16進、バージョン桁 1〜5、バリアント桁 8/9/a/b、大文字小文字は区別しない。
    `GENERAL_VALIDATION.UUID_REGEX`）。API が採番する id は v4 だが、受け付ける形式は v4 に限らない。
    形式に合わない id は 400 `INVALID_REQUEST`

### 6.2 ドキュメント削除
```typescript
// 植物ドキュメントの削除（SDK使用）
await container.item(plantId, plantId).delete();
```
削除前に `imagePath` を読んでおき、ドキュメント削除後に Blob Storage 上の画像も削除します
（孤児Blobを残さないため）。画像削除の失敗はログ出力のみで、削除自体は成功として扱います。

画像の削除（更新時の旧画像・削除時の画像とも）は、URL のホストが自ストレージアカウントの
Blob エンドポイントと一致し、最初のパスセグメントが永続コンテナ名または一時コンテナ名と
完全一致する場合に限って行います。満たさない URL は何も削除せず、ドキュメント操作は
通常どおり成功します。入口（save / PUT の `imagePath` 検証）と出口（削除）の二層で、
他レコードの Blob を消す経路を塞ぐためです（`StorageService.deleteImage()`）。
削除する Blob 名はコンテナ名より後ろのパス全体です（最後のセグメントだけを取ると、
中間にセグメントを挟んだ URL が別の Blob を指せてしまうため）。

## 7. 拡張性考慮

### 7.1 将来的な拡張要素
現在はシンプルな単一コンテナ構成ですが、将来的には以下の拡張が考えられます：

- **マルチテナント対応**: ユーザーIDをパーティションキーに使用
- **カテゴリ分類**: ドキュメント内にcategories配列を追加
- **位置情報**: locationオブジェクトをドキュメントに埋め込み
- **識別履歴**: 別コンテナまたはドキュメント内のhistory配列

### 7.2 NoSQL設計原則
現在の設計は**NoSQLのベストプラクティス**に従っています：
- 非正規化（データの冗長性を許容）
- アクセスパターンに最適化されたスキーマ設計
- JSONドキュメントとしての柔軟性

## 8. パフォーマンス考慮

### 8.1 想定アクセスパターン
1. **一覧表示**: createdAt降順での全件取得（最頻用）- 5RU
2. **詳細表示**: id指定でのPoint Read（頻用）- 1RU
3. **重複確認**: name指定での存在確認（中頻度）- 3RU
4. **新規作成**: ドキュメントの作成（中頻度）- 5RU
5. **更新/削除**: ドキュメントの更新/削除（低頻度）- 5RU

### 8.2 最適化方針
- **パーティションキー**: `/id`でホットパーティションを回避
- **画像ストレージ**: Azure Blob Storageで分離しRU消費を最小化
- **スループット**: 無料枠の 400 RU/s をコンテナに割り当て（`cosmos_db_throughput`）

未実施の項目:
- **インデクシングポリシーの絞り込み**: 現状は `/*`（3.2 参照）
- **TTL設定**: 設定していない（ドキュメントは明示的な削除のみ）
- **コネクションモード**: `new CosmosClient({ endpoint, key })` のみで、
  接続モードは指定していない（SDKの既定）