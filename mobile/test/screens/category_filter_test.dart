import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../helpers/app_test_helpers.dart';
import '../helpers/trip_test_helpers.dart';

// カテゴリでの絞り込み（docs/travel-album/03_screen_design.md §5.2・§5.3。段階3）。
// 入口は旅行詳細のチップと、旅行一覧の「カテゴリ」から開くカテゴリの写真の画面

/// 分類が済んだ写真。[time] は 2026年10月6日のその時刻（サムネイルの読み上げ用ラベルで見分ける）
Map<String, Object?> _photo(
        int number, String? tripId, String? category, String time) =>
    photoJson(number: number, tripId: tripId, takenAt: '2026-10-06T$time:00')
      ..['category'] = category
      ..['processing'] = {
        'state': category == null ? 'none' : 'done',
        'step': category == null ? null : 'classify',
        'attempts': category == null ? 0 : 1,
        'lastError': null,
        'updatedAt': '2026-10-18T03:00:00.000Z'
      };

/// サムネイルの読み上げ用ラベル（撮影日時）
String _label(String time) => '2026年10月6日 $time';

/// 旅行「北海道」に、食べ物（10:00）・風景（11:00）・分類前（12:00）の3枚
List<Map<String, Object?>> _hokkaidoPhotos() => [
      _photo(1, hokkaidoTripId, 'food', '10:00'),
      _photo(2, hokkaidoTripId, 'landscape', '11:00'),
      _photo(3, hokkaidoTripId, null, '12:00'),
    ];

/// 旅行詳細を開く
Future<FakeTripBackend> _openTripDetail(WidgetTester tester) async {
  final backend = FakeTripBackend(
    trips: [hokkaidoTrip(photoCount: 3)],
    functionKey: 'test-key',
    photosByTripId: {hokkaidoTripId: _hokkaidoPhotos()},
  );
  await openTripsTab(tester, backend);
  await tester.tap(find.text('北海道 2026秋'));
  await letFramesRun(tester);
  return backend;
}

/// 出ているサムネイルの撮影日時（読み上げ用ラベル）を、[times] のそれぞれについて出ているかで返す
List<bool> _shown(List<String> times) => [
      for (final time in times)
        find.bySemanticsLabel(_label(time)).evaluate().isNotEmpty
    ];

/// カテゴリのチップ
Finder _chip(String label) => find.widgetWithText(ChoiceChip, label);

