import { CATALOG_KINDS } from '../catalog/kinds';
import { TIMELINE_PROPOSE_MAX_TOKENS } from '../constants/album';
import { TimelinePhotoSnapshot } from '../types/timeline';
import { UpstreamError } from '../utils/errors';
import { OpenAIVisionService } from './openAIVisionService';

/**
 * 区切り案の応答の形（Structured Outputs。docs/06_processing_design.md §8.2）
 *
 * strict モードでは minimum / maximum を書けないので、番号の範囲（0 以上・渡した写真の数未満）はコードで検査する
 */
const TIMELINE_PROPOSAL_SCHEMA = {
  type: 'object',
  properties: {
    sceneStarts: {
      type: 'array',
      items: { type: 'integer' },
      description: '場面の最初の写真の番号（[ ] の中の数）。撮影の順',
    },
  },
  required: ['sceneStarts'],
  additionalProperties: false,
};

/** AI に渡す写真1枚（何日目かは呼び出し側が日を分けて決める） */
export interface TimelineProposalPhoto {
  photo: TimelinePhotoSnapshot;
  /** 何日目か */
  dayNumber: number;
}

/**
 * 旅行の写真から、場面の区切りの案を AI に出させる（段階5。06 §8.2・§8.4）
 *
 * 画像は渡さず、写真1枚を1行の文字にする（費用を抑える。画像の中身は分類・識別の結果として控えに入っている）
 */
export class TimelineProposerService {
  /**
   * タイムライン用のデプロイ（`AZURE_OPENAI_TIMELINE_DEPLOYMENT_NAME`。空・空白だけなら今のデプロイ）に送るサービスを作る（06 §8.1）
   *
   * 設定の誤りはここで例外になる。呼び出し側は、失敗を扱える所（ワーカーの try の中）で作る
   */
  constructor(
    private readonly vision = new OpenAIVisionService(process.env.AZURE_OPENAI_TIMELINE_DEPLOYMENT_NAME)
  ) {}

  /**
   * 区切りの案を出させる
   *
   * @param photos 撮影日時のある写真（撮影の順）。番号は渡した順に 0 から振る
   * @returns 場面の最初の写真の番号（重なりを除いて小さい順）
   * @throws UpstreamError（ai） AI の失敗と、応答の検証違反
   */
  async propose(photos: TimelineProposalPhoto[]): Promise<number[]> {
    const lines = photos.map(({ photo, dayNumber }, index) => photoLineOf(photo, dayNumber, index));
    const prompt = `
旅行の写真を撮影の順に並べました。続けて撮った一まとまりの出来事（食事1回・1か所の観光・食べ歩き・移動など）を1つの場面として、
場面の最初の写真の番号を答えてください。

- 時間のすき間と地名の変化を目安にしてください
- 食事の写真と同じ時間に撮った店内や外観の写真は、同じ場面にしてください
- 日をまたいで1つの場面にしないでください（各日の最初の写真は必ず場面の始まりです）
- 細かく分けすぎないでください

日の区切り:
${dayRangesOf(photos)}

写真（[番号] 何日目 撮影時刻 カテゴリ 名前 地名「コメント」）:
${lines.join('\n')}
`;

    try {
      const result = (await this.vision.analyze({
        schemaName: 'timeline_proposal',
        schema: TIMELINE_PROPOSAL_SCHEMA,
        prompt,
        maxCompletionTokens: TIMELINE_PROPOSE_MAX_TOKENS,
      })) as { sceneStarts: unknown };

      // strict のスキーマでも範囲は強制できない。範囲外の番号を区切りにすると、控えに無い写真を指してしまう
      const starts = result.sceneStarts;
      if (!Array.isArray(starts) || !starts.every((start) => Number.isInteger(start) && start >= 0 && start < photos.length)) {
        throw new Error('sceneStartsが写真の番号の配列ではありません');
      }
      return [...new Set(starts as number[])].sort((a, b) => a - b);
    } catch (error: any) {
      throw new UpstreamError(`タイムラインの区切り案に失敗しました: ${error.message}`, 'ai', error);
    }
  }
}

/**
 * 写真1枚を1行にする（例: `[12] 1日目 10/05 14:25 食べ物 たい焼き 小樽市「店の前で」`）
 *
 * 無い要素は書かない。撮影日時は現地の時刻のまま（タイムゾーンを変換しない）。
 * 名前・地名・コメントの改行は空白にする（利用者が書いたコメントの改行の後ろが、別の写真の行に見えないように）
 */
function photoLineOf(photo: TimelinePhotoSnapshot, dayNumber: number, index: number): string {
  const takenAt = photo.takenAt!;
  const time = `${takenAt.slice(5, 7)}/${takenAt.slice(8, 10)} ${takenAt.slice(11, 16)}`;
  const parts = [`[${index}]`, `${dayNumber}日目`, time, categoryLabelOf(photo.category), oneLine(photo.name), oneLine(photo.placeName)];
  const comment = oneLine(photo.comment);
  return parts.filter((part): part is string => !!part).join(' ') + (comment ? `「${comment}」` : '');
}

/** 改行（続く改行は1つ）を空白にして1行にする。全角の空白など、改行でない空白は利用者が書いたまま残す */
function oneLine(text: string | null): string | null {
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
function dayRangesOf(photos: TimelineProposalPhoto[]): string {
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
