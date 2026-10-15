# バックログ

実装されていない機能・既知の課題を記録する。対応したらこのファイルから該当項目を削除する。

運用方針: 仕様書（`06_api_design.md` / `06_api_openapi.yaml` など）には**実装済みのものだけ**を書く。
未実装のものをここに置くことで、仕様書を「実装の正確な写し」として信頼できる状態に保つ。

各項目の**「判断が必要な点」と「推奨」は Claude が付けた意見**であり、検証済みの事実ではない。
このファイルの他の記述（実在する課題・実測値）とは性質が違うので混ぜないこと。
採否は人間が決め、決めたら推奨の節は消して結論を本文に書く。

---

## Flutter（Dart）の作業

Dart に触る作業の索引。以前は WSL から `flutter test` を実行できず、Windows 側でまとめて処理するために
集めていたが、2026-10-11 に開発環境を Windows に統一したので、その制約は無くなった（CLAUDE.md「開発環境」）。
散らばった項目を探し直さずに済むよう、索引としては残している。詳細は各項目にある。
**ここに書くのは Dart の変更が必要なもの（確認の結果で必要になりうるものを含む）だけ。**

| 項目 | 判断 | 内容 |
|---|---|---|
| [判定できない画像形式を `image/jpeg` として送る](#判定できない画像形式を-imagejpeg-として送る) | **TODO: Android 実機で確認** | 確認結果を見て、既定値を残すかサーバに 415 で弾かせるかを決める |
| [科名の「科」が二重になる可能性](#科名の科が二重になる可能性要確認dart) | 要確認 | 実際の `familyName` を確かめてから |
| [画像選択画面のタイトルに「撮影」とあるが、撮影できない](#画像選択画面のタイトルに撮影とあるが撮影できないdart) | 直す（判断済み） | タイトルと CAMERA 権限から「撮影」を外す |

第1弾（テストの新設、`uploadImage()` の削除、409 の扱い、`api_response.dart` の書き直し、
Content-Type のマジックバイト判定）は #2 で対応済み。その後、未使用の `identifyPlant()` の削除と、
`deletePlant()` のエラー解釈の統一も対応済み。

### 最初にやること

```powershell
cd mobile
flutter pub get      # pubspec.lock はコミット済みだが .dart_tool/ は無いので必要
flutter analyze      # 着手前の状態を確認する（既存の指摘で終了コード1になる。CLAUDE.md 参照）
flutter test
```

**先に CLAUDE.md の「クライアント実装で踏みやすい罠」節と、`mobile/` 節のテストの注意点を読むこと。**
テストの書き方は `mobile/test/services/api_service_test.dart`（`MockClient` で HTTP を差し替える）と
`mobile/test/screens/identification_screen_test.dart`（画面のテスト）が手本になる。

`dev_dependencies` は `flutter_test`・`flutter_lints` と、端末の機能をテストで差し替えるための
プラットフォーム層（`image_picker_platform_interface`・`flutter_secure_storage_platform_interface`・
`plugin_platform_interface`）だけ。モック生成の補助パッケージ（mocktail など）は入っていない。
HTTP は `http` 同梱の `MockClient` で足りている。新しい依存を増やす前に
CLAUDE.md「実装の慣習」の Flutter の構成方針を確認すること。

**進め方**: api と同じく TDD で進める（CLAUDE.md の TDD の節）。

`flutter analyze` と `flutter test` は CI（`.github/workflows/flutter.yml`）で回る（#24）。

---

## 機能追加

### 旅行アルバム（ロードマップ）

旅行中に撮った写真をアップロードしてアルバムにする構想（人間の要望、2026-10-12）。
**要件（決まっていること・段階）は [docs/travel-album/01_requirements.md](./travel-album/01_requirements.md) にある。**
進み具合は Issue #22。ここには、要件や設計の根拠になる実測の記録だけを置く。

**段階1の結果**（2026-10-12、旅行で使う端末 SC-03K・Android 10 で実測）

アプリが受け取ったファイルの EXIF を、3つの取り込み方で比べた。確認用の試作は `spike/photo-metadata` ブランチ
（`main` にはマージしない。起動すると確認画面が開き、別のアプリ ID で既存のアプリと並べて入る）。

| 取り込み方 | 撮影日時 | 位置情報 | タイムゾーン |
|---|---|---|---|
| A: `image_picker`、今のアプリの設定（画質85%・最大1920px に縮小）、ギャラリーから選択 | あり | あり | なし |
| B: `image_picker`、縮小なし、ギャラリーから選択 | あり | あり | なし |
| C: `photo_manager` で端末の写真の一覧から直接読む（`ACCESS_MEDIA_LOCATION` あり） | あり | あり | なし |

- **位置情報の権限（`ACCESS_MEDIA_LOCATION`）が無くても、ギャラリーから選べば位置情報は残る**（権限を外して A をやり直して確かめた）。
  今の SnapPlant 本体の取り込み方のままで読める。縮小しても残るのは、`image_picker_android` が縮小時に撮影日時と GPS の EXIF を
  写しているため（`ExifDataCopier`）
- **カメラの「位置情報タグ」がオフだと、写真に位置情報が一切残らない。** この端末では最初オフだった。オフで撮った写真は
  どの取り込み方でも位置情報なし。旅行の前にオンにしておくのが運用上の前提になる
- **タイムゾーン（`OffsetTimeOriginal`）は記録されない。** 撮影日時は撮影した土地での時刻として扱う。時差をまたぐと移動日の
  前後で並び順がずれうる。位置情報がある写真は GPS の時刻（UTC）で補正できる
- 確かめていないこと: Google フォトから選んだ場合、Android 10 以外の版。SC-03K は Android 10 が最終版なので OS の更新では変わらない

**段階2の結果**（2026-10-14、SC-03K・Android 10 で実測。PR 7 の着手前の確認、[09 §6](./travel-album/09_implementation_plan.md#6-最初に実機で確かめること)、#33）

同じ試作（`spike/photo-metadata`）に「D: 複数選択」を足し、PR 7 と同じ `pickMultiImage()`（画質85%・最大1920px）で選んだ写真の
SHA-256・バイト数・EXIF・地名（`geocoding` 5.0.0、端末の Geocoder）を出して確かめた。

| 確かめたこと | 結果 |
|---|---|
| ハッシュの決定性（同じ3枚を2回選ぶ） | **3枚とも一致**。縮小ありのまま `photoId` に使える（`imageQuality` / `maxWidth` を外さなくてよい） |
| `pickMultiImage()` の EXIF | 3枚とも撮影日時・位置情報あり（段階1の `pickImage()` と同じ） |
| 端末の Geocoder | 「〇丁目」まで返る（市区町村より細かい）。機内モードでも止まらずに返った |

- **機内モードで地名が返ったのは、直前に同じ座標を引いた結果が端末に残っていたため**と見ている（応答が 40ms 前後で、オンラインの初回より速い）。
  初めて引く座標がオフラインで引けるかは確かめていない（別の場所の写真が手元に無かった）。止まらないこと（10 秒で打ち切る作りで、打ち切りには至らなかった）は確かめた
- **`geocoding` 5.0.0 は minSdk 24・compileSdk 36 を求める。** 本体は minSdk 21・compileSdk 35 なので、PR 7 で入れるときに上げる
  （SC-03K は Android 10 = API 29 なので影響しない。API 21〜23 の端末は対象から外れる）
- 確かめていないこと: 1枚の縮小後のバイト数（10MB の上限と 300 枚の送信時間の見積もり。PR 7 の 300 枚の送信の確認で測る）

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

**やるとしたら OpenAI を呼ぶ `POST /api/images/upload` と `POST /api/plants/identify` に絞る。**
この2つだけが OpenAI の課金に直結する（アプリが実際に使うのは upload だけ）。Azure 側の予算アラートを先に入れて、
実際に異常な消費が観測されてから着手する方が費用対効果が高い。

---

## 既知の不具合・改善

### Functions を Flex Consumption プランへ移し、Node 24 に上げる（2027-04 まで）

Functions は Linux の従量課金プラン（Y1）で、Node は 22（2026-10-11 に 20 から上げた）。

| 事実 | 出典 |
|---|---|
| Node 22 の Functions でのサポート終了は **2027-04-30**。Node 24 は 2028-04-30 | Microsoft Learn「Supported languages in Azure Functions」（2026-08-27 更新） |
| **Node 22 は Linux 従量課金で使える最後の Node**。Node 24 は Flex Consumption などでしか使えない | 同上 |
| **Linux 従量課金プラン自体が 2028-09-30 に廃止**され、新しい機能も言語バージョンも追加されない | 同上 |

つまり Node 22 のサポートが切れる前に、プランの移行が要る。

移行で起きること（Microsoft Learn「Migrate Consumption plan apps to the Flex Consumption plan」）。

- **既存の Function App は変換されず、新しい Function App が並べて作られる。** URL（ホスト名）が変わるので、
  Flutter アプリの設定画面のエンドポイントを入れ替える必要がある。Function Key もおそらく変わる（未確認）
- Flex では使えないアプリ設定がある（`FUNCTIONS_WORKER_RUNTIME`、`WEBSITE_NODE_DEFAULT_VERSION`、`WEBSITE_RUN_FROM_PACKAGE` など）。
  ランタイムと版は `functionAppConfig` で指定する
- デプロイ先のストレージコンテナが要る。GitHub Actions の `Azure/functions-action` の設定（Publish Profile が使えるか、`sku` の指定）は未確認
- Terraform では `azurerm_service_plan`（Y1）+ `azurerm_linux_function_app` を `azurerm_function_app_flex_consumption` に置き換える。
  このリソースは azurerm v4 以降にある。プロバイダは 2026-10-11 に v4（4.81.0）へ上げ済み（#12）
- Flex は従量課金（上限10分）より長い `functionTimeout` を許す。`host.json` で5分を明示しているので移行だけでは変わらないが、
  伸ばすなら一時 URL の SAS の有効期限（`storageService.ts` の `TEMP_SAS_EXPIRY_MINUTES`、15分）も見直す。
  この有効期限は1リクエストの上限が5分であることを前提にしており、超えると AI 識別の途中で画像を読めなくなる

**やること（着手時に確認しながら）**

1. `azurerm_function_app_flex_consumption` で新しい Function App を作り、Node 24 にする（旧アプリは残す）
2. デプロイのワークフローを新しいアプリ向けに直し、Publish Profile などの Secrets を取り直す
3. 新しい URL で動作確認してから、Flutter の設定を切り替え、旧アプリを削除する

上記「azurerm プロバイダを v5 に上げる」と同じ時期にまとめると、`plan` の確認が1回で済む。

`terraform plan` / `apply` には作業マシンにしか無い state が要る（CLAUDE.md「開発環境」）。

### Terraform 管理外の App Insights `func-snaplant-mk0w7s38` を削除する

リソースグループには App Insights が2つある。Terraform が作った `appi-snaplant-mk0w7s38` と、
ポータルで自動作成されたとみられる `func-snaplant-mk0w7s38`（Terraform の管理外）。

2026-10-11 の時点で、Function App のテレメトリは**管理外の `func-snaplant-mk0w7s38` に送られていた**
（Function App の `APPINSIGHTS_INSTRUMENTATIONKEY` がこちらのキーと一致することを Azure CLI で確認。
Function App のタグ `hidden-link: /app-insights-resource-id` もこちらを指していた）。
`main.tf` は `appi-snaplant-mk0w7s38` に送る定義なので、どこかでポータルから付け替えられていた。
azurerm v4 への更新の `apply` で、人間の判断により `appi-snaplant-mk0w7s38` に揃えた。

**やること**: 過去のログが要らなくなったら `func-snaplant-mk0w7s38` を削除する（Terraform の管理外なので `az` かポータルで）。
保持期間の既定は 90 日。料金は取り込み量に応じてかかるので、送られなくなれば実質かからない。

### azurerm プロバイダを v5 に上げる（画像の公開設定に注意）

2026-10-11 に v3 から v4（4.81.0）へ上げた。Node 22 の指定に v4 が必要だったため。
最新は v5（2026-10-11 時点で 5.9.0）。v4 → v5 で、このリポジトリに影響する変更（azurerm の 5.0 移行ガイド）。

- **`azurerm_storage_account` の `allow_nested_items_to_be_public` の既定値が `false` になる。**
  `images` コンテナは公開読み取り（`container_access_type = "blob"`）で、Flutter はその公開 URL で画像を表示している。
  **明示せずに上げると、画像がすべて表示されなくなる。** `allow_nested_items_to_be_public = true` を明示してから上げる
- **`azurerm_storage_container` の `storage_account_name` が削除され、`storage_account_id` になる。**
  指定方法を変えるとコンテナが作り直しになる可能性がある（`images` の中身が消える）。
  `terraform plan` で replace が出ないことを必ず確かめる。出るなら `terraform state` 操作か import で回避する
- `azurerm_application_insights` の `local_authentication_disabled`・`disable_ip_masking` が削除される（このリポジトリでは未使用）
- `features` ブロックの中身の一部が変わる（`enhanced_validation` が中に移る、`skip_provider_registration` の削除）

**判断が必要な点**: いつ上げるか。v4 のサポート期間中は急がない。Flex Consumption への移行（`azurerm_function_app_flex_consumption`）と
同じ時期にまとめると、`plan` の確認が1回で済む。

### 判定できない画像形式を `image/jpeg` として送る

`mobile/lib/utils/image_mime_type.dart` の `detectImageMimeType()` は
PNG / JPEG / GIF / WebP のシグネチャに当たらない中身を `image/jpeg` として返す
（#2 でマジックバイト判定を入れたときに、従来の既定値を引き継いだ）。

サーバ（`upload.ts`）は送られた Content-Type だけを検証して信頼するため、
HEIC / AVIF / BMP などは `image/jpeg` として受理され、中身と Content-Type・拡張子が
食い違った Blob が保存される。#2 で直した食い違いが、4形式以外に限って残っている。
AI 識別に渡ったときにどうなるか（OpenAI がその形式を読めるか）は未確認。

**判断: Android の実機で確認してから決める**（人間がトリアージ済み、2026-10-11）。
iOS からは当面使う予定が無いので、iOS の HEIC の問題は考えなくてよい。
実機確認はすぐにはできないため、TODO として残す。

**TODO（Android 実機）**: カメラ撮影とギャラリー選択のそれぞれで、`image_picker` が
渡すファイルの形式（先頭バイト）を確認する。4形式以外（HEIC / HEIF など）が来るかどうかで決める。

- 4形式以外が来ない → 下記の推奨どおり 415 で弾かせても利用者に影響しない
- 来る → 弾くとアップロードできなくなる。クライアント側で JPEG に変換するか、
  `image_picker` の `imageQuality` 指定で再エンコードさせるかを先に決める

**判断が必要な点**（確認後）: 既定値を残すか、判定できないものはサーバに弾かせるか。

**推奨**: **`application/octet-stream` を返してサーバに 415 で弾かせる。**
4形式以外を受け付けないのはサーバの仕様なので、クライアントが偽の Content-Type で
すり抜けさせる理由が無い。

### 旅行詳細で、写真の一覧が 404 を返しても「この旅行は削除されています」にならない（Dart、旅行アルバム）

旅行詳細を開いた後に別の端末で旅行が消され、そのあと写真の一覧を引っ張って読み直したり続きを読んだりすると、
`GET /api/photos` が 404 `TRIP_NOT_FOUND` を返す。`PhotoGrid`（`mobile/lib/widgets/photo_grid.dart`）はこれを他の失敗と同じに扱うので、
スナックバーに「要求されたデータが見つかりません。」が出るか、末尾に「続きを読み込めませんでした」が出て、編集・削除のメニューも残る。
`docs/travel-album/03_screen_design.md` §4.4 の「旅行が無い → この旅行は削除されています」と食い違う
（2026-10-14、PR 6b の contract-auditor の指摘。コードを読んでの判断）。まれな操作で、写真が消えることは無い。

**やること**: `PhotoGrid` から旅行詳細へ「旅行が無い」を知らせ、画面全体を「この旅行は削除されています」にする。

### エンドポイントを `http://` で設定すると、読み込みは通るのに書き込みだけ「ステータス301」で失敗する（Dart）

Function App は `https_only = true` で、`http://` の要求には 301（https への転送）を返す。`http` パッケージは GET の転送を辿るので
一覧や詳細は出るが、POST / PUT / DELETE は辿らずに 301 をそのまま受け取り、`ApiException` の固定の文言
「サーバーでエラーが発生しました（ステータス301）」になる（2026-10-14、PR 8 の実機確認で起きた。`curl` で http の GET・POST とも 301、
https の `POST /api/photos/move` は届くことを確かめた）。設定は人が直せば済むが、一覧が出るので設定の誤りだと気づきにくい。
ローカル開発では http を使うので、設定の入力で http を拒むことはしない（2026-10-13 に人間が決定）。

**やること**: 3xx を受けたときの文言を「エンドポイントを https で始まる URL にしてください」のように設定の見直しを促すものにするか、
設定の保存時に本番らしいホストで http なら注意を出すかを決める。

### 分類できない失敗も「通信の失敗」として送り直す（Dart）

`ApiService._handleError`（`mobile/lib/services/api_service.dart`）は、`ApiException` でも通信の例外でもない失敗（応答の JSON の形の誤りなど）を
すべて `statusCode: 0` にする。写真の送信（`UploadQueue`）は 0 を通信の失敗として 2・4・8 秒で3回送り直すので、送り直しても直らない失敗も
3回送ってから失敗になる（2026-10-15、PR 7b の test-reviewer の指摘。コードを読んでの判断）。写真の id で冪等なので、写真が重複することは無い。

**判断が要ること**: 通信の失敗と、それ以外の分類できない失敗を、`ApiException` の別のステータス（または種類）で分けるか。

### 選択モード中に下に引っ張って読み直すと、消えた写真が選択に残る（Dart、旅行アルバム）

`PhotoSelection`（`mobile/lib/widgets/photo_selection.dart`）は選んだ写真の id を持ち続け、読み直した一覧に合わせて絞らない。
選択モード中に別の端末で写真が消され、下に引っ張って読み直すと、見えない写真が「N枚を選択中」に数えられたまま残り、
移動・削除の要求にも入る（2026-10-14、PR 8 の `/code-review` の指摘。コードを読んでの判断）。
移動なら「（N枚は見つかりませんでした）」、削除なら 404 を消せたと数えるので、写真を取り違えることは無い。

**判断が要ること**: 読み直したら選択を読み込んだ写真に絞るか、選択モード中は引っ張る読み直しをさせないか、読み直したら選択モードを抜けるか。
`docs/travel-album/03_screen_design.md` §4.8 に決めた扱いを書いてから直す。

### `EndpointSuffix` の無い接続文字列の既定値の分岐が使われない

`StorageService` の `resolveBlobEndpointHost()` は、接続文字列に `EndpointSuffix` が無ければ `core.windows.net` として
ホストを組み立てる。ところが実 SDK の `BlobServiceClient.fromConnectionString` は、`EndpointSuffix` の無い接続文字列を
`Invalid EndpointSuffix in the provided Connection String` で拒否する（2026-10-13、#46 の整理で test-consolidator が手元で確認）。
`StorageService` も `PhotoStorageService` もコンストラクタで `fromConnectionString` を呼ぶので、既定値の分岐には届かず、
エンドポイントは 500 になる（SDK の `extractConnectionStringParts()` の該当箇所は contract-auditor もソースで確認した）。
DEPLOYMENT.md「`STORAGE_CONNECTION_STRING` の制約」にあった「`EndpointSuffix` を省いた場合は `core.windows.net` として
ホストを組み立てます」は事実ではなかったので、2026-10-13 に contract-auditor が現在の振る舞い（`EndpointSuffix` は必須で、
無いと 500）に書き直した。

この分岐を守っていた単体テストは、入口から観測できないので #46 の整理で消した。Terraform が流し込む接続文字列には
`EndpointSuffix` が入っているので、実害は無い。

ただし「届かない」のはサービスのコンストラクタの経路だけで、静的な検証 `StorageService.isValidImagePath()` は、サービスを作る前に
save・updatePlant の入口でこの分岐を通る（2026-10-14 に確認）。分岐を消して `null` を返す形にすると、`EndpointSuffix` の無い設定で
save の応答が 500 から 400（`画像アップロードAPIが返したURLを指定してください`）に変わる。設定の誤りなのに利用者の入力の誤りに見えるので、
消すなら静的な検証でも例外にして 500 を保つのがよい。

**判断: 今のまま残す**（2026-10-14、人間が決定）。補う分岐は本番の接続文字列では使われず害も無い。消すと設定の誤りが入力の誤り（400）に見えるので、残す。

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

### `save` の重複チェックは read-then-write で同時リクエストに効かない

`api/src/functions/save.ts` は `getPlantsByImagePath()` でクエリしてから
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

### `upload` で AI の呼び出しが例外で失敗すると、一時保存した Blob が残る

`api/src/functions/upload.ts` は一時保存（`uploadImageToTemp()`）の後に
AI 識別（`identifyPlant()`）を呼ぶ。植物でないと判定された場合は
`deleteImage()` で一時ファイルを消すが、`identifyPlant()` が例外を投げた場合は
ハンドラ全体を囲む catch 節に抜ける。catch 節は応答を作るだけで、一時ファイルを消さない。
502 / 503 `AI_SERVICE_ERROR` になる経路（AI に接続できない・エラー応答・応答が空や不正・検証違反）は、すべてこれに当たる。

同じ catch 節に抜ける経路として、永続コンテナへの移動（`moveFromTempToPermanent()`）の途中の失敗もある。
移動は「一時から読む → 永続へ書く → 一時を消す」の順なので、一時の削除より前で失敗すれば一時 Blob が、
一時の削除で失敗すれば一時 Blob と永続コンテナの複製の両方が残る（複製の URL はクライアントに返らないので、
どのレコードからも参照されない）。

残った一時 Blob は、一時コンテナ（`temp-images`）のライフサイクル管理（`azurerm_storage_management_policy`。#30 の apply 後に有効）が
最終更新から1日を過ぎると消す（Azure が1日1回処理するので実際には1〜2日後）。それまでの間と、永続コンテナに残った複製は消えない。

**実行時の症状**: AI 識別サービスの障害や不正な応答が起きるたびに、利用者の画像が一時コンテナに残る。
Flutter クライアントは失敗後に同じ画像を送り直せる（`07_api_workflow.md` §4.1）ので、再試行の回数だけ溜まる。
一時コンテナは非公開で、一時 URL の SAS は発行から15分で切れる（ログにも SAS を出さない）ため、
残った画像を外から取得される心配は小さいが、利用者が保存しなかった画像が1〜2日残る。

**残っている対処**: ライフサイクル管理だけでは1〜2日残るので、ハンドラでも片付ける。

1. **catch で一時ファイルを削除する**（一時保存が済んでいれば）。削除の失敗はログだけにして、
   元のエラーの分類（502 / 503 `AI_SERVICE_ERROR` など）を変えない。`uploadImageToTemp()` が
   SAS 生成の失敗時に行っている後片付けと同じ扱い。挙動変更なので、再現テスト（AI の呼び出しを失敗させ、
   一時コンテナが空であることを偽物の `store` で確かめる）を先に書く

### `updatePlant` で存在しない id への PUT が 404 ではなく 409 を返す

`api/src/functions/updatePlant.ts` は `imagePath` の重複チェックを
**存在チェックより先に**実行する。404 を返す唯一の経路は
`cosmosService.updatePlant()` の戻りが null のときなので、
重複チェックで止まると 404 に到達しない。

**実行時の症状**: 既に削除された（または存在しない）id に対して、
他レコードが使っている `imagePath` を添えて PUT すると
**409 `IMAGE_ALREADY_SAVED`** が返る。本来は 404 `PLANT_NOT_FOUND`。
クライアントは「画像が重複している」と誤解し、実際の原因
（対象の植物が存在しない）に気づけない。

リトライで起こりうる。保存に成功した画像で別レコードを更新しようとして、
その間に対象が削除されていた場合など。

**判断が必要な点**: 順序を入れ替えるか。

**推奨**: **入れ替える。** 先に `getPlantById(plantId)` で存在を確認して
404 を返し、そのうえで重複チェックを行う。読み取りが1回増えるが、
404 と 409 の意味が正しくなる。

副産物として、**`imagePath` が変わっていない場合に重複チェックを
丸ごと省略できる**（現在の記録と同じ `imagePath` なら新たな重複は
生まれない）。今は全件取得して「自分が持っているか」で判定しているが、
既存レコードを読むならもっと直接的に書ける。

挙動変更なので Red テストを先に書くこと。既存の 409 のテストに
影響しないかも確認が必要。

### 接続障害の判定が Cosmos DB 側の6箇所に複製され、AI・ストレージ側と書き方も違う

接続障害（503）の判定は2つの書き方に分かれている。

| 判定 | 書き方 | 見る `code` |
|---|---|---|
| Cosmos DB を使う6箇所（`checkDuplicate.ts` / `plantDetail.ts` の GET と DELETE / `plants.ts` / `save.ts` / `updatePlant.ts` の catch） | トップレベルの `error.code` を直接比べる。同じ条件を6箇所に手で写している | `ENOTFOUND` / `ECONNREFUSED` |
| AI 由来（`identify`・`upload`） | `createUpstreamErrorResponse()`（`utils/response.ts`）が `UpstreamError` を `hasCauseCode()`（`utils/errors.ts`）で `cause` のチェーンまでたどる。`code` の集合は同ファイルの `UPSTREAM_ERROR_RESPONSES` に service ごとに置いてある | `ENOTFOUND` / `ECONNREFUSED` |
| ストレージ由来（`upload`） | 同上 | `ENOTFOUND` / `ECONNREFUSED` / `ETIMEDOUT` |

AI・ストレージ側は1つの表にまとまっているが、Cosmos DB 側とは別に書かれているので**既にずれている**
（下記「`ETIMEDOUT` を 503 に分類するのは `upload` のストレージ由来だけ」がその結果）。
Cosmos DB を使う6箇所はトップレベルの `code` しか見ない（Cosmos SDK が errno をどこに載せるかは未確認）。

**推奨**: Cosmos DB 側の6箇所も、`hasCauseCode()` と共通の `code` の集合を使う1つの述語
（`isConnectivityError(error)` など）から判定する。
`ETIMEDOUT` の追加（下記）は同じ集合に触るので、**まとめて1つの作業単位にするのが効率的**。

### `ETIMEDOUT` を 503 に分類するのは `upload` のストレージ由来だけ

接続障害の分類が `upload` のストレージ由来と、それ以外の判定で1つずれている。

| 判定 | 503 に分類する `code` |
|---|---|
| `upload` のストレージ由来 | `ENOTFOUND` / `ECONNREFUSED` / **`ETIMEDOUT`** |
| `upload` の AI 由来・`identify` | `ENOTFOUND` / `ECONNREFUSED` のみ（`ETIMEDOUT` は 502 `AI_SERVICE_ERROR`） |
| `save` / `plants` / `updatePlant` / `plantDetail`（2箇所） / `checkDuplicate` | `ENOTFOUND` / `ECONNREFUSED` のみ（`ETIMEDOUT` は 500 `INTERNAL_ERROR`） |

**実行時の症状**: Cosmos DB への接続がタイムアウトした場合、
`GET /api/plants` 等は 503 ではなく 500 `INTERNAL_ERROR` を返す。
タイムアウトは時間を置けば回復しうる障害なので、クライアントの
再試行判断を誤らせる（54ae670 で `ENOTFOUND` について直したのと同じ型の問題）。
AI 識別の呼び出しの `ETIMEDOUT` は 502 になる（OpenAI SDK のタイムアウトがチェーンに `ETIMEDOUT` を持つかは未確認）。

**判断が必要な点**: Cosmos DB 側の6箇所と AI 由来の判定に `ETIMEDOUT` を足すか。

**推奨**: **足す。** タイムアウトは「到達できていない」側なので 503 が適切で、
すべての判定が同じ集合を見ているのが素直。`upload` のストレージ由来だけが正しい状態になっている。

**今回のセッションで実装しなかった理由**: 6エンドポイントのステータスコードが
変わる契約変更であり、`ENOTFOUND` の件（バックログ項目として既に
人間がトリアージ済みだったもの）とは違って新しく出てきた判断である。
このリポジトリの TDD の規律（1サイクルで赤にするテストは1つだけ）に従うと
6サイクルに分かれる作業量でもある。

**着手時の手順**: 各ハンドラの既存の「DB接続エラーの場合は503エラー」テストを
`it.each(['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT'])` に広げる形が素直
（`upload.test.ts` に先行例がある）。実装後は仕様書の記述も更新すること
（`06_api_openapi.yaml` の `POST /images/upload` の 503 と `AIServiceUnavailable` / `AIServiceError` に
「`ETIMEDOUT` を 503 にするのは upload の Blob Storage の操作だけ」と明記してあり、
`06_api_design.md` の §6.2「502 / 503 の振り分けと `message`」と `07_api_workflow.md` §4.1 の表も該当する）。

### `plantDetail` の 503 分岐2箇所にテストが無い

`api/src/functions/plantDetail.ts` は GET と DELETE で別々に
`ENOTFOUND` / `ECONNREFUSED` の 503 分岐を持つが、
`tests/functions/plantDetail.test.ts` に 503 を期待するテストが1件も無い
（他の6ハンドラにはある。`identify` の 503 のテストはエラー分類の修正で加わった）。

偽物は `forcedReadError` / `forcedDeleteError` を既に持っているので、
`code` を設定したエラーを入れるだけで書ける。上記の `ETIMEDOUT` の作業と
同じ箇所を触るため、**まとめてやるのが効率的**。

### テストの軽微な改善（優先度低）

test-reviewer が指摘した、原則違反ではないが締められる点。

- **`FakeCosmosBackend<TDoc>` は止めたい方向を型で止められていない。**
  `FakeCosmosBackend<PlantSummary>` に完全な `Plant` を入れても通る（構造的部分型）。
  現状はテスト側が `const x: PlantSummary[] = [...]` とリテラルで宣言している
  規律に依存している
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

旅行アルバムの旅行の作成・編集ダイアログ（`mobile/lib/widgets/trip_edit_dialog.dart` の旅行名 100・メモ 1000）も同じ差がある
（2026-10-13 の `/code-review` で指摘）。上限の値もサーバの環境変数（`TRIP_NAME_MAX_LENGTH` など）と連動しない。
越えた場合はサーバの 400 の文言がダイアログにそのまま出て、入力は残るので、直して送り直せる。同じ判断で許容する。

---

## テストと仕様書の監査（2026-10-11）で見つかった項目

api / mobile の全テスト197件を仕様書（docs/01〜08、OpenAPI、README、DEPLOYMENT）と突き合わせた。
事実の追記と、どちらが正しいか明らかな食い違いは仕様書側を直した。
ここに残すのは**判断が必要なもの**と、**コード・テスト側のバグ**。

### エラーの `details` に内部例外のメッセージをそのまま返している

409 `DATABASE_ERROR`・500・502・503 では、catch した例外の `message`（SDK 由来の英語や、内部で包み直した文言）が
`details` に入る。仕様書には事実として追記した（「内容は安定しないのでクライアントは表示・分岐に使わない」）。

**決定済み（2026-10-11、人間）: `details` は契約外。** 契約はステータス・`code`・`message` まで（CLAUDE.md「レスポンス規約」）。

**残っている作業: テストが `details` の文言を固定するのをやめる。** `api/tests/functions/` の7ファイルで
`details:` を `toEqual` などで固定している箇所が35あり（2026-10-11、エラー分類の修正後の時点。修正前は37）、入力検証の固定文言と内部例外の文言の両方を含む。
付くか付かないかを確かめる必要があるもの以外は、`details` を期待値から外す（`expect.objectContaining` で
`code` と `message` だけを見るなど）。テストだけの変更なので、全テストが緑のまま1ファイルずつ直す（Refactor 段と同じ規律）。

**判断が必要な点（残り）**: 内部例外の文言を外に出し続けるか。
参考: 構成情報を応答に含めない方針（`api/src/constants/validation.ts` のコメント）と、
ヘルスチェックでは例外メッセージを出さない方針（上記「ヘルスチェックエンドポイント」）がある。

**推奨**: **出さない方向。** 500 系の `details` は省くか固定文言にし、原因はログ（Application Insights）で追う。

### upload のフォームデータのパース失敗が 400 にならない疑い（要確認）

`upload.ts` は「`TypeError` で、かつメッセージに `formData` を含む」ときだけ 400「ファイルの読み取りに失敗しました」を返す。
同梱の undici（5.x）は multipart の解析失敗で busboy のエラーを包んだ `TypeError` か `DOMException` を投げ、
`formData` を含む文言を作るのは multipart でない場合の分岐だけ（コードを読んでの推定。実行して確かめてはいない）。
テストは `new TypeError('Failed to parse formData')` を注入しており、実ランタイムの形ではない。

**やること**: 壊れた multipart を実際に送って何が返るか確かめる。500 になるなら判定条件を見直す。
仕様書には到達を確認できるまで書かない。

### `upload` のエラーのログに SAS 付きの一時 URL が混ざる可能性（要確認）

`upload.ts` は「一時保存完了」のログから SAS を除いたが、catch 節は `context.log('画像アップロード・植物判定エラー:', error)` で
エラーをそのまま出す。AI 識別サービスが画像を取得できなかったときのエラーメッセージに画像の URL が入るなら、
SAS 付きの一時 URL がログに残り、`details` としてクライアントにも返る（コードを読んでの推定。実際のエラーでは確かめていない）。
SAS は発行から15分で切れるので、取得できるのはその間に限られる。

**やること**: デプロイ先で、AI が一時 URL を読めない状況（例: 一時 Blob を先に消す）を作り、
エラーメッセージに URL が入るかを確かめる。入るなら、ログと `details` に出す前にクエリ文字列を除く。

### Application Insights への個人情報のマスキングが無い

`docs/05_technology_selection.md` §7.2 に「Application Insights: 個人情報のマスキング」とあったが、実装は無い
（`api/src` にもインフラ定義にも、テレメトリのプロセッサや関連する設定は無い）。仕様書から外してここに移した。
ハンドラは利用者の入力をそのままログに出している。例: `upload.ts` のファイル名、`identify.ts` の `contextInfo`（自由記述）、
`checkDuplicate.ts`・`plantDetail.ts` の植物名。アプリに利用者アカウントは無いが、ファイル名や自由記述には個人情報が入りうる。

**判断が必要な点**: ログに出す項目を減らすか、マスキングを入れるか、このままにするか。

### Cosmos のシステム項目が応答に含まれている可能性（要確認）

`getPlantById()` などは Cosmos が返したドキュメントをそのまま返しており、`_rid` / `_self` / `_etag` / `_attachments` / `_ts`
を除いていない。OpenAPI の `Plant` にこれらの項目は無い（コードを読んでの推定。実際の応答では確かめていない）。

**やること**: デプロイ先で `GET /api/plants/{id}` の応答を確認する。含まれていれば、除くか仕様に書くかを決める。
`GET /api/plants` は射影（`SELECT c.id, ...`）しているので含まれない（CLAUDE.md の「Cosmos のクエリを変更したら手で確認する」参照）。

### 監査で見つかったテスト側の問題

仕様との食い違いではなく、テストそのものの不備。

- **`updatePlant.test.ts` の 503 のテストが `code: 'ENOTFOUND'` に message `'Connection timeout'` を組み合わせている。**
  PUT では `ETIMEDOUT` は 503 にならないので読み手が誤解しやすい
- **修正前の状態を「現在の実装」と書いたコメントが残っている**: `api/src/services/storageService.ts` の 191〜192 行・319〜320 行付近、
  `api/tests/functions/upload.test.ts` の 532〜536 行付近
- **Flutter のテストの偽レスポンスが OpenAPI と細部で違う**: アップロードの `identificationResult` に `reason` を入れている、
  `isPlant: true` なのに `candidates: []`、植物IDに UUID でない `plant-1` を使っている。検証には影響しない
- **仕様にあるのにテストが無い振る舞い**: contextInfo の検証が一時保存と AI 呼び出しの前に行われること（upload の 501 文字のテストは Blob も OpenAI も見ていない）、
  503 になる `ECONNREFUSED`（植物図鑑の Cosmos DB を使うハンドラのテストは `ENOTFOUND` だけ）、
  identify の `contextInfo: null` と数値・オブジェクトの拒否、`CONTEXT_INFO_MAX_LENGTH` に有効な値を設定した場合
- **`api/host.json` の `http` がトップレベルにある**（正しくは `extensions.http`）。`routePrefix: "api"` は既定値と同じなので実害は無いが、
  `maxOutstandingRequests` などを設定するつもりでここに書いても効かない

---

## 画面設計の書き直し（2026-10-12）で見つかった項目

`docs/03_screen_design.md` を実装の写しに書き直し、`docs/08_flutter_ui_design.md` を削除したときに、
コードを読んで見つけたもの（`contract-auditor` の報告。日時の表示と処理中の画面操作はメインセッションがコードで確認した）。

### 識別結果で保存しなかった画像が永続コンテナに残る

`upload` は植物と判定した時点で、画像を永続コンテナ（公開読み取り）へ移す（`upload.ts`）。
識別結果確認画面で「やり直し」や戻る操作をすると、どのレコードからも参照されない画像が残る。
画像選択画面でアップロードと識別の処理中に戻った場合も同じ（クライアントは応答を待たずに画面を閉じるが、
サーバ側の処理は続いて画像を永続コンテナへ移す）。
画像だけを消す API は無く（`DELETE /api/plants/{id}` はレコード単位）、クライアントからは片付けられない。
初期の画面設計は「キャンセル時、画像は削除済み」としていたが、実装されていなかった。

**判断が必要な点**: どこで片付けるか。保存までは一時コンテナに置き、保存時に永続コンテナへ移す設計に変えるのが筋だが、
`upload` と `save` の契約（`imagePath` が指すコンテナ）が変わる。上記「`upload` で AI の呼び出しが例外で失敗すると、
一時保存した Blob が残る」のライフサイクル管理と合わせて考えるとよい。

### 科名の「科」が二重になる可能性（要確認、Dart）

識別結果確認画面と詳細画面は、科名の値の末尾に必ず「科」を付けて表示する。
一方、AI のスキーマの説明は「科名（日本語）」（`openAIVisionService.ts`）で、OpenAPI と 07 の例は `"バラ科"`。
AI が「バラ科」を返すと「バラ科科」と表示される。

**やること**: 実際の識別結果の `familyName` を確かめる。「科」まで含むなら、クライアントで付けるのをやめる。

### 画像選択画面のタイトルに「撮影」とあるが、撮影できない（Dart）

タイトルは「植物を撮影・情報入力」だが、画面はギャラリーからの選択だけを使う。
`AndroidManifest.xml` は CAMERA 権限を宣言している（使われていなかった `CameraService` は #24 で削除した）。

**判断: タイトルと権限から「撮影」を外す。** 旅行アルバムの要件（`docs/travel-album/01_requirements.md` の「対象外・未定」）で、
アプリからのカメラ撮影は当面入れないと決まった。

### 初期の設計にあって未実装の機能

03 の書き直しと 08 の削除、05・07 の整理で仕様書から外したもの。仕様書には実装済みのものだけを書くため外したが、
**新機能の要件定義の材料**として残す。実装すると決めたら「機能追加」へ移す。

| 機能 | 初期の記述 | 現状 |
|---|---|---|
| カメラでの撮影 | 05 §3.1・§4.3「画像選択・撮影」 | ギャラリーからの選択だけ（未使用だった `CameraService` は #24 で削除） |
| 重複時の比較画面 | 03「重複確認画面」: 既存と新しい写真を並べ、保持か置き換えかをラジオボタンで選ぶ | 文言だけのダイアログ（「キャンセル」「上書き保存」） |
| 識別結果でキャンセルしたときの画像の削除 | 03「キャンセル時、画像は削除済み」、07 §6.1「途中キャンセル時のクリーンアップ処理」 | 削除しない（上記「識別結果で保存しなかった画像が永続コンテナに残る」） |
| 処理中の中断 | 07 §6.3「長時間処理の途中キャンセル機能」 | 中断する操作は無い |
| 植物名の読み | 03「桜 (サクラ)」 | データモデルに読みの項目が無い |
| 候補・詳細の追加情報 | 03「日本原産」「開花時期」「分布」 | 該当する項目が無い |
| ヘルプ・サポート | 03 設定画面「使い方ガイド」「よくある質問」「お問い合わせ」（当時から「将来実装」） | 無い |
| 一覧のキャッシュ | 07 §5.2「一覧データのクライアントサイドキャッシュ」 | 表示のたびに取り直す（画像だけ `cached_network_image` でキャッシュ） |
| 自動の再試行 | 07 §5.2「ネットワークエラー時の自動再試行」 | 無い。再試行は利用者の操作による |
| 識別と重複確認の並列実行 | 07 §5.2 | 重複確認は利用者が選んだ候補の名前を使うので、識別の完了前には行えない |
| 利用状況の計測 | 05 §3.7「ユーザー行動分析」「カスタムイベント追跡」、07 §8.1「ユーザーの離脱ポイント」 | クライアントからのテレメトリも `trackEvent` も無い |
| アラート | 07 §8.2「AI識別サービスの応答時間異常」「データベース接続エラー急増」「画像アップロード失敗率上昇」 | Terraform にアラートの定義が無い |
| レスポンスのサニタイズ | 07 §6.2「XSS対策としてのレスポンスデータサニタイズ」 | 無い（Flutter は文字列をテキストとして描画するので、HTML の注入は起きない） |
| 設定画面でのユーザー管理 | 05 §7.1 選定理由 | ユーザー管理の機能は無い（設定は Function Key とエンドポイントの入力だけ） |
