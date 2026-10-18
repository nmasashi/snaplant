import { Container } from '@azure/cosmos';
import { Plant, PlantSummary } from '../../src/types/plant';
import { TripDocument } from '../../src/types/album';

/**
 * 引数を見分ける状態持ちの偽物 Cosmos DB。
 *
 * ドキュメントを id をキーにした Map で保持する。保存・更新・削除が
 * 効いたかどうかを、呼び出しの検証ではなく Map の状態で確認できる。
 * Cosmos DB は管理下にある依存なので、モックは運用上の例外として
 * 許容するが**やり取りの検証はしない**。
 *
 * パーティションキーは `/id` なので、単一ドキュメント操作は
 * `container.item(id, id)` と id を2回渡す形になる。偽物も
 * `id !== partitionKey` なら見つからない扱いにして、片方を取り違える
 * 不具合を検出できるようにしている。
 *
 * ## read と replace / delete の非対称性
 *
 * 「アイテムなし」の表現方法が操作によって違う。実際の `@azure/cosmos` は
 * read（単一アイテム取得）に限り NotFound エラーを内部で飲み込み、
 * resource が undefined のレスポンスを返す（`Item.read` の実装: catch 節で
 * `error.code === StatusCodes.NotFound` のときは再スローせず、resource が
 * 無いレスポンスとして扱う）。一方 replace・delete は NotFound をそのまま
 * 例外として投げる。読み取りに限った実 SDK の挙動なので偽物もここに合わせる。
 *
 * read() が例外を投げる前提で書くと、本番で絶対に通らない catch 分岐を
 * テストすることになり、実際に通る `resource || null` の経路が無検証のまま
 * 緑になってしまう（過去にこの誤りがあった）。
 *
 * パーティションキーの取り違え（例: `item(id, 'wrong')`）の検出は、読み取りが
 * 例外を投げなくなっても失わない。id と partitionKey が一致しない場合は
 * resource を undefined にするため、取り違えが起きれば呼び出し側は
 * 「見つからない」という結果を受け取り、正しいドキュメントを期待する
 * テストが失敗する。
 *
 * ## ページ（`fetchNext`）
 *
 * `query(spec, { maxItemCount, continuationToken, enableQueryControl })` に対し `fetchNext()` が
 * `{ resources, continuationToken }` を返す。`maxItemCount` 件ずつ返し（無ければ残り全部）、続きがあれば
 * 絞り込み後の挿入順の位置を表す JSON の文字列を `continuationToken` に入れ、最後のページでは undefined にする
 * （実 SDK のトークンも JSON の文字列）。同じトークンを渡すと続きから返す。同じ iterator で `fetchNext` を
 * 呼び直しても続きから返す（実 SDK と同じく、iterator が位置を持つ）。
 * 渡されたトークンが JSON として読めなければ、実 SDK（`ContinuationTokenParser`）と同じく、`code` の無い普通の
 * Error（`Failed to parse continuation token: ...`）を投げる。JSON だが偽物が作った形でないトークンには、
 * 数値の `code` に 400 を持つエラーを投げる。こちらは**推測の再現**で、サービスが受け付けないトークンを
 * 400 で拒むかは実環境で確かめていない（05 §5.2 の表の 7 も「推測」）。実 SDK と同じと見なさないこと
 * （どちらも `fetchNext` を呼んだときに投げる）。
 * `fetchAll()` はページに関係なく絞り込み後の全件を返す（`enableQueryControl` の影響を受けない）。
 *
 * **`enableQueryControl: true` が無いクエリでは、継続トークンを返さず、渡されたら投げる。**
 * 実 SDK（4.10.1）は、パーティションをまたぐ ORDER BY のクエリでこれが無いと、1ページ目にトークンを返さず、
 * トークンを渡されると `Error('Continuation tokens are supported when enableQueryControl is set true in FeedOptions')`
 * を投げる（トークンの中身を読む前）。偽物も同じにして、付け忘れ（トークンが往復しない）をテストで検出できるようにする。
 * 偽物は SQL を解釈できず、パーティションをまたぐ ORDER BY かどうかを見分けられないので、`fetchNext` を使う
 * クエリすべてにこの条件を適用する（単一パーティションのクエリなど、実 SDK ならトークンを返せるものにも厳しい）。
 * 今 `fetchNext` を使うのは写真の一覧だけ。空の文字列のトークンは、実 SDK と同じく「トークン無し」として扱う。
 *
 * ## 結果がまだ揃っていない空のページ（`emptyPagesBeforeResults`）
 *
 * 実 SDK は、パーティションをまたぐクエリに `enableQueryControl: true` を付けると、その時点で取れた分を返し、
 * 結果が揃っていなければ**空のページ（`resources: []`）を継続トークン付きで**返す。`emptyPagesBeforeResults` に
 * 数を入れると、`enableQueryControl: true` のクエリの `fetchNext` が、実際の結果を返す前に、その回数だけ
 * 空のページとトークンを返す（`enableQueryControl` が無いクエリは、結果が揃うまで待つので空のページを返さない）。続きは、返ってきた
 * トークンを渡して作り直した iterator でも、同じ iterator の `fetchNext` の呼び直しでも読める。
 * 実際の結果のページの後も、次のページの前にまた同じ回数の空のページを返す（実 SDK はどのページの前でも空を返しうる）。
 *
 * ## patch
 *
 * `item(id, pk).patch(body)` は、操作の配列か `{ operations, condition }` を受け、`set` / `replace` / `remove` を
 * `path`（`/tripId` の1段、`/processing/state` の2段）に適用する。`id !== partitionKey` か、ドキュメントが無ければ
 * 実 SDK と同じ数値 `code` 404 を投げる。存在しない path への `replace` / `remove` は `code` 400（実 SDK も拒む）。
 * 適用は複製に対して行い、途中で失敗してもドキュメントは変わらない。
 * `condition` は `FROM c WHERE c.<path> = "<文字列>"` と `c.<path> = <整数>` を `AND` でつないだ形（ワーカーの担当の条件）と、
 * その項に `(IS_NULL(c.<path>) OR c.<path> = "<文字列>")` を置いた形（識別のコメントの条件）だけを解釈し、
 * 満たさなければ実 SDK と同じ数値 `code` 412 を投げる（ドキュメントは変わらない）。**それ以外の形は例外にする**（知らない条件を黙って通さない）。
 * 失敗の注入は `forcedPatchError`。「読んだ後・patch の直前に他の操作が書き換えた」は `beforePatch` で作る。
 *
 * ## 偽物では検証できないこと
 *
 * `items.query` は Cosmos SQL を解釈せず、渡されたパラメータ
 * （`@name` / `@imagePath` / `@type` / `@tripId` / `@category`、図鑑の `@kind` / `@entryName`（写真の `identification.kind` / `.name`））の値で絞り込むだけに留める。クエリ文字列自体への
 * 依存はリファクタリング耐性を失うため見ない。この簡略化の結果、
 * 次の点はこの層のテストでは検証できない（SQL 自体を解釈する実エミュレータ、
 * もしくは E2E テストに委ねる）:
 *
 * - WHERE句が実際に name / imagePath / tripId で絞り込む条件になっているか
 *   （パラメータの値さえ渡っていれば、絞り込み条件を丸ごと削除しても
 *   この偽物は気づかない）
 * - `@tripId` に null を渡したとき、実際の Cosmos が「tripId が null のものだけ」に絞るか。
 *   偽物は `tripId` が値と厳密に等しいものだけを返す（null なら null のものだけで、`tripId` の項目が
 *   無いドキュメントは含めない）。`c.tripId = @tripId` が null と項目の欠損をこう区別する前提は
 *   実環境で手で確かめる
 * - `ORDER BY c.createdAt DESC` や `ORDER BY c.sortAt` による並び順（偽物は Map の挿入順をそのまま返す）
 * - 継続トークンが別の絞り込みのものでないか。偽物のトークンは絞り込み後の挿入順の位置にすぎず、
 *   絞り込みを変えて渡し直しても拒まない（偽物が拒むのは、JSON として読めないトークンと、偽物が作った形でないトークンだけ）
 * - クエリがパーティションをまたぐ ORDER BY かどうか。`enableQueryControl: true` の要求（上の「ページ」を参照）は、
 *   SQL を見ずに `fetchNext` を使うクエリすべてに掛ける。単一パーティションのクエリなど、実 SDK なら
 *   `enableQueryControl` が無くてもトークンを返せるクエリにも掛かるので、`fetchNext` を新しいクエリに使うときは、
 *   本当に要るかを実環境で確かめる
 * - SELECT の列指定（射影）が正しいか（偽物はドキュメント全体を返す）
 * - WHERE 句が `type` でも絞り込む条件になっているか（偽物は `@type` パラメータの値で絞るだけで、
 *   WHERE 句から type の条件を削除しても気づかない）
 * - 集計（GROUP BY / COUNT / MIN / MAX）の値。偽物は `@type` で絞ったドキュメントをそのまま行として返す
 *   だけなので、写真を置いても集計の行にはならず、GROUP BY の枚数は0・期間は null に見える（`VALUE` の集計は、絞り込んだ先頭の文書がそのまま値に見える）。集計の値は
 *   tripSummaries.test.ts（行から値を組み立てる関数）で確かめる。サービスやハンドラのテストでは、
 *   写真を置いて集計の値を主張しない。`SELECT VALUE COUNT(1)` も数ではなく文書を返すので、
 *   図鑑の項目の詳細の枚数（photoCount）と「枚数が 0 なら項目は無い」は確かめられない
 * - パラメータでない条件（SQL に書いた値）。例えば図鑑のクエリの `c.identification.matchesKind = true` は
 *   偽物が見ないので、`matchesKind: false` で名前の残った文書を置いても絞られない（テストの写真は、写っていなければ名前を null にする）
 * - Cosmos のシステム項目（_rid・_self・_etag・_attachments・_ts）。偽物は付けない。応答への漏れを見るテストは、
 *   偽物に置くドキュメントに自分で足す（tests/helpers/albumDocuments.ts の COSMOS_SYSTEM_FIELDS）
 */

