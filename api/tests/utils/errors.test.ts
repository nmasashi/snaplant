import { hasCauseCode } from '../../src/utils/errors';

// cause をたどって errno を見つける動作と、isConnectivityError の分類は、
// ハンドラのテスト（tests/helpers/databaseFailures.ts の表、identify / upload の接続障害）が
// 同じ形のエラーで固定している。ここに残すのは、上位のどのテストも捕まえない循環の歯止めだけ
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
});
