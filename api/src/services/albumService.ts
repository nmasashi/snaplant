import { Container } from '@azure/cosmos';
import { openAlbumContainer } from './albumContainer';
import { InvalidContinuationTokenError } from '../utils/errors';
import { v4 as uuidv4 } from 'uuid';
import { CATALOG_KINDS } from '../catalog/kinds';
import { CatalogEntriesQuery, CatalogEntry, CatalogEntryQuery, PhotoDocument, PhotoProcessing, Trip, TripDocument, TripInput, TripSummary } from '../types/album';
import { PhotoCountRow, queryCover, queryPhotoCounts, queryTakenAtRanges } from './albumQueries';
import { queryCatalogHead, queryCatalogNameCounts, queryCatalogPhotoCount } from './catalogQueries';
import { catalogEntryOf, catalogPageOf } from './catalogEntries';
import { buildTripSummaries } from './tripSummaries';
import { PHOTO_CONTINUATION_TOKEN_LIMIT_KB, PHOTO_EMPTY_PAGE_RETRIES } from '../constants/album';

/** 識別に回すスクリプトが読む写真の項目（listUnidentifiedPhotos の射影） */
export type UnidentifiedPhotoRow = Pick<PhotoDocument, 'id' | 'category' | 'identification' | 'processing'>;

/** 写真の id と Blob 名（写真の Blob を消すのに要るもの） */
export interface PhotoBlobNames {
  id: string;
  blobName: string;
  thumbnailBlobName: string | null;
}

/** Blob 名から表紙の URL（SAS 付き）を作る関数 */
export type CoverUrlOf = (blobName: string) => string;

/**
 * 旅行アルバムの Cosmos DB（album コンテナ）を扱うサービス
 */
export class AlbumService {
  private container: Container;

  constructor() {
    this.container = openAlbumContainer();
  }

  /**
   * 旅行を作る
   * @param input 旅行名と説明
   * @returns 保存した旅行
   */
  async createTrip(input: TripInput): Promise<Trip> {
    const now = new Date().toISOString();
    const doc: TripDocument = {
      id: uuidv4(),
      type: 'trip',
      name: input.name.trim(),
      description: input.description,
      tags: [],
      createdAt: now,
      updatedAt: now,
    };
    await this.container.items.create(doc);
    return toTrip(doc);
  }

  /**
   * 旅行を、写真の集計を付けて取り出す
   * @param id 旅行 ID
   * @returns 旅行。無ければ null
   */
  async getTrip(id: string, coverUrlOf?: CoverUrlOf): Promise<TripSummary | null> {
    const resource = await this.readTrip(id);
    if (!resource) {
      return null;
    }
    const [counts, ranges] = await Promise.all([
      queryPhotoCounts(this.container, id),
      queryTakenAtRanges(this.container, id),
    ]);
    const coverUrls = await this.coverUrls(tripsWithPhotos([id], counts), coverUrlOf);
    return buildTripSummaries([toTrip(resource)], counts, ranges, coverUrls).trips[0];
  }

  /**
   * 旅行の一覧を、写真の集計を付けて返す（作成日時の新しい順）
   *
   * 写真を全部読まずに、旅行ごとの枚数と撮影期間を GROUP BY で数える
   * （docs/04_data_design.md §5.1）。旅行に属さない写真の枚数も同じ集計から出す
   */
  async listTrips(coverUrlOf?: CoverUrlOf): Promise<{ trips: TripSummary[]; unassignedPhotoCount: number }> {
    const [{ resources: tripDocs }, counts, ranges] = await Promise.all([
      this.container.items
        .query<TripDocument>({
          query: 'SELECT * FROM c WHERE c.type = @type ORDER BY c.createdAt DESC',
          parameters: [{ name: '@type', value: 'trip' }],
        })
        .fetchAll(),
      queryPhotoCounts(this.container),
      queryTakenAtRanges(this.container),
    ]);
    const coverUrls = await this.coverUrls(tripsWithPhotos(tripDocs.map((trip) => trip.id), counts), coverUrlOf);
    return buildTripSummaries(tripDocs.map(toTrip), counts, ranges, coverUrls);
  }

