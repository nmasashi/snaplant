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

さらに `contract-auditor` の監査で、**このメソッドは呼ばれても必ず失敗する**ことが
判明した。`MultipartFile.fromBytes/fromPath` に `contentType` を渡していないため
`application/octet-stream` になり、`upload.ts` の `isValidImageContentType()` で
415 `UNSUPPORTED_MEDIA_TYPE` になる。`uploadAndIdentifyImage()` は正しく渡している。

**推奨**: **削除する。** 名前が「単純アップロード」を約束しているのに
実際は AI 識別が走って課金されるため、残すほど誤用の危険がある。
加えて動かないコードでもある。
`uploadAndIdentifyImage()` が同じエンドポイントを正しい名前で叩いている。

Dart なので削除後に Windows 側で `flutter analyze` が必要。
上記「Flutter 側のテストがほぼ無い」と同じセッションでまとめて処理するのが効率的。

### Azurite などパス形式のエンドポイントに対応していない

`StorageService` のコンストラクタは、接続文字列に `BlobEndpoint=` があれば
**例外を投げて起動を止める**（未対応として明示）。

対応していない理由は、パス形式のエンドポイントだと URL の形が変わること。

```
標準:     https://account.blob.core.windows.net/images/abc.jpg
Azurite:  http://127.0.0.1:10000/devstoreaccount1/images/abc.jpg
                                 ^^^^^^^^^^^^^^^^ アカウント名がパスに入る
```

`isValidImagePath()` は「パスがちょうど `/<コンテナ>/<Blob名>` の2セグメント」を
要求するため、3セグメントになるパス形式と衝突する。あわせて `https:` のみを
許可しているが Azurite は `http://` を使う。

対応するなら「ベースパス + コンテナ + Blob名」の形へ検証を書き直し、
スキームの扱いも見直す必要がある。

**判断が必要な点**: ローカル開発に Azurite を導入するか。

**推奨**: **当面は導入しない。** 現状 `.env.example` も実 Azure の接続文字列で、
ローカル開発は実リソースに対して行う運用になっている。
Azurite を導入すると「本番と同じ検証ロジックが通らない」という状態を
意図的に作ることになり、検証を緩める圧力がかかる。

