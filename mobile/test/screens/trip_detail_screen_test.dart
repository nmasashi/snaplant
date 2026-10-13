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

/// 撮影日時 [label]（例 `2026年10月5日 12:30`）を読み上げ用ラベルに持つサムネイル。
/// 画像そのものはテスト環境で読み込めないので、どの写真かはこのラベルで見分ける。
/// ラベルに他の文言（画像の読み込み失敗の表示など）が続いていても一致するよう、部分一致で探す
Finder _thumbnail(String label) => find.bySemanticsLabel(RegExp(RegExp.escape(label)));

/// 「詳細を開く」ボタンだけのホーム画面から、[hokkaidoTripId] の旅行詳細を開く。
/// 詳細画面の前に画面がある状態にする（削除したら戻る先）
Future<void> openDetailFromHome(WidgetTester tester, FakeTripBackend backend) async {
  final apiService = ApiService(baseUrl: testApiEndpoint, client: backend.client, functionKey: _apiKey);
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
  testWidgets('旅行詳細を開くと、写真の一覧の1ページ目の読み込み中は「写真を読み込み中...」を出し、読み込めたらサーバが返す順にサムネイルを並べる', (tester) async {
    // サムネイルの画像は、テスト環境の HTTP が返さないので見えない。並びは、各サムネイルの読み上げ用ラベル（撮影日時）の位置で見る。
    // 並びがサーバの返す順そのものであることを見るため、撮影日時の順ではない並びで渡す（クライアントは並べ替えない）
    final semantics = tester.ensureSemantics();
    final release = Completer<void>();
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 3)],
      functionKey: _apiKey,
      photosByTripId: {
        hokkaidoTripId: [
          photoJson(number: 1, tripId: hokkaidoTripId, takenAt: '2026-10-06T10:15:00'),
          photoJson(number: 2, tripId: hokkaidoTripId, takenAt: '2026-10-05T12:30:15'),
          photoJson(number: 3, tripId: hokkaidoTripId, takenAt: '2026-10-07T18:45:00'),
        ],
      },
    );
    backend.holds[TripRoute.photos] = release.future;
    await openDetailFromHome(tester, backend);
    // 写真の応答を待っている間
    expect(find.text('写真を読み込み中...'), findsOneWidget);
    expect(_thumbnail('2026年10月6日 10:15'), findsNothing);

    release.complete();
    await letFramesRun(tester);

    expect(find.text('写真を読み込み中...'), findsNothing);
    final first = tester.getTopLeft(_thumbnail('2026年10月6日 10:15'));
    final second = tester.getTopLeft(_thumbnail('2026年10月5日 12:30'));
    final third = tester.getTopLeft(_thumbnail('2026年10月7日 18:45'));
    // 3列のグリッドの1行目に、返された順に左から並ぶ
    expect(second.dy, first.dy);
    expect(third.dy, first.dy);
    expect(first.dx, lessThan(second.dx));
    expect(second.dx, lessThan(third.dx));
    semantics.dispose();
  });

  testWidgets('写真が0枚の旅行を開くと、「まだ写真がありません」と「写真を追加」から送る案内を出し、読み込み中の表示は消える', (tester) async {
    // 旅行は存在し、写真が1枚も無い（404 ではなく photos: [] の応答。docs/travel-album/05_api_design.md §5.2）
    final backend = _backendWith([tripJson(id: hokkaidoTripId, name: '京都', photoCount: 0)]);

    await openDetailFromHome(tester, backend);

    expect(find.text('まだ写真がありません'), findsOneWidget);
    expect(find.text('「写真を追加」からギャラリーの写真を送りましょう'), findsOneWidget);
    expect(find.text('写真を読み込み中...'), findsNothing);
  });

  testWidgets('写真の一覧の取得に失敗すると、旅行の枚数・期間は出したまま写真の部分にエラーと「再試行」を出し、「再試行」で取り直すと写真が並ぶ', (tester) async {
    // 旅行の取得は成功し、写真の一覧の1回目だけが 503 で失敗する。2回目の成功で、取り直したかどうかを見分ける
    final semantics = tester.ensureSemantics();
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 1)],
      functionKey: _apiKey,
      photosByTripId: {
        hokkaidoTripId: [photoJson(number: 1, tripId: hokkaidoTripId, takenAt: '2026-10-05T12:30:15')],
      },
    );
    backend.failNext(TripRoute.photos);

    await openDetailFromHome(tester, backend);

    // 旅行の見出しはそのままで、写真の部分だけがエラーになる。写真と、読み込み中・0件の表示は出ていない
    expect(find.text('1枚 · 2026/10/05 〜 2026/10/08'), findsOneWidget);
    expect(find.text('エラーが発生しました'), findsOneWidget);
    expect(find.text('サービスに一時的に接続できません。しばらく待ってから再試行してください。'), findsOneWidget);
    expect(find.text('再試行'), findsOneWidget);
    expect(_thumbnail('2026年10月5日 12:30'), findsNothing);
    expect(find.text('写真を読み込み中...'), findsNothing);
    expect(find.text('まだ写真がありません'), findsNothing);

    await tester.tap(find.text('再試行'));
    await letFramesRun(tester);

    expect(_thumbnail('2026年10月5日 12:30'), findsOneWidget);
    expect(find.text('エラーが発生しました'), findsNothing);
    expect(find.text('1枚 · 2026/10/05 〜 2026/10/08'), findsOneWidget);
    semantics.dispose();
  });

  testWidgets('写真が1ページに収まらない旅行は、グリッドを下端まで送ると末尾に「読み込み中...」を出して次のページを取り、続きの写真を並べる', (tester) async {
    // サーバの1ページは30枚（偽のサーバの pageSize）。旅行の写真は33枚なので、続きは2ページ目の3枚（撮影日時の分 31〜33）。
    // 30枚（10行）は画面（約5行分）を超えるので、下端まで送らないと2ページ目は要らない
    final semantics = tester.ensureSemantics();
    final release = Completer<void>();
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 33)],
      functionKey: _apiKey,
      pageSize: 30,
      photosByTripId: {
        hokkaidoTripId: [
          for (var n = 1; n <= 33; n++)
            photoJson(number: n, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:${n.toString().padLeft(2, '0')}:00'),
        ],
      },
    );
    await openDetailFromHome(tester, backend);
    // 2ページ目の応答を止めておく（1ページ目は読み込み済み）
    backend.holds[TripRoute.photos] = release.future;

    await tester.drag(find.byType(GridView), const Offset(0, -5000));
    await letFramesRun(tester);

    // 次のページを読んでいる間。1ページ目の最後の写真が見え、続きはまだ無い
    expect(find.text('読み込み中...'), findsOneWidget);
    expect(_thumbnail('2026年10月5日 10:30'), findsOneWidget);
    expect(_thumbnail('2026年10月5日 10:31'), findsNothing);

    release.complete();
    await letFramesRun(tester);
    await tester.drag(find.byType(GridView), const Offset(0, -5000));
    await letFramesRun(tester);

    expect(find.text('読み込み中...'), findsNothing);
    expect(_thumbnail('2026年10月5日 10:31'), findsOneWidget);
    expect(_thumbnail('2026年10月5日 10:33'), findsOneWidget);
    semantics.dispose();
  });

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

  testWidgets('旅行を削除している間は、「キャンセル」や外のタップ、戻る操作でもダイアログは閉じず、応答が返れば前の画面に戻って知らせる', (tester) async {
    // 閉じられると、要求は送られたまま旅行がサーバで消えるのに、詳細画面が残って利用者は取り消したつもりになる
    final release = Completer<void>();
    final backend = _backendWith([hokkaidoTrip()]);
    backend.holds[TripRoute.delete] = release.future;
    await openDetailFromHome(tester, backend);
    await openDeleteDialog(tester);
    await tapInDialog(tester, '削除');

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

    expect(find.text('旅行を削除しました（写真12枚は「旅行に属さない写真」に移しました）'), findsOneWidget);
    expect(find.byType(Dialog), findsNothing);
    expect(find.byType(TripDetailScreen), findsNothing);
    expect(find.text('詳細を開く'), findsOneWidget);
  });

  testWidgets('編集を保存した後の取り直しで旅行が既に無い（404）と分かったときも、「この旅行は削除されています」と出し、編集・削除のメニューは出さない', (tester) async {
    final release = Completer<void>();
    final backend = _backendWith([hokkaidoTrip()]);
    await openDetailFromHome(tester, backend);
    await openEditDialog(tester);
    await enterTripName(tester, '北海道 2026冬');
    // 保存の応答の後の取り直しを止め、その間に別の端末で旅行が消された状態にする
    backend.holds[TripRoute.detail] = release.future;
    await tapInDialog(tester, '保存');
    backend.trips.clear();

    release.complete();
    await letFramesRun(tester);

    expect(find.text('この旅行は削除されています'), findsOneWidget);
    expect(find.byIcon(Icons.more_vert), findsNothing);
  });

  testWidgets('編集を保存した後の取り直しが 404 以外で失敗したときは、エラーと「再試行」を出し、編集・削除のメニューは出さない', (tester) async {
    final backend = _backendWith([hokkaidoTrip()]);
    await openDetailFromHome(tester, backend);
    await openEditDialog(tester);
    await enterTripName(tester, '北海道 2026冬');
    // 保存（PUT）は成功し、その後の取り直し（詳細の取得）だけが失敗する
    backend.failNext(TripRoute.detail);

    await tapInDialog(tester, '保存');

    expect(find.text('エラーが発生しました'), findsOneWidget);
    expect(find.text('サービスに一時的に接続できません。しばらく待ってから再試行してください。'), findsOneWidget);
    expect(find.text('再試行'), findsOneWidget);
    expect(find.byIcon(Icons.more_vert), findsNothing);
  });
}