void main() {
  group('旅行詳細のカテゴリの絞り込み', () {
    testWidgets('旅行詳細にカテゴリのチップを出し、既定の「すべて」では全部の写真を並べる', (tester) async {
      final semantics = tester.ensureSemantics();
      await _openTripDetail(tester);

      for (final label in ['すべて', '植物', '食べ物', '風景', 'その他']) {
        expect(_chip(label), findsOneWidget);
      }
      expect(tester.widget<ChoiceChip>(_chip('すべて')).selected, isTrue);
      expect(_shown(['10:00', '11:00', '12:00']), [true, true, true]);
      semantics.dispose();
    });

    testWidgets('チップで「食べ物」を選ぶと、その旅行の食べ物の写真だけを並べ、「すべて」に戻すと全部を並べる',
        (tester) async {
      final semantics = tester.ensureSemantics();
      await _openTripDetail(tester);

      await tester.tap(_chip('食べ物'));
      await letFramesRun(tester);
      expect(_shown(['10:00', '11:00', '12:00']), [true, false, false]);
      // 選べるのは1つだけ（§5.3）
      expect(tester.widget<ChoiceChip>(_chip('食べ物')).selected, isTrue);
      expect(tester.widget<ChoiceChip>(_chip('すべて')).selected, isFalse);

      await tester.tap(_chip('すべて'));
      await letFramesRun(tester);
      expect(_shown(['10:00', '11:00', '12:00']), [true, true, true]);
      semantics.dispose();
    });

    testWidgets('絞り込んだ結果が0枚なら「この旅行に植物の写真はありません」と出す', (tester) async {
      await _openTripDetail(tester);

      await tester.tap(_chip('植物'));
      await letFramesRun(tester);

      expect(find.text('この旅行に植物の写真はありません'), findsOneWidget);
    });

    testWidgets('絞り込んでも、見出しの枚数は旅行全体のまま', (tester) async {
      await _openTripDetail(tester);

      await tester.tap(_chip('食べ物'));
      await letFramesRun(tester);

      // 枚数も期間も旅行全体のまま（§5.3）
      expect(find.text('3枚 · 2026/10/05 〜 2026/10/08'), findsOneWidget);
    });

    testWidgets('絞り込んでいる間は、続きのページも下に引っ張っての読み直しも、同じカテゴリで読む', (tester) async {
      // 継続トークンは同じ絞り込みにだけ有効（05 §5.2）。1ページ目は食べ物 30 枚、続きに食べ物 1 枚。
      // 風景を前後に置き、絞り込みを落とした読み方ならどちらかが並ぶようにする
      final semantics = tester.ensureSemantics();
      final photos = [
        _photo(39, hokkaidoTripId, 'landscape', '09:00'),
        for (var n = 1; n <= 31; n++)
          _photo(
              n, hokkaidoTripId, 'food', '10:${n.toString().padLeft(2, '0')}'),
        _photo(40, hokkaidoTripId, 'landscape', '11:00'),
      ]..sort(
          (a, b) => (a['sortAt'] as String).compareTo(b['sortAt'] as String));
      final backend = FakeTripBackend(
        trips: [hokkaidoTrip(photoCount: 33)],
        functionKey: 'test-key',
        pageSize: 30,
        photosByTripId: {hokkaidoTripId: photos},
      );
      await openTripsTab(tester, backend);
      await tester.tap(find.text('北海道 2026秋'));
      await letFramesRun(tester);
      await tester.tap(_chip('食べ物'));
      await letFramesRun(tester);

      await tester.drag(find.byType(GridView), const Offset(0, -5000));
      await letFramesRun(tester);
      expect(_shown(['10:31', '09:00', '11:00']), [true, false, false]);

      await tester.drag(find.byType(GridView), const Offset(0, 5000));
      await letFramesRun(tester);
      await tester.drag(find.byType(GridView), const Offset(0, 300));
      await letFramesRun(tester);
      expect(_shown(['10:01', '09:00']), [true, false]);
      semantics.dispose();
    });

    testWidgets('旅行詳細を開き直すと「すべて」に戻る', (tester) async {
      final semantics = tester.ensureSemantics();
      await _openTripDetail(tester);
      await tester.tap(_chip('食べ物'));
      await letFramesRun(tester);

      await tester.pageBack();
      await letFramesRun(tester);
      await tester.tap(find.text('北海道 2026秋'));
      await letFramesRun(tester);

      expect(tester.widget<ChoiceChip>(_chip('すべて')).selected, isTrue);
      expect(_shown(['10:00', '11:00', '12:00']), [true, true, true]);
      semantics.dispose();
    });

    testWidgets('絞り込んだまま複数選択でき、選択モードの間はチップを出さない', (tester) async {
      final semantics = tester.ensureSemantics();
      await _openTripDetail(tester);
      await tester.tap(_chip('食べ物'));
      await letFramesRun(tester);

      await tester.longPress(photoThumbnail(_label('10:00')));
      await letFramesRun(tester);

      expect(find.text('1枚を選択中'), findsOneWidget);
      expect(_chip('すべて'), findsNothing);
      // 選択モードに入っても、絞り込んだまま（全部の写真に戻らない）
      expect(_shown(['10:00', '11:00', '12:00']), [true, false, false]);
      semantics.dispose();
    });
  });

  group('カテゴリ横断画面', () {
    /// 北海道と京都と、どの旅行にも属さない写真に、食べ物とそれ以外を混ぜた偽のサーバ
    FakeTripBackend acrossTrips() => FakeTripBackend(
          trips: [
            hokkaidoTrip(photoCount: 2),
            tripJson(id: kyotoTripId, name: '京都 2026冬', photoCount: 1),
          ],
          functionKey: 'test-key',
          unassignedPhotoCount: 1,
          photosByTripId: {
            hokkaidoTripId: [
              _photo(1, hokkaidoTripId, 'food', '10:00'),
              _photo(2, hokkaidoTripId, 'landscape', '11:00'),
            ],
            kyotoTripId: [_photo(3, kyotoTripId, 'food', '12:00')],
            'none': [_photo(4, null, 'food', '13:00')],
          },
        );

    /// 旅行一覧の「カテゴリ」から、[label] のカテゴリの写真の画面を開く
    Future<void> openCategory(
        WidgetTester tester, FakeTripBackend backend, String label) async {
      await openTripsTab(tester, backend);
      await tester.tap(find.byTooltip('カテゴリ'));
      await letFramesRun(tester);
      await tester.tap(find.text(label));
      await letFramesRun(tester);
    }

    testWidgets('旅行一覧の「カテゴリ」から開く一覧に、植物・食べ物・風景・その他を並べる', (tester) async {
      await openTripsTab(tester, acrossTrips());

      await tester.tap(find.byTooltip('カテゴリ'));
      await letFramesRun(tester);

      for (final label in ['植物', '食べ物', '風景', 'その他']) {
        expect(find.text(label), findsOneWidget);
      }
    });

    testWidgets('「食べ物」を選ぶと、旅行をまたいで（旅行に属さない写真も）食べ物の写真だけを並べる', (tester) async {
      final semantics = tester.ensureSemantics();
      await openCategory(tester, acrossTrips(), '食べ物');

      expect(find.widgetWithText(AppBar, '食べ物'), findsOneWidget);
      expect(_shown(['10:00', '11:00', '12:00', '13:00']),
          [true, false, true, true]);
      semantics.dispose();
    });

    testWidgets('写真ビューアから戻ると、一覧を読み直す（開いている間に増えた写真も出る）', (tester) async {
      final semantics = tester.ensureSemantics();
      final backend = acrossTrips();
      await openCategory(tester, backend, '食べ物');
      await tester.tap(photoThumbnail(_label('10:00')));
      await letFramesRun(tester);
      backend.photosByTripId[kyotoTripId]!
          .add(_photo(5, kyotoTripId, 'food', '14:00'));

      await tester.pageBack();
      await letFramesRun(tester);

      expect(photoThumbnail(_label('14:00')), findsOneWidget);
      semantics.dispose();
    });

    testWidgets('そのカテゴリの写真が無ければ案内を出し、「写真を追加」は置かない', (tester) async {
      await openCategory(tester, acrossTrips(), '植物');

      expect(find.text('植物の写真はありません'), findsOneWidget);
      expect(find.text('分類が済んだ写真が、ここに並びます'), findsOneWidget);
      expect(find.text('写真を追加'), findsNothing);
    });

    testWidgets('カテゴリの写真の複数選択の操作は「削除」だけ', (tester) async {
      await openCategory(tester, acrossTrips(), '食べ物');

      await tester.longPress(photoThumbnail(_label('10:00')));
      await letFramesRun(tester);

      expect(find.text('削除'), findsOneWidget);
      expect(find.text('旅行に入れる'), findsNothing);
      expect(find.text('旅行から外す'), findsNothing);
    });

    testWidgets('カテゴリの画面で写真を消してから旅行一覧へ戻ると、旅行の枚数を読み直している', (tester) async {
      // 旅行詳細・旅行に属さない写真の画面から戻ったときと同じ（消すと旅行の枚数・期間・表紙が変わる）
      final backend = acrossTrips();
      await openCategory(tester, backend, '食べ物');
      await tester.longPress(photoThumbnail(_label('12:00')));
      await letFramesRun(tester);
      await tester.tap(find.text('削除'));
      await letFramesRun(tester);
      await tapInDialog(tester, '削除');

      await tester.pageBack();
      await letFramesRun(tester);
      await tester.pageBack();
      await letFramesRun(tester);

      expect(find.textContaining('京都 2026冬'), findsOneWidget);
      expect(find.textContaining('0枚'), findsOneWidget);
    });

    testWidgets('選んだ写真を削除できる', (tester) async {
      final semantics = tester.ensureSemantics();
      final backend = acrossTrips();
      await openCategory(tester, backend, '食べ物');
      await tester.longPress(photoThumbnail(_label('12:00')));
      await letFramesRun(tester);

      await tester.tap(find.text('削除'));
      await letFramesRun(tester);
      await tapInDialog(tester, '削除');

      expect(backend.photosByTripId[kyotoTripId], isEmpty);
      expect(_shown(['10:00', '12:00', '13:00']), [true, false, true]);
      semantics.dispose();
    });
  });
}
