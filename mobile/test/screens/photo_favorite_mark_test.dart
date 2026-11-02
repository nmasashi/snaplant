import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../helpers/app_test_helpers.dart';
import '../helpers/trip_test_helpers.dart';

// サムネイルのお気に入りの印（docs/03_screen_design.md §5.10.3。F-3。02 §5 #63）。
// 入口は旅行詳細の写真のグリッド（F-3）と、旅行詳細の「タイムライン」の完成版の場面・場面の写真の一覧・案の確認画面（F-4）

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

  // 印と読み上げは、お気に入りを扱う一覧（旅行詳細）だけ。同じ PhotoGrid でも、ほかの一覧には足さない（§5.10.3）
  testWidgets('旅行に属さない写真の画面の一覧では、お気に入りの写真にも印を出さず、読み上げにも足さない', (tester) async {
    final semantics = tester.ensureSemantics();
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 0)],
      functionKey: 'test-key',
      unassignedPhotoCount: 1,
      photosByTripId: {
        'none': [photoJson(number: 1, takenAt: '2026-09-01T10:15:00')..['favorite'] = true]
      },
    );
    await openTripsTab(tester, backend);
    await tester.tap(find.text('旅行に属さない写真'));
    await letFramesRun(tester);

    expect(find.bySemanticsLabel('2026年9月1日 10:15'), findsOneWidget);
    // サムネイルにも、画面のどこにもハートは出ない
    expect(_heartIn('2026年9月1日 10:15'), findsNothing);
    expect(find.byIcon(Icons.favorite), findsNothing);
    semantics.dispose();
  });

  testWidgets('図鑑の項目詳細の一覧では、お気に入りの写真にも印を出さず、読み上げにも足さない', (tester) async {
    final semantics = tester.ensureSemantics();
    final backend = FakeTripBackend(
      functionKey: 'test-key',
      catalogEntriesByKind: {
        'plant': [catalogEntryJson('plant', 'ソメイヨシノ', photoCount: 1)]
      },
      photosByTripId: {
        hokkaidoTripId: [
          identifiedPhotoJson(number: 1, kind: 'plant', name: 'ソメイヨシノ', tripId: hokkaidoTripId, takenAt: '2026-10-06T10:00:00')
            ..['favorite'] = true
        ]
      },
    );
    await openCatalogTab(tester, backend);
    await tester.tap(find.text('ソメイヨシノ'));
    await letFramesRun(tester);

    expect(find.bySemanticsLabel('2026年10月6日 10:00'), findsOneWidget);
    // サムネイルにも、画面のどこにもハートは出ない
    expect(_heartIn('2026年10月6日 10:00'), findsNothing);
    expect(find.byIcon(Icons.favorite), findsNothing);
    semantics.dispose();
  });

  testWidgets('タイムラインの完成版の場面と、場面の写真の一覧のサムネイルにも、お気に入りの印と読み上げの「、お気に入り」を出す', (tester) async {
    final semantics = tester.ensureSemantics();
    final photos = [
      timelinePhotoJson(1, '2026-10-05T07:50:00')..['favorite'] = true,
      timelinePhotoJson(2, '2026-10-05T08:00:00')..['favorite'] = false,
    ];
    final backend = FakeTripBackend(trips: [hokkaidoTrip(photoCount: 2)], functionKey: 'test-key', photosByTripId: {hokkaidoTripId: []});
    backend.timelinesByTripId[hokkaidoTripId] = timelineWithOneScene(photos);
    await openHokkaidoTimeline(tester, backend);

    // 完成版の場面
    expect(_heartIn('2026年10月5日 07:50、お気に入り'), findsOneWidget);
    expect(find.bySemanticsLabel('2026年10月5日 08:00'), findsOneWidget);
    expect(_heartIn('2026年10月5日 08:00'), findsNothing);

    // 場面の写真の一覧
    await tester.tap(find.text('朝の散歩'));
    await letFramesRun(tester);
    expect(_heartIn('2026年10月5日 07:50、お気に入り'), findsOneWidget);
    expect(find.bySemanticsLabel('2026年10月5日 08:00'), findsOneWidget);
    expect(_heartIn('2026年10月5日 08:00'), findsNothing);
    semantics.dispose();
  });

  testWidgets('タイムラインの案の確認画面のサムネイルには、お気に入りの写真にも印を出さず、読み上げにも足さない', (tester) async {
    final semantics = tester.ensureSemantics();
    final photo = timelinePhotoJson(1, '2026-10-05T07:50:00')..['favorite'] = true;
    final backend = FakeTripBackend(trips: [hokkaidoTrip(photoCount: 1)], functionKey: 'test-key', photosByTripId: {hokkaidoTripId: []});
    backend.timelinesByTripId[hokkaidoTripId] = {
      'current': null,
      'draft': {
        'id': '0b8e1c5a-0000-4000-8000-000000000099',
        'reason': 'create',
        'phase': 'reviewing',
        'job': null,
        'startedAt': '2026-10-25T09:00:00.000Z',
        'days': [
          {
            'date': '2026-10-05',
            'dayNumber': 1,
            'scenes': [timelineSceneJson([photo], startedBy: 'day')],
          },
        ],
      },
      'changes': null,
    };
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    await tester.tap(find.text('タイムライン'));
    await letFramesRun(tester);
    await tester.tap(find.text('案を確認する'));
    await letFramesRun(tester);

    expect(find.bySemanticsLabel('2026年10月5日 07:50'), findsOneWidget);
    expect(find.byIcon(Icons.favorite), findsNothing);
    semantics.dispose();
  });
}
