// 試作: AI がタグ（皿ごとの点と名前）を提案できるかの当たり具合を見る（11 §9.1 の C-4 の前の試し。捨てる前提）
//
// 使い方（リポジトリ直下で）:
//   1. .work/spike-tags/photos/ に食べ物の写真（jpg / png / webp）を置く
//   2. .work/spike-tags/.env に AZURE_OPENAI_ENDPOINT・AZURE_OPENAI_API_KEY・AZURE_OPENAI_DEPLOYMENT_NAME
//      （任意で AZURE_OPENAI_API_VERSION）を KEY=VALUE の形で書く
//   3. node spikes/tag-suggestions/run.js            （detail を low と high の両方で試す）
//      node spikes/tag-suggestions/run.js high       （片方だけ）
//   4. .work/spike-tags/result.html をブラウザで開く
//
// 鍵は .env から読むだけで、表示も書き出しもしない。結果の JSON にも鍵や URL は入れない
const fs = require('fs');
const path = require('path');
const OpenAI = require(path.join(__dirname, '..', '..', 'api', 'node_modules', 'openai')).default;

const WORK = path.join(__dirname, '..', '..', '.work', 'spike-tags');
const PHOTOS = path.join(WORK, 'photos');

/** .env を読む（値は表示しない） */
function loadEnv() {
  const file = path.join(WORK, '.env');
  if (!fs.existsSync(file)) throw new Error(`${file} がありません`);
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  for (const key of ['AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_DEPLOYMENT_NAME']) {
    if (!env[key]) throw new Error(`.env に ${key} がありません`);
  }
  return env;
}

// 名前の決まりは食べ物の namingRule（02 §5 #60）と同じ考え方
const PROMPT = `
この写真に写っている料理を、皿（器）ごとに挙げてください。
- name: 一般的な料理名（例: 味噌ラーメン・海鮮丼）か、分からなければ料理の種類（例: ラーメン）。名物名や店の看板料理などの固有の名前は、写真の中の文字（メニュー・看板など）で分かるときだけにし、見た目だけで推し量らない
- x, y: その皿の中心の位置。画像の左上を (0, 0)、右下を (1, 1) とする割合で答える
- 飲み物も1つの皿として数える。料理が写っていなければ dishes を空にする
- 同じ料理が複数の皿にあれば、皿ごとに別に挙げる
`;

const SCHEMA = {
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

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

async function main() {
  const env = loadEnv();
  const details = process.argv[2] ? [process.argv[2]] : ['low', 'high'];
  const deployment = env.AZURE_OPENAI_DEPLOYMENT_NAME.trim();
  const client = new OpenAI({
    apiKey: env.AZURE_OPENAI_API_KEY,
    baseURL: `${env.AZURE_OPENAI_ENDPOINT.replace(/\/$/, '')}/openai/deployments/${deployment}`,
    defaultQuery: { 'api-version': env.AZURE_OPENAI_API_VERSION || '2024-12-01-preview' },
    defaultHeaders: { 'api-key': env.AZURE_OPENAI_API_KEY },
  });
  const files = fs.readdirSync(PHOTOS).filter((f) => MIME[path.extname(f).toLowerCase()]).sort();
  if (files.length === 0) throw new Error(`${PHOTOS} に写真がありません`);

  const results = [];
  for (const file of files) {
    const bytes = fs.readFileSync(path.join(PHOTOS, file));
    const url = `data:${MIME[path.extname(file).toLowerCase()]};base64,${bytes.toString('base64')}`;
    for (const detail of details) {
      const started = Date.now();
      try {
        const response = await client.chat.completions.create({
          model: deployment,
          messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }, { type: 'image_url', image_url: { url, detail } }] }],
          max_completion_tokens: 4000,
          response_format: { type: 'json_schema', json_schema: { name: 'dish_tags', strict: true, schema: SCHEMA } },
        });
        const answer = JSON.parse(response.choices[0].message.content);
        results.push({ file, detail, ms: Date.now() - started, usage: response.usage, dishes: answer.dishes });
        console.log(`${file} (${detail}): ${answer.dishes.length} 皿, ${Date.now() - started} ms, 入力 ${response.usage?.prompt_tokens} / 出力 ${response.usage?.completion_tokens} トークン`);
      } catch (error) {
        results.push({ file, detail, error: String(error.message || error) });
        console.log(`${file} (${detail}): 失敗 ${error.status ?? ''} ${error.name ?? ''}`);
      }
    }
  }
  fs.writeFileSync(path.join(WORK, 'result.json'), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(WORK, 'result.html'), html(results));
  console.log(`書き出した: ${path.join(WORK, 'result.html')}`);
}

/** 写真の上に点と名前を重ねたページ（写真は photos/ を相対で参照する） */
function html(results) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const cards = results.map((r) => {
    const dots = (r.dishes || []).map((d, i) =>
      `<div class="dot" style="left:${d.x * 100}%;top:${d.y * 100}%"><span>${i + 1}. ${esc(d.name)}</span></div>`).join('');
    const meta = r.error ? `<p class="err">失敗: ${esc(r.error)}</p>`
      : `<p>${r.dishes.length} 皿 / ${r.ms} ms / 入力 ${r.usage?.prompt_tokens ?? '?'}・出力 ${r.usage?.completion_tokens ?? '?'} トークン</p>`;
    return `<figure><figcaption>${esc(r.file)}（detail: ${r.detail}）</figcaption><div class="photo"><img src="photos/${encodeURIComponent(r.file)}">${dots}</div>${meta}</figure>`;
  }).join('\n');
  return `<!doctype html><meta charset="utf-8"><title>タグの提案の試作</title>
<style>
body{font-family:sans-serif;margin:16px;background:#fafafa}
figure{display:inline-block;vertical-align:top;margin:8px;max-width:460px}
.photo{position:relative;display:inline-block}
.photo img{max-width:440px;display:block}
.dot{position:absolute;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;background:#e53935;border:2px solid #fff;box-shadow:0 0 2px #000}
.dot span{position:absolute;left:16px;top:-4px;white-space:nowrap;background:rgba(0,0,0,.7);color:#fff;font-size:12px;padding:1px 4px;border-radius:3px}
.err{color:#c62828}
</style>
<h1>タグの提案の試作（${new Date().toLocaleString('ja-JP')}）</h1>
${cards}`;
}

main().catch((error) => {
  console.error(`止まった: ${error.message}`);
  process.exit(1);
});