/**
 * 偽物が絞り込みに使う最小のフィールド。
 * 旅行のドキュメントは name を持つが imagePath を持たないため、どちらも任意にしている
 */
export interface FakeCosmosDocument {
  id: string;
  type?: string;
  name?: string;
  imagePath?: string;
  /** 写真の属する旅行。旅行に属さないときは null、旅行のドキュメントなどは項目ごと持たない */
  tripId?: string | null;
  /** 写真のカテゴリ（分類前は null） */
  category?: string | null;
  /** 写真の識別の結果（図鑑の種類と名前で絞るのに使う） */
  identification?: unknown;
}

export interface FakeCosmosBackend<TDoc extends FakeCosmosDocument = Plant | PlantSummary | TripDocument> {
  // Cosmosは射影（SELECTの列指定）に応じてPlantの部分集合しか返さないことがある。
  // 既定を Plant 固定にすると「常に完全なPlantが返る」という誤った前提を型で
  // 固定してしまうため、射影結果として渡す PlantSummary も受け入れる。
  // Plant しか入れないテストは FakeCosmosBackend<Plant> と明示して絞れる
  documents: Map<string, TDoc>;
  forcedCreateError?: Error | null;
  /**
   * `create` の冒頭で呼ばれる。「読んだ後・作る直前に、他のリクエストが同じ id を作った」を再現する
   * （コールバックの中で `documents` に足す）。足された後なので、この `create` は 409 になる。
   * 既定は未設定。呼ばれるたびに実行されるので、複数回呼ばれても困らない書き方にする
   */
  beforeCreate?: () => void;
  forcedReadError?: Error | null;
  forcedReplaceError?: Error | null;
  forcedDeleteError?: Error | null;
  /** `item().patch()` が投げるエラー。ドキュメントは変わらない */
  forcedPatchError?: Error | null;
  /**
   * `item(id).patch()` の冒頭（条件を評価する前）で呼ばれる。「読んだ後・patch の直前に、他のリクエストが書き換えた」を再現する
   * （コールバックの中で `documents` を書き換える）。呼ばれるたびに実行されるので、何回目かはコールバックの側で数える
   */
  beforePatch?: (id: string) => void;
  /**
   * ドキュメントの id ごとに、`item(id).delete()` と `item(id).patch()` が投げるエラー。
   * `forcedDeleteError` / `forcedPatchError` は全件に効くので、「読んだ後に1枚だけ他の操作で消された」のような
   * 一部のドキュメントだけの失敗はこちらで起こす。エラーを投げるだけで、ドキュメント自体は Map に残る
   * (消えたことにはならない)。全件に効く `forcedDeleteError` / `forcedPatchError` が先に評価される
   */
  forcedErrorById?: Record<string, Error>;
  forcedQueryError?: Error | null;
  /**
   * `fetchNext` が実際の結果を返す前に返す、結果がまだ揃っていない空のページ（`resources: []` と継続トークン）の数。
   * 実 SDK が `enableQueryControl: true` のときに返す形を再現するので、`enableQueryControl: true` のクエリにだけ効く
   * （ファイル冒頭の説明を参照）。既定は未設定（0）
   */
  emptyPagesBeforeResults?: number;
}

