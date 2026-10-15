# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## リポジトリ構成

3つの独立したサブプロジェクトからなるモノレポ。それぞれツールチェーンが異なる。

| ディレクトリ | 内容 | 言語/ツール |
|---|---|---|
| `api/` | Azure Functions v4 の植物識別 API | TypeScript / npm / Jest |
| `mobile/` | Flutter 製モバイルアプリ | Dart / flutter |
| `infrastructure/` | Azure リソース定義 | Terraform |
| `docs/` | 設計書・OpenAPI 仕様（日本語） | Markdown / YAML |

コメント・エラーメッセージ・コミットメッセージはすべて日本語で記述する慣習。

## 開発環境

**Windows に統一している**（2026-10-11 に WSL との併用をやめた）。Claude Code の Bash ツールは Git Bash で動く。
api・mobile・ドキュメントの作業はすべてこの作業ツリー（`C:\Users\masas\git\snaplant`）で行い、検証もここで回す。

以前は WSL 側に別のクローン（`/home/noguchi/git/snaplant`）があり、api は WSL、Flutter は Windows と分けていた。
その名残で注意すること。

- **`api/node_modules` はマシンごとに `npm ci` で作る。** WSL と共有していた時期は無く、Windows 側の
  `node_modules` は 2025-08 から更新されていなかった（TypeScript 5.8 のままで、`tsconfig` の `module: node20` を読めず全テストが落ちた）。
  `package-lock.json` が変わったら `npm ci` し直す
- **リポジトリに入っていない作業マシン専用のファイルは、WSL 側のクローンにしか無かった。**
  `infrastructure/terraform.tfstate`（と `.backup`）、`infrastructure/terraform.tfvars`、`api/local.settings.json`。
  どれも秘密情報を含むので、人間が Windows 側の同じ場所へ移す。**WSL 側のクローンを消す前に必ず移すこと**（state を失うと
  Terraform で既存の Azure リソースを管理できなくなる）
- **テキストは作業ツリーも LF にそろえている**（`.gitattributes` の `* text=auto eol=lf`、2026-10-12）。
  この PC の Git は `core.autocrlf=true` で、以前は作業ツリーが CRLF になり、ツールが LF で書いたファイルと混ざって
  バイト比較や行末の検索が `\r` に邪魔され、Git Bash ではシェルスクリプトも失敗した。新しいファイルも LF で書くこと。
  Windows 用のスクリプト（`.bat` / `.cmd` / `.ps1`）だけは CRLF。
  `.gitattributes` が入る前のブランチを取り出すと、そのブランチのファイルは CRLF に戻る

Terraform は Windows に導入済み（2026-10-11 時点で 1.16.5）。`plan` / `apply` には上記の state と `terraform.tfvars` が要る。
azurerm プロバイダは v4 で、サブスクリプション ID を環境変数 `ARM_SUBSCRIPTION_ID` で渡す
（`export ARM_SUBSCRIPTION_ID=$(az account show --query id -o tsv)`。`scripts/deploy.sh`・`destroy.sh` は自動で設定する）。

**この環境からは IPv4 か IPv6 の片方の接続が、日によって確立した直後に切られる。** HashiCorp（`registry.terraform.io`・
`releases.hashicorp.com`）にも Azure の管理 API（`management.azure.com`）にも起きる。Terraform（Go）は IPv6 を先に使い、
切られても IPv4 に切り替えない。再送しない POST（`listKeys` など）だけが `connection may have been reset` で失敗し、
`plan` / `apply` が通らない。Windows の IPv4 優先の設定（`netsh interface ipv6 set prefixpolicy ::ffff:0:0/96 60 4`）は
Terraform には効かなかった（2026-10-12）。**`infrastructurescripts	f.cmd plan` / `apply` で回す**（コマンドプロンプト・
Git Bash のどちらからでも、どこからでも可）。IPv4 で Azure と HashiCorp につながれば IPv4 だけでつなぐ中継（`tf.js`。
TLS は中身を見ずに転送する）を通し、つながらなければそのまま `terraform` を実行する。2026-10-12 の apply はこれで通した。
`terraform init` のプロバイダのダウンロードもこれで通るはずだが未確認。通らなければ次の手順。
そのときは `curl -4` で再試行しながらプロバイダの zip を落とし、公開されている `SHA256SUMS` と照合したうえで、
`<dir>/registry.terraform.io/hashicorp/<name>/terraform-provider-<name>_<ver>_windows_amd64.zip` に置いて
`terraform init -plugin-dir=<dir>` で読み込ませる。`terraform validate` は CI（`terraform.yml`）でも回る。

Windows に入っていないツール（必要になったら入れる）。

| ツール | 用途 | 無い間にできないこと |
|---|---|---|
| Azure Functions Core Tools（`func`） | api のローカル起動 | `npm start`（テストと型チェックには不要） |

## コマンド

### api/

```bash
cd api
npm ci                    # package-lock.json どおりに入れる。lock が変わったらやり直す
npm start                 # prestart で build + func extensions install を実行してから func start
npm run build             # tsc（src のみ → dist/src/ 配下に出力）
npm test
npm run test:coverage

# 単一テストの実行
npx jest tests/functions/save.test.ts
npx jest -t "植物一覧取得"

# 型チェック（tests も含める。tsconfig.json は src のみ対象）
npx tsc -p tsconfig.test.json --noEmit
```

リンターは未設定（CI も `npm run lint` が無いことを前提にスキップする）。

tsconfig が4分割されている理由：`tsconfig.base.json` が共通設定、`tsconfig.json` がビルド用（`src` のみ・emit あり）、`tsconfig.test.json` が型チェック用（`src` + `tests`・`noEmit`）、`tsconfig.editor.json` が IDE 用（両者を project references で束ねる）。Jest は `tsconfig.test.json` を使う。

### mobile/

```bash
cd mobile
flutter pub get
flutter run
flutter analyze           # flutter_lints 準拠
flutter test
flutter test test/services/api_service_test.dart
flutter build apk --release
```

Flutter SDK は `C:\Users\masas\flutter` にあり、`flutter` は PATH 上にある。
Dart を変更したら、その場で `flutter analyze` / `flutter test` を回して検証する。

**デバッグ版（`flutter run`）は別のアプリとして入る**（パッケージ名 `com.snaplant.mobile.debug`、ホーム画面の名前は「SnapPlant 開発版」。
`android/app/build.gradle` の `applicationIdSuffix`）。普段使いのリリース版（`com.snaplant.mobile`）を上書きしない。
以前は同じパッケージ名で、署名の鍵が違うと `flutter run` が古い版を黙ってアンインストールし、端末に保存した API キーなどの設定が消えた（2026-10-13）。
デバッグ版とリリース版は設定を別々に持つので、デバッグ版にも API キーの入力が要る。

`flutter analyze` の指摘は0件にしてある（2026-10-12、#24）。info も含めて1件でも出れば CI（`flutter.yml`）が失敗するので、
指摘を残したまま PR を出さない。

`test/` の構成。

| ファイル | 対象 |
|---|---|
| `services/api_service_test.dart` | `ApiService` の封筒の解釈（成功・エラー）と、送信する Content-Type（マジックバイトによる画像形式の判定を含む） |
| `screens/identification_screen_test.dart` | 保存時の 409 の扱い |
| `screens/camera_screen_test.dart` | 処理中の画面操作（選び直し・戻る）と、取り込みに失敗したときの表示 |
| `app_root_test.dart` | 設定の有無・読み込みの失敗・リセットに応じた起動直後の表示（アプリ全体を開く） |
| `screens/home_shell_test.dart` | 下のタブ（図鑑 / 旅行）の切り替えと、切り替えても一覧を読み直さないこと |
| `screens/trip_list_screen_test.dart` | 旅行一覧の表示・読み込みの失敗と読み直し、旅行の作成、旅行に属さない写真の画面（複数選択の操作と枚数の取り直しを含む）、旅行詳細から戻った後の送信の進み具合と一覧の読み直し（旅行アルバム） |
| `screens/trip_detail_screen_test.dart` | 旅行詳細の表示、編集、削除（写真を残すか消すか）、旅行が既に無いとき、写真のグリッド（ページ・失敗・読み直し）、写真の複数選択と旅行への出し入れ・削除、写真の追加と送信（EXIF、進み具合バナー、失敗と送り直し、画面をまたぐ送信）（旅行アルバム） |
| `screens/photo_thumbnail_test.dart` | 写真のサムネイルの画像を読み込めないときの表示（画像の取得まで実時間で待つので、他の画面のテストと分けている） |
| `screens/plant_detail_screen_test.dart` | 保存日時を端末の時刻で表示すること |
| `helpers/app_test_helpers.dart` | （テストではない）アプリ全体を開く `openApp`・セキュアストレージの偽物・ホストとキーを見分ける偽のサーバ `plantServer`・設定のリセットの手順 |
| `helpers/gallery_test_helpers.dart` | （テストではない）OS のギャラリーの偽物 `FakeMultiGallery`（`pickMultiImage`）・テストの画像を書き出す `writeTestImage`・1x1 の PNG とその SHA-256・EXIF（撮影日時・GPS）付きの JPEG を組み立てる `exifJpegBytes` |
| `helpers/trip_test_helpers.dart` | （テストではない）旅行の API の偽のサーバ `FakeTripBackend`（旅行を1つのリストで持ち、別の端末での変化はテストが書き換えて表す。1回だけの失敗は `failNext`、応答の保留は `holds`。写真の移動 `POST /api/photos/move` は本物と同じく 200 件の上限・空の配列・`tripId` のキーの省略を 400 で断り、写真の削除は無い写真に 404 `PHOTO_NOT_FOUND` を返す） |

