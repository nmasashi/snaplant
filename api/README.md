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
各関数ファイルは末尾で `app.http(...)`（キューのトリガーは `app.storageQueue(...)`）を呼び、`app.ts` が全ファイルを import することで登録が走る。
新しい関数を足したら `app.ts` に import を足す。足し忘れると、その関数は一切登録されない（HTTP の関数は 404 になり、キューのワーカーはメッセージを取らない）。

HTTP の関数はすべて `authLevel: 'function'` なので、呼び出しには `?code={FUNCTION_KEY}` が要る。
ルートの一覧は `README.md`（リポジトリ直下）のエンドポイント表。

キューのトリガーの関数は、旅行アルバムの写真の解析のワーカー `processPhoto`（`src/functions/processPhoto.ts`）だけ。
キューの名前はアプリの設定 `PHOTO_QUEUE_NAME` から `%PHOTO_QUEUE_NAME%` で解決し、接続は `AzureWebJobsStorage`（設定値は `docs/travel-album/07_infrastructure_design.md` §6.1）。

## テスト

- `tests/` は `src/` をミラーする。守り続けるテストは入口（エンドポイント）の `tests/functions/` に置く
- Cosmos DB / Blob Storage / Storage Queue の偽物は `tests/fakes/`、複数のテストが使うケースの表は `tests/helpers/`
- `tests/setup.ts` が環境変数と `openai` のモックをグローバルに設定する
- 変異テストは `scripts/mutate.js`（使い方は先頭のコメント）
- 原則は `.claude/test-principles.md`
