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

## コマンド

### api/

```bash
cd api
npm install
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
flutter test test/widget_test.dart
flutter build apk --release
```

**これらのコマンドは WSL から実行できない。** Flutter SDK は Windows 側
(`/mnt/c/Users/masas/flutter`) にあり、シェルスクリプトが CRLF 改行のため
`/usr/bin/env: 'bash\r': No such file or directory` で起動に失敗する。
WSL 側で Android Studio が動かなかった経緯もあり、Flutter の実行・解析・テストは
すべて Windows 側で行う運用。

つまり **Dart コードを変更したら、WSL セッションでは検証できない。**
静的解析やテストを試みず、「Windows 側で `flutter analyze` / `flutter test` を
実行してください」と明示して引き渡すこと。実行していないものを実行したように書かない。

api (TypeScript) 側は WSL で `npx tsc` / `npm test` が普通に動くので、こちらは自分で検証する。

`test/` にはスモークテスト1本しかない。

### infrastructure/

```bash
cd infrastructure
cp terraform.tfvars.example terraform.tfvars   # openai_api_key を設定
./scripts/deploy.sh                            # terraform apply 一式
./scripts/get-publish-profile.sh               # GitHub Secrets 用の Publish Profile 取得
./scripts/destroy.sh
```

`terraform.tfstate` はローカルファイルとしてリポジトリに入っている（リモートバックエンドなし）。

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

`plants/{id}` は `plantDetail.ts` と `updatePlant.ts` の2ファイルが別々に登録している（メソッドが異なるため共存可能）。片方だけ見て全体を判断しないこと。

### 画像アップロードが3役を兼ねる設計

`upload.ts` は単なるアップロードではなく、**一時保存 → AI 判定 → 永続化** を1リクエストで完結させる。ここがこのアプリの設計上の核心。

1. `uploadImageToTemp()` で temp コンテナに保存（SAS トークン付き URL を返す）
2. `OpenAIVisionService.validateImage()` → `identifyPlant()` で植物判定
3. 植物でなければ temp ファイルを削除し `NOT_A_PLANT` エラーを返す
4. 植物なら `moveFromTempToPermanent()` で images コンテナへ移動（公開 URL を返す）
5. 画像 URL と識別候補をまとめて返す

Blob Storage のコンテナは2つで役割が違う：`images`（永続・公開 URL）と `temp`（一時・SAS 付き URL）。`StorageService` は URL 文字列にコンテナ名が含まれるかで判定を分岐するため、コンテナ名の変更は URL 解析ロジックに影響する。

### レスポンス規約

すべてのハンドラは `utils/response.ts` のヘルパー経由でレスポンスを作る。生の `HttpResponseInit` を手書きしない。

- 成功: `createSuccessResponse(data, statusCode?)` → `{ success: true, data }`
- 失敗: `createErrorResponse(code, message, statusCode, details?)` → `{ success: false, error: { code, message, details } }`
- 定型エラー: `createValidationError()` / `createNotFoundError()` / `createInternalError()`

`code` は `types/api.ts` の `ErrorCode` enum、ステータスは `HttpStatusCode` enum から選ぶ。新しいエラー種別が必要なら enum に追加する。

### Cosmos DB

パーティションキーは `/id`（Terraform で定義）。そのため単一ドキュメント操作は `container.item(id, id)` と id を2回渡す形になる。`CosmosService` は `StorageService` を内部に持つ。`updatePlant()` で `imagePath` が変わった場合のみ旧画像を Blob から削除する（削除失敗はログだけ出して処理は継続）。一方 `deletePlant()` は**ドキュメントだけ消して画像は残す**ので、孤児 Blob が残る。

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

`constants/validation.ts` の各上限値は環境変数で上書きできる（`MAX_FILE_SIZE`, `PLANT_NAME_MAX_LENGTH` など）。エラーメッセージも同じ環境変数から文字数を埋め込んで生成されるため、値を変えるとメッセージも追従する。マジックナンバーをハンドラに直接書かない。

## 実装の進め方: TDD

**新機能の実装とバグ修正は TDD で進める。**

Kent Beck の Canon TDD に従い、**「リスト、レッド、グリーン、リファクタ」の4段**とする。
「Red-Green-Refactor」の3段で語られることが多いが、**テストリストの段が落ちている**。
ここを飛ばすと、何をテストすべきかを考えずに手近なテストから書き始めてしまう。

| 段 | やること | 担当 |
|---|---|---|
| **List** | 押さえるべきテストシナリオを洗い出し、リストにする | メインセッション |
| **Red** | リストから**1つだけ**選び、失敗するテストを書いて落ちることを確認 | `test-writer` |
| **Green** | 最小の実装で、そのテストと既存の全テストを通す | メインセッション |
| **Refactor** | 振る舞いを変えずに整理する。**ここで初めて設計判断を行う** | メインセッション |