テストで踏みやすい点。

- **サーバは `http` 同梱の `MockClient`（`package:http/testing.dart`）で差し替える。**
  `ApiService` はコンストラクタで `http.Client` を受け取る。応答はメソッドとパスが
  一致したときだけ返し、それ以外は 404 にする（宛先の誤りを検出するため）。
  ヘッダは `content-type: application/json` を付ける。`http` は charset の無い
  `application/json` を UTF-8 で読むが、ヘッダが無いと latin1 になり日本語が化ける。
  アプリ全体を開くテストでは `SnapPlantApp(httpClient: ...)` で差し込む（`AppRoot` が作る `ApiService` に渡る）
- **画面のテストは表示サイズを実機に合わせる。** 既定の 800×600 では
  `IdentificationScreen` の保存ボタンが画面外に出てタップが空振りする（警告だけで失敗しない）。
  `tester.view.physicalSize` / `devicePixelRatio` を設定し、`addTearDown(tester.view.reset)` で戻す
- **`tester.ensureVisible()` の後は `pump` が要る。** スクロール位置は次のフレームまで反映されない
- **`ElevatedButton.icon` は `find.widgetWithText(ElevatedButton, ...)` で見つからない。**
  実体がサブクラスで、`byType` は型の完全一致を見るため。文言で探す
- **端末の機能（OS の画像選択・セキュアストレージ）は、プラットフォーム層を偽物に差し替える。**
  `ImagePickerPlatform.instance`（`camera_screen_test.dart`）、`FlutterSecureStoragePlatform.instance`
  （`helpers/app_test_helpers.dart` の `useSecureStorage`。値だけなら `FlutterSecureStorage.setMockInitialValues`）。
  `SharedPreferences.setMockInitialValues` も使える。ただし `SettingsService` はシングルトンで、
  最初に取った `SharedPreferences` を持ち越す（テスト間でエンドポイントを変えると古い値が残りうる。
  アプリはエンドポイントの既定値を持たないので、一覧を開くテストは冒頭で `saveTestEndpoint` を呼び、テスト用の宛先（本番ではない URL）を保存する。未保存の状態は `clearSavedEndpoint`）
- **写真の送信のテストは、フェイクの時間と実時間を組み合わせる。** 送り直しの待ち（`Future.delayed`）はフェイクの時間（`tester.pump(Duration)`）で進み、
  写真の準備（`compute`）とファイルの読み込みは実時間（`tester.runAsync`）でしか進まない。待ちのタイマーが過ぎた後も、実時間の読み込みと
  `pump` を何度か往復しないと要求は偽のサーバに届かない。**実時間を一度に長く待つだけだと進まず、「まだ届いていない」を誤って確かめられてしまう**
  （早すぎる送り直しを入れる変異が生き残った）。短い実時間の待ちと `pump()` を繰り返す。「届かないこと」の確認は、変異で確かめてから信用する
- **画像（`CachedNetworkImage`）を出す画面で実時間を進めると、`path_provider` が無くて落ちる。** キャッシュがファイルの置き場を
  `path_provider` で取るため。`runAsync` を使わなければ画像の取得が始まらないので普段は通るが、写真を出した後に `runAsync` を使うテストを
  足すと無関係に見える `MissingPluginException` で落ちる。画像の取得まで待つテストは `test/screens/photo_thumbnail_test.dart` の形
  （`path_provider` を偽物に差し替える）にする
- **`pumpAndSettle` は使えないことが多い。** 読み込み中の `CircularProgressIndicator` や、
  `CachedNetworkImage` のプレースホルダー（テスト環境の HTTP は 400 を返す）が回り続けて終わらない。
  `pump` を必要な回数だけ呼ぶ。ファイルの読み書きは `tester.runAsync` の中でないと進まない
- **日時の表示のテストは、日本時間で動くことを前提にしている。** 期待値を日本時間の文字列で書き、
  テストの冒頭で `timeZoneOffset` が9時間であることを確かめる（UTC の環境で黙って通らないように）。
  CI（`flutter.yml`）は `TZ=Asia/Tokyo` で動かしている

### infrastructure/

```bash
cd infrastructure
cp terraform.tfvars.example terraform.tfvars   # openai_api_key を設定
./scripts/deploy.sh                            # terraform apply 一式
./scripts/get-publish-profile.sh               # GitHub Secrets 用の Publish Profile 取得
./scripts/destroy.sh
```

`terraform.tfstate` はローカルファイルとして存在するが、**`infrastructure/.gitignore` が `*.tfstate` を除外しているためリポジトリには入っていない**（リモートバックエンドもなし）。つまり state は作業マシンにしかない。

## アーキテクチャ

### 関数の登録経路

`api/src/app.ts` が唯一のエントリーポイント（`package.json` の `main` は `dist/src/app.js`）。各関数ファイルは末尾で `app.http(...)` を呼び、`app.ts` が全ファイルを import することで登録が走る。**新しい関数を追加したら `app.ts` に import を追記しないと一切登録されない。**

全関数は `authLevel: 'function'` なので、呼び出しには `?code={FUNCTION_KEY}` が必要。Flutter 側は `ApiService._buildUrl()` が自動で付与する。

実際のルート（`host.json` の `routePrefix: "api"` が前につく）:

| ルート | メソッド | ファイル |
|---|---|---|
| `/api/images/upload` | POST | `functions/upload.ts` |
| `/api/plants/identify` | POST | `functions/identify.ts` |
| `/api/plants/check-duplicate` | GET | `functions/checkDuplicate.ts` |
| `/api/plants/save` | POST | `functions/save.ts` |
| `/api/plants` | GET | `functions/plants.ts` |
| `/api/plants/{id}` | GET, DELETE | `functions/plantDetail.ts` |
| `/api/plants/{id}` | PUT | `functions/updatePlant.ts` |
| `/api/trips` | GET, POST | `functions/trips.ts`（旅行アルバム） |
| `/api/trips/{tripId}` | GET, PUT, DELETE | `functions/tripDetail.ts`（旅行アルバム） |
| `/api/photos` | GET, POST | `functions/photos.ts`（旅行アルバム） |
| `/api/photos/{photoId}` | GET, PATCH, DELETE | `functions/photoDetail.ts`（旅行アルバム） |
| `/api/photos/move` | POST | `functions/photoMove.ts`（旅行アルバム。`photos/{photoId}` と同じ階層のリテラルのルート） |

`plants/{id}` は `plantDetail.ts` と `updatePlant.ts` の2ファイルが別々に登録している（メソッドが異なるため共存可能）。片方だけ見て全体を判断しないこと。

### 画像アップロードが3役を兼ねる設計

`upload.ts` は単なるアップロードではなく、**一時保存 → AI 判定 → 永続化** を1リクエストで完結させる。ここがこのアプリの設計上の核心。

1. `uploadImageToTemp()` で temp コンテナに保存（SAS トークン付き URL を返す）
2. `OpenAIVisionService.validateImage()` → `identifyPlant()` で植物判定
3. 植物でなければ temp ファイルを削除し `NOT_A_PLANT` エラーを返す
4. 植物なら `moveFromTempToPermanent()` で images コンテナへ移動（公開 URL を返す）
5. 画像 URL と識別候補をまとめて返す

Blob Storage のコンテナは植物図鑑の2つで役割が違う：`images`（永続・公開 URL）と `temp-images`（一時・SAS 付き URL）。`temp-images` はライフサイクル管理で最終更新から1日を過ぎると消える。旅行アルバムの写真は `photos`（非公開。読み取りは Blob 単位の SAS で、`PhotoStorageService` が扱う）、旅行と写真のデータは Cosmos DB の `album`（`docs/travel-album/`）。コンテナ名は環境変数から取る。`'temp'` は `TEMP_STORAGE_CONTAINER_NAME` が未設定のときのコード側のフォールバック値にすぎず、Terraform が作るのは `temp-images`。`StorageService` は URL を**ホストの一致**と**パスセグメントの完全一致**で検証する。自ストレージアカウント以外のホストを指す URL は何も削除せず `false` を返す。コンテナはパスの最初のセグメントで決め、永続コンテナ名・一時コンテナ名のどちらとも完全一致しなければやはり何も削除せず `false` を返す（未知のコンテナを永続側にフォールバックさせると、永続側の同名 Blob を消せてしまうため）。文字列包含で判定していた頃は、外部ホストの URL を渡すだけで自分のコンテナの同名 Blob を消せてしまった。

