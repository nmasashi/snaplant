import 'dart:async';
import 'dart:ui' show SemanticsFlag;

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

/// 旅行「京都」の id（写真の移し先に使う）
const kyotoTripId = '3f2504e0-4f89-41d3-9a0c-0305e82c3302';

FakeTripBackend _backendWith(List<Map<String, Object?>> trips) => FakeTripBackend(trips: trips, functionKey: _apiKey);

/// 旅行の写真が33枚（撮影日時は 2026-10-05 の 10:01〜10:33、この順）の偽のサーバ。サーバの1ページは30枚。
/// 30枚（10行）は画面（約5行分）を超えるので、2ページ目は下端まで送ったときにだけ要る。2ページ目は3枚
FakeTripBackend _backendWith33Photos() {
  return FakeTripBackend(
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
}

/// 写真のグリッドを下端まで送り、画面を進める
Future<void> _scrollToEnd(WidgetTester tester) async {
  await tester.drag(find.byType(GridView), const Offset(0, -5000));
  await letFramesRun(tester);
}

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
    expect(photoThumbnail('2026年10月6日 10:15'), findsNothing);

    release.complete();
    await letFramesRun(tester);

    expect(find.text('写真を読み込み中...'), findsNothing);
    final first = tester.getTopLeft(photoThumbnail('2026年10月6日 10:15'));
    final second = tester.getTopLeft(photoThumbnail('2026年10月5日 12:30'));
    final third = tester.getTopLeft(photoThumbnail('2026年10月7日 18:45'));
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
    expect(photoThumbnail('2026年10月5日 12:30'), findsNothing);
    expect(find.text('写真を読み込み中...'), findsNothing);
    expect(find.text('まだ写真がありません'), findsNothing);

    await tester.tap(find.text('再試行'));
    await letFramesRun(tester);

    expect(photoThumbnail('2026年10月5日 12:30'), findsOneWidget);
    expect(find.text('エラーが発生しました'), findsNothing);
    expect(find.text('1枚 · 2026/10/05 〜 2026/10/08'), findsOneWidget);
    semantics.dispose();
  });

  testWidgets('写真が1ページに収まらない旅行は、グリッドを下端まで送ると末尾に「読み込み中...」を出して次のページを取り、続きの写真を並べる', (tester) async {
    // 30枚（10行）は画面（約5行分）を超えるので、下端まで送らないと2ページ目は要らない
    final semantics = tester.ensureSemantics();
    final release = Completer<void>();
    final backend = _backendWith33Photos();
    await openDetailFromHome(tester, backend);
    // 2ページ目の応答を止めておく（1ページ目は読み込み済み）
    backend.holds[TripRoute.photos] = release.future;

    await _scrollToEnd(tester);

    // 次のページを読んでいる間。1ページ目の最後の写真が見え、続きはまだ無い
    expect(find.text('読み込み中...'), findsOneWidget);
    expect(photoThumbnail('2026年10月5日 10:30'), findsOneWidget);
    expect(photoThumbnail('2026年10月5日 10:31'), findsNothing);

    release.complete();
    await letFramesRun(tester);
    await _scrollToEnd(tester);

    expect(find.text('読み込み中...'), findsNothing);
    expect(photoThumbnail('2026年10月5日 10:31'), findsOneWidget);
    expect(photoThumbnail('2026年10月5日 10:33'), findsOneWidget);
    semantics.dispose();
  });

  testWidgets('次のページの取得に失敗すると、1ページ目の写真は残したまま末尾に「続きを読み込めませんでした」と「再試行」を出し、「再試行」で取り直すと続きの写真が並ぶ', (tester) async {
    // 2ページ目の要求だけを 503 で1回失敗させる。
    // 自動で取り直されれば2回目で成功してエラーが消えるので、自動の再試行をしないことも、失敗の表示が残ることで見る
    final semantics = tester.ensureSemantics();
    final backend = _backendWith33Photos();
    await openDetailFromHome(tester, backend);
    backend.failNext(TripRoute.photos);

    await _scrollToEnd(tester);

    // 失敗した後。1ページ目の写真は残り、続きは無い。読み込み中ではない
    expect(find.text('続きを読み込めませんでした'), findsOneWidget);
    expect(find.text('再試行'), findsOneWidget);
    expect(find.text('読み込み中...'), findsNothing);
    expect(find.text('エラーが発生しました'), findsNothing);
    expect(photoThumbnail('2026年10月5日 10:30'), findsOneWidget);
    expect(photoThumbnail('2026年10月5日 10:31'), findsNothing);

    await tester.tap(find.text('再試行'));
    await letFramesRun(tester);
    await _scrollToEnd(tester);

    expect(find.text('続きを読み込めませんでした'), findsNothing);
    expect(find.text('再試行'), findsNothing);
    expect(photoThumbnail('2026年10月5日 10:31'), findsOneWidget);
    expect(photoThumbnail('2026年10月5日 10:33'), findsOneWidget);
    semantics.dispose();
  });

  testWidgets('1ページ目だけ読んだところでグリッドを下に引っ張ると、続きからではなく先頭のページから読み直し、別の端末で増えた写真が出る', (tester) async {
    // 1ページ目を読んだ時点で、続きのトークンは残っている。
    // そのトークンで読み直すと、先頭ではなく2ページ目（元の写真の10:30 から）が返り、増えた写真は出ない
    final semantics = tester.ensureSemantics();
    final backend = _backendWith33Photos();
    await openDetailFromHome(tester, backend);
    expect(photoThumbnail('2026年10月5日 10:00'), findsNothing);
    // 別の端末で、撮影日時が一番早い写真が1枚増えた
    backend.photosByTripId[hokkaidoTripId]!
        .insert(0, photoJson(number: 100, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:00:00'));

    await tester.drag(find.byType(GridView), const Offset(0, 600));
    await letFramesRun(tester);

    expect(photoThumbnail('2026年10月5日 10:00'), findsOneWidget);
    expect(photoThumbnail('2026年10月5日 10:01'), findsOneWidget);
    semantics.dispose();
  });

  testWidgets('2ページ目まで読んだあとに引っ張って読み直すと、読み直した1ページ目の続きを、もう一度「読み込み中...」を出して読み、古い続きは残らない', (tester) async {
    // 2ページ目まで読んだ時点では、続きのトークンは無い（最後のページ）。
    // 読み直した先頭のページには続きがあるので、読み直しでトークンを更新していなければ続きを読まず、写真が欠ける。
    // 古い2ページ目を残したまま読み直せば、先頭に増えた写真が並ばない
    final semantics = tester.ensureSemantics();
    final release = Completer<void>();
    final backend = _backendWith33Photos();
    await openDetailFromHome(tester, backend);
    await _scrollToEnd(tester);
    await _scrollToEnd(tester);
    expect(photoThumbnail('2026年10月5日 10:33'), findsOneWidget);
    // 別の端末で、撮影日時が一番早い写真が1枚増えた。読み直すと先頭のページは「増えた1枚 + 元の先頭29枚」になる
    backend.photosByTripId[hokkaidoTripId]!
        .insert(0, photoJson(number: 100, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:00:00'));
    // 先頭まで戻ってから、下に引っ張る（引っ張って読み直せるのは先頭にいるときだけ）
    await tester.drag(find.byType(GridView), const Offset(0, 5000));
    await letFramesRun(tester);
    await tester.drag(find.byType(GridView), const Offset(0, 600));
    await letFramesRun(tester);
    expect(photoThumbnail('2026年10月5日 10:00'), findsOneWidget);
    expect(photoThumbnail('2026年10月5日 10:01'), findsOneWidget);
    backend.holds[TripRoute.photos] = release.future;

    await _scrollToEnd(tester);

    expect(find.text('読み込み中...'), findsOneWidget);
    release.complete();
    await letFramesRun(tester);
    await _scrollToEnd(tester);
    expect(find.text('読み込み中...'), findsNothing);
    expect(photoThumbnail('2026年10月5日 10:30'), findsOneWidget);
    expect(photoThumbnail('2026年10月5日 10:33'), findsOneWidget);
    semantics.dispose();
  });

  testWidgets('続きの取得が遅れている間に引っ張って読み直したあと、遅れていた古い続きが届いても、読み直した1ページ目には足されず、続きは読み直した先頭から正しく並ぶ', (tester) async {
    // 続きの要求（2ページ目。元の写真の10:31〜10:33）を止めている間に、別の端末で写真が1枚増え、引っ張って読み直す。
    // 読み直した先頭は「増えた1枚 + 元の先頭29枚」で、本当の続きは元の10:30 から。
    // 遅れていた古い続きを足してしまうと、10:30 が抜け、続きのトークンも古い応答のもの（最後のページ）になって取りに行かない
    final semantics = tester.ensureSemantics();
    final backend = _backendWith33Photos();
    await openDetailFromHome(tester, backend);
    final release = backend.holdNextReply(TripRoute.photos);
    await _scrollToEnd(tester);
    expect(find.text('読み込み中...'), findsOneWidget);
    backend.photosByTripId[hokkaidoTripId]!
        .insert(0, photoJson(number: 100, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:00:00'));
    await tester.drag(find.byType(GridView), const Offset(0, 5000));
    await letFramesRun(tester);
    await tester.drag(find.byType(GridView), const Offset(0, 600));
    await letFramesRun(tester);
    expect(photoThumbnail('2026年10月5日 10:00'), findsOneWidget);

    release.complete();
    await letFramesRun(tester);
    await _scrollToEnd(tester);
    await _scrollToEnd(tester);

    expect(photoThumbnail('2026年10月5日 10:30'), findsOneWidget);
    expect(photoThumbnail('2026年10月5日 10:31'), findsOneWidget);
    expect(photoThumbnail('2026年10月5日 10:33'), findsOneWidget);
    expect(find.text('読み込み中...'), findsNothing);
    semantics.dispose();
  });

  testWidgets('1ページ目が空でも続きのトークンが付いていれば、「まだ写真がありません」を出さず、続きを読んで写真を並べる', (tester) async {
    // サーバは空のページを何度か読み直しても空のとき、空のページを続きのトークン付きで返すことがある（写真がある旅行でも起きる）
    final semantics = tester.ensureSemantics();
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 3)],
      functionKey: _apiKey,
      leadingEmptyPages: 1,
      photosByTripId: {
        hokkaidoTripId: [
          photoJson(number: 1, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:01:00'),
          photoJson(number: 2, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:02:00'),
          photoJson(number: 3, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:03:00'),
        ],
      },
    );

    await openDetailFromHome(tester, backend);

    expect(photoThumbnail('2026年10月5日 10:01'), findsOneWidget);
    expect(photoThumbnail('2026年10月5日 10:03'), findsOneWidget);
    expect(find.text('まだ写真がありません'), findsNothing);
    semantics.dispose();
  });

  testWidgets('空のページが続けて3回返ったら、自動で読むのをやめて「続きを読み込めませんでした」と「再試行」を出し、「再試行」で続きから読むと写真が並ぶ', (tester) async {
    // サーバが空のページを続きのトークン付きで返し続けたとき、要求を止めずに送り続けない。
    // 偽のサーバは空のページを5回返してから写真を返す。3回で止めていれば、写真はまだ出ていない。
    // 止めずに読み続けていれば、写真が並んでしまうので、止めたことは写真が出ていないことで見る。
    // 「再試行」の後は、また最大3回まで読む(空のページの数を数え直す)ので、残りの2回の空のページを越えて写真が並ぶ
    final semantics = tester.ensureSemantics();
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 2)],
      functionKey: _apiKey,
      leadingEmptyPages: 5,
      photosByTripId: {
        hokkaidoTripId: [
          photoJson(number: 1, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:01:00'),
          photoJson(number: 2, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:02:00'),
        ],
      },
    );

    await openDetailFromHome(tester, backend);

    expect(find.text('続きを読み込めませんでした'), findsOneWidget);
    expect(find.text('再試行'), findsOneWidget);
    expect(photoThumbnail('2026年10月5日 10:01'), findsNothing);
    // 写真が無いと確定したわけではないので、0枚の案内は出さない
    expect(find.text('まだ写真がありません'), findsNothing);

    await tester.tap(find.text('再試行'));
    await letFramesRun(tester);

    expect(photoThumbnail('2026年10月5日 10:01'), findsOneWidget);
    expect(photoThumbnail('2026年10月5日 10:02'), findsOneWidget);
    expect(find.text('続きを読み込めませんでした'), findsNothing);
    semantics.dispose();
  });

  testWidgets('1ページ目のエラーの表示で、引っ張る読み直しと「再試行」が重なったとき、先に終わった読み直しで出た写真を、遅れて届いた「再試行」の失敗の応答で消さない', (tester) async {
    // 1ページ目の取得に失敗してエラーの表示になる。引っ張った読み直し（応答を止める）の間に「再試行」を押し、
    // 先に読み直しの応答が成功して写真が並んだあとで、遅れて「再試行」の失敗の応答が届く。
    // 古くなった読み込み（「再試行」）の結果は捨てるので、写真はそのまま残り、エラーの表示には戻らない
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
    expect(find.text('エラーが発生しました'), findsOneWidget);
    // 引っ張った読み直しの応答を止めておく
    final pullReply = backend.holdNextReply(TripRoute.photos);
    await tester.drag(find.text('エラーが発生しました'), const Offset(0, 600));
    await letFramesRun(tester);
    // 引っ張っている間に「再試行」を押す。その応答は失敗で、止めておく
    backend.failNext(TripRoute.photos);
    final retryReply = backend.holdNextReply(TripRoute.photos);
    await tester.tap(find.text('再試行'));
    await letFramesRun(tester);
    // 先に、引っ張った読み直しの応答が届いて、写真が並ぶ
    pullReply.complete();
    await letFramesRun(tester);
    expect(photoThumbnail('2026年10月5日 12:30'), findsOneWidget);

    retryReply.complete();
    await letFramesRun(tester);

    expect(photoThumbnail('2026年10月5日 12:30'), findsOneWidget);
    expect(find.text('エラーが発生しました'), findsNothing);
    semantics.dispose();
  });

  testWidgets('写真が0枚の案内を出しているときも、下に引っ張ると読み直し、別の端末で増えた写真が並んで案内は消える', (tester) async {
    final semantics = tester.ensureSemantics();
    final backend = _backendWith([tripJson(id: hokkaidoTripId, name: '京都', photoCount: 0)]);
    await openDetailFromHome(tester, backend);
    expect(find.text('まだ写真がありません'), findsOneWidget);
    // 別の端末で、この旅行に写真が1枚入った
    backend.photosByTripId[hokkaidoTripId] = [
      photoJson(number: 1, tripId: hokkaidoTripId, takenAt: '2026-10-05T12:30:15'),
    ];

    await tester.drag(find.text('まだ写真がありません'), const Offset(0, 600));
    await letFramesRun(tester);

    expect(photoThumbnail('2026年10月5日 12:30'), findsOneWidget);
    expect(find.text('まだ写真がありません'), findsNothing);
    semantics.dispose();
  });

  testWidgets('下に引っ張った読み直しに失敗すると、写真のグリッドは残したまま、エラーの文言をスナックバーで知らせる', (tester) async {
    final semantics = tester.ensureSemantics();
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 1)],
      functionKey: _apiKey,
      photosByTripId: {
        hokkaidoTripId: [photoJson(number: 1, tripId: hokkaidoTripId, takenAt: '2026-10-05T12:30:15')],
      },
    );
    await openDetailFromHome(tester, backend);
    // 1回目（開いたとき）は成功済み。読み直しの要求だけを 503 で失敗させる
    backend.failNext(TripRoute.photos);

    await tester.drag(find.byType(GridView), const Offset(0, 600));
    await letFramesRun(tester);

    expect(find.text('サービスに一時的に接続できません。しばらく待ってから再試行してください。'), findsOneWidget);
    expect(photoThumbnail('2026年10月5日 12:30'), findsOneWidget);
    // 写真の部分全体のエラー表示（1ページ目の取得の失敗）にはならない
    expect(find.text('エラーが発生しました'), findsNothing);
    semantics.dispose();
  });

  testWidgets('写真が1ページに収まる旅行は、グリッドを下端まで送っても続きを取りに行かず、写真は1枚ずつしか並ばない', (tester) async {
    // 1ページ目の継続トークンが null（最後のページ）。確認が抜けると、null のトークンで先頭のページを取り直し、同じ写真が二重に並ぶ
    final semantics = tester.ensureSemantics();
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 3)],
      functionKey: _apiKey,
      photosByTripId: {
        hokkaidoTripId: [
          photoJson(number: 1, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:01:00'),
          photoJson(number: 2, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:02:00'),
          photoJson(number: 3, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:03:00'),
        ],
      },
    );
    await openDetailFromHome(tester, backend);

    await tester.drag(find.byType(GridView), const Offset(0, -5000));
    await letFramesRun(tester);

    expect(photoThumbnail('2026年10月5日 10:01'), findsOneWidget);
    expect(photoThumbnail('2026年10月5日 10:02'), findsOneWidget);
    expect(photoThumbnail('2026年10月5日 10:03'), findsOneWidget);
    expect(find.text('読み込み中...'), findsNothing);
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

  testWidgets('写真を長押しすると選択モードに入り、見出しが「1枚を選択中」と「×」「すべて選択」に替わり、押した写真だけが選択中になって、下に「旅行に入れる」「旅行から外す」「削除」が出る', (tester) async {
    // 選択中かどうかは、サムネイルの読み上げ用ラベルを持つ Semantics の「選択中」の状態で見る（チェックの絵は画像のため見分けにくい）
    final semantics = tester.ensureSemantics();
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 2)],
      functionKey: _apiKey,
      photosByTripId: {
        hokkaidoTripId: [
          photoJson(number: 1, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:01:00'),
          photoJson(number: 2, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:02:00'),
        ],
      },
    );
    await openDetailFromHome(tester, backend);
    // 長押しの前は、通常の見出しで、選択の操作は出ていない
    expect(find.descendant(of: find.byType(AppBar), matching: find.text('北海道 2026秋')), findsOneWidget);
    expect(find.text('旅行に入れる'), findsNothing);

    await tester.longPress(photoThumbnail('2026年10月5日 10:01'));
    await letFramesRun(tester);

    expect(find.descendant(of: find.byType(AppBar), matching: find.text('1枚を選択中')), findsOneWidget);
    expect(find.descendant(of: find.byType(AppBar), matching: find.byIcon(Icons.close)), findsOneWidget);
    expect(find.descendant(of: find.byType(AppBar), matching: find.text('すべて選択')), findsOneWidget);
    expect(find.descendant(of: find.byType(AppBar), matching: find.text('北海道 2026秋')), findsNothing);
    expect(tester.getSemantics(photoThumbnail('2026年10月5日 10:01')).hasFlag(SemanticsFlag.isSelected), isTrue);
    expect(tester.getSemantics(photoThumbnail('2026年10月5日 10:02')).hasFlag(SemanticsFlag.isSelected), isFalse);
    expect(find.text('旅行に入れる'), findsOneWidget);
    expect(find.text('旅行から外す'), findsOneWidget);
    expect(find.text('削除'), findsOneWidget);
    semantics.dispose();
  });

  testWidgets('選択モードで別の写真をタップすると、その写真も選択中になり、見出しが「2枚を選択中」に変わる', (tester) async {
    final semantics = tester.ensureSemantics();
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 3)],
      functionKey: _apiKey,
      photosByTripId: {
        hokkaidoTripId: [
          photoJson(number: 1, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:01:00'),
          photoJson(number: 2, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:02:00'),
          photoJson(number: 3, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:03:00'),
        ],
      },
    );
    await openDetailFromHome(tester, backend);
    await tester.longPress(photoThumbnail('2026年10月5日 10:01'));
    await letFramesRun(tester);

    await tester.tap(photoThumbnail('2026年10月5日 10:02'));
    await letFramesRun(tester);

    expect(find.descendant(of: find.byType(AppBar), matching: find.text('2枚を選択中')), findsOneWidget);
    expect(tester.getSemantics(photoThumbnail('2026年10月5日 10:01')).hasFlag(SemanticsFlag.isSelected), isTrue);
    expect(tester.getSemantics(photoThumbnail('2026年10月5日 10:02')).hasFlag(SemanticsFlag.isSelected), isTrue);
    expect(tester.getSemantics(photoThumbnail('2026年10月5日 10:03')).hasFlag(SemanticsFlag.isSelected), isFalse);
    semantics.dispose();
  });

  testWidgets('選んだ写真をもう一度タップして0枚になっても選択モードのままで、その写真の選択は外れ、下の「旅行に入れる」「旅行から外す」「削除」は押せなくなる', (tester) async {
    // 押せないことは、ボタンの Semantics が「有効・無効の状態を持ち、無効」であることで見る
    final semantics = tester.ensureSemantics();
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 1)],
      functionKey: _apiKey,
      photosByTripId: {
        hokkaidoTripId: [photoJson(number: 1, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:01:00')],
      },
    );
    await openDetailFromHome(tester, backend);
    await tester.longPress(photoThumbnail('2026年10月5日 10:01'));
    await letFramesRun(tester);

    await tester.tap(photoThumbnail('2026年10月5日 10:01'));
    await letFramesRun(tester);

    expect(find.descendant(of: find.byType(AppBar), matching: find.text('0枚を選択中')), findsOneWidget);
    expect(tester.getSemantics(photoThumbnail('2026年10月5日 10:01')).hasFlag(SemanticsFlag.isSelected), isFalse);
    for (final label in ['旅行に入れる', '旅行から外す', '削除']) {
      final button = tester.getSemantics(find.text(label));
      expect(button.hasFlag(SemanticsFlag.hasEnabledState), isTrue, reason: '$label は有効・無効の状態を持つ');
      expect(button.hasFlag(SemanticsFlag.isEnabled), isFalse, reason: '$label は押せない');
    }
    semantics.dispose();
  });

  testWidgets('選択モードで「すべて選択」を押すと、読み込んでいる写真がすべて選択中になり、見出しが「3枚を選択中」に変わる', (tester) async {
    final semantics = tester.ensureSemantics();
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 3)],
      functionKey: _apiKey,
      photosByTripId: {
        hokkaidoTripId: [
          photoJson(number: 1, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:01:00'),
          photoJson(number: 2, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:02:00'),
          photoJson(number: 3, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:03:00'),
        ],
      },
    );
    await openDetailFromHome(tester, backend);
    await tester.longPress(photoThumbnail('2026年10月5日 10:01'));
    await letFramesRun(tester);

    await tester.tap(find.text('すべて選択'));
    await letFramesRun(tester);

    expect(find.descendant(of: find.byType(AppBar), matching: find.text('3枚を選択中')), findsOneWidget);
    expect(tester.getSemantics(photoThumbnail('2026年10月5日 10:01')).hasFlag(SemanticsFlag.isSelected), isTrue);
    expect(tester.getSemantics(photoThumbnail('2026年10月5日 10:02')).hasFlag(SemanticsFlag.isSelected), isTrue);
    expect(tester.getSemantics(photoThumbnail('2026年10月5日 10:03')).hasFlag(SemanticsFlag.isSelected), isTrue);
    semantics.dispose();
  });

  testWidgets('選択モード中に端末の戻る操作をすると、画面は閉じずに選択モードを抜け、見出しが旅行名に戻り、下の操作が消えて、写真の選択も外れる', (tester) async {
    final semantics = tester.ensureSemantics();
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 1)],
      functionKey: _apiKey,
      photosByTripId: {
        hokkaidoTripId: [photoJson(number: 1, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:01:00')],
      },
    );
    await openDetailFromHome(tester, backend);
    await tester.longPress(photoThumbnail('2026年10月5日 10:01'));
    await letFramesRun(tester);

    await tester.binding.handlePopRoute();
    await letFramesRun(tester);

    expect(find.byType(TripDetailScreen), findsOneWidget);
    expect(find.descendant(of: find.byType(AppBar), matching: find.text('北海道 2026秋')), findsOneWidget);
    expect(find.descendant(of: find.byType(AppBar), matching: find.textContaining('選択中')), findsNothing);
    expect(find.text('旅行に入れる'), findsNothing);
    expect(tester.getSemantics(photoThumbnail('2026年10月5日 10:01')).hasFlag(SemanticsFlag.isSelected), isFalse);
    semantics.dispose();
  });

  testWidgets('選んだ写真2枚を「旅行に入れる」で別の旅行「京都」に入れると、「2枚を「京都」に入れました」と知らせ、選択モードを抜けて、写真の一覧と見出しの枚数から移した写真が消える', (tester) async {
    // 「旅行を選ぶ」ダイアログは、今いる旅行（北海道）を出さず、他の旅行を名前と枚数で並べる。
    // 移したかどうかは、呼び出しではなく、一覧から消えたことと、偽のサーバの京都の写真に入っていることで見る
    final semantics = tester.ensureSemantics();
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 3), tripJson(id: kyotoTripId, name: '京都', photoCount: 0)],
      functionKey: _apiKey,
      photosByTripId: {
        hokkaidoTripId: [
          photoJson(number: 1, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:01:00'),
          photoJson(number: 2, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:02:00'),
          photoJson(number: 3, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:03:00'),
        ],
      },
    );
    await openDetailFromHome(tester, backend);
    await tester.longPress(photoThumbnail('2026年10月5日 10:01'));
    await letFramesRun(tester);
    await tester.tap(photoThumbnail('2026年10月5日 10:03'));
    await letFramesRun(tester);
    await tester.tap(find.text('旅行に入れる'));
    await letFramesRun(tester);
    expect(inDialog(find.text('旅行を選ぶ')), findsOneWidget);
    expect(inDialog(find.textContaining('京都')), findsOneWidget);
    expect(inDialog(find.textContaining('0枚')), findsOneWidget);
    expect(inDialog(find.textContaining('北海道')), findsNothing);
    await tester.tap(inDialog(find.textContaining('京都')));
    await letFramesRun(tester);

    await tapInDialog(tester, '入れる');

    expect(find.text('2枚を「京都」に入れました'), findsOneWidget);
    expect(find.byType(Dialog), findsNothing);
    expect(find.text('旅行に入れる'), findsNothing);
    expect(photoThumbnail('2026年10月5日 10:01'), findsNothing);
    expect(photoThumbnail('2026年10月5日 10:02'), findsOneWidget);
    expect(photoThumbnail('2026年10月5日 10:03'), findsNothing);
    expect(find.text('1枚 · 2026/10/05 〜 2026/10/08'), findsOneWidget);
    expect(backend.photosByTripId[kyotoTripId]!.map((photo) => photo['takenAt']), ['2026-10-05T10:01:00', '2026-10-05T10:03:00']);
    semantics.dispose();
  });

  testWidgets('選んだ写真の1枚が、選んだあとに別の端末で消されていたら、「旅行に入れる」の知らせに「（1枚は見つかりませんでした）」を足し、残りの1枚は移す', (tester) async {
    final semantics = tester.ensureSemantics();
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 3), tripJson(id: kyotoTripId, name: '京都', photoCount: 0)],
      functionKey: _apiKey,
      photosByTripId: {
        hokkaidoTripId: [
          photoJson(number: 1, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:01:00'),
          photoJson(number: 2, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:02:00'),
          photoJson(number: 3, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:03:00'),
        ],
      },
    );
    await openDetailFromHome(tester, backend);
    await tester.longPress(photoThumbnail('2026年10月5日 10:01'));
    await letFramesRun(tester);
    await tester.tap(photoThumbnail('2026年10月5日 10:03'));
    await letFramesRun(tester);
    await tester.tap(find.text('旅行に入れる'));
    await letFramesRun(tester);
    await tester.tap(inDialog(find.textContaining('京都')));
    await letFramesRun(tester);
    // 選んだあとに、別の端末で10:03の写真が消された
    backend.photosByTripId[hokkaidoTripId]!.removeWhere((photo) => photo['takenAt'] == '2026-10-05T10:03:00');

    await tapInDialog(tester, '入れる');

    expect(find.text('1枚を「京都」に入れました（1枚は見つかりませんでした）'), findsOneWidget);
    expect(backend.photosByTripId[kyotoTripId]!.map((photo) => photo['takenAt']), ['2026-10-05T10:01:00']);
    semantics.dispose();
  });

  testWidgets('201枚を選んで「旅行に入れる」と、200枚を超えても全部が移り、「201枚を「京都」に入れました」と知らせる', (tester) async {
    // 偽のサーバは、一度に200枚を超える移動を 400 で断る（実際のサーバと同じ）。
    // 分けずに送れば失敗するので、全部が移ったことと知らせの枚数で見る。1ページで全部を読み込ませる
    final semantics = tester.ensureSemantics();
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 201), tripJson(id: kyotoTripId, name: '京都', photoCount: 0)],
      functionKey: _apiKey,
      pageSize: 300,
      photosByTripId: {
        hokkaidoTripId: [
          for (var n = 1; n <= 201; n++) photoJson(number: n, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:00:00'),
        ],
      },
    );
    await openDetailFromHome(tester, backend);
    await tester.longPress(photoThumbnail('2026年10月5日 10:00').first);
    await letFramesRun(tester);
    await tester.tap(find.text('すべて選択'));
    await letFramesRun(tester);
    await tester.tap(find.text('旅行に入れる'));
    await letFramesRun(tester);
    await tester.tap(inDialog(find.textContaining('京都')));
    await letFramesRun(tester);

    await tapInDialog(tester, '入れる');

    expect(find.text('201枚を「京都」に入れました'), findsOneWidget);
    expect(backend.photosByTripId[kyotoTripId]!.length, 201);
    semantics.dispose();
  });

  testWidgets('ちょうど200枚を選んで「旅行に入れる」と、200枚が移り、「200枚を「京都」に入れました」と知らせる', (tester) async {
    // 200枚は一度に送れる上限ちょうど。分け方の境界で、空のまとまりを余分に送ると偽のサーバが 400 で断る
    final semantics = tester.ensureSemantics();
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 200), tripJson(id: kyotoTripId, name: '京都', photoCount: 0)],
      functionKey: _apiKey,
      pageSize: 300,
      photosByTripId: {
        hokkaidoTripId: [
          for (var n = 1; n <= 200; n++) photoJson(number: n, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:00:00'),
        ],
      },
    );
    await openDetailFromHome(tester, backend);
    await tester.longPress(photoThumbnail('2026年10月5日 10:00').first);
    await letFramesRun(tester);
    await tester.tap(find.text('すべて選択'));
    await letFramesRun(tester);
    await tester.tap(find.text('旅行に入れる'));
    await letFramesRun(tester);
    await tester.tap(inDialog(find.textContaining('京都')));
    await letFramesRun(tester);

    await tapInDialog(tester, '入れる');

    expect(find.text('200枚を「京都」に入れました'), findsOneWidget);
    expect(backend.photosByTripId[kyotoTripId]!.length, 200);
    semantics.dispose();
  });

  testWidgets('写真を移している間は「入れる」が「入れています...」になり、「キャンセル」や「新しい旅行を作る」、旅行の行も押せず、外のタップや戻る操作でも「旅行を選ぶ」は閉じず、応答が返れば「1枚を「京都」に入れました」と知らせる', (tester) async {
    // 閉じられると、要求は送られたまま写真がサーバで移るのに、利用者は取り消したつもりになる。押せないことは、ボタンの Semantics で見る
    final semantics = tester.ensureSemantics();
    final release = Completer<void>();
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 1), tripJson(id: kyotoTripId, name: '京都', photoCount: 0)],
      functionKey: _apiKey,
      photosByTripId: {
        hokkaidoTripId: [photoJson(number: 1, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:01:00')],
      },
    );
    await openDetailFromHome(tester, backend);
    await tester.longPress(photoThumbnail('2026年10月5日 10:01'));
    await letFramesRun(tester);
    await tester.tap(find.text('旅行に入れる'));
    await letFramesRun(tester);
    await tester.tap(inDialog(find.textContaining('京都')));
    await letFramesRun(tester);
    backend.holds[TripRoute.move] = release.future;

    await tapInDialog(tester, '入れる');

    expect(inDialog(find.text('入れています...')), findsOneWidget);
    expect(inDialog(find.text('入れる')), findsNothing);
    final moving = tester.getSemantics(inDialog(find.text('入れています...')));
    expect(moving.hasFlag(SemanticsFlag.hasEnabledState), isTrue);
    expect(moving.hasFlag(SemanticsFlag.isEnabled), isFalse);
    final cancel = tester.getSemantics(inDialog(find.text('キャンセル')));
    expect(cancel.hasFlag(SemanticsFlag.hasEnabledState), isTrue);
    expect(cancel.hasFlag(SemanticsFlag.isEnabled), isFalse);
    // 「新しい旅行を作る」と旅行の行も押せない。作成ダイアログが重なったまま移動が終わると、結果で閉じるダイアログを取り違える。
    // 行を選び直せると、表示と送った先が食い違う
    final createTrip = tester.getSemantics(inDialog(find.textContaining('新しい旅行を作る')));
    expect(createTrip.hasFlag(SemanticsFlag.hasEnabledState), isTrue);
    expect(createTrip.hasFlag(SemanticsFlag.isEnabled), isFalse);
    final kyotoRow = tester.getSemantics(inDialog(find.textContaining('京都')));
    expect(kyotoRow.hasFlag(SemanticsFlag.hasEnabledState), isTrue);
    expect(kyotoRow.hasFlag(SemanticsFlag.isEnabled), isFalse);
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

    expect(find.text('1枚を「京都」に入れました'), findsOneWidget);
    expect(find.byType(Dialog), findsNothing);
    semantics.dispose();
  });

  testWidgets('写真を削除している間は「削除」が「削除中...」になり、「キャンセル」も押せず、外のタップや戻る操作でも確認は閉じず、応答が返れば「1枚を削除しました」と知らせる', (tester) async {
    // 閉じられると、要求は送られたまま写真がサーバで消えるのに、利用者は取り消したつもりになる。押せないことは、ボタンの Semantics で見る
    final semantics = tester.ensureSemantics();
    final release = Completer<void>();
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 1)],
      functionKey: _apiKey,
      photosByTripId: {
        hokkaidoTripId: [photoJson(number: 1, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:01:00')],
      },
    );
    await openDetailFromHome(tester, backend);
    await tester.longPress(photoThumbnail('2026年10月5日 10:01'));
    await letFramesRun(tester);
    await tester.tap(find.text('削除'));
    await letFramesRun(tester);
    backend.holds[TripRoute.deletePhoto] = release.future;

    await tapInDialog(tester, '削除');

    expect(inDialog(find.text('削除中...')), findsOneWidget);
    final deleting = tester.getSemantics(inDialog(find.text('削除中...')));
    expect(deleting.hasFlag(SemanticsFlag.hasEnabledState), isTrue);
    expect(deleting.hasFlag(SemanticsFlag.isEnabled), isFalse);
    final cancel = tester.getSemantics(inDialog(find.text('キャンセル')));
    expect(cancel.hasFlag(SemanticsFlag.hasEnabledState), isTrue);
    expect(cancel.hasFlag(SemanticsFlag.isEnabled), isFalse);
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

    expect(find.text('1枚を削除しました'), findsOneWidget);
    expect(find.byType(Dialog), findsNothing);
    semantics.dispose();
  });

  testWidgets('写真を削除したあとの旅行の取り直しに失敗しても、「1枚を削除しました」と知らせて写真の一覧は読み直し、見出しは前の値のまま、エラーの表示も失敗の知らせも出さない', (tester) async {
    // 旅行の取得（GET /api/trips/{tripId}）は、開いたときに済んでいる。削除のあとの取り直しが次の1回目なので、確認の「削除」を押す直前に失敗させる
    final semantics = tester.ensureSemantics();
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 3)],
      functionKey: _apiKey,
      photosByTripId: {
        hokkaidoTripId: [
          photoJson(number: 1, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:01:00'),
          photoJson(number: 2, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:02:00'),
          photoJson(number: 3, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:03:00'),
        ],
      },
    );
    await openDetailFromHome(tester, backend);
    await tester.longPress(photoThumbnail('2026年10月5日 10:01'));
    await letFramesRun(tester);
    await tester.tap(find.text('削除'));
    await letFramesRun(tester);
    backend.failNext(TripRoute.detail);

    await tapInDialog(tester, '削除');

    expect(find.text('1枚を削除しました'), findsOneWidget);
    expect(photoThumbnail('2026年10月5日 10:01'), findsNothing);
    expect(photoThumbnail('2026年10月5日 10:02'), findsOneWidget);
    expect(photoThumbnail('2026年10月5日 10:03'), findsOneWidget);
    expect(find.descendant(of: find.byType(AppBar), matching: find.text('北海道 2026秋')), findsOneWidget);
    expect(find.text('3枚 · 2026/10/05 〜 2026/10/08'), findsOneWidget);
    expect(find.text('エラーが発生しました'), findsNothing);
    expect(find.text('サービスに一時的に接続できません。しばらく待ってから再試行してください。'), findsNothing);
    semantics.dispose();
  });

  testWidgets('写真の移動にサーバが失敗を返すと、エラーの文言を出して「旅行を選ぶ」のダイアログと2枚の選択は残り、「入れる」を押し直すと移って「2枚を「京都」に入れました」と知らせる', (tester) async {
    // 移動の要求の1回目だけを 503 で失敗させる。2回目の成功で、押し直しで取り直せることを見る
    final semantics = tester.ensureSemantics();
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 3), tripJson(id: kyotoTripId, name: '京都', photoCount: 0)],
      functionKey: _apiKey,
      photosByTripId: {
        hokkaidoTripId: [
          photoJson(number: 1, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:01:00'),
          photoJson(number: 2, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:02:00'),
          photoJson(number: 3, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:03:00'),
        ],
        kyotoTripId: [],
      },
    );
    await openDetailFromHome(tester, backend);
    await tester.longPress(photoThumbnail('2026年10月5日 10:01'));
    await letFramesRun(tester);
    await tester.tap(photoThumbnail('2026年10月5日 10:03'));
    await letFramesRun(tester);
    await tester.tap(find.text('旅行に入れる'));
    await letFramesRun(tester);
    await tester.tap(inDialog(find.textContaining('京都')));
    await letFramesRun(tester);
    backend.failNext(TripRoute.move);

    await tapInDialog(tester, '入れる');

    expect(find.text('サービスに一時的に接続できません。しばらく待ってから再試行してください。'), findsOneWidget);
    expect(inDialog(find.text('旅行を選ぶ')), findsOneWidget);
    expect(find.descendant(of: find.byType(AppBar), matching: find.text('2枚を選択中')), findsOneWidget);
    expect(backend.photosByTripId[kyotoTripId], isEmpty);
    expect(find.textContaining('に入れました'), findsNothing);

    await tapInDialog(tester, '入れる');

    expect(find.text('2枚を「京都」に入れました'), findsOneWidget);
    expect(find.byType(Dialog), findsNothing);
    expect(backend.photosByTripId[kyotoTripId]!.map((photo) => photo['takenAt']), ['2026-10-05T10:01:00', '2026-10-05T10:03:00']);
    semantics.dispose();
  });

  testWidgets('「旅行を選ぶ」で「京都」を選んだあとに「新しい旅行を作る」で「沖縄」を作ると、一覧に「沖縄」が加わって選びが「沖縄」に替わり、そのまま「入れる」で選んだ写真が「沖縄」に入る（「京都」には入らない）', (tester) async {
    // 先に「京都」を選んでおき、作った旅行で選びが上書きされることも見る（作った旅行を選ばなければ、「入れる」は京都に入ってしまう）。
    // 作った旅行が選ばれていることは、行のラジオボタンの状態ではなく、「入れる」でその旅行に移せることで見る
    // （ラジオボタンの選択は Semantics からは読めなかった）
    final semantics = tester.ensureSemantics();
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 2), tripJson(id: kyotoTripId, name: '京都', photoCount: 0)],
      functionKey: _apiKey,
      photosByTripId: {
        hokkaidoTripId: [
          photoJson(number: 1, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:01:00'),
          photoJson(number: 2, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:02:00'),
        ],
      },
    );
    await openDetailFromHome(tester, backend);
    await tester.longPress(photoThumbnail('2026年10月5日 10:01'));
    await letFramesRun(tester);
    await tester.tap(find.text('旅行に入れる'));
    await letFramesRun(tester);
    await tester.tap(inDialog(find.textContaining('京都')));
    await letFramesRun(tester);
    expect(inDialog(find.textContaining('新しい旅行を作る')), findsOneWidget);
    await tester.tap(inDialog(find.textContaining('新しい旅行を作る')));
    await letFramesRun(tester);
    await enterTripName(tester, '沖縄');

    await tapInDialog(tester, '作成');

    expect(inDialog(find.text('旅行を選ぶ')), findsOneWidget);
    expect(inDialog(find.text('沖縄')), findsOneWidget);
    expect(inDialog(find.textContaining('京都')), findsOneWidget);

    await tapInDialog(tester, '入れる');

    expect(find.text('1枚を「沖縄」に入れました'), findsOneWidget);
    final okinawaId = backend.trips.firstWhere((trip) => trip['name'] == '沖縄')['id'];
    expect(backend.photosByTripId[okinawaId]!.map((photo) => photo['takenAt']), ['2026-10-05T10:01:00']);
    expect(backend.photosByTripId[kyotoTripId] ?? [], isEmpty);
    semantics.dispose();
  });

  testWidgets('選んだ写真2枚を「旅行から外す」で確認して「外す」と、「2枚を旅行から外しました」と知らせ、選択モードを抜けて、写真の一覧と見出しの枚数から外した写真が消え、旅行に属さない写真になる', (tester) async {
    // 外したことは、偽のサーバの「旅行に属さない写真」（none）に入ったことで見る。
    // 偽のサーバは、外すときに tripId のキーを省いた要求を 400 で断る（null を明示して送ったことも、成功で分かる）
    final semantics = tester.ensureSemantics();
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 3)],
      functionKey: _apiKey,
      photosByTripId: {
        hokkaidoTripId: [
          photoJson(number: 1, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:01:00'),
          photoJson(number: 2, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:02:00'),
          photoJson(number: 3, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:03:00'),
        ],
      },
    );
    await openDetailFromHome(tester, backend);
    await tester.longPress(photoThumbnail('2026年10月5日 10:01'));
    await letFramesRun(tester);
    await tester.tap(photoThumbnail('2026年10月5日 10:03'));
    await letFramesRun(tester);
    await tester.tap(find.text('旅行から外す'));
    await letFramesRun(tester);
    expect(inDialog(find.text('旅行から外す')), findsOneWidget);
    expect(inDialog(find.text('2枚を旅行から外しますか？\n写真は「旅行に属さない写真」に移ります。')), findsOneWidget);
    expect(inDialog(find.text('キャンセル')), findsOneWidget);

    await tapInDialog(tester, '外す');

    expect(find.text('2枚を旅行から外しました'), findsOneWidget);
    expect(find.byType(Dialog), findsNothing);
    expect(find.text('旅行から外す'), findsNothing);
    expect(photoThumbnail('2026年10月5日 10:01'), findsNothing);
    expect(photoThumbnail('2026年10月5日 10:02'), findsOneWidget);
    expect(photoThumbnail('2026年10月5日 10:03'), findsNothing);
    expect(find.text('1枚 · 2026/10/05 〜 2026/10/08'), findsOneWidget);
    expect(backend.photosByTripId['none']!.map((photo) => photo['takenAt']), ['2026-10-05T10:01:00', '2026-10-05T10:03:00']);
    semantics.dispose();
  });

  testWidgets('「旅行から外す」の移動にサーバが失敗を返すと、エラーの文言を出して確認のダイアログと2枚の選択は残り、「外す」を押し直すと外れて「2枚を旅行から外しました」と知らせる', (tester) async {
    // 移動の要求の1回目だけを 503 で失敗させる。2回目の成功で、押し直しで取り直せることを見る
    final semantics = tester.ensureSemantics();
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 3)],
      functionKey: _apiKey,
      photosByTripId: {
        hokkaidoTripId: [
          photoJson(number: 1, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:01:00'),
          photoJson(number: 2, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:02:00'),
          photoJson(number: 3, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:03:00'),
        ],
        'none': [],
      },
    );
    await openDetailFromHome(tester, backend);
    await tester.longPress(photoThumbnail('2026年10月5日 10:01'));
    await letFramesRun(tester);
    await tester.tap(photoThumbnail('2026年10月5日 10:03'));
    await letFramesRun(tester);
    await tester.tap(find.text('旅行から外す'));
    await letFramesRun(tester);
    backend.failNext(TripRoute.move);

    await tapInDialog(tester, '外す');

    expect(find.text('サービスに一時的に接続できません。しばらく待ってから再試行してください。'), findsOneWidget);
    expect(inDialog(find.text('旅行から外す')), findsOneWidget);
    expect(find.descendant(of: find.byType(AppBar), matching: find.text('2枚を選択中')), findsOneWidget);
    expect(backend.photosByTripId['none'], isEmpty);
    expect(find.textContaining('外しました'), findsNothing);

    await tapInDialog(tester, '外す');

    expect(find.text('2枚を旅行から外しました'), findsOneWidget);
    expect(find.byType(Dialog), findsNothing);
    expect(backend.photosByTripId['none']!.map((photo) => photo['takenAt']), ['2026-10-05T10:01:00', '2026-10-05T10:03:00']);
    semantics.dispose();
  });

  testWidgets('選んだ写真2枚を「削除」で確認して「削除」すると、「2枚を削除しました」と知らせ、選択モードを抜けて、写真の一覧と見出しの枚数から消え、サーバからも消える', (tester) async {
    // 下の操作バーの「削除」と、確認ダイアログのタイトル・ボタンの「削除」は同じ文言。確認の中のものはダイアログに絞って探す。
    // 消したことは、偽のサーバから消えたことで見る
    final semantics = tester.ensureSemantics();
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 3)],
      functionKey: _apiKey,
      photosByTripId: {
        hokkaidoTripId: [
          photoJson(number: 1, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:01:00'),
          photoJson(number: 2, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:02:00'),
          photoJson(number: 3, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:03:00'),
        ],
      },
    );
    await openDetailFromHome(tester, backend);
    await tester.longPress(photoThumbnail('2026年10月5日 10:01'));
    await letFramesRun(tester);
    await tester.tap(photoThumbnail('2026年10月5日 10:03'));
    await letFramesRun(tester);
    await tester.tap(find.text('削除'));
    await letFramesRun(tester);
    expect(inDialog(find.text('写真を削除')), findsOneWidget);
    expect(inDialog(find.text('2枚の写真を削除しますか？\nこの操作は元に戻せません。')), findsOneWidget);
    expect(inDialog(find.text('キャンセル')), findsOneWidget);

    await tapInDialog(tester, '削除');

    expect(find.text('2枚を削除しました'), findsOneWidget);
    expect(find.byType(Dialog), findsNothing);
    expect(find.text('旅行に入れる'), findsNothing);
    expect(photoThumbnail('2026年10月5日 10:01'), findsNothing);
    expect(photoThumbnail('2026年10月5日 10:02'), findsOneWidget);
    expect(photoThumbnail('2026年10月5日 10:03'), findsNothing);
    expect(find.text('1枚 · 2026/10/05 〜 2026/10/08'), findsOneWidget);
    expect(backend.photosByTripId[hokkaidoTripId]!.map((photo) => photo['takenAt']), ['2026-10-05T10:02:00']);
    semantics.dispose();
  });

  testWidgets('選んだ写真3枚の削除で、1枚は既に別の端末で消されていて（404）、1枚は削除に失敗しても、404の1枚は消せたと数えて「2枚を削除しました（1枚は削除できませんでした）」と知らせ、失敗した1枚は一覧に残る', (tester) async {
    // 削除は選んだ順に1枚ずつ送られる。10:01 を最初に選ぶので、削除の要求の1回目（503 で失敗させる）は 10:01 のもの。
    // 10:02 は選んだ後に別の端末で消される（404）。10:03 は消せる
    final semantics = tester.ensureSemantics();
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 3)],
      functionKey: _apiKey,
      photosByTripId: {
        hokkaidoTripId: [
          photoJson(number: 1, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:01:00'),
          photoJson(number: 2, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:02:00'),
          photoJson(number: 3, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:03:00'),
        ],
      },
    );
    await openDetailFromHome(tester, backend);
    await tester.longPress(photoThumbnail('2026年10月5日 10:01'));
    await letFramesRun(tester);
    await tester.tap(photoThumbnail('2026年10月5日 10:02'));
    await letFramesRun(tester);
    await tester.tap(photoThumbnail('2026年10月5日 10:03'));
    await letFramesRun(tester);
    await tester.tap(find.text('削除'));
    await letFramesRun(tester);
    backend.failNext(TripRoute.deletePhoto);
    backend.photosByTripId[hokkaidoTripId]!.removeWhere((photo) => photo['takenAt'] == '2026-10-05T10:02:00');

    await tapInDialog(tester, '削除');

    expect(find.text('2枚を削除しました（1枚は削除できませんでした）'), findsOneWidget);
    expect(find.byType(Dialog), findsNothing);
    expect(find.text('旅行に入れる'), findsNothing);
    expect(photoThumbnail('2026年10月5日 10:01'), findsOneWidget);
    expect(photoThumbnail('2026年10月5日 10:03'), findsNothing);
    expect(backend.photosByTripId[hokkaidoTripId]!.map((photo) => photo['takenAt']), ['2026-10-05T10:01:00']);
    semantics.dispose();
  });

  testWidgets('「旅行を選ぶ」で旅行の一覧の読み込みに失敗すると、ダイアログの中にエラーの文言と「再試行」を出して「入れる」は押せず、「再試行」で旅行が並んで選べる', (tester) async {
    // 旅行の一覧（GET /api/trips）の1回目だけを 503 で失敗させる。詳細を開くまでに呼ばれた分は済んでいるので、ダイアログを開く直前に仕掛ける
    final semantics = tester.ensureSemantics();
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 1), tripJson(id: kyotoTripId, name: '京都', photoCount: 0)],
      functionKey: _apiKey,
      photosByTripId: {
        hokkaidoTripId: [photoJson(number: 1, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:01:00')],
      },
    );
    await openDetailFromHome(tester, backend);
    await tester.longPress(photoThumbnail('2026年10月5日 10:01'));
    await letFramesRun(tester);
    backend.failNext(TripRoute.list);

    await tester.tap(find.text('旅行に入れる'));
    await letFramesRun(tester);

    expect(inDialog(find.text('旅行を選ぶ')), findsOneWidget);
    expect(inDialog(find.text('サービスに一時的に接続できません。しばらく待ってから再試行してください。')), findsOneWidget);
    expect(inDialog(find.text('再試行')), findsOneWidget);
    expect(inDialog(find.textContaining('京都')), findsNothing);
    final moveButton = tester.getSemantics(inDialog(find.text('入れる')));
    expect(moveButton.hasFlag(SemanticsFlag.hasEnabledState), isTrue);
    expect(moveButton.hasFlag(SemanticsFlag.isEnabled), isFalse);

    await tapInDialog(tester, '再試行');

    expect(inDialog(find.textContaining('京都')), findsOneWidget);
    expect(inDialog(find.text('再試行')), findsNothing);
    await tester.tap(inDialog(find.textContaining('京都')));
    await letFramesRun(tester);
    await tapInDialog(tester, '入れる');
    expect(find.text('1枚を「京都」に入れました'), findsOneWidget);
    semantics.dispose();
  });
}