  /**
   * 旅行ごとの表紙（並べ替え用の日時で最初の写真のサムネイル、無ければ原寸）の URL を作る
   * @param tripIds 旅行 ID
   * @param coverUrlOf Blob 名から URL を作る関数。無ければ表紙を作らない
   */
  private async coverUrls(tripIds: string[], coverUrlOf: CoverUrlOf | undefined): Promise<Map<string, string>> {
    const urls = new Map<string, string>();
    if (!coverUrlOf) {
      return urls;
    }
    const covers = await Promise.all(tripIds.map((tripId) => queryCover(this.container, tripId)));
    tripIds.forEach((tripId, i) => {
      const cover = covers[i];
      if (cover) {
        urls.set(tripId, coverUrlOf(cover.thumbnailBlobName ?? cover.blobName));
      }
    });
    return urls;
  }

  /**
   * 図鑑の項目の一覧の1ページを作る（docs/04_data_design.md §3.1 の3段）
   * @param query 検証済みのクエリ（種類・何件目から・何件まで）。offset と limit はどちらも数なので、位置で渡すと取り違えても型が止めない
   * @param coverUrlOf Blob 名から表紙の URL（SAS 付き）を作る
   * @returns ページの項目と、項目の総数
   */
  async listCatalogEntries(
    { kind, offset, limit }: CatalogEntriesQuery,
    coverUrlOf: CoverUrlOf
  ): Promise<{ entries: CatalogEntry[]; total: number }> {
    // 1. 名前ごとの枚数 → 2・3 はページを作る関数（切ってから、ページの項目の分だけ見出しを読む）
    return catalogPageOf(
      kind,
      await queryCatalogNameCounts(this.container, kind),
      offset,
      limit,
      (name) => queryCatalogHead(this.container, kind, name),
      coverUrlOf
    );
  }

  /**
   * 図鑑の項目の詳細と、その写真の1ページを読む（docs/04_data_design.md §5.6 の詳細の3本）
   *
   * 見出しの写真（TOP 1）を先に読み、無ければ項目は無い（その種類と名前の写真が0枚）。写真のページを読まないので、
   * 項目が消えた後に古い継続トークンで続きを頼まれても、トークンの不正ではなく entry: null を返す。
   * 見出しがあれば枚数と写真のページを並列に読み、枚数が 0 なら項目は無い（読む間に消された・名前が変わったときに、
   * 見出しだけ残った食い違った項目を返さない）
   * @param query 検証済みのクエリ（種類・名前・写真のページ）
   * @param coverUrlOf Blob 名から表紙の URL（SAS 付き）を作る
   * @returns 項目（無ければ null）と、写真の1ページと次のページの継続トークン
   */
  async getCatalogEntry(
    { kind, name, limit, continuationToken }: CatalogEntryQuery,
    coverUrlOf: CoverUrlOf
  ): Promise<{ entry: CatalogEntry | null; photos: PhotoDocument[]; continuationToken: string | null }> {
    const head = await queryCatalogHead(this.container, kind, name);
    if (head === null) {
      return { entry: null, photos: [], continuationToken: null };
    }
    const [photoCount, page] = await Promise.all([
      queryCatalogPhotoCount(this.container, kind, name),
      this.listPhotos({ tripId: undefined, category: undefined, entry: { kind, name } }, limit, continuationToken),
    ]);
    if (photoCount === 0) {
      return { entry: null, photos: [], continuationToken: null };
    }
    return { entry: catalogEntryOf(kind, { name, photoCount }, head, coverUrlOf), ...page };
  }

  /**
   * 旅行の名前と説明を置き換える（タグと作成日時は変えない）
   * @param id 旅行 ID
   * @param input 新しい旅行名と説明
   * @returns 更新後の旅行。無ければ null
   */
  async updateTrip(id: string, input: TripInput): Promise<Trip | null> {
    const current = await this.readTrip(id);
    if (!current) {
      return null;
    }
    const updated: TripDocument = {
      ...current,
      name: input.name.trim(),
      description: input.description,
      updatedAt: new Date().toISOString(),
    };
    try {
      await this.container.item(id, id).replace(updated);
    } catch (error: any) {
      // 読んだ後・置き換える前に旅行が消された（旅行の削除と重なった）。
      // replace は NotFound を例外で投げるので、読み取りで無かったときと同じく null にする
      if (error.code === 404) {
        return null;
      }
      throw error;
    }
    return toTrip(updated);
  }

