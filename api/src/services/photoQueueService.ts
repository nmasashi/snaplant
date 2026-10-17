import { QueueClient } from '@azure/storage-queue';

/**
 * 写真の解析（分類・識別）のキュー（docs/travel-album/06_processing_design.md §1）
 *
 * メッセージは `{ photoId }` だけ。やる処理（`processing.step`）と手がかり（`hint`）はワーカーが写真から読む
 * （メッセージに載せると、再投入や重複配信で写真の中身と食い違ったものが届きうる）
 */
export class PhotoQueueService {
  private readonly client: QueueClient;

  constructor() {
    // キューの名前は必須（既定値を持たない）。ワーカーのトリガー（'%PHOTO_QUEUE_NAME%'）は既定値を持てないので、
    // 送る側だけ既定のキューに送ると、設定が無くて動かないワーカーの代わりに誰も拾わないキューへ積むことになる
    // 前後の空白は落とさない（トリガーは設定の値をそのまま使うので、落とすと別のキューに送ることになる）
    const queueName = process.env.PHOTO_QUEUE_NAME;
    if (!queueName?.trim()) {
      throw new Error('PHOTO_QUEUE_NAME（解析のキューの名前）が設定されていません');
    }
    // ワーカーのトリガー（connection: 'AzureWebJobsStorage'）と同じストレージアカウントのキュー
    this.client = new QueueClient(process.env.AzureWebJobsStorage!, queueName);
  }

  /**
   * 写真の解析を依頼する
   * @param photoId 写真の ID
   */
  async enqueue(photoId: string): Promise<void> {
    // Functions のキューのトリガーは本文を base64 として読む（host.json の messageEncoding の既定）。
    // JSON をそのまま送ると、トリガーが読めずに poison に落ちる
    const body = Buffer.from(JSON.stringify({ photoId }), 'utf8').toString('base64');
    await this.client.sendMessage(body);
  }
}

/**
 * 写真の解析を依頼する。失敗しても投げず、ログを出して false を返す
 *
 * 投入の前に写真を分類の待ち（pending）にしてあるので、投入に失敗しても再投入のタイマーが拾う。
 * 呼び出し側（送信・やり直しの受付）は、投入の失敗で応答を失敗にしない（失敗を返すと、保存・受付できているのに
 * 利用者が送り直したり、「失敗したのに後で勝手に走る」ことになる）
 * @param photoId 写真の ID
 * @param log ログの出し先
 * @returns 投入できたら true
 */
export async function enqueuePhotoOrLog(photoId: string, log: (...args: unknown[]) => void): Promise<boolean> {
  try {
    await new PhotoQueueService().enqueue(photoId);
    return true;
  } catch (error: any) {
    log(`解析のキューへの投入に失敗しました（タイマーが再投入します）: ID=${photoId}`, error);
    return false;
  }
}
