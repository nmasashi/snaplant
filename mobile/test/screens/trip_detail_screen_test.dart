import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:snaplant_mobile/screens/trip_detail_screen.dart';
import 'package:snaplant_mobile/services/api_service.dart';

import '../helpers/app_test_helpers.dart';
import '../helpers/trip_test_helpers.dart';

// 旅行詳細画面を単独で開き、利用者から見た振る舞いを確かめる（docs/travel-album/03_screen_design.md §4.3・§4.4）。
// 旅行の API は偽のサーバ（helpers の tripServer）で差し替える

const _tripId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

/// 「詳細を開く」ボタンだけのホーム画面から、[_tripId] の旅行詳細を開く。
/// 詳細画面の前に画面がある状態にする（削除したら戻る先）
Future<void> openDetailFromHome(WidgetTester tester, ApiService apiService) async {
  await openApp(
    tester,
    app: MaterialApp(
      home: Builder(
        builder: (context) => Scaffold(
          body: Center(
            child: ElevatedButton(
              onPressed: () => Navigator.push(
                context,
                MaterialPageRoute(builder: (_) => TripDetailScreen(apiService: apiService, tripId: _tripId)),
              ),
              child: const Text('詳細を開く'),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('詳細を開く'));
  await letFramesRun(tester);
}

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

  testWidgets('メニューの「削除」で写真12枚の扱いを選ぶ確認が出て、既定の「写真は残す」のまま削除すると、写真が旅行に属さない写真へ移ったと知らせて前の画面に戻る', (tester) async {
    final server = tripServer(
      [],
      unassignedPhotoCount: 0,
      tripDetails: {
        _tripId: tripJson(
          id: _tripId,
          name: '北海道 2026秋',
          photoCount: 12,
          firstTakenAt: '2026-10-05T09:00:00',
          lastTakenAt: '2026-10-08T17:30:00',
        ),
      },
    );
    await openDetailFromHome(tester, ApiService(client: server));
    await tester.tap(find.byIcon(Icons.more_vert));
    await letFramesRun(tester);
    await tester.tap(find.text('削除'));
    await letFramesRun(tester);
    // 写真の扱いを選ぶ確認。補足の文言も出ている
    final dialog = find.byType(Dialog);
    expect(find.descendant(of: dialog, matching: find.text('旅行を削除')), findsOneWidget);
    expect(find.descendant(of: dialog, matching: find.textContaining('「北海道 2026秋」を削除します。')), findsOneWidget);
    expect(find.descendant(of: dialog, matching: find.textContaining('中の写真12枚はどうしますか？')), findsOneWidget);
    expect(find.descendant(of: dialog, matching: find.text('写真は残す')), findsOneWidget);
    expect(find.descendant(of: dialog, matching: find.textContaining('「旅行に属さない写真」に移ります')), findsOneWidget);
    expect(find.descendant(of: dialog, matching: find.text('写真も削除する')), findsOneWidget);
    expect(find.descendant(of: dialog, matching: find.textContaining('この操作は元に戻せません')), findsOneWidget);

    // 選択を変えずに削除する。何を送ったかは、偽のサーバが返す枚数（移した数）から現れる知らせで分かる
    await tester.tap(find.descendant(of: dialog, matching: find.text('削除')));
    await letFramesRun(tester);

    expect(find.text('旅行を削除しました（写真12枚は「旅行に属さない写真」に移しました）'), findsOneWidget);
    expect(find.byType(Dialog), findsNothing);
    expect(find.byType(TripDetailScreen), findsNothing);
    expect(find.text('詳細を開く'), findsOneWidget);
  });

  testWidgets('削除の確認で「写真も削除する」を選んで削除すると、写真12枚を削除したと知らせて前の画面に戻る', (tester) async {
    final server = tripServer(
      [],
      unassignedPhotoCount: 0,
      tripDetails: {
        _tripId: tripJson(
          id: _tripId,
          name: '北海道 2026秋',
          photoCount: 12,
          firstTakenAt: '2026-10-05T09:00:00',
          lastTakenAt: '2026-10-08T17:30:00',
        ),
      },
    );
    await openDetailFromHome(tester, ApiService(client: server));
    await tester.tap(find.byIcon(Icons.more_vert));
    await letFramesRun(tester);
    await tester.tap(find.text('削除'));
    await letFramesRun(tester);
    final dialog = find.byType(Dialog);
    await tester.tap(find.descendant(of: dialog, matching: find.text('写真も削除する')));
    await letFramesRun(tester);

    // 何を送ったかは、偽のサーバが返す枚数（消した数）から現れる知らせで分かる
    await tester.tap(find.descendant(of: dialog, matching: find.text('削除')));
    await letFramesRun(tester);

    expect(find.text('旅行を削除しました（写真12枚を削除）'), findsOneWidget);
    expect(find.byType(Dialog), findsNothing);
    expect(find.byType(TripDetailScreen), findsNothing);
    expect(find.text('詳細を開く'), findsOneWidget);
  });

  testWidgets('写真が0枚の旅行を削除するときは写真の扱いを選ばせず、確認だけして削除でき、前の画面に戻る', (tester) async {
    final deletePhotosSent = <String?>[];
    final server = tripServer(
      [],
      unassignedPhotoCount: 0,
      deletePhotosSent: deletePhotosSent,
      tripDetails: {
        _tripId: tripJson(id: _tripId, name: '京都', photoCount: 0),
      },
    );
    await openDetailFromHome(tester, ApiService(client: server));
    await tester.tap(find.byIcon(Icons.more_vert));
    await letFramesRun(tester);
    await tester.tap(find.text('削除'));
    await letFramesRun(tester);
    final dialog = find.byType(Dialog);
    expect(find.descendant(of: dialog, matching: find.textContaining('「京都」を削除しますか？')), findsOneWidget);
    expect(find.descendant(of: dialog, matching: find.text('写真は残す')), findsNothing);
    expect(find.descendant(of: dialog, matching: find.text('写真も削除する')), findsNothing);

    await tester.tap(find.descendant(of: dialog, matching: find.text('削除')));
    await letFramesRun(tester);

    expect(find.text('旅行を削除しました'), findsOneWidget);
    expect(find.byType(Dialog), findsNothing);
    expect(find.byType(TripDetailScreen), findsNothing);
    expect(find.text('詳細を開く'), findsOneWidget);
    // 写真が0枚だと応答は true でも false でも同じ。API が必須にしている deletePhotos を、残す側（false）で載せたことは要求で確かめる
    expect(deletePhotosSent, ['false']);
  });

  testWidgets('旅行の削除にサーバが失敗を返すと、確認ダイアログは開いたままで詳細も閉じず、エラーの文言を出す', (tester) async {
    final server = tripServer(
      [],
      unassignedPhotoCount: 0,
      failDelete: true,
      tripDetails: {
        _tripId: tripJson(
          id: _tripId,
          name: '北海道 2026秋',
          photoCount: 12,
          firstTakenAt: '2026-10-05T09:00:00',
          lastTakenAt: '2026-10-08T17:30:00',
        ),
      },
    );
    await openDetailFromHome(tester, ApiService(client: server));
    await tester.tap(find.byIcon(Icons.more_vert));
    await letFramesRun(tester);
    await tester.tap(find.text('削除'));
    await letFramesRun(tester);
    final dialog = find.byType(Dialog);

    await tester.tap(find.descendant(of: dialog, matching: find.text('削除')));
    await letFramesRun(tester);

    expect(find.text('サービスに一時的に接続できません。しばらく待ってから再試行してください。'), findsOneWidget);
    expect(find.byType(Dialog), findsOneWidget);
    expect(find.byType(TripDetailScreen), findsOneWidget);
    expect(find.textContaining('旅行を削除しました'), findsNothing);
  });

  testWidgets('削除しようとした旅行が既に無い（404）ときは、削除できたときと同じく前の画面に戻り、「旅行を削除しました」と知らせる', (tester) async {
    final server = tripServer(
      [],
      unassignedPhotoCount: 0,
      deleteTripNotFound: true,
      tripDetails: {
        _tripId: tripJson(
          id: _tripId,
          name: '北海道 2026秋',
          photoCount: 12,
          firstTakenAt: '2026-10-05T09:00:00',
          lastTakenAt: '2026-10-08T17:30:00',
        ),
      },
    );
    await openDetailFromHome(tester, ApiService(client: server));
    await tester.tap(find.byIcon(Icons.more_vert));
    await letFramesRun(tester);
    await tester.tap(find.text('削除'));
    await letFramesRun(tester);
    final dialog = find.byType(Dialog);

    await tester.tap(find.descendant(of: dialog, matching: find.text('削除')));
    await letFramesRun(tester);

    // 消したか移したかの枚数は分からないので、括弧書きは付けない
    expect(find.text('旅行を削除しました'), findsOneWidget);
    expect(find.byType(Dialog), findsNothing);
    expect(find.byType(TripDetailScreen), findsNothing);
    expect(find.text('詳細を開く'), findsOneWidget);
  });
}
