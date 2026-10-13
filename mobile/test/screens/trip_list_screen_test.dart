import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/test/test_flutter_secure_storage_platform.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:snaplant_mobile/main.dart';

import '../helpers/app_test_helpers.dart';
import '../helpers/trip_test_helpers.dart';

// アプリ全体を開き、旅行タブの旅行一覧の利用者から見た振る舞いを確かめる
// （docs/travel-album/03_screen_design.md §3・§4.2〜§4.4）。
// 旅行の API は偽のサーバ（helpers の FakeTripBackend）で差し替える。偽のサーバは API キーを照合するので、
// 端末に保存したキー（ここでは FakeTripBackend の既定の 'saved-key'）で通信しているかも確かめられる。
// 図鑑タブの GET /api/plants は 404 になるが、図鑑タブは隠れていて、旅行タブの表示に影響しない

/// 端末に API キーを保存した状態でアプリを開き、旅行タブに切り替える
Future<void> openTripsTab(WidgetTester tester, FakeTripBackend backend) async {
  useSecureStorage(TestFlutterSecureStoragePlatform({'api_key': backend.functionKey}));
  SharedPreferences.setMockInitialValues({});
  await useDefaultEndpoint(tester);
  await openApp(tester, app: SnapPlantApp(httpClient: backend.client));
  await tester.tap(find.text('旅行'));
  await letFramesRun(tester);
}

/// 右下の「旅行を作る」ボタンから、旅行の作成ダイアログを開く
Future<void> openCreateDialog(WidgetTester tester) async {
  await tester.tap(find.byType(FloatingActionButton));
  await letFramesRun(tester);
}

