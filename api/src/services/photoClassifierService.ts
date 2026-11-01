import { CATALOG_KINDS, PHOTO_KINDS, PhotoKind } from '../catalog/kinds';
import { OpenAIVisionService } from './openAIVisionService';
import { UpstreamError } from '../utils/errors';
import { aiCommentOf } from '../utils/aiComment';

/** 選択肢のキーの意味（例: `plant（植物）・food（食べ物）`）。キーだけでは AI が種類の境目を判断できないので、定義表の名前を添える */
const KIND_LABELS = Object.entries(CATALOG_KINDS)
  .map(([kind, { label }]) => `${kind}（${label}）`)
  .join('・');

/**
 * 分類の応答の形（Structured Outputs。docs/06_processing_design.md §2.2）
 *
 * 選択肢は定義表の種類と other から組み立てる（定義表に種類を足すと追従する）。
 * strict モードでは minimum / maximum を書けないので、信頼度の 0〜100 はコードで検査する
 */
const PHOTO_CLASSIFICATION_SCHEMA = {
  type: 'object',
  properties: {
    kind: {
      type: 'string',
      enum: PHOTO_KINDS,
      description: `写真の主題のカテゴリ。${KIND_LABELS} のどれでもなければ other`,
    },
    confidence: { type: 'number', description: '分類の信頼度（0-100）' },
    // 判定理由は保存しない（06 §2.3）。AI に理由を書かせて判断を言葉にさせるために残し、出力は数十トークンで費用は無視できる
    reason: { type: 'string', description: '判定理由（日本語で簡潔に）' },
    comment: { type: 'string', description: '写っているものについての一言（日本語）' },
  },
  required: ['kind', 'confidence', 'reason', 'comment'],
  additionalProperties: false,
};

/** 写真の分類の結果 */
export interface PhotoClassification {
  kind: PhotoKind;
  confidence: number;
  /** 分類に使ったデプロイ名 */
  model: string;
  /** 写っているものについての一言（前後の空白を除いたもの）。空なら null */
  comment: string | null;
}

/**
 * 写真の主題を AI に分類させる（段階3）
 */
export class PhotoClassifierService {
  /**
   * 分類用のデプロイ（`AZURE_OPENAI_CLASSIFY_DEPLOYMENT_NAME`。空・空白だけなら今のデプロイ）に送るサービスを作る（06 §2.1）
   *
   * 設定の誤り（デプロイ名が決まらない、API キーが無い）はここで例外になる。呼び出し側は、モジュールの最上位ではなく
   * 失敗を扱える所（ワーカーの try の中）で作る。最上位で作ると、読み込みの時点で落ちて同じアプリの関数がすべて登録されない
   */
  constructor(
    private readonly vision = new OpenAIVisionService(process.env.AZURE_OPENAI_CLASSIFY_DEPLOYMENT_NAME)
  ) {}

  /**
   * 写真を分類する
   *
   * @param imageUrl 原寸の Blob の読み取り SAS 付き URL
   * @param clues 手がかり。撮影地（placeName）と、やり直しで利用者が書いた手がかり（hint）。あれば AI に渡す
   */
  async classify(
    imageUrl: string,
    clues: { placeName: string | null; hint: string | null }
  ): Promise<PhotoClassification> {
    const clueSection =
      (clues.hint ? `\n利用者からの手がかり: ${clues.hint}` : '') +
      (clues.placeName ? `\n撮影地: ${clues.placeName}（手がかりとして使ってください）` : '') +
      (clues.hint || clues.placeName ? '\n' : '');
    const prompt = `
この写真の主題を、${KIND_LABELS} から1つ選んでください。
${clueSection}
人や動物、建物の内装など、当てはまるものが無ければ other を選んでください。
comment は、後で写真を見返す人に向けた、写っているものについての一言にしてください。
料理は見た目で分かる一般的な呼び方（ラーメン・海鮮丼など）にし、名物名や店の料理名は、利用者の手がかりや写真の中の文字（メニュー・看板など）で分かるときのほかは、見た目や撮影地から推し量って書かないでください。
時間がたつと手がかりの内容は分からなくなるので、手がかりや撮影地、判断の過程には触れないでください。
`;

    try {
      const result = (await this.vision.analyze({
        schemaName: 'photo_classification',
        schema: PHOTO_CLASSIFICATION_SCHEMA,
        prompt,
        imageUrl,
      })) as { kind: unknown; confidence: unknown; comment: unknown };

      // strict のスキーマでも、範囲は強制できず、選択肢の外の値が来ないことも検査しないと保証できない。
      // 検査を通らない応答を書き込むと、写真の category が図鑑の種類と食い違う
      if (typeof result.kind !== 'string' || !PHOTO_KINDS.includes(result.kind)) {
        throw new Error('kindが選択肢にありません');
      }
      if (typeof result.confidence !== 'number' || result.confidence < 0 || result.confidence > 100) {
        throw new Error('confidenceが0-100の範囲の数値ではありません');
      }

      return {
        kind: result.kind as PhotoKind,
        confidence: result.confidence,
        model: this.vision.deployment,
        comment: aiCommentOf(result.comment),
      };
    } catch (error: any) {
      throw new UpstreamError(`写真の分類に失敗しました: ${error.message}`, 'ai', error);
    }
  }
}
