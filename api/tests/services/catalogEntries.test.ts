import { catalogEntryOf, catalogPageOf, pageOfCatalogNames } from '../../src/services/catalogEntries';
import { CatalogHeadPhoto } from '../../src/services/catalogQueries';

// 入口（GET /api/catalog/entries）から入力を作れないので、ここで確かめる（CLAUDE.md の名簿）。
// 偽物は GROUP BY と ORDER BY を解釈しないので、名前ごとの枚数の行と、項目ごとの見出しの写真（信頼度の高い1枚）を作れない

describe('pageOfCatalogNames', () => {
  // 取り違えを見分けられるよう、行は名前順ではなく、枚数も名前ごとに変えてある
  const rows = [
    { name: 'ヤマザクラ', photoCount: 4 },
    { name: 'アジサイ', photoCount: 1 },
    { name: 'ソメイヨシノ', photoCount: 3 },
    { name: 'イチョウ', photoCount: 2 }
  ];

  it('項目を名前の文字列順に並べ、offset から limit 件を切り、総数はページに依らない', () => {
    // 文字列の符号単位の順（05 §5.14）。カタカナはア・イ・ソ・ヤの順
    expect(pageOfCatalogNames(rows, 1, 2)).toEqual({
      page: [
        { name: 'イチョウ', photoCount: 2 },
        { name: 'ソメイヨシノ', photoCount: 3 }
      ],
      total: 4
    });
  });

  it('offset が項目の数を超えれば、空のページで総数はそのまま', () => {
    expect(pageOfCatalogNames(rows, 10, 50)).toEqual({ page: [], total: 4 });
  });

  it('名前の無い行（GROUP BY の null の鍵）は項目にも総数にも数えない', () => {
    // 写っていると判断した写真は必ず名前を持つ（06 §3.1 の応答の検証）が、集計の鍵が null の行が来ても項目にしない
    expect(pageOfCatalogNames([...rows, { name: null, photoCount: 5 }], 0, 50).total).toBe(4);
  });
});

describe('catalogEntryOf', () => {
  /** 見出しの写真（その名前で信頼度が最も高い1枚） */
  const head = (overrides: Partial<CatalogHeadPhoto> = {}): CatalogHeadPhoto => ({
    id: 'a'.repeat(64),
    blobName: `${'a'.repeat(64)}.jpg`,
    thumbnailBlobName: `${'a'.repeat(64)}.thumb.jpg`,
    identification: {
      kind: 'plant',
      matchesKind: true,
      name: 'ソメイヨシノ',
      confidence: 92,
      description: '日本で最も広く植えられているサクラの栽培品種',
      characteristics: '淡い桃色の花を葉より先に咲かせる',
      attributes: { scientificName: 'Prunus × yedoensis', familyName: 'バラ科' },
      reason: null,
      model: 'gpt-6-luna',
      at: '2026-10-18T09:40:57.701Z'
    },
    ...overrides
  });
  const coverUrlOf = (blobName: string) => `https://test.blob.core.windows.net/photos/${blobName}?sas`;

  it('信頼度・説明・特徴・種類ごとの項目は見出しの写真の識別から、枚数は行から、表紙はサムネイルのURL', () => {
    // 04 §3.1 の表。項目の見出しは、その名前の写真のうち信頼度が最も高いものから取る
    expect(catalogEntryOf('plant', { name: 'ソメイヨシノ', photoCount: 3 }, head(), coverUrlOf)).toEqual({
      kind: 'plant',
      name: 'ソメイヨシノ',
      confidence: 92,
      description: '日本で最も広く植えられているサクラの栽培品種',
      characteristics: '淡い桃色の花を葉より先に咲かせる',
      attributes: { scientificName: 'Prunus × yedoensis', familyName: 'バラ科' },
      photoCount: 3,
      coverThumbnailUrl: `https://test.blob.core.windows.net/photos/${'a'.repeat(64)}.thumb.jpg?sas`
    });
  });

  it('見出しの写真にサムネイルが無ければ、表紙は原寸のURL', () => {
    const entry = catalogEntryOf('plant', { name: 'ソメイヨシノ', photoCount: 3 }, head({ thumbnailBlobName: null }), coverUrlOf);

    expect(entry?.coverThumbnailUrl).toBe(`https://test.blob.core.windows.net/photos/${'a'.repeat(64)}.jpg?sas`);
  });
});

describe('catalogPageOf', () => {
  /** 名前ごとに信頼度と Blob 名を変えた見出しの写真（取り違えを見分けるため） */
  const headFor = (name: string, confidence: number, head: string): CatalogHeadPhoto => ({
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
    }
  });
  const heads = new Map<string, CatalogHeadPhoto | null>([
    ['塩ラーメン', headFor('塩ラーメン', 70, 'a')],
    ['醤油ラーメン', headFor('醤油ラーメン', 80, 'b')],
    ['味噌ラーメン', headFor('味噌ラーメン', 90, 'c')],
    ['豚骨ラーメン', headFor('豚骨ラーメン', 60, 'd')]
  ]);
  const headOf = async (name: string) => heads.get(name) ?? null;
  const coverUrlOf = (blobName: string) => `https://test.blob.core.windows.net/photos/${blobName}?sas`;
  // 文字列の符号単位の順は、味噌（U+5473）・塩（U+5869）・豚骨（U+8C5A）・醤油（U+91A4）
  const rows = [
    { name: '醤油ラーメン', photoCount: 2 },
    { name: '塩ラーメン', photoCount: 1 },
    { name: '豚骨ラーメン', photoCount: 4 },
    { name: '味噌ラーメン', photoCount: 3 }
  ];

  it('ページの項目ごとに、その名前の見出しの写真から項目を作る（種類は渡したもの）', async () => {
    const result = await catalogPageOf('food', rows, 1, 2, headOf, coverUrlOf);

    expect(result.total).toBe(4);
    expect(result.entries.map(({ kind, name, confidence, photoCount, coverThumbnailUrl }) => ({
      kind,
      name,
      confidence,
      photoCount,
      coverThumbnailUrl
    }))).toEqual([
      {
        kind: 'food',
        name: '塩ラーメン',
        confidence: 70,
        photoCount: 1,
        coverThumbnailUrl: `https://test.blob.core.windows.net/photos/${'a'.repeat(64)}.thumb.jpg?sas`
      },
      {
        kind: 'food',
        name: '豚骨ラーメン',
        confidence: 60,
        photoCount: 4,
        coverThumbnailUrl: `https://test.blob.core.windows.net/photos/${'d'.repeat(64)}.thumb.jpg?sas`
      }
    ]);
  });

  it('数えてから見出しを読むまでにその名前の写真が無くなっていたら（見出しが無い）、その項目を外し、総数はそのまま', async () => {
    // 消された・やり直しで名前が変わった直後（05 §5.14）。次に開けば数え直される
    const withoutShio = async (name: string) => (name === '塩ラーメン' ? null : headOf(name));

    const result = await catalogPageOf('food', rows, 0, 3, withoutShio, coverUrlOf);

    expect(result.total).toBe(4);
    expect(result.entries.map((entry) => entry.name)).toEqual(['味噌ラーメン', '豚骨ラーメン']);
  });
});
