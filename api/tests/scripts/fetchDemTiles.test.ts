import * as fs from 'fs';
import * as path from 'path';
import { DemTile, TileStore, fetchDemTiles, folderStore, judgeGsiResponse } from '../../src/scripts/fetchDemTiles';

// 標高のデータ（国土地理院の標高タイル）を取り出すスクリプト（C-7a。docs/06_processing_design.md §11.2）。
// ズーム 8 から始め、あるタイル（404 でないもの）の子だけをズーム 10・12・14 とたどる。
// 国土地理院の HTTP の代わりに、陸のズーム 14 のタイルの集まりから「あるか」を決める偽物を渡す

const key = (t: DemTile): string => `${t.z}/${t.x}/${t.y}`;

/** 陸のズーム 14 のタイルを持ち、その祖先のタイルだけを返す偽の国土地理院。頼まれた順を覚える */
function fakeServer(land14: Array<[number, number]>) {
  const requested: string[] = [];
  const exists = (t: DemTile): boolean => land14.some(([x, y]) => (x >> (14 - t.z)) === t.x && (y >> (14 - t.z)) === t.y);
  const fetchTile = async (t: DemTile): Promise<Buffer | null> => {
    requested.push(key(t));
    return exists(t) ? Buffer.from(`png ${key(t)}`) : null;
  };
  return { requested, fetchTile };
}

/** メモリの中の置き場。取ったタイルと、無かったタイル（404）を覚える */
function memoryStore(initial: { found?: string[]; missing?: string[] } = {}) {
  const found = new Map<string, Buffer>((initial.found ?? []).map((k) => [k, Buffer.from('earlier')]));
  const missing = new Set<string>(initial.missing ?? []);
  const store: TileStore = {
    state: (t) => (found.has(key(t)) ? 'found' : missing.has(key(t)) ? 'missing' : null),
    saveFound: (t, body) => { found.set(key(t), body); },
    saveMissing: (t) => { missing.add(key(t)); }
  };
  return { store, found, missing };
}

// 九重山の近く（北緯 33.08 度・東経 131.24 度）のズーム 14 のタイルは (14164, 6595)。
// ズーム 8 では (221, 103)、10 では (885, 412)、12 では (3541, 1648)
const KUJU: [number, number] = [14164, 6595];
// ズーム 8 の (221, 103) の1枚だけを覆う範囲
const ONE_Z8 = { south: 33.0, north: 33.1, west: 131.0, east: 131.1 };

const noWait = async (): Promise<void> => {};

