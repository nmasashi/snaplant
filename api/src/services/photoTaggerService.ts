import { CATALOG_KINDS } from '../catalog/kinds';
import { TAG_VALIDATION } from '../constants/validation';
import { OpenAIVisionService } from './openAIVisionService';
import { UpstreamError } from '../utils/errors';
import { GRAPHEMES } from '../utils/graphemes';
import { exceedsLength, trimUserText } from '../utils/userText';
import { LandmarkCandidate } from './landmarkCandidates';

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

/**
 * 名所のタグの提案の応答の形（Structured Outputs。docs/06_processing_design.md §10）。料理と同じく、位置と個数の上限はコードで直す
 */
const LANDMARK_TAGS_SCHEMA = {
  type: 'object',
  properties: {
    landmarks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '建物・名所の固有の名前' },
          x: { type: 'number', description: 'そのものの中心の横の位置（0〜1）' },
          y: { type: 'number', description: 'そのものの中心の縦の位置（0〜1）' },
        },
        required: ['name', 'x', 'y'],
        additionalProperties: false,
      },
    },
  },
  required: ['landmarks'],
  additionalProperties: false,
};

/** AI が提案したタグ1つ（料理か名所。名前は切り詰め、位置は 0〜1 に収めた後） */
export interface TagSuggestion {
  name: string;
  x: number;
  y: number;
}

/**
 * 写真にタグ（名前と位置）を AI に提案させる。食べ物は皿ごと（C-4。06 §9。02 §5 #61）、風景は名所ごと（C-5。06 §10。02 §5 #65）
 *
 * 位置を答えさせるので画像を細かく（detail: high）渡す（試作では low が位置と名前を外した。09「AI のタグの提案の試作」）
 */
export class PhotoTaggerService {
  constructor(private readonly vision = new OpenAIVisionService()) {}

  /**
   * @param imageUrl 原寸の Blob の読み取り SAS 付き URL
   * @returns 皿ごとの提案（TAG_VALIDATION.MAX_COUNT 個まで）。料理が無ければ空
   * @throws UpstreamError（ai） AI の失敗と、応答の検証違反（dishes が配列でない、答えた皿がどれも通らない）
   */
  async suggest(imageUrl: string): Promise<TagSuggestion[]> {
    const prompt = `
この写真に写っている料理を、皿（器）ごとに挙げてください。
- name: 名前の決まり: ${CATALOG_KINDS.food.namingRule}
- x, y: その皿の中心の位置。画像の左上を (0, 0)、右下を (1, 1) とする割合で答える
- 飲み物も1つの皿として数える。料理が写っていなければ dishes を空にする
- 同じ料理が複数の皿にあれば、皿ごとに別に挙げる
- 1つの皿・区画に別々の料理が盛り合わせてあれば（ワンプレート・弁当の区画など）、「盛り合わせ」とまとめずに料理ごとに分けて挙げ、x, y はその料理の中心にする。付け合わせの小さな野菜は、主な料理にまとめてよい
`;
    return this.request('dish_tags', DISH_TAGS_SCHEMA, 'dishes', prompt, imageUrl);
  }

  /**
   * 風景の写真に写った建物・名所のタグを AI に提案させる（C-5。06 §10。02 §5 #65）
   *
   * @param imageUrl 原寸の Blob の読み取り SAS 付き URL
   * @param clues 撮影地の地名（あれば）と、撮影地の周りの名所の候補（座標のある写真だけ。無ければ空）
   * @returns 名所ごとの提案（TAG_VALIDATION.MAX_COUNT 個まで）。名所が無ければ空
   * @throws UpstreamError（ai） AI の失敗と、応答の検証違反（landmarks が配列でない、答えた名所がどれも通らない）
   */
  async suggestLandmarks(
    imageUrl: string,
    clues: { placeName: string | null; candidates: LandmarkCandidate[] }
  ): Promise<TagSuggestion[]> {
    const lines = [
      `
この写真に写っている、固有の名前のある建物・名所（城・寺社・橋・塔・山小屋など）を挙げてください。
- 写っていて、固有の名前まで分かるものだけを挙げる。分からないものに名前を付けない。「神社」「橋」のような一般の呼び方は挙げない
- 山・山並みには名前を付けない
- x, y: そのものの中心の位置。画像の左上を (0, 0)、右下を (1, 1) とする割合で答える
- 名所が写っていなければ landmarks を空にする`,
    ];
    if (clues.placeName) {
      lines.push(`撮影地: ${clues.placeName}`);
    }
    if (clues.candidates.length > 0) {
      lines.push(
        '撮影地の周りの名所の候補（地図のデータ。方角と距離は撮影地から）。候補にあるものは候補の名前のまま答える（地図の名前が古くても直さない）。候補に無いものは、写真の中の文字（案内板など）で確かなときだけ挙げる:',
        ...clues.candidates.map((c) => `${c.name}（${c.kindLabel}） ${c.direction} ${c.km.toFixed(1)} km`)
      );
    }
    return this.request('landmark_tags', LANDMARK_TAGS_SCHEMA, 'landmarks', `${lines.join('\n')}\n`, imageUrl);
  }

  /**
   * AI に画像を細かく（detail: high）渡してタグを頼み、答えの配列（listKey の項目）を検証して提案にする
   */
  private async request(schemaName: string, schema: Record<string, unknown>, listKey: string, prompt: string, imageUrl: string): Promise<TagSuggestion[]> {
    try {
      const result = (await this.vision.analyze({
        schemaName,
        schema,
        prompt,
        imageUrl,
        detail: 'high',
      })) as Record<string, unknown>;

      // strict のスキーマでも、空の名前や数でない位置が来ないことは保証されない。形の崩れた応答は AI の失敗にする
      const items = result[listKey];
      if (!Array.isArray(items)) {
        throw new Error(`${listKey}が配列ではありません`);
      }
      // 通らないものだけを捨てる（1つの誤りで、通ったものまで捨てて detail: high の呼び出しをやり直さない）
      const suggestions = items
        .map(toSuggestion)
        .filter((item): item is TagSuggestion => item !== null)
        .slice(0, TAG_VALIDATION.MAX_COUNT);
      // 答えたものがどれも通らないのは「写っていない」ではないので、AI の失敗にしてやり直す
      if (items.length > 0 && suggestions.length === 0) {
        throw new Error('答えたものがどれも検証に通りません');
      }
      return suggestions;
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
function toSuggestion(dish: any): TagSuggestion | null {
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
