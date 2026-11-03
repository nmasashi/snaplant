import { buildLandmarkCells } from '../../src/scripts/buildLandmarkCells';
import { forEachCase } from '../helpers/cases';

// 名所のデータの区画のファイルを作るスクリプト（C-5a。docs/06_processing_design.md §10.1）。
// 入力は osmium export の GeoJSON の行（geojsonseq。1行に1つの Feature、座標は [経度, 緯度]）

type Tags = Record<string, string>;

/** 点の Feature の行 */
const point = (lat: number, lon: number, tags: Tags): string =>
  JSON.stringify({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: tags });

/** 多角形（敷地の形）の Feature の行。外周だけ */
const polygon = (ring: Array<[number, number]>, tags: Tags): string =>
  JSON.stringify({
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [ring.map(([lat, lon]) => [lon, lat])] },
    properties: tags
  });

/** 線（道）の Feature の行 */
const line = (points: Array<[number, number]>, tags: Tags): string =>
  JSON.stringify({ type: 'Feature', geometry: { type: 'LineString', coordinates: points.map(([lat, lon]) => [lon, lat]) }, properties: tags });

/** 下限を気にしないで組み立てる */
const build = (lines: string[]) => buildLandmarkCells(lines, { minCount: 0 });

/** すべての区画の名所を1つの配列にする */
const allEntries = (cells: Record<string, unknown[]>) => Object.values(cells).flat();

