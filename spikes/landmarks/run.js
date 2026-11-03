// 試作: 風景の写真に写った山・建物（城・寺社・塔など）を、撮影地の周りの地図のデータを候補にして AI に当てさせる
// （11 §9.1 の C-5 の前の試し。捨てる前提で、main には入れない）
//
// 使い方（リポジトリ直下で）:
//   1. .work/spike-landmarks/photos/ に写真（jpg / png / webp）を置く
//   2. .work/spike-landmarks/photos.csv に1枚1行で書く（UTF-8。1行目は見出し）:
//        ファイル名,撮った場所,座標,答え,種類
//        IMG_0012.jpg,長野県松本市,,松本城,建物
//        IMG_0034.jpg,上高地,"36.2490, 137.6380",穂高岳・明神岳,山
//      - 撮った場所: 地名（市町村・駅の名前など）。答えそのものは書かない
//      - 座標: 任意。Google マップで長押しして出る「緯度, 経度」
//      - 答え: 写っているもの。いくつもあれば「・」で区切る
//      - 種類: 山 / 建物（空なら名前から推し量る）
//   3. node spikes/landmarks/run.js candidates   … 地図の候補だけを引いて candidates.html に書く（AI を使わない。鍵は要らない）
//      node spikes/landmarks/run.js              … 候補を引いたうえで AI に当てさせ、result.html に書く
//      （AI を使うときは .work/spike-landmarks/.env に AZURE_OPENAI_ENDPOINT・AZURE_OPENAI_API_KEY・AZURE_OPENAI_DEPLOYMENT_NAME）
//
// 外に送るもの: 撮った場所の地名と座標を OpenStreetMap の Nominatim（地名→座標）と Overpass API（周りの山・名所）に送る。
// 写真は Azure OpenAI にだけ送る。鍵は .env から読むだけで、表示も書き出しもしない
//
// AI には4通りで聞いて比べる:
//   photo       写真だけ（見た目だけでどこまで当たるか）
//   place       写真＋撮った場所の地名（候補なし）
//   place+cand  写真＋地名＋地名から引いた周りの候補（本番で、位置情報の無い写真に手で地名を書いた場合）
//   coords+cand 写真＋座標＋座標から引いた周りの候補（本番で、位置情報のある写真の場合。座標を書いた行だけ）
const fs = require('fs');
const path = require('path');
const OpenAI = require(path.join(__dirname, '..', '..', 'api', 'node_modules', 'openai')).default;

const WORK = path.join(__dirname, '..', '..', '.work', 'spike-landmarks');
const PHOTOS = path.join(WORK, 'photos');
const CACHE = path.join(WORK, 'cache.json');
const USER_AGENT = 'snaplant-spike-landmarks/0.1 (personal trial)';

// 候補を探す範囲（m）。地名から引いた座標は粗い（市役所のあたりなど）ので、建物の範囲を広げる
const RADIUS = {
  mountain: 40000,
  landmarkFine: 2000,
  landmarkCoarse: 6000,
};
const MAX_MOUNTAINS = 25;
const MAX_LANDMARKS = 25;
const CONCURRENCY = 4;

