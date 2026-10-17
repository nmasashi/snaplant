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
    // ワーカーのトリガー（connection: 'AzureWebJobsStorage'）と同じストレージアカウントのキュー
    this.client = new QueueClient(
      process.env.AzureWebJobsStorage!,
      process.env.PHOTO_QUEUE_NAME || 'photo-processing'
    );
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