リストが空になるまで Red に戻って繰り返す。

`test-writer` は Red を確認した時点で引き渡す（本番コードを書けないため）。
実装はメインセッションが受け取る。この分担は「サブエージェント」節を参照。

### 守るべき点

- **テストリストを先に作る。** 1つ目のテストを書く前に、
  カバーすべきシナリオを列挙する。実装中に気づいたものはリストに追加し、
  そのとき書き始めずに現在のサイクルを完了させる
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
| テストの**期待値の意味** | 変更しない。変えたら振る舞いを変えている |

冗長なテストの削除は判断を伴う。基準は `.claude/test-principles.md` の原則5
（論理的従属性、確信、意思疎通の3段で判断する）。

**本番コードとテストコードを同時に変更しない。**
両方に欠陥が入ると互いを隠蔽し、テストが通っているのに壊れている状態になる。
本番コードの変更を終えて全テストが緑になってから、テストの再構成に取りかかり、
**1変更ごとにテストを実行する**。

### バグ修正の場合

**先に再現するテストを書く。** 直してから確認するのではなく、
再現テストが赤になることを確認してから修正する。
これが退行テストとして残り、同じバグの再発を防ぐ。

`debug-investigator` の報告にある「修正を検証する方法」が、この再現テストの仕様になる。

### TDD を適用しない場合

- **取るに足らないコード** — テスト自体を書かない方針なので TDD の対象外。
  判断基準は `.claude/test-principles.md` の原則5
- **設計を探るための試作** — 捨てる前提のコードには適用しない。
  ただし残すと決めた時点でテストを書く
- **既存テストの書き直し・整理** — Red-Green のサイクルではない。
  本番コードの振る舞いを変えずにテストの構造を直す作業なので、
  Refactor 段と同じ規律（全テストが緑の状態で、1変更ごとに実行）で進める
- **Flutter 側（`mobile/`）** — WSL から `flutter test` を実行できないため、
  このシェルでは赤緑のサイクルを回せない。
  テストを書いてから実装する順序は維持し、**実行と確認は Windows 側で行う**。
  赤の確認を飛ばしたまま実装を進めないこと

## レビューのタイミング

**TDD の1サイクルごとにはレビューしない。** サイクルは小さく頻繁なので無駄が大きい。

レビューは**テストリストが空になった時点**、つまり1つの作業単位が完了したときに行う。
これはコミット前と同じ瞬間になる。差分が溜まりすぎてからでは精度が落ちるため、
**作業単位ごとに1回**を守る。

### 何を回すか

| 条件 | 手段 | 見るもの |
|---|---|---|
| **常に** | `/code-review` | 差分のバグと、再利用・簡約・効率の整理 |
| テストを書いた・直した | `test-reviewer` | 古典学派の原則への準拠 |
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

### レビュー後

指摘への対応はメインセッションが行う。機械的に適用してよい指摘が多ければ
`/code-review --fix` で差分へ適用できる。

**レビューは CI の代替ではない。** push 後に CI がテスト・`npm audit`・CodeQL を回す。
レビューはその前段で、CI が見ない設計と可読性の問題を拾う。

### レビューしない領域

- **ドキュメントのみの変更** — `/code-review` は差分のコードを見るので効果が薄い。
  人間が読んで確認する
- **サブエージェントの成果物** — `test-writer` のテストは `test-reviewer` が見るが、
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
- **Flutter 側のアーキテクチャ方針は未決定。**
  状態管理・ルーティング・HTTP クライアントの選択が `pubspec.yaml` の宣言と
  実装で食い違っている（`docs/10_proposals.md` に検討課題として記録済み）。
  決まるまでは**現状の実態に合わせる**こと:
  状態管理は `setState`、HTTP は `http`、ルーティングは `main.dart` の手書き

`provider` / `go_router` / `dio` / `uuid` / `intl` は `pubspec.yaml` にあるが
使用実績ゼロ。**これらを使い始める前に方針を決めること。**

## テストの流儀

**テストを書く・直す・レビューする前に `.claude/test-principles.md` を読むこと。**
このリポジトリは Khorikov『単体テストの考え方/使い方』の古典学派の立場を取る。
専用のサブエージェント `test-writer`（執筆）と `test-reviewer`（レビュー、読み取り専用）があり、
どちらも同じ原則ファイルを基準に動く。

最重要の原則は、**テストダブルの検証可否を依存の種類で決める**こと。
Cosmos DB / Blob Storage は管理下にある依存なので、モックは運用上の例外として許容するが
**やり取りの検証はしない**。OpenAI API は管理外の依存なのでモックと検証の両方が正当。

既存テストの事実（新規テストで踏襲しないもの含む）：