void main() {
  testWidgets('旅行一覧には、先頭に「旅行に属さない写真」の枚数、その下にサーバが返す順で旅行の名前・枚数・撮影の期間が並ぶ', (tester) async {
    // 並べ替えていないことが分かるよう、名前の順でも枚数の順でもない順に返す。
    // 期間の3通り: 日をまたぐ範囲、同じ日、撮影日時のある写真が無い
    final backend = FakeTripBackend(trips: [
      hokkaidoTrip(),
      tripJson(
        id: '3f2504e0-4f89-41d3-9a0c-0305e82c3302',
        name: '大阪',
        photoCount: 3,
        firstTakenAt: '2026-09-20T10:00:00',
        lastTakenAt: '2026-09-20T18:00:00',
      ),
      tripJson(
        id: '3f2504e0-4f89-41d3-9a0c-0305e82c3303',
        name: '京都',
        photoCount: 0,
      ),
    ], unassignedPhotoCount: 8);

    await openTripsTab(tester, backend);

    expect(find.text('8枚'), findsOneWidget);
    expect(find.text('12枚 · 2026/10/05 〜 2026/10/08'), findsOneWidget);
    expect(find.text('3枚 · 2026/09/20'), findsOneWidget);
    expect(find.text('0枚 · 撮影日時なし'), findsOneWidget);
    final unassignedTop = tester.getTopLeft(find.text('旅行に属さない写真')).dy;
    final hokkaidoTop = tester.getTopLeft(find.text('北海道 2026秋')).dy;
    final osakaTop = tester.getTopLeft(find.text('大阪')).dy;
    final kyotoTop = tester.getTopLeft(find.text('京都')).dy;
    expect(unassignedTop, lessThan(hokkaidoTop));
    expect(hokkaidoTop, lessThan(osakaTop));
    expect(osakaTop, lessThan(kyotoTop));
  });

  testWidgets('旅行が1件もないときも「旅行に属さない写真」の行は出し、その下に最初の旅行を作るよう促す', (tester) async {
    final backend = FakeTripBackend(unassignedPhotoCount: 5);

    await openTripsTab(tester, backend);

    expect(find.text('旅行に属さない写真'), findsOneWidget);
    expect(find.text('5枚'), findsOneWidget);
    expect(find.text('まだ旅行がありません'), findsOneWidget);
    expect(find.text('「旅行を作る」から最初の旅行を作りましょう'), findsOneWidget);
    // 促す表示は先頭の行の下に出る
    expect(
      tester.getTopLeft(find.text('旅行に属さない写真')).dy,
      lessThan(tester.getTopLeft(find.text('まだ旅行がありません')).dy),
    );
  });

  testWidgets('旅行一覧の読み込みに失敗するとエラーと「再試行」を出し、「再試行」を押すと読み直して一覧を出す', (tester) async {
    // 1回目は 503、2回目は成功。再試行で読み直したかどうかを、2回目の成功で見分ける
    final backend = FakeTripBackend(trips: [hokkaidoTrip()], unassignedPhotoCount: 8);
    backend.failNext(TripRoute.list);
    await openTripsTab(tester, backend);
    // 失敗したときの表示。一覧は出ていない
    expect(find.text('エラーが発生しました'), findsOneWidget);
    expect(find.text('サービスに一時的に接続できません。しばらく待ってから再試行してください。'), findsOneWidget);
    expect(find.text('北海道 2026秋'), findsNothing);

    await tester.tap(find.text('再試行'));
    await letFramesRun(tester);

    expect(find.text('北海道 2026秋'), findsOneWidget);
    expect(find.text('8枚'), findsOneWidget);
    expect(find.text('エラーが発生しました'), findsNothing);
  });

  testWidgets('旅行を作るダイアログで旅行名が空白だけのまま「作成」を押すと、入力欄の下に注意を出し、旅行は作られない', (tester) async {
    // 送られたら成功して旅行が増える偽のサーバ。送られなかったことは、旅行が増えず、ダイアログが開いたままであることで見る
    final backend = FakeTripBackend();
    await openTripsTab(tester, backend);
    await openCreateDialog(tester);
    // 「旅行を作る」は一覧の案内文・ボタン・ダイアログの見出しに出るので、ダイアログの中に絞って見る
    expect(inDialog(find.text('旅行を作る')), findsOneWidget);
    await enterTripName(tester, '   ');

    await tapInDialog(tester, '作成');

    expect(inDialog(find.text('旅行名を入力してください')), findsOneWidget);
    expect(find.text('旅行を作成しました'), findsNothing);
    // 一覧には旅行が増えておらず、0件の案内のまま
    expect(find.text('まだ旅行がありません'), findsOneWidget);
  });

  testWidgets('旅行を作るダイアログで旅行名を入れて「作成」を押すと、ダイアログが閉じて「旅行を作成しました」と出て、一覧に新しい旅行が加わる', (tester) async {
    // 作った旅行は偽のサーバが覚え、読み直した一覧に載せる。最初の一覧は0件
    final backend = FakeTripBackend();
    await openTripsTab(tester, backend);
    await openCreateDialog(tester);
    await enterTripName(tester, '北海道 2026秋');

    await tapInDialog(tester, '作成');

    expect(find.byType(Dialog), findsNothing);
    expect(find.text('旅行を作成しました'), findsOneWidget);
    expect(find.text('北海道 2026秋'), findsOneWidget);
    expect(find.text('0枚 · 撮影日時なし'), findsOneWidget);
    expect(find.text('まだ旅行がありません'), findsNothing);
  });

  testWidgets('メモを入れて旅行を作ると、作った旅行の編集を開いたときにそのメモが入っている', (tester) async {
    final backend = FakeTripBackend();
    await openTripsTab(tester, backend);
    await openCreateDialog(tester);
    await enterTripName(tester, '北海道 2026秋');
    await enterTripMemo(tester, 'ひとり旅');
    await tapInDialog(tester, '作成');

    // 作った旅行を開いて、編集ダイアログを出す
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    await openEditDialog(tester);

    expect(inDialog(find.text('ひとり旅')), findsOneWidget);
  });

  testWidgets('旅行の作成にサーバが失敗を返すと、ダイアログは開いたまま旅行名が残り、エラーの文言を出す', (tester) async {
    // 400 の文言はサーバのものがそのまま画面に出る（ApiException.userMessage）
    final backend = FakeTripBackend();
    backend.failNext(TripRoute.create, status: 400, code: 'INVALID_REQUEST', message: '旅行名は100文字以内で指定してください');
    await openTripsTab(tester, backend);
    await openCreateDialog(tester);
    await enterTripName(tester, '北海道 2026秋');

    await tapInDialog(tester, '作成');

    expect(find.text('旅行名は100文字以内で指定してください'), findsOneWidget);
    expect(find.byType(Dialog), findsOneWidget);
    expect(inDialog(find.text('北海道 2026秋')), findsOneWidget);
    expect(find.text('旅行を作成しました'), findsNothing);
  });

  testWidgets('旅行の行をタップすると旅行詳細が開き、上部に旅行名、その下に取り直した枚数と撮影の期間を出す', (tester) async {
    final backend = FakeTripBackend(trips: [hokkaidoTrip(photoCount: 10)]);
    await openTripsTab(tester, backend);
    expect(find.text('10枚 · 2026/10/05 〜 2026/10/08'), findsOneWidget);
    // 一覧を読んだ後に、別の端末で写真が増えた。詳細が取り直していれば12枚が出る
    backend.trips.first['photoCount'] = 12;

    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);

    expect(find.descendant(of: find.byType(AppBar), matching: find.text('北海道 2026秋')), findsOneWidget);
    expect(find.text('12枚 · 2026/10/05 〜 2026/10/08'), findsOneWidget);
  });

  testWidgets('旅行詳細から一覧に戻ると一覧を読み直し、削除した旅行が消え、旅行に属さない写真の枚数が新しくなっている', (tester) async {
    final backend = FakeTripBackend(trips: [
      hokkaidoTrip(),
      tripJson(
        id: '3f2504e0-4f89-41d3-9a0c-0305e82c3302',
        name: '大阪',
        photoCount: 3,
        firstTakenAt: '2026-09-20T10:00:00',
        lastTakenAt: '2026-09-20T18:00:00',
      ),
    ], unassignedPhotoCount: 8);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    // 詳細で削除する（既定の「写真は残す」）。偽のサーバは、移った写真12枚を旅行に属さない写真に足す
    await openDeleteDialog(tester);

    await tapInDialog(tester, '削除');

    expect(find.text('北海道 2026秋'), findsNothing);
    expect(find.text('大阪'), findsOneWidget);
    expect(find.text('20枚'), findsOneWidget);
  });

  testWidgets('旅行一覧は、最初の読み込みが終わるまで「旅行一覧を読み込み中...」を出し、読み込めたら消して一覧を出す', (tester) async {
    // 応答を止めておき、読み込み中の状態を見る
    final release = Completer<void>();
    final backend = FakeTripBackend(unassignedPhotoCount: 8);
    backend.holds[TripRoute.list] = release.future;
    await openTripsTab(tester, backend);
    expect(find.text('旅行一覧を読み込み中...'), findsOneWidget);
    expect(find.text('旅行に属さない写真'), findsNothing);

    release.complete();
    await letFramesRun(tester);

    expect(find.text('旅行一覧を読み込み中...'), findsNothing);
    expect(find.text('旅行に属さない写真'), findsOneWidget);
  });

  testWidgets('旅行一覧を下に引っ張ると読み直し、別の端末で作られた旅行が出る', (tester) async {
    final backend = FakeTripBackend(trips: [
      tripJson(id: '3f2504e0-4f89-41d3-9a0c-0305e82c3302', name: '大阪', photoCount: 3),
    ]);
    await openTripsTab(tester, backend);
    expect(find.text('京都'), findsNothing);
    // 一覧を読んだ後に、別の端末で旅行が作られた
    backend.trips.insert(0, tripJson(id: '3f2504e0-4f89-41d3-9a0c-0305e82c3303', name: '京都', photoCount: 0));

    await tester.fling(find.text('旅行に属さない写真'), const Offset(0, 400), 1000);
    await letFramesRun(tester);

    expect(find.text('京都'), findsOneWidget);
    expect(find.text('大阪'), findsOneWidget);
  });

  testWidgets('旅行を作っている間は「作成」が「作成中...」になり、押し直しても旅行は二重に作られない', (tester) async {
    // 作成の応答を止めておき、作成中の状態を見る
    final release = Completer<void>();
    final backend = FakeTripBackend();
    backend.holds[TripRoute.create] = release.future;
    await openTripsTab(tester, backend);
    await openCreateDialog(tester);
    await enterTripName(tester, '北海道 2026秋');

    await tapInDialog(tester, '作成');

    expect(inDialog(find.text('作成中...')), findsOneWidget);
    expect(inDialog(find.text('作成')), findsNothing);

    // 作成中のボタンを押し直しても、応答が返った後に旅行が1つしか載らない
    await tester.tap(inDialog(find.text('作成中...')));
    release.complete();
    await letFramesRun(tester);

    expect(find.text('北海道 2026秋'), findsOneWidget);
  });

  testWidgets('旅行を作っている間は、「キャンセル」や外のタップ、戻る操作でもダイアログは閉じず、応答が返れば閉じて「旅行を作成しました」と出し、一覧に旅行が1つ載る', (tester) async {
    // 閉じられると、旅行は作られるのに一覧は読み直されず、利用者はもう一度作って同じ名前の旅行が2つできる
    final release = Completer<void>();
    final backend = FakeTripBackend();
    backend.holds[TripRoute.create] = release.future;
    await openTripsTab(tester, backend);
    await openCreateDialog(tester);
    await enterTripName(tester, '北海道 2026秋');
    await tapInDialog(tester, '作成');

    await tapInDialog(tester, 'キャンセル');
    expect(find.byType(Dialog), findsOneWidget);
    // ダイアログの外（画面の隅）のタップ
    await tester.tapAt(const Offset(5, 5));
    await letFramesRun(tester);
    expect(find.byType(Dialog), findsOneWidget);
    // 端末の戻る操作
    await tester.binding.handlePopRoute();
    await letFramesRun(tester);
    expect(find.byType(Dialog), findsOneWidget);

    release.complete();
    await letFramesRun(tester);

    expect(find.byType(Dialog), findsNothing);
    expect(find.text('旅行を作成しました'), findsOneWidget);
    expect(find.text('北海道 2026秋'), findsOneWidget);
  });

  testWidgets('一覧が出ているときの読み直しに失敗しても、一覧は残したままエラーの文言を出し、もう一度引っ張れば読み直せる', (tester) async {
    final backend = FakeTripBackend(trips: [
      tripJson(id: '3f2504e0-4f89-41d3-9a0c-0305e82c3302', name: '大阪', photoCount: 3),
    ]);
    await openTripsTab(tester, backend);
    // 次の読み直しだけ失敗させる（最初の読み込みは済んでいる）
    backend.failNext(TripRoute.list);

    await tester.fling(find.text('旅行に属さない写真'), const Offset(0, 400), 1000);
    await letFramesRun(tester);

    expect(find.text('サービスに一時的に接続できません。しばらく待ってから再試行してください。'), findsOneWidget);
    expect(find.text('大阪'), findsOneWidget);
    expect(find.text('エラーが発生しました'), findsNothing);

    // 一覧が残っているので、もう一度引っ張って読み直せる。その間に別の端末で旅行が作られた
    backend.trips.insert(0, tripJson(id: '3f2504e0-4f89-41d3-9a0c-0305e82c3303', name: '京都', photoCount: 0));
    await tester.fling(find.text('旅行に属さない写真'), const Offset(0, 400), 1000);
    await letFramesRun(tester);

    expect(find.text('京都'), findsOneWidget);
    expect(find.text('大阪'), findsOneWidget);
  });
}
