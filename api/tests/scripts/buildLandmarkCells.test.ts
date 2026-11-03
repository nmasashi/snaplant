import { LandmarkEntry, buildLandmarkCells } from '../../src/scripts/buildLandmarkCells';
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
const allEntries = (cells: Record<string, LandmarkEntry[]>): LandmarkEntry[] => Object.values(cells).flat();

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

    const entries = allEntries(result.cells);
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
        { highway: 'footway', bridge: 'yes', name: 'Matsumoto Castle path', 'name:ja': '松本城の園路', 'bridge:name': '埋橋' }
      ),
      point(35.0124, 135.7826, { tourism: 'museum', name: 'Kyoto City KYOCERA Museum of Art', 'name:ja': '京都市京セラ美術館' }),
      point(36.2378, 137.9712, { amenity: 'place_of_worship', religion: 'shinto', name: '四柱神社' }),
      point(36.2400, 137.9700, { amenity: 'place_of_worship', religion: 'shinto' }),
      // 橋の道でもある観光地は、橋の名前でなく、その観光地の名前を使う（橋の名前は種類が橋のときだけ）
      line(
        [
          [36.30, 137.30],
          [36.31, 137.31]
        ],
        { highway: 'footway', bridge: 'yes', tourism: 'attraction', name: '空中散歩道', 'bridge:name': '第二歩道橋' }
      )
    ]);

    expect(allEntries(result.cells).map((e) => e.name).sort()).toStrictEqual(
      ['京都市京セラ美術館', '四柱神社', '埋橋', '空中散歩道'].sort()
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
      ['神社の建物', { building: 'shrine' }, 'place_of_worship'],
      ['教会の建物', { building: 'church' }, 'place_of_worship'],
      ['大聖堂の建物', { building: 'cathedral' }, 'place_of_worship'],
      ['仏塔の建物', { building: 'pagoda' }, 'place_of_worship'],
      ['宗教の分かる寺の建物', { building: 'temple', religion: 'buddhist' }, 'temple'],
      ['塔', { man_made: 'tower' }, 'tower'],
      ['灯台', { man_made: 'lighthouse' }, 'lighthouse'],
      ['橋（man_made）', { man_made: 'bridge' }, 'bridge'],
      ['橋（道。橋の名前のあるもの）', { highway: 'primary', bridge: 'yes', 'bridge:name': '何々橋' }, 'bridge'],
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
      // 橋の道でもある名所は、橋でなくその種類にする（橋として名前の条件で捨てられないように）
      ['橋の道でもある観光地', { highway: 'footway', bridge: 'yes', tourism: 'attraction' }, 'attraction'],
      ['橋の道でもある記念碑', { highway: 'footway', bridge: 'yes', historic: 'monument' }, 'monument'],
      ['避難小屋', { tourism: 'wilderness_hut' }, 'alpine_hut'],
      ['山頂', { natural: 'peak' }, 'peak'],
      ['火山', { natural: 'volcano' }, 'peak'],
      ['どれでもない（店）', { shop: 'convenience' }, null],
      ['どれでもない（道）', { highway: 'primary' }, null]
    ];
    await forEachCase(cases, async (_name, tags, kind) => {
      const result = await build([point(36.1, 137.1, { ...tags, name: 'なにか' })]);
      const entries = allEntries(result.cells);
      expect(entries.map((e) => e.kind)).toEqual(kind === null ? [] : [kind]);
    });
  });

  it('Wikidata か Wikipedia が付いていれば名の知れたもの、どちらも無ければそうでない', async () => {
    const result = await build([
      point(36.1, 137.1, { historic: 'castle', name: 'ウィキペディアだけ', wikipedia: 'ja:何々城' }),
      point(36.1, 137.1, { historic: 'castle', name: 'どちらも無い' })
    ]);

    const entries = allEntries(result.cells);
    expect(entries.find((e) => e.name === 'ウィキペディアだけ')?.known).toBe(true);
    expect(entries.find((e) => e.name === 'どちらも無い')?.known).toBe(false);
  });

  it('山頂は標高を数で持ち、数として読めなければ標高は無し。山頂でないものは標高のタグがあっても無し', async () => {
    const result = await build([
      point(36.2894, 137.6480, { natural: 'peak', name: '奥穂高岳', ele: '3190' }),
      point(36.2265, 137.5875, { natural: 'volcano', name: '焼岳', ele: '2444.3' }),
      point(36.3, 137.6, { natural: 'peak', name: '標高の読めない山', ele: 'unknown' }),
      // 桁区切りや複数の値は、先頭の数だけを読むと桁違いになる（3,776 を 3 と読む）
      point(36.3, 137.6, { natural: 'peak', name: '桁区切りの標高の山', ele: '3,776' }),
      point(36.3, 137.6, { natural: 'peak', name: '値が2つある山', ele: '2999;3000' }),
      // 単位の m が付いた値は読む
      point(36.3, 137.6, { natural: 'peak', name: '単位付きの山', ele: '3776 m' }),
      point(36.3, 137.6, { natural: 'peak', name: '単位が詰まった山', ele: '2444.3m' }),
      point(36.3, 137.6, { natural: 'peak', name: '標高の無い山' }),
      point(36.2, 137.9, { man_made: 'tower', name: '標高の付いた塔', ele: '700' })
    ]);

    const eleOf = (name: string) => allEntries(result.cells).find((e) => e.name === name)?.ele;
    expect(eleOf('奥穂高岳')).toBe(3190);
    expect(eleOf('焼岳')).toBe(2444.3);
    expect(eleOf('標高の読めない山')).toBeNull();
    expect(eleOf('桁区切りの標高の山')).toBeNull();
    expect(eleOf('値が2つある山')).toBeNull();
    expect(eleOf('単位付きの山')).toBe(3776);
    expect(eleOf('単位が詰まった山')).toBe(2444.3);
    expect(eleOf('標高の無い山')).toBeNull();
    expect(eleOf('標高の付いた塔')).toBeNull();
  });

  it('区画の境の上の点は、北と東の区画に入る', async () => {
    const result = await build([
      point(36.25, 138.0, { historic: 'castle', name: '境の上' }),
      point(36.2499, 137.9999, { historic: 'castle', name: '境の手前' })
    ]);

    expect(Object.keys(result.cells).sort()).toEqual(['36.00_137.75', '36.25_138.00']);
    expect(result.cells['36.25_138.00'].map((e) => e.name)).toEqual(['境の上']);
  });

  it('道や線路の橋は、橋の名前があるか、名前に「橋」を含むときだけ入れ、道や線路の名前だけの橋は捨てる', async () => {
    const segment: Array<[number, number]> = [
      [36.10, 137.10],
      [36.11, 137.11]
    ];
    const result = await build([
      line(segment, { railway: 'rail', bridge: 'yes', name: '東海道新幹線' }),
      line(segment, { highway: 'primary', bridge: 'yes', name: '国道20号' }),
      line(segment, { highway: 'footway', bridge: 'yes', name: '河童橋' }),
      // bridge=no は橋でない（編集の跡で残っていることがある）
      line(segment, { highway: 'residential', bridge: 'no', name: '日本橋通り' }),
      line(segment, { highway: 'primary', bridge: 'yes', name: '国道20号', 'bridge:name': '新宮川橋梁' }),
      // 橋の名前があれば、「橋」を含まなくても入れる
      line(segment, { highway: 'motorway', bridge: 'yes', name: '首都高速湾岸線', 'bridge:name': 'ベイブリッジ' }),
      // man_made=bridge は橋そのものなので、名前に「橋」が無くても入れる
      polygon(
        [
          [36.10, 137.10],
          [36.10, 137.11],
          [36.11, 137.11],
          [36.10, 137.10]
        ],
        { man_made: 'bridge', name: 'レインボーブリッジ' }
      )
    ]);

    expect(allEntries(result.cells).map((e) => e.name).sort()).toStrictEqual(
      ['ベイブリッジ', 'レインボーブリッジ', '新宮川橋梁', '河童橋'].sort()
    );
  });

  it('同じ区画に同じ名前・同じ種類が何件あっても1件にまとめ、どれかが名の知れたものなら名の知れたものとして残す', async () => {
    const result = await build([
      // 道は区切って載っていることが多く、城は点と敷地の形の両方で載っていることがある
      line(
        [
          [36.2380, 137.9680],
          [36.2381, 137.9681]
        ],
        { highway: 'footway', bridge: 'yes', name: '埋橋' }
      ),
      line(
        [
          [36.2381, 137.9681],
          [36.2382, 137.9682]
        ],
        { highway: 'footway', bridge: 'yes', name: '埋橋' }
      ),
      point(36.2386, 137.9689, { historic: 'castle', name: '松本城' }),
      point(36.2387, 137.9690, { historic: 'castle', name: '松本城', wikidata: 'Q46581' }),
      // 名の知れたものの後に、名の知れていないもの（wikidata の無い敷地の形など）が来ても、名の知れたもののまま
      point(36.2388, 137.9691, { historic: 'castle', name: '松本城' }),
      // 名前が同じでも種類が違えば別
      point(36.2386, 137.9689, { tourism: 'viewpoint', name: '松本城' })
    ]);

    const entries = allEntries(result.cells);
    expect(entries.map((e) => `${e.name}:${e.kind}`).sort()).toEqual(['埋橋:bridge', '松本城:castle', '松本城:viewpoint'].sort());
    // 位置は最初の1件
    expect(entries.find((e) => e.kind === 'castle')).toStrictEqual({ name: '松本城', kind: 'castle', lat: 36.2386, lon: 137.9689, known: true, ele: null });
    expect(result.total).toBe(3);
    expect(result.byKind).toEqual({ bridge: 1, castle: 1, viewpoint: 1 });
  });

  it('同じ区画の同じ名前・同じ種類でも、離れていれば（500 m より遠ければ）別の名所として残す', async () => {
    // 八幡神社や丸山のような名前は、同じ区画（25 km 四方ほど）にいくつもある
    const result = await build([
      point(36.10, 137.10, { amenity: 'place_of_worship', religion: 'shinto', name: '八幡神社' }),
      // 北へ 0.004 度（約 440 m）。同じ神社の点と敷地の形とみなす
      point(36.104, 137.10, { amenity: 'place_of_worship', religion: 'shinto', name: '八幡神社' }),
      // 北へ 0.05 度（約 5.5 km）。別の神社
      point(36.15, 137.10, { amenity: 'place_of_worship', religion: 'shinto', name: '八幡神社' })
    ]);

    const entries = allEntries(result.cells);
    expect(entries.map((e) => e.lat).sort()).toStrictEqual([36.1, 36.15]);
    expect(result.total).toBe(2);
  });

  it('区切られて載っている橋は、最初の区切りとつながる区切りを1件にまとめ、最初の区切りから離れた区切りは別に残す', async () => {
    // 1 区切り 0.006 度（約 670 m）。区切りの中心どうしは 500 m より離れるが、隣り合う区切りの端はつながっている
    const result = await build([
      line([[36.100, 137.10], [36.106, 137.10]], { man_made: 'bridge', name: '長い大橋' }),
      line([[36.106, 137.10], [36.112, 137.10]], { man_made: 'bridge', name: '長い大橋' }),
      // 最初の区切りから約 670 m 離れる。まとめても四角は広げない（鎖のようにつながないため）ので、別に残る
      line([[36.112, 137.10], [36.118, 137.10]], { man_made: 'bridge', name: '長い大橋' })
    ]);

    const lats = allEntries(result.cells).map((e) => e.lat);
    expect(lats).toHaveLength(2);
    expect(lats[0]).toBeCloseTo(36.103, 6);
    expect(lats[1]).toBeCloseTo(36.115, 6);
  });

  it('大きな敷地の形の中にある点は、敷地の中心から 500 m より遠くても1件にまとめる', async () => {
    // osmium は点を先に書き出す。城の点の後に、2 km 四方ほどの城の敷地の形が来る
    const result = await build([
      point(36.101, 137.101, { historic: 'castle', name: '大きな城', wikidata: 'Q1' }),
      polygon(
        [
          [36.10, 137.10],
          [36.10, 137.12],
          [36.12, 137.12],
          [36.12, 137.10],
          [36.10, 137.10]
        ],
        { historic: 'castle', name: '大きな城' }
      )
    ]);

    expect(allEntries(result.cells)).toStrictEqual([
      { name: '大きな城', kind: 'castle', lat: 36.101, lon: 137.101, known: true, ele: null }
    ]);
  });

  it('区画の境をまたいでも、500 m 以内の同じ名前・同じ種類は1件にまとめ、最初の1件の区画に入れる', async () => {
    const result = await build([
      point(36.2499, 137.9, { historic: 'castle', name: '境の城' }),
      point(36.2501, 137.9, { historic: 'castle', name: '境の城' })
    ]);

    expect(result.cells).toStrictEqual({
      '36.00_137.75': [{ name: '境の城', kind: 'castle', lat: 36.2499, lon: 137.9, known: false, ele: null }]
    });
  });

  it('まとめるとき、先の1件に標高が無く後の1件にあれば、その標高を使う', async () => {
    const result = await build([
      point(36.2894, 137.6480, { natural: 'peak', name: '奥穂高岳' }),
      point(36.2895, 137.6481, { natural: 'peak', name: '奥穂高岳', ele: '3190' })
    ]);

    expect(allEntries(result.cells).map((e) => e.ele)).toStrictEqual([3190]);
  });

  it('行頭の区切りの文字（osmium の geojsonseq が付ける）と空行は読み飛ばす', async () => {
    const result = await build(['\u001e' + point(36.1, 137.1, { historic: 'castle', name: '区切り付き' }), '', '   ']);

    expect(allEntries(result.cells).map((e) => e.name)).toStrictEqual(['区切り付き']);
  });

  it('名所と山頂の件数が下限を下回ると失敗し、下限以上なら全体と種類ごとの件数を返す', async () => {
    const lines = [
      point(36.1, 137.1, { historic: 'castle', name: '城' }),
      point(36.1, 137.1, { natural: 'peak', name: '山', ele: '1000' }),
      point(36.1, 137.1, { natural: 'peak', name: '山2', ele: '1200' }),
      // 捨てるものは数えない
      point(36.1, 137.1, { shop: 'convenience', name: '店' })
    ];

    await expect(buildLandmarkCells(lines, { minCount: 4 })).rejects.toThrow(/3 件/);
    const result = await buildLandmarkCells(lines, { minCount: 3 });
    expect(result.total).toBe(3);
    expect(result.byKind).toEqual({ castle: 1, peak: 2 });
  });

  it('件数の下限が数として読めない・負・小数なら、確かめが黙って効かなくならないよう失敗する', async () => {
    const lines = [point(36.1, 137.1, { historic: 'castle', name: '城' })];
    // 「120,000」などを渡すと NaN になり、件数 < NaN は常に false で、下限が消える
    await forEachCase(
      [
        ['数でない', Number.NaN],
        ['負', -1],
        ['小数', 1.5]
      ] as Array<[string, number]>,
      async (_name, minCount) => {
        await expect(buildLandmarkCells(lines, { minCount })).rejects.toThrow('件数の下限が無効です');
      }
    );
  });

  it('座標が数十万ある敷地の形も、それを囲む四角の中心の点になる', async () => {
    // 大きな敷地の形の座標を Math.min(...配列) に広げると、引数の数の上限で落ちる
    const ring: Array<[number, number]> = Array.from({ length: 500_000 }, (_, i) => [36.1 + (i % 2) * 0.01, 137.1]);
    const result = await build([polygon(ring, { historic: 'castle', name: '大きな城' })]);

    const [entry] = allEntries(result.cells);
    expect(entry.name).toBe('大きな城');
    expect(entry.lat).toBeCloseTo(36.105, 6);
    expect(entry.lon).toBeCloseTo(137.1, 6);
  });

  it('同じ名前の名所が 500 m より短い間隔で並んでいても、最初の1件から 500 m より離れたものは別に残す', async () => {
    // 展望台・忠魂碑のような名前は、尾根や海沿いに短い間隔で並ぶことがある。鎖のようにつないで1件にしない
    const result = await build([
      point(36.100, 137.10, { tourism: 'viewpoint', name: '展望台' }),
      // 北へ約 400 m
      point(36.1036, 137.10, { tourism: 'viewpoint', name: '展望台' }),
      // 北へ約 800 m（2件目からは約 400 m）
      point(36.1072, 137.10, { tourism: 'viewpoint', name: '展望台' })
    ]);

    expect(allEntries(result.cells).map((e) => e.lat)).toStrictEqual([36.1, 36.1072]);
  });
});