// 山の候補の選び方。撮影の向きが分からないので、上位を取るだけだと別の方角の近い山で埋まり、写っている遠くの山が落ちる
//   current … 標高÷距離の上位 25（最初の試し）
//   dir5    … 方角を8つに分け、方角ごとに名の知れた山（Wikidata のある山）を先に、標高÷距離の上位 5（計 40）
//   known40 … 標高 1500m 以上で、名の知れた山を先に、標高÷距離の上位 40
const peakScore = (c) => c.ele / Math.max(c.km, 0.5);
const MOUNTAIN_STRATEGIES = {
  current: (peaks) => [...peaks].sort((a, b) => peakScore(b) - peakScore(a)).slice(0, MAX_MOUNTAINS),
  dir5: (peaks) => ['北', '北東', '東', '南東', '南', '南西', '西', '北西'].flatMap((d) =>
    peaks.filter((c) => c.direction === d).sort((a, b) => Number(b.known) - Number(a.known) || peakScore(b) - peakScore(a)).slice(0, 5)),
  known40: (peaks) => peaks.filter((c) => c.ele >= 1500)
    .sort((a, b) => Number(b.known) - Number(a.known) || peakScore(b) - peakScore(a)).slice(0, 40),
};
// node run.js [candidates|rescore] [--strategy=dir5] [--only=山] [--modes=place+cand,coords+cand] [--repeat=2]
const option = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const STRATEGY = option('strategy', 'current');
if (!MOUNTAIN_STRATEGIES[STRATEGY]) throw new Error(`--strategy は ${Object.keys(MOUNTAIN_STRATEGIES).join(' / ')}`);
// 結果のファイルの名前に付ける印（既定の選び方・聞き方では付けず、最初の試しの result.json を残す）
const SUFFIX = process.argv.some((a) => a.startsWith('--')) ? `-${STRATEGY}` : '';

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

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

/** 引用符を解する最小の CSV の読み込み */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

/** photos.csv を読む */
function loadRows() {
  const file = path.join(WORK, 'photos.csv');
  if (!fs.existsSync(file)) throw new Error(`${file} がありません`);
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  if (text.includes('\uFFFD')) throw new Error('photos.csv を UTF-8 で保存してください');
  const [, ...body] = parseCsv(text);
  return body.map((cells, index) => {
    const [file, place, coordsText, answerText, kindText] = cells.map((x) => (x ?? '').trim());
    if (!fs.existsSync(path.join(PHOTOS, file))) throw new Error(`${index + 2} 行目: photos/${file} がありません`);
    const answers = answerText.split(/[・、,／/]/).map((x) => x.trim()).filter(Boolean);
    const kind = kindText === '山' || kindText === '建物' ? kindText : (/山|岳|峰|富士/.test(answerText) ? '山' : '建物');
    return { file, place: place || null, coords: parseCoords(coordsText), answers, kind };
  });
}

/** 「36.2490, 137.6380」の形の座標を読む（読めなければ null） */
function parseCoords(text) {
  const m = (text || '').match(/^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$/);
  return m ? { lat: Number(m[1]), lon: Number(m[2]) } : null;
}

// ---- 地図のデータ（結果は cache.json に残し、同じ問い合わせを繰り返さない） ----

