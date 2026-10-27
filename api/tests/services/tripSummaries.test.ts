import { buildTripSummaries } from '../../src/services/tripSummaries';
import { Trip } from '../../src/types/album';

describe('buildTripSummaries', () => {
  it('各旅行の枚数と撮影期間は、集計の行の並びに関係なくその旅行の行から埋まる', () => {
    const tripA: Trip = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      name: '京都旅行',
      description: null,
      tags: [],
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    };
    const tripB: Trip = {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      name: '札幌旅行',
      description: '雪まつり',
      tags: ['国内'],
      createdAt: '2026-10-02T00:00:00.000Z',
      updatedAt: '2026-10-02T00:00:00.000Z',
    };
    // 取り違えを検出できるよう、集計の行は trips と逆順にしてある
    const counts = [
      { tripId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', photoCount: 2 },
      { tripId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', photoCount: 3 },
    ];
    const ranges = [
      {
        tripId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        firstTakenAt: '2026-11-01T10:00:00',
        lastTakenAt: '2026-11-03T20:15:00',
      },
      {
        tripId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        firstTakenAt: '2026-10-05T09:00:00',
        lastTakenAt: '2026-10-08T18:30:00',
      },
    ];

    const result = buildTripSummaries([tripA, tripB], counts, ranges);

    expect(result.trips).toEqual([
      {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        name: '札幌旅行',
        description: '雪まつり',
        tags: ['国内'],
        createdAt: '2026-10-02T00:00:00.000Z',
        updatedAt: '2026-10-02T00:00:00.000Z',
        photoCount: 2,
        firstTakenAt: '2026-11-01T10:00:00',
        lastTakenAt: '2026-11-03T20:15:00',
        coverThumbnailUrl: null,
      },
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        name: '京都旅行',
        description: null,
        tags: [],
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
        photoCount: 3,
        firstTakenAt: '2026-10-05T09:00:00',
        lastTakenAt: '2026-10-08T18:30:00',
        coverThumbnailUrl: null,
      },
    ]);
  });

  it('撮影日時のある写真が無い旅行は、枚数があっても撮影期間なしになる', () => {
    const trip: Trip = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      name: '京都旅行',
      description: null,
      tags: [],
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    };
    const counts = [{ tripId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', photoCount: 3 }];

    const result = buildTripSummaries([trip], counts, []);

    expect(result.trips[0].photoCount).toBe(3);
    expect(result.trips[0].firstTakenAt).toBeNull();
    expect(result.trips[0].lastTakenAt).toBeNull();
  });

  it('旅行に属さない写真の枚数は、どの旅行にも属さない写真の集計の行から出し、一覧に無い旅行を指す写真は数えない', () => {
    const trip: Trip = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      name: '京都旅行',
      description: null,
      tags: [],
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    };
    const counts = [
      { tripId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', photoCount: 2 },
      { tripId: null, photoCount: 4 },
      { tripId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', photoCount: 5 },
    ];

    const result = buildTripSummaries([trip], counts, []);

    expect(result.unassignedPhotoCount).toBe(4);
    expect(result.trips[0].photoCount).toBe(2);
  });

  it('旅行は最初の撮影日時の新しい順に並べ、撮影日時のある写真が無い旅行は先頭に作成日時の新しい順で並べる（撮影日時が同じなら作成日時の新しい順）', () => {
    const trip = (id: string, name: string, createdAt: string): Trip => ({
      id,
      name,
      description: null,
      tags: [],
      createdAt,
      updatedAt: createdAt,
    });
    // 一覧のクエリは作成日時の新しい順で返す。京都は古い旅行を後から作った
    const trips = [
      trip('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '京都（5月の旅行を後から作った）', '2026-10-25T00:00:00.000Z'),
      trip('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '作ったばかりの空の旅行', '2026-10-20T00:00:00.000Z'),
      trip('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '小樽（札幌と同じ日に始まる）', '2026-10-10T00:00:00.000Z'),
      trip('dddddddd-dddd-4ddd-8ddd-dddddddddddd', '札幌', '2026-10-02T00:00:00.000Z'),
      trip('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', '日時の無い写真だけの旅行', '2026-10-01T00:00:00.000Z'),
    ];
    const ranges = [
      { tripId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', firstTakenAt: '2026-05-03T09:00:00', lastTakenAt: '2026-05-05T18:00:00' },
      { tripId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', firstTakenAt: '2026-10-05T07:50:00', lastTakenAt: '2026-10-06T12:00:00' },
      { tripId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', firstTakenAt: '2026-10-05T07:50:00', lastTakenAt: '2026-10-07T20:00:00' },
    ];

    const result = buildTripSummaries(trips, [{ tripId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', photoCount: 2 }], ranges);

    expect(result.trips.map((summary) => summary.name)).toEqual([
      '作ったばかりの空の旅行',
      '日時の無い写真だけの旅行',
      '小樽（札幌と同じ日に始まる）',
      '札幌',
      '京都（5月の旅行を後から作った）',
    ]);
  });
});
