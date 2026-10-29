import { CATALOG_KINDS } from '../catalog/kinds';
import { TimelinePhotoSnapshot } from '../types/timeline';

/*
 * タイムラインで AI に渡す文字の部品（区切り案と文で共有する。06 §8.4）
 *
 * 写真1枚を1行にし、日の区切りを番号の範囲で書く。どちらも画像を渡さずに、写真を番号で指すための形
 */

/** AI に渡す写真1枚（何日目かは呼び出し側が日を分けて決める） */
export interface TimelinePromptPhoto {
  photo: TimelinePhotoSnapshot;
  /** 何日目か */
  dayNumber: number;
}

/**
 * 写真1枚を1行にする（例: `[12] 1日目 10/05 14:25 食べ物 たい焼き 小樽市「店の前で」`）
 *
 * 無い要素は書かない。撮影日時は現地の時刻のまま（タイムゾーンを変換しない）。
 * 名前・地名・コメントの改行は空白にする（利用者が書いたコメントの改行の後ろが、別の写真の行に見えないように）
 */
export function photoLineOf(photo: TimelinePhotoSnapshot, dayNumber: number, index: number): string {
  const takenAt = photo.takenAt!;
  const time = `${takenAt.slice(5, 7)}/${takenAt.slice(8, 10)} ${takenAt.slice(11, 16)}`;
  const parts = [`[${index}]`, `${dayNumber}日目`, time, categoryLabelOf(photo.category), oneLine(photo.name), oneLine(photo.placeName)];
  const comment = oneLine(photo.comment);
  return parts.filter((part): part is string => !!part).join(' ') + (comment ? `「${comment}」` : '');
}

/** 改行（続く改行は1つ）を空白にして1行にする。全角の空白など、改行でない空白は利用者が書いたまま残す */
export function oneLine(text: string | null): string | null {
  return text === null ? null : text.replace(/[\r\n\u0085\u2028\u2029]+/g, ' ').trim();
}

/** カテゴリの表示名（図鑑の種類は定義表の名前、それ以外は「その他」、分類していなければ書かない） */
function categoryLabelOf(category: string | null): string | null {
  if (category === null) {
    return null;
  }
  return CATALOG_KINDS[category as keyof typeof CATALOG_KINDS]?.label ?? 'その他';
}

/** 日ごとの番号の範囲（例: `1日目: 0番〜3番`）。区切りが日をまたがないように渡す */
export function dayRangesOf(photos: TimelinePromptPhoto[]): string {
  const ranges: { dayNumber: number; first: number; last: number }[] = [];
  photos.forEach(({ dayNumber }, index) => {
    const range = ranges[ranges.length - 1];
    if (range && range.dayNumber === dayNumber) {
      range.last = index;
    } else {
      ranges.push({ dayNumber, first: index, last: index });
    }
  });
  return ranges.map(({ dayNumber, first, last }) => `${dayNumber}日目: ${first}番〜${last}番`).join('\n');
}
