# バックログ

実装されていない機能・既知の課題を記録する。対応したらこのファイルから該当項目を削除する。

運用方針: 仕様書（`06_api_design.md` / `06_api_openapi.yaml` など）には**実装済みのものだけ**を書く。
未実装のものをここに置くことで、仕様書を「実装の正確な写し」として信頼できる状態に保つ。

---

## 優先対応

### 既存テストを古典学派の原則に準拠させる

`api/tests/` の 135 件は Khorikov『単体テストの考え方/使い方』の原則に反する箇所を多数含む。
リポジトリの方針は `.claude/test-principles.md` で古典学派に定めたが、既存テストは未対応。

**何が問題か**

327 個のアサーションのうち 77 個（約 24%）がモックの呼び出し検証で、
その多くが**スタブ（クエリ）とのやり取りの検証**にあたる。

```typescript
// api/tests/services/storageService.test.ts:62-63
expect(mockBlobServiceClient.getContainerClient).toHaveBeenCalledWith('test-images');
expect(mockContainerClient.getBlockBlobClient).toHaveBeenCalledWith('...');

// api/tests/services/cosmosService.test.ts:143
expect(mockContainer.item).toHaveBeenCalledWith(plantId, plantId);
```

Cosmos DB と Blob Storage は**管理下にある依存**であり、読み取りはクエリなのでスタブ。
スタブへの呼び出し検証は過剰検証で、4本の柱のうち**リファクタリングへの耐性**を壊す。

実害の例: `StorageService` でコンテナクライアントをキャッシュする最適化を入れると、
振る舞いが一切変わっていないのに上記のテストが落ちる。
また `container.item(id, id)` の形はパーティションキーの渡し方という実装の詳細をテストに焼き付けている。

**なぜ優先か**

テストが偽陽性を出す状態を放置すると、開発者が「落ちたテストを読まずに直す」習慣になり、
テストスイート全体が信頼されなくなる。バックログの他項目（`deletePlant()` の孤児 Blob 修正など）に
着手する前に、テストを信頼できる状態にしておく方が安全。

**モック呼び出し検証の分布（多い順）**

| ファイル | 件数 |
|---|---|
| `tests/services/storageService.test.ts` | 17 |
| `tests/functions/upload.test.ts` | 15 |
| `tests/services/cosmosService.test.ts` | 12 |
| `tests/functions/updatePlant.test.ts` | 10 |
| `tests/functions/plantDetail.test.ts` | 6 |
| `tests/functions/checkDuplicate.test.ts` | 5 |
| `tests/functions/save.test.ts` | 4 |
| `tests/functions/identify.test.ts` | 4 |
| `tests/services/openAIVisionService.test.ts` | 3 |
| `tests/functions/plants.test.ts` | 1 |

注意: `openAIVisionService.test.ts` の 3 件は OpenAI API（**管理外の依存**）への検証なので
**違反ではない**。LLM 呼び出し回数はコストに直結する観察可能な振る舞い。

**進め方**

1. `test-reviewer` サブエージェントを既存テストにかけ、違反箇所を確定させる
   （上の件数は静的な見立てなので、正当なものが混ざっている可能性がある）
2. レポートを見て修正範囲を判断する
3. `test-writer` サブエージェントで `storageService.test.ts` から順に書き直す

併せて `tests/setup.ts` のグローバルモックと各テストの個別モックの二重構造も整理したい
（どのモックが効いているか追えず「保守のしやすさ」を損なっている）。

---

## 機能追加

### ヘルスチェックエンドポイント `GET /api/health`

依存サービスの到達性をまとめて返すエンドポイント。OpenAPI 仕様書に定義だけ存在していたが
未実装だったため、2026-10-08 に仕様書から削除してここへ移した。

当時の想定レスポンス:

```json
{
  "status": "healthy",
  "services": {
    "database": "healthy",
    "blobStorage": "healthy",
    "aiService": "healthy"
  },
  "timestamp": "2026-10-08T12:00:00.000Z"
}
```

`status` は `healthy` / `degraded` / `unhealthy`、各サービスは `healthy` / `unhealthy`。

