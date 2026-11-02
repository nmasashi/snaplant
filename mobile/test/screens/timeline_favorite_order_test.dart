import 'package:flutter_test/flutter_test.dart';

import '../helpers/app_test_helpers.dart';
import '../helpers/trip_test_helpers.dart';

// タイムラインのお気に入りの並び（docs/03_screen_design.md §5.10.4。F-4。02 §5 #63）。
// 入口は旅行詳細の「タイムライン」の完成版（§8.3）と、場面の写真の一覧（§8.8）

/// 場面の写真（[favorite] は API が今の写真から付ける印。05 §5.15）
Map<String, Object?> _photo(int number, String takenAt, {bool favorite = false}) =>
    timelinePhotoJson(number, takenAt)..['favorite'] = favorite;

/// 1枚目〜4枚目（07:50・08:00・08:10・08:20）のうち、3枚目と4枚目がお気に入りの場面「朝の散歩」だけの完成版
Map<String, Object?> _timeline() => timelineWithOneScene([
      _photo(1, '2026-10-05T07:50:00'),
      _photo(2, '2026-10-05T08:00:00'),
      _photo(3, '2026-10-05T08:10:00', favorite: true),
      _photo(4, '2026-10-05T08:20:00', favorite: true),
    ]);

/// 旅行詳細の「タイムライン」を開く
Future<void> _openTimeline(WidgetTester tester) async {
  final backend = FakeTripBackend(
    trips: [hokkaidoTrip(photoCount: 4)],
    functionKey: 'test-key',
    photosByTripId: {hokkaidoTripId: []},
  );
  backend.timelinesByTripId[hokkaidoTripId] = _timeline();
  await openHokkaidoTimeline(tester, backend);
}

/// 撮影日時の読み上げ用ラベル（お気に入りなら「、お気に入り」が付く）
String _label(String time, {bool favorite = false}) => '2026年10月5日 $time${favorite ? '、お気に入り' : ''}';

/// [labels] のサムネイルの左上の位置を、上から・左からの順に並べたときの並び
List<String> _orderOf(WidgetTester tester, List<String> labels) {
  final positions = {for (final label in labels) label: tester.getTopLeft(find.bySemanticsLabel(label))};
  return [...labels]..sort((a, b) {
      final pa = positions[a]!;
      final pb = positions[b]!;
      return pa.dy != pb.dy ? pa.dy.compareTo(pb.dy) : pa.dx.compareTo(pb.dx);
    });
}

void main() {
  testWidgets('完成版の場面では、お気に入りの写真を先に（大きい枠に）並べ、お気に入りどうし・それ以外どうしは撮影の順。時刻は撮影の順のまま', (tester) async {
    final semantics = tester.ensureSemantics();
    await _openTimeline(tester);

    final labels = [_label('07:50'), _label('08:00'), _label('08:10', favorite: true), _label('08:20', favorite: true)];
    expect(_orderOf(tester, labels), [_label('08:10', favorite: true), _label('08:20', favorite: true), _label('07:50'), _label('08:00')]);
    // 大きい枠（最初の2枚）はお気に入り
    expect(tester.getSize(find.bySemanticsLabel(_label('08:10', favorite: true))).width,
        greaterThan(tester.getSize(find.bySemanticsLabel(_label('07:50'))).width));
    // 始まりの時刻と終わりの時刻は、撮影の順で決めたまま
    expect(find.text('7:50'), findsOneWidget);
    expect(find.textContaining('〜8:20'), findsOneWidget);
    semantics.dispose();
  });

  testWidgets('場面の写真の一覧は、お気に入りがあっても撮影の順のまま並べる', (tester) async {
    final semantics = tester.ensureSemantics();
    await _openTimeline(tester);
    await tester.tap(find.text('朝の散歩'));
    await letFramesRun(tester);

    final labels = [_label('07:50'), _label('08:00'), _label('08:10', favorite: true), _label('08:20', favorite: true)];
    expect(_orderOf(tester, labels), labels);
    semantics.dispose();
  });
}
