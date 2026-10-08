# バックログ

実装されていない機能・既知の課題を記録する。対応したらこのファイルから該当項目を削除する。

運用方針: 仕様書（`06_api_design.md` / `06_api_openapi.yaml` など）には**実装済みのものだけ**を書く。
未実装のものをここに置くことで、仕様書を「実装の正確な写し」として信頼できる状態に保つ。

---

## 優先対応

### 既存テストを古典学派の原則に準拠させる

`api/tests/` は Khorikov『単体テストの考え方/使い方』の原則に反する箇所を多数含む。
リポジトリの方針は `.claude/test-principles.md` で古典学派に定めた。
**サービス層は対応済み。ハンドラ群が未対応**（下記の進捗表）。

**何が問題か**

現在 312 個のアサーションのうち 48 個がモックの呼び出し検証で、
うち 41 個が**スタブ（クエリ）とのやり取りの検証**にあたる。

着手前はこの形だった（いずれも修正済み）。

```typescript
// storageService.test.ts — コンテナクライアントの取得方法を固定していた
expect(mockBlobServiceClient.getContainerClient).toHaveBeenCalledWith('test-images');
expect(mockContainerClient.getBlockBlobClient).toHaveBeenCalledWith('...');

// cosmosService.test.ts — 原則3が NG 例として列挙している型そのもの
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

**モック呼び出し検証の分布と進捗**

| ファイル | 件数 | 状態 |
|---|---|---|
| `tests/functions/upload.test.ts` | 15 | 未着手（論点1・3） |
| `tests/functions/updatePlant.test.ts` | 10 | 未着手（論点1） |
| `tests/functions/plantDetail.test.ts` | 6 | 未着手（論点1） |
| `tests/functions/checkDuplicate.test.ts` | 5 | 未着手（論点1・2） |
| `tests/functions/save.test.ts` | 4 | 未着手（論点1） |
| `tests/functions/identify.test.ts` | 4 | **変更不要** |
| `tests/services/openAIVisionService.test.ts` | 3 | **変更不要** |
| `tests/functions/plants.test.ts` | 1 | 未着手（論点2） |
| `tests/services/storageService.test.ts` | 0 | **完了**（768e07c） |
| `tests/services/cosmosService.test.ts` | 0 | **完了** |

`openAIVisionService.test.ts` の 3 件と `identify.test.ts` の 4 件は
OpenAI API（**管理外の依存**）への検証なので**違反ではない**。
LLM 呼び出し回数はコストに直結する観察可能な振る舞いで、
`toHaveBeenCalledTimes(1)` は原則3が推奨型として挙げている形そのもの。

**サービス層は完了した**

`storageService.test.ts` と `cosmosService.test.ts` を書き直した。共通の手口は次の通りで、
残りのファイルを進めるときの先行例になる。

1. **引数に応じて違う値を返す偽物に差し替える。** 元の共有モックは
   `getContainerClient` / `container.item` が引数に関係なく同一オブジェクトを返していたため、
   宛先やパーティションキーを取り違える不具合が通っていた（原則7-3）
2. 偽物が状態を持つので、**呼び出し検証を戻り値と最終状態の検証に置き換えられる**
3. `StorageService` はプロセス内の自前クラスなので、原則2の手順1に従い
   モックをやめて**実物**を使い、その下の Blob SDK だけを偽物にした
4. 偽物は**各テストファイル内に書き写す**。共有モジュールに切り出していない
   （`tests/setup.ts` の二重構造と同じ問題を作らないため）

**着手前に決めるべき論点**

残りはハンドラ群で、**修正の形がサービス層と違う。** 原則4はハンドラの観察可能な振る舞いを
**レスポンスそのもの**（ステータスコードとボディ）と定めており、偽物のストアを作って
状態を検証する形にはならない。サービス層の手口をそのまま機械適用できない。

着手前に次の3つを決める必要がある。原則ファイルに判定がないため、人間の判断が必要。

**論点1: `not.toHaveBeenCalled()` の扱い（18箇所）**

「バリデーション失敗時に依存に触らない」を検証する形がハンドラ群に18箇所ある。

```typescript
// tests/functions/plantDetail.test.ts:163
expect(mockContainer.item).not.toHaveBeenCalled();
```

コマンドの不発の検証として正当とも読めるが、原則4は
「内部でどのサービスをどう呼んだかではない」と定めている。どちらとも決まらない。
決めたら原則ファイル側に追記して、両エージェントの基準を揃える必要がある。

**論点2: SQL を固定しているクエリ検証（3箇所）— 外すと退行検出が消えることを実測済み**

`checkDuplicate.test.ts:104,164` と `plants.test.ts:107` が
`items.query` に渡す SQL 文を固定している。クエリは管理下にある依存への読み取りなので
原則3では検証してはいけない型だが、**外すとネットが消える**ことを変異で確認した。

| 変異 | 検出したテスト |
|---|---|
| `getPlantByName` の `WHERE c.name = @name` を削除 | **全スイートで未検出** |
| `getPlants` の射影を `SELECT *` に | **全スイートで未検出** |
| `getPlants` の `ORDER BY c.createdAt DESC` を削除 | `plants.test.ts:107-108` のみ |
| `checkDuplicateByName` の `WHERE` を削除 | `checkDuplicate.test.ts:106-109` のみ |

つまり下2つは、**これから掃除する予定の原則3違反アサーションだけが捕まえている**状態。
ハンドラ群を原則準拠に直した時点で、SQL の絞り込み・並び順・射影の退行は
どのテストからも検出されなくなる。

`cosmosService.test.ts` では `@name` パラメータの値と名前の取り違えまでは
検出できる偽物にしたが（SQL 文字列は解釈しない）、WHERE 句そのものの消失は検出できない。
Cosmos の偽物に SQL を解釈させるのは非現実的なので、
**アサーションを復活させるのではなく、妥協の埋め合わせ先を先に用意する**のが筋。
下記「Cosmos の SQL を検証する層がない」が、この掃除の前提条件になる。
原則5の歯止め2（確信が下がるなら削除しない）に当たる判断。

**論点3: `upload.test.ts` を剥がす順序**

`storageService.test.ts` の書き直し前に変異を当てたところ、
`moveFromTempToPermanent` の削除対象を取り違える変異を捕まえていたのは
`upload.test.ts` の3件だけだった。**ハンドラテストの呼び出し検証が
サービステストの穴を肩代わりしていた。**

サービス層が整った今は条件が変わっているため、剥がす前に
**再度変異を当てて保護の所在を確認する**こと。単体で捕まるようになっていれば安全に剥がせる。

併せて `tests/setup.ts` のグローバルモックと各テストの個別モックの二重構造も整理したい
（どのモックが効いているか追えず「保守のしやすさ」を損なっている）。
これは全テストに影響するため、**ハンドラ群の書き直しが終わった後の独立した作業単位**にする。

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

**注意: `cosmosService.test.ts` が現状の振る舞い（画像が残ること）をテストで固定している。**
修正に着手すると、このテストが設計どおり赤になる。期待値を書き換えるのではなく、
テスト自体が仕様の変更対象であることを認識して進めること。

このテストを残すべきかは判断待ち。`deletePlant()` には Blob を触るコードが一行もないため
対応する変異が存在せず、検出力を測れない（原則5の「取るに足らないコード」寄り）。
一方で既知仕様のドキュメントとしての価値はある（原則5の歯止め3）。

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

### Cosmos の SQL を検証する層がない

絞り込み（`WHERE`）・並び順（`ORDER BY`）・射影（`SELECT` の列）の正しさを
検証しているテストが実質存在しない。単体テストの偽物は SQL 文字列を解釈しないため
原理的に検証できず、エミュレータも E2E も未整備。

実測した穴（変異を入れて全スイートを実行した結果）:

- `getPlantByName` の `WHERE c.name = @name` を削除 → **全スイートで未検出**
- `getPlants` の射影を `SELECT *` に変更 → **全スイートで未検出**。
  これは `GET /api/plants` のレスポンスに `description` / `updatedAt` / `scientificName`
  まで漏れる退行で、OpenAPI の `PlantSummary` 契約に直接当たる
- `ORDER BY c.createdAt DESC` の削除と `checkDuplicateByName` の `WHERE` 削除は、
  ハンドラテストの SQL 文字列アサーション（原則3違反で掃除対象）だけが捕まえている

`.claude/test-principles.md` の原則2は「エミュレータ未導入のため SDK モックを許容する。
この妥協を埋め合わせるのは E2E テストの役割」と定めているが、
**その E2E が存在しない**ため、妥協の埋め合わせがされていない状態。

対応するなら Cosmos DB Emulator を CI に載せるか、
デプロイ後の実リソースに対する契約テストを足す。
[既存テストの原則準拠](#既存テストを古典学派の原則に準拠させる)の論点2の前提条件。

### `CosmosService.getPlantByName()` が未使用

`api/src/services/cosmosService.ts:55-65`。`src/` 全体と `mobile/lib` を検索しても
参照は定義のみで、呼び出し元が存在しない。`checkDuplicateByName()` と機能が重複している。

`cosmosService.test.ts` のテスト2件がこのデッドコードを守っている状態。
削除するならテストも同時に落とす。
[`StorageService.imageExists()`](#storageserviceimageexists-が未使用) と
[`ApiService.uploadImage()`](#apiserviceuploadimage-が未使用) と同種の課題なので、
まとめて整理したい。

### `StorageService.imageExists()` が未使用

`api/src/services/storageService.ts` の `imageExists()` は、リポジトリ全体で
**定義1箇所のみ・呼び出し元ゼロ**（`api/src`、`api/tests`、`mobile/lib` すべてで確認）。

**削除を推奨する。** 理由は2つ。

公開メソッドである以上、将来誰かが「存在するから使おう」と手を伸ばす。
そのとき `this.containerName`（永続コンテナ）固定で一時コンテナを見ないという
制約に気づかず誤用する可能性がある。

もう1つは用途がないこと。`deleteImage()` は 404 を正常扱いするため、
「存在確認してから削除する」パターンが不要になっている。

**テストを追加してはいけない。** `test-reviewer` は
「テスト0件・最も費用対効果が高い追加」と指摘したが、死んだ public API に
テストを足すと「この API は使われている」という誤った信号を残し、
削除のコストが上がる。[`ApiService.uploadImage()`](#apiserviceuploadimage-が未使用) と
同種の課題なので、まとめて整理したい。

### `moveFromTempToPermanent` の catch が全例外を同一文言で包む

`api/src/services/storageService.ts` の `moveFromTempToPermanent()` は、
catch 節であらゆる例外を `画像の永続保存への移動に失敗しました: ${error.message}`
に包んでいる。

これが偽陰性の温床になっていた。テストが `toThrow('画像の永続保存への移動に失敗しました')`
と接頭辞で一致させると、**検証したい分岐とまったく別の原因で落ちても通る**。
実際に「無効な一時URL形式の場合」というテストは、URL 形式のガードに到達せず、
後続の別エラーで落ちて通っていた（`.claude/test-principles.md` の原則7 参照）。

対応するなら、分岐ごとに固有のメッセージを付けるか、エラーの型を分ける。
URL 形式のガードは `extractFileNameFromUrl()` が `null` を返す場合のみ発火し、
`new URL()` がパースできる文字列はすべて通過する点にも注意（ガード自体がほぼ到達不能）。

### `deleteImage` のコンテナ判定が文字列包含

`api/src/services/storageService.ts` の `deleteImage()` は、
削除先のコンテナを URL の文字列包含で決めている。

```typescript
const containerName = imageUrl.includes(this.tempContainerName)
  ? this.tempContainerName
  : this.containerName;
