/**
 * 文を見た目の1文字（書記素）ずつに分ける
 *
 * 結合した絵文字・国旗・サロゲートペアを1文字として扱う。UTF-16 やコードポイントの単位で文を切ると、
 * それらの一部だけが残って壊れた文字になるので、文を切り詰めるところはこれで境目を決める
 * （タイムラインの写真の控えのコメント（docs/04_data_design.md §1.6）と、AI が書いた文の切り詰め（docs/06_processing_design.md §8.3））
 */
export const GRAPHEMES = new Intl.Segmenter('ja', { granularity: 'grapheme' });
