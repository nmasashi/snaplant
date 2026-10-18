import { catalogEntryOf, pageOfCatalogNames } from '../../src/services/catalogEntries';
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

  it('先頭から切れば最初の項目から、最後のページは残りだけ', () => {
    expect(pageOfCatalogNames(rows, 0, 3).page.map((row) => row.name)).toEqual(['アジサイ', 'イチョウ', 'ソメイヨシノ']);
    expect(pageOfCatalogNames(rows, 3, 3).page.map((row) => row.name)).toEqual(['ヤマザクラ']);
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

  it('数えてから見出しを読むまでにその名前の写真が無くなっていたら（見出しが無い）、項目にしない', () => {
    // 消された・やり直しで名前が変わった直後（05 §5.14）。total は数えたときのまま
    expect(catalogEntryOf('plant', { name: 'ソメイヨシノ', photoCount: 3 }, null, coverUrlOf)).toBeNull();
  });
});
