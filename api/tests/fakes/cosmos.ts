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
 * ## 偽物では検証できないこと
 *
 * `items.query` は Cosmos SQL を解釈せず、渡されたパラメータ
 * （`@name` / `@imagePath` / `@type`）の値で絞り込むだけに留める。クエリ文字列自体への
 * 依存はリファクタリング耐性を失うため見ない。この簡略化の結果、
 * 次の点はこの層のテストでは検証できない（SQL 自体を解釈する実エミュレータ、
 * もしくは E2E テストに委ねる）:
 *
 * - WHERE句が実際に name / imagePath で絞り込む条件になっているか
 *   （パラメータの値さえ渡っていれば、絞り込み条件を丸ごと削除しても
 *   この偽物は気づかない）
 * - `ORDER BY c.createdAt DESC` による並び順（偽物は Map の挿入順をそのまま返す）
 * - SELECT の列指定（射影）が正しいか（偽物はドキュメント全体を返す）
 * - WHERE 句が `type` でも絞り込む条件になっているか（偽物は `@type` パラメータの値で絞るだけで、
 *   WHERE 句から type の条件を削除しても気づかない）
 * - 集計（GROUP BY / COUNT / MIN / MAX）の値。偽物は `@type` で絞ったドキュメントをそのまま行として返す
 *   だけなので、写真を置いても集計の行にはならず、枚数は0・期間は null に見える。集計の値は
 *   tripSummaries.test.ts（行から値を組み立てる関数）で確かめる。サービスやハンドラのテストでは、
 *   写真を置いて集計の値を主張しない
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
}

export interface FakeCosmosBackend<TDoc extends FakeCosmosDocument = Plant | PlantSummary | TripDocument> {
  // Cosmosは射影（SELECTの列指定）に応じてPlantの部分集合しか返さないことがある。
  // 既定を Plant 固定にすると「常に完全なPlantが返る」という誤った前提を型で
  // 固定してしまうため、射影結果として渡す PlantSummary も受け入れる。
  // Plant しか入れないテストは FakeCosmosBackend<Plant> と明示して絞れる
  documents: Map<string, TDoc>;
  forcedCreateError?: Error | null;
  /** 作成は成功するが resource が返らない（SDK が稀に返す形）を再現する */
  forcedCreateNoResource?: boolean;
  /**
   * `create` の冒頭で呼ばれる。「読んだ後・作る直前に、他のリクエストが同じ id を作った」を再現する
   * （コールバックの中で `documents` に足す）。足された後なので、この `create` は 409 になる。
   * 既定は未設定。呼ばれるたびに実行されるので、複数回呼ばれても困らない書き方にする
   */
  beforeCreate?: () => void;
  forcedReadError?: Error | null;
  forcedReplaceError?: Error | null;
  forcedDeleteError?: Error | null;
  forcedQueryError?: Error | null;
}

/** 実 SDK が存在しないドキュメントへの replace / delete で投げる形に合わせたエラー */
export function cosmosNotFoundError(): any {
  const err: any = new Error('NotFound');
  err.code = 404;
  return err;
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

export function createFakeContainer<TDoc extends FakeCosmosDocument>(
  backend: FakeCosmosBackend<TDoc>
): Container {
  return {
    items: {
      create: async (doc: TDoc) => {
        backend.beforeCreate?.();
        if (backend.forcedCreateError) throw backend.forcedCreateError;
        if (backend.forcedCreateNoResource) return { resource: undefined };
        // 実 SDK は同じ id（パーティションキーも id なので同じ論理パーティション）の create を 409 にする
        if (backend.documents.has(doc.id)) throw cosmosConflictError();
        backend.documents.set(doc.id, doc);
        return { resource: doc };
      },
      query: (querySpec: any) => {
        const parameters = typeof querySpec === 'string' ? [] : (querySpec.parameters ?? []);
        const nameParam = parameters.find((p: any) => p.name === '@name')?.value;
        const imagePathParam = parameters.find((p: any) => p.name === '@imagePath')?.value;
        const typeParam = parameters.find((p: any) => p.name === '@type')?.value;
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
        return {
          fetchAll: async () => {
            if (backend.forcedQueryError) throw backend.forcedQueryError;
            return { resources: docs };
          }
        };
      }
    },
    item: (id: string, partitionKey: string) => ({
      read: async () => {
        if (backend.forcedReadError) throw backend.forcedReadError;
        if (id !== partitionKey || !backend.documents.has(id)) {
          return { resource: undefined };
        }
        return { resource: backend.documents.get(id) };
      },
      replace: async (doc: TDoc) => {
        if (backend.forcedReplaceError) throw backend.forcedReplaceError;
        if (id !== partitionKey || !backend.documents.has(id)) throw cosmosNotFoundError();
        backend.documents.set(id, doc);
        return { resource: doc };
      },
      delete: async () => {
        if (backend.forcedDeleteError) throw backend.forcedDeleteError;
        if (id !== partitionKey || !backend.documents.has(id)) throw cosmosNotFoundError();
        backend.documents.delete(id);
        return { resource: { id } };
      }
    })
  } as unknown as Container;
}