**接続文字列に `BlobEndpoint=` があるとコンストラクタが例外を投げる**（未対応）。SDK はそのエンドポイントを使う一方で `StorageService` は `AccountName` と `EndpointSuffix` からホストを組み立てるため、食い違うと自分が生成した URL を自分で弾いて孤児 Blob が残る。Azurite はこの形式なので使えない。

### レスポンス規約

すべてのハンドラは `utils/response.ts` のヘルパー経由でレスポンスを作る。生の `HttpResponseInit` を手書きしない。

- 成功: `createSuccessResponse(data, statusCode?)` → `{ success: true, data }`
- 失敗: `createErrorResponse(code, message, statusCode, details?)` → `{ success: false, error: { code, message, details } }`
- 定型エラー: `createValidationError()` / `createNotFoundError()` / `createInternalError()`
- 上流（AI・Blob Storage）の失敗: `createUpstreamErrorResponse(error)`。サービスは失敗を `UpstreamError`（`utils/errors.ts`、`service: 'ai' | 'storage'`）で投げ、ハンドラは `error instanceof UpstreamError` で受けてこれに渡す。接続できない（`cause` をたどって errno を探す `hasCauseCode()`）なら 503、接続できたうえでの失敗なら 502。**メッセージの文字列で分類しない**（SDK のメッセージに `OpenAI` や `Storage` は入らない）。Cosmos DB 側のハンドラはまだトップレベルの `code` で 503 を判定している（`docs/09_backlog.md`）

`code` は `types/api.ts` の `ErrorCode` enum、ステータスは `HttpStatusCode` enum から選ぶ。新しいエラー種別が必要なら enum に追加する。

**エラー応答の契約は、ステータス・`code`・`message` まで。`details` は契約外。**（2026-10-11 に人間が決定）

| 項目 | 扱い | 理由 |
|---|---|---|
| ステータス・`code` | 契約。仕様書に書き、テストで固定する | クライアントが分岐に使う |
| `message` | 契約。仕様書に文言まで書き、テストで固定する | Flutter は 400・409 などで `message` をそのまま画面に出すので、利用者に見える |
| `details` | 契約外。仕様書に文言が載っていても参考扱いで保証しない。**テストで文言を固定しない** | 500 系では catch した例外の `message`（SDK 由来の英語など）がそのまま入り、SDK の更新で変わる。入力検証の `details` は固定文言だが、扱いを一律にするため同じく契約外とする |

`message` を変えたら仕様書（`docs/06_api_openapi.yaml`・`docs/06_api_design.md`）も変える。
`details` は付くか付かないかを確かめるのは構わないが、文言を `toEqual` で固定しない。

### Cosmos DB

パーティションキーは `/id`（Terraform で定義）。そのため単一ドキュメント操作は `container.item(id, id)` と id を2回渡す形になる。`CosmosService` は `StorageService` を内部に持つ。`updatePlant()` で `imagePath` が変わった場合のみ旧画像を Blob から削除する。`deletePlant()` も削除前に `imagePath` を読んで画像を削除する。**どちらも Blob 削除の失敗はログだけ出してドキュメント操作は成功扱いにする。**

この「`imagePath` の Blob を無条件に削除する」性質があるため、**同じ `imagePath` を持つレコードが2つあると一方の削除で他方の画像が消える**。そのため `save` と `PUT`（`updatePlant`）の**両方**が `getPlantsByImagePath()`（配列を返す）で重複を確認し、既にあれば 409 + `IMAGE_ALREADY_SAVED` を返す。`PUT` は**更新対象自身が既にその画像を持っていれば通す**（`heldBySelf`）ため、`imagePath` を変えずに他のフィールドだけ更新しても 409 にはならない。他に同じ画像のレコードが既に残っていても通す。1件だけ取って id を比べる形や「自分以外が残るか」で見る形では、既存の重複を理由に正当な更新を永久に拒んでいた（経緯は `updatePlant.ts` のコメント）。`save` 側だけ塞いでも `PUT` から同じ状態を作れるので、入口を揃えている。発生経路はリトライで、保存に成功したがレスポンスが届かず同じ `imagePath` で再送されるケース。ただし Flutter クライアントは保存の前に名前で重複確認をするため、同じ候補での再保存は `PUT` に進み、自分自身が画像を持っているので 409 にならない。クライアントから 409 になるのは、レスポンスが届かなかった後に**別の候補**で保存し直したとき。

`save` にはもう1つ別の 409 がある。Cosmos DB 自身が返す 409 を `DATABASE_ERROR` に変換するもので（`save.ts` の catch）、`imagePath` の重複とは別物。`updatePlant` はこちらを変換していないため 500 になる。

**ただしこれは read-then-write なので、ほぼ同時に届いた2件には効かない。** パーティションキーが `/id` のため Cosmos の一意キーでは `imagePath` の制約を張れず、根本解決には設計変更が必要（バックログに記録済み）。

### OpenAI 呼び出し

`openAIVisionService.ts` は Azure OpenAI と OpenAI API の両方に対応し、`AZURE_OPENAI_ENDPOINT` の有無で分岐する。Azure 側は `baseURL` にデプロイメントパスを埋め込み、`api-version` を `defaultQuery` で渡す。

Structured Outputs（`response_format: json_schema`, `strict: true`）で応答構造を強制している。strict モードの制約がコード上の設計を縛っている点に注意：

- 全プロパティを `required` に列挙する必要があるため、任意項目は `["string", "null"]` で null 許容として表現する
- `minimum` / `maximum` / `maxItems` が使えないため、信頼度の範囲は `validateAnalysisResult()` で、候補数の上限はプロンプトで担保している
- 推論モデルのため `max_completion_tokens` を使い（`max_tokens` ではない）、`temperature` は指定しない（デフォルト値のみサポート）
- トークン節約のため画像は `detail: "low"` で渡す

モデル名は `AZURE_OPENAI_DEPLOYMENT_NAME` から取り、Terraform の `azurerm_cognitive_deployment` 名と一致する必要がある（現在 `gpt-5.6-luna`、GlobalStandard SKU）。

### バリデーション定数

アップロード検証の失敗は 400 ではなく専用のステータスを返す：形式不正は 415 + `UNSUPPORTED_MEDIA_TYPE`、
サイズ超過は 413 + `FILE_TOO_LARGE`。ファイル未指定や Content-Type 不正は 400 + `INVALID_REQUEST`。

`imagePath` は `save` と `updatePlant` で `StorageService.isValidImagePath()` により**3条件すべて**を検証する。アップロード API が返した URL 以外は 400 になる。

1. スキームが `https:`
2. ホストが自ストレージアカウントの Blob エンドポイント
3. パスが**ちょうど `/<永続コンテナ名>/<Blob名>` の2セグメント**
4. **生の文字列が `https://<ホスト>/<コンテナ>/<Blob名>` と完全一致する**

4つ目が最後の関門。`new URL()` はホストの大文字小文字や先頭の空白を正規化し、クエリ文字列・フラグメント・認証情報は `pathname` に出ないため、**パース結果を見る限り正当な URL と区別できない**。保存されるのは生の文字列なので、`?x=1` を付けただけで `save` の重複チェック（文字列一致）を素通りでき、`updatePlant` の旧画像削除の判定（文字列比較）が誤作動して更新後も指している画像を消す。

4つは独立した条件にしてある。過去に「URL の一部を無視する」誤りを4回繰り返したため、1つが緩んでも他が残るようにしている。これは外部ホストの URL を保存して更新時の旧画像削除を発火させ、他レコードの Blob を消す経路を塞ぐためで、**入口（ハンドラ）と出口（`deleteImage()`）の二層で守っている**。片方だけ緩めないこと。

Blob 名の拡張子は**検証済みの Content-Type から引く**（`FILE_UPLOAD.EXTENSION_BY_CONTENT_TYPE`）。クライアントが送るファイル名からは取らない。`/` を含む名前で拡張子にパス区切りが紛れ込み、Blob 名と SAS の署名対象がずれるため。`upload` のレスポンスの `fileName` はクライアントが送った名前をそのまま返すもので、**Blob 名とは別物**。

`constants/validation.ts` の各上限値は環境変数で上書きできる（`MAX_FILE_SIZE`, `PLANT_NAME_MAX_LENGTH`, `CONTEXT_INFO_MAX_LENGTH` など）。エラーメッセージも同じ環境変数から文字数を埋め込んで生成されるため、値を変えるとメッセージも追従する。

読み取りは `positiveIntFromEnv()` を通す。**正の整数として読めない値は既定値にフォールバックする。** `parseInt` が返す `NaN` をそのまま上限値に使うと、`length > NaN` が常に false になって**上限が静かに消える**（`size <= NaN` 側は全部拒否になるので気づけるが、こちらは気づけない）。マジックナンバーをハンドラに直接書かない。

## 開発の流れ

1つの作業単位（1 PR）はこの順で進める。各段の詳細は参照先の節にある。