/** 実 SDK が、patch の condition を満たさないときに投げる形（数値 `code` 412） */
export function cosmosPreconditionFailedError(): any {
  const err: any = new Error('PreconditionFailed');
  err.code = 412;
  return err;
}

/**
 * patch の condition を評価する
 *
 * 解釈できるのは `FROM c WHERE c.<path> = "<文字列>"` と `c.<path> = <整数>` を `AND` でつないだ形
 * （ワーカーの担当の条件 `c.processing.state = "pending" AND c.processing.attempts = <読んだ回数>`）と、
 * その `AND` の項に `(IS_NULL(c.<path>) OR c.<path> = "<文字列>")` を置いた形（識別のコメントの条件）だけ
 * @returns 条件を満たすか
 */
function satisfiesCondition(doc: unknown, condition: string): boolean {
  const where = /^FROM c WHERE (.+)$/.exec(condition.trim());
  if (!where) {
    throw new Error(`偽物の patch が解釈できない condition です: ${condition}`);
  }
  const valueAt = (path: string) =>
    path.split('.').reduce<any>((current, key) => (current == null ? undefined : current[key]), doc);
  const equals = (term: string): boolean => {
    const match = /^c\.([A-Za-z_][\w.]*) = (?:"([^"]*)"|(-?\d+))$/.exec(term.trim());
    if (!match) {
      throw new Error(`偽物の patch が解釈できない condition です: ${condition}`);
    }
    const value = valueAt(match[1]);
    return match[2] !== undefined ? value === match[2] : value === Number(match[3]);
  };
  return where[1].split(' AND ').every((term) => {
    const either = /^\(IS_NULL\(c\.([A-Za-z_][\w.]*)\) OR (c\.[A-Za-z_][\w.]* = "[^"]*")\)$/.exec(term.trim());
    if (either) {
      // Cosmos の IS_NULL は項目が無いと偽（null のときだけ真）
      return valueAt(either[1]) === null || equals(either[2]);
    }
    return equals(term);
  });
}

