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
