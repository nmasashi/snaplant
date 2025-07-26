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
```json
{
  "indexingMode": "consistent",
  "automatic": true,
  "includedPaths": [
    {"path": "/name/?"}, 
    {"path": "/createdAt/?"}
  ],
  "excludedPaths": [
    {"path": "/description/?"}
  ]
}
```

## 4. データ要件

### 4.1 データサイズ見積もり
- **想定ドキュメント数**: 1ユーザーあたり平均50種類の植物
- **ドキュメントサイズ**: 1ドキュメントあたり約2KB（画像はBlob Storageに別保存）
- **RU消費量**: 読み取り1RU/ドキュメント、書き込み5RU/ドキュメント

### 4.2 データ制約
- **id**: UUID v4形式、一意性必須
- **name**: 必須項目、最大100文字
- **characteristics**: 必須項目、最大500文字
- **confidence**: 0.0以上100.0以下の数値
- **imagePath**: 必須項目、有効なHTTPS URL
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
```sql
-- ID指定でのドキュメント取得（Point Read）
SELECT * FROM c WHERE c.id = "123e4567-e89b-12d3-a456-426614174000"
```

### 5.3 重複確認機能
```sql
-- 同名植物の存在確認
SELECT c.id, c.name, c.imagePath, c.confidence, c.createdAt
FROM c 
WHERE c.name = @name
LIMIT 1
```

### 5.4 植物識別結果保存
```typescript
// 新規植物の登録（SDK使用）
const newPlant = {
  id: uuidv4(),
  name: "桜",
  scientificName: "Prunus serrulata",
  familyName: "バラ科",
  description: "日本を代表する花木",
  characteristics: "春に美しいピンクの花を咲かせる",
  confidence: 95.5,
  imagePath: "https://snaplant.blob.core.windows.net/images/sakura.jpg",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};
await container.items.create(newPlant);
```

### 5.5 植物情報更新
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
- **一意性制約**: id（UUIDで一意性保証）
- **必須フィールド**: name, characteristics, confidence, imagePath, createdAt, updatedAt
- **バリデーション**: アプリケーションレベルで実装
  - confidence: 0.0 ≤ confidence ≤ 100.0
  - imagePath: 有効なHTTPS URL形式
  - UUID: v4形式の正規表現チェック

### 6.2 ドキュメント削除
```typescript
// 植物ドキュメントの削除（SDK使用）
await container.item(plantId, plantId).delete();
```

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
- **インデクシングポリシー**: 必要なフィールドのみインデックス化
- **パーティションキー**: `/id`でホットパーティションを回避
- **画像ストレージ**: Azure Blob Storageで分離しRU消費を最小化
- **TTL設定**: 必要に応じて自動削除機能を活用
- **コネクションモード**: Directモードでレイテンシ最小化