import { TIMELINE_WRITE_MAX_TOKENS } from '../constants/album';
import { TIMELINE_VALIDATION } from '../constants/validation';
import { UpstreamError } from '../utils/errors';
import { OpenAIVisionService } from './openAIVisionService';
import { TimelinePromptPhoto, dayRangesOf, photoLineOf } from './timelinePrompt';
import { GRAPHEMES } from '../utils/graphemes';

/**
 * 文の応答の形（Structured Outputs。docs/06_processing_design.md §8.3）
 *
 * strict モードでは配列の長さや文字数を強制できないので、頼んだ日と場面がちょうど1回ずつあること・場面の最後の写真の番号と、文の長さはコードで検査する
 */
const TIMELINE_TEXTS_SCHEMA = {
  type: 'object',
  properties: {
    days: {
      type: 'array',
      description: '書いてほしい日ごとの文',
      items: {
        type: 'object',
        properties: {
          date: { type: 'string', description: '日付（YYYY-MM-DD。書いてほしい日のどれか）' },
          title: { type: 'string', description: 'その日を表す短いタイトル' },
          summary: { type: 'string', description: 'その日のまとめ（2〜3文）' },
        },
        required: ['date', 'title', 'summary'],
        additionalProperties: false,
      },
    },
    scenes: {
      type: 'array',
      description: '書いてほしい場面ごとの文',
      items: {
        type: 'object',
        properties: {
          start: { type: 'integer', description: '場面の最初の写真の番号（書いてほしい場面のどれか）' },
          end: { type: 'integer', description: '場面の最後の写真の番号' },
          label: { type: 'string', description: '場面の短い見出し' },
          note: { type: 'string', description: '写っているものについての一言' },
        },
        required: ['start', 'end', 'label', 'note'],
        additionalProperties: false,
      },
    },
  },
  required: ['days', 'scenes'],
  additionalProperties: false,
};

/** 文を書かせる1回分 */
export interface TimelineWriteRequest {
  /** 撮影日時のある写真（撮影の順）。番号は渡した順に 0 から振る */
  photos: TimelinePromptPhoto[];
  /** 区切り（場面の最初の写真の番号。この呼び出しの写真のぶん全部を昇順に。写真は場面ごとに並び、0 番は最初の場面の始まり） */
  sceneStarts: number[];
  /** 文を書いてほしい場面（最初の写真の番号） */
  scenesToWrite: number[];
  /** 文を書いてほしい日 */
  daysToWrite: { date: string; dayNumber: number }[];
}

/** AI が書いた文（前後の空白を除き、上限で切り詰めた後） */
export interface TimelineWrittenTexts {
  days: Map<string, { title: string; summary: string }>;
  scenes: Map<number, { label: string; note: string }>;
}

/**
 * 区切りの場面と日に、見出し・一言・タイトル・まとめを AI に書かせる（段階5。06 §8.3・§8.4）
 *
 * 区切り案と同じく画像は渡さず、写真1枚を1行の文字にする
 */
export class TimelineWriterService {
  /**
   * タイムライン用のデプロイ（`AZURE_OPENAI_TIMELINE_DEPLOYMENT_NAME`。空・空白だけなら今のデプロイ）に送るサービスを作る（06 §8.1）
   *
   * 設定の誤りはここで例外になる。呼び出し側は、失敗を扱える所（ワーカーの try の中）で作る
   */
  constructor(
    private readonly vision = new OpenAIVisionService(process.env.AZURE_OPENAI_TIMELINE_DEPLOYMENT_NAME)
  ) {}

