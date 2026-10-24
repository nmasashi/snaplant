import { hourFromEnv, positiveIntFromEnv } from './validation';
import { PhotoProcessing } from '../types/album';

/**
 * 旅行アルバムの定数
 */

/**
 * 撮影日時の無い写真の並び位置（sortAt）を決めるときに、アップロード日時（UTC）をずらす量（分）
 *
 * 撮影日時はタイムゾーン無しの「撮影した土地での時刻」で、利用者は日本在住、旅行の多くは国内。
 * アップロード日時を日本時間に直して揃えると、撮影日時のある写真と同じ物差しで並ぶ
 * （docs/04_data_design.md §1.3）
 */
export const SORT_AT_UTC_OFFSET_MINUTES = 540;

/**
 * 写真の URL（SAS）を、発行の何分前から有効にするか
 *
 * サーバと Blob Storage の時計がずれると、発行した直後の URL が「まだ有効でない」で 403 になる
 */
export const PHOTO_SAS_START_SKEW_MINUTES = 5;

/**
 * 写真一覧の継続トークンの大きさの上限（KB）
 *
 * トークンはクエリパラメータで受け渡すので、URL の長さの上限に収める。
 * Cosmos は ORDER BY の横断クエリでトークンが長くなりうるため、SDK に上限を渡して抑える
 * （小さすぎると Cosmos が1ページに返す件数が減るだけで、結果は欠けない）
 */
export const PHOTO_CONTINUATION_TOKEN_LIMIT_KB = 2;

/**
 * 写真一覧で、結果が揃っていない空のページを読み直す回数の上限
 *
 * enableQueryControl の Cosmos は、まだ結果を返せないパーティションがあると空のページを返す。
 * 上限に達したら空のページをトークン付きで返し、クライアントが続きを取る（無限に読み続けない）
 */
export const PHOTO_EMPTY_PAGE_RETRIES = 10;

/**
 * 写真の解析（分類・識別）を試す回数の上限（PHOTO_PROCESSING_MAX_ATTEMPTS。既定 3）
 *
 * 上限に達したら failed にし、キューの再試行にも再投入のタイマーにも回さない（同じ画像で毎回失敗しても回り続けない）。
 * キューの再試行の回数（host.json の maxDequeueCount 3）より大きくすると、上限の前にメッセージが poison に落ち、
 * 残りはタイマーの再投入（10 分ごと）だけで進むので、maxDequeueCount 以下にする。呼ぶたびに読む
 */
export function photoProcessingMaxAttempts(): number {
  return positiveIntFromEnv(process.env.PHOTO_PROCESSING_MAX_ATTEMPTS, 3);
}

/**
 * 分類・識別の AI に渡す原寸の SAS の有効期限（分）
 *
 * AI が画像を取りに来るまでの間だけ開ける（一時画像と同じ理由。docs/06_processing_design.md §2.1）
 */
export const CLASSIFY_IMAGE_SAS_MINUTES = 15;

/**
 * 解析待ち・処理中のまま止まった写真を、再投入のタイマーが拾うまでの時間（分）
 *
 * キューの可視性タイムアウト（1 分）と再試行（3 回）、ワーカーの 1 回の処理（5 分以内）より長くとる。
 * 短いと、キューに残っているだけの写真まで積み直して、メッセージが増える（06 §1.1）
 */
export const PHOTO_REQUEUE_AFTER_MINUTES = 10;

/**
 * 掃除のタイマーが、写真の文書の無い Blob を消すまでの時間（時間）
 *
 * 新しい Blob は送信の途中（Blob を書いた後、文書を作る前）かもしれないので消さない。
 * 送信は数分で終わるので、1日あれば途中の Blob を消すことは無い（docs/04_data_design.md §7.2）
 */
export const ORPHAN_BLOB_MIN_AGE_HOURS = 24;

/**
 * タイムラインの日付の切り替えの時刻（TIMELINE_DAY_START_HOUR。0〜23、既定 4）
 *
 * 4 なら 10月6日 2:30 の写真は 10月5日に入る（深夜まで出かけた写真を前の日に入れる）。
 * 作る・作り直すときに読み、下書きに書く（後で変えても、作り直すまでその値で日を分ける。docs/07_infrastructure_design.md §6.1）
 */
export function timelineDayStartHour(): number {
  return hourFromEnv(process.env.TIMELINE_DAY_START_HOUR, 4);
}

/**
 * タイムラインの写真の控えに残すコメントの長さ（文字）
 *
 * AI に渡す分だけを残す。全文（最大 500 文字）を控えると、写真の多い旅行で控えの文書が大きくなる（docs/04_data_design.md §1.6）
 */
export const TIMELINE_SNAPSHOT_COMMENT_LENGTH = 100;

/**
 * 解析（分類・識別）が済んでいない写真の状態
 *
 * 再投入のタイマーが拾う状態で、タイムラインを作れない状態（none・done・failed は済んだものとして扱う。01 §5.3.1）。
 * SQL の IN の並び（albumService.listStalePhotos）も同じ3つにする
 */
export const UNFINISHED_PROCESSING_STATES: readonly PhotoProcessing['state'][] = ['pending', 'classifying', 'identifying'];