describe('標高のデータを取り出すスクリプト（C-7a。06 §11.2）', () => {
  it('ズーム 8 からあるタイルの子だけをたどり、ズーム 14 まで取って置く', async () => {
    const server = fakeServer([KUJU]);
    const { store, found, missing } = memoryStore();

    await fetchDemTiles({ fetchTile: server.fetchTile, store, wait: noWait, bounds: ONE_Z8 });

    // 陸のタイルの祖先だけが取れる
    expect([...found.keys()].sort()).toEqual(['10/885/412', '12/3541/1648', '14/14164/6595', '8/221/103'].sort());
    // 取ってきたファイルをそのまま置く（変換しない）
    expect(found.get('14/14164/6595')).toEqual(Buffer.from('png 14/14164/6595'));
    // あるタイルの子（4 × 4 = 16 枚）を頼み、無かった 15 枚は 404 として覚える。無いタイルの子は頼まない
    expect(server.requested).toHaveLength(1 + 16 * 3);
    expect(missing.size).toBe(15 * 3);
    // ズーム 12 は、あったズーム 10 の 885/412 の子（x 3540〜3543・y 1648〜1651）だけを頼む
    const children12 = [3540, 3541, 3542, 3543].flatMap((x) => [1648, 1649, 1650, 1651].map((y) => `12/${x}/${y}`));
    expect(server.requested.filter((k) => k.startsWith('12/')).sort()).toEqual(children12.sort());
  });

  it('既に置いてあるタイルと、無かったと覚えているタイルは頼み直さず、置いてあるタイルの子はたどる（途中で止まっても続きから取れる）', async () => {
    const server = fakeServer([KUJU]);
    const missingAt12 = ['12/3540/1648', '12/3541/1649'];
    const { store, found } = memoryStore({ found: ['8/221/103', '10/885/412'], missing: missingAt12 });

    await fetchDemTiles({ fetchTile: server.fetchTile, store, wait: noWait, bounds: ONE_Z8 });

    expect(server.requested).not.toContain('8/221/103');
    // ズーム 10 は置いてある 885/412 を頼まず、置き場に無いほかの 15 枚だけを頼む
    expect(server.requested).not.toContain('10/885/412');
    expect(server.requested.filter((k) => k.startsWith('10/'))).toHaveLength(15);
    for (const k of missingAt12) expect(server.requested).not.toContain(k);
    expect(server.requested.filter((k) => k.startsWith('12/'))).toHaveLength(14);
    // 無かったと覚えているズーム 12 の子は頼まない（続きから回すたびに海のズーム 14 を頼み直さない）。頼むのは、あったズーム 12 の子の 16 枚だけ
    expect(server.requested.filter((k) => k.startsWith('14/'))).toHaveLength(16);
    expect(found.has('14/14164/6595')).toBe(true);
  });

  it('1枚ずつ頼み、頼むたびに既定の間を待ち終えてから次を頼み、頼まなかったタイルでは待たない（国土地理院のサーバに負荷をかけない）', async () => {
    const server = fakeServer([KUJU]);
    const { store } = memoryStore({ found: ['8/221/103'] });
    const events: string[] = [];
    const fetchTile = async (t: DemTile): Promise<Buffer | null> => { events.push('頼む'); return server.fetchTile(t); };
    const wait = async (ms: number): Promise<void> => {
      events.push(`待つ ${ms}`);
      await new Promise((resolve) => setImmediate(resolve));
      events.push('待ち終わり');
    };

    await fetchDemTiles({ fetchTile, store, wait, bounds: ONE_Z8 });

    // 置いてあるズーム 8 は頼まない。頼んだ 48 枚のそれぞれで、頼む → 0.4 秒（1秒に 2〜3 枚）待つ → 待ち終わってから次を頼む
    expect(server.requested).toHaveLength(48);
    expect(events).toEqual(server.requested.flatMap(() => ['頼む', '待つ 400', '待ち終わり']));
  });

  it('404 でない失敗は間を置いて取り直し、取れれば続ける', async () => {
    const server = fakeServer([KUJU]);
    let failures = 2;
    const flaky = async (t: DemTile): Promise<Buffer | null> => {
      if (key(t) === '12/3541/1648' && failures > 0) { failures--; throw new Error('HTTP 503'); }
      return server.fetchTile(t);
    };
    const { store, found } = memoryStore();
    const waits: number[] = [];

    // 取り直しの間は既定のまま（渡さない）。失敗のたびに、頼むたびの間とは別に、0 より長い間を置く
    await fetchDemTiles({ fetchTile: flaky, store, wait: async (ms) => { waits.push(ms); }, bounds: ONE_Z8, intervalMs: 400 });

    expect(found.has('14/14164/6595')).toBe(true);
    const retryWaits = waits.filter((ms) => ms !== 400);
    expect(retryWaits).toHaveLength(2);
    expect(retryWaits.every((ms) => ms > 0)).toBe(true);
  });

  it('取り直しても失敗が続けば止まり、それまでに取ったタイルは置いたまま残り、失敗したタイルは無かったことにしない（次に回せば取り直す）', async () => {
    const server = fakeServer([KUJU]);
    const broken = async (t: DemTile): Promise<Buffer | null> => {
      if (t.z === 12) throw new Error('HTTP 503');
      return server.fetchTile(t);
    };
    const { store, found, missing } = memoryStore();

    await expect(fetchDemTiles({ fetchTile: broken, store, wait: noWait, bounds: ONE_Z8, retryDelaysMs: [5000, 15000] })).rejects.toThrow('HTTP 503');

    expect([...found.keys()].sort()).toEqual(['10/885/412', '8/221/103']);
    expect([...missing].filter((k) => k.startsWith('12/'))).toEqual([]);
  });

  it('取り直しても変わらない失敗（404 でない 4xx。サーバに断られた）は、取り直さずにすぐ止まる（断ったサーバに頼み続けない）', async () => {
    const server = fakeServer([KUJU]);
    const refused = async (t: DemTile): Promise<Buffer | null> => {
      if (t.z === 10) {
        server.requested.push(key(t));
        throw Object.assign(new Error('HTTP 403'), { retryable: false });
      }
      return server.fetchTile(t);
    };
    const { store } = memoryStore();
    const waits: number[] = [];

    await expect(fetchDemTiles({ fetchTile: refused, store, wait: async (ms) => { waits.push(ms); }, bounds: ONE_Z8, intervalMs: 400, retryDelaysMs: [5000, 15000] }))
      .rejects.toThrow('HTTP 403');

    expect(server.requested.filter((k) => k.startsWith('10/'))).toHaveLength(1);
    expect(waits.filter((ms) => ms !== 400)).toEqual([]);
  });

  it('ズームごとに、あったタイルと無かったタイルの数を返す', async () => {
    const server = fakeServer([KUJU, [14165, 6595]]);
    const { store } = memoryStore();

    const summary = await fetchDemTiles({ fetchTile: server.fetchTile, store, wait: noWait, bounds: ONE_Z8 });

    expect(summary).toEqual({
      8: { found: 1, missing: 0 },
      10: { found: 1, missing: 15 },
      12: { found: 1, missing: 15 },
      14: { found: 2, missing: 14 }
    });
  });

  it('範囲を渡さなければ、日本を覆う範囲（北緯 20〜46 度・東経 122〜154 度）のズーム 8 のタイルから始める', async () => {
    const server = fakeServer([]);
    const { store } = memoryStore();

    await fetchDemTiles({ fetchTile: server.fetchTile, store, wait: noWait });

    // 東経 122〜154 度はズーム 8 の x が 214〜237、北緯 46〜20 度は y が 91〜113
    expect(server.requested).toHaveLength(24 * 23);
    expect(server.requested).toContain('8/214/91');
    expect(server.requested).toContain('8/237/113');
  });
});

