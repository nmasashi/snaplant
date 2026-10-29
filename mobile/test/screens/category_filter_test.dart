import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../helpers/app_test_helpers.dart';
import '../helpers/trip_test_helpers.dart';

// カテゴリでの絞り込み（docs/03_screen_design.md §5.3。段階3）。
// 入口は旅行詳細のチップ（旅行をまたぐカテゴリ横断画面は 2026-10-24 に消した。§5.2）

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

      for (final label in ['すべて', '植物', '食べ物', '風景']) {
        expect(_chip(label), findsOneWidget);
      }
      // 「その他」のチップは置かない（その写真は「すべて」で見える。02 §5 #33）
      expect(_chip('その他'), findsNothing);
      expect(tester.widget<ChoiceChip>(_chip('すべて')).selected, isTrue);
      expect(_shown(['10:00', '11:00', '12:00']), [true, true, true]);
      semantics.dispose();
    });

    testWidgets('チップで「食べ物」を選ぶと、その旅行の食べ物の写真だけを並べて見出しの枚数は旅行全体のままにし、0枚のカテゴリなら「この旅行に植物の写真はありません」と出し、「すべて」に戻すと全部を並べる',
        (tester) async {
      final semantics = tester.ensureSemantics();
      await _openTripDetail(tester);

      await tester.tap(_chip('食べ物'));
      await letFramesRun(tester);
      expect(_shown(['10:00', '11:00', '12:00']), [true, false, false]);
      // 選べるのは1つだけ（§5.3）
      expect(tester.widget<ChoiceChip>(_chip('食べ物')).selected, isTrue);
      expect(tester.widget<ChoiceChip>(_chip('すべて')).selected, isFalse);
      // 枚数も期間も旅行全体のまま（§5.3）
      expect(find.text('3枚 · 2026/10/05 〜 2026/10/08'), findsOneWidget);

      await tester.tap(_chip('植物'));
      await letFramesRun(tester);
      expect(find.text('この旅行に植物の写真はありません'), findsOneWidget);

      await tester.tap(_chip('すべて'));
      await letFramesRun(tester);
      expect(_shown(['10:00', '11:00', '12:00']), [true, true, true]);
      semantics.dispose();
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

      await tester.drag(photoGridScroll(), const Offset(0, -5000));
      await letFramesRun(tester);
      expect(_shown(['10:31', '09:00', '11:00']), [true, false, false]);

      await tester.drag(photoGridScroll(), const Offset(0, 5000));
      await letFramesRun(tester);
      await tester.drag(photoGridScroll(), const Offset(0, 300));
      await letFramesRun(tester);
      expect(_shown(['10:01', '09:00']), [true, false]);
      semantics.dispose();
    });

    testWidgets('旅行詳細を開き直すと「すべて」に戻る', (tester) async {
      final semantics = tester.ensureSemantics();
      await _openTripDetail(tester);
      await tester.tap(_chip('食べ物'));
      await letFramesRun(tester);

      await tapBack(tester);
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
}
