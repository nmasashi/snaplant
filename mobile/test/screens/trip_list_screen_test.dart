import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:snaplant_mobile/screens/trip_detail_screen.dart';

import '../helpers/app_test_helpers.dart';
import '../helpers/gallery_test_helpers.dart';
import '../helpers/trip_test_helpers.dart';

// アプリ全体を開き、旅行タブの旅行一覧の利用者から見た振る舞いを確かめる
// （docs/travel-album/03_screen_design.md §3・§4.2〜§4.4）。
// 旅行の API は偽のサーバ（helpers の FakeTripBackend）で差し替える。偽のサーバは API キーを照合するので、
// 端末に保存したキー（ここでは FakeTripBackend の既定の 'saved-key'）で通信しているかも確かめられる。
// 図鑑タブの GET /api/plants は 404 になるが、図鑑タブは隠れていて、旅行タブの表示に影響しない

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

  testWidgets('旅行一覧の上のバーには設定のボタンだけがあり、「カテゴリ」のボタンは無い（旅行をまたいで種類ごとに見るのは図鑑）',
      (tester) async {
    await openTripsTab(tester, FakeTripBackend(trips: [hokkaidoTrip()]));

    expect(find.byTooltip('設定'), findsOneWidget);
    expect(find.byTooltip('カテゴリ'), findsNothing);
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

  testWidgets('「旅行に属さない写真」の行をタップすると、その画面が開き、上部に見出しと枚数（期間は出さない）、その下に旅行に属さない写真が並び、編集・削除のメニューは出ない', (tester) async {
    // 旅行に属さない写真は GET /api/photos?tripId=none で取る（旅行の写真は混ざらない）。
    // 一覧が持っている枚数（3枚）を使う。写真の並びは、サムネイルの読み上げ用ラベル（撮影日時）で見る
    final semantics = tester.ensureSemantics();
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip()],
      unassignedPhotoCount: 3,
      photosByTripId: {
        'none': [
          photoJson(number: 1, takenAt: '2026-09-01T10:15:00'),
          photoJson(number: 2, takenAt: '2026-09-02T12:30:00'),
          photoJson(number: 3, takenAt: '2026-09-03T18:45:00'),
        ],
        hokkaidoTripId: [
          photoJson(number: 4, tripId: hokkaidoTripId, takenAt: '2026-10-05T11:11:00'),
        ],
      },
    );
    await openTripsTab(tester, backend);

    await tester.tap(find.text('旅行に属さない写真'));
    await letFramesRun(tester);

    expect(find.descendant(of: find.byType(AppBar), matching: find.text('旅行に属さない写真')), findsOneWidget);
    expect(find.text('3枚'), findsOneWidget);
    expect(find.textContaining('撮影日時なし'), findsNothing);
    expect(find.textContaining('·'), findsNothing);
    final first = tester.getTopLeft(photoThumbnail('2026年9月1日 10:15'));
    final second = tester.getTopLeft(photoThumbnail('2026年9月2日 12:30'));
    final third = tester.getTopLeft(photoThumbnail('2026年9月3日 18:45'));
    expect(first.dx, lessThan(second.dx));
    expect(second.dx, lessThan(third.dx));
    expect(photoThumbnail('2026年10月5日 11:11'), findsNothing);
    expect(find.byIcon(Icons.more_vert), findsNothing);
    semantics.dispose();
  });

  testWidgets('旅行に属さない写真が0枚のときは、その画面に「旅行に属さない写真はありません」と、あとから旅行に入れられるという案内を出す', (tester) async {
    final backend = FakeTripBackend(trips: [hokkaidoTrip()], unassignedPhotoCount: 0);
    await openTripsTab(tester, backend);

    await tester.tap(find.text('旅行に属さない写真'));
    await letFramesRun(tester);

    expect(find.text('0枚'), findsOneWidget);
    expect(find.text('旅行に属さない写真はありません'), findsOneWidget);
    expect(find.text('「写真を追加」で送った写真は、あとから旅行に入れられます'), findsOneWidget);
    // 旅行の写真の0件の案内とは文言が違う
    expect(find.text('まだ写真がありません'), findsNothing);
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

  testWidgets('旅行に属さない写真の画面から一覧に戻ると一覧を読み直し、枚数が新しくなっている', (tester) async {
    final backend =
        FakeTripBackend(trips: [hokkaidoTrip()], unassignedPhotoCount: 8);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('旅行に属さない写真'));
    await letFramesRun(tester);
    // 開いている間に、旅行に属さない写真が旅行へ移るなどして枚数が変わった
    backend.unassignedPhotoCount = 3;

    await tester.pageBack();
    await letFramesRun(tester);

    expect(find.text('3枚'), findsOneWidget);
    expect(find.text('8枚'), findsNothing);
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

  testWidgets('「旅行に属さない写真」の画面で写真を長押しすると、複数選択の操作は「旅行に入れる」と「削除」だけで、「旅行から外す」は出ない', (tester) async {
    final semantics = tester.ensureSemantics();
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip()],
      unassignedPhotoCount: 1,
      photosByTripId: {
        'none': [photoJson(number: 1, takenAt: '2026-09-01T10:15:00')],
      },
    );
    await openTripsTab(tester, backend);
    await tester.tap(find.text('旅行に属さない写真'));
    await letFramesRun(tester);

    await tester.longPress(photoThumbnail('2026年9月1日 10:15'));
    await letFramesRun(tester);

    expect(find.text('旅行に入れる'), findsOneWidget);
    expect(find.text('削除'), findsOneWidget);
    expect(find.text('旅行から外す'), findsNothing);
    semantics.dispose();
  });

  testWidgets('「旅行に属さない写真」の画面で2枚を選んで、すべての旅行から「京都」を選んで入れると、写真の一覧と見出しの枚数から消え、京都に入る', (tester) async {
    // 「旅行に入れる」の行き先は、すべての旅行（今いる旅行という除外が無い）。
    // 見出しの枚数は旅行一覧から受け取った値のままではなく、移したあとにサーバから取り直した値（偽のサーバが移した分を引く）になる
    final semantics = tester.ensureSemantics();
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(), tripJson(id: '3f2504e0-4f89-41d3-9a0c-0305e82c3302', name: '京都', photoCount: 0)],
      unassignedPhotoCount: 3,
      photosByTripId: {
        'none': [
          photoJson(number: 1, takenAt: '2026-09-01T10:15:00'),
          photoJson(number: 2, takenAt: '2026-09-02T12:30:00'),
          photoJson(number: 3, takenAt: '2026-09-03T18:45:00'),
        ],
      },
    );
    await openTripsTab(tester, backend);
    await tester.tap(find.text('旅行に属さない写真'));
    await letFramesRun(tester);
    expect(find.text('3枚'), findsOneWidget);
    await tester.longPress(photoThumbnail('2026年9月1日 10:15'));
    await letFramesRun(tester);
    await tester.tap(photoThumbnail('2026年9月2日 12:30'));
    await letFramesRun(tester);
    await tester.tap(find.text('旅行に入れる'));
    await letFramesRun(tester);
    expect(inDialog(find.textContaining('北海道')), findsOneWidget);
    expect(inDialog(find.textContaining('京都')), findsOneWidget);
    await tester.tap(inDialog(find.textContaining('京都')));
    await letFramesRun(tester);

    await tapInDialog(tester, '入れる');

    expect(find.text('2枚を「京都」に入れました'), findsOneWidget);
    expect(photoThumbnail('2026年9月1日 10:15'), findsNothing);
    expect(photoThumbnail('2026年9月2日 12:30'), findsNothing);
    expect(photoThumbnail('2026年9月3日 18:45'), findsOneWidget);
    expect(find.text('1枚'), findsOneWidget);
    expect(backend.photosByTripId['3f2504e0-4f89-41d3-9a0c-0305e82c3302']!.map((photo) => photo['takenAt']), ['2026-09-01T10:15:00', '2026-09-02T12:30:00']);
    semantics.dispose();
  });

  testWidgets('「旅行に属さない写真」の画面で写真を削除したあとの枚数の取り直しに失敗しても、「1枚を削除しました」と知らせて写真の一覧は読み直し、見出しの枚数は前の値のまま、失敗の知らせは足さない', (tester) async {
    // 削除では「旅行を選ぶ」が開かないので、旅行の一覧（GET /api/trips）は削除のあとの枚数の取り直しで初めて呼ばれる。
    // 確認ダイアログの「削除」を押す直前に、その1回目を 503 で失敗させる
    final semantics = tester.ensureSemantics();
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip()],
      unassignedPhotoCount: 3,
      photosByTripId: {
        'none': [
          photoJson(number: 1, takenAt: '2026-09-01T10:15:00'),
          photoJson(number: 2, takenAt: '2026-09-02T12:30:00'),
          photoJson(number: 3, takenAt: '2026-09-03T18:45:00'),
        ],
      },
    );
    await openTripsTab(tester, backend);
    await tester.tap(find.text('旅行に属さない写真'));
    await letFramesRun(tester);
    await tester.longPress(photoThumbnail('2026年9月1日 10:15'));
    await letFramesRun(tester);
    await tester.tap(find.text('削除'));
    await letFramesRun(tester);
    backend.failNext(TripRoute.list);

    await tapInDialog(tester, '削除');

    expect(find.text('1枚を削除しました'), findsOneWidget);
    expect(photoThumbnail('2026年9月1日 10:15'), findsNothing);
    expect(photoThumbnail('2026年9月2日 12:30'), findsOneWidget);
    expect(photoThumbnail('2026年9月3日 18:45'), findsOneWidget);
    expect(find.text('3枚'), findsOneWidget);
    expect(find.text('サービスに一時的に接続できません。しばらく待ってから再試行してください。'), findsNothing);
    semantics.dispose();
  });

  testWidgets('「旅行に属さない写真」の画面の「写真を追加」で1枚選ぶと、旅行を指定せずに送られ、「1枚を送信しました」と知らせて、写真の一覧と見出しの枚数に出る', (tester) async {
    // 偽のサーバは、旅行を指定せずに送られた写真を「旅行に属さない写真」（none）に入れ、その枚数を増やす。
    // 見出しの枚数は、送ったあとに旅行の一覧を取り直して分かる
    final image = writeTestImage('unassigned.png');
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [hokkaidoTrip()], unassignedPhotoCount: 0);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('旅行に属さない写真'));
    await letFramesRun(tester);
    expect(find.text('旅行に属さない写真はありません'), findsOneWidget);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, 'none');
    await letFramesRun(tester);

    expect(backend.photosByTripId['none']!.map((photo) => photo['id']), [tinyPngSha256]);
    expect(backend.photosByTripId['none']!.single['tripId'], isNull);
    expect(find.text('1枚を送信しました'), findsOneWidget);
    expect(find.text('1枚'), findsOneWidget);
    expect(find.text('旅行に属さない写真はありません'), findsNothing);
  });

  testWidgets('「旅行に属さない写真」の画面で2枚を送っている間は、画面の上部に「送信中 0/2」を出し、応答が返るとバナーを消して「2枚を送信しました」と知らせる', (tester) async {
    // 偽のサーバは、届いた2回の送信の応答をそれぞれ保留する。この画面は、旅行宛てでない項目だけを数える
    final first = writeTestImage('first.png');
    final second = writeTestImage('second.png', bytes: [...tinyPngBytes, 0]);
    useGalleryReturning([first, second]);
    final backend = FakeTripBackend(trips: [hokkaidoTrip()], unassignedPhotoCount: 0);
    final firstReply = backend.holdNextReply(TripRoute.upload);
    final secondReply = backend.holdNextReply(TripRoute.upload);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('旅行に属さない写真'));
    await letFramesRun(tester);
    expect(find.textContaining('送信中'), findsNothing);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, 'none', count: 2);
    await letFramesRun(tester);

    expect(backend.photosByTripId['none']!.length, 2);
    expect(find.text('送信中 0/2'), findsOneWidget);

    firstReply.complete();
    secondReply.complete();
    await letFramesRun(tester);

    expect(find.textContaining('送信中'), findsNothing);
    expect(find.text('2枚を送信しました'), findsOneWidget);
  });

  testWidgets('北海道宛ての写真を送っている間に「旅行に属さない写真」の画面を開いても、バナーは出ない（この画面は、旅行宛てでない分だけを数える）', (tester) async {
    // 旅行一覧は全体を数えるので、北海道宛ての送信中は一覧に「送信中 0/1」が出る。旅行に属さない写真の画面には、該当する項目が無いので出ない
    final image = writeTestImage('hokkaido.png');
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    final reply = backend.holdNextReply(TripRoute.upload);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, hokkaidoTripId);
    await letFramesRun(tester);
    await tester.pageBack();
    await letFramesRun(tester);
    expect(find.text('送信中 0/1'), findsOneWidget);

    await tester.tap(find.text('旅行に属さない写真'));
    await letFramesRun(tester);

    expect(find.text('旅行に属さない写真はありません'), findsOneWidget);
    expect(find.textContaining('送信中'), findsNothing);
    reply.complete();
    await letFramesRun(tester);
  });

  testWidgets('旅行一覧に戻っている間に送信が全部失敗しても、送れた写真が無いので旅行一覧は読み直さず、読み直しの失敗のエラーも出さない（バナーは「1枚を送信できませんでした」）', (tester) async {
    // 戻った時点の読み直しは済ませてから、旅行一覧の取得の失敗（503）を仕掛ける。読み直していれば、その失敗がスナックバーに出る。
    // 送信の応答は、解放したときに 500 の失敗で返す（失敗の指定は、解放したあとの応答で使われる）
    final image = writeTestImage('hokkaido.png');
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    final release = Completer<void>();
    backend.holds[TripRoute.upload] = release.future;
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 1);
    await letFramesRun(tester);
    await tester.pageBack();
    await letFramesRun(tester);
    expect(find.text('送信中 0/1'), findsOneWidget);
    backend.failNext(TripRoute.upload, status: 500, code: 'INTERNAL_ERROR', message: '写真の保存に失敗しました');
    backend.failNext(TripRoute.list);

    release.complete();
    await letFramesRun(tester);

    expect(find.text('1枚を送信できませんでした（$serverErrorMessage）'), findsOneWidget);
    expect(find.text('サービスに一時的に接続できません。しばらく待ってから再試行してください。'), findsNothing);
  });

  testWidgets('旅行一覧に戻っている間に、送った写真が全部別の旅行に送信済み（200）だったと分かっても、宛先の一覧は変わらないので旅行一覧は読み直さず、読み直しの失敗のエラーも出さない', (tester) async {
    // 戻った時点の読み直しは済ませてから、旅行一覧の取得の失敗（503）を仕掛ける。読み直していれば、その失敗がスナックバーに出る。
    // スナックバーは順に出る（送信の知らせが消えてから、あとの知らせが出る）ので、フェイクの時間を進めて、エラーの文言が出ないことを見る
    final alreadySent = writeTestImage('already_sent.png');
    useGalleryReturning([alreadySent]);
    final backend = FakeTripBackend(
      trips: [
        tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0),
        tripJson(id: kyotoTripId, name: '京都', photoCount: 1),
      ],
      photosByTripId: {
        kyotoTripId: [photoJson(number: 0, tripId: kyotoTripId)..['id'] = tinyPngSha256],
      },
    );
    final release = Completer<void>();
    backend.holds[TripRoute.upload] = release.future;
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 1);
    await letFramesRun(tester);
    await tester.pageBack();
    await letFramesRun(tester);
    expect(find.text('送信中 0/1'), findsOneWidget);
    backend.failNext(TripRoute.list);

    release.complete();
    await letFramesRun(tester);

    expect(find.text('1枚を送信しました（1枚は送信済みでした。別の旅行か、旅行に属さない写真にあります）'), findsOneWidget);
    await pumpUntilFound(tester, find.text('サービスに一時的に接続できません。しばらく待ってから再試行してください。'));
    expect(find.text('サービスに一時的に接続できません。しばらく待ってから再試行してください。'), findsNothing);
  });

  testWidgets('送信している間に旅行一覧へ戻っても送信は続き、旅行一覧の上部に全体の「送信中 0/2」を出し、応答が返ると「2枚を送信しました」と知らせて、一覧の北海道の枚数が「2枚」になる', (tester) async {
    // 送信は画面ではなくアプリの根が持つので、詳細を閉じても止まらない。
    // 偽のサーバは送信の応答を、解放されるまで返さない（写真は解放したときに入る）。一覧に戻った時点では、まだ0枚のまま。
    // 一覧が「2枚」になるのは、送信が一区切りついたときに一覧を読み直すから
    final first = writeTestImage('first.png');
    final second = writeTestImage('second.png', bytes: [...tinyPngBytes, 0]);
    useGalleryReturning([first, second]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    final release = Completer<void>();
    backend.holds[TripRoute.upload] = release.future;
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 2);
    await letFramesRun(tester);

    await tester.pageBack();
    await letFramesRun(tester);

    expect(find.byType(TripDetailScreen), findsNothing);
    expect(find.text('送信中 0/2'), findsOneWidget);
    expect(find.text('0枚 · 撮影日時なし'), findsOneWidget);

    release.complete();
    await letFramesRun(tester);

    expect(find.textContaining('送信中'), findsNothing);
    expect(find.text('2枚を送信しました'), findsOneWidget);
    expect(find.text('2枚 · 撮影日時なし'), findsOneWidget);
  });
}
