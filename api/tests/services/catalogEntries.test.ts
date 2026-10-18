import { catalogPageOf } from '../../src/services/catalogEntries';
import { CatalogHeadPhoto } from '../../src/services/catalogQueries';

// 入口（GET /api/catalog/entries）から入力を作れないので、入口に最も近い catalogPageOf() で確かめる（CLAUDE.md の名簿）。
// 偽物は GROUP BY と ORDER BY を解釈しないので、名前ごとの枚数の行と、項目ごとの見出しの写真（信頼度の高い1枚）を作れない。
// 見出しを読む関数（Cosmos の代わり）は名前ごとに違う写真を返し、呼び出しは確かめず、できた項目の中身で確かめる

describe('catalogPageOf', () => {
  /** 名前ごとに信頼度と Blob 名を変えた見出しの写真（取り違えを見分けるため） */
  const headFor = (name: string, confidence: number, head: string, overrides: Partial<CatalogHeadPhoto> = {}): CatalogHeadPhoto => ({
    id: head.repeat(64),
    blobName: `${head.repeat(64)}.jpg`,
    thumbnailBlobName: `${head.repeat(64)}.thumb.jpg`,
    identification: {
      kind: 'food',
      matchesKind: true,
      name,
      confidence,
      description: `${name}の説明`,
      characteristics: `${name}の特徴`,
      attributes: { genre: 'ラーメン', mainIngredients: ['中華麺'] },
      reason: null,
      model: 'gpt-6-luna',
      at: '2026-10-18T09:40:00.000Z'
    },
    ...overrides
  });
  const heads = new Map<string, CatalogHeadPhoto>([
    ['塩ラーメン', headFor('塩ラーメン', 70, 'a')],
    ['醤油ラーメン', headFor('醤油ラーメン', 80, 'b')],
    ['味噌ラーメン', headFor('味噌ラーメン', 90, 'c')],
    ['豚骨ラーメン', headFor('豚骨ラーメン', 60, 'd')]
  ]);
  const headOf = async (name: string) => heads.get(name) ?? null;
  const coverUrlOf = (blobName: string) => `https://test.blob.core.windows.net/photos/${blobName}?sas`;
  // 取り違えを見分けられるよう、行は名前順ではなく、枚数も名前ごとに変えてある。
  // 文字列の符号単位の順は、味噌（U+5473）・塩（U+5869）・豚骨（U+8C5A）・醤油（U+91A4）
  const rows = [
    { name: '醤油ラーメン', photoCount: 2 },
    { name: '塩ラーメン', photoCount: 1 },
    { name: '豚骨ラーメン', photoCount: 4 },
    { name: '味噌ラーメン', photoCount: 3 }
  ];
  const namesOf = (result: { entries: { name: string }[] }) => result.entries.map((entry) => entry.name);

  it('項目は、見出しの写真の識別から信頼度・説明・特徴・種類ごとの項目を、行から枚数を取り、表紙はサムネイルのURL', async () => {
    // 04 §3.1 の表。項目の見出しは、その名前の写真のうち信頼度が最も高いものから取る
    const result = await catalogPageOf('food', rows, 0, 1, headOf, coverUrlOf);

    expect(result).toEqual({
      entries: [
        {
          kind: 'food',
          name: '味噌ラーメン',
          confidence: 90,
          description: '味噌ラーメンの説明',
          characteristics: '味噌ラーメンの特徴',
          attributes: { genre: 'ラーメン', mainIngredients: ['中華麺'] },
          photoCount: 3,
          coverThumbnailUrl: `https://test.blob.core.windows.net/photos/${'c'.repeat(64)}.thumb.jpg?sas`
        }
      ],
      total: 4
    });
  });

  it('項目を名前の文字列順に並べ、offset から limit 件を切り、それぞれの名前の見出しから作る。総数はページに依らない', async () => {
    const result = await catalogPageOf('food', rows, 1, 2, headOf, coverUrlOf);

    expect(result.total).toBe(4);
    expect(result.entries.map(({ name, confidence, photoCount }) => ({ name, confidence, photoCount }))).toEqual([
      { name: '塩ラーメン', confidence: 70, photoCount: 1 },
      { name: '豚骨ラーメン', confidence: 60, photoCount: 4 }
    ]);
  });

  it('名前順はロケールの照合順ではなく文字列の符号単位の順（ひらがなはカタカナより前）', async () => {
    // 05 §5.14。照合順（ja・en とも）なら「カレーライス」が「わらびもち」より前になる。どの環境でも同じ並びにする
    const kana = [
      { name: 'カレーライス', photoCount: 1 },
      { name: 'わらびもち', photoCount: 1 }
    ];
    const kanaHeadOf = async (name: string) => headFor(name, 50, name === 'わらびもち' ? 'e' : 'f');

    expect(namesOf(await catalogPageOf('food', kana, 0, 50, kanaHeadOf, coverUrlOf))).toEqual(['わらびもち', 'カレーライス']);
  });

  it('offset が項目の数を超えれば、空のページで総数はそのまま', async () => {
    expect(await catalogPageOf('food', rows, 10, 50, headOf, coverUrlOf)).toEqual({ entries: [], total: 4 });
  });

  it('名前の無い行（GROUP BY の null の鍵）は項目にも総数にも数えない', async () => {
    // 写っていると判断した写真は必ず名前を持つ（06 §3.1 の応答の検証）が、集計の鍵が null の行が来ても項目にしない
    const result = await catalogPageOf('food', [...rows, { name: null, photoCount: 5 }], 0, 50, headOf, coverUrlOf);

    expect(result.total).toBe(4);
    expect(namesOf(result)).toEqual(['味噌ラーメン', '塩ラーメン', '豚骨ラーメン', '醤油ラーメン']);
  });

  it('見出しの写真にサムネイルが無ければ、表紙は原寸のURL', async () => {
    const noThumbnail = async (name: string) => headFor(name, 90, 'c', { thumbnailBlobName: null });

    const result = await catalogPageOf('food', rows, 0, 1, noThumbnail, coverUrlOf);

    expect(result.entries[0].coverThumbnailUrl).toBe(`https://test.blob.core.windows.net/photos/${'c'.repeat(64)}.jpg?sas`);
  });

  it('見出しの写真の識別に説明・特徴・種類ごとの項目の欄が無くても、null・null・{} の項目にする', async () => {
    // 欄の欠けた識別（移行で入れた写真など）でも、応答のキーを消さない
    const sparse = async (name: string): Promise<CatalogHeadPhoto> => ({
      ...headFor(name, 90, 'c'),
      identification: { kind: 'food', matchesKind: true, name, confidence: 90, reason: null, model: 'migration', at: '2026-10-18T09:40:00.000Z' }
    });

    const [entry] = (await catalogPageOf('food', rows, 0, 1, sparse, coverUrlOf)).entries;

    // toMatchObject は期待値の {} を「何でも含む」と読むので、欄ごとに toEqual で見る
    expect([entry.description, entry.characteristics, entry.attributes]).toEqual([null, null, {}]);
  });

  it('数えてから見出しを読むまでにその名前の写真が無くなっていたら（見出しが無い）、その項目を外し、総数はそのまま', async () => {
    // 消された・やり直しで名前が変わった直後（05 §5.14）。次に開けば数え直される
    const withoutShio = async (name: string) => (name === '塩ラーメン' ? null : headOf(name));

    const result = await catalogPageOf('food', rows, 0, 3, withoutShio, coverUrlOf);

    expect(result.total).toBe(4);
    expect(namesOf(result)).toEqual(['味噌ラーメン', '豚骨ラーメン']);
  });

  it('見出しの写真を読めなければ、その項目を外さず、その失敗のまま止まる', async () => {
    // 障害は「写真が無くなった」（null で外す）とは違う。ハンドラが code で 503 / 500 に分けるので、包み直さない
    const failure = Object.assign(new Error('getaddrinfo ENOTFOUND test.documents.azure.com'), {
      name: 'RestError',
      code: 'ENOTFOUND'
    });
    const failingForShio = (name: string) => (name === '塩ラーメン' ? Promise.reject(failure) : headOf(name));

    await expect(catalogPageOf('food', rows, 0, 3, failingForShio, coverUrlOf)).rejects.toBe(failure);
  });
});