const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : { geocode: {}, overpass: {} };
const saveCache = () => fs.writeFileSync(CACHE, JSON.stringify(cache, null, 1));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 地名を座標に直す（Nominatim。利用の決まりで1秒に1回まで） */
async function geocode(place) {
  if (place in cache.geocode) return cache.geocode[place];
  await sleep(1100);
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=jp&accept-language=ja&q=${encodeURIComponent(place)}`;
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!response.ok) throw new Error(`Nominatim ${response.status}`);
  const [hit] = await response.json();
  cache.geocode[place] = hit ? { lat: Number(hit.lat), lon: Number(hit.lon), label: hit.display_name } : null;
  saveCache();
  return cache.geocode[place];
}

/** 周りの山と名所を引く（Overpass API） */
async function nearby(center, landmarkRadius) {
  // 末尾の v2 は問い合わせの形の版（滝と道路の橋を足した）。形を変えたら上げて、前の結果を使わないようにする
  const key = `${center.lat.toFixed(4)},${center.lon.toFixed(4)},${landmarkRadius},v2`;
  if (cache.overpass[key]) return cache.overpass[key];
  const at = (r) => `(around:${r},${center.lat},${center.lon})`;
  const L = at(landmarkRadius);
  const query = `[out:json][timeout:90];
(
  node["natural"~"^(peak|volcano)$"]["name"]${at(RADIUS.mountain)};
  nwr["historic"~"^(castle|monument|memorial|ruins|archaeological_site)$"]["name"]${L};
  nwr["building"~"^(castle|temple|shrine|church|cathedral|pagoda)$"]["name"]${L};
  nwr["amenity"="place_of_worship"]["name"]${L};
  nwr["tourism"~"^(attraction|museum|viewpoint)$"]["name"]${L};
  nwr["man_made"~"^(tower|lighthouse|bridge)$"]["name"]${L};
  nwr["natural"="waterfall"]["name"]${L};
  nwr["waterway"="waterfall"]["name"]${L};
  way["bridge"]["bridge:name"]${L};
  way["bridge"]["name"]${L};
);
out center tags;`;
  // 公開の Overpass は混むと 429・502・504 を返すので、別の公開のサーバにも順に聞き、間を空けて何度か送り直す
  const servers = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  ];
  let response;
  for (const [i, wait] of [0, 0, 0, 20000, 20000, 20000].entries()) {
    await sleep(wait);
    try {
      response = await fetch(servers[i % servers.length], {
        method: 'POST',
        headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
        // 混んでいると応答が返らないまま待ち続けるので、2分で打ち切って次のサーバへ
        signal: AbortSignal.timeout(120000),
      });
    } catch (error) {
      // つながらないサーバもあるので、次のサーバへ
      console.log(`  Overpass につながらない（${error.cause?.code ?? error.message}）。次へ`);
      continue;
    }
    if (![429, 502, 503, 504].includes(response.status)) break;
    console.log(`  Overpass ${response.status}。送り直す`);
  }
  if (!response.ok) throw new Error(`Overpass ${response.status}`);
  const elements = (await response.json()).elements;
  cache.overpass[key] = elements;
  saveCache();
  return elements;
}

/** 地図の要素の種類を日本語にする */
function kindOf(tags) {
  if (tags.natural === 'peak' || tags.natural === 'volcano') return '山';
  if (tags.historic === 'castle' || tags.building === 'castle') return '城';
  if (tags.amenity === 'place_of_worship' || ['temple', 'shrine', 'church', 'cathedral', 'pagoda'].includes(tags.building)) {
    return { shinto: '神社', buddhist: '寺', christian: '教会' }[tags.religion] || '寺社';
  }
  if (tags.man_made === 'tower') return '塔';
  if (tags.man_made === 'lighthouse') return '灯台';
  if (tags.man_made === 'bridge' || tags.bridge) return '橋';
  if (tags.natural === 'waterfall' || tags.waterway === 'waterfall') return '滝';
  if (tags.historic === 'ruins' || tags.historic === 'archaeological_site') return '遺跡';
  if (tags.historic === 'monument' || tags.historic === 'memorial') return '記念碑';
  if (tags.tourism === 'museum') return '博物館';
  if (tags.tourism === 'viewpoint') return '展望地';
  return '名所';
}

const toRad = (d) => (d * Math.PI) / 180;
/** 2点の距離（km） */
function distanceKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
/** a から見た b の方角（8方位） */
function directionOf(a, b) {
  const y = Math.sin(toRad(b.lon - a.lon)) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lon - a.lon));
  const deg = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  return ['北', '北東', '東', '南東', '南', '南西', '西', '北西'][Math.round(deg / 45) % 8];
}

/**
 * 候補の一覧を作る。山は「高くて近いもの」（標高÷距離）の上位、名所は Wikidata のある（名の知れた）ものを先に、近い順の上位
 */
async function candidatesAt(center, landmarkRadius) {
  const seen = new Set();
  const all = [];
  for (const el of await nearby(center, landmarkRadius)) {
    const tags = el.tags || {};
    // 道路の橋は name が道路の名前のことがあるので、橋の名前（bridge:name）を先に見る
    const name = tags['bridge:name'] || tags['name:ja'] || tags.name;
    const at = el.lat != null ? { lat: el.lat, lon: el.lon } : el.center ? { lat: el.center.lat, lon: el.center.lon } : null;
    if (!name || !at || seen.has(name)) continue;
    seen.add(name);
    const kind = kindOf(tags);
    const km = distanceKm(center, at);
    const ele = Number.parseFloat(tags.ele);
    all.push({ name, kind, km, direction: directionOf(center, at), ele: Number.isFinite(ele) ? Math.round(ele) : null, known: Boolean(tags.wikidata || tags.wikipedia) });
  }
  const mountains = MOUNTAIN_STRATEGIES[STRATEGY](all.filter((c) => c.kind === '山' && c.ele != null));
  const landmarks = all.filter((c) => c.kind !== '山')
    .sort((a, b) => Number(b.known) - Number(a.known) || a.km - b.km).slice(0, MAX_LANDMARKS);
  return { all, list: [...landmarks, ...mountains] };
}

const lineOf = (c, i) =>
  `${i + 1}. ${c.name}（${c.kind}${c.ele != null ? ` ${c.ele}m` : ''}） ${c.direction} ${c.km < 10 ? c.km.toFixed(1) : Math.round(c.km)} km`;

// ---- AI ----

const PROMPT = `
この写真に写っている、名前の付いた山・建物・名所（城・寺社・塔・橋など）を挙げてください。
- 写っていて、名前まで分かるものだけを挙げる。見た目だけで推し量れないものは挙げない（無理に名前を付けない）
- name: 名前（例: 松本城、槍ヶ岳）
- kind: mountain（山）/ castle（城）/ temple_shrine（寺社）/ tower（塔）/ bridge（橋）/ building（そのほかの建物）/ other
- x, y: 写真の中でそれが写っている位置（そのものの中心。山は山頂）。左上を (0, 0)、右下を (1, 1) とする割合
- confidence: high / medium / low
- fromCandidates: 下の候補から選んだなら true（候補が無ければ false）
`;

const SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          kind: { type: 'string', enum: ['mountain', 'castle', 'temple_shrine', 'tower', 'bridge', 'building', 'other'] },
          x: { type: 'number' },
          y: { type: 'number' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          fromCandidates: { type: 'boolean' },
        },
        required: ['name', 'kind', 'x', 'y', 'confidence', 'fromCandidates'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

/** 聞き方ごとのプロンプト */
function promptOf(mode, row, candidates) {
  const parts = [PROMPT];
  if (mode === 'place' || mode === 'place+cand') parts.push(`撮影地（利用者が書いた地名）: ${row.place}`);
  if (mode === 'coords+cand') parts.push(`撮影地（座標）: ${row.coords.lat}, ${row.coords.lon}`);
  if (candidates) {
    parts.push(`撮影地の周りの候補（地図のデータ。方角と距離は撮影地から）。候補にあるものは候補の名前のまま答える。候補に無いものは、写真の中の文字などで確かなときだけ挙げる:\n${candidates.map(lineOf).join('\n')}`);
  }
  return parts.join('\n');
}

// 「華厳の滝」と「華厳滝」、「槍ヶ岳」と「槍ケ岳」を同じに見るため、つなぎの文字を落として比べる
const normalize = (s) => s.normalize('NFKC').replace(/[\sのノヶケが]/g, '').toLowerCase();
/** 答えの名前と AI の名前が合うか（どちらかがもう一方を含めば合う。「松本城」と「国宝松本城天守」など） */
const matches = (answer, name) => {
  const a = normalize(answer);
  const b = normalize(name);
  return a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a));
};

/** 同時に limit 個まで動かす */
async function pool(tasks, limit) {
  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }));
  return results;
}

async function main() {
  // rescore: AI を呼び直さずに、result.json の答えを今の答え（photos.csv）と比べ直して result.html を書き直す
  if (process.argv[2] === 'rescore') {
    const saved = JSON.parse(fs.readFileSync(path.join(WORK, 'result.json'), 'utf8'));
    const answersOf = new Map(loadRows().map((r) => [r.file, r]));
    for (const row of saved) {
      const now = answersOf.get(row.file);
      if (now) Object.assign(row, { answers: now.answers, kind: now.kind });
      for (const r of Object.values(row.results || {})) {
        if (r.items) r.hits = row.answers.map((a) => r.items.some((item) => matches(a, item.name)));
      }
    }
    fs.writeFileSync(path.join(WORK, 'result.json'), JSON.stringify(saved, null, 2));
    fs.writeFileSync(path.join(WORK, 'result.html'), resultHtml(saved));
    console.log(`書き直した: ${path.join(WORK, 'result.html')}`);
    return;
  }
  const candidatesOnly = process.argv[2] === 'candidates';
  const only = option('only', null);
  const rows = loadRows().filter((r) => !only || r.kind === only);
  if (rows.length === 0) throw new Error('photos.csv に行がありません');

  // 候補を引く（地名から・座標から）
  for (const row of rows) {
    if (row.place) {
      row.geocoded = await geocode(row.place);
      if (row.geocoded) row.placeCandidates = await candidatesAt(row.geocoded, RADIUS.landmarkCoarse);
    }
    if (row.coords) row.coordsCandidates = await candidatesAt(row.coords, RADIUS.landmarkFine);
    const inList = (c) => c && row.answers.map((a) => c.list.some((x) => matches(a, x.name)));
    const inAll = (c) => c && row.answers.map((a) => c.all.some((x) => matches(a, x.name)));
    row.answerInCandidates = { place: inList(row.placeCandidates), coords: inList(row.coordsCandidates) };
    row.answerInMap = { place: inAll(row.placeCandidates), coords: inAll(row.coordsCandidates) };
    console.log(`${row.file}: 地名→${row.geocoded ? '見つかった' : row.place ? '見つからない' : '無し'}`
      + ` 候補 ${row.placeCandidates?.list.length ?? '-'} / ${row.coordsCandidates?.list.length ?? '-'}`
      + ` 答えが候補に ${JSON.stringify(row.answerInCandidates)}`);
  }
  if (candidatesOnly) {
    fs.writeFileSync(path.join(WORK, 'candidates.html'), candidatesHtml(rows));
    console.log(`書き出した: ${path.join(WORK, 'candidates.html')}`);
    return;
  }

  const env = loadEnv();
  const deployment = env.AZURE_OPENAI_DEPLOYMENT_NAME.trim();
  const client = new OpenAI({
    apiKey: env.AZURE_OPENAI_API_KEY,
    baseURL: `${env.AZURE_OPENAI_ENDPOINT.replace(/\/$/, '')}/openai/deployments/${deployment}`,
    defaultQuery: { 'api-version': env.AZURE_OPENAI_API_VERSION || '2024-12-01-preview' },
    defaultHeaders: { 'api-key': env.AZURE_OPENAI_API_KEY },
  });

  const tasks = [];
  for (const row of rows) {
    const bytes = fs.readFileSync(path.join(PHOTOS, row.file));
    const url = `data:${MIME[path.extname(row.file).toLowerCase()]};base64,${bytes.toString('base64')}`;
    const modes = [
      ['photo', null],
      ...(row.place ? [['place', null]] : []),
      ...(row.placeCandidates ? [['place+cand', row.placeCandidates.list]] : []),
      ...(row.coordsCandidates ? [['coords+cand', row.coordsCandidates.list]] : []),
    ];
    row.results = {};
    const wanted = option('modes', null)?.split(',');
    const repeat = Number(option('repeat', '1'));
    for (const [baseMode, candidates] of modes.filter(([m]) => !wanted || wanted.includes(m))) {
      for (let n = 1; n <= repeat; n++) {
      // 2回目からは「place+cand#2」のように回の番号を付けて別に残す
      const mode = n === 1 ? baseMode : `${baseMode}#${n}`;
      tasks.push(async () => {
        const started = Date.now();
        try {
          const response = await client.chat.completions.create({
            model: deployment,
            messages: [{ role: 'user', content: [{ type: 'text', text: promptOf(mode, row, candidates) }, { type: 'image_url', image_url: { url, detail: 'high' } }] }],
            max_completion_tokens: 4000,
            response_format: { type: 'json_schema', json_schema: { name: 'landmarks', strict: true, schema: SCHEMA } },
          });
          const { items } = JSON.parse(response.choices[0].message.content);
          const hits = row.answers.map((a) => items.some((item) => matches(a, item.name)));
          row.results[mode] = { items, hits, ms: Date.now() - started, usage: response.usage };
          console.log(`${row.file} ${mode}: ${hits.filter(Boolean).length}/${hits.length} 当たり, ${items.length} 件, ${Date.now() - started} ms`);
        } catch (error) {
          row.results[mode] = { error: String(error.message || error) };
          console.log(`${row.file} ${mode}: 失敗 ${error.status ?? ''} ${error.name ?? ''}`);
        }
      });
      }
    }
  }
  await pool(tasks, CONCURRENCY);

  // 答えの山ごとに、何回のうち何回当たったか・答えに無い名前を何回挙げたか
  for (const row of rows) {
    for (const [mode, r] of Object.entries(row.results)) {
      if (!r.items) continue;
      const wrong = r.items.filter((it) => !row.answers.some((a) => matches(a, it.name)));
      console.log(`  ${row.file} ${mode}: 当たり ${row.answers.filter((a, i) => r.hits[i]).join('・') || '-'}`
        + ` / 答えに無い ${wrong.map((it) => `${it.name}@${it.x.toFixed(2)},${it.y.toFixed(2)}`).join('・') || '-'}`);
    }
  }
  fs.writeFileSync(path.join(WORK, `result${SUFFIX}.json`), JSON.stringify(rows, null, 2));
  fs.writeFileSync(path.join(WORK, `result${SUFFIX}.html`), resultHtml(rows));
  console.log(`書き出した: ${path.join(WORK, `result${SUFFIX}.html`)}`);
}