| 段 | やること | 担当 | 詳細 |
|---|---|---|---|
| 1 | 作業単位を決める（Issue かバックログから。1 PR、差分 2,000 行以内） | 人間・メインセッション | 「PR と Issue の運用」 |
| 2 | List: テストリストを作る。**上位の行は入口（仕様に振る舞いを書いた場所）の振る舞いで書く**。小さく進めるための細かい行（関数単位）は足してよいが、4 で寄せる対象になる | メインセッション | 「実装の進め方: TDD」 |
| 3 | Red → Green → Refactor を繰り返す。**段ごとにコミットする**。入口以外に書いてよい | `test-writer`・メインセッション | 同（「コミットの分け方」） |
| 4 | リストが空になったら、入口以外のテストを入口へ寄せ、残す理由の無いものを消す。作業単位の最後に毎回呼び、整理があればコミットする | `test-consolidator` | 「テストの流儀」「サブエージェント」 |
| 5 | レビュー: `test-reviewer` → `contract-auditor` → `/code-review`（条件で `/security-review`） | 各エージェント・メインセッション | 「レビューのタイミング」 |
| 6 | PR（`Closes #N`）→ CI → マージ → デプロイ → Cosmos のクエリを変えたら手で確認 | メインセッション・人間 | 「PR と Issue の運用」「CI/CD」「ドキュメントの扱い」 |

入口とは、その振る舞いを仕様に書いた場所（エンドポイント、画面）で、呼び出し元ではない。
どこが入口かは「テストの流儀」の表にある。

## 実装の進め方: TDD

**新機能の実装とバグ修正は TDD で進める。**

Kent Beck の Canon TDD に従い、**「リスト、レッド、グリーン、リファクタ」の4段**とする。
「Red-Green-Refactor」の3段で語られることが多いが、**テストリストの段が落ちている**。
ここを飛ばすと、何をテストすべきかを考えずに手近なテストから書き始めてしまう。

| 段 | やること | 担当 |
|---|---|---|
| **List** | 押さえるべきテストシナリオを洗い出し、リストにする。**上位の行は入口の振る舞いで書く**（どの API・画面に、どんな入力で、何が返るか）。仕様書はここでは見ない | メインセッション |
| **Red** | リストから**1つだけ**選び、失敗するテストを書いて落ちることを確認 | `test-writer` |
| **Green** | 最小の実装で、そのテストと既存の全テストを通す | メインセッション |
| **Refactor** | 振る舞いを変えずに整理する。**ここで初めて設計判断を行う** | メインセッション |

リストが空になるまで Red に戻って繰り返す。

`test-writer` は Red を確認した時点で引き渡す（本番コードを書けないため）。
実装はメインセッションが受け取る。この分担は「サブエージェント」節を参照。

### コミットの分け方

**TDD の段ごとにコミットを分け、履歴から回り方が読めるようにする**（2026-10-15 に人間が決定）。
Green と Refactor を1つの変更で入れていて、どこで設計判断をしたかが履歴から読めなかったため。

| コミット | 中身 | 件名の頭 |
|---|---|---|
| List + Red | 落ちるテストだけ（赤のままコミットしてよい）。メッセージにテストリストの表を載せる（下記） | `[Red]` |
| Green | そのテストを通す最小の実装だけ | `[Green]` |
| Refactor | 振る舞いを変えない整理。整理することが無ければコミットせず、次の Red のメッセージに「Refactor なし」と書く | `[Refactor]` |
| 作業単位の最後 | `test-consolidator` によるテストの整理（入口へ寄せる・冗長なものを消す）。整理が無ければコミットしない | `[整理]` |

- **テストリストは PR 全体で1つの表にする。** `[Red]` のコミットのたびに同じ表を載せ、行は増えてよいが済みの行は消さない
  （PR を通して進み方が読めるように）。列は「#・テスト・状態」、状態は「済み」「今回」「未着手」「書かない（理由）」。
  番号は PR の中で固定し、後から足した行は末尾に続けて振る

  ```
  | # | テスト | 状態 |
  |---|---|---|
  | 1 | 旅行詳細の「写真を追加」で1枚選ぶと、その旅行宛てに送られる | 済み |
  | 2 | 選ばずに閉じたら何もしない | 書かない（変異が生き残り、観察できる違いが無い） |
  | 3 | 読み込みに失敗したら「画像の読み込みに失敗しました」 | 今回 |
  | 4 | 送信に失敗したら「送り直す」「閉じる」を出す | 未着手 |
  ```
- `test-writer` はコミットしないので、Red のコミットはメインセッションが**期待した理由で赤になったことを確かめてから**入れる
- **コミットの前に、テストの終了コードを確かめる。** `flutter test 2>&1 | tail -1 && git commit` のように出力を `tail` でつなぐと、
  テストが落ちても `tail` が成功して次へ進み、赤のまま `[Green]` をコミットしてしまう（2026-10-15 に起きた）。
  結果をファイルに書き出して終了コードを見る（`flutter test > log 2>&1; echo $?`）。Red なら、落ちたのが今回のテストだけかも見る
- コミットごとに入れるファイルを指定する（`git add -A` にしない）。`git reset --soft` の後はステージに前の変更が残っている
- 赤のコミットが途中にあっても構わない。CI は PR の先頭のコミットで回り、そこでは全テストが緑になっている
- レビューの指摘への対応（テストの直し・本番の直し）は、TDD の段ではないので件名の頭を付けない。
  不具合の修正は、再現テストを `[Red]`、修正を `[Green]` として同じ形で入れる

### 守るべき点

- **テストリストを先に作る。** 1つ目のテストを書く前に、
  カバーすべきシナリオを列挙する。実装中に気づいたものはリストに追加し、
  そのとき書き始めずに現在のサイクルを完了させる
- **List の上位の行は入口の振る舞いで書く。** 最後に残るテストも仕様に載る文もその単位だから。
  小さく進めるために関数単位の細かい行を足してよいが、それは作業単位の終わりに入口へ寄せる対象になる
  （「Refactor 段でのテストコードの扱い」）。仕様に無い振る舞いは行にしない。契約にしたければ先に仕様に書く
  （旅行アルバムは `docs/travel-album/` が目指す姿なので先に書ける。植物図鑑の `docs/06` は実装後に書く文書なので、
  List がそのまま仕様の下書きになり、作業単位の終わりに `contract-auditor` が写す）
- **1サイクルで扱うテストは1つだけ。** 複数を同時に赤にしない
- **赤を確認せずに実装に進まない。** 赤を見ていないテストは、
  何も検証していない可能性がある（アサーションが甘い、テスト対象が呼ばれていない）
- **赤が「期待した理由で」出ていることを確認する。** 未実装だから落ちているのか、
  テスト自体が壊れて落ちているのかは別物
- **Green では最小の実装に留める。** 思いついた改良を同時に入れない。
  設計判断は Refactor 段に持ち越す

### Refactor 段でのテストコードの扱い

**Refactor 段はテストコードも対象に含む。** テストもコードであり保守対象である。

変更してよいもの / いけないもの:

| 対象 | 扱い |
|---|---|
| テストの**構造** — 重複排除、冗長なテストの削除、ヘルパー抽出、改名 | **変更してよい。むしろすべき** |
| テストの**置き場所** — 入口以外に書いたテストを入口の表へ移す | **変更してよい。むしろすべき** |
| テストの**期待値の意味** | 変更しない。変えたら振る舞いを変えている |

冗長なテストの削除は判断を伴う。基準は `.claude/test-principles.md` の原則5
（論理的従属性、確信、意思疎通の3段で判断する）。

**入口以外に書いたテストは入口へ寄せる。** Red で入口以外（util・サービス）に書いたテストは、
テストリストが空になった時点（レビューと PR の前）に、同じ振る舞いを入口のテストの表に載せ、元のものを消す。
上流が下流を必ず呼ぶことは仕様に無いので、入口以外のテストは「呼ばれている」ことを守れず、
振る舞いを変えない整理で落ちる。残すのは、入口から入力を作れないときと、
その場所が外部システムとの契約をそのまま担うときだけ（名簿は「テストの流儀」）。
この作業は `test-consolidator` が担い、作業単位につき1回。毎サイクルの Refactor では行わない。
冗長なテストの削除の判断もこの段で、同じエージェントが変異で確かめて行う
（原則5の3段のうち、従属と確信は変異で、意思疎通は入口の行名で満たす）。
本番コードは触らず、全テストが緑の状態で1変更ごとに実行する。`test-reviewer` と `contract-auditor` はその後に回す。

**本番コードとテストコードを同時に変更しない。**
両方に欠陥が入ると互いを隠蔽し、テストが通っているのに壊れている状態になる。
本番コードの変更を終えて全テストが緑になってから、テストの再構成に取りかかり、
**1変更ごとにテストを実行する**。

### バグ修正の場合

**先に再現するテストを書く。** 直してから確認するのではなく、
再現テストが赤になることを確認してから修正する。
これが退行テストとして残り、同じバグの再発を防ぐ。

