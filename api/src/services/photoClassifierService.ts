import { CATALOG_KINDS, OTHER_KIND, PhotoKind } from '../catalog/kinds';
import { OpenAIVisionService } from './openAIVisionService';
import { UpstreamError } from '../utils/errors';

/** 分類 AI が選べる種類 */
const CLASSIFICATION_KINDS: readonly string[] = [...Object.keys(CATALOG_KINDS), OTHER_KIND];

/**
 * 分類の応答の形（Structured Outputs。docs/travel-album/06_processing_design.md §2.2）
 *
 * 選択肢は定義表の種類と other から組み立てる（定義表に種類を足すと追従する）。
 * strict モードでは minimum / maximum を書けないので、信頼度の 0〜100 はコードで検査する
 */
const PHOTO_CLASSIFICATION_SCHEMA = {
  type: 'object',
  properties: {
    kind: {
      type: 'string',
      enum: CLASSIFICATION_KINDS,
      description: '写真の主題のカテゴリ。どれにも当てはまらなければ other',
    },
    confidence: { type: 'number', description: '分類の信頼度（0-100）' },
    reason: { type: 'string', description: '判定理由（日本語で簡潔に）' },
  },
  required: ['kind', 'confidence', 'reason'],
  additionalProperties: false,
};

/** 写真の分類の結果 */
export interface PhotoClassification {
  kind: PhotoKind;
  confidence: number;
  /** 分類に使ったデプロイ名 */
  model: string;
}

/**
 * 写真の主題を AI に分類させる（段階3）
 */
export class PhotoClassifierService {
  constructor(private readonly vision = new OpenAIVisionService()) {}

  /**
   * 写真を分類する
   *
   * @param imageUrl 原寸の Blob の読み取り SAS 付き URL
   * @param placeName 撮影地（あれば手がかりとして AI に渡す）
   */
  async classify(imageUrl: string, placeName: string | null): Promise<PhotoClassification> {
    // 分類用のデプロイが無ければ今のデプロイを使う（06 §2.1）
    const deployment =
      process.env.AZURE_OPENAI_CLASSIFY_DEPLOYMENT_NAME?.trim() || this.vision.defaultDeployment;
    const placeSection = placeName ? `\n撮影地: ${placeName}（手がかりとして使ってください）\n` : '';
    const prompt = `
この写真の主題を1つ選んでください。
${placeSection}
人や動物、建物の内装など、当てはまるものが無ければ other を選んでください。
`;

    try {
      const result = (await this.vision.analyze({
        deployment,
        schemaName: 'photo_classification',
        schema: PHOTO_CLASSIFICATION_SCHEMA,
        prompt,
        imageUrl,
      })) as { kind: unknown; confidence: unknown };

      // strict のスキーマでも、範囲は強制できず、選択肢の外の値が来ないことも検査しないと保証できない。
      // 検査を通らない応答を書き込むと、写真の category が図鑑の種類と食い違う
      if (typeof result.kind !== 'string' || !CLASSIFICATION_KINDS.includes(result.kind)) {
        throw new Error('kindが選択肢にありません');
      }
      if (typeof result.confidence !== 'number' || result.confidence < 0 || result.confidence > 100) {
        throw new Error('confidenceが0-100の範囲の数値ではありません');
      }

      return { kind: result.kind as PhotoKind, confidence: result.confidence, model: deployment };
    } catch (error: any) {
      throw new UpstreamError(`写真の分類に失敗しました: ${error.message}`, 'ai', error);
    }
  }
}