// ---- 結果のページ ----

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const MODES = ['photo', 'place', 'place+cand', 'coords+cand'];
const COLORS = { photo: '#757575', place: '#1e88e5', 'place+cand': '#e53935', 'coords+cand': '#43a047' };
const STYLE = `<style>
body{font-family:sans-serif;margin:16px;background:#fafafa;color:#222}
table{border-collapse:collapse;margin:8px 0}td,th{border:1px solid #ccc;padding:4px 8px;font-size:14px}
figure{display:inline-block;vertical-align:top;margin:8px;max-width:520px;background:#fff;padding:8px;border:1px solid #ddd}
.photo{position:relative;display:inline-block}.photo img{max-width:500px;display:block}
.dot{position:absolute;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;border:2px solid #fff;box-shadow:0 0 2px #000}
.ok{color:#2e7d32;font-weight:bold}.ng{color:#c62828;font-weight:bold}.small{font-size:12px;color:#555}
ol{margin:4px 0;padding-left:20px;font-size:12px}
</style>`;

/** 当たりの割合を「当たり / 答えの数」で出す */
function rate(rows, mode, kind) {
  const hits = rows.filter((r) => r.kind === kind && r.results?.[mode]?.hits).flatMap((r) => r.results[mode].hits);
  return hits.length ? `${hits.filter(Boolean).length} / ${hits.length}` : '-';
}