**再現テストは入口に書く。** 退行テストとして残すものなので、入口以外に書くと寄せる対象になる。

`debug-investigator` の報告にある「修正を検証する方法」が、この再現テストの仕様になる。

### TDD を適用しない場合

- **取るに足らないコード** — テスト自体を書かない方針なので TDD の対象外。
  判断基準は `.claude/test-principles.md` の原則5
- **設計を探るための試作** — 捨てる前提のコードには適用しない。
  ただし残すと決めた時点でテストを書く
- **既存テストの書き直し・整理** — Red-Green のサイクルではない。
  本番コードの振る舞いを変えずにテストの構造を直す作業なので、
  Refactor 段と同じ規律（全テストが緑の状態で、1変更ごとに実行）で進める

Flutter 側（`mobile/`）も api と同じく TDD で進める。以前は WSL から `flutter test` を
実行できず例外扱いだったが、Windows に統一したのでその場で赤緑を確認できる。

## PR と Issue の運用

### PR の粒度

**1作業単位 = 1 PR。差分は 2,000行以内を目安にする。**

上限の根拠は `/code-review ultra` が **8,000行で受け付けを拒否する**こと。
余裕を持たせないと、いざレビューしたいときに回せない。

実害が出た例: 53コミット・8,150行の PR を出したところ `ultra` が拒否され、
基準を途中のコミットに縮めて回すしかなくなった。結果、前半の作業単位は
`/code-review` を**一度も通らずにマージ対象になった**。
PR が大きすぎることが、そのままレビューの穴になる。

あわせて守ること。

- **作業単位が終わったら出す。** 溜めない。レビューは作業単位ごとに1回という
  方針（下記「レビューのタイミング」）と、PR の粒度を一致させる
- **`main` へのマージは本番デプロイを起動する**（`deploy-functions.yml`）。
  PR が小さいほど1回のデプロイの影響範囲が狭く、切り分けも早い
- **`mobile/` の変更を含む PR も、手元で `flutter analyze` / `flutter test` を回してから出す。**
  CI（`flutter.yml`）でも回るが、手元で先に見る方が早い

なお `ci.yml` と `terraform.yml` は `[main, develop]` をトリガにしているが、
**`develop` ブランチは存在しない**。PR を `develop` に集約して `main` へは
意図したタイミングで出す運用に変える余地がある（CI 側は既に対応済み）。

### Issue を作る基準

**作る**: 判断が済んでいて、着手できる状態の作業。

- 担当や環境が分かれるもの（例: 人間が実機で確認する作業）
- 複数の PR にまたがるもの
- 他の作業の前提になっているもの

**作らない**: 次のものは Issue にしない。

| 対象 | 置き場 | 理由 |
|---|---|---|
| **判断待ちの項目** | `docs/09_backlog.md` | 決まっていないものを待ち行列に入れない |
| **トリアージ待ちの提案** | `docs/10_proposals.md` | 採否が決まってから Issue にする |
| **判断の根拠・実測値・変異テストの結果** | `docs/09_backlog.md` | コードと一緒にバージョン管理し、差分で履歴を追うべきもの |

### Issue の本文

**内容を複製しない。** Issue は**状態とポインタ**、`docs/09_backlog.md` が**実体**。

- `docs/09_backlog.md` の該当節へのリンク
- 完了条件のチェックリスト
- label（例: `windows`, `flutter`, `api`）

根拠や経緯を Issue 本文に書き写すと、backlog とずれたときにどちらが正しいか
分からなくなる。**ずれは必ず起きる**ので、最初から一方を実体と決めておく。

### クローズの基準

**原則、PR のマージで自動的に閉じる。** 手で閉じるのは例外。

- **PR 本文に `Closes #N` を必ず書く。** これが無いと閉じ忘れる
- 1つの PR が複数の Issue を閉じる場合は全部書く（`Closes #3, closes #4`）
- **手で閉じるのは「不要になった」場合だけ。** そのときは**理由をコメントに残す**。
  理由の無いクローズは、同じ提案の蒸し返しを招く

**閉じ忘れを防ぐ仕組み。**

1. **作業を始める前に `gh issue list` を見る。** Issue はファイルと違って
   エージェントの文脈に自動では載らない。見に行かないと存在しないのと同じ
2. **`docs/09_backlog.md` から項目を削除するコミットに、対応する Issue 番号を書く。**
   バックログは「対応したら該当項目を削除する」運用なので、
   削除と Issue のクローズが対応していなければどちらかが漏れている
3. **PR を出すときに、閉じる Issue が1つも無いなら理由を考える。**
   Issue 化の基準に該当する作業だったのに Issue が無かった、という取りこぼしに気づける

## レビューのタイミング

**TDD の1サイクルごとにはレビューしない。** サイクルは小さく頻繁なので無駄が大きい。

レビューは**テストリストが空になり、入口以外のテストを入口へ寄せた後**（「開発の流れ」の 4 の後）、
つまり1つの作業単位が完了したときに行う。寄せる前に `test-reviewer` を回すと、消すテストを見ることになる。
これはコミット前と同じ瞬間になる。差分が溜まりすぎてからでは精度が落ちるため、
**作業単位ごとに1回**を守る。

**テストと仕様書の突き合わせも、このタイミングで1回だけ行う。** TDD のサイクル中は
テストが増えたり減ったりするので、その都度突き合わせても手戻りになる。
PR を出す前の最終チェックとして、作業単位で固まったテストを仕様書と照らす。

PR を出す前に満たすこと。

- テストが固定している外部から観測できる振る舞い（ステータス・`code`・`message`、
  管理外の依存へ送るもの、クライアントなら画面に出す文言や遷移）が、仕様書に書かれている。
  書かれていなければ仕様書に追記する
- 入口以外に残したテストが、「テストの流儀」の名簿にあるか、2つの例外のどちらかに当たる理由がコメントにある
- テストと仕様書が食い違っていたら、正しい方が明らかなら揃え、
  判断が要るなら `docs/09_backlog.md` に残して人間に委ねる

### 何を回すか

順番は `test-consolidator`（寄せる。呼ぶ条件は「サブエージェント」）→ `test-reviewer` → `contract-auditor` → `/code-review`。

| 条件 | 手段 | 見るもの |
|---|---|---|
| **常に** | `/code-review` | 差分のバグと、再利用・簡約・効率の整理 |
| テストを書いた・直した | `test-reviewer` | 古典学派の原則への準拠。契約外（`details` の文言）を固定していないか。入口以外のテストが名簿に無いのに残っていないか |
| テストを書いた・直した、または外部から観測できる振る舞いを変えた | `contract-auditor` | テストが固定している振る舞いと仕様書の突き合わせ（上記「PR を出す前に満たすこと」） |
| API・レスポンス形状・型定義を変えた | `contract-auditor` | 仕様書・クライアントとの乖離 |
| 入力処理・認証・シークレット・外部通信・ストレージを触った | `/security-review` | セキュリティ |
| 依存を更新した | テストが通ることが検証になる | 破壊的変更への追従コードは `/code-review` |

TDD で進めた場合、**テストコードが成果物の大きな割合を占める**。
`test-reviewer` を省かないこと。`/code-review` は差分のバグを見るが、
テストダブルの分類や実装の詳細の検証といったテスト固有の原則は見ない。

### 粒度の指定

`/code-review` はレベルを省略すると前回指定したものを再利用する。**明示する方がよい。**

- 定型的な変更、小さな差分 → `low` / `medium`（確度の高い指摘だけ）
- 影響範囲が広い、外部契約を変えた、慣れていない領域 → `high` / `max`
- 大きな機能の完成時、リリース前 → `ultra`（多数のエージェントによる深いレビュー）

**`ultra` はユーザーしか起動できない**（課金対象のため）。
必要と判断したら、こちらから起動せずユーザーに依頼する。
`low` 〜 `max` はセッション内で動き通常の利用枠に含まれるので、
**迷ったら `high` を回す。** `ultra` を頼むのは、それでも不安が残るときだけ。

`ultra` はクラウドで動くため、ローカル実行とは違う制約が2つある。
どちらも実際に踏んだ。

- **基準ブランチはリモートで解決される。** ローカルにしか無いコミットは
  基準にできない。`main` がローカルで先に進んでいる状態で `ultra main` と
  指定すると、`origin/main` として解決されて意図より広い差分になる。
  **SHA を直接渡せば回避できる**（その SHA がリモートに到達している必要がある）
- **起動後に積んだコミットは対象に入らない。** 起動時点のブランチを
  クラウドへ送って解析するため。レビュー中は差分を動かさない

### レビュー後

指摘への対応はメインセッションが行う。機械的に適用してよい指摘が多ければ
`/code-review --fix` で差分へ適用できる。

**レビューは CI の代替ではない。** push 後に CI がテスト・CodeQL を、`audit.yml` が `npm audit` を回す。
レビューはその前段で、CI が見ない設計と可読性の問題を拾う。

### レビューしない領域

- **ドキュメントのみの変更** — `/code-review` は差分のコードを見るので効果が薄い。
  人間が読んで確認する
