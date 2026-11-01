import { CATALOG_KINDS } from '../catalog/kinds';
import { TAG_VALIDATION } from '../constants/validation';
import { OpenAIVisionService } from './openAIVisionService';
import { UpstreamError } from '../utils/errors';
import { GRAPHEMES } from '../utils/graphemes';
import { exceedsLength, trimUserText } from '../utils/userText';

/**
 * タグの提案の応答の形（Structured Outputs。docs/06_processing_design.md §9）
 *
 * strict モードでは minimum / maximum / maxItems を書けないので、位置の 0〜1 と個数の上限はコードで直す
 */
const DISH_TAGS_SCHEMA = {
  type: 'object',
  properties: {
    dishes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '料理の名前' },
          x: { type: 'number', description: '皿の中心の横の位置（0〜1）' },
          y: { type: 'number', description: '皿の中心の縦の位置（0〜1）' },
        },
        required: ['name', 'x', 'y'],
        additionalProperties: false,
      },
    },
  },
  required: ['dishes'],
  additionalProperties: false,
};

/** AI が提案した料理1つ（名前は切り詰め、位置は 0〜1 に収めた後） */
export interface DishSuggestion {
  name: string;
  x: number;
  y: number;
}

/**
 * 食べ物の写真に、皿ごとのタグ（名前と位置）を AI に提案させる（C-4。06 §9。02 §5 #61）
 *
 * 位置を答えさせるので画像を細かく（detail: high）渡す（試作では low が位置と名前を外した。09「AI のタグの提案の試作」）
 */
export class PhotoTaggerService {
  constructor(private readonly vision = new OpenAIVisionService()) {}

  /**
   * @param imageUrl 原寸の Blob の読み取り SAS 付き URL
   * @returns 皿ごとの提案（TAG_VALIDATION.MAX_COUNT 個まで）。料理が無ければ空
   * @throws UpstreamError（ai） AI の失敗と、応答の検証違反
   */
  async suggest(imageUrl: string): Promise<DishSuggestion[]> {
    const prompt = `
この写真に写っている料理を、皿（器）ごとに挙げてください。
- name: 名前の決まり: ${CATALOG_KINDS.food.namingRule}
- x, y: その皿の中心の位置。画像の左上を (0, 0)、右下を (1, 1) とする割合で答える
- 飲み物も1つの皿として数える。料理が写っていなければ dishes を空にする
- 同じ料理が複数の皿にあれば、皿ごとに別に挙げる
- 1つの皿・区画に別々の料理が盛り合わせてあれば（ワンプレート・弁当の区画など）、「盛り合わせ」とまとめずに料理ごとに分けて挙げ、x, y はその料理の中心にする。付け合わせの小さな野菜は、主な料理にまとめてよい
`;
    try {
      const result = (await this.vision.analyze({
        schemaName: 'dish_tags',
        schema: DISH_TAGS_SCHEMA,
        prompt,
        imageUrl,
        detail: 'high',
      })) as { dishes: unknown };

      // strict のスキーマでも、空の名前や数でない位置が来ないことは保証されない。形の崩れた応答は AI の失敗にする
      if (!Array.isArray(result.dishes)) {
        throw new Error('dishesが配列ではありません');
      }
      // 通らない皿だけを捨てる（1皿の誤りで、通った皿まで捨てて detail: high の呼び出しをやり直さない）
      return result.dishes
        .map(toSuggestion)
        .filter((dish): dish is DishSuggestion => dish !== null)
        .slice(0, TAG_VALIDATION.MAX_COUNT);
    } catch (error: any) {
      throw new UpstreamError(`タグの提案に失敗しました: ${error.message}`, 'ai', error);
    }
  }
}

/**
 * AI の皿1つを提案にする。名前は手で付けるタグと同じ決まり（05 §5.6・§9.6）で前後の空白を除いて切り詰め、通らなければ null
 *
 * 手で付けるタグの検証が断る名前を保存すると、アプリがタグを送り直したときに 400 になって直せなくなる
 */
function toSuggestion(dish: any): DishSuggestion | null {
  if (typeof dish?.name !== 'string' || typeof dish.x !== 'number' || typeof dish.y !== 'number') {
    return null;
  }
  const name = trimUserText(truncate(trimUserText(dish.name), TAG_VALIDATION.MAX_LENGTH));
  if (name === '' || exceedsLength(name, TAG_VALIDATION.MAX_LENGTH)) {
    return null;
  }
  return { name, x: clamp(dish.x), y: clamp(dish.y) };
}

/** 見た目の文字数（05 §9.6）で切り詰める */
function truncate(text: string, maxLength: number): string {
  const graphemes = [...GRAPHEMES.segment(text)].map((segment) => segment.segment);
  return graphemes.length <= maxLength ? text : graphemes.slice(0, maxLength).join('');
}

/** 画像の中の位置の割合（0〜1）に収める */
function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}
