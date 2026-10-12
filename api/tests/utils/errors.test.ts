import { hasCauseCode, isConnectivityError } from '../../src/utils/errors';

describe('hasCauseCode', () => {
  // 循環ガードが外れると、このテストは同期の無限ループになる。
  // 同期ループは Jest の testTimeout（10秒）では中断できないため、
  // 失敗はテストの赤ではなく CI のジョブのタイムアウトとして現れる。
  // 上限の深さそのものは実装の詳細なので固定しない
  it('causeが循環していても止まり、該当するcodeが無ければfalseを返す', () => {
    const a: any = new Error('a');
    const b: any = new Error('b');
    a.cause = b;
    b.cause = a;

    expect(hasCauseCode(a, ['ENOTFOUND'])).toBe(false);
  });

  it('causeのチェーンの深い位置に該当するcodeがあればtrueを返す', () => {
    const root = Object.assign(new Error('getaddrinfo ENOTFOUND host'), { code: 'ENOTFOUND' });
    const mid = Object.assign(new TypeError('fetch failed'), { cause: root });
    const top = Object.assign(new Error('Connection error.'), { cause: mid });

    expect(hasCauseCode(top, ['ENOTFOUND', 'ECONNREFUSED'])).toBe(true);
  });
});

describe('isConnectivityError', () => {
  it.each([
    ['ENOTFOUND', 'getaddrinfo ENOTFOUND example.documents.azure.com'],
    ['ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:8081'],
  ])(
    'トップレベルのcodeが%sのエラーは、接続できない障害と判定する',
    (code, message) => {
      const error = Object.assign(new Error(message), { code });

      expect(isConnectivityError(error)).toBe(true);
    }
  );

  it('接続できない原因がcauseの2段奥にあっても、接続できない障害と判定する', () => {
    const root = Object.assign(new Error('getaddrinfo ENOTFOUND example.documents.azure.com'), {
      code: 'ENOTFOUND',
    });
    const mid = Object.assign(new TypeError('fetch failed'), { cause: root });
    const top = Object.assign(new Error('Connection error.'), { cause: mid });

    expect(isConnectivityError(top)).toBe(true);
  });

  it.each([
    ['codeの無い通常のエラー', new Error('something went wrong')],
    [
      'Cosmos DBが返す404のエラー',
      Object.assign(new Error('Entity with the specified id does not exist in the system.'), {
        code: 404,
      }),
    ],
  ])('%sは、接続できない障害と判定しない', (_name, error) => {
    expect(isConnectivityError(error)).toBe(false);
  });
});
