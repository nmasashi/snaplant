# SnapPlant mobile

Flutter 製の Android アプリ（植物図鑑と旅行アルバム）。
画面の仕様は `docs/03_screen_design.md`（植物図鑑）と `docs/travel-album/03_screen_design.md`（旅行アルバム）、
技術の選び方は `docs/05_technology_selection.md`。

## コマンド

```bash
flutter pub get
flutter run               # デバッグ版を端末に入れて起動する（下記）
flutter analyze           # flutter_lints 準拠
flutter test
flutter test test/services/api_service_test.dart
flutter build apk --release
```

- `flutter analyze` の指摘は0件にしてある（2026-10-12、#24）。info も含めて1件でも出れば CI（`flutter.yml`）が失敗する
- Dart を変えたら、その場で `flutter analyze` と `flutter test` を回す
- CI の Flutter の版は手元と同じ 3.32.8 に固定している。上げるときは手元と一緒に上げる
- 日時の表示のテストは日本時間を前提にしている。CI は `TZ=Asia/Tokyo` で動かす

## デバッグ版は別のアプリとして入る

`flutter run` で入るデバッグ版は、普段使いのリリース版とは別のアプリになる（`android/app/build.gradle` の `applicationIdSuffix`）。

| | パッケージ名 | ホーム画面の名前 |
|---|---|---|
| リリース版 | `com.snaplant.mobile` | SnapPlant |
| デバッグ版 | `com.snaplant.mobile.debug` | SnapPlant 開発版 |

- 2つは設定（エンドポイント・API キー）を別々に持つ。デバッグ版を初めて入れたときは、設定画面で API キーなどを入れ直す
- 分けた理由: 以前は同じパッケージ名で、署名の鍵が違うと `flutter run` が古い版を黙ってアンインストールし、端末に保存した API キーなどの設定が消えた（2026-10-13）

## 実機で確かめるときの注意

- Android 10 では、「写真を追加」で開く写真の選択画面のアプリによって、複数選択できないことがある。端末のギャラリーは1枚しか選べず、「ファイル」（長押しで複数選択）なら選べる。アプリからは選ぶアプリを決められない
- 300枚を選ぶと、写真を選ぶ部品が1枚ずつ縮小してから返すので、受け取るまで10分ほど待つ（その間は「写真を読み込み中...」）。実測は `docs/09_backlog.md`「段階2の結果」

## テスト

`test/` の構成。

