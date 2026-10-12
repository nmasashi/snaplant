import { buildTripSummaries } from '../../src/services/tripSummaries';
import { Trip } from '../../src/types/album';

describe('buildTripSummaries', () => {
  it('写真の無い旅行は、枚数0・撮影期間なし・表紙なしで、旅行に属さない写真も0枚になる', () => {
    const trip: Trip = {
      id: '11111111-1111-4111-8111-111111111111',
      name: '京都旅行',
      description: null,
      tags: ['国内'],
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    };

    const result = buildTripSummaries([trip], [], []);

    expect(result.trips).toEqual([
      {
        id: '11111111-1111-4111-8111-111111111111',
        name: '京都旅行',
        description: null,
        tags: ['国内'],
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
        photoCount: 0,
        firstTakenAt: null,
        lastTakenAt: null,
        coverThumbnailUrl: null,
      },
    ]);
    expect(result.unassignedPhotoCount).toBe(0);
  });

  it('各旅行の枚数と撮影期間は、並びに関係なくその旅行の行から埋まる', () => {
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
});
