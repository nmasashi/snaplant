# バックログ

実装されていない機能・既知の課題を記録する。対応したらこのファイルから該当項目を削除する。

運用方針: 仕様書（`06_api_design.md` / `06_api_openapi.yaml` など）には**実装済みのものだけ**を書く。
未実装のものをここに置くことで、仕様書を「実装の正確な写し」として信頼できる状態に保つ。

各項目の**「判断が必要な点」と「推奨」は Claude が付けた意見**であり、検証済みの事実ではない。
このファイルの他の記述（実在する課題・実測値）とは性質が違うので混ぜないこと。
採否は人間が決め、決めたら推奨の節は消して結論を本文に書く。

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

**判断が必要な点**: ハンドラテストで「依存に触っていないこと」を検証してよいか。

**推奨**: 呼び出し検証をやめ、**偽物の状態が変わっていないこと**で検証する。
サービス層で作った偽物（状態を持つ `Map`）がそのまま使えるので、
「バリデーション失敗時に Cosmos のドキュメントが増えていない」「Blob が増えていない」
という形に書き換えられる。これなら原則3（スタブへの呼び出しを検証しない）と
原則4（観察可能な振る舞い）の両方を満たし、どちらの解釈を採るかを決めずに済む。

状態で表現できない箇所だけ `not.toHaveBeenCalled()` を残し、
原則ファイルに「外部への副作用が起きていないことは観察可能な振る舞いに含める」と
追記して基準を一本化する。

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

**判断が必要な点**: SQL 検証層が無いまま掃除を進めるか、先に層を用意するか。

**推奨**: **該当3箇所だけ例外として残す。** 他の呼び出し検証は掃除してよいが、
`checkDuplicate.test.ts:104,164` と `plants.test.ts:107` には
「SQL の絞り込み・並び順・射影を見ているテストがここしかない。
E2E が入ったら削除する」というコメントを付けて据え置く。

原則違反を承知で残す判断なので、理由をコードに書き残すことが条件。
原則5の歯止め2が「確信が下がるなら削除しない」と定めており、
ここは実測で確信が下がることが分かっている。

**論点3: `upload.test.ts` を剥がす順序**

`storageService.test.ts` の書き直し前に変異を当てたところ、
`moveFromTempToPermanent` の削除対象を取り違える変異を捕まえていたのは
`upload.test.ts` の3件だけだった。**ハンドラテストの呼び出し検証が
サービステストの穴を肩代わりしていた。**

サービス層が整った今は条件が変わっているため、剥がす前に
**再度変異を当てて保護の所在を確認する**こと。単体で捕まるようになっていれば安全に剥がせる。

**判断が必要な点**: なし（手順の問題）。

**推奨**: `upload.test.ts` を**最後**に回す。着手時の手順は、
(1) `moveFromTempToPermanent` の削除対象を取り違える変異を入れる、
(2) `upload.test.ts` を除いて全体を実行し、サービス層だけで赤になることを確認する、
(3) 赤になるなら剥がしてよい。緑なら保護がまだ `upload.test.ts` にあるので、
先にサービス層のテストを足す。

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

**判断が必要な点**

1. `authLevel: 'anonymous'` にするか。Function Key を要求すると監視ツール側に鍵を置くことになる
2. `aiService` の到達性をどう測るか。OpenAI に実際のリクエストを投げると**ヘルスチェックごとに課金**される

**推奨**

`authLevel: 'anonymous'` で実装する。ただし**返す情報を最小限にする** —
`healthy` / `degraded` / `unhealthy` の文字列だけにして、
例外メッセージ・エンドポイント URL・リソース名を含めない。
認証なしで情報を出す面のリスクは、状態文字列だけなら低い。

`aiService` は**実リクエストを投げない。** 設定（`AZURE_OPENAI_ENDPOINT` /
`AZURE_OPENAI_DEPLOYMENT_NAME` / API キー）が揃っているかの確認に留める。
監視の間隔によっては推論モデルの課金が積み上がるため、
`DEPLOYMENT.md` のコスト最適化方針と衝突する。

`database` と `blobStorage` は読み取り1回で測れるので実際に叩いてよい
（Cosmos は軽いクエリ、Blob はコンテナのプロパティ取得）。

実装は TDD で進められる。レスポンス形状は上に確定しているので、
`degraded`（一部だけ unhealthy）の判定ルールをテストリストに入れること。

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

**判断が必要な点**: そもそも実装するか。するなら API Management か自前か。

**推奨**: **現時点では実装しない。** 理由は3つ。

API Management を前段に置くと固定費が発生し、`DEPLOYMENT.md` のコスト最適化方針と
正面から衝突する。自前実装は Cosmos にカウンタを書き込むことになり、
全リクエストに書き込みが1回増えて RU を食う（レート制限のために
データベースのコストが上がるのは本末転倒）。

そして現状、全関数が `authLevel: 'function'` で Function Key を要求するため、
鍵を知らない第三者は叩けない。濫用の経路は鍵の漏洩に限られ、
それはレート制限ではなく鍵のローテーションで対処する問題。