- `tests/setup.ts` が `setupFilesAfterEnv` でグローバルに環境変数と Azure SDK / openai のモックを設定し、`console.log` も抑制する
- 各テストファイルは**それに加えて**個別に `jest.mock()` と環境変数を設定する二重構造。追いにくいため新規テストはファイル内で完結させる
- ディレクトリ構成は `src/` をミラーする（`tests/functions/`, `tests/services/`, `tests/utils/`）
- テスト名は非開発者にも通じる日本語の文で書く（この慣習は踏襲する）
- `testTimeout` は 10 秒
- **既存テストには原則違反（スタブへの呼び出し検証）が多数含まれている。** 検証のしかたは踏襲しないこと

## サブエージェント

`.claude/agents/` に専用のサブエージェントがある。

| 名前 | 役割 | 書き込める範囲 |
|---|---|---|
| `test-writer` | 原則に沿ったテストの執筆と実行 | **テストコードのみ** |
| `test-reviewer` | テストの原則準拠レビュー | なし（読み取り専用） |
| `contract-auditor` | 実装とドキュメント・クライアントの乖離検出 | **仕様書・設計文書・README のみ** |
| `dep-upgrader` | 依存パッケージの段階的更新 | 依存定義とロックファイル、移行に伴う機械的な追従 |
| `debug-investigator` | 不具合の原因調査と修正案の提示 | なし（読み取り専用） |
| `improvement-scout` | 根拠付きの改善提案 | **提案文書のみ** |

**どのエージェントも `.claude/` 配下を書き換えない。**
エージェント定義と `test-principles.md` はエージェント自身の振る舞いを決める文書であり、
エージェントが自分の基準を書き換えられる状態にしない。
記述の不備は報告させ、**人間が判断して直す**。

`dep-upgrader` と `test-writer` はコミット・プッシュをしない。

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

- `.github/workflows/ci.yml` — テスト・カバレッジ・ビルド・`npm audit`・CodeQL。トリガーは `api/` と `.github/workflows/` 配下の変更のみ。`mobile/` と `infrastructure/` は CI の対象外で、Flutter のテストも `flutter analyze` も自動実行されない。
- `.github/workflows/deploy-functions.yml` — `main` への push で ci.yml を呼んでから本番デプロイ
- デプロイは `scm-do-build-during-deployment: false` / `enable-oryx-build: false`。つまり**サーバ側でビルドしない**ため、ワークフロー内で `npm run build` 済みの `dist/` がそのままパッケージされる。ビルド出力パスを変える場合はデプロイ設定とあわせて確認する

## ドキュメントの扱い

**仕様書には実装済みのものだけを書く。** 未実装の機能や既知の課題は `docs/09_backlog.md` に置く。
この分離により、`docs/06_api_openapi.yaml` を「実装の正確な写し」として信頼できる状態に保つ。

記録先は確度で3段に分かれており、**混ぜない**こと。

| 文書 | 内容 | 書き込む主体 |
|---|---|---|
| 仕様書・設計文書（`docs/01`〜`08`, README, DEPLOYMENT） | **実装済みの事実** | 人間、`contract-auditor` |
| `docs/09_backlog.md` | **検証済みで実在する**課題・未実装機能 | 人間、根拠を確認したエージェント |
| `docs/10_proposals.md` | **トリアージ待ちの提案**（未採用） | `improvement-scout` のみ |

採用した提案は**人間が**バックログへ移す。却下した提案は理由を添えて
提案文書の「却下」節へ残す（同じ提案の蒸し返しを防ぐため）。
`improvement-scout` はバックログに書き込まない。バックログの
「すべて検証済み」という性質が信頼性の源だから。

API を変更したら、あわせて更新する対象：

- `docs/06_api_openapi.yaml` — ルート、リクエスト/レスポンス形状、ステータスコード
- `docs/06_api_design.md` / `docs/07_api_workflow.md`
- `README.md` のエンドポイント表
- `mobile/lib/services/api_service.dart` — クライアント側の呼び出し

### クライアント実装で踏みやすい罠

API のレスポンスは必ず `{ success, data }` の封筒に包まれている。
Flutter 側の `_parseResponse()` は**ボディ全体**をコールバックに渡すため、
各メソッドが自分で `json['data']` を剥がす必要がある。これを忘れると実行時に
`fromJson` がキーを見つけられず失敗する（過去に `identifyPlant()` と `uploadImage()` で発生）。

さらに封筒の内側のキーが関数ごとに違う点にも注意：

| エンドポイント | `data` の中身 |
|---|---|
| `GET /api/plants` | `{ plants, total }` |
| `GET` / `PUT /api/plants/{id}` | `{ plant }` |
| `POST /api/plants/save` | `{ plant }` |
| `DELETE /api/plants/{id}` | `{ message }` |
| `POST /api/plants/identify` | `{ result }` |
| `GET /api/plants/check-duplicate` | `DuplicateCheckResult` を直接 |
| `POST /api/images/upload` | `{ imagePath, fileName, contentType, fileSize, identificationResult }` |
