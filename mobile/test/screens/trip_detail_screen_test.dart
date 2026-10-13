import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:snaplant_mobile/screens/trip_detail_screen.dart';
import 'package:snaplant_mobile/services/api_service.dart';

import '../helpers/app_test_helpers.dart';
import '../helpers/trip_test_helpers.dart';

// 旅行詳細画面を開き、利用者から見た振る舞いを確かめる（docs/travel-album/03_screen_design.md §4.3・§4.4）。
// 旅行の API は偽のサーバ（helpers の FakeTripBackend）で差し替える。
// 偽のサーバは API キーを照合するので、画面に渡す ApiService には同じキーを持たせる

const _apiKey = 'test-key';

FakeTripBackend _backendWith(List<Map<String, Object?>> trips) => FakeTripBackend(trips: trips, functionKey: _apiKey);

/// 「詳細を開く」ボタンだけのホーム画面から、[hokkaidoTripId] の旅行詳細を開く。
/// 詳細画面の前に画面がある状態にする（削除したら戻る先）
Future<void> openDetailFromHome(WidgetTester tester, FakeTripBackend backend) async {
  final apiService = ApiService(client: backend.client, functionKey: _apiKey);
  await openApp(
    tester,
    app: MaterialApp(
      home: Builder(
        builder: (context) => Scaffold(
          body: Center(
            child: ElevatedButton(
              onPressed: () => Navigator.push(
                context,
                MaterialPageRoute(builder: (_) => TripDetailScreen(apiService: apiService, tripId: hokkaidoTripId)),
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
    final backend = _backendWith([hokkaidoTrip(description: 'ひとり旅')]);
    await openDetailFromHome(tester, backend);
    await openEditDialog(tester);
    // 作成ダイアログではなく編集ダイアログで、今の旅行名とメモが入っている
    expect(inDialog(find.text('旅行を編集')), findsOneWidget);
    expect(inDialog(find.text('北海道 2026秋')), findsOneWidget);
    expect(inDialog(find.text('ひとり旅')), findsOneWidget);
    await enterTripName(tester, '北海道 2026冬');

    await tapInDialog(tester, '保存');

    expect(find.byType(Dialog), findsNothing);
    expect(find.text('旅行を更新しました'), findsOneWidget);
    expect(find.descendant(of: find.byType(AppBar), matching: find.text('北海道 2026冬')), findsOneWidget);
  });

  testWidgets('旅行名だけを変えて保存しても、メモは消えずに残る', (tester) async {
    // 更新は全体置き換え（メモを送らないと消える）。保存し直した後に編集を開き直して、メモが入っていることで見る
    final backend = _backendWith([hokkaidoTrip(description: 'ひとり旅')]);
    await openDetailFromHome(tester, backend);
    await openEditDialog(tester);
    await enterTripName(tester, '北海道 2026冬');
    await tapInDialog(tester, '保存');

    await openEditDialog(tester);

    expect(inDialog(find.text('北海道 2026冬')), findsOneWidget);
    expect(inDialog(find.text('ひとり旅')), findsOneWidget);
  });

  testWidgets('メニューの「削除」で写真12枚の扱いを選ぶ確認が出て、既定の「写真は残す」のまま削除すると、写真が旅行に属さない写真へ移ったと知らせて前の画面に戻る', (tester) async {
    final backend = _backendWith([hokkaidoTrip()]);
    await openDetailFromHome(tester, backend);
    await openDeleteDialog(tester);
    // 写真の扱いを選ぶ確認。補足の文言も出ている
    expect(inDialog(find.text('旅行を削除')), findsOneWidget);
    expect(inDialog(find.textContaining('「北海道 2026秋」を削除します。')), findsOneWidget);
    expect(inDialog(find.textContaining('中の写真12枚はどうしますか？')), findsOneWidget);
    expect(inDialog(find.text('写真は残す')), findsOneWidget);
    expect(inDialog(find.textContaining('「旅行に属さない写真」に移ります')), findsOneWidget);
    expect(inDialog(find.text('写真も削除する')), findsOneWidget);
    expect(inDialog(find.textContaining('この操作は元に戻せません')), findsOneWidget);

    // 選択を変えずに削除する。何を送ったかは、偽のサーバが返す枚数（移した数）から現れる知らせで分かる
    await tapInDialog(tester, '削除');

    expect(find.text('旅行を削除しました（写真12枚は「旅行に属さない写真」に移しました）'), findsOneWidget);
    expect(find.byType(Dialog), findsNothing);
    expect(find.byType(TripDetailScreen), findsNothing);
    expect(find.text('詳細を開く'), findsOneWidget);
  });

  testWidgets('削除の確認で「写真も削除する」を選んで削除すると、写真12枚を削除したと知らせて前の画面に戻る', (tester) async {
    final backend = _backendWith([hokkaidoTrip()]);
    await openDetailFromHome(tester, backend);
    await openDeleteDialog(tester);
    await tapInDialog(tester, '写真も削除する');

    // 何を送ったかは、偽のサーバが返す枚数（消した数）から現れる知らせで分かる
    await tapInDialog(tester, '削除');

    expect(find.text('旅行を削除しました（写真12枚を削除）'), findsOneWidget);
    expect(find.byType(Dialog), findsNothing);
    expect(find.byType(TripDetailScreen), findsNothing);
    expect(find.text('詳細を開く'), findsOneWidget);
  });

  testWidgets('写真が0枚の旅行を削除するときは写真の扱いを選ばせず、確認だけして削除でき、前の画面に戻る', (tester) async {
    final backend = _backendWith([tripJson(id: hokkaidoTripId, name: '京都', photoCount: 0)]);
    await openDetailFromHome(tester, backend);
    await openDeleteDialog(tester);
    expect(inDialog(find.textContaining('「京都」を削除しますか？')), findsOneWidget);
    expect(inDialog(find.text('写真は残す')), findsNothing);
    expect(inDialog(find.text('写真も削除する')), findsNothing);

    await tapInDialog(tester, '削除');

    expect(find.text('旅行を削除しました'), findsOneWidget);
    expect(find.byType(Dialog), findsNothing);
    expect(find.byType(TripDetailScreen), findsNothing);
    expect(find.text('詳細を開く'), findsOneWidget);
    // 写真が0枚だと応答は true でも false でも同じ。API が必須にしている deletePhotos を、残す側（false）で載せたことは要求で確かめる
    expect(backend.deletePhotosSent, ['false']);
  });

  testWidgets('旅行の削除にサーバが失敗を返すと、確認ダイアログは開いたままで詳細も閉じず、エラーの文言を出す', (tester) async {
    final backend = _backendWith([hokkaidoTrip()]);
    backend.failNext(TripRoute.delete);
    await openDetailFromHome(tester, backend);
    await openDeleteDialog(tester);

    await tapInDialog(tester, '削除');

    expect(find.text('サービスに一時的に接続できません。しばらく待ってから再試行してください。'), findsOneWidget);
    expect(find.byType(Dialog), findsOneWidget);
    expect(find.byType(TripDetailScreen), findsOneWidget);
    expect(find.textContaining('旅行を削除しました'), findsNothing);
  });

  testWidgets('削除しようとした旅行が既に無い（404）ときは、削除できたときと同じく前の画面に戻り、「旅行を削除しました」と知らせる', (tester) async {
    final backend = _backendWith([hokkaidoTrip()]);
    await openDetailFromHome(tester, backend);
    // 詳細を開いた後に、別の端末で旅行が消された
    backend.trips.clear();
    await openDeleteDialog(tester);

    await tapInDialog(tester, '削除');

    // 消したか移したかの枚数は分からないので、括弧書きは付けない
    expect(find.text('旅行を削除しました'), findsOneWidget);
    expect(find.byType(Dialog), findsNothing);
    expect(find.byType(TripDetailScreen), findsNothing);
    expect(find.text('詳細を開く'), findsOneWidget);
  });

  testWidgets('開こうとした旅行が既に無い（404）ときは、「この旅行は削除されています」と出し、編集・削除のメニューは出さない', (tester) async {
    // 一覧を読んだ後に別の端末で消された旅行（偽のサーバに無い）
    final backend = _backendWith([]);

    await openDetailFromHome(tester, backend);

    expect(find.text('この旅行は削除されています'), findsOneWidget);
    expect(find.byIcon(Icons.more_vert), findsNothing);
  });

  testWidgets('旅行詳細の取得に失敗するとエラーと「再試行」を出し、「再試行」で取り直すと旅行名と枚数・期間が出る', (tester) async {
    // 1回目は 503、2回目は成功。再試行で取り直したかどうかを、2回目の成功で見分ける
    final backend = _backendWith([hokkaidoTrip()]);
    backend.failNext(TripRoute.detail);
    await openDetailFromHome(tester, backend);
    // 失敗したときの表示。旅行の中身とメニューは出ていない
    expect(find.text('エラーが発生しました'), findsOneWidget);
    expect(find.text('サービスに一時的に接続できません。しばらく待ってから再試行してください。'), findsOneWidget);
    expect(find.text('12枚 · 2026/10/05 〜 2026/10/08'), findsNothing);
    expect(find.byIcon(Icons.more_vert), findsNothing);

    await tester.tap(find.text('再試行'));
    await letFramesRun(tester);

    expect(find.descendant(of: find.byType(AppBar), matching: find.text('北海道 2026秋')), findsOneWidget);
    expect(find.text('12枚 · 2026/10/05 〜 2026/10/08'), findsOneWidget);
    expect(find.text('エラーが発生しました'), findsNothing);
  });

  testWidgets('旅行を削除している間は「削除」が「削除中...」になり、押し直しても削除の要求は二重に送られない', (tester) async {
    // 削除の応答を止めておき、削除中の状態を見る
    final release = Completer<void>();
    final backend = _backendWith([hokkaidoTrip()]);
    backend.holds[TripRoute.delete] = release.future;
    await openDetailFromHome(tester, backend);
    await openDeleteDialog(tester);

    await tapInDialog(tester, '削除');

    expect(inDialog(find.text('削除中...')), findsOneWidget);
    expect(inDialog(find.text('削除')), findsNothing);

    // 削除中のボタンを押し直しても、削除の要求は1回しか送られない。
    // 2回目の削除は 404（成功扱い）になって結果からは見分けられないので、送られた要求の件数で見る
    await tester.tap(inDialog(find.text('削除中...')));
    release.complete();
    await letFramesRun(tester);

    expect(backend.deletePhotosSent, ['false']);
  });
}
