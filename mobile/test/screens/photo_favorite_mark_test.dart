import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../helpers/app_test_helpers.dart';
import '../helpers/trip_test_helpers.dart';

// サムネイルのお気に入りの印（docs/03_screen_design.md §5.10.3。F-3。02 §5 #63）。
// 入口は旅行詳細の写真のグリッド（タイムラインの場面・場面の写真の一覧の印は F-4）

/// [time] に撮った旅行「北海道」の写真
Map<String, Object?> _photo(int number, String time, {bool favorite = false, String state = 'done'}) =>
    photoJson(number: number, tripId: hokkaidoTripId, takenAt: '2026-10-06T$time:00')
      ..['category'] = 'food'
      ..['favorite'] = favorite
      ..['processing'] = {'state': state, 'step': 'classify', 'attempts': 1, 'lastError': null, 'updatedAt': '2026-10-18T03:00:00.000Z'};

/// サムネイルの読み上げ用ラベル
String _label(String time) => '2026年10月6日 $time';

/// 読み上げ用ラベルが [label] のサムネイルの中の、塗ったハート
Finder _heartIn(String label) => find.descendant(of: find.bySemanticsLabel(label), matching: find.byIcon(Icons.favorite));

void main() {
  testWidgets('旅行詳細のサムネイルで、お気に入りの写真には右上に塗ったハートを出し、読み上げに「、お気に入り」を足す（分類の印より前）', (tester) async {
    final semantics = tester.ensureSemantics();
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 3)],
      functionKey: 'test-key',
      photosByTripId: {
        hokkaidoTripId: [
          _photo(1, '10:00', favorite: true),
          _photo(2, '11:00'),
          _photo(3, '12:00', favorite: true, state: 'pending'),
        ]
      },
    );
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);

    expect(find.bySemanticsLabel('${_label('10:00')}、お気に入り'), findsOneWidget);
    expect(find.bySemanticsLabel(_label('11:00')), findsOneWidget);
    expect(find.bySemanticsLabel('${_label('12:00')}、お気に入り、分類中'), findsOneWidget);
    expect(_heartIn('${_label('10:00')}、お気に入り'), findsOneWidget);
    expect(_heartIn(_label('11:00')), findsNothing);
    // ハートは右上、砂時計は右下
    final tile = tester.getRect(find.bySemanticsLabel('${_label('12:00')}、お気に入り、分類中'));
    final heart = tester.getCenter(_heartIn('${_label('12:00')}、お気に入り、分類中'));
    final hourglass = tester.getCenter(find.descendant(
        of: find.bySemanticsLabel('${_label('12:00')}、お気に入り、分類中'), matching: find.byIcon(Icons.hourglass_empty)));
    expect(heart.dx, greaterThan(tile.center.dx));
    expect(heart.dy, lessThan(tile.center.dy));
    expect(hourglass.dy, greaterThan(tile.center.dy));
    semantics.dispose();
  });
}
