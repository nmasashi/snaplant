import { generateReadSasUrl, ReadSasParams } from '../../src/utils/blobSas';

// 実 SDK で署名する（モックしない）。署名はローカルの計算だけで Blob Storage へは通信しない。
// できた SAS トークンのうち、署名（sig）は読めないが、権限（sp）・対象の種類（sr）・開始時刻（st）・
// 有効期限（se）は平文のクエリで読める。この4つは Blob Storage が検証する契約なので、
// SDK へ渡した引数ではなく、返ってきた URL のトークンそのものを見る。
// sv（API バージョン）は SDK の更新で変わるので見ない

const BLOB_URL = 'https://test.blob.core.windows.net/photos/abc.jpg';

/** 署名に要る引数。開始時刻（startsOn）は任意で、渡したときだけ足す */
const readSasParams = (extra: { startsOn?: Date } = {}): ReadSasParams => ({
  accountName: 'test',
  accountKey: 'testkey==',
  blobUrl: BLOB_URL,
  containerName: 'photos',
  blobName: 'abc.jpg',
  expiresOn: new Date('2026-10-10T04:12:45.000Z'),
  ...extra
});

/** `<blobUrl>?<SAS>` の URL から、SAS トークンのクエリを取り出す */
const tokenOf = (url: string): URLSearchParams => new URLSearchParams(url.slice(url.indexOf('?') + 1));

describe('generateReadSasUrl', () => {
  it('読み取りだけを許す、Blob1つ分のURLになる', () => {
    const url = generateReadSasUrl(readSasParams());

    const token = tokenOf(url);
    expect(token.get('sp')).toBe('r');
    expect(token.get('sr')).toBe('b');
  });

  it('有効期限は、渡した時刻になる', () => {
    const url = generateReadSasUrl(readSasParams());

    expect(tokenOf(url).get('se')).toBe('2026-10-10T04:12:45Z');
  });

  it('開始時刻を渡すと、その時刻から有効なURLになる', () => {
    const url = generateReadSasUrl(readSasParams({ startsOn: new Date('2026-10-10T03:07:45.000Z') }));

    expect(tokenOf(url).get('st')).toBe('2026-10-10T03:07:45Z');
  });

  it('開始時刻を渡さなければ、発行した時点から有効なURLになる', () => {
    const url = generateReadSasUrl(readSasParams());

    // 開始時刻を省くと、SAS のトークンに st 自体が付かない
    expect(tokenOf(url).get('st')).toBeNull();
  });
});