describe('標高のデータを取り出すスクリプトの、国土地理院の応答の見分け方と手元の置き場（C-7a。06 §11.2）', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('tile')]);

  it('200 の PNG はそのまま置く中身になり、404 は無かったタイルになる', () => {
    expect(judgeGsiResponse(200, String(png.length), png)).toEqual(png);
    expect(judgeGsiResponse(404, '0', Buffer.alloc(0))).toBeNull();
  });

  it('断られた 4xx（404・408・425・429 でないもの）と 3xx と 200 でない 2xx は取り直さない失敗、408・425・429 と 5xx は取り直す失敗になる', () => {
    const errorOf = (status: number): { retryable?: boolean } => {
      try {
        judgeGsiResponse(status, '0', Buffer.alloc(0));
      } catch (error) {
        return error as { retryable?: boolean };
      }
      throw new Error(`${status} で失敗にならなかった`);
    };
    expect(errorOf(403).retryable).toBe(false);
    expect(errorOf(400).retryable).toBe(false);
    expect(errorOf(429).retryable).toBe(true);
    expect(errorOf(503).retryable).toBe(true);
    // 408（時間切れ）・425（早すぎる）は一時的な 4xx なので取り直す。3xx（場所が移った）は取り直しても変わらない
    expect(errorOf(408).retryable).toBe(true);
    expect(errorOf(425).retryable).toBe(true);
    expect(errorOf(301).retryable).toBe(false);
    expect(errorOf(302).retryable).toBe(false);
    // 200 でない 2xx（204 中身なし・206 一部だけ）も、取り直しても変わらない
    expect(errorOf(204).retryable).toBe(false);
    expect(errorOf(206).retryable).toBe(false);
  });

  it('Content-Length が空か数でなければ、長さは比べずに PNG なら置く', () => {
    expect(judgeGsiResponse(200, '', png)).toEqual(png);
    expect(judgeGsiResponse(200, undefined, png)).toEqual(png);
    expect(judgeGsiResponse(200, '12a', png)).toEqual(png);
  });

  it('本文が途中で切れた応答と PNG でない応答は、置かずに取り直す失敗になる（置くと二度と取り直されない）', () => {
    const retryableOf = (contentLength: string, body: Buffer): boolean | undefined => {
      try {
        judgeGsiResponse(200, contentLength, body);
      } catch (error) {
        return (error as { retryable?: boolean }).retryable !== false;
      }
      throw new Error('失敗にならなかった');
    };
    expect(retryableOf(String(png.length + 100), png)).toBe(true);
    const html = Buffer.from('<html>maintenance</html>');
    expect(retryableOf(String(html.length), html)).toBe(true);
  });

  describe('手元のフォルダの置き場', () => {
    let root: string;
    // 一時フォルダはリポジトリ直下の .work/ に作る（OS の一時フォルダに書かない。CLAUDE.md）
    const workDir = path.join(__dirname, '..', '..', '..', '.work');
    beforeEach(() => {
      fs.mkdirSync(workDir, { recursive: true });
      root = fs.mkdtempSync(path.join(workDir, 'dem-tiles-test-'));
    });
    afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

    it('取ったタイルは <ズーム>/<x>/<y>.png に中身のまま置き（Blob に上げるときの名前）、無かったタイルは .none で覚える', () => {
      const store = folderStore(root);

      store.saveFound({ z: 14, x: 14164, y: 6595 }, png);
      store.saveMissing({ z: 12, x: 3540, y: 1648 });

      expect(fs.readFileSync(path.join(root, '14', '14164', '6595.png'))).toEqual(png);
      expect(fs.existsSync(path.join(root, '12', '3540', '1648.none'))).toBe(true);
      // 新しく作り直した置き場（次に回したとき）からも見える
      const again = folderStore(root);
      expect(again.state({ z: 14, x: 14164, y: 6595 })).toBe('found');
      expect(again.state({ z: 12, x: 3540, y: 1648 })).toBe('missing');
      expect(again.state({ z: 14, x: 6595, y: 14164 })).toBeNull();
    });
  });
});