**やるとしたら `POST /api/plants/identify` だけに絞る。**
ここだけが OpenAI の課金に直結する。Azure 側の予算アラートを先に入れて、
実際に異常な消費が観測されてから着手する方が費用対効果が高い。

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

**判断が必要な点**: 修正するか。ユーザーの画像を実際に削除する振る舞いの変更になる。

**推奨**: **修正する。** 孤児 Blob はストレージ課金に積み上がり続け、
放置する理由がない。実装は本文の方針どおり、`updatePlant()` と同じ流儀
（Blob 削除の失敗はログのみ、ドキュメント削除は成功扱い）に揃える。

既存テストは**期待値の意味を変えてよい**。通常は「期待値を書き換えたくなったら
振る舞いを変えているサイン」だが、ここは意図的な仕様変更なので正当。
「画像も削除される」に書き換える。

TDD で進める。再現テスト（削除後に Blob が残っていることを確認）は
`cosmosService.test.ts` に既にあるので、それを反転させる形になる。

### 未使用のエラーコード `PLANT_ALREADY_EXISTS`

`api/src/types/api.ts` に定義されているが、どこからも使われていない。
`POST /api/plants/save` は同名植物の存在チェックをせず、Cosmos DB が 409 を返した場合に
`DATABASE_ERROR` を返している。

本来は保存前に `getPlantByName()` で重複を確認し、
`PLANT_ALREADY_EXISTS` + 409 を返す設計だったと思われる。
現状はクライアントが保存前に `GET /api/plants/check-duplicate` を呼ぶ運用で代替している。

**判断が必要な点**: `POST /api/plants/save` の契約を変えるか、enum から消すか。

**推奨**: **enum から削除する**（契約は変えない）。

クライアントが `check-duplicate` を先に呼ぶ運用で既に成立している。
`save` を 409 + `PLANT_ALREADY_EXISTS` に変えると、OpenAPI 仕様書・
`mobile/lib/services/api_service.dart`・エラー処理の分岐すべてに波及するうえ、
クライアント側の事前チェックは重複チェックの UX（候補の提示）のために
残るので、ラウンドトリップは減らない。

未使用の定義を残すと「この契約は存在する」という誤った信号になる。
`imageExists()` や `getPlantByName()` と同じ死蔵コードの問題。

### Flutter 側のテストがほぼ無い

`mobile/test/` にはアプリが起動することを確認するスモークテスト1本しかない。
`ApiService` のレスポンス封筒の解釈は過去に実際に不整合を起こしているため、
`http.Client` をモックしたユニットテストの価値が高い。

`test-writer` サブエージェントで書けるが、WSL から `flutter test` は実行できないため
実行と確認は Windows 側で行う必要がある。

**判断が必要な点**: なし（着手のタイミングだけ）。

**推奨**: **Windows 側で `flutter test` を回せるセッションを1回取り、その場で書く。**

WSL セッションで先に書き溜めておくことは意図的に避けた。赤も緑も確認できないまま
Dart のテストを置いていくと、構文エラー1つで「テストがある」という誤った信号だけが残る。
CLAUDE.md が「実行していないものを実行したように書かない」と定めている趣旨からも、
未検証のテストを成果物として置くのは筋が悪い。

優先して書く対象は `ApiService` のレスポンス封筒の解釈。
`_parseResponse()` がボディ全体をコールバックに渡すため各メソッドが
自分で `json['data']` を剥がす必要があり、過去に `identifyPlant()` と
`uploadImage()` で実際に不整合が起きている。封筒の内側のキーが
エンドポイントごとに違う点（CLAUDE.md の表）も、テストで固定する価値が高い。

### Flutter と Terraform が CI の対象外

`.github/workflows/ci.yml` のトリガーは `api/**` と `.github/workflows/**` のみ。
`flutter analyze` も `flutter test` も `terraform validate` も自動実行されていない。

**判断が必要な点**: CI に Flutter SDK を入れるか（ジョブ時間が増える）。

**推奨**: **Terraform を先に入れる。** `terraform fmt -check` と
`terraform validate` は SDK のセットアップが軽く、実行も数秒で、
`terraform.tfstate` がリポジトリに入っている構成では壊れた定義を
push する事故を直接防ぐ。トリガーに `infrastructure/**` を足すだけで済む。

Flutter はその次。`subosito/flutter-action` で `flutter analyze` と
`flutter test` を入れる。**これは WSL で検証できない作業の保険として特に効く** —
現状、Dart コードの変更は誰も自動で検証していない。

ただし `mobile/` のアーキテクチャ方針が未決定（`provider` / `go_router` / `dio` が
宣言だけで未使用）な状態で `flutter analyze` を必須化すると、
方針を決める作業が CI に阻まれる可能性がある。先に方針を決める方が順序としては自然。

### `ApiService.uploadImage()` が未使用

`mobile/lib/services/api_service.dart` の `uploadImage()` は
「従来版・互換性のため残存」とあるが、呼び出し元が存在しない。
呼び出すエンドポイントは `uploadAndIdentifyImage()` と同じ `/api/images/upload` で、
AI 識別も走るため「単純アップロード」という元の意味は既に失われている。削除候補。

