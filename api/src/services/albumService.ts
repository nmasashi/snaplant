import { CosmosClient, Container } from '@azure/cosmos';
import { v4 as uuidv4 } from 'uuid';
import { PhotoDocument, PhotoProcessing, Trip, TripDocument, TripInput, TripSummary } from '../types/album';
import { PhotoCountRow, queryCover, queryPhotoCounts, queryTakenAtRanges } from './albumQueries';
import { buildTripSummaries } from './tripSummaries';
import { PHOTO_CONTINUATION_TOKEN_LIMIT_KB, PHOTO_EMPTY_PAGE_RETRIES } from '../constants/album';

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
    const client = new CosmosClient({
      endpoint: process.env.COSMOS_DB_ENDPOINT!,
      key: process.env.COSMOS_DB_KEY!,
    });
    this.container = client
      .database(process.env.COSMOS_DB_DATABASE!)
      .container(process.env.COSMOS_DB_ALBUM_CONTAINER!);
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
   * （docs/travel-album/04_data_design.md §5.1）。旅行に属さない写真の枚数も同じ集計から出す
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
   *   category はカテゴリ（絞らないなら undefined）。両方あれば AND
   * @param limit 1ページの最大枚数
   * @param continuationToken 前のページの継続トークン。先頭からなら undefined
   * @returns 写真と、次のページの継続トークン（最後のページなら null）
   */
  async listPhotos(
    filter: { tripId: string | null | undefined; category: string | undefined },
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
          ' ORDER BY c.sortAt ASC',
        parameters: [
          { name: '@type', value: 'photo' },
          ...(filter.tripId !== undefined ? [{ name: '@tripId', value: filter.tripId }] : []),
          ...(filter.category !== undefined ? [{ name: '@category', value: filter.category }] : []),
        ],
      },
      {
        maxItemCount: limit,
        continuationToken,
        continuationTokenLimitInKB: PHOTO_CONTINUATION_TOKEN_LIMIT_KB,
        enableQueryControl: true,
      }
    );
    let page = await iterator.fetchNext();
    for (let i = 0; i < PHOTO_EMPTY_PAGE_RETRIES && page.resources.length === 0 && page.continuationToken; i++) {
      page = await iterator.fetchNext();
    }
    return { photos: page.resources, continuationToken: page.continuationToken ?? null };
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
        condition: `FROM c WHERE c.tripId = "${missingTripId}"`,
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
   * 止まった写真の processing を書き換える（解析待ちに戻すか、失敗にする）。読んだときのままのときだけ書く条件付きの patch
   *
   * 読んでから書くまでにワーカーが担当していたら（state か回数が変わる）書かない
   * @param id 写真 ID
   * @param read 読んだときの processing
   * @param next 書く processing
   * @returns 書けたら true。読んだときと変わっていた（412）か、写真が消えていた（404）なら false
   */
  async resetStalePhotoProcessing(id: string, read: PhotoProcessing, next: PhotoProcessing): Promise<boolean> {
    try {
      await this.container.item(id, id).patch({
        condition: processingCondition(read),
        operations: [{ op: 'set', path: '/processing', value: next }],
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
   * 写真の解析のやり直しを受け付ける（分類の待ちにし、回数を 0 に戻し、手がかりを書き、コメントを消す）
   *
   * コメントは、やり直しの結果で置き換えるために消す（利用者の文は、アプリが手がかりに事前入力してから頼む。
   * docs/travel-album/05_api_design.md §5.7）。前回の結果の欄（category など）は、やり直しの結果が出るまで残す
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
   * 写真の解析を担当する（processing を処理中にする）。読んだときのまま分類の待ち（pending）のときだけ書く条件付きの patch
   *
   * 同じメッセージが2回届いたとき、先に書いた方だけが担当になる（docs/travel-album/04_data_design.md §7.4）。
   * 回数も条件に入れる。読んでから担当するまでに、別のインスタンスが担当して失敗し分類の待ちに戻していると、
   * state だけでは見分けられず、回数を数え直して上限で止まらなくなる
   * @param id 写真 ID
   * @param step 担当する処理。読んでから担当するまでに別の処理が step を変えていたら担当しない
   * @param readAttempts 読んだときの失敗の回数（processing.attempts）
   * @param processing 処理中の processing
   * @returns 担当できたら true。別のインスタンスが先に担当していた（412）か、写真が消えていた（404）なら false
   */
  async claimPhotoProcessing(id: string, expected: PhotoProcessing, processing: PhotoProcessing): Promise<boolean> {
    try {
      await this.container.item(id, id).patch({
        condition: processingCondition(expected),
        operations: [{ op: 'set', path: '/processing', value: processing }],
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
   * 写真の解析の進み具合だけを書く（失敗したとき。結果の欄には触らない）
   * @param id 写真 ID
   * @param processing 書く processing
   */
  async writeProcessing(id: string, claimed: PhotoProcessing, processing: PhotoProcessing): Promise<boolean> {
    return this.patchIfStillClaimed(id, claimed, [{ op: 'set', path: '/processing', value: processing }]);
  }

  /**
   * 分類の結果を写真に書く（AI が書く欄だけ。利用者の欄には触らない。docs/travel-album/04_data_design.md §7.4）
   * @param id 写真 ID
   * @param result 書く値
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
   * 担当したときのまま（分類中で、回数が担当したときの値）のときだけ書く条件付きの patch
   *
   * 分類の間にやり直しの受付（pending・回数 0）が入っていたら書かない。古い処理の結果や失敗でやり直しを上書きすると、
   * やり直しで積んだメッセージは担当できずに捨てられ、やり直しが黙って消える（docs/travel-album/05_api_design.md §5.7）
   * @returns 書けたら true。担当したときと変わっていた（412）か、写真が消えていた（404）なら false
   */
  private async patchIfStillClaimed(
    id: string,
    claimed: PhotoProcessing,
    operations: { op: 'set'; path: string; value: unknown }[]
  ): Promise<boolean> {
    try {
      await this.container.item(id, id).patch({
        condition: processingCondition(claimed),
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
   * （段階3の掃除のタイマーが未所属に戻す。docs/travel-album/04_data_design.md §7.3）。
   * 写真の処理が失敗したら投げる（旅行は残り、済んだ分はそのまま。再送で続きができる）
   * @param id 旅行 ID
   * @param deletePhotos 中の写真も消すなら true、残すなら false
   * @param onPhotoDeleted 写真のドキュメントを消した後に呼ぶ（Blob を消すため）
   * @returns 消した写真と未所属に戻した写真の枚数。旅行が無ければ null
   */
  async deleteTrip(
    id: string,
    deletePhotos: boolean,
    onPhotoDeleted: (photo: PhotoBlobNames) => Promise<void>
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
  return (
    `FROM c WHERE c.processing.state = "${expected.state}"` +
    (expected.step !== null ? ` AND c.processing.step = "${expected.step}"` : '') +
    ` AND c.processing.attempts = ${expected.attempts}` +
    (expected.updatedAt !== null ? ` AND c.processing.updatedAt = "${expected.updatedAt}"` : '')
  );
}