function resultHtml(rows) {
  const summary = `<table><tr><th>聞き方</th><th>山</th><th>山以外</th></tr>${MODES.map((m) =>
    `<tr><td><span style="color:${COLORS[m]}">●</span> ${m}</td><td>${rate(rows, m, '山')}</td><td>${rate(rows, m, '建物')}</td></tr>`).join('')}</table>`;
  const tokens = rows.flatMap((r) => Object.values(r.results || {})).filter((x) => x.usage);
  const usage = `<p class="small">AI の呼び出し ${tokens.length} 回、入力 平均 ${Math.round(tokens.reduce((s, x) => s + x.usage.prompt_tokens, 0) / Math.max(tokens.length, 1))}・出力 平均 ${Math.round(tokens.reduce((s, x) => s + x.usage.completion_tokens, 0) / Math.max(tokens.length, 1))} トークン、時間 平均 ${Math.round(tokens.reduce((s, x) => s + x.ms, 0) / Math.max(tokens.length, 1))} ms</p>`;
  const cards = rows.map((row) => {
    const dots = MODES.flatMap((m) => (row.results?.[m]?.items || []).map((it) =>
      `<div class="dot" title="${esc(m)}: ${esc(it.name)}" style="left:${it.x * 100}%;top:${it.y * 100}%;background:${COLORS[m]}"></div>`)).join('');
    const lines = MODES.filter((m) => row.results?.[m]).map((m) => {
      const r = row.results[m];
      if (r.error) return `<div><span style="color:${COLORS[m]}">●</span> ${m}: <span class="ng">失敗</span> ${esc(r.error)}</div>`;
      const n = r.hits.filter(Boolean).length;
      return `<div><span style="color:${COLORS[m]}">●</span> ${m}: <span class="${n === r.hits.length ? 'ok' : 'ng'}">${n}/${r.hits.length}</span> `
        + `${r.items.map((it) => `${esc(it.name)}（${it.kind}・${it.confidence}${it.fromCandidates ? '・候補' : ''}）`).join('、') || '（挙げなかった）'}</div>`;
    }).join('');
    return `<figure><div><b>${esc(row.file)}</b>（${row.kind}） 答え: ${esc(row.answers.join('・') || '（未記入。点数に入れない）')}</div>
<div class="small">撮った場所: ${esc(row.place ?? '-')}${row.coords ? ` / 座標 ${row.coords.lat}, ${row.coords.lon}` : ''}
 / 答えが候補に: 地名 ${JSON.stringify(row.answerInCandidates.place)} 座標 ${JSON.stringify(row.answerInCandidates.coords)}</div>
<div class="photo"><img src="photos/${encodeURIComponent(row.file)}">${dots}</div>${lines}</figure>`;
  }).join('\n');
  return `<!doctype html><meta charset="utf-8"><title>名所の判別の試作</title>${STYLE}
<h1>名所の判別の試作（${new Date().toLocaleString('ja-JP')}）</h1>${summary}${usage}${cards}`;
}

