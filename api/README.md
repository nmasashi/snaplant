# SnapPlant API

Azure Functions v4（Node.js 22・TypeScript）で動く、植物識別と旅行アルバムの API。
仕様は植物図鑑が `docs/06_api_design.md`・`docs/06_api_openapi.yaml`、旅行アルバムが `docs/travel-album/05_api_design.md`。
デプロイの手順と環境変数は `DEPLOYMENT.md`。

## コマンド

```bash
npm ci                    # package-lock.json どおりに入れる。lock が変わったらやり直す
npm start                 # prestart で build + func extensions install を実行してから func start（Azure Functions Core Tools が要る）
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

## tsconfig が4つある理由

| ファイル | 用途 |
|---|---|
| `tsconfig.base.json` | 共通設定 |
| `tsconfig.json` | ビルド用（`src` のみ・emit あり）。`npm run build` が使う |
| `tsconfig.test.json` | 型チェック用（`src` + `tests`・`noEmit`）。Jest もこれを使う |
| `tsconfig.editor.json` | IDE 用（上の2つを project references で束ねる） |

## 関数の登録

`src/app.ts` が唯一のエントリーポイント（`package.json` の `main` は `dist/src/app.js`）。
各関数ファイルは末尾で `app.http(...)`（キューのトリガーは `app.storageQueue(...)`、タイマーは `app.timer(...)`）を呼び、`app.ts` が全ファイルを import することで登録が走る。
新しい関数を足したら `app.ts` に import を足す。足し忘れると、その関数は一切登録されない（HTTP の関数は 404 になり、キューのワーカーはメッセージを取らず、タイマーは走らない）。

HTTP の関数はすべて `authLevel: 'function'` なので、呼び出しには `?code={FUNCTION_KEY}` が要る。
ルートの一覧は `README.md`（リポジトリ直下）のエンドポイント表。

キューのトリガーの関数は、旅行アルバムの写真の解析のワーカー `processPhoto`（`src/functions/processPhoto.ts`）だけ。
キューの名前はアプリの設定 `PHOTO_QUEUE_NAME` から `%PHOTO_QUEUE_NAME%` で解決し、接続は `AzureWebJobsStorage`（設定値は `docs/travel-album/07_infrastructure_design.md` §6.1）。

タイマーの関数は旅行アルバムの2つ（スケジュールは UTC の cron。設計は `docs/travel-album/06_processing_design.md` §1.1）。

| 関数（`app.timer` の第1引数） | ファイル | スケジュール | 内容 |
|---|---|---|---|
| `requeueStalePhotos` | `src/functions/requeueStalePhotos.ts` | `0 */10 * * * *`（10 分ごと） | 解析待ち・処理中のまま 10 分以上止まった写真を解析待ちに戻してキューに積む。回数が上限なら失敗にする |
| `sweepAlbum` | `src/functions/sweepAlbum.ts` | `0 0 18 * * *`（毎日 UTC 18 時 = 日本時間の午前3時） | 文書の無い古い Blob を消し、消えた旅行を指す写真を未所属に戻し、原寸の Blob の無い写真をログに出す |

## 手で回すスクリプト

`src/scripts/` にあり、`app.ts` からは import しない（関数としては登録されない）。ビルドしてから手元で回す。
環境変数が無ければ `local.settings.json` の `Values` を読む（中身はログに出さない）。**本番のデータを書くので、回すのは人間。**

| スクリプト | 内容 | 設計 |
|---|---|---|
| `src/scripts/enqueueUnidentified.ts` | 段階3で分類まで済んだ写真（`done`・図鑑の種類・識別なし）を識別の待ちにする。キューには積まず、再投入のタイマーが 10〜20 分後に積む | `docs/travel-album/06_processing_design.md` §1 |
| `src/scripts/migratePlants.ts` | 植物図鑑の記録（`plants`）を、植物1件につき写真1枚（識別の済んだ、どの旅行にも属さない写真）として `album`・`photos` に移す。`plants`・`images` は読むだけ | `docs/travel-album/06_processing_design.md` §7.1 |

設定の読み込みと宛先の表示は `src/scripts/scriptSettings.ts` が共有する。

### 写真を識別の待ちにする（`enqueueUnidentified`）

```bash
cd api
npm run build
node dist/src/scripts/enqueueUnidentified.js          # 対象の枚数を数えるだけ（何も書かない）
node dist/src/scripts/enqueueUnidentified.js --apply  # 識別の待ちにする
```

要る設定は `COSMOS_DB_ENDPOINT`・`COSMOS_DB_KEY`・`COSMOS_DB_DATABASE`・`COSMOS_DB_ALBUM_CONTAINER`（キューの設定は要らない）。
どれかが無い・空白だけなら、何も読まずに `Cosmos の設定がありません: <足りない設定の名前>` を出して止まる（終了コード 1）。
最初に宛先（Cosmos のホスト・データベース・コンテナ）を出すので、`--apply` の前に本番を指しているかを確かめる。`--apply` の後、20 分ほどで識別が進む。進み具合は写真の `processing`（`pending` → `identifying` → `done`）で見る。

### 植物図鑑の記録を写真へ移す（`migratePlants`）

先に退避（`infrastructure/README.md`「植物図鑑の退避」）を済ませる。

```bash
cd api
npm run build
node dist/src/scripts/migratePlants.js          # 移す植物を数え、飛ばす植物を出すだけ（何も書かない）
node dist/src/scripts/migratePlants.js --apply 2>&1 | tee "<退避先>/migrate.log"  # 移す。出力を退避先にも残す
```

`<退避先>` は手順 1 で `plants.json` と画像を置いたフォルダ（リポジトリの外）。ログには植物の名前と id が出る（鍵は出ない）。

要る設定は `COSMOS_DB_ENDPOINT`・`COSMOS_DB_KEY`・`COSMOS_DB_DATABASE`・`COSMOS_DB_CONTAINER`（読む元の `plants`）・`STORAGE_CONNECTION_STRING`・`STORAGE_CONTAINER_NAME`（読む元の `images`）。
どれかが無い・空白だけなら、何も読まずに `設定が足りません: <足りない設定の名前をすべて>` を出して止まる（終了コード 1）。
書く先の `COSMOS_DB_ALBUM_CONTAINER`・`PHOTO_STORAGE_CONTAINER_NAME` も、`--apply` が無いときを含めて要る（無ければ `plants` を読む前に止まる。読むだけの実行が通れば、`--apply` も設定では止まらない）。

最初に宛先を2行出す。`読む元:` に Cosmos のホスト・データベース・植物のコンテナと、画像のストレージアカウント・コンテナ、
`書く先:` に写真のコンテナと写真の保存先のコンテナ（鍵は出さない）。`--apply` の前に本番を指しているかを確かめる。

続いて `植物図鑑の記録: <件数> 件`、飛ばした植物を1件ずつ `飛ばしました: <名前>（植物 ID=<植物の id>）: <理由>`、最後に `移した植物: <件数> 件、飛ばした植物: <件数> 件` を出す（`--apply` が無ければ `移す植物: <件数> 件、飛ばす植物: <件数> 件（--apply が無いので、何も書いていません）`）。
読むだけの実行でも、`--apply` のときと同じ確かめ（先にある写真を含む）で一覧が出るので、先に読むだけで回して一覧を見てから `--apply` する（同じ画像の植物が2つあると、読むだけの実行では写真がまだ無いので2つとも移す植物に数え、`--apply` では2つ目が `同じ写真が先にある` になる）。
この `飛ばしました:` の行が飛ばした植物の一覧で、ほかの場所には残らない（`grep 飛ばしました "<退避先>/migrate.log"` で見る）。理由は4つ（`docs/travel-album/06_processing_design.md` §7.1）。

- `画像が見つからない`・`画像の URL が images コンテナの Blob ではない`・`画像の形式（…）が写真として受け付けないもの`: その植物は移っていない。退避した `plants.json` と画像を見て、捨てるか手で入れるかを決める
- `同じ写真が先にある（写真 ID=…）`: その写真の `legacyPlantId` を見る。この植物の id なら前の回で移したもの、別の植物の id なら同じ画像の植物が先に移ったもの、無ければ旅行アルバムに同じ写真を送っていたもの（その写真の `identification` が `null` なら乗せるかを決める）

途中で止まったら（`植物図鑑の記録を移すスクリプトが失敗しました:` と原因の例外が出て、終了コードは 1。`tee` でつなぐと終了コードは `tee` のものになるので、出力で見る）、原因を直してもう一度 `--apply` で回す。移した植物は `同じ写真が先にある` として飛ばすので、写真は重複しない。
確認（件数・`legacyPlantId` の突き合わせ）は `docs/travel-album/06_processing_design.md` §7 の手順 3。

## テスト

- `tests/` は `src/` をミラーする。守り続けるテストは入口に置く（エンドポイントは `tests/functions/`、手で回すスクリプトは `tests/scripts/`）
- Cosmos DB / Blob Storage / Storage Queue の偽物は `tests/fakes/`、複数のテストが使うケースの表は `tests/helpers/`
- `tests/setup.ts` が環境変数と `openai` のモックをグローバルに設定する
- 変異テストは `scripts/mutate.js`（使い方は先頭のコメント）
- 原則は `.claude/test-principles.md`