- **サブエージェントの成果物** — `test-writer` のテストと `test-consolidator` が寄せたテストは `test-reviewer` が見るが、
  `contract-auditor` のドキュメント修正を自動で見るものはない。
  報告された「変更の根拠」を人間が確認する

## 実装の慣習

計測して確認した、このリポジトリの実際の慣習。**周囲のコードに合わせるときの基準値。**

- **ドキュメントコメントの密度が高い。** api 側は関数41個に対して `/**` が43個で、
  実質すべての関数・メソッドに JSDoc 形式の説明が付いている。
  新規に関数を追加するときも同様に付ける。日本語で書く
- **コメントは why を書く。** 既存コードの良い例は
  `openAIVisionService.ts` 冒頭の、Structured Outputs の strict 制約が
  なぜ設計をそう縛っているかの説明。
  制約や非自明な判断の理由を残す。何をしているかの逐語訳は書かない
- **`catch (error: any)` が慣習。** `strict: true` だが catch 節では
  `any` を使っている（api 側で20箇所）。`error.code` や `error.message` への
  アクセスのため。ここを `unknown` + 型ガードに変えるなら全体で揃えること。
  **1箇所だけ流儀を変えない**
- **Flutter 側の構成方針**（2026-10-11 に人間が決定。実態に合わせた）。

  | 項目 | 方針 | 理由 |
  |---|---|---|
  | 状態管理 | `setState`。`ApiService` などは画面のコンストラクタで渡す | 画面をまたいで共有するクライアント状態が無く、扱うのはサーバのデータだけ |
  | 画面遷移 | `Navigator.push` / `pop`（`MaterialPageRoute`）。名前付きルートは使わない | ディープリンクや Web の履歴に対応する予定が無い（Android のみ） |
  | HTTP | `http`。テストは同梱の `MockClient` で差し替える | テストがこれに依存している |

  **見直す条件**: 画面をまたいで共有するクライアント状態（お気に入り、絞り込み条件、
  オフラインのキャッシュなど）が要る機能を足すとき。そのときは状態管理の方式を選び直し、
  **全画面を一度に移す**（`setState` と混在させると状態の所在が追えなくなる）。
  `pubspec.yaml` には使うパッケージだけを宣言する。かつて `provider` / `go_router` / `dio` /
  `uuid` / `intl` が使われないまま宣言されており、どれを使うべきか判断がぶれていた

## テストの流儀

**テストを書く・直す・レビューする前に `.claude/test-principles.md` を読むこと。**
このリポジトリは Khorikov『単体テストの考え方/使い方』の古典学派の立場を取る。
専用のサブエージェント `test-writer`（執筆）・`test-reviewer`（レビュー、読み取り専用）・
`test-consolidator`（入口へ寄せる）があり、どれも同じ原則ファイルを基準に動く。

最重要の原則は、**テストダブルの検証可否を依存の種類で決める**こと。
Cosmos DB / Blob Storage は管理下にある依存なので、モックは運用上の例外として許容するが
**やり取りの検証はしない**。OpenAI API は管理外の依存なのでモックと検証の両方が正当。
検証するのは `docs/06_api_design.md` §5.9「AI 識別サービスへ渡すもの」に書いた要素まで。
プロンプトの文言は `details` と同じ契約外で、完全一致で固定しない。

**エラー応答で固定するのはステータス・`code`・`message` まで。** `details` の文言は契約外なので
`toEqual` で固定しない（上記「レスポンス規約」）。仕様書との突き合わせは TDD のサイクル中ではなく、
作業単位が終わってから行う（「レビューのタイミング」）。

**エラーを注入するときは、実装の判定条件に合わせた文字列を作らない。** 実装が文字列で
分岐しているとき（かつて identify / upload は `error.message.includes('OpenAI')` で 502 を判定していた）、
その文字列を含むエラーを注入すると、実 SDK が作らない形でしか分岐を通らないテストになる
（2026-10-11 の監査で複数見つかり、分類は「どこで失敗したか」に改めた）。
実 SDK が投げる形を再現する。既存のテストにある例:

| 失敗 | 再現する形 |
|---|---|
| OpenAI のエラー応答 | `Object.assign(new Error('500 The server had an error...'), { name: 'InternalServerError', status: 500 })`（message に `OpenAI` は入らない） |
| OpenAI に接続できない | `APIConnectionError`（code なし）→ `TypeError: fetch failed` → `Error`（code `ENOTFOUND`）の3段の `cause` |
| Blob Storage の操作の失敗 | `name: 'RestError'`・`statusCode`・`code`（例 `AuthorizationFailure`）を持つエラー。接続できないときは `code` に errno が直接載る |

**環境変数を消すときは `delete process.env.X` を使う。** `process.env.X = undefined` は
文字列 `"undefined"` になり、「未設定」の分岐を通らない。

### テストの入口

**入口とは、その振る舞いを仕様に書いた場所**（原則4「テストの入口」）。守り続けるテストは入口に置く。

| 対象 | 入口 | 仕様 |
|---|---|---|
| api（植物図鑑） | エンドポイント（`api/tests/functions/`） | `docs/06_api_design.md`・`06_api_openapi.yaml` |
| api（旅行アルバム） | エンドポイント（`api/tests/functions/`） | `docs/travel-album/05_api_design.md`（目指す姿） |
| mobile | 画面（`mobile/test/screens/`） | `docs/03_screen_design.md` |
| mobile | アプリ全体（`mobile/test/app_root_test.dart`。起動直後の設定の扱い） | `docs/03_screen_design.md` §1・`docs/travel-album/03_screen_design.md` §4.1 |
| mobile | `ApiService`（封筒の契約。`mobile/test/services/`） | `docs/05_technology_selection.md` §4.2・`docs/07_api_workflow.md` |

**入口以外に残してよいテストの名簿。** 原則4の2つの例外に当たるもの。ここに無いテストが入口以外に残っていたら、
`test-consolidator` は理由を報告し、メインセッションが判断する。

| テスト | 例外 | 理由 |
|---|---|---|
| `api/tests/services/tripSummaries.test.ts` | 入口から入力を作れない | 偽物は Cosmos SQL を解釈しないので、`GROUP BY` の結果の行を入口（`GET /api/trips`）から作れない |

**複数の入口が同じ規則を持つとき**（データベースの 503、`imagePath` の検証、植物 ID の形式など）は、
仕様の「同じ」「全エンドポイント」を根拠に全ケースを通す入口を1つ決め、他の入口は1〜2行にして、
どこで全ケースを通しているかをコメントに書く（`photos.test.ts` の `storageFailureCases` のコメントが既にこの形）。
`databaseFailureCases` のように同じ表を入口ごとに全件回す形は、この決め方で減らす。

**変異の回し方**（原則7。`test-consolidator` と `test-reviewer` が使う）。api は `api/scripts/mutate.js` で回す。

```bash
cd api
node scripts/mutate.js mutations.json                    # 結果は標準出力
node scripts/mutate.js mutations.json --out result.json  # JSON でも残す
```

`mutations.json` は `{ file, old, new, name? }` の配列。`file` は `api/` からの相対パス、`old` はそのファイルに
ちょうど1回だけ現れる文字列（0回・2回以上なら実行前に止まる）、`new` は置き換え後（空文字なら削除）。
変異ごとに、退避 → 置換 → **全テスト**を実行 → 退避から復元 → バイト比較、の順に回し、
どのテストが落ちたか（殺した）と、どのテストも落ちなかった変異（生き残り）を報告する。
変異を入れる前から落ちているテストは数えない。import 先を壊すなど読み込みの時点で落ちた変異は、
テストが捕まえたのではないので「無効」として分ける。**型だけを変える変異は捕まらない**（ts-jest は
`isolatedModules` で型検査をしないため、実行時の振る舞いが変わらなければ生き残りになる）。
実行時の振る舞いが変わる変異（検証対象の削除、条件の反転、定数の変更）を選ぶ。
終了コードが非 0 になるのは、復元に失敗したとき（1。退避先のパスを出す）と入力の誤り（2）だけで、
生き残りがあっても 0（残すか直すかは読む側が判断する）。`mutations.json` はその場で書いて捨て、リポジトリに入れない。
`api/scripts/` はデプロイのパッケージ（`api/` 丸ごと）に含まれるが、実行時に読み込まれることは無い。

mobile は `flutter test` が Windows でしか回らず道具が無いので、手で回す。

1. 対象の本番ファイルを退避する（`git checkout` で戻す前提にしない。未コミットの実装があると消える）
2. 変異を入れる（検証対象の削除、条件の反転、定数の変更）
3. **全テスト**を実行し、どのテストが落ちたかを記録する
4. 退避から戻し、変異を入れる前の差分と一致することを確認する

### 偽物は `tests/fakes/` に置く

Cosmos DB / Blob Storage の差し替えには、**引数を見分ける状態持ちの偽物**を使う。
`tests/fakes/cosmos.ts` と `tests/fakes/blob.ts` が唯一の実体で、
各テストはここから import する。**テストファイル内に偽物を再定義しない。**