describe('名所のデータの区画のファイルを作るスクリプト（C-5a。06 §10.1）', () => {
  it('名前のある城の点は、その区画に名前・種類・位置・名の知れたものか・標高の無しで入る', async () => {
    const result = await build([point(36.2386, 137.9689, { historic: 'castle', name: '松本城', wikidata: 'Q46581' })]);

    // 緯度 36.2386 は 36.00〜36.25、経度 137.9689 は 137.75〜138.00 の区画
    expect(result.cells).toEqual({
      '36.00_137.75': [{ name: '松本城', kind: 'castle', lat: 36.2386, lon: 137.9689, known: true, ele: null }]
    });
  });

  it('敷地の形（多角形）と道（線）は、それを囲む四角の中心の点になる', async () => {
    const result = await build([
      polygon(
        [
          [33.5600, 133.5300],
          [33.5600, 133.5320],
          [33.5610, 133.5320],
          [33.5610, 133.5300],
          [33.5600, 133.5300]
        ],
        { historic: 'castle', name: '高知城' }
      ),
      line(
        [
          [36.2490, 137.6370],
          [36.2496, 137.6380]
        ],
        { man_made: 'bridge', name: '河童橋' }
      )
    ]);

    const entries = allEntries(result.cells) as Array<{ name: string; lat: number; lon: number }>;
    const kochi = entries.find((e) => e.name === '高知城');
    const kappa = entries.find((e) => e.name === '河童橋');
    expect(kochi?.lat).toBeCloseTo(33.5605, 6);
    expect(kochi?.lon).toBeCloseTo(133.531, 6);
    expect(kappa?.lat).toBeCloseTo(36.2493, 6);
    expect(kappa?.lon).toBeCloseTo(137.6375, 6);
  });

  it('名前は橋の名前・日本語の名前・名前の順に最初にあるものを使い、どれも無いものは捨てる', async () => {
    const result = await build([
      // 道の橋は name に道の名前が入っていることがある
      line(
        [
          [36.2380, 137.9680],
          [36.2381, 137.9681]
        ],
        { highway: 'footway', bridge: 'yes', name: '松本城の園路', 'bridge:name': '埋橋' }
      ),
      point(35.0124, 135.7826, { tourism: 'museum', name: 'Kyoto City KYOCERA Museum of Art', 'name:ja': '京都市京セラ美術館' }),
      point(36.2378, 137.9712, { amenity: 'place_of_worship', religion: 'shinto', name: '四柱神社' }),
      point(36.2400, 137.9700, { amenity: 'place_of_worship', religion: 'shinto' })
    ]);

    expect((allEntries(result.cells) as Array<{ name: string }>).map((e) => e.name).sort()).toEqual(
      ['京都市京セラ美術館', '四柱神社', '埋橋'].sort()
    );
  });

  it('種類は地図のタグから決め、名所でも山頂でもないものは捨てる', async () => {
    const cases: Array<[string, Tags, string | null]> = [
      ['城（historic）', { historic: 'castle' }, 'castle'],
      ['城（building）', { building: 'castle' }, 'castle'],
      ['寺', { amenity: 'place_of_worship', religion: 'buddhist' }, 'temple'],
      ['神社', { amenity: 'place_of_worship', religion: 'shinto' }, 'shrine'],
      ['教会', { amenity: 'place_of_worship', religion: 'christian' }, 'church'],
      ['宗教の分からない寺社', { amenity: 'place_of_worship' }, 'place_of_worship'],
      ['寺の建物', { building: 'temple' }, 'place_of_worship'],
      ['塔', { man_made: 'tower' }, 'tower'],
      ['灯台', { man_made: 'lighthouse' }, 'lighthouse'],
      ['橋（man_made）', { man_made: 'bridge' }, 'bridge'],
      ['橋（道）', { highway: 'primary', bridge: 'yes' }, 'bridge'],
      ['滝（natural）', { natural: 'waterfall' }, 'waterfall'],
      ['滝（waterway）', { waterway: 'waterfall' }, 'waterfall'],
      ['遺跡', { historic: 'ruins' }, 'ruins'],
      ['史跡', { historic: 'archaeological_site' }, 'ruins'],
      ['記念碑', { historic: 'monument' }, 'monument'],
      ['慰霊碑', { historic: 'memorial' }, 'monument'],
      ['博物館', { tourism: 'museum' }, 'museum'],
      ['展望地', { tourism: 'viewpoint' }, 'viewpoint'],
      ['観光地', { tourism: 'attraction' }, 'attraction'],
      ['山小屋', { tourism: 'alpine_hut' }, 'alpine_hut'],
      ['避難小屋', { tourism: 'wilderness_hut' }, 'alpine_hut'],
      ['山頂', { natural: 'peak' }, 'peak'],
      ['火山', { natural: 'volcano' }, 'peak'],
      ['どれでもない（店）', { shop: 'convenience' }, null],
      ['どれでもない（道）', { highway: 'primary' }, null]
    ];
    await forEachCase(cases, async (_name, tags, kind) => {
      const result = await build([point(36.1, 137.1, { ...tags, name: 'なにか' })]);
      const entries = allEntries(result.cells) as Array<{ kind: string }>;
      expect(entries.map((e) => e.kind)).toEqual(kind === null ? [] : [kind]);
    });
  });

  it('Wikidata か Wikipedia が付いていれば名の知れたもの、どちらも無ければそうでない', async () => {
    const result = await build([
      point(36.1, 137.1, { historic: 'castle', name: 'ウィキペディアだけ', wikipedia: 'ja:何々城' }),
      point(36.1, 137.1, { historic: 'castle', name: 'どちらも無い' })
    ]);

    const entries = allEntries(result.cells) as Array<{ name: string; known: boolean }>;
    expect(entries.find((e) => e.name === 'ウィキペディアだけ')?.known).toBe(true);
    expect(entries.find((e) => e.name === 'どちらも無い')?.known).toBe(false);
  });

  it('山頂は標高を数で持ち、数として読めなければ標高は無し。山頂でないものは標高のタグがあっても無し', async () => {
    const result = await build([
      point(36.2894, 137.6480, { natural: 'peak', name: '奥穂高岳', ele: '3190' }),
      point(36.2265, 137.5875, { natural: 'volcano', name: '焼岳', ele: '2444.3' }),
      point(36.3, 137.6, { natural: 'peak', name: '標高の読めない山', ele: 'unknown' }),
      point(36.3, 137.6, { natural: 'peak', name: '標高の無い山' }),
      point(36.2, 137.9, { man_made: 'tower', name: '標高の付いた塔', ele: '700' })
    ]);

    const eleOf = (name: string) => (allEntries(result.cells) as Array<{ name: string; ele: number | null }>).find((e) => e.name === name)?.ele;
    expect(eleOf('奥穂高岳')).toBe(3190);
    expect(eleOf('焼岳')).toBe(2444.3);
    expect(eleOf('標高の読めない山')).toBeNull();
    expect(eleOf('標高の無い山')).toBeNull();
    expect(eleOf('標高の付いた塔')).toBeNull();
  });

  it('区画の境の上の点は、北と東の区画に入る', async () => {
    const result = await build([
      point(36.25, 138.0, { historic: 'castle', name: '境の上' }),
      point(36.2499, 137.9999, { historic: 'castle', name: '境の手前' })
    ]);

    expect(Object.keys(result.cells).sort()).toEqual(['36.00_137.75', '36.25_138.00']);
    expect((result.cells['36.25_138.00'] as Array<{ name: string }>).map((e) => e.name)).toEqual(['境の上']);
  });

  it('行頭の区切りの文字（osmium の geojsonseq が付ける）と空行は読み飛ばす', async () => {
    const result = await build(['\u001e' + point(36.1, 137.1, { historic: 'castle', name: '区切り付き' }), '', '   ']);

    expect((allEntries(result.cells) as Array<{ name: string }>).map((e) => e.name)).toEqual(['区切り付き']);
  });

  it('名所と山頂の件数が下限を下回ると失敗し、下限以上なら全体と種類ごとの件数を返す', async () => {
    const lines = [
      point(36.1, 137.1, { historic: 'castle', name: '城' }),
      point(36.1, 137.1, { natural: 'peak', name: '山', ele: '1000' }),
      point(36.1, 137.1, { natural: 'peak', name: '山2', ele: '1200' }),
      // 捨てるものは数えない
      point(36.1, 137.1, { shop: 'convenience', name: '店' })
    ];

    await expect(buildLandmarkCells(lines, { minCount: 4 })).rejects.toThrow('名所と山頂が 3 件しかありません（下限 4 件）');
    const result = await buildLandmarkCells(lines, { minCount: 3 });
    expect(result.total).toBe(3);
    expect(result.byKind).toEqual({ castle: 1, peak: 2 });
  });
});
