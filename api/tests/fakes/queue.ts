import { QueueClient } from '@azure/storage-queue';

/**
 * 状態持ちの偽物 Storage Queue（`@azure/storage-queue` の `QueueClient`）。
 *
 * キューは管理下にある依存なので、モックは運用上の例外として許容するが**やり取りの検証はしない**。
 * 投入されたかは呼び出し回数ではなく、キューの名前ごとの `queues` の中身で確かめる
 * （宛先のキューを取り違えると、ワーカーが拾わずにテストが落ちるように、名前で分けて持つ）。
 *
 * 本文は `sendMessage()` に渡された文字列をそのまま積む。読み戻すときは `decodeQueueMessage()` を使う。
 */
export interface FakeQueueBackend {
  /** キューの名前 → 積まれたメッセージの本文（積まれた順） */
  queues: Map<string, string[]>;
  /** `sendMessage()` を失敗させる。何も積まれない */
  forcedSendError?: Error | null;
}

/**
 * `new QueueClient(connectionString, queueName)` の代わりに返す偽物を作る
 * @param backend 積んだメッセージを持つ状態
 * @param queueName コンストラクタに渡されたキューの名前
 */
export function createFakeQueueClient(backend: FakeQueueBackend, queueName: string): QueueClient {
  return {
    name: queueName,
    sendMessage: async (messageText: string) => {
      if (backend.forcedSendError) throw backend.forcedSendError;
      const messages = backend.queues.get(queueName) ?? [];
      messages.push(messageText);
      backend.queues.set(queueName, messages);
      return { messageId: `fake-${messages.length}` };
    }
  } as unknown as QueueClient;
}

/**
 * 積まれた本文を、Functions のキューのトリガーが読むのと同じ形で読み戻す。
 *
 * トリガーは本文を base64 として読む（host.json の `extensions.queues.messageEncoding` の既定）。
 * JSON をそのまま積むと、トリガーが読めずにメッセージが poison に落ちる。base64 でない本文はここで読めずに失敗する
 */
export function decodeQueueMessage(messageText: string): unknown {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(messageText)) {
    throw new Error(`base64 ではない本文です: ${messageText}`);
  }
  return JSON.parse(Buffer.from(messageText, 'base64').toString('utf8'));
}
