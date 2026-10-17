import { PhotoClassifierService } from '../../src/services/photoClassifierService';
import { UpstreamError } from '../../src/utils/errors';

// 分類の入口（キューのワーカー）は段階3の 3-3 で作る。それまでの間だけ、AI（管理外の依存）に送るものと、
// 応答から返すものをここで確かめる。3-3 でワーカーのテストに同じ振る舞いが揃ったら寄せて消す（CLAUDE.md の名簿）
jest.mock('openai');
const MockedOpenAI = jest.requireMock('openai');

const ENV_KEYS = [
  'AZURE_OPENAI_ENDPOINT',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_DEPLOYMENT_NAME',
  'AZURE_OPENAI_CLASSIFY_DEPLOYMENT_NAME',
  'AZURE_OPENAI_API_VERSION',
  'OPENAI_API_KEY'
] as const;

// 原寸の Blob の読み取り SAS（docs/travel-album/06_processing_design.md §2.1）
const IMAGE_URL = 'https://test.blob.core.windows.net/photos/photo-1.jpg?sv=2024-11-04&sig=test';

describe('写真の分類', () => {
  let savedEnv: Record<string, string | undefined>;
  // AI に送った要求。どの接続先（クライアントの設定）から送ったかと一緒に残す
  let sent: Array<{ options: any; body: any }>;
  let reply: () => Promise<unknown>;

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    sent = [];
    MockedOpenAI.mockImplementation((options: any) => ({
      chat: {
        completions: {
          create: (body: any) => {
            sent.push({ options, body });
            return reply();
          }
        }
      }
    }));
    process.env.AZURE_OPENAI_ENDPOINT = 'https://test.openai.azure.com';
    process.env.AZURE_OPENAI_API_KEY = 'azure-api-key';
    process.env.AZURE_OPENAI_DEPLOYMENT_NAME = 'main-deployment';
    delete process.env.AZURE_OPENAI_CLASSIFY_DEPLOYMENT_NAME;
    aiReturns({ kind: 'food', confidence: 82.5, reason: 'ラーメンが写っている' });
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    jest.clearAllMocks();
  });

  const aiReturns = (body: unknown) => {
    reply = async () => ({ choices: [{ message: { content: JSON.stringify(body) } }] });
  };

  it('写真を分類すると、AIが選んだ種類と信頼度、使ったデプロイ名を返す', async () => {
    const result = await new PhotoClassifierService().classify(IMAGE_URL, null);

    expect(result).toEqual({ kind: 'food', confidence: 82.5, model: 'main-deployment' });
  });

  it('AIに送るものは、写真の画像（detail: low）と、定義表の種類とotherから1つ選ばせるstrictな応答の形', async () => {
    await new PhotoClassifierService().classify(IMAGE_URL, null);

    expect(sent).toHaveLength(1);
    const body = sent[0].body;

    // メッセージ: user ロールの1件。テキストと画像の2パート。画像は detail: low
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe('user');
    expect(body.messages[0].content).toHaveLength(2);
    expect(body.messages[0].content).toEqual(expect.arrayContaining([
      { type: 'text', text: expect.any(String) },
      { type: 'image_url', image_url: { url: IMAGE_URL, detail: 'low' } }
    ]));

    // 応答の形: Structured Outputs（json_schema・strict）。選択肢は定義表の種類と other
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.strict).toBe(true);
    const schema = body.response_format.json_schema.schema;
    expect(schema.properties.kind.enum).toEqual(['plant', 'food', 'landscape', 'other']);
    expect([...schema.required].sort()).toEqual(['confidence', 'kind', 'reason']);
    expect(Object.keys(schema.properties).sort()).toEqual([...schema.required].sort());
    expect(schema.additionalProperties).toBe(false);

    // トークン上限は max_completion_tokens（max_tokens は新しいモデルでは 400）。temperature は送らない
    expect(typeof body.max_completion_tokens).toBe('number');
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('temperature');
  });

  it('撮影地があれば、手がかりとしてプロンプトに含める', async () => {
    await new PhotoClassifierService().classify(IMAGE_URL, '北海道札幌市中央区');

    const text = sent[0].body.messages[0].content.find((part: any) => part.type === 'text').text;
    expect(text).toContain('北海道札幌市中央区');
  });

  it('分類用のデプロイ名（AZURE_OPENAI_CLASSIFY_DEPLOYMENT_NAME）があれば、そのデプロイに送る', async () => {
    process.env.AZURE_OPENAI_CLASSIFY_DEPLOYMENT_NAME = 'classify-deployment';

    const result = await new PhotoClassifierService().classify(IMAGE_URL, null);

    expect(sent).toHaveLength(1);
    expect(sent[0].options.baseURL).toBe('https://test.openai.azure.com/openai/deployments/classify-deployment');
    expect(sent[0].body.model).toBe('classify-deployment');
    expect(result.model).toBe('classify-deployment');
  });

  it.each([
    ['未設定', undefined],
    ['空文字列', ''],
    ['空白だけ', '  ']
  ])('分類用のデプロイ名が%sなら、今のデプロイ（AZURE_OPENAI_DEPLOYMENT_NAME）に送る', async (_label, value) => {
    if (value !== undefined) {
      process.env.AZURE_OPENAI_CLASSIFY_DEPLOYMENT_NAME = value;
    }

    const result = await new PhotoClassifierService().classify(IMAGE_URL, null);

    expect(sent).toHaveLength(1);
    expect(sent[0].options.baseURL).toBe('https://test.openai.azure.com/openai/deployments/main-deployment');
    expect(sent[0].body.model).toBe('main-deployment');
    expect(result.model).toBe('main-deployment');
  });

  it('Azure OpenAI Serviceの接続先があるのにデプロイ名がどちらも無ければ、AIを呼ばずに失敗する', async () => {
    delete process.env.AZURE_OPENAI_DEPLOYMENT_NAME;

    // 設定の誤りは AI の障害ではないので、UpstreamError にはしない
    const error = await (async () => new PhotoClassifierService().classify(IMAGE_URL, null))().catch((e) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(UpstreamError);
    expect(sent).toHaveLength(0);
  });

  // AI の失敗（UpstreamError('ai')）として投げたか
  const expectAiFailure = async (promise: Promise<unknown>) => {
    const error = await promise.catch((e) => e);
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error.service).toBe('ai');
  };

  it.each([
    ['負の数', -0.1],
    ['100を超える', 100.5],
    ['数値でない', '90']
  ])('信頼度が%sなら、AIの失敗にする', async (_label, confidence) => {
    aiReturns({ kind: 'food', confidence, reason: 'テスト' });

    await expectAiFailure(new PhotoClassifierService().classify(IMAGE_URL, null));
  });

  it.each([0, 100])('信頼度が%sなら受け付ける', async (confidence) => {
    aiReturns({ kind: 'landscape', confidence, reason: 'テスト' });

    const result = await new PhotoClassifierService().classify(IMAGE_URL, null);

    expect(result.confidence).toBe(confidence);
  });

  it('種類が選択肢に無ければ、AIの失敗にする', async () => {
    aiReturns({ kind: 'animal', confidence: 90, reason: '犬が写っている' });

    await expectAiFailure(new PhotoClassifierService().classify(IMAGE_URL, null));
  });

  it.each([
    ['空', null],
    ['JSONとして読めない', '{"kind": "food"']
  ])('応答が%sなら、AIの失敗にする', async (_label, content) => {
    reply = async () => ({ choices: [{ message: { content } }] });

    await expectAiFailure(new PhotoClassifierService().classify(IMAGE_URL, null));
  });

  it('AIの呼び出しが失敗したら、AIの失敗にする', async () => {
    // 実 SDK のエラー応答の形（message に OpenAI は入らない）
    reply = async () => {
      throw Object.assign(new Error('500 The server had an error while processing your request.'), {
        name: 'InternalServerError',
        status: 500
      });
    };

    await expectAiFailure(new PhotoClassifierService().classify(IMAGE_URL, null));
  });
});