導入するとしたら、[Cosmos の SQL を検証する層](#cosmos-の-sql-を検証する層がない)と
同じ「ローカルにエミュレータを揃えるか」という文脈でまとめて判断したい。

### Flutter が 409 を英文のまま表示し、リトライから回復できない

`mobile/lib/services/api_service.dart` の `_parseResponse()` は、非 2xx で
**封筒を一切読まない**。

```dart
throw ApiException(
  statusCode: response.statusCode,
  message: 'API request failed',   // 固定の英文
  body: response.body,              // 封筒は文字列として保持するだけ
);
```

`ApiException.userMessage` の `switch` は 0 / 401 / 404 / 429 / 500 / 502 / 503 だけを
扱い、**409 は `default` に落ちて `message` をそのまま返す**。
`identification_screen.dart` の `_savePlant()` の catch は `e.userMessage` を
スナックバーに出す。

**実行時にどうなるか**: 保存に成功したがレスポンスが届かず、ユーザーが
もう一度「保存」を押すと、**赤いスナックバーに英語の `API request failed` が出る**。
保存自体は成功しているのに失敗したように見え、ユーザーは同じ操作を繰り返す
（毎回409）。`Navigator.pop(context, true)` に到達しないため一覧へ戻らず、
「既に図鑑にある」ことにも気づけない。

409 は以前も Cosmos の制約エラーで起こり得たが稀だった。
**491c855 で `save` が重複を 409 で拒むようにしたため、到達頻度が大きく上がった。**
既存の穴だが、実質的には今回の変更が招いた問題として扱うべき。

**判断が必要な点**: どこまで直すか。

**推奨**: **クライアント側を直す。** サーバは意図どおり（`id` を返さない設計の
根拠は 491c855 に記録済み）。最小の修正は次の2つ。

1. `ApiException` にサーバの `error.code` / `error.message` を持たせる
2. `savePlant()` が 409 `IMAGE_ALREADY_SAVED` のときは「この画像は既に
   保存されています」を表示して一覧へ戻す（成功相当に扱う）

仕様どおり「既存レコードを `GET /api/plants` から探す」までやるかは設計判断。

Dart の変更なので WSL では検証できない。
[Flutter 側のテスト](#flutter-側のテストがほぼ無い)と同じセッションで扱う。
`ApiException` に封筒を読ませる改修は、下記
[`api_response.dart` の型がサーバの封筒と合っていない](#api_responsedart-の型がサーバの封筒と合っていない)
と同時にやるのが自然。

### `save` の重複チェックは read-then-write で同時リクエストに効かない

`api/src/functions/save.ts` は `getPlantByImagePath()` でクエリしてから
`createPlant()` するだけで、トランザクションも一意制約もない。

同じ `imagePath` の `save` が**ほぼ同時に**2件届くと両方が通り、重複レコードが
できる（その後どちらかを削除・更新すると他方の画像が消えるという元の不具合が残る）。

**491c855 のコミットメッセージに「入口で一意性を保証する」と書いたが、
これは言い過ぎだった。** 逐次のリトライには有効だが、並行リクエストには
当てはまらない。

Terraform の `azurerm_cosmosdb_sql_container.plants` に `unique_key` ブロックは無い。
あっても Cosmos の一意キーは**パーティション内でしか効かない**ため、
パーティションキーが `/id` の現構成では `imagePath` の一意制約を張れない。

**判断が必要な点**: 対処するか。

**推奨**: **当面は現状のまま。** モバイルの手動リトライには時間差があるため
実害が小さい。根本解決にはパーティションキーの変更という設計変更が必要で、
得られるものに対してコストが大きい。

### `api_response.dart` の型がサーバの封筒と合っていない

`mobile/lib/models/api_response.dart` の `ApiError.fromJson` は
`detail`（サーバは `details`）と `statusCode`（サーバはボディに含めない）を
必須で読む。`ApiResponse.fromJson` は `json['error'] as String?` と、
エラーをオブジェクトではなく**文字列**として扱う。

サーバの封筒は `{ success, error: { code, message, details? } }`。

`lib` / `test` 配下に参照箇所が1つも無いため**現時点では何も起きない。**
使い始めた瞬間に `statusCode` の null キャストで例外になる。

**判断が必要な点**: 削除するか、書き直すか。

**推奨**: **書き直す。** 上記
[Flutter が 409 を英文のまま表示する](#flutter-が-409-を英文のまま表示しリトライから回復できない)
の対応で「`error.code` を読む」経路を作るので、そのときに正しい形に直して使うのが自然。
使われていないからといって削除すると、同じものを書き直すことになる。

### Web 経路が実際の MIME を無視して image/jpeg を送る

`mobile/lib/services/api_service.dart:133-140` の Web 経路は、画像の実データに
関係なく `contentType: MediaType('image', 'jpeg')` と
`filename: 'plant_image.jpg'` を固定で送る。

**Blob 名の拡張子と Blob の Content-Type は、この送られた Content-Type から
決まる**（3bcabf8 以降）。そのため Web で PNG を選んでも、永続コンテナには
「中身が PNG で名前と Content-Type が JPEG」の Blob が入る。

変更前もファイル名由来で `.jpg` になっていたため退行ではないが、
Content-Type が拡張子の決定要因に昇格した分だけ影響が明確になった。
表示は多くの環境で成功するため気づきにくい。

**判断が必要な点**: クライアント側を直すか、サーバ側で実データから判定するか。

**推奨**: **クライアント側を直す。** Web でも実データから MIME を判定して送る。
サーバは「検証済みの Content-Type を信頼する」設計で一貫しており、
ここを崩すと `#10` で塞いだ「クライアント由来の文字列を Blob 名に入れない」
という性質が戻ってしまう。

Dart の変更なので WSL では `flutter analyze` を実行できない。
[Flutter 側のテスト](#flutter-側のテストがほぼ無い)と同じセッションで扱う。

### contextInfo の文字数の数え方がクライアントとサーバで違う

`mobile/lib/screens/camera_screen.dart:446` の `maxLength: 500` は書記素クラスタ単位、
`api/src/functions/upload.ts` と `identify.ts` の検証は JavaScript の
`String.length`（UTF-16 コードユニット）単位。

絵文字やサロゲートペアを含む入力は、UI が許した 500 文字でもサーバ側で
500 を超えて 400 になる。通常の日本語テキストでは発生しない。

**判断が必要な点**: 揃えるか、許容するか。

**推奨**: **優先度低。当面は許容する。** 合わせるならサーバ側を
`[...str].length` にする方が利用者の直感に近いが、現行実装も妥当。
補足情報は自由記述のヒントであり、境界ちょうどの入力が実務で問題になりにくい。

### 使われていないエラーコード `UNAUTHORIZED` / `INVALID_API_KEY`

`api/src/types/api.ts` の `ErrorCode.UNAUTHORIZED` と
`ErrorCode.INVALID_API_KEY`、および `HttpStatusCode.UNAUTHORIZED` は
アプリコードからの生成箇所がゼロ。

401 は Azure Functions のランタイムが返すため、このアプリの
`{ success, error }` 封筒の形にならない。つまり**構造的に使われない**。

**判断が必要な点**: 残すか削除するか。

**推奨**: **コメントを添えて残す。** 「401 はランタイムが返すため
この enum は使われない」と書く。削除しても契約は変わらないが、
仕様書側には 401 の説明（ランタイム挙動として）があるため、
型定義だけ消すと対応関係が追えなくなる。

### `save` ハンドラと `createPlant()` で id と日時の生成が二重

`api/src/functions/save.ts:36-46` が `uuidv4()` と `createdAt`/`updatedAt` を
詰めた完全な `Plant` を組み立てて `createPlant(plantData)` に渡している。

`createPlant()` 側は `{ id: this.generateId(), ...plantData, createdAt: now, updatedAt: now }`
と組み立てるため、スプレッドの順で**ハンドラ側の id が勝ち、`generateId()` の
結果は捨てられる**。日時は `createPlant()` 側が勝つ。

レスポンス形状は仕様どおりで実行時の症状はない。責務の重複として整理候補。

**判断が必要な点**: どちらに寄せるか。

**推奨**: **`createPlant()` に寄せる。** id と日時の生成はサービスの責務で、
ハンドラはリクエストの詰め替えに留めるのが自然。
`createPlant()` の引数型が `PlantCreateRequest` であることもその設計を示している。
ハンドラ側から `id` / `createdAt` / `updatedAt` を外し、`uuidv4()` の import も落とす。

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

### `StorageService.uploadImage()` が未使用

`api/src/services/storageService.ts` の `uploadImage()`（永続コンテナへ直接
アップロードするメソッド）は、`api/src` と `mobile/lib` のどこからも呼ばれていない。

`upload.ts` が使うのは `uploadImageToTemp()` → `moveFromTempToPermanent()` の経路だけ。
一時保存して AI 判定を通してから永続化する設計（CLAUDE.md の「画像アップロードが
3役を兼ねる設計」）なので、永続コンテナへ直接上げる経路は使われない。

`storageService.test.ts` のテスト数件がこのメソッドを守っている状態。
削除するならテストも同時に落とす。

**判断が必要な点**: 削除してよいか。

**推奨**: **削除する。** 使われないだけでなく、「AI 判定を通さずに永続化できる
メソッド」が公開されている状態そのものが設計意図に反する。
誰かがこれを使うと、植物でない画像が永続コンテナに入る経路ができる。

`imageExists()` と `getPlantByName()` は削除済み。
残るのはこれと [`ApiService.uploadImage()`](#apiserviceuploadimage-が未使用) の2件。
