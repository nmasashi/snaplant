import { CATALOG_KINDS, OTHER_KIND, PhotoKind } from '../catalog/kinds';
import { OpenAIVisionService } from './openAIVisionService';
import { UpstreamError } from '../utils/errors';

/** 分類 AI が選べる種類 */
const CLASSIFICATION_KINDS: readonly string[] = [...Object.keys(CATALOG_KINDS), OTHER_KIND];

/** 選択肢のキーの意味（例: `plant（植物）・food（食べ物）`）。キーだけでは AI が種類の境目を判断できないので、定義表の名前を添える */
const KIND_LABELS = Object.entries(CATALOG_KINDS)
  .map(([kind, { label }]) => `${kind}（${label}）`)
  .join('・');

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
      description: `写真の主題のカテゴリ。${KIND_LABELS} のどれでもなければ other`,
    },
    confidence: { type: 'number', description: '分類の信頼度（0-100）' },
    // 判定理由は保存しない（06 §2.3）。AI に理由を書かせて判断を言葉にさせるために残し、出力は数十トークンで費用は無視できる
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
  // 分類用のデプロイが無ければ今のデプロイを使う（06 §2.1。OpenAIVisionService が空・空白だけも未設定として扱う）
  constructor(
    private readonly vision = new OpenAIVisionService(process.env.AZURE_OPENAI_CLASSIFY_DEPLOYMENT_NAME)
  ) {}

  /**
   * 写真を分類する
   *
   * @param imageUrl 原寸の Blob の読み取り SAS 付き URL
   * @param placeName 撮影地（あれば手がかりとして AI に渡す）
   */
  async classify(imageUrl: string, placeName: string | null): Promise<PhotoClassification> {
    const placeSection = placeName ? `\n撮影地: ${placeName}（手がかりとして使ってください）\n` : '';
    const prompt = `
この写真の主題を、${KIND_LABELS} から1つ選んでください。
${placeSection}
人や動物、建物の内装など、当てはまるものが無ければ other を選んでください。
`;

    try {
      const result = (await this.vision.analyze({
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

      return { kind: result.kind as PhotoKind, confidence: result.confidence, model: this.vision.deployment };
    } catch (error: any) {
      throw new UpstreamError(`写真の分類に失敗しました: ${error.message}`, 'ai', error);
    }
  }
}