実装時にやること:

- `api/src/functions/health.ts` を追加し、`authLevel: 'anonymous'`、`route: 'health'` で登録する
  （監視用途なので Function Key を要求しない想定）
- `api/src/app.ts` に import を追加する（**忘れると関数が登録されない**）
- `api/tests/functions/health.test.ts` を追加する
- `.github/workflows/deploy-functions.yml` の Health Check ステップを
  ルート `/` への curl から `/api/health` に切り替える
- OpenAPI 仕様書にパス定義と `HealthStatus` スキーマを戻す

### レート制限

`06_api_design.md` に制限値とエラーレスポンスの定義だけ存在していたが未実装だったため、
2026-10-08 に設計書から削除してここへ移した。

当時の想定値:

| 対象 | 制限 |
|------|------|
| 一般API | 1分間に60リクエスト |
| 画像アップロード | 1分間に10リクエスト |
| 植物識別 | 1分間に5リクエスト |

超過時は `RATE_LIMIT_EXCEEDED` を返す想定だったが、このコードは
`api/src/types/api.ts` の `ErrorCode` にも存在しない。実装する場合は enum への追加が必要。

Azure Functions の Consumption Plan には標準のレート制限機構がないため、
実装するなら API Management を前段に置くか、Cosmos DB にカウンタを持つ自前実装になる。
コスト最適化方針（`DEPLOYMENT.md`）と合わせて要検討。

---

## 既知の不具合・改善

### 植物削除時に Blob 画像が残る

`CosmosService.deletePlant()` は Cosmos DB のドキュメントのみ削除し、
Blob Storage 上の画像を削除しない。削除を繰り返すと孤児 Blob が蓄積する。

一方 `updatePlant()` は画像差し替え時に旧画像を削除している（`cosmosService.ts` 参照）ので、
削除側だけ処理が抜けている状態。

対応するなら `deletePlant()` で対象植物の `imagePath` を読んでから
`storageService.deleteImage()` を呼ぶ。`updatePlant()` と同様に、
Blob 削除の失敗はログ出力のみでドキュメント削除は成功扱いにするのが既存方針と整合する。

### 未使用のエラーコード `PLANT_ALREADY_EXISTS`

`api/src/types/api.ts` に定義されているが、どこからも使われていない。
`POST /api/plants/save` は同名植物の存在チェックをせず、Cosmos DB が 409 を返した場合に
`DATABASE_ERROR` を返している。

本来は保存前に `getPlantByName()` で重複を確認し、
`PLANT_ALREADY_EXISTS` + 409 を返す設計だったと思われる。
現状はクライアントが保存前に `GET /api/plants/check-duplicate` を呼ぶ運用で代替している。

### Flutter 側のテストがほぼ無い

`mobile/test/` にはアプリが起動することを確認するスモークテスト1本しかない。
`ApiService` のレスポンス封筒の解釈は過去に実際に不整合を起こしているため、
`http.Client` をモックしたユニットテストの価値が高い。

`test-writer` サブエージェントで書けるが、WSL から `flutter test` は実行できないため
実行と確認は Windows 側で行う必要がある。

### Flutter と Terraform が CI の対象外

`.github/workflows/ci.yml` のトリガーは `api/**` と `.github/workflows/**` のみ。
`flutter analyze` も `flutter test` も `terraform validate` も自動実行されていない。

### `ApiService.uploadImage()` が未使用

`mobile/lib/services/api_service.dart` の `uploadImage()` は
「従来版・互換性のため残存」とあるが、呼び出し元が存在しない。
呼び出すエンドポイントは `uploadAndIdentifyImage()` と同じ `/api/images/upload` で、
AI 識別も走るため「単純アップロード」という元の意味は既に失われている。削除候補。

### ts-jest の設定警告

テスト実行時に毎回 `TS151002`（hybrid module kind は `isolatedModules: true` が必要）が出る。
テストは通るが出力がノイズで埋まる。`api/tsconfig.base.json` に `isolatedModules: true` を
追加するか、ts-jest の `diagnostics.ignoreCodes` で抑制する。