| ファイル | 中身 |
|---|---|
| `tests/fakes/cosmos.ts` | `FakeCosmosBackend`（ドキュメントの `Map`）と `createFakeContainer()` |
| `tests/fakes/blob.ts` | `FakeBlobBackend`（Blob の `Map`）と `createFakeBlobServiceClient()` |

状態を持たせるのは、**呼び出しを検証せずに結果を確認する**ため。
保存できたか・消えたか・宛先を取り違えていないかは、`toHaveBeenCalledWith` ではなく
`documents` / `store` の中身で確かめる。単一の共有モックだとどの引数で呼ばれても
同じ値を返すので、宛先の取り違えがテストを通過してしまう。

偽物は各テスト対象が使う操作の**和集合**を持つ。余分な操作を持っていても
テストは弱くならないため、テストごとに最小構成へ削らない。
失敗経路は `forcedQueryError` などのフラグ、もしくは Blob 単位の
`failWith` / `streamErrorWith` で起こす。

**偽物で検証できないことは偽物のファイルに書いてある。**
Cosmos SQL を解釈しないため、WHERE 句の中身・`ORDER BY` の並び順・
SELECT の射影は検証できない。この3点は実エミュレータか E2E、
もしくは「Cosmos のクエリを変更したら手で確認する」手順に委ねる。

### 既存テストの事実

- `tests/setup.ts` が `setupFilesAfterEnv` でグローバルに環境変数と `openai` のモックを設定し、`console.log` も抑制する。**Azure SDK のモックは置いていない**（完全に死んでいたため削除した）
- 各テストファイルは**それに加えて**個別に `jest.mock()` と環境変数を設定する二重構造。追いにくいため新規テストはファイル内で完結させる
- ディレクトリ構成は `src/` をミラーする。守り続けるテストは入口の `tests/functions/` に置き、`tests/services/` には名簿のテストだけがある（`tests/utils/` は #46 で無くなった。開発中に足すのは構わないが、作業単位の終わりに入口へ寄せる）。`tests/fakes/`（偽物）と `tests/helpers/`（複数のテストファイルが使うケースの表など。例 `databaseFailures.ts` の 503 / 500 の表）だけが例外で、`src/` に対応するものが無い共有部品
- テスト名は非開発者にも通じる日本語の文で書く（この慣習は踏襲する）
- `testTimeout` は 10 秒
- **スタブへの呼び出し検証は解消済み。** 残る `toHaveBeenCalled*` は OpenAI（管理外の依存）に対するものだけで、これは正当。Cosmos / Blob に対して書き足さないこと

## サブエージェント

`.claude/agents/` に専用のサブエージェントがある。

| 名前 | 役割 | 書き込める範囲 |
|---|---|---|
| `test-writer` | 原則に沿ったテストの執筆と実行 | **テストコードのみ** |
| `test-reviewer` | テストの原則準拠レビュー | なし（読み取り専用） |
| `test-consolidator` | 作業単位の終わりに、入口以外のテストを入口へ寄せて消す | **テストコードのみ** |
| `contract-auditor` | 実装とドキュメント・クライアントの乖離検出 | **仕様書・設計文書・README のみ** |
| `dep-upgrader` | 依存パッケージの段階的更新 | 依存定義とロックファイル、移行に伴う機械的な追従 |
| `debug-investigator` | 不具合の原因調査と修正案の提示 | なし（読み取り専用） |
| `improvement-scout` | 根拠付きの改善提案 | **提案文書のみ** |

**どのエージェントも `.claude/` 配下を書き換えない。**
エージェント定義と `test-principles.md` はエージェント自身の振る舞いを決める文書であり、
エージェントが自分の基準を書き換えられる状態にしない。
記述の不備は報告させ、**人間が判断して直す**。

`dep-upgrader`・`test-writer`・`test-consolidator` はコミット・プッシュをしない。

`test-consolidator` を呼ぶのは、作業単位の終わり（テストリストが空になった時点）に**毎回**（2026-10-15 に変更。
以前は入口以外のテストファイルに差分があるときだけだった）。整理するものが無ければ、その旨の報告だけで終わり、コミットは入らない。
TDD のサイクル中には呼ばない。

**呼ぶときは、作業単位で増えた入口のテストの冗長も見るよう指定する。** 定義の既定の対象は「入口以外に書かれたテスト」だけで、
テストを最初から入口に書いた作業単位では「対象なし」で終わる。定義は「呼び出し側が指定したテストを対象にする」ので、
「この作業単位で増えた入口のテストのうち、原則5の論理的従属で冗長なものがあれば、変異で確かめて消す」と頼む
（2026-10-15 に人間が決定。定義を直すかは、この運用で様子を見てから決める）。

コードレビューは組み込みの `/code-review`（差分のバグと整理）と
`/security-review`（セキュリティ）が担うため、自作していない。
`test-reviewer` はテスト固有の原則を見るもので、役割が重複しない。

### 実装は誰がやるか

**本番アプリケーションコードの修正はメインセッションが行う。**
サブエージェントで本番コードを書けるものは1つもない（`test-writer` もテストだけ）。

サブエージェントは調査・検証・提案・限定領域の作業を担い、実装はメインセッションに戻る。

| きっかけ | サブエージェント | その後 |
|---|---|---|
| 不具合・テスト失敗 | `debug-investigator` が原因と修正案を報告 | **メインセッションが修正** |
| テストが必要 | `test-writer` がテストを書く | 本番バグを見つけたら報告 → **メインセッションが修正** |
| テストの品質が不安 | `test-reviewer` が違反を報告 | `test-writer` が書き直す |
| 作業単位が終わった | `test-consolidator` が入口へ寄せて消す | 名簿に無いのに残したものは報告 → **メインセッションが判断** |
| API 変更後の整合性 | `contract-auditor` がドキュメントを直す | コード側の不整合は報告 → **メインセッションが判断して修正** |
| 依存を更新したい | `dep-upgrader` が段階的に更新 | 破壊的変更は報告 → **メインセッションが移行** |
| 次に何をやるか | `improvement-scout` が提案文書に追記 | **人間がトリアージ** → バックログ → **メインセッションが実装** |

この設計は意図的なもの。本番コードの修正は過去の判断の積み重ねの上に乗る作業で、
コールドスタートのサブエージェントには前提が引き継がれない。
また完了まで割り込めないため、前提が崩れたときに軌道修正できない。

確定した修正を機械的に広範囲へ適用する場合は、組み込みの
`/code-review --fix` や `/simplify` を使う。

### 定義の書き方

**これらの定義にはプロジェクト固有のパスやファイル名を書かない方針。**
ファイル名が変わってもエージェント定義まで追えないため、方法論だけを記述し、
プロジェクト固有の事実はこの CLAUDE.md から読ませている。

**つまりこの CLAUDE.md が古くなると、サブエージェントが古い前提で動く。**
構成を変えたらここを更新すること。テストの原則だけは
`.claude/test-principles.md` に分離してあり、こちらもパスを含まない。

## CI/CD

- `.github/workflows/ci.yml` — テスト・カバレッジ・ビルド・CodeQL。トリガーは `api/` と `.github/workflows/` 配下の変更のみ。
- `.github/workflows/audit.yml` — `npm audit --audit-level=high`。`api/package*.json` の変更と、毎週月曜の定期実行。**失敗はそのまま失敗にするが、デプロイは止めない**（人間の判断）。ci.yml とは別のワークフローにしているのは terraform.yml と同じ理由。以前は ci.yml の中で `continue-on-error: true` にしており、critical の脆弱性があっても成功扱いで誰も気づけなかった。**`continue-on-error` で失敗を握りつぶさない**こと。デプロイを止めたくない検査は、別のワークフローに分ける
- `.github/workflows/terraform.yml` — `terraform fmt -check` と `terraform validate`。トリガーは `infrastructure/**` と `.github/workflows/terraform.yml`（`main` / `develop` への push と `main` への PR）。**Azure へは通信せず認証情報も不要**で、定義ファイルの構文と内部整合性を見るだけ。`plan` は回さない（認証情報が必要になるうえ、リポジトリに入っている `terraform.tfstate` が実態と乖離していると誤った差分を出す）。**ci.yml とは別のワークフローにしている** — `deploy-functions.yml` が ci.yml の成功をデプロイの前提にしているため、ci.yml に足すとインフラ定義の整形崩れが API のデプロイを止めてしまう。
- `.github/workflows/flutter.yml` — `mobile/` の `flutter analyze`（info も含めて指摘があれば失敗）と `flutter test`（`TZ=Asia/Tokyo`。日時の表示のテストが日本時間を前提にしている）。トリガーは `mobile/**` と `flutter.yml` の変更。Flutter の版は手元と同じ 3.32.8 に固定しているので、上げるときは手元と一緒に上げる。ci.yml とは別のワークフロー（`mobile/` は本番デプロイと関係が無いため）。
- `.github/workflows/deploy-functions.yml` — `main` への push で ci.yml を呼んでから本番デプロイ
- デプロイは `scm-do-build-during-deployment: false` / `enable-oryx-build: false`。つまり**サーバ側でビルドしない**ため、ワークフロー内で `npm run build` 済みの `dist/` がそのままパッケージされる。ビルド出力パスを変える場合はデプロイ設定とあわせて確認する。ビルドの後に `npm prune --omit=dev` で開発用の依存を外してから `api/` を丸ごと送るので、**実行時に読み込むパッケージは `dependencies` に置く**（`devDependencies` に置くと、テストは通るのに本番で読み込みに失敗する）