**判断が必要な点**: 削除してよいか。

**推奨**: **削除する。** 名前が「単純アップロード」を約束しているのに
実際は AI 識別が走って課金されるため、残すほど誤用の危険がある。
`uploadAndIdentifyImage()` が同じエンドポイントを正しい名前で叩いている。

Dart なので削除後に Windows 側で `flutter analyze` が必要。
上記「Flutter 側のテストがほぼ無い」と同じセッションでまとめて処理するのが効率的。

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

**判断が必要な点**: エミュレータか、デプロイ後の実リソースへの契約テストか。

**推奨**: **デプロイ後の実リソースに対する契約テスト**を
`deploy-functions.yml` の後段に足す。

Cosmos DB Emulator は Linux コンテナ版があるが、起動に時間がかかり
CI のフィードバックを遅くする。単体テストの速さを守る方が、
原則1の「迅速なフィードバック」に沿う。

最小限、次の3つを見れば今空いている穴は埋まる。

- `GET /api/plants` のレスポンスに `description` / `updatedAt` /
  `scientificName` が**含まれない**こと（射影が効いている）
- `GET /api/plants` が `createdAt` の降順であること
- `GET /api/plants/check-duplicate` が別名の植物を拾わないこと

実データを作って消す必要があるため、本番とは別のテスト用コンテナか、
テスト用 ID の接頭辞で後片付けする仕組みが要る。ここが設計のポイント。

### `CosmosService.getPlantByName()` が未使用

`api/src/services/cosmosService.ts:55-65`。`src/` 全体と `mobile/lib` を検索しても
参照は定義のみで、呼び出し元が存在しない。`checkDuplicateByName()` と機能が重複している。

`cosmosService.test.ts` のテスト2件がこのデッドコードを守っている状態。
削除するならテストも同時に落とす。

**判断が必要な点**: 削除してよいか。

**推奨**: **削除する。** `checkDuplicateByName()` が同じ役割を果たしており、
こちらは `GET /api/plants/check-duplicate` から実際に使われている。
2つあると、どちらを使うべきかの判断を読み手に押しつける。
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

**判断が必要な点**: 削除してよいか。

**推奨**: **削除する。** 本文の理由に加えて、
`deleteImage()` が 404 を正常扱いするため「存在確認してから削除」のパターンが
そもそも不要になっている。死蔵コード3件（これ、`getPlantByName()`、
`ApiService.uploadImage()`）は1つのコミットでまとめて落とすのが見通しがよい。

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
`new URL()` がパースできる文字列はすべて通過する点にも注意。

**判断が必要な点**: メッセージを分けるか、エラーの型を分けるか。

**推奨**: **分岐ごとに固有のメッセージを付ける。**
`catch (error: any)` という既存の慣習（api 側で20箇所）を保てて、
変更が `moveFromTempToPermanent()` の内側に収まる。

エラー型を導入すると、各ハンドラのエラー整形（`utils/response.ts` 経由の
`ErrorCode` への対応づけ）まで波及する。それ自体は設計として筋がよいが、
今の問題（テストが分岐を区別できない）を解くには過剰。

なおテスト側は既に全文一致（`/^...$/`）のアサーションに直してあるため、
偽陰性は解消済み。これは**可読性と診断性の改善**であって、
退行検出の穴を埋める作業ではない。優先度は低い。

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

**判断が必要な点**: 上限値をいくつにするか。

**推奨**: **500 文字。** 環境変数 `CONTEXT_INFO_MAX_LENGTH` で上書きできる形にして、
`PLANT_VALIDATION` と同じ流儀（エラーメッセージも同じ定数から文字数を埋め込む）に揃える。

**既存リクエストを弾く心配は実質ない。** `mobile/lib/screens/camera_screen.dart:446`
の入力欄が既に `maxLength: 500` を強制しているため、アプリからは
500 文字を超える `contextInfo` を送れない。文書化されていた意図とも一致する。

つまりこれは「クライアントだけが守っている制約を、サーバ側にも入れる」作業。
API は Function Key を持てば直接叩けるので、サーバ側で守る価値がある
（プロンプトに直接埋め込まれ、ログに全文が出る経路なので、
トークン消費とログ量の両方に効く）。

### `streamToBuffer` のエラー経路が未カバー

`api/src/services/storageService.ts` の `streamToBuffer()` は
`stream.on('error', reject)` でストリームのエラーを拾っているが、この経路のテストがない。

テストの偽物バックエンドは `download()` の時点で例外を投げるため、
**ストリームを返したあとにエラーが起きる経路に到達できない**。
`'error'` のリスナーを落とすと `moveFromTempToPermanent()` が
永久に待ち続けるが、テストは緑のまま。

対応するなら、偽物バックエンドのエントリに「エラーを発火するストリームを返す」
フラグを追加する（現在の `failWith` は `download()` 自体を失敗させるもので、別物）。