  /**
   * 旅行があるか（集計はしない）
   * @param id 旅行 ID
   */
  async tripExists(id: string): Promise<boolean> {
    return (await this.readTrip(id)) !== null;
  }

  /**
   * 写真のドキュメントを読む
   * @param id 写真 ID
   * @returns 写真のドキュメント。無いか写真でなければ null
   */
  async getPhoto(id: string): Promise<PhotoDocument | null> {
    const { resource } = await this.container.item(id, id).read<PhotoDocument>();
    return resource?.type === 'photo' ? resource : null;
  }

  /**
   * 旅行の写真（または、どの旅行にも属さない写真）を、並べ替え用の日時の順に1ページ分読む
   *
   * どの旅行にも属さない写真は tripId に null を渡す（c.tripId = null は値が null のものだけに一致し、
   * 項目が無いドキュメントには一致しない。写真は必ず tripId を書くので漏れない）
   * @param filter 絞り込み。tripId は旅行 ID（どの旅行にも属さない写真なら null、旅行で絞らないなら undefined）、
   *   category はカテゴリ（絞らないなら undefined）、entry は図鑑の項目（種類と名前。分類どおりの種類が写っている写真だけ）。あれば AND
   * @param limit 1ページの最大枚数
   * @param continuationToken 前のページの継続トークン。先頭からなら undefined
   * @returns 写真と、次のページの継続トークン（最後のページなら null）
   */
  async listPhotos(
    filter: { tripId: string | null | undefined; category: string | undefined; entry?: { kind: string; name: string } },
    limit: number,
    continuationToken: string | undefined
  ): Promise<{ photos: PhotoDocument[]; continuationToken: string | null }> {
    // album は PK が /id なので、この ORDER BY はパーティションをまたぐ。@azure/cosmos 4.x では、この形で
    // 継続トークンを使うには enableQueryControl が要る（無いと1ページ目にトークンが返らず、トークンを渡すと例外）。
    // enableQueryControl では、結果が揃っていないと空のページをトークン付きで返すので、写真が取れるまで読み進める
    const iterator = this.container.items.query<PhotoDocument>(
      {
        query:
          'SELECT * FROM c WHERE c.type = @type' +
          (filter.tripId !== undefined ? ' AND c.tripId = @tripId' : '') +
          (filter.category !== undefined ? ' AND c.category = @category' : '') +
          (filter.entry !== undefined
            ? ' AND c.identification.kind = @kind AND c.identification.matchesKind = true AND c.identification.name = @entryName'
            : '') +
          ' ORDER BY c.sortAt ASC',
        parameters: [
          { name: '@type', value: 'photo' },
          ...(filter.tripId !== undefined ? [{ name: '@tripId', value: filter.tripId }] : []),
          ...(filter.category !== undefined ? [{ name: '@category', value: filter.category }] : []),
          ...(filter.entry !== undefined
            ? [
                { name: '@kind', value: filter.entry.kind },
                { name: '@entryName', value: filter.entry.name },
              ]
            : []),
        ],
      },
      {
        maxItemCount: limit,
        continuationToken,
        continuationTokenLimitInKB: PHOTO_CONTINUATION_TOKEN_LIMIT_KB,
        enableQueryControl: true,
      }
    );
    try {
      let page = await iterator.fetchNext();
      for (let i = 0; i < PHOTO_EMPTY_PAGE_RETRIES && page.resources.length === 0 && page.continuationToken; i++) {
        page = await iterator.fetchNext();
      }
      return { photos: page.resources, continuationToken: page.continuationToken ?? null };
    } catch (error: any) {
      // JSON としては読めるが Cosmos が受け付けないトークンは、サーバが 400 で拒む（推測。実環境で確かめる）。
      // トークンを渡したこのクエリの 400 だけを、トークンの不正とみなす
      if (continuationToken !== undefined && error.code === 400) {
        throw new InvalidContinuationTokenError(error);
      }
      throw error;
    }
  }

  /**
   * 写真のドキュメントを消す
   * @param id 写真 ID
   * @returns 消した写真のドキュメント（Blob を消すために使う）。無ければ null
   */
  async deletePhoto(id: string): Promise<PhotoDocument | null> {
    const photo = await this.getPhoto(id);
    if (!photo) {
      return null;
    }
    try {
      await this.container.item(id, id).delete();
    } catch (error: any) {
      // 読んだ後・消す前に他のリクエストが消した。無かったときと同じく null にする
      // （画像は先に消した側が消すので、こちらでは触らない）
      if (error.code === 404) {
        return null;
      }
      throw error;
    }
    return photo;
  }

