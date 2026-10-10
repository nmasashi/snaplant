# バックログ

実装されていない機能・既知の課題を記録する。対応したらこのファイルから該当項目を削除する。

運用方針: 仕様書（`06_api_design.md` / `06_api_openapi.yaml` など）には**実装済みのものだけ**を書く。
未実装のものをここに置くことで、仕様書を「実装の正確な写し」として信頼できる状態に保つ。

各項目の**「判断が必要な点」と「推奨」は Claude が付けた意見**であり、検証済みの事実ではない。
このファイルの他の記述（実在する課題・実測値）とは性質が違うので混ぜないこと。
採否は人間が決め、決めたら推奨の節は消して結論を本文に書く。

---

## Windows 側で行う作業

**WSL から `flutter analyze` / `flutter test` は実行できない**（CLAUDE.md 参照）。
Dart に触る作業はここに集める。Windows 側でセッションを1回立てて**まとめて処理する**。

散らばった項目を探し直さずに済むようにするための索引で、詳細は各項目にある。
**ここに書くのは Dart の変更が必要なものだけ。**

| 項目 | 判断 | 内容 |
|---|---|---|
| [Flutter 側のテストがほぼ無い](#flutter-側のテストがほぼ無い) | **決定済み** | その場で書く。WSL で書き溜めない |
| [`ApiService.uploadImage()` が未使用](#apiserviceuploadimage-が未使用) | **決定済み** | 削除する |
| [409 を英文のまま表示](#flutter-が-409-を英文のまま表示しリトライから回復できない) | **決定済み** | `ApiException` に封筒を読ませ、409 を成功相当に扱う |
| [`api_response.dart` の型不一致](#api_responsedart-の型がサーバの封筒と合っていない) | **決定済み** | 上と同時に、封筒に合わせて書き直す |
| [Web 経路が MIME を無視](#web-経路が実際の-mime-を無視して-imagejpeg-を送る) | **判断待ち** | 実データから MIME を判定するか |

### 最初にやること

```powershell
cd mobile
flutter pub get      # pubspec.lock はコミット済みだが .dart_tool/ は無いので必要
flutter analyze      # 着手前の状態を確認する（既存の指摘があるかを先に見る）
flutter test         # 現状は test/widget_test.dart の1本だけ
```

**読む順序**。上記の項目はほぼ `ApiService` とその戻り値の型に集中している。

| 順 | ファイル | 見るところ |
|---|---|---|
| 1 | `mobile/lib/services/api_service.dart` | `_parseResponse()` と `_buildUrl()`。下記の項目の大半がここ |
| 2 | `mobile/lib/models/api_response.dart` | サーバの封筒 `{ success, data }` との対応 |
| 3 | `docs/06_api_openapi.yaml` | 封筒の内側のキーがエンドポイントごとに違う（CLAUDE.md に一覧がある） |
| 4 | `mobile/test/widget_test.dart` | 既存テストの書き方。テストは1本しかないので慣習はここから読めない |

**先に CLAUDE.md の「クライアント実装で踏みやすい罠」節を読むこと。**
`_parseResponse()` がボディ全体を渡すため各メソッドが自分で `json['data']` を
剥がす必要があり、過去に `identifyPlant()` と `uploadImage()` で実際に踏んでいる。

`dev_dependencies` は `flutter_test` と `flutter_lints` だけ。テスト専用の
補助パッケージ（mocktail などのモック生成）は入っていない。
HTTP をモックする必要が出たら `http` の `MockClient`（`package:http/testing.dart`、
`http` に同梱なので追加不要）を使う。新しい依存を増やす前に
CLAUDE.md の「`provider` / `go_router` / `dio` / `uuid` / `intl` は使用実績ゼロ、
使い始める前に方針を決める」を確認すること。

**進め方**: テストを書いてから実装する順序は維持する。赤緑の確認が
Windows 側に移るだけ（CLAUDE.md の TDD の節）。
`ApiService` の改修とテストの新規作成が同じセッションに入るので、
**テストを先に書いて赤を確認してから改修する**こと。

CI に `flutter analyze` を入れるかは
[Flutter と Terraform が CI の対象外](#flutter-が-ci-の対象外)にある。
`mobile/` のアーキテクチャ方針が未決定の間は入れない判断になっている。

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

**判断: 後回し。ただし方針は確定**（人間がトリアージ済み）。

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

**判断: 優先度低として残す。ゲートウェイ化の一部として将来対応**（人間がトリアージ済み）。

自前実装ではなくゲートウェイ側の機能として入る前提。単独で実装しない理由は3つ。

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

**判断: Windows 側で `flutter test` を回せるセッションを1回取り、その場で書く**（人間がトリアージ済み）。

WSL セッションで先に書き溜めておくことは意図的に避けた。赤も緑も確認できないまま
Dart のテストを置いていくと、構文エラー1つで「テストがある」という誤った信号だけが残る。
CLAUDE.md が「実行していないものを実行したように書かない」と定めている趣旨からも、
未検証のテストを成果物として置くのは筋が悪い。

優先して書く対象は `ApiService` のレスポンス封筒の解釈。
`_parseResponse()` がボディ全体をコールバックに渡すため各メソッドが
自分で `json['data']` を剥がす必要があり、過去に `identifyPlant()` と
`uploadImage()` で実際に不整合が起きている。封筒の内側のキーが
エンドポイントごとに違う点（CLAUDE.md の表）も、テストで固定する価値が高い。

### Flutter が CI の対象外

`terraform fmt -check` と `terraform validate` は
`.github/workflows/terraform.yml` として追加済み。残るのは Flutter。

`flutter analyze` と `flutter test` は自動実行されていない。
現状、Dart コードの変更は誰も自動で検証していない。
WSL から実行できないため、人間が Windows 側で回すまで検証されない状態。

**判断: 後回し**（人間がトリアージ済み）。

`mobile/` のアーキテクチャ方針が未決定（`provider` / `go_router` / `dio` が
`pubspec.yaml` にあるのに使用実績ゼロ）な状態で `flutter analyze` を
必須化すると、方針を決める作業が CI に阻まれる可能性がある。
先に方針を決める方が順序として自然。

入れるときは `subosito/flutter-action` を使う。

**実測（2026-10-10、Windows 側で確認）**: 現状の `flutter analyze` は
**エラー0件、info / warning 141件、終了コード1**。この141件は
`origin/main` と**完全に同一**で、PR #1 の変更による新規の指摘は無い。

つまり `flutter analyze` を素朴に CI へ入れると、**既存の141件で初日から落ちる**。
入れるときは次のどちらかが必要。

- 先に141件を解消する（アーキテクチャ方針の決定と重なる作業）
- `--no-fatal-infos` / `--no-fatal-warnings` で当面エラーのみを失敗条件にする

`flutter test` は通る（スモークテスト1本のみ）。

### `ApiService.uploadImage()` が未使用

`mobile/lib/services/api_service.dart` の `uploadImage()` は
「従来版・互換性のため残存」とあるが、呼び出し元が存在しない。
呼び出すエンドポイントは `uploadAndIdentifyImage()` と同じ `/api/images/upload` で、
AI 識別も走るため「単純アップロード」という元の意味は既に失われている。削除候補。

さらに `contract-auditor` の監査で、**このメソッドは呼ばれても必ず失敗する**ことが
判明した。`MultipartFile.fromBytes/fromPath` に `contentType` を渡していないため
`application/octet-stream` になり、`upload.ts` の `isValidImageContentType()` で
415 `UNSUPPORTED_MEDIA_TYPE` になる。`uploadAndIdentifyImage()` は正しく渡している。

**判断: 削除する**（人間がトリアージ済み）。名前が「単純アップロード」を約束しているのに
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

導入するとしたら「ローカルにエミュレータを揃えるか」という文脈でまとめて判断したい。
同じ文脈の Cosmos DB Emulator / E2E は却下済み
（`10_proposals.md` の「Cosmos の SQL を検証する層を作る」）。

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

**判断: クライアント側を直す**（人間がトリアージ済み）。サーバは意図どおり
（`id` を返さない設計の根拠は 491c855 に記録済み）。最小の修正は次の2つ。

1. `ApiException` にサーバの `error.code` / `error.message` を持たせる
2. `savePlant()` が 409 `IMAGE_ALREADY_SAVED` のときは「この画像は既に
   保存されています」を表示して一覧へ戻す（成功相当に扱う）

仕様どおり「既存レコードを `GET /api/plants` から探す」までやるかは設計判断。

Dart の変更なので WSL では検証できない。
[Flutter 側のテスト](#flutter-側のテストがほぼ無い)と同じセッションで扱う。
`ApiException` に封筒を読ませる改修は、下記
[`api_response.dart` の型がサーバの封筒と合っていない](#api_responsedart-の型がサーバの封筒と合っていない)
と同時にやるのが自然。

**あわせて検討すること（contract-auditor の監査で判明）**:
`userMessage` は `case 500: case 502: case 503:` を1つにまとめており、
**502 と 503 を区別していない**。サーバ側は意味を分けている
（502 = 上流に到達したがエラー応答、503 = 到達できない）ので、
封筒を読ませる改修のついでにメッセージを分けるかを決めたい。
503 は時間を置けば回復しうるので「しばらく待って再試行」、
502 は再試行しても同じ結果になりやすい。
`isServerError`（`api_service.dart`）がどこからも使われていない点と、
`userMessage` の `case 429` に対応するステータスがサーバに存在しない点
（レート制限は未実装）も、同じ関数を触るついでに片付けられる。

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

**判断: 書き直す**（人間がトリアージ済み）。上記
[Flutter が 409 を英文のまま表示する](#flutter-が-409-を英文のまま表示しリトライから回復できない)
の対応で「`error.code` を読む」経路を作るので、そのときに正しい形に直して使うのが自然。
使われていないからといって削除すると、同じものを書き直すことになる。

### UUID の生成方法が2つある

`CosmosService.generateId()` は `uuid` パッケージを使わず、
`Math.random()` を使った自前実装になっている。

```typescript
return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
  const r = Math.random() * 16 | 0;
  ...
```

一方 `StorageService.generateUniqueFileName()` は `uuid` パッケージの
`v4()` を使う。**同じリポジトリ内で UUID の生成方法が2つある。**

`save.ts` も以前は `uuidv4()` を使っていたが、`createPlant()` が
スプレッドの前で `generateId()` を呼ぶため常に捨てられていた。つまり
**`uuid` パッケージは植物の id 生成に一度も使われていなかった**
（この二重生成は解消済み）。

**機能上の問題はない。** `Math.random()` は暗号学的に安全ではないが、
この id は `GET /api/plants` で全件返るため秘密ではなく、推測されても
害がない（アクセス制御は Function Key）。

**判断が必要な点**: `uuid` パッケージに統一するか。

**推奨**: **統一する。** 依存として既に入っていて `StorageService` が
使っているので、追加コストはない。生成方法が2つあると「どちらを使うべきか」
の判断を読み手に押しつける。

`generateId()` を `uuidv4()` の呼び出しに置き換えるだけで、
テストは形式を検証しているため期待値を変える必要もない
（`uuid` も v4 を生成するので同じ形になる）。

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

### `wrapError()` の適用5箇所のうち3箇所が無検証

`api/src/utils/errors.ts` の `wrapError()` は5箇所で使われているが、
**退行テストが付いているのは1箇所だけ**（`uploadImageToTemp`）。
test-reviewer が変異で確認した。

| 箇所 | `new Error` に戻したときの結果 |
|---|---|
| `storageService.ts` の `uploadImageToTemp` | **赤1件**（守られている） |
| `storageService.ts` の `moveFromTempToPermanent` | **緑**（無検証） |
| `storageService.ts` の `deleteImage` | **緑**（無検証） |
| `storageService.ts` の SAS URL 生成 | **緑**（無検証） |
| `openAIVisionService.ts` の `identifyPlant` | 下記の別項目を参照 |

つまり `upload` の**移動失敗・削除失敗・SAS 生成失敗**の 503 分類は
現在ノーガードで、`code` の引き継ぎをやめても気づけない。

**なぜ今テストを足さなかったか**: 偽物の `forcedUploadError` は
バックエンド全体に効くため、「一時保存は成功させて永続保存への移動だけ
失敗させる」という条件が作れない。`tests/fakes/blob.ts` に
コンテナ単位（あるいは呼び出し回数単位）の失敗注入を足す必要がある。

**判断が必要な点**: 偽物に失敗注入の仕組みを足すか。

**推奨**: **足す。** `forcedUploadErrorByContainer` のような
コンテナ名をキーにした失敗注入が素直で、既存の `failWith`（Blob 単位）と
同じ発想。移動処理は「一時から読んで永続へ書き、一時を消す」の3手で
宛先を取り違える余地があり、守る価値が高い。

### `identify` の 503 分岐が実運用で到達しない

`api/src/functions/identify.ts` のネットワークエラー分岐
（503 / `AI_SERVICE_ERROR` / `植物識別サービスに接続できません`）は
**OpenAI 経路では発火しない。**

**実測したチェーン**（openai 7.x / Node 20+ の native fetch。
実際に名前解決できないホストへ接続して確認、2026-10-10）:

```
深さ0  APIConnectionError      code=undefined   "Connection error."
深さ1  TypeError               code=undefined   "fetch failed"
深さ2  Error                   code="ENOTFOUND"
```

`APIConnectionError` は自分では `code` を設定しない
（`super(undefined, undefined, 'Connection error.', undefined)` を呼び、
`APIError` が `this.code = data?.['code']` とするため）。
さらに undici の `fetch` が `TypeError: fetch failed` を1枚挟むため、
**errno は2段奥にある**。`wrapError()` は `cause.code` しか見ないので undefined のまま。

**実行時の症状**: Azure OpenAI のホスト名が解決できないとき
`POST /api/plants/identify` は 503 ではなく **500 `INTERNAL_ERROR`**
（`details: "植物識別に失敗しました: Connection error."`）を返す。
メッセージに `OpenAI` も `LLM` も含まないため 502 にも落ちない。
クライアントは 500/502/503 を同じ扱いにするのでユーザー向けの表示は
変わらないが、監視と再試行判断の精度が落ちる。

対照的に **`upload` の Storage 経路の 503 は確実に到達する**。Azure の transport は
`RestError` に `code: err.code ?? ...` で errno を**直接**載せるため
（`@typespec/ts-http-runtime` の `nodeHttpClient.js`）、`wrapError()` が引き継ぐ。
**つまり 54ae670 の修正が効いているのは Storage 経路だけ。**

**一度 revert した経緯**: `6c4bbda` で `cause?.code ?? cause?.cause?.code` と
一段だけ辿る修正を入れたが、上記のとおり errno は2段奥なので**本番では効かなかった**。
テストが通ったのは `cause` を1段だけ持つ、**実SDKが作らない形**で検証していたため。
クラウドレビューの指摘を受けて実測し、revert した。

**判断が必要な点**: サーバを直すか、分岐を削るか。

**推奨**: **サーバを直す。** ただし下記2点を**同時に**満たすこと。

1. **`cause` チェーンを深さ上限付きで辿る。** 一段では足りない。
   循環参照の保護も入れる（`Error.cause` は任意のオブジェクトを取れる）
2. **`upload.ts` の分類も同時に直す。** ここが落とし穴で、
   1だけ直すと `upload` 経路で **OpenAI の障害が `STORAGE_ERROR`（503）として
   報告される**。`upload.ts` の catch は「ネットワークエラー」分岐
   （`STORAGE_ERROR`）をメッセージによる `Storage` 判定より先に評価し、
   かつ包み直したメッセージ（`植物識別に失敗しました: Connection error.`）は
   `includes('OpenAI')` にも `includes('LLM')` にも当たらないため、
   AI 由来の障害が Storage 由来として分類される。
   監視やアラートが `ErrorCode` を見ている場合、**Storage を調べに行かせてしまう**

2の対策は、AI 由来かどうかを判定してから接続障害かを見る二段構えにするか、
`upload.ts` の AI 呼び出し部分を独立した `try`/`catch` に分けて
文字列判定そのものをやめるか。後者の方が堅いが変更範囲は広い。

仕様書（`06_api_openapi.yaml` / `06_api_design.md`）は分岐が実装されている
前提で 503 を記載している。実装を直せば記述も正しくなる。
**分岐を削る選択を採る場合は仕様書の 503 の記載も消すこと。**

### 接続障害の判定が8箇所に複製されている

`error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED'` が
`checkDuplicate.ts:60` / `plantDetail.ts:54` / `plantDetail.ts:107` /
`identify.ts:91` / `updatePlant.ts:85` / `plants.ts:35` / `save.ts:83` の7箇所、
`upload.ts:156` は `ETIMEDOUT` を足した3code版で、**合計8箇所**にある。

手で写しているので**既にずれている**（上記「`ETIMEDOUT` を 503 に分類するのは
`upload` だけ」がその結果）。

**推奨**: `utils/errors.ts` の `wrapError()` の隣に
`isConnectivityError(error)` を切り出し、8箇所すべてから呼ぶ。
`ETIMEDOUT` の追加と `identify` の 503 の修正は同じ述語に触るので、
**3件まとめて1つの作業単位にするのが効率的**。

### `ETIMEDOUT` を 503 に分類するのは `upload` だけ

接続障害の分類が `upload` と他6ハンドラで1つずれている。

| ハンドラ | 503 に分類する `code` |
|---|---|
| `upload` | `ENOTFOUND` / `ECONNREFUSED` / **`ETIMEDOUT`** |
| `save` / `plants` / `updatePlant` / `plantDetail`（2箇所） / `checkDuplicate` / `identify` | `ENOTFOUND` / `ECONNREFUSED` のみ |

**実行時の症状**: Cosmos DB への接続がタイムアウトした場合、
`GET /api/plants` 等は 503 ではなく 500 `INTERNAL_ERROR` を返す。
タイムアウトは時間を置けば回復しうる障害なので、クライアントの
再試行判断を誤らせる（54ae670 で `ENOTFOUND` について直したのと同じ型の問題）。

**判断が必要な点**: 6ハンドラに `ETIMEDOUT` を足すか。

**推奨**: **足す。** タイムアウトは「到達できていない」側なので 503 が適切で、
7ハンドラが同じ集合を見ているのが素直。`upload` だけが正しい状態になっている。

**今回のセッションで実装しなかった理由**: 6エンドポイントのステータスコードが
変わる契約変更であり、`ENOTFOUND` の件（バックログ項目として既に
人間がトリアージ済みだったもの）とは違って新しく出てきた判断である。
このリポジトリの TDD の規律（1サイクルで赤にするテストは1つだけ）に従うと
6サイクルに分かれる作業量でもある。

**着手時の手順**: 各ハンドラの既存の「DB接続エラーの場合は503エラー」テストを
`it.each(['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT'])` に広げる形が素直
（`upload.test.ts` に先行例がある）。実装後は仕様書の記述も更新すること
（`06_api_openapi.yaml` の `StorageUnavailable` に「`ETIMEDOUT` を見るのは
upload だけ」と明記してあり、`06_api_design.md` のエラーコード表も該当する）。

### `plantDetail` の 503 分岐2箇所にテストが無い

`api/src/functions/plantDetail.ts` は GET と DELETE で別々に
`ENOTFOUND` / `ECONNREFUSED` の 503 分岐を持つが、
`tests/functions/plantDetail.test.ts` に 503 を期待するテストが1件も無い
（他の5ハンドラにはある）。

偽物は `forcedReadError` / `forcedDeleteError` を既に持っているので、
`code` を設定したエラーを入れるだけで書ける。上記の `ETIMEDOUT` の作業と
同じ箇所を触るため、**まとめてやるのが効率的**。

### `upload` の AI 判定がメッセージ文字列依存で分類順の先頭にある

`api/src/functions/upload.ts` の catch は
`error.message.includes('OpenAI') || error.message.includes('LLM')` を
最初に評価する。そのため `code === 'ENOTFOUND'` を持つエラーでも、
メッセージに `LLM` / `OpenAI` が含まれていれば 502 `AI_SERVICE_ERROR` が勝つ。

現状 `StorageService` の包み直しメッセージは日本語で `Storage` も `LLM` も
含まないため**実害は観測できない**。ただし将来メッセージを変えると
分類が静かに入れ替わる脆さがある。

**判断が必要な点**: 分類を文字列から型・`code` に寄せるか。

**推奨**: **当面そのまま。** 実害が書けない以上、優先度は低い。
`identify` の `code` 問題（上記）を直すときに、エラー分類の方式そのものを
見直す文脈でまとめて扱うのが筋。

### テストの軽微な改善（優先度低）

test-reviewer が指摘した、原則違反ではないが締められる点。

- **`openAIVisionService.test.ts` の `.rejects.toThrow('植物識別に失敗しました')`
  が前方一致。** catch が全例外を同じ接頭辞で包むため、**別の原因で落ちても通る**。
  `storageService.test.ts` は `/^…$/` でアンカーしており、そちらに揃えるのが素直
- **`FakeCosmosBackend<TDoc>` は止めたい方向を型で止められていない。**
  `FakeCosmosBackend<PlantSummary>` に完全な `Plant` を入れても通る（構造的部分型）。
  現状はテスト側が `const x: PlantSummary[] = [...]` とリテラルで宣言している
  規律に依存している。射影と完全な `Plant` の両方を扱う `cosmosService.test.ts` が
  既定の union を使っているため、**区別が最も必要なファイルで区別が消えている**
- **`cosmosService.test.ts` の検索語が常に「存在する側」。** `@name` に固定値を
  渡す変異を入れてもサービス層のテストは緑で、ハンドラ側のテストだけが捕まえる。
  片方の検索語を2件目の文書にすると変異が赤になる
- **`upload.test.ts` が設定する `OPENAI_API_KEY` は死蔵。**
  `openAIVisionService.ts` は `AZURE_OPENAI_ENDPOINT` の有無で分岐し、
  それは `tests/setup.ts` のグローバル値が立ったまま。
  他ファイルが徹底している「`setup.ts` に暗黙依存しない」方針と不整合

### contextInfo の文字数の数え方がクライアントとサーバで違う

`mobile/lib/screens/camera_screen.dart:446` の `maxLength: 500` は書記素クラスタ単位、
`api/src/functions/upload.ts` と `identify.ts` の検証は JavaScript の
`String.length`（UTF-16 コードユニット）単位。

絵文字やサロゲートペアを含む入力は、UI が許した 500 文字でもサーバ側で
500 を超えて 400 になる。通常の日本語テキストでは発生しない。

**判断: 当面は許容する**（人間がトリアージ済み）。合わせるならサーバ側を
`[...str].length` にする方が利用者の直感に近いが、現行実装も妥当。
補足情報は自由記述のヒントであり、境界ちょうどの入力が実務で問題になりにくい。
