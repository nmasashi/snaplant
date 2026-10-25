import { Container } from '@azure/cosmos';
import { openAlbumContainer } from './albumContainer';
import { sqlString } from '../utils/sqlString';
import { PhotoDocument, PhotoProcessing } from '../types/album';
import { TimelineDocument, TimelineDraft, TimelineJob, TimelinePhotoSnapshot, TimelinePhotosDocument } from '../types/timeline';

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
 * 写真の控えが無い
 *
 * 控えを消すのはタイムラインの書き込みの後（下書きをやめる・作り直す・旅行の削除）なので、読んだタイムラインが指す控えが、
 * 読む前に消えていることがある（他の操作と重なった）。読み直しても無ければ壊れている
 */
export class TimelineSnapshotMissingError extends Error {
  constructor(id: string) {
    super(`写真の控えがありません: ${id}`);
    this.name = 'TimelineSnapshotMissingError';
  }
}

/**
 * タイムラインと控えを読んで応答を組む処理を、控えが無ければ最初から読み直す（05 §5.15。3回まで）
 *
 * 控えが無いのは、読んだ後に他の操作が下書きをやめた・作り直した・旅行を消したとき。読み直すと今の状態になる。
 * 続けて重なることもある（作り直しを続けて押した）ので数回は読み直し、それでも無ければ壊れているとして投げる（500）
 * @param read タイムラインを読むところから応答を組むまで
 */
export async function rereadIfSnapshotMissing<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await read();
    } catch (error: any) {
      if (!(error instanceof TimelineSnapshotMissingError) || attempt > SNAPSHOT_REREADS) {
        throw error;
      }
    }
  }
}

/** 控えが無いときに読み直す回数 */
const SNAPSHOT_REREADS = 3;

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
   * 写真の控えの写真を読む。無ければ投げる
   *
   * 空として扱うと、日と場面が空になり、全部の写真が増えたと知らせ、区切りを無効と返してしまう。
   * 他の操作と重なったのか壊れているのかは、呼ぶ側が読み直して見分ける（rereadIfSnapshotMissing）
   * @param id 控えの id
   * @throws TimelineSnapshotMissingError 控えが無い
   */
  async readSnapshotPhotos(id: string): Promise<TimelinePhotoSnapshot[]> {
    const { resource } = await this.container.item(id, id).read<TimelinePhotosDocument>();
    if (resource?.type !== 'timelinePhotos') {
      throw new TimelineSnapshotMissingError(id);
    }
    return resource.photos;
  }

  /**
   * 旅行の今の写真の id と解析の状態を読む（04 §5 の 5.13）
   *
   * 控えを取った後に消えた写真を見分ける（下書きの表示・区切りの保存・完成版）。完成版を開くときは、控えとの差で写真の増えた・消えた枚数を、
   * 同じ結果から解析が済んでいない写真の枚数も数える（旅行の写真を読むのは1回）。射影は id と解析の状態だけなので軽い
   * （processing の中の state だけをオブジェクトの射影で読む。processing の無い文書は none（解析の対象でない）として扱う）
   * @param tripId 旅行の ID
   */
  async readTripPhotoStates(tripId: string): Promise<{ id: string; state: PhotoProcessing['state'] }[]> {
    const { resources } = await this.container.items
      .query<{ id: string; processing?: { state?: PhotoProcessing['state'] } }>({
        query: 'SELECT c.id, { "state": c.processing.state } AS processing FROM c WHERE c.type = @type AND c.tripId = @tripId',
        parameters: [
          { name: '@type', value: 'photo' },
          { name: '@tripId', value: tripId },
        ],
      })
      .fetchAll();
    return resources.map((row) => ({ id: row.id, state: row.processing?.state ?? 'none' }));
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
   * @param apply 読み直した文書（下書きは自分のもの）に結果を当てた文書を返す（区切り案は下書きを、文は完成版と残せなかった文も書く）
   * @returns 書けたら、置き換えた（結果を当てる前の）文書。下書きが自分のものでなくなっていた・タイムラインが消えていたら null
   */
  async writeDraftResult(
    tripId: string,
    draftId: string,
    claimedJob: TimelineJob,
    apply: (doc: TimelineDocument & { draft: TimelineDraft }) => TimelineDocument
  ): Promise<TimelineDocument | null> {
    for (let attempt = 0; attempt <= RESULT_RETRIES; attempt += 1) {
      const read = await this.readTimeline(tripId);
      const draft = read?.doc.draft;
      if (!read || !draft || draft.id !== draftId || !sameJob(draft.job, claimedJob)) {
        return null;
      }
      try {
        await this.replaceTimeline({ ...apply({ ...read.doc, draft }), updatedAt: new Date().toISOString() }, read.etag);
        return read.doc;
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
  return typeof value === 'number' ? String(value) : sqlString(value);
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