  /**
   * 写真をまとめて旅行に入れる（tripId に null を渡すと旅行から外す）
   *
   * 写真ごとに tripId と updatedAt だけを patch する（AI が書く欄やコメントには触らない）。
   * 無い写真は notFound に入れて続ける。それ以外の失敗は投げる（済んだ分は移っている。再送しても同じ結果になる）
   * @param photoIds 写真 ID（重複は呼び出し側で除く）
   * @param tripId 移す先の旅行 ID。外すなら null
   */
  async movePhotos(photoIds: string[], tripId: string | null): Promise<{ moved: string[]; notFound: string[] }> {
    const now = new Date().toISOString();
    const moved: string[] = [];
    const notFound: string[] = [];
    for (const id of photoIds) {
      try {
        await this.container.item(id, id).patch([
          { op: 'set', path: '/tripId', value: tripId },
          { op: 'set', path: '/updatedAt', value: now },
        ]);
        moved.push(id);
      } catch (error: any) {
        if (error.code === 404) {
          notFound.push(id);
          continue;
        }
        throw error;
      }
    }
    return { moved, notFound };
  }

  /**
   * 写真の利用者のコメントとタグを直す
   *
   * 書くのは comment・commentSource・tags・updatedAt だけ（AI が書く欄には触らない）。解析中でも受け付ける
   * @param id 写真 ID
   * @param changes 直す項目（comment は null で消す。tags は置き換え）
   * @returns 更新後の写真のドキュメント。無ければ null
   */
  async updatePhoto(
    id: string,
    changes: { comment?: string | null; tags?: string[] }
  ): Promise<PhotoDocument | null> {
    const operations: { op: 'set'; path: string; value: unknown }[] = [];
    if (changes.comment !== undefined) {
      operations.push({ op: 'set', path: '/comment', value: changes.comment });
      operations.push({ op: 'set', path: '/commentSource', value: changes.comment === null ? null : 'user' });
    }
    if (changes.tags !== undefined) {
      operations.push({ op: 'set', path: '/tags', value: changes.tags });
    }
    operations.push({ op: 'set', path: '/updatedAt', value: new Date().toISOString() });
    try {
      const { resource } = await this.container.item(id, id).patch<PhotoDocument>(operations);
      return resource ?? null;
    } catch (error: any) {
      if (error.code === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * 全写真の id・旅行・原寸の Blob 名だけを読む（掃除のタイマー。04 §5 の 5.9）
   *
   * 全件を読むのはこのタイマーだけ（1日1回。1万枚でも 1 MB 程度の射影）。画面から呼ぶ API には置かない
   */
  async listPhotoRefs(): Promise<{ id: string; tripId: string | null; blobName: string }[]> {
    const { resources } = await this.container.items
      .query<{ id: string; tripId: string | null; blobName: string }>({
        query: 'SELECT c.id, c.tripId, c.blobName FROM c WHERE c.type = @type',
        parameters: [{ name: '@type', value: 'photo' }],
      })
      .fetchAll();
    return resources;
  }

  /**
   * 消えた旅行を指す写真を、どの旅行にも属さない写真に戻す（掃除のタイマー）。読んだ旅行のままのときだけ書く条件付きの patch
   *
   * 読んだ後に利用者が別の旅行へ移していたら戻さない
   * @param id 写真 ID
   * @param missingTripId 読んだときに写真が指していた（消えた）旅行の ID
   * @returns 戻したら true。旅行が変わっていた（412）か、写真が消えていた（404）なら false
   */
  async detachPhotoFromMissingTrip(id: string, missingTripId: string): Promise<boolean> {
    try {
      await this.container.item(id, id).patch({
        condition: `FROM c WHERE c.tripId = ${sqlString(missingTripId)}`,
        operations: [
          { op: 'set', path: '/tripId', value: null },
          { op: 'set', path: '/updatedAt', value: new Date().toISOString() },
        ],
      });
      return true;
    } catch (error: any) {
      if (error.code === 412 || error.code === 404) {
        return false;
      }
      throw error;
    }
  }

  /**
   * 全旅行の id を読む（掃除のタイマー）
   */
  async listTripIds(): Promise<string[]> {
    const { resources } = await this.container.items
      .query<{ id: string }>({
        query: 'SELECT c.id FROM c WHERE c.type = @type',
        parameters: [{ name: '@type', value: 'trip' }],
      })
      .fetchAll();
    return resources.map((trip) => trip.id);
  }

  /**
   * 解析待ち・処理中のまま、指定した時刻より前から止まっている写真を読む（再投入のタイマー。04 §5 の 5.8）
   *
   * failed と none は含めない（failed を拾うと同じ画像で永遠に失敗し続け、none を拾うと段階2の写真すべてに課金する）
   * @param before この時刻（ISO）より前に processing が更新された写真を読む
   */
  async listStalePhotos(before: string): Promise<{ id: string; processing: PhotoProcessing }[]> {
    const { resources } = await this.container.items
      .query<{ id: string; processing: PhotoProcessing }>({
        query:
          "SELECT c.id, c.processing FROM c WHERE c.type = @type AND c.processing.state IN ('pending', 'classifying', 'identifying') AND c.processing.updatedAt < @before",
        parameters: [
          { name: '@type', value: 'photo' },
          { name: '@before', value: before },
        ],
      })
      .fetchAll();
    return resources;
  }

  /**
   * 分類まで済んで識別の無い、図鑑の種類の写真を読む（段階3に送った写真を識別に回すスクリプト用。06 §1）
   *
   * 絞り込みはテストで確かめられない（偽物は SQL を解釈しない）ので、呼び出し側も同じ条件をコードで見る
   * @returns 写真ごとの id・category・identification・processing
   */
  async listUnidentifiedPhotos(): Promise<UnidentifiedPhotoRow[]> {
    const { resources } = await this.container.items
      .query<UnidentifiedPhotoRow>({
        query:
          "SELECT c.id, c.category, c.identification, c.processing FROM c WHERE c.type = @type AND c.processing.state = 'done' AND IS_NULL(c.identification) AND ARRAY_CONTAINS(@kinds, c.category)",
        parameters: [
          { name: '@type', value: 'photo' },
          { name: '@kinds', value: Object.keys(CATALOG_KINDS) },
        ],
      })
      .fetchAll();
    return resources;
  }

  /**
   * 写真の解析のやり直しを受け付ける（分類の待ちにし、回数を 0 に戻し、手がかりを書き、コメントを消す）
   *
   * コメントは、やり直しの結果で置き換えるために消す（利用者の文は、アプリが手がかりに事前入力してから頼む。
   * docs/05_api_design.md §5.7）。前回の結果の欄（category など）は、やり直しの結果が出るまで残す
   * @param id 写真 ID
   * @param step やり直す処理
   * @param hint 利用者からの手がかり。無ければ null
   * @param now 受け付けた時刻（ISO）
   * @returns 更新後の写真のドキュメント。無ければ null
   */
  async requestPhotoProcessing(
    id: string,
    step: 'classify' | 'identify',
    hint: string | null,
    now: string
  ): Promise<PhotoDocument | null> {
    try {
      const { resource } = await this.container.item(id, id).patch<PhotoDocument>([
        { op: 'set', path: '/processing', value: { state: 'pending', step, attempts: 0, lastError: null, updatedAt: now } },
        { op: 'set', path: '/hint', value: hint },
        { op: 'set', path: '/comment', value: null },
        { op: 'set', path: '/commentSource', value: null },
        { op: 'set', path: '/updatedAt', value: now },
      ]);
      return resource ?? null;
    } catch (error: any) {
      if (error.code === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * 写真の解析を担当する（processing を処理中にする）。processing が expected のままのときだけ書く条件付きの patch
   *
   * 同じメッセージが2回届いたとき、先に書いた方だけが担当になる（docs/04_data_design.md §7.4）。
   * 条件は processingCondition()（state・step・回数・updatedAt）。読んでから担当するまでに、別のインスタンスの担当と失敗や、
   * やり直しの受付が入っていたら担当しない
   * @param id 写真 ID
   * @param expected 担当してよい processing。読んだ値に、担当する state（pending）と step を入れたもの
   * @param processing 処理中の processing（updatedAt は今。結果を書くときの条件になる）
   * @returns 担当できたら true。別のインスタンスが先に担当していた（412）か、写真が消えていた（404）なら false
   */
  async claimPhotoProcessing(id: string, expected: PhotoProcessing, processing: PhotoProcessing): Promise<boolean> {
    return this.writeProcessing(id, expected, processing);
  }

  /**
   * 写真の解析の進み具合だけを書く（結果の欄には触らない）。processing が expected のままのときだけ書く
   *
   * ワーカーの失敗の記録（expected は担当したときに書いたもの）、再投入のタイマーと識別に回すスクリプト（expected は読んだもの）が使う。
   * 読んで（担当して）から書くまでに、ワーカーの担当ややり直しの受付が入っていたら書かない
   * @param id 写真 ID
   * @param expected 読んだ、または担当したときに書いた processing
   * @param processing 書く processing
   * @returns 書けたら true。expected と変わっていた（412）か、写真が消えていた（404）なら false
   */
  async writeProcessing(id: string, expected: PhotoProcessing, processing: PhotoProcessing): Promise<boolean> {
    return this.patchIfStillClaimed(id, expected, [{ op: 'set', path: '/processing', value: processing }]);
  }

  /**
   * 分類の結果を写真に書く（AI が書く欄だけ。利用者の欄には触らない。docs/04_data_design.md §7.4）。担当したときのままのときだけ書く
   * @param id 写真 ID
   * @param claimed 担当したときに書いた processing（claimPhotoProcessing に渡したもの）
   * @param result 書く値
   * @returns 書けたら true。担当したときと変わっていたら false
   */
  async writeClassification(
    id: string,
    claimed: PhotoProcessing,
    result: { category: string; classification: unknown; processing: PhotoProcessing; updatedAt: string }
  ): Promise<boolean> {
    return this.patchIfStillClaimed(id, claimed, [
      { op: 'set', path: '/category', value: result.category },
      { op: 'set', path: '/classification', value: result.classification },
      { op: 'set', path: '/identification', value: null },
      { op: 'set', path: '/processing', value: result.processing },
      { op: 'set', path: '/updatedAt', value: result.updatedAt },
    ]);
  }

  /**
   * 識別の結果を写真に書く（AI が書く欄だけ。docs/04_data_design.md §7.4）。担当したときのままのときだけ書く
   * @param id 写真 ID
   * @param claimed 担当したときに書いた processing（claimPhotoProcessing に渡したもの）
   * @param result 書く値
   * @returns 書けたら true。担当したときと変わっていたら false
   */
  async writeIdentification(
    id: string,
    claimed: PhotoProcessing,
    result: { identification: unknown; processing: PhotoProcessing; updatedAt: string }
  ): Promise<boolean> {
    return this.patchIfStillClaimed(id, claimed, [
      { op: 'set', path: '/identification', value: result.identification },
      { op: 'set', path: '/processing', value: result.processing },
      { op: 'set', path: '/updatedAt', value: result.updatedAt },
    ]);
  }

  /**
   * AI のコメントを写真に書く。担当したときのままで、利用者がコメントを書いていない（commentSource が null か ai）ときだけ書く
   *
   * コメントは利用者の PATCH と AI の両方が書く唯一の欄（04 §7.4）。条件を Cosmos が原子的に評価するので、
   * 読んでから書くまでの間に利用者が書いたコメントも消さない。担当したときのままも条件にするのは、識別の間に
   * やり直しの受付が入ったとき、捨てる結果のコメントをやり直しの写真に残さないため
   * @param id 写真 ID
   * @param claimed 担当したときに書いた processing（claimPhotoProcessing に渡したもの）
   * @param comment AI のコメント
   * @returns 書けたら true。利用者のコメントがある・担当したときと変わっていた（412）か、写真が消えていた（404）なら false
   */
  async writeAiComment(id: string, claimed: PhotoProcessing, comment: string): Promise<boolean> {
    return this.patchIfStillClaimed(
      id,
      claimed,
      [
        { op: 'set', path: '/comment', value: comment },
        { op: 'set', path: '/commentSource', value: 'ai' },
      ],
      // null は != で比べられない（null != "user" は未定義になる）ので、IS_NULL と = でつなぐ
      'IS_NULL(c.commentSource) OR c.commentSource = "ai"'
    );
  }

  /**
   * 担当したときのまま（processing が担当したときに書いたもののまま）のときだけ書く条件付きの patch
   *
   * 分類の間にやり直しの受付（pending・回数 0）が入っていたら書かない。古い処理の結果や失敗でやり直しを上書きすると、
   * やり直しで積んだメッセージは担当できずに捨てられ、やり直しが黙って消える（docs/05_api_design.md §5.7）
   * @param extraCondition 担当したときのままに加えて満たすべき条件（括弧で包んで `AND` でつなぐ）。無ければ担当したときのままだけ
   * @returns 書けたら true。担当したときと変わっていた・extraCondition を満たさない（412）か、写真が消えていた（404）なら false
   */
  private async patchIfStillClaimed(
    id: string,
    claimed: PhotoProcessing,
    operations: { op: 'set'; path: string; value: unknown }[],
    extraCondition?: string
  ): Promise<boolean> {
    try {
      await this.container.item(id, id).patch({
        // 括弧で包む（条件に OR があっても、担当したときのままの条件と AND で結び付くように）
        condition: processingCondition(claimed) + (extraCondition ? ` AND (${extraCondition})` : ''),
        operations,
      });
      return true;
    } catch (error: any) {
      if (error.code === 412 || error.code === 404) {
        return false;
      }
      throw error;
    }
  }

  /**
   * 旅行を消す。先に中の写真を消すか、どの旅行にも属さない写真に戻してから、最後に旅行を消す
   *
   * 中の写真は最初にページで全部読み（射影）、その分だけを処理する。削除の途中に届いた写真は消さない
   * （段階3の掃除のタイマーが未所属に戻す。docs/04_data_design.md §7.3）。
   * 写真の処理が失敗したら投げる（旅行は残り、済んだ分はそのまま。再送で続きができる）
   * @param id 旅行 ID
   * @param deletePhotos 中の写真も消すなら true、残すなら false
   * @param onPhotoDeleted 写真のドキュメントを消した後に呼ぶ（Blob を消すため）
   * @param beforeTripDeleted 写真を処理した後、旅行を消す前に呼ぶ（タイムラインを消すため。失敗したら旅行は残る）
   * @returns 消した写真と未所属に戻した写真の枚数。旅行が無ければ null
   */
  async deleteTrip(
    id: string,
    deletePhotos: boolean,
    onPhotoDeleted: (photo: PhotoBlobNames) => Promise<void>,
    beforeTripDeleted: () => Promise<void> = async () => {}
  ): Promise<{ deletedPhotoCount: number; detachedPhotoCount: number } | null> {
    if (!(await this.readTrip(id))) {
      return null;
    }
    const photos = await this.readTripPhotoBlobNames(id);
    let deletedPhotoCount = 0;
    let detachedPhotoCount = 0;
    const now = new Date().toISOString();
    for (const photo of photos) {
      try {
        if (deletePhotos) {
          await this.container.item(photo.id, photo.id).delete();
          deletedPhotoCount++;
          await onPhotoDeleted(photo);
        } else {
          await this.container.item(photo.id, photo.id).patch([
            { op: 'set', path: '/tripId', value: null },
            { op: 'set', path: '/updatedAt', value: now },
          ]);
          detachedPhotoCount++;
        }
      } catch (error: any) {
        // 読んだ後に別の操作で写真が消されていた。消えたものとして読み飛ばし、枚数には数えない
        if (error.code !== 404) {
          throw error;
        }
      }
    }
    await beforeTripDeleted();
    try {
      await this.container.item(id, id).delete();
    } catch (error: any) {
      // 写真を処理している間に、他の操作が旅行を先に消していた。旅行が無いという結果は同じなので成功とする
      if (error.code !== 404) {
        throw error;
      }
    }
    return { deletedPhotoCount, detachedPhotoCount };
  }

  /**
   * 旅行の写真の id と Blob 名を、ページで全部読む
   * @param tripId 旅行 ID
   */
  private async readTripPhotoBlobNames(tripId: string): Promise<PhotoBlobNames[]> {
    const iterator = this.container.items.query<PhotoBlobNames>(
      {
        query: 'SELECT c.id, c.blobName, c.thumbnailBlobName FROM c WHERE c.type = @type AND c.tripId = @tripId',
        parameters: [
          { name: '@type', value: 'photo' },
          { name: '@tripId', value: tripId },
        ],
      },
      { enableQueryControl: true }
    );
    const photos: PhotoBlobNames[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await iterator.fetchNext();
      photos.push(...page.resources);
      continuationToken = page.continuationToken;
    } while (continuationToken);
    return photos;
  }

  /**
   * 写真のドキュメントを作る
   *
   * 写真の id は中身の SHA-256 なので、同じ写真がほぼ同時に送られると、先に読んだときには
   * 無くても create の時点では別の送信が作っている。そのとき create は 409 になるので、
   * 先に作られた方を読んで返す（同じ写真は1枚）
   * @param doc 写真のドキュメント
   * @returns 保存した（または先に作られていた）写真のドキュメントと、この呼び出しで作ったか
   */
  async createPhoto(doc: PhotoDocument): Promise<{ photo: PhotoDocument; created: boolean }> {
    try {
      await this.container.items.create(doc);
      return { photo: doc, created: true };
    } catch (error: any) {
      if (error.code === 409) {
        const existing = await this.getPhoto(doc.id);
        if (existing) {
          return { photo: existing, created: false };
        }
      }
      throw error;
    }
  }

  /**
   * 旅行のドキュメントを読む
   *
   * 旅行と写真は同じコンテナにあるので、id で読めても旅行とは限らない
   * @param id 旅行 ID
   * @returns 旅行のドキュメント。無いか旅行でなければ null
   */
  private async readTrip(id: string): Promise<TripDocument | null> {
    const { resource } = await this.container.item(id, id).read<TripDocument>();
    return resource?.type === 'trip' ? resource : null;
  }
}

/**
 * ドキュメントから応答に出す項目だけを取り出す
 *
 * スプレッドで type だけを除く形にすると、Cosmos のシステム項目（_rid・_etag など）まで
 * 応答に漏れる。項目を列挙して詰め替える
 * @param doc 旅行のドキュメント
 */
function toTrip(doc: TripDocument): Trip {
  return {
    id: doc.id,
    name: doc.name,
    description: doc.description,
    tags: doc.tags,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * 写真のある旅行だけに絞る（枚数の GROUP BY に行がある旅行）
 *
 * 表紙のクエリは旅行ごとに1本投げるので、写真の無い旅行の分を省く
 * @param tripIds 旅行 ID
 * @param counts 旅行ごとの写真の枚数の行
 */
function tripsWithPhotos(tripIds: string[], counts: PhotoCountRow[]): string[] {
  const withPhotos = new Set(counts.map((row) => row.tripId));
  return tripIds.filter((id) => withPhotos.has(id));
}

/**
 * 写真の processing が、読んだ（または書いた）ときのままのときだけ書く patch の条件
 *
 * state・step・回数に加えて processing.updatedAt も見る。やり直しの受付は回数を 0 に戻すので、
 * state と回数だけでは「やり直しの後に取り直された担当」と古い担当が同じ値に見える（ABA）。
 * updatedAt は processing を書くたびに今の時刻になるので、担当ごとの印になる
 * @param expected 読んだ（または書いた）ときの processing
 */
function processingCondition(expected: PhotoProcessing): string {
  // 解析の待ち・処理中の写真は必ず updatedAt を持つ（送信・やり直し・担当・タイマーが今の時刻を書く）。null は段階2の none の写真だけ
  return (
    `FROM c WHERE c.processing.state = ${sqlString(expected.state)}` +
    (expected.step !== null ? ` AND c.processing.step = ${sqlString(expected.step)}` : '') +
    ` AND c.processing.attempts = ${Number(expected.attempts)}` +
    (expected.updatedAt !== null ? ` AND c.processing.updatedAt = ${sqlString(expected.updatedAt)}` : '')
  );
}

/**
 * patch の condition に埋める文字列のリテラル
 *
 * condition はパラメータを取れないので値を埋め込む。埋める値はどれもサーバが書いた列挙・時刻・UUID だが、
 * 引用符が混ざっても条件が壊れないよう、JSON の文字列としてエスケープする（Cosmos SQL の文字列リテラルと同じ書き方）
 */
function sqlString(value: string): string {
  return JSON.stringify(value);
}
