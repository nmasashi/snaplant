import { TIMELINE_PROPOSE_MAX_TOKENS } from '../constants/album';
import { UpstreamError } from '../utils/errors';
import { OpenAIVisionService } from './openAIVisionService';
import { TimelinePromptPhoto, dayRangesOf, photoLineOf } from './timelinePrompt';

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
  async propose(photos: TimelinePromptPhoto[]): Promise<number[]> {
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
