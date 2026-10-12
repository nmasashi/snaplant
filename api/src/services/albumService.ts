import { CosmosClient, Container } from '@azure/cosmos';
import { v4 as uuidv4 } from 'uuid';
import { Trip, TripDocument, TripInput, TripSummary } from '../types/album';
import { queryPhotoCounts, queryTakenAtRanges } from './albumQueries';
import { buildTripSummaries } from './tripSummaries';

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
  async getTrip(id: string): Promise<TripSummary | null> {
    const resource = await this.readTrip(id);
    if (!resource) {
      return null;
    }
    const [counts, ranges] = await Promise.all([
      queryPhotoCounts(this.container, id),
      queryTakenAtRanges(this.container, id),
    ]);
    return buildTripSummaries([toTrip(resource)], counts, ranges).trips[0];
  }

  /**
   * 旅行の一覧を、写真の集計を付けて返す（作成日時の新しい順）
   *
   * 写真を全部読まずに、旅行ごとの枚数と撮影期間を GROUP BY で数える
   * （docs/travel-album/04_data_design.md §5.1）。旅行に属さない写真の枚数も同じ集計から出す
   */
  async listTrips(): Promise<{ trips: TripSummary[]; unassignedPhotoCount: number }> {
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
    return buildTripSummaries(tripDocs.map(toTrip), counts, ranges);
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
    await this.container.item(id, id).replace(updated);
    return toTrip(updated);
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
