import { PhotoLocation } from '../types/album';

/**
 * 写真の撮影地の有無（名所のタグの提案に回すかの条件。docs/06_processing_design.md §10）。
 * 解析のワーカーと、既にある写真を回すスクリプトで同じ条件を使う
 */

/** 緯度・経度があるか（名所の候補を引ける） */
export function hasCoordinates(location: PhotoLocation | null | undefined): boolean {
  return typeof location?.latitude === 'number' && typeof location?.longitude === 'number';
}

/** 撮影地（緯度・経度か地名）があるか。無ければ写真だけでは名所の精度が無いので、名所の提案に回さない（02 §5 #65） */
export function hasPlace(location: PhotoLocation | null | undefined): boolean {
  return hasCoordinates(location) || Boolean(location?.placeName);
}