## ドキュメントの扱い

**仕様書には実装済みのものだけを書く。** 未実装の機能や既知の課題は `docs/09_backlog.md` に置く。
この分離により、`docs/06_api_openapi.yaml` を「実装の正確な写し」として信頼できる状態に保つ。

記録先は確度で分かれており、**混ぜない**こと。

| 文書 | 内容 | 書き込む主体 |
|---|---|---|
| 仕様書・設計文書（`docs/01`〜`07`, README, DEPLOYMENT） | **実装済みの事実** | 人間、`contract-auditor` |
| `docs/travel-album/` | 旅行アルバムの**目指す姿**（要件・設計）。**未実装の要件を書いてよい**（2026-10-12 に決定）。開発中はこちらを正として都度直す。`docs/01`〜`07`・`DEPLOYMENT.md` への取り込みは機能が固まってから後でまとめて行う（2026-10-12 に決定。開発中に何度も変わるため） | 人間、メインセッション |
| `docs/09_backlog.md` | **検証済みで実在する**課題・未実装機能 | 人間、根拠を確認したエージェント |
| `docs/10_proposals.md` | **トリアージ待ちの提案**（未採用） | `improvement-scout` のみ |

`contract-auditor` は `docs/travel-album/` を実装の写しとして扱わない（未実装の記述をバックログへ移さない）。
ただし、旅行アルバムの機能を実装して `docs/01`〜`07` に取り込むときは、両者の食い違いを見る。

採用した提案は**人間が**バックログへ移す。却下した提案は理由を添えて
提案文書の「却下」節へ残す（同じ提案の蒸し返しを防ぐため）。
`improvement-scout` はバックログに書き込まない。バックログの
「すべて検証済み」という性質が信頼性の源だから。

**利用者から観測できる事実は仕様書に書く。CLAUDE.md は開発者向けの罠と手順に限る。**
バグ修正で分かった振る舞い（入力検証の条件、エラーの文言、削除時のホスト検証など）が
CLAUDE.md とコードのコメントにだけ残り、仕様書に戻っていないことが 2026-10-11 の監査で多数見つかった。
CLAUDE.md に書くのは「なぜそうなっているか」「どこで踏みやすいか」で、「どう振る舞うか」は仕様書に書く。

API を変更したら、あわせて更新する対象：

- `docs/06_api_openapi.yaml` — ルート、リクエスト/レスポンス形状、ステータスコード、エラーの `code` と `message`
- `docs/06_api_design.md` / `docs/07_api_workflow.md`
- `README.md` のエンドポイント表
- `mobile/lib/services/api_service.dart` — クライアント側の呼び出し
- `docs/06_api_design.md` §5.9 — AI 識別サービスへ渡すものを変えたとき。要素まで書き、プロンプトの文言は書かない

Flutter クライアントの振る舞いを変えたら、あわせて更新する対象：

- `docs/05_technology_selection.md` §4.2 — エラー表示の文言（`userMessage` の表）、送信内容の決め方
- `docs/03_screen_design.md` — 画面ごとの挙動（保存時の 409 の扱いなど）
- `docs/07_api_workflow.md` — エラー時のクライアントの対応

### Cosmos のクエリを変更したら手で確認する

**SQL の絞り込み・並び順・射影を検証しているテストは存在しない。**
ユニットテストの偽物は SQL 文字列を解釈しないため原理的に検証できず、
エミュレータも E2E も導入していない（環境が1つしかないため却下。`docs/09_backlog.md` 参照）。

そのため `cosmosService.ts` のクエリを変更したら、**デプロイ後に手で確認する**。
実測で穴が分かっている3点。

| 確認すること | 崩れたときの症状 |
|---|---|
| `GET /api/plants` のレスポンスに余分なキーが出ていないか | 射影が崩れると `description` / `updatedAt` / `scientificName` が漏れ、`PlantSummary` の契約が壊れる |
| `GET /api/plants` が作成日時の降順か | `ORDER BY c.createdAt DESC` の消失 |
| `GET /api/plants/check-duplicate` が別名の植物を拾わないか | `WHERE` 句の消失 |
| `GET /api/trips` が作成日時の降順か | `ORDER BY c.createdAt DESC` の消失（`AlbumService.listTrips`） |
| `GET /api/photos?tripId=...` が撮影日時（`sortAt`）の昇順か、継続トークンでページが続くか | `ORDER BY c.sortAt ASC` の消失。偽物は挿入順で返す |
| `GET /api/photos?tripId=none` が `tripId` が `null` の写真だけを返すか（`c.tripId = @tripId` に null を渡す） | 未所属の一覧が空か、旅行の写真が混ざる |
| `GET /api/trips` の表紙が各旅行の撮影日時の最初の写真か（`queryCover` の `TOP 1 … ORDER BY`） | 別の写真が表紙になる |
| `GET /api/trips` の枚数・撮影期間・旅行に属さない写真の枚数（`albumQueries.ts` の `GROUP BY`。`tripId` が `null` の写真が1つのグループになるか） | 集計が崩れる。偽物は集計を解釈しないので単体テストでは見えない |

偽物は渡したドキュメントをそのまま返すので、**射影の崩れは実際の Cosmos でしか観測できない。**

### クライアント実装で踏みやすい罠

**非 2xx は `ApiException.fromResponse()` が封筒の `error.code` / `error.message` を読む。**
`ApiException.code` にエラーコード、`message` にサーバの日本語メッセージが入り、
`userMessage` は 0 / 401 / 404 / 429 / 500 / 502 / 503 以外ではその `message` をそのまま返す。
429 はアプリが返すのではなく、従量課金プランの Functions ランタイムが過負荷時に封筒なしで返す。
401 は Functions ランタイムが返すため封筒にならないなど、読めないボディでは `code` が null になり、
ステータスを添えた固定の日本語メッセージになる。
**同じステータスでもコードで意味が違うものがある**（409 は `IMAGE_ALREADY_SAVED` と `DATABASE_ERROR`）。
分岐はステータスではなく `code` で行う（例: `ApiException.isImageAlreadySaved`）。

以下は 2xx の場合の話。API のレスポンスは必ず `{ success, data }` の封筒に包まれている。
Flutter 側の `_parseResponse()` は**ボディ全体**をコールバックに渡すため、
各メソッドが自分で `json['data']` を剥がす必要がある。これを忘れると実行時に
`fromJson` がキーを見つけられず失敗する（過去に `ApiService` の `identifyPlant()` と `uploadImage()` で発生。どちらも未使用だったため削除済み）。
`mobile/test/services/api_service_test.dart` が、クライアントが `data` を読む下表の植物の API のエンドポイントすべてでこれを固定している
（`DELETE` は `data` を読まず、`identify` はクライアントから呼んでいないので対象外）。
旅行アルバムの API は、画面のテストが偽のサーバ（`FakeTripBackend`）越しに封筒の剥がし方まで通しているので、`api_service_test.dart` にメソッドごとのテストを足していない
（上位に従属するテストを作らない。Issue #41）。メソッドを足したら、それを使う画面のテストで `data` の読み違いが落ちることを確かめる。
メソッドを足したら同じ形でテストを足すこと。

さらに封筒の内側のキーが関数ごとに違う点にも注意：

| エンドポイント | `data` の中身 |
|---|---|
| `GET /api/plants` | `{ plants, total }` |
| `GET` / `PUT /api/plants/{id}` | `{ plant }` |
| `POST /api/plants/save` | `{ plant }` |
| `DELETE /api/plants/{id}` | `{ message }` |
| `POST /api/plants/identify` | `{ result }`（クライアントからは呼んでいない） |
| `GET /api/plants/check-duplicate` | `DuplicateCheckResult` を直接 |
| `POST /api/images/upload` | `{ imagePath, fileName, contentType, fileSize, identificationResult }` |
| `GET /api/trips` | `{ trips, total, unassignedPhotoCount }` |
| `POST /api/trips`・`GET` / `PUT /api/trips/{tripId}` | `{ trip }` |
| `DELETE /api/trips/{tripId}` | `{ message, deletedPhotoCount, detachedPhotoCount }` |
| `GET /api/photos` | `{ photos, continuationToken, urlExpiresAt }` |
| `POST /api/photos/move` | `{ moved, notFound }`（`ApiService.movePhotos` が 200 件ずつ分けて送り、結果を合わせる） |
| `DELETE /api/photos/{photoId}` | `{ message }`（クライアントは `data` を読まない） |
