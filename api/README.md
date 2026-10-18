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

```bash
cd api
npm run build
node dist/src/scripts/enqueueUnidentified.js          # 対象の枚数を数えるだけ（何も書かない）
node dist/src/scripts/enqueueUnidentified.js --apply  # 識別の待ちにする
```

要る設定は `COSMOS_DB_ENDPOINT`・`COSMOS_DB_KEY`・`COSMOS_DB_DATABASE`・`COSMOS_DB_ALBUM_CONTAINER`（キューの設定は要らない）。
どれかが無い・空白だけなら、何も読まずに `Cosmos の設定がありません: <足りない設定の名前>` を出して止まる（終了コード 1）。
最初に宛先（Cosmos のホスト・データベース・コンテナ）を出すので、`--apply` の前に本番を指しているかを確かめる。`--apply` の後、20 分ほどで識別が進む。進み具合は写真の `processing`（`pending` → `identifying` → `done`）で見る。

## テスト

- `tests/` は `src/` をミラーする。守り続けるテストは入口に置く（エンドポイントは `tests/functions/`、手で回すスクリプトは `tests/scripts/`）
- Cosmos DB / Blob Storage / Storage Queue の偽物は `tests/fakes/`、複数のテストが使うケースの表は `tests/helpers/`
- `tests/setup.ts` が環境変数と `openai` のモックをグローバルに設定する
- 変異テストは `scripts/mutate.js`（使い方は先頭のコメント）
- 原則は `.claude/test-principles.md`