function candidatesHtml(rows) {
  const block = (title, c) => (c ? `<div class="small">${title}（全 ${c.all.length} 件から ${c.list.length} 件）</div><ol>${c.list.map((x) => `<li>${esc(lineOf(x, 0).replace(/^1\. /, ''))}</li>`).join('')}</ol>` : '');
  const cards = rows.map((row) => `<figure><div><b>${esc(row.file)}</b>（${row.kind}） 答え: ${esc(row.answers.join('・') || '（未記入。点数に入れない）')}</div>
<div class="small">撮った場所: ${esc(row.place ?? '-')} → ${esc(row.geocoded?.label ?? '見つからない')}${row.coords ? ` / 座標 ${row.coords.lat}, ${row.coords.lon}` : ''}</div>
<div class="small">答えが候補に: 地名 ${JSON.stringify(row.answerInCandidates.place)} 座標 ${JSON.stringify(row.answerInCandidates.coords)} / 地図のデータに: 地名 ${JSON.stringify(row.answerInMap.place)} 座標 ${JSON.stringify(row.answerInMap.coords)}</div>
${block('地名から', row.placeCandidates)}${block('座標から', row.coordsCandidates)}</figure>`).join('\n');
  return `<!doctype html><meta charset="utf-8"><title>名所の候補</title>${STYLE}<h1>地図から引いた候補</h1>${cards}`;
}

main().catch((error) => {
  console.error(`止まった: ${error.message}`);
  process.exit(1);
});
