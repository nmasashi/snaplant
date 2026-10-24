import { Container } from '@azure/cosmos';
import { openAlbumContainer } from './albumContainer';
import { sqlString } from '../utils/sqlString';
import { PhotoDocument } from '../types/album';
import { TimelineDocument, TimelineDraft, TimelineJob, TimelinePhotosDocument } from '../types/timeline';

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
    await this.deleteDocument(id);
  }

  /**
   * 文書を消す。無ければ何もしない（控えと、旅行の削除のときのタイムライン）
   * @param id 文書の id
   */
  private async deleteDocument(id: string): Promise<void> {
    try {
      await this.container.item(id, id).delete();
    } catch (error: any) {
      if (error.code !== 404) {
        throw error;
      }
    }
  }

  /**
   * 使われなくなった控えを消す。失敗しても投げず、ログだけ出す（残っても害は無く、旅行の削除で消える。04 §1.6）
   * @param id 控えの id
   * @param log ログの出し先
   */
  async deleteUnusedSnapshot(id: string, log: (...args: unknown[]) => void): Promise<void> {
    try {
      await this.deleteSnapshot(id);
    } catch (error: any) {
      log(`使われなくなった写真の控えを消せませんでした: ${id}`, error);
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

  /**
   * タイムラインの文書を消す。読んだときの _etag のままのときだけ消す
   * @param tripId 旅行の ID
   * @param etag 読んだときの _etag
   * @throws TimelineConflictError 読んでから消すまでに他が書いた（412）か、消えていた（404）
   */
  async deleteTimeline(tripId: string, etag: string): Promise<void> {
    const id = timelineIdOf(tripId);
    try {
      await this.container.item(id, id).delete({ accessCondition: { type: 'IfMatch', condition: etag } });
    } catch (error: any) {
      if (error.code === 412 || error.code === 404) {
        throw new TimelineConflictError();
      }
      throw error;
    }
  }

  /**
   * 処理が待ち・処理中のまま、指定した時刻より前から止まっている下書きを読む（再投入のタイマー。04 §5 の 5.15）
   *
   * 絞り込みはテストで確かめられない（偽物は SQL を解釈しない）ので、呼び出し側も同じ条件をコードで見る
   * @param before この時刻（ISO）より前に job が更新された下書きを読む
   */
  async listStaleDrafts(before: string): Promise<{ tripId: string; draft: TimelineDraft | null }[]> {
    const { resources } = await this.container.items
      .query<{ tripId: string; draft: TimelineDraft | null }>({
        query:
          "SELECT c.tripId, c.draft FROM c WHERE c.type = @type AND c.draft.job.state IN ('pending', 'running') AND c.draft.job.updatedAt < @before",
        parameters: [
          { name: '@type', value: 'timeline' },
          { name: '@before', value: before },
        ],
      })
      .fetchAll();
    return resources;
  }

  /**
   * ワーカーが担当した下書きに結果を書く。読んだ文書の _etag 付きの置き換えで、他の操作と重なったら（412）読み直して当て直す（06 §8.1）
   *
   * 当て直すのは、下書きがまだ自分のもの（同じ id）で、処理も担当したときのままのときだけ（利用者が完成版の文を直した・
   * 残せなかった文を閉じたなどと重なっても、AI の結果を捨てない）。重なりが続けば投げる（内部の失敗として待ちに戻る）
   * @param tripId 旅行の ID
   * @param draftId 担当した下書きの id
   * @param claimedJob 担当したときに書いた job
   * @param apply 読み直した下書きに結果を当てた下書きを返す
   * @returns 書けたら true。下書きが自分のものでなくなっていた・タイムラインが消えていたら false
   */
  async writeDraftResult(
    tripId: string,
    draftId: string,
    claimedJob: TimelineJob,
    apply: (draft: TimelineDraft) => TimelineDraft
  ): Promise<boolean> {
    for (let attempt = 0; attempt <= RESULT_RETRIES; attempt += 1) {
      const read = await this.readTimeline(tripId);
      const draft = read?.doc.draft;
      if (!read || !draft || draft.id !== draftId || !sameJob(draft.job, claimedJob)) {
        return false;
      }
      try {
        await this.replaceTimeline({ ...read.doc, draft: apply(draft), updatedAt: new Date().toISOString() }, read.etag);
        return true;
      } catch (error: any) {
        if (!(error instanceof TimelineConflictError)) {
          throw error;
        }
      }
    }
    throw new Error(`タイムラインの書き込みが他の操作と重なり続けました: 旅行=${tripId}`);
  }

  /**
   * 下書きの処理の状態だけを書く。同じ下書き（id）で、処理が expected のままのときだけ書く条件付きの patch
   *
   * 再投入のタイマーとワーカーの担当が使う（写真の writeProcessing と同じ条件の形。06 §8.1）。
   * 読んでから書くまでに、下書きをやめた・出し直した・ワーカーが担当したなどがあれば書かない
   * @param tripId 旅行の ID
   * @param draftId 読んだ下書きの id
   * @param expected 読んだ job
   * @param job 書く job
   * @returns 書けたら true。変わっていた（412）か、タイムラインが消えていた（404）なら false
   */
  async writeDraftJob(tripId: string, draftId: string, expected: TimelineJob, job: TimelineJob): Promise<boolean> {
    const id = timelineIdOf(tripId);
    try {
      await this.container.item(id, id).patch({
        condition:
          `FROM c WHERE c.draft.id = ${sqlString(draftId)}` +
          JOB_IDENTITY.map((field) => ` AND c.draft.job.${field} = ${jobValueLiteral(expected[field])}`).join(''),
        operations: [{ op: 'set', path: '/draft/job', value: job }],
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
   * 旅行のタイムラインと写真の控えを全部消す（旅行の削除の手順 4。05 §5.12）。無いものは飛ばす
   *
   * 控えは旅行の id で引く（どこからも指されなくなった控えも、ここでまとめて消える）。
   * 失敗したら投げる（旅行の削除は中断し、旅行は残る。再送で続きができる）
   * @param tripId 旅行の ID
   */
  async deleteTripTimeline(tripId: string): Promise<void> {
    const { resources } = await this.container.items
      .query<{ id: string }>({
        query: 'SELECT c.id FROM c WHERE c.type = @type AND c.tripId = @tripId',
        parameters: [
          { name: '@type', value: 'timelinePhotos' },
          { name: '@tripId', value: tripId },
        ],
      })
      .fetchAll();
    for (const id of [timelineIdOf(tripId), ...resources.map((row) => row.id)]) {
      await this.deleteDocument(id);
    }
  }
}

/** 旅行のタイムラインの文書の id（旅行ごとに1件） */
export function timelineIdOf(tripId: string): string {
  return `timeline-${tripId}`;
}

/** 結果の書き込みが他の操作と重なったときに、読み直して当て直す回数（06 §8.1） */
const RESULT_RETRIES = 3;

/**
 * 下書きの処理が「読んだときのまま」かを見分ける項目
 *
 * 条件付き patch の条件（writeDraftJob）と、結果を当て直すときの確かめ（sameJob）の両方をここから作る（片方だけ項目が増えて、
 * 結果の書き込みと失敗の書き込みで「まだ自分の担当か」の判断が食い違わないように）
 */
const JOB_IDENTITY = ['state', 'step', 'attempts', 'updatedAt'] as const;

/** patch の条件に埋める job の値（数はそのまま、文字列はエスケープする） */
function jobValueLiteral(value: string | number): string {
  return typeof value === 'number' ? String(Number(value)) : sqlString(value);
}

/** 下書きの処理が担当したときのままか（担当の後に、再投入のタイマーが待ちに戻すなどしていないか） */
function sameJob(job: TimelineJob | null, claimed: TimelineJob): boolean {
  return job !== null && JOB_IDENTITY.every((field) => job[field] === claimed[field]);
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
