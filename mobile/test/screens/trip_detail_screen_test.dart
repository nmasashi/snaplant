import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:snaplant_mobile/screens/trip_detail_screen.dart';
import 'package:snaplant_mobile/services/api_service.dart';

import '../helpers/app_test_helpers.dart';
import '../helpers/trip_test_helpers.dart';

// 旅行詳細画面を単独で開き、利用者から見た振る舞いを確かめる（docs/travel-album/03_screen_design.md §4.3・§4.4）。
// 旅行の API は偽のサーバ（helpers の tripServer）で差し替える

const _tripId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

void main() {
  testWidgets('メニューの「編集」で旅行名とメモを今の値のまま編集ダイアログに出し、旅行名を変えて「保存」すると詳細のタイトルが新しい旅行名になる', (tester) async {
    final server = tripServer(
      [],
      unassignedPhotoCount: 0,
      tripDetails: {
        _tripId: tripJson(
          id: _tripId,
          name: '北海道 2026秋',
          description: 'ひとり旅',
          photoCount: 12,
          firstTakenAt: '2026-10-05T09:00:00',
          lastTakenAt: '2026-10-08T17:30:00',
        ),
      },
    );
    await openApp(
      tester,
      app: MaterialApp(
        home: TripDetailScreen(apiService: ApiService(client: server), tripId: _tripId),
      ),
    );
    await tester.tap(find.byIcon(Icons.more_vert));
    await letFramesRun(tester);
    await tester.tap(find.text('編集'));
    await letFramesRun(tester);
    // 作成ダイアログではなく編集ダイアログで、今の旅行名とメモが入っている
    final dialog = find.byType(Dialog);
    expect(find.descendant(of: dialog, matching: find.text('旅行を編集')), findsOneWidget);
    expect(find.descendant(of: dialog, matching: find.text('北海道 2026秋')), findsOneWidget);
    expect(find.descendant(of: dialog, matching: find.text('ひとり旅')), findsOneWidget);
    await tester.enterText(find.descendant(of: dialog, matching: find.byType(TextField)).first, '北海道 2026冬');

    await tester.tap(find.descendant(of: dialog, matching: find.text('保存')));
    await letFramesRun(tester);

    expect(find.byType(Dialog), findsNothing);
    expect(find.text('旅行を更新しました'), findsOneWidget);
    expect(find.descendant(of: find.byType(AppBar), matching: find.text('北海道 2026冬')), findsOneWidget);
  });
}
