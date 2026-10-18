import { CATALOG_KINDS, CatalogKind } from '../catalog/kinds';
import { OpenAIVisionService } from './openAIVisionService';
import { UpstreamError } from '../utils/errors';
import { CATALOG_VALIDATION } from '../constants/validation';

/**
 * 識別の応答の形（Structured Outputs。docs/travel-album/06_processing_design.md §3.1）
 *
 * 種類ごとの項目（attributes）は定義表の fields から組み立てる（定義表に項目を足すと追従する）。
 * strict モードではすべての項目を required に入れなければならないので、無いことは null で表す
 * @param kind 図鑑の種類
 */
function identificationSchema(kind: CatalogKind) {
  const fields = CATALOG_KINDS[kind].fields;
  return {
    type: 'object',
    properties: {
      matchesKind: { type: 'boolean', description: `写真に${CATALOG_KINDS[kind].label}が写っているか` },
      name: { type: ['string', 'null'], description: '名前の決まりどおりの名前。写っていなければ null' },
      confidence: { type: 'number', description: '識別の信頼度（0-100）' },
      description: { type: ['string', 'null'], description: 'その種類の説明。写っていなければ null' },
      characteristics: { type: ['string', 'null'], description: '見た目の特徴（一言）。写っていなければ null' },
      comment: { type: 'string', description: 'この写真への一言。写っていなければ、そう判断した理由' },
      attributes: {
        type: 'object',
        properties: Object.fromEntries(
          fields.map((field) => [
            field.key,
            field.type === 'string[]'
              ? { type: ['array', 'null'], items: { type: 'string' }, description: field.prompt }
              : { type: ['string', 'null'], description: field.prompt },
          ])
        ),
        required: fields.map((field) => field.key),
        additionalProperties: false,
      },
    },
    required: ['matchesKind', 'name', 'confidence', 'description', 'characteristics', 'comment', 'attributes'],
    additionalProperties: false,
  };
}

/** 写真の識別の結果 */
export interface PhotoIdentification {
  /** 分類どおりの種類が写っているか */
  matchesKind: boolean;
  /** 名前（前後の空白を除いたもの）。写っていなければ null */
  name: string | null;
  confidence: number;
  description: string | null;
  characteristics: string | null;
  /** この写真への一言（前後の空白を除いたもの）。写っていなければ、そう判断した理由。空なら null */
  comment: string | null;
  /** 種類ごとの項目（キーは定義表の fields の key） */
  attributes: Record<string, unknown>;
  /** 識別に使ったデプロイ名 */
  model: string;
}

/**
 * 写真に写ったものの名前を AI に答えさせる（段階4）
 */
export class PhotoIdentifierService {
  /**
   * 今のデプロイ（`AZURE_OPENAI_DEPLOYMENT_NAME`）に送るサービスを作る。識別用のデプロイ名は置かない（06 §3.1）
   *
   * 設定の誤りはここで例外になる。呼び出し側は失敗を扱える所（ワーカーの try の中）で作る（PhotoClassifierService と同じ）
   */
  constructor(private readonly vision = new OpenAIVisionService()) {}

  /**
   * 写真を識別する
   *
   * @param imageUrl 原寸の Blob の読み取り SAS 付き URL
   * @param kind 分類で決まった図鑑の種類
   * @param clues 手がかり。撮影地（placeName）、撮影日時（takenAt。TZ 無し）、やり直しで利用者が書いた手がかり（hint）
   */
  async identify(
    imageUrl: string,
    kind: CatalogKind,
    clues: { placeName: string | null; takenAt: string | null; hint: string | null }
  ): Promise<PhotoIdentification> {
    const { label, namingRule } = CATALOG_KINDS[kind];
    const clueLines = [
      clues.hint ? `利用者からの手がかり: ${clues.hint}` : null,
      clues.placeName ? `撮影地: ${clues.placeName}` : null,
      // takenAt は YYYY-MM-DDTHH:mm:ss（TZ 無し）。分までを読みやすい形で渡す
      clues.takenAt ? `撮影日時: ${clues.takenAt.slice(0, 10)} ${clues.takenAt.slice(11, 16)}` : null,
    ].filter((line) => line !== null);
    const clueSection =
      clueLines.length > 0 ? `\n追加情報：\n${clueLines.join('\n')}\nこの情報を参考にして、識別の精度を向上させてください。\n` : '';
    const prompt = `
この写真に写っている${label}を識別してください。
名前の決まり: ${namingRule}
候補を列挙せず、1つに決めてください。確証が無いときは、comment で「〇〇の可能性もある」のように補足してください。
写真に${label}が写っていなければ、matchesKind を false にし、comment にそう判断した理由を書いてください。
${clueSection}`;

    try {
      const result = (await this.vision.analyze({
        schemaName: 'photo_identification',
        schema: identificationSchema(kind),
        prompt,
        imageUrl,
      })) as {
        matchesKind: unknown;
        name: unknown;
        confidence: unknown;
        description: string | null;
        characteristics: string | null;
        comment: string;
        attributes: Record<string, unknown>;
      };

      // strict のスキーマでも、範囲・空・長さは強制できない。通らない応答を書くと、図鑑に名前の無い項目や範囲外の信頼度が出る
      if (typeof result.matchesKind !== 'boolean') {
        throw new Error('matchesKindが真偽値ではありません');
      }
      if (typeof result.confidence !== 'number' || result.confidence < 0 || result.confidence > 100) {
        throw new Error('confidenceが0-100の範囲の数値ではありません');
      }
      const name = typeof result.name === 'string' ? result.name.trim() : null;
      if (result.matchesKind && (!name || name.length > CATALOG_VALIDATION.NAME_MAX_LENGTH)) {
        throw new Error(`nameが空か、${CATALOG_VALIDATION.NAME_MAX_LENGTH}文字を超えています`);
      }
      const attributes = Object.fromEntries(
        CATALOG_KINDS[kind].fields.map((field) => {
          const value = result.attributes?.[field.key] ?? null;
          const valid =
            value === null ||
            (field.type === 'string[]'
              ? Array.isArray(value) && value.every((item) => typeof item === 'string')
              : typeof value === 'string');
          if (!valid) {
            throw new Error(`attributesの${field.key}が型（${field.type}）に合いません`);
          }
          return [field.key, value];
        })
      );
      const comment = typeof result.comment === 'string' ? result.comment.trim() : '';

      return {
        matchesKind: result.matchesKind,
        name: result.matchesKind ? name : null,
        confidence: result.confidence,
        description: result.description,
        characteristics: result.characteristics,
        comment: comment || null,
        attributes,
        model: this.vision.deployment,
      };
    } catch (error: any) {
      throw new UpstreamError(`写真の識別に失敗しました: ${error.message}`, 'ai', error);
    }
  }
}
