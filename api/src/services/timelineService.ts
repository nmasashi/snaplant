import { Container } from '@azure/cosmos';
import { openAlbumContainer } from './albumContainer';
import { PhotoDocument } from '../types/album';
import { TimelineDocument, TimelinePhotosDocument } from '../types/timeline';

/** 控えを取るときに読む写真の項目（04 §5 の 5.12） */
export type TimelinePhotoRow = Pick<
  PhotoDocument,
  'id' | 'takenAt' | 'sortAt' | 'category' | 'identification' | 'location' | 'comment' | 'blobName' | 'thumbnailBlobName' | 'processing'
>;

/** 読んだタイムラインと、置き換えるときの条件にする _etag */
export interface ReadTimeline {
  doc: TimelineDocument;
  etag: string;
}

/** 読んでから書くまでに他が書いた（412）・同時に作られた（409）。呼び出し側は 409 TIMELINE_STATE_CONFLICT にする */
export class TimelineConflictError extends Error {
  constructor() {
    super('タイムラインが他の操作で変わりました');
    this.name = 'TimelineConflictError';
  }
}

/**
 * タイムライン（段階5）の Cosmos DB の操作（docs/04_data_design.md §1.6・§5.7）
 *
 * タイムラインの文書は、利用者の操作とワーカーが同じ欄（下書き・完成版）を書くので、読んだ _etag 付きの置き換えで書く
 */
export class TimelineService {
  private readonly container: Container;

  constructor() {
    this.container = openAlbumContainer();
  }

  /**
   * 旅行のタイムラインを読む
   * @param tripId 旅行の ID
   * @returns 文書と _etag。無ければ null
   */
  async readTimeline(tripId: string): Promise<ReadTimeline | null> {
    const id = timelineIdOf(tripId);
    const { resource } = await this.container.item(id, id).read<TimelineDocument & { _etag: string }>();
    if (resource?.type !== 'timeline') {
      return null;
    }
    return { doc: toTimelineDocument(resource), etag: resource._etag };
  }

  /**
   * 控えを取るために、旅行の写真の薄い射影を全部読む（04 §5 の 5.12。利用者が作る・作り直すときだけ）
   * @param tripId 旅行の ID
   */
  async readTripPhotosForSnapshot(tripId: string): Promise<TimelinePhotoRow[]> {
    const { resources } = await this.container.items
      .query<TimelinePhotoRow>({
        query:
          'SELECT c.id, c.takenAt, c.sortAt, c.category, c.identification, c.location, c.comment, c.blobName, c.thumbnailBlobName, c.processing FROM c WHERE c.type = @type AND c.tripId = @tripId',
        parameters: [
          { name: '@type', value: 'photo' },
          { name: '@tripId', value: tripId },
        ],
      })
      .fetchAll();
    return resources;
  }

  /**
   * 写真の控えを読む
   * @param id 控えの id
   * @returns 控え。無ければ null
   */
  async readSnapshot(id: string): Promise<TimelinePhotosDocument | null> {
    const { resource } = await this.container.item(id, id).read<TimelinePhotosDocument>();
    return resource?.type === 'timelinePhotos' ? resource : null;
  }

  /**
   * 旅行の今の写真の id を読む（04 §5 の 5.13。控えを取った後に消えた写真を見分ける）
   *
   * id だけの射影なので軽い。区切りの確認と完成版を開くときに読む
   * @param tripId 旅行の ID
   */
  async readTripPhotoIds(tripId: string): Promise<Set<string>> {
    const { resources } = await this.container.items
      .query<{ id: string }>({
        query: 'SELECT c.id FROM c WHERE c.type = @type AND c.tripId = @tripId',
        parameters: [
          { name: '@type', value: 'photo' },
          { name: '@tripId', value: tripId },
        ],
      })
      .fetchAll();
    return new Set(resources.map((row) => row.id));
  }

  /**
   * 写真の控えを作る（後から変えない）
   * @param doc 控えの文書
   */
  async createSnapshot(doc: TimelinePhotosDocument): Promise<void> {
    await this.container.items.create(doc);
  }

  /**
   * 写真の控えを消す。無ければ何もしない
   * @param id 控えの id
   */
  async deleteSnapshot(id: string): Promise<void> {
    try {
      await this.container.item(id, id).delete();
    } catch (error: any) {
      if (error.code !== 404) {
        throw error;
      }
    }
  }

  /**
   * タイムラインを作る（まだ無いとき）
   * @throws TimelineConflictError 同時に作られていた（409）
   */
  async createTimeline(doc: TimelineDocument): Promise<void> {
    try {
      await this.container.items.create(doc);
    } catch (error: any) {
      if (error.code === 409) {
        throw new TimelineConflictError();
      }
      throw error;
    }
  }


  /**
   * タイムラインを置き換える。読んだときの _etag のままのときだけ書く
   * @param doc 書く文書
   * @param etag 読んだときの _etag
   * @throws TimelineConflictError 読んでから書くまでに他が書いた（412）か、消えていた（404）
   */
  async replaceTimeline(doc: TimelineDocument, etag: string): Promise<void> {
    try {
      await this.container.item(doc.id, doc.id).replace(doc, { accessCondition: { type: 'IfMatch', condition: etag } });
    } catch (error: any) {
      if (error.code === 412 || error.code === 404) {
        throw new TimelineConflictError();
      }
      throw error;
    }
  }
}

/** 旅行のタイムラインの文書の id（旅行ごとに1件） */
export function timelineIdOf(tripId: string): string {
  return `timeline-${tripId}`;
}

/**
 * 読んだ文書から、タイムラインの項目だけを取り出す
 *
 * Cosmos のシステム項目（_rid・_etag など）を書き戻さない（置き換えのたびに古い _etag が文書に残るのを避ける）
 */
function toTimelineDocument(doc: TimelineDocument): TimelineDocument {
  return {
    id: doc.id,
    type: doc.type,
    tripId: doc.tripId,
    current: doc.current,
    draft: doc.draft,
    droppedEdits: doc.droppedEdits,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}
