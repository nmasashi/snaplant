import 'dart:ui' show SemanticsFlag;

import 'package:flutter_test/flutter_test.dart';

import '../helpers/app_test_helpers.dart';
import '../helpers/trip_test_helpers.dart';

// 複数選択と、旅行への出し入れ・削除（docs/03_screen_design.md §4.8）を、利用者から見た振る舞いで確かめる。
// 旅行の API は偽のサーバ（helpers の FakeTripBackend）。アプリ全体を開いて旅行一覧から旅行詳細へ進む。
// この節のほかのテストは、まだ trip_detail_screen_test.dart にある（節ごとに分ける前からあるファイル）

void main() {
  testWidgets('選択モード中に下に引っ張って読み直すと、別の端末で消された写真は選択から外れ、選択モードのまま残りの写真は選んだままになり、削除の確認も残りの枚数で出る', (tester) async {
    // 選択中かどうかは、サムネイルの読み上げ用ラベルを持つ Semantics の「選択中」の状態で見る（枚数だけでは、どの写真が残ったかを取り違えても通る）
    final semantics = tester.ensureSemantics();
    bool selected(String label) => tester.getSemantics(photoThumbnail(label)).hasFlag(SemanticsFlag.isSelected);
    final backend = FakeTripBackend(
      trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 3)],
      photosByTripId: {
        hokkaidoTripId: [
          photoJson(number: 1, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:01:00'),
          photoJson(number: 2, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:02:00'),
          photoJson(number: 3, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:03:00'),
        ],
      },
    );
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    await tester.longPress(photoThumbnail('2026年10月5日 10:01'));
    await letFramesRun(tester);
    await tester.tap(photoThumbnail('2026年10月5日 10:02'));
    await letFramesRun(tester);
    expect(find.text('2枚を選択中'), findsOneWidget);
    // 別の端末で、選んでいた 10:02 の写真が消された
    backend.photosByTripId[hokkaidoTripId]!.removeAt(1);

    await tester.drag(photoGridScroll(), const Offset(0, 600));
    await letFramesRun(tester);

    expect(photoThumbnail('2026年10月5日 10:02'), findsNothing);
    expect(find.text('1枚を選択中'), findsOneWidget);
    expect([selected('2026年10月5日 10:01'), selected('2026年10月5日 10:03')], [true, false]);
    await tester.tap(find.text('削除'));
    await letFramesRun(tester);
    expect(find.text('1枚の写真を削除しますか？\nこの操作は元に戻せません。'), findsOneWidget);
    semantics.dispose();
  });
}