/**
 * 実 SDK は `item(id)` の URL を組み立てるとき（通信の前）に id を検査して投げる（@azure/cosmos 4.10 で実物を呼んで確かめた）。
 * 偽物がこれを「見つからない」として返すと、本番では例外になる id をテストが「見つからない」として通してしまう
 */
function assertSdkItemId(id: unknown): void {
  if (typeof id !== 'string') throw new Error('invalid input: input is not string');
  const trimmed = id.replace(/^\/+|\/+$/g, '');
  if (trimmed === '') throw new Error('Resource ID must be a string and cannot be undefined, null or empty');
  if (/[/\\#]/.test(trimmed)) throw new Error("Illegal characters ['/', '\\', '#'] cannot be used in Resource ID");
}

/** 実 SDK が存在しないドキュメントへの replace / delete で投げる形に合わせたエラー */
export function cosmosNotFoundError(): any {
  const err: any = new Error('NotFound');
  err.code = 404;
  return err;
}

/** `patch` の操作1つ。偽物が解釈するのは `set` / `replace` / `remove` だけ */
export interface FakePatchOperation {
  op: 'set' | 'replace' | 'remove';
  /** `/tripId` のような1段、または `/processing/state` のような2段 */
  path: string;
  value?: unknown;
}

/** `patch` に渡せる形。操作の配列か、条件付きの `{ operations, condition }` */
export type FakePatchBody = FakePatchOperation[] | { operations: FakePatchOperation[]; condition?: string };

/** 実 SDK が、適用できない patch の操作（存在しない path の replace / remove など）に返す形に合わせたエラー */
function cosmosBadPatchError(message: string): any {
  const err: any = new Error(message);
  err.code = 400;
  return err;
}

/**
 * patch の操作をドキュメントの複製に適用して返す（元のドキュメントは変えない。途中で失敗しても反映されない）。
 * 偽物が扱えない操作や、3段以上の path は、黙って通さずに例外にする
 */
function applyPatchOperations(doc: object, operations: FakePatchOperation[]): object {
  const next: Record<string, any> = structuredClone(doc);
  for (const { op, path, value } of operations) {
    const segments = path.split('/').slice(1);
    if (!['set', 'replace', 'remove'].includes(op) || segments.length < 1 || segments.length > 2) {
      throw new Error(`偽物の patch が扱えない操作です: ${op} ${path}`);
    }
    const key = segments[segments.length - 1];
    let parent: Record<string, any> = next;
    if (segments.length === 2) {
      parent = next[segments[0]];
      if (parent === null || typeof parent !== 'object') throw cosmosBadPatchError(`親の path がありません: ${path}`);
    }
    if (op === 'set') {
      parent[key] = value;
    } else if (!(key in parent)) {
      throw cosmosBadPatchError(`存在しない path への ${op} です: ${path}`);
    } else if (op === 'replace') {
      parent[key] = value;
    } else {
      delete parent[key];
    }
  }
  return next;
}

/**
 * 実 SDK が同じ id のドキュメントの create で投げる形に合わせたエラー。
 * 実際の `ErrorResponse` と同じく、数値の `code` に 409 を持つ
 */
export function cosmosConflictError(): any {
  const err: any = new Error('Conflict');
  err.code = 409;
  return err;
}

/**
 * iterator の読み進め方。絞り込み後の挿入順の位置と、次に返す結果の前にあと何ページ空のページを返すか。
 * 継続トークンはこれを JSON の文字列にしたもの（実 SDK のトークンも SDK 内部の JSON の文字列）
 */
interface FakeCursor {
  position: number;
  emptyPagesLeft: number;
}

/**
 * 継続トークン。偽物が作った形だと分かるよう、項目名に `fake` を付ける。
 * `fakeEmptyPagesLeft` は、空のページを返したあとの続きのトークンにだけ入れる（実際の結果のページの後は、
 * 次のページの前の空のページの数が決まっていないので入れない）
 */
interface FakeContinuationToken {
  fakePosition: number;
  fakeEmptyPagesLeft?: number;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function continuationTokenOf(token: FakeContinuationToken): string {
  return JSON.stringify(token);
}

/**
 * トークンから読み進め方を復元する。無ければ先頭から（空のページは `emptyPages` 回）。
 * JSON として読めなければ、実 SDK と同じく `code` の無い普通の Error を投げる。
 * JSON だが偽物が作った形でなければ、数値の `code` に 400 を持つエラーを投げる
 * （サービスが受け付けないトークンを 400 で拒む、という推測の再現。実環境では確かめていない）
 */
function cursorFromContinuationToken(token: string | undefined, emptyPages: number): FakeCursor {
  if (token === undefined) return { position: 0, emptyPagesLeft: emptyPages };
  let parsed: any;
  try {
    parsed = JSON.parse(token);
  } catch (error: any) {
    throw new Error(`Failed to parse continuation token: ${error.message}`);
  }
  const hasEmptyPagesLeft = parsed !== null && typeof parsed === 'object' && 'fakeEmptyPagesLeft' in parsed;
  const isFakeToken =
    parsed !== null &&
    typeof parsed === 'object' &&
    isNonNegativeInteger(parsed.fakePosition) &&
    (!hasEmptyPagesLeft || isNonNegativeInteger(parsed.fakeEmptyPagesLeft));
  if (!isFakeToken) {
    const err: any = new Error('Invalid continuation token');
    err.code = 400;
    throw err;
  }
  return { position: parsed.fakePosition, emptyPagesLeft: hasEmptyPagesLeft ? parsed.fakeEmptyPagesLeft : emptyPages };
}

export function createFakeContainer<TDoc extends FakeCosmosDocument>(
  backend: FakeCosmosBackend<TDoc>
): Container {
  return {
    items: {
      create: async (doc: TDoc) => {
        backend.beforeCreate?.();
        if (backend.forcedCreateError) throw backend.forcedCreateError;
        // 実 SDK は同じ id（パーティションキーも id なので同じ論理パーティション）の create を 409 にする
        if (backend.documents.has(doc.id)) throw cosmosConflictError();
        backend.documents.set(doc.id, doc);
        return { resource: doc };
      },
      query: (
        querySpec: any,
        options?: { maxItemCount?: number; continuationToken?: string; enableQueryControl?: boolean }
      ) => {
        const parameters = typeof querySpec === 'string' ? [] : (querySpec.parameters ?? []);
        const nameParam = parameters.find((p: any) => p.name === '@name')?.value;
        const imagePathParam = parameters.find((p: any) => p.name === '@imagePath')?.value;
        const typeParam = parameters.find((p: any) => p.name === '@type')?.value;
        // @tripId は null を値として渡せる（旅行に属さない写真）ので、値ではなくパラメータがあるかで判断する
        const tripIdParam = parameters.find((p: any) => p.name === '@tripId');
        const categoryParam = parameters.find((p: any) => p.name === '@category')?.value;
        // 図鑑の項目（識別の種類と名前）。名前は植物の @name と分けて @entryName で受ける。
        // @kind・@entryName は図鑑の識別の絞り込み専用（別の意味で同じ名前のパラメータを使うと、偽物が識別で絞ってしまう）
        const kindParam = parameters.find((p: any) => p.name === '@kind')?.value;
        const entryNameParam = parameters.find((p: any) => p.name === '@entryName')?.value;
        let docs = Array.from(backend.documents.values());
        if (nameParam !== undefined) {
          docs = docs.filter((d) => d.name === nameParam);
        }
        if (imagePathParam !== undefined) {
          docs = docs.filter((d) => d.imagePath === imagePathParam);
        }
        if (typeParam !== undefined) {
          docs = docs.filter((d) => d.type === typeParam);
        }
        if (tripIdParam !== undefined) {
          // 厳密な一致。null を渡せば tripId が null のものだけで、項目が無い（undefined の）ドキュメントは含めない
          docs = docs.filter((d) => d.tripId === tripIdParam.value);
        }
        if (categoryParam !== undefined) {
          docs = docs.filter((d) => d.category === categoryParam);
        }
        if (kindParam !== undefined) {
          docs = docs.filter((d) => (d.identification as { kind?: unknown } | null | undefined)?.kind === kindParam);
        }
        if (entryNameParam !== undefined) {
          docs = docs.filter((d) => (d.identification as { name?: unknown } | null | undefined)?.name === entryNameParam);
        }
        // 実 SDK の iterator と同じく、fetchNext を呼び直すと続きから読む。
        // 最初の fetchNext で（渡されたトークンがあればそれを読んで）決める。トークンの不正は、そのとき投げる
        let cursor: FakeCursor | undefined;
        return {
          fetchAll: async () => {
            if (backend.forcedQueryError) throw backend.forcedQueryError;
            return { resources: docs };
          },
          fetchNext: async () => {
            if (backend.forcedQueryError) throw backend.forcedQueryError;
            // 実 SDK は、パーティションをまたぐ ORDER BY のクエリで enableQueryControl が無いと、トークンを渡された時点で
            // この例外を投げ（トークンの中身を読む前）、1ページ目にもトークンを返さない。空のページも返さない
            // （結果が揃うまで内部で待つ）。偽物は SQL を解釈できないので、fetchNext を使うクエリすべてにこれを適用する。
            // 空の文字列は、実 SDK と同じく「トークン無し」として扱う
            const queryControl = options?.enableQueryControl === true;
            const token = options?.continuationToken || undefined;
            if (token !== undefined && !queryControl) {
              throw new Error('Continuation tokens are supported when enableQueryControl is set true in FeedOptions');
            }
            const emptyPages = queryControl ? (backend.emptyPagesBeforeResults ?? 0) : 0;
            const current = cursor ?? cursorFromContinuationToken(token, emptyPages);
            if (current.emptyPagesLeft > 0) {
              // 結果がまだ揃っていない。位置は進めず、空のページと続きのトークンを返す
              cursor = { position: current.position, emptyPagesLeft: current.emptyPagesLeft - 1 };
              return {
                resources: [],
                continuationToken: continuationTokenOf({
                  fakePosition: cursor.position,
                  fakeEmptyPagesLeft: cursor.emptyPagesLeft
                })
              };
            }
            const end =
              options?.maxItemCount === undefined ? docs.length : current.position + options.maxItemCount;
            cursor = { position: end, emptyPagesLeft: emptyPages };
            return {
              resources: docs.slice(current.position, end),
              continuationToken:
                queryControl && end < docs.length ? continuationTokenOf({ fakePosition: end }) : undefined
            };
          }
        };
      }
    },
    item: (id: string, partitionKey: string) => ({
      read: async () => {
        assertSdkItemId(id);
        if (backend.forcedReadError) throw backend.forcedReadError;
        if (id !== partitionKey || !backend.documents.has(id)) {
          return { resource: undefined };
        }
        return { resource: backend.documents.get(id) };
      },
      replace: async (doc: TDoc) => {
        assertSdkItemId(id);
        if (backend.forcedReplaceError) throw backend.forcedReplaceError;
        if (id !== partitionKey || !backend.documents.has(id)) throw cosmosNotFoundError();
        backend.documents.set(id, doc);
        return { resource: doc };
      },
      patch: async (body: FakePatchBody) => {
        assertSdkItemId(id);
        if (backend.forcedPatchError) throw backend.forcedPatchError;
        if (backend.forcedErrorById?.[id]) throw backend.forcedErrorById[id];
        backend.beforePatch?.(id);
        if (id !== partitionKey || !backend.documents.has(id)) throw cosmosNotFoundError();
        if (!Array.isArray(body) && body.condition !== undefined && !satisfiesCondition(backend.documents.get(id), body.condition)) {
          throw cosmosPreconditionFailedError();
        }
        const operations = Array.isArray(body) ? body : body.operations;
        const patched = applyPatchOperations(backend.documents.get(id)!, operations) as TDoc;
        backend.documents.set(id, patched);
        return { resource: patched };
      },
      delete: async () => {
        assertSdkItemId(id);
        if (backend.forcedDeleteError) throw backend.forcedDeleteError;
        if (backend.forcedErrorById?.[id]) throw backend.forcedErrorById[id];
        if (id !== partitionKey || !backend.documents.has(id)) throw cosmosNotFoundError();
        backend.documents.delete(id);
        return { resource: { id } };
      }
    })
  } as unknown as Container;
}
