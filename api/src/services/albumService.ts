import { CosmosClient, Container } from '@azure/cosmos';
import { v4 as uuidv4 } from 'uuid';
import { PhotoDocument, Trip, TripDocument, TripInput, TripSummary } from '../types/album';
import { queryCover, queryPhotoCounts, queryTakenAtRanges } from './albumQueries';
import { buildTripSummaries } from './tripSummaries';
import { PHOTO_CONTINUATION_TOKEN_LIMIT_KB, PHOTO_EMPTY_PAGE_RETRIES } from '../constants/album';

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
    const [counts, ranges, coverUrls] = await Promise.all([
      queryPhotoCounts(this.container, id),
      queryTakenAtRanges(this.container, id),
      this.coverUrls([id], coverUrlOf),
    ]);
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
    const coverUrls = await this.coverUrls(tripDocs.map((trip) => trip.id), coverUrlOf);
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
   * @param tripId 旅行 ID。どの旅行にも属さない写真なら null
   * @param limit 1ページの最大枚数
   * @param continuationToken 前のページの継続トークン。先頭からなら undefined
   * @returns 写真と、次のページの継続トークン（最後のページなら null）
   */
  async listPhotos(
    tripId: string | null,
    limit: number,
    continuationToken: string | undefined
  ): Promise<{ photos: PhotoDocument[]; continuationToken: string | null }> {
    // album は PK が /id なので、この ORDER BY はパーティションをまたぐ。@azure/cosmos 4.x では、この形で
    // 継続トークンを使うには enableQueryControl が要る（無いと1ページ目にトークンが返らず、トークンを渡すと例外）。
    // enableQueryControl では、結果が揃っていないと空のページをトークン付きで返すので、写真が取れるまで読み進める
    const iterator = this.container.items.query<PhotoDocument>(
      {
        query: 'SELECT * FROM c WHERE c.type = @type AND c.tripId = @tripId ORDER BY c.sortAt ASC',
        parameters: [
          { name: '@type', value: 'photo' },
          { name: '@tripId', value: tripId },
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