  /**
   * 頼んだ場面と日の文を書かせる
   *
   * @throws UpstreamError（ai） AI の失敗と、応答の検証違反（頼んだ日・場面がちょうど1回ずつ無い、場面の最後の写真の番号が合わない、空の文）
   */
  async write(request: TimelineWriteRequest): Promise<TimelineWrittenTexts> {
    const lines = request.photos.map(({ photo, dayNumber }, index) => photoLineOf(photo, dayNumber, index));
    const endOf = sceneEndsOf(request.sceneStarts, request.photos.length);
    const rangeOf = (start: number) => `${start}番〜${endOf.get(start)}番`;
    const prompt = `
旅行の写真を撮影の順に並べ、場面に区切りました。下に挙げる場面と日に、文を書いてください。

- 場面の見出しは短く（食事なら朝ごはん・昼ごはん・おやつ・夜ごはん・食べ歩き など、それ以外は場所や出来事）
- 場面の一言は、写っているものについて書いてください（手がかりや判断の過程には触れない）
- 日のタイトルはその日を表す短い言葉、まとめは2〜3文
- 渡していないことを作らないでください

日の区切り:
${dayRangesOf(request.photos)}

場面の区切り（場面の最初と最後の写真の番号）: ${request.sceneStarts.map(rangeOf).join('、')}

書いてほしい場面（最初と最後の写真の番号）: ${listOrNone(request.scenesToWrite.map(rangeOf), 'scenes')}
書いてほしい日: ${listOrNone(request.daysToWrite.map(({ date, dayNumber }) => `${date}（${dayNumber}日目）`), 'days')}
写真（[番号] 何日目 撮影時刻 カテゴリ 名前 地名「コメント」）:
${lines.join('\n')}
`;

    try {
      const result = (await this.vision.analyze({
        schemaName: 'timeline_texts',
        schema: TIMELINE_TEXTS_SCHEMA,
        prompt,
        maxCompletionTokens: TIMELINE_WRITE_MAX_TOKENS,
      })) as { days: unknown; scenes: unknown };
      return {
        days: textsByKey(
          result.days,
          request.daysToWrite.map(({ date }) => date),
          (item) => item.date,
          (item) => ({
            title: textOf(item.title, TIMELINE_VALIDATION.MAX_LENGTH.TITLE),
            summary: textOf(item.summary, TIMELINE_VALIDATION.MAX_LENGTH.SUMMARY),
          })
        ),
        scenes: textsByKey(
          result.scenes,
          request.scenesToWrite,
          (item) => item.start,
          (item) => {
            // 最初の番号だけでは、番号と文の組を取り違えた応答（次の場面の文を返した）を見分けられない
            if (item.end !== endOf.get(item.start)) {
              throw new Error(`場面の最後の写真の番号が合いません: ${item.start}番〜${String(item.end)}番`);
            }
            return {
              label: textOf(item.label, TIMELINE_VALIDATION.MAX_LENGTH.LABEL),
              note: textOf(item.note, TIMELINE_VALIDATION.MAX_LENGTH.NOTE),
            };
          }
        ),
      };
    } catch (error: any) {
      throw new UpstreamError(`タイムラインの文に失敗しました: ${error.message}`, 'ai', error);
    }
  }
}

/**
 * 場面の最初の写真の番号から、最後の写真の番号（次の場面の前、最後の場面はこの呼び出しの最後の写真）
 *
 * 区切りが昇順で、この呼び出しの写真を全部の場面で覆っていること（writeDraftTexts が場面ごとに写真を並べる）を前提にする
 */
function sceneEndsOf(sceneStarts: number[], photoCount: number): Map<number, number> {
  return new Map(sceneStarts.map((start, index) => [start, (sceneStarts[index + 1] ?? photoCount) - 1]));
}

/**
 * 書いてほしいものの並び。無ければ、空の配列で返すよう頼む（頼んでいない日・場面を返すと検証で AI の失敗になるので、はっきり書く）
 */
function listOrNone(items: string[], field: string): string {
  return items.length > 0 ? items.join('、') : `なし（${field} は空の配列にしてください）`;
}

/**
 * 応答の配列を、頼んだ鍵（日付・場面の番号）ごとの文にする。頼んだ鍵がちょうど1回ずつ無ければ投げる
 */
function textsByKey<K, T>(items: unknown, requested: K[], keyOf: (item: any) => unknown, textsOf: (item: any) => T): Map<K, T> {
  if (!Array.isArray(items) || items.length !== requested.length) {
    throw new Error('頼んだ日・場面の数と応答の数が合いません');
  }
  const texts = new Map<K, T>();
  for (const item of items) {
    const key = keyOf(item) as K;
    if (!requested.includes(key) || texts.has(key)) {
      throw new Error(`頼んでいない、または重なった日・場面があります: ${String(key)}`);
    }
    texts.set(key, textsOf(item));
  }
  return texts;
}

/** 前後の空白を除いた文。空なら投げ、上限を超える分は切り詰める（切り詰めて空になるときも投げる） */
function textOf(value: unknown, maxLength: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '') {
    throw new Error('空の文があります');
  }
  if (text.length <= maxLength) {
    return text;
  }
  // 文字数は UTF-16 の数で数える（05 §4）が、見た目の1文字（結合した絵文字・国旗・サロゲートペア）の途中では切らない。
  // 途中で切ると、絵文字の前の部分や国旗の片方だけが残って壊れた文字になる
  let end = 0;
  for (const { index, segment } of GRAPHEMES.segment(text)) {
    if (index + segment.length > maxLength) {
      break;
    }
    end = index + segment.length;
  }
  // 切った位置の直前が空白なら、それも除く（前後の空白を除いた文にする）
  const cut = text.slice(0, end).trimEnd();
  if (cut === '') {
    // 最初の1文字だけで上限を超える（結合文字を重ねた文字など）。空の文は保存しない
    throw new Error('上限に収まる文がありません');
  }
  return cut;
}
