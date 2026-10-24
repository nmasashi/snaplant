import { QueueClient } from '@azure/storage-queue';

/**
 * タイムラインのキュー（段階5。docs/06_processing_design.md §8.1）
 *
 * メッセージは `{ tripId, draftId }`。やること（draft.job.step）はワーカーが文書から読む。
 * draftId は、やめた・出し直した下書きの古いメッセージで書かないために載せる
 */
export class TimelineQueueService {
  private readonly client: QueueClient;

  constructor() {
    // キューの名前は必須（写真のキューと同じ理由。ワーカーのトリガー '%TIMELINE_QUEUE_NAME%' は既定値を持てない）
    const queueName = process.env.TIMELINE_QUEUE_NAME;
    if (!queueName?.trim()) {
      throw new Error('TIMELINE_QUEUE_NAME（タイムラインのキューの名前）が設定されていません');
    }
    this.client = new QueueClient(process.env.AzureWebJobsStorage!, queueName);
  }

  /**
   * 下書きの処理を依頼する
   * @param tripId 旅行の ID
   * @param draftId 下書きの ID
   */
  async enqueue(tripId: string, draftId: string): Promise<void> {
    // Functions のキューのトリガーは本文を base64 として読む（写真のキューと同じ）
    const body = Buffer.from(JSON.stringify({ tripId, draftId }), 'utf8').toString('base64');
    await this.client.sendMessage(body);
  }
}

/**
 * 下書きの処理を依頼する。失敗しても投げず、ログを出して false を返す
 *
 * 投入の前に下書きを待ち（pending）にしてあるので、投入に失敗しても再投入のタイマーが拾う（写真の enqueuePhotoOrLog と同じ）
 * @param tripId 旅行の ID
 * @param draftId 下書きの ID
 * @param log ログの出し先
 * @returns 投入できたら true
 */
export async function enqueueTimelineOrLog(
  tripId: string,
  draftId: string,
  log: (...args: unknown[]) => void
): Promise<boolean> {
  try {
    await new TimelineQueueService().enqueue(tripId, draftId);
    return true;
  } catch (error: any) {
    log(`タイムラインのキューへの投入に失敗しました（タイマーが再投入します）: 旅行=${tripId}`, error);
    return false;
  }
}
