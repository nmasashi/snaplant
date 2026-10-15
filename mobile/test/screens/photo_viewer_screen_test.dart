import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../helpers/app_test_helpers.dart';
import '../helpers/trip_test_helpers.dart';

// 写真ビューア（docs/travel-album/03_screen_design.md §4.6）。入口は旅行詳細の写真のグリッド

void main() {
  testWidgets('旅行詳細で写真をタップすると写真ビューアが開き、その写真の撮影日時と地名を出す', (tester) async {
    // サムネイルは撮影日時を読み上げ用ラベルとしてだけ持ち、Text は出さない。
    // よって find.text で見つかる撮影日時と地名は、ビューアが出したもの
    final semantics = tester.ensureSemantics();
    final tapped = photoJson(
        number: 2, tripId: hokkaidoTripId, takenAt: '2026-10-05T12:30:15')
      ..['location'] = {
        'latitude': 43.7706,
        'longitude': 142.365,
        'placeName': '北海道旭川市',
        'placeSource': 'device'
      };
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 3)],
      functionKey: 'test-key',
      photosByTripId: {
        hokkaidoTripId: [
          photoJson(
              number: 1,
              tripId: hokkaidoTripId,
              takenAt: '2026-10-06T10:15:00'),
          tapped,
          photoJson(
              number: 3,
              tripId: hokkaidoTripId,
              takenAt: '2026-10-07T18:45:00'),
        ],
      },
    );
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);

    await tester.tap(photoThumbnail('2026年10月5日 12:30'));
    await letFramesRun(tester);

    expect(find.text('北海道旭川市'), findsOneWidget);
    expect(find.text('2026年10月5日 12:30'), findsOneWidget);
    semantics.dispose();
  });

  testWidgets('写真ビューアで左にスワイプすると一覧の次の写真に、右にスワイプすると前の写真に移る', (tester) async {
    // 撮影日時はビューアだけが Text で出す（サムネイルは読み上げ用ラベルのみ）
    final semantics = tester.ensureSemantics();
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 3)],
      functionKey: 'test-key',
      photosByTripId: {
        hokkaidoTripId: [
          photoJson(
              number: 1,
              tripId: hokkaidoTripId,
              takenAt: '2026-10-06T10:15:00'),
          photoJson(
              number: 2,
              tripId: hokkaidoTripId,
              takenAt: '2026-10-05T12:30:15'),
          photoJson(
              number: 3,
              tripId: hokkaidoTripId,
              takenAt: '2026-10-07T18:45:00'),
        ],
      },
    );
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    await tester.tap(photoThumbnail('2026年10月5日 12:30'));
    await letFramesRun(tester);

    await tester.dragFrom(
        tester.getCenter(find.byType(Scaffold).last), const Offset(-800, 0));
    await letFramesRun(tester);

    expect(find.text('2026年10月7日 18:45').hitTestable(), findsOneWidget);
    expect(find.text('2026年10月5日 12:30').hitTestable(), findsNothing);

    await tester.dragFrom(
        tester.getCenter(find.byType(Scaffold).last), const Offset(800, 0));
    await letFramesRun(tester);
    await tester.dragFrom(
        tester.getCenter(find.byType(Scaffold).last), const Offset(800, 0));
    await letFramesRun(tester);

    expect(find.text('2026年10月6日 10:15').hitTestable(), findsOneWidget);
    expect(find.text('2026年10月7日 18:45').hitTestable(), findsNothing);
    semantics.dispose();
  });
}