| ファイル | 対象 |
|---|---|
| `services/api_service_test.dart` | `ApiService` の封筒の解釈（成功・エラー）と、送信する Content-Type（マジックバイトによる画像形式の判定を含む） |
| `screens/identification_screen_test.dart` | 保存時の 409 の扱い |
| `screens/camera_screen_test.dart` | 処理中の画面操作（選び直し・戻る）と、取り込みに失敗したときの表示 |
| `app_root_test.dart` | 設定の有無・読み込みの失敗・リセットに応じた起動直後の表示（アプリ全体を開く） |
| `screens/home_shell_test.dart` | 下のタブ（図鑑 / 旅行）の切り替えと、切り替えても一覧を読み直さないこと |
| `screens/trip_list_screen_test.dart` | 旅行一覧の表示・読み込みの失敗と読み直し、旅行の作成、旅行に属さない写真の画面（複数選択の操作と枚数の取り直しを含む）、旅行詳細から戻った後の送信の進み具合と一覧の読み直し（旅行アルバム） |
| `screens/trip_detail_screen_test.dart` | 旅行詳細の表示、編集、削除（写真を残すか消すか）、旅行が既に無いとき、写真のグリッド（ページ・失敗・読み直し）、写真の複数選択と旅行への出し入れ・削除、写真の追加と送信（EXIF、進み具合バナー、失敗と送り直し、画面をまたぐ送信、サムネイル、地名）、送信中の旅行の削除の確認と送信の取り消し（旅行アルバム） |
| `screens/photo_viewer_screen_test.dart` | 写真ビューア（旅行詳細・旅行に属さない写真から開く。スワイプ、位置情報の表示、続きのページ、表示の切り替え、削除、戻ったときの読み直し）（旅行アルバム）。スワイプは画面の幅より短く払う（`_swipe`。幅を超えて引くと2枚分進む） |
| `screens/pending_photo_tiles_test.dart` | 送信中・失敗の写真をグリッドの後ろに端末の画像で並べること（旅行詳細・旅行に属さない写真。宛先、一区切りまでの扱い、0枚の旅行、続きのページ。カテゴリの写真の画面と図鑑の項目詳細には並べない）（旅行アルバム）。サーバの写真の画像を出したまま送信の実時間を進めるので、`path_provider` をファイル全体で1回だけ差し替え、各テストの終わりに画像のキャッシュの掃除のタイマー（10 秒）を過ぎるまで進める |
| `screens/photo_classification_test.dart` | 写真の分類の表示（ビューアのカテゴリと状態、サムネイルの印と読み上げ）と、解析のやり直し（ダイアログの事前入力・空白だけの手がかり・キャンセル・失敗・受け付けた後のビューアと一覧の表示）（旅行アルバム。段階3） |
| `screens/category_filter_test.dart` | カテゴリでの絞り込み（旅行詳細のチップ・0枚の案内・見出しの枚数・開き直すと「すべて」・選択モードの間はチップを出さない、旅行一覧の「カテゴリ」から開くカテゴリの一覧と、旅行をまたぐカテゴリの写真の画面（0枚の案内・「写真を追加」が無い・複数選択は削除だけ））（旅行アルバム。段階3） |
| `screens/catalog_screen_test.dart` | 図鑑のタブ（下のタブの「図鑑（新）」から開く。種類のタブ・項目の行・0件の案内・読み込み中、続きのページの `offset` の進め方（外れた項目があっても `limit` だけ進める、1ページ目がすべて外れても続きを読む、総数まで読んだら止める）、下に引っ張る読み直しとその失敗、別の種類のタブから戻ると読み直す、タブを開くまで図鑑の API を呼ばない、種類の一覧・項目の一覧・続きのページを読めないとき）（旅行アルバム。段階4） |
| `screens/catalog_entry_screen_test.dart` | 図鑑の項目詳細（図鑑のタブの項目の行から開く。見出し（信頼度・枚数・説明・特徴・種類の欄の順、値が無いときの「—」、配列の欄）、旅行をまたいで撮影の順に並ぶ写真と並べない写真（名前・種類の違い、分類と合わない写真）、記号や空白のある名前、続きのページ（見出しを書き換えない、項目が無くなっていたら読み終える）、読み込み中・取得の失敗と再試行、写真が無いときの表示と戻ったときの一覧の読み直し（「戻る」と端末の戻る操作）、写真ビューアから戻ったとき・下に引っ張ったとき・複数選択で削除したときの読み直し、古い読み直しの応答で見出しを戻さない、小さな端末で説明が長くても写真を出す、複数選択の操作は削除だけ）（旅行アルバム。段階4） |
| `screens/photo_thumbnail_test.dart` | 写真のサムネイルの画像を読み込めないときの表示（画像の取得まで実時間で待つので、他の画面のテストと分けている） |
| `screens/plant_detail_screen_test.dart` | 保存日時を端末の時刻で表示すること |
| `helpers/app_test_helpers.dart` | （テストではない）アプリ全体を開く `openApp`・セキュアストレージの偽物・ホストとキーを見分ける偽のサーバ `plantServer`・設定のリセットの手順 |
| `helpers/gallery_test_helpers.dart` | （テストではない）OS のギャラリーの偽物 `FakeMultiGallery`（`pickMultiImage`。返すのを止める `hold`、開かれた回数 `openCount`）・テストの画像を書き出す `writeTestImage`・1x1 の PNG とその SHA-256・EXIF（撮影日時・GPS）付きの JPEG を組み立てる `exifJpegBytes` |
| `helpers/image_compress_test_helpers.dart` | （テストではない）画像の圧縮の偽物 `FakeImageCompress`（`FlutterImageCompressPlatform.instance` を差し替える。Android の縮め方を再現し、EXIF の回転は再現しない）と、寸法を指定した PNG `pngBytesOfSize` |
| `helpers/geocoding_test_helpers.dart` | （テストではない）端末の Geocoder の偽物 `FakeGeocoding`（`GeocodingPlatformFactory.instance` を差し替える。引いた座標を `lookups` に残し、失敗・応答なしも作れる） |
| `helpers/trip_test_helpers.dart` | （テストではない）旅行の API の偽のサーバ `FakeTripBackend`（旅行を1つのリストで持ち、別の端末での変化はテストが書き換えて表す。1回だけの失敗は `failNext`、応答の保留は `holds`（放した時点の状態で中身が決まる）と `holdNextReply`（届いた時点で決まる）。写真の移動 `POST /api/photos/move` は本物と同じく 200 件の上限・空の配列・`tripId` のキーの省略を 400 で断り、写真の削除は無い写真に 404 `PHOTO_NOT_FOUND` を返す。解析のやり直し `POST /api/photos/{photoId}/process` は写真を分類の待ち（`pending`）にして手がかりを `hint` に書き、コメントを消して 202 を返す（`step` と手がかりの検証、無い写真の 404 も本物と同じ）。写真の一覧 `GET /api/photos` は `tripId` に加えて `category` でも絞り、`tripId` が無ければ旅行をまたいで `sortAt` の順に返す（どちらも無い・定義表に無いカテゴリは本物と同じ 400）。写真の一覧の続きは、最後に返した写真の後から。図鑑の種類の一覧 `GET /api/catalog/kinds` は本物の定義表と同じ3種類（`catalogKinds`）を返し、項目の一覧 `GET /api/catalog/entries` は `catalogEntriesByKind` を入れた順（本物は名前順なので名前順に入れる）に `offset` / `limit` で切って `total` を付ける（種類・ページの指定の 400 は本物と同じ）。`catalogVanishedNames` の名前はページから外すが `total` には数え、受け取った `offset` は `catalogOffsetsReceived`、図鑑の API が呼ばれた回数は `catalogRequestsReceived` に残す。項目の詳細 `GET /api/catalog/entry` は `catalogEntriesByKind` を使わず、`photosByTripId` の全部の写真から `identification` の種類と名前が合い `matchesKind` が true のものを `sortAt` の順に集め、信頼度の最も高い写真（同じなら識別の新しい写真）から `entry` を作る（`photoCount` は集めた枚数。合う写真が無ければ `entry: null`）。写真は `pageSize` 枚ずつ返し、受け取った名前と継続トークンは `catalogEntryQueriesReceived` に残す（種類・名前・トークンの形の 400 は本物と同じ文言）。識別済みの写真は `identifiedPhotoJson` で作る） |

テストの原則は `.claude/test-principles.md`。テスト環境で踏みやすい点（画面の大きさ、実時間とフェイクの時間、`path_provider` など）は、各テストファイルのコメントと `CLAUDE.md` の mobile の節にある。
