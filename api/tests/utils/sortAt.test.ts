import { computeSortAt } from '../../src/utils/sortAt';

describe('computeSortAt', () => {
  it.each([
    ['同じ日の昼', '2026-10-10T03:12:45.000Z', '2026-10-10T12:12:45'],
    ['日付をまたぐ夜', '2026-10-10T20:00:00.000Z', '2026-10-11T05:00:00'],
  ])(
    '撮影日時が無い写真は、アップロード日時を日本時間に直したタイムゾーンの無い日時で並ぶ（%s）',
    (_name, uploadedAt, expected) => {
      const sortAt = computeSortAt(null, uploadedAt);

      expect(sortAt).toBe(expected);
    }
  );

  it('撮影日時がある写真は、撮影日時そのままで並ぶ', () => {
    const sortAt = computeSortAt('2026-10-05T12:30:15', '2026-10-10T03:12:45.000Z');

    expect(sortAt).toBe('2026-10-05T12:30:15');
  });
});