```

**本番では現状問題ない。** Terraform が `TEMP_STORAGE_CONTAINER_NAME` に
`temp-images` を設定し、永続側は `images` なので、永続URL
`https://.../images/<uuid>.jpg` に `temp-images` は含まれず誤判定しない。

ただし脆い。環境変数が未設定だとコード側の既定値 `'temp'` に落ちるため、
ストレージアカウント名に `temp` が含まれると永続画像を一時コンテナから
削除しようとする。URL のパスセグメントで判定するべき。

### `contextInfo` に長さの上限がない

`POST /api/images/upload` と `POST /api/plants/identify` が受け取る `contextInfo` は、
**コード側に長さの検証がない**（`api/src/constants/validation.ts` にも定数がない）。

受け取った値は2箇所でそのまま使われる。

- `api/src/services/openAIVisionService.ts` でプロンプトに直接埋め込まれる
- `api/src/functions/identify.ts` でログに全文が出る

`docs/06_api_openapi.yaml` には以前 `maxLength: 500` の記載があったが、
実装に存在しない制約だったため仕様書から外した
（仕様書には実装済みのものだけを書く方針のため）。結果として
**仕様・実装の双方で上限なし**の状態になっている。

対応するなら `PLANT_VALIDATION` と同様に環境変数で上書きできる定数を追加し、
検証を入れてから OpenAPI に `maxLength` を戻す。

ただし**これまで通っていたリクエストを弾くようになる**ので、上限値は判断が必要。
文書化されていた意図は500文字。トークン消費とログ量の両方に影響する。

### `streamToBuffer` のエラー経路が未カバー

`api/src/services/storageService.ts` の `streamToBuffer()` は
`stream.on('error', reject)` でストリームのエラーを拾っているが、この経路のテストがない。

テストの偽物バックエンドは `download()` の時点で例外を投げるため、
**ストリームを返したあとにエラーが起きる経路に到達できない**。
`'error'` のリスナーを落とすと `moveFromTempToPermanent()` が
永久に待ち続けるが、テストは緑のまま。

対応するなら、偽物バックエンドのエントリに「エラーを発火するストリームを返す」
フラグを追加する（現在の `failWith` は `download()` 自体を失敗させるもので、別物）。

### ts-jest の設定警告

テスト実行時に毎回 `TS151002`（hybrid module kind は `isolatedModules: true` が必要）が出る。
テストは通るが出力がノイズで埋まる。`api/tsconfig.base.json` に `isolatedModules: true` を
追加するか、ts-jest の `diagnostics.ignoreCodes` で抑制する。
