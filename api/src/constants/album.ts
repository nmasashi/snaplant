/**
 * 旅行アルバムの定数
 */

/**
 * 撮影日時の無い写真の並び位置（sortAt）を決めるときに、アップロード日時（UTC）をずらす量（分）
 *
 * 撮影日時はタイムゾーン無しの「撮影した土地での時刻」で、利用者は日本在住、旅行の多くは国内。
 * アップロード日時を日本時間に直して揃えると、撮影日時のある写真と同じ物差しで並ぶ
 * （docs/travel-album/04_data_design.md §1.3）
 */
export const SORT_AT_UTC_OFFSET_MINUTES = 540;

/**
 * 写真の URL（SAS）を、発行の何分前から有効にするか
 *
 * サーバと Blob Storage の時計がずれると、発行した直後の URL が「まだ有効でない」で 403 になる
 */
export const PHOTO_SAS_START_SKEW_MINUTES = 5;
