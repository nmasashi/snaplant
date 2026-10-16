import 'dart:async';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' show SemanticsFlag;

import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart' show listEquals;
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_image_compress/flutter_image_compress.dart' show CompressFormat;
import 'package:flutter_test/flutter_test.dart';
import 'package:geocoding_platform_interface/geocoding_platform_interface.dart' show Placemark;
import 'package:snaplant_mobile/screens/trip_detail_screen.dart';
import 'package:snaplant_mobile/services/api_service.dart';
import 'package:snaplant_mobile/services/upload_queue.dart';
import 'package:snaplant_mobile/theme/app_theme.dart';

import '../helpers/app_test_helpers.dart';
import '../helpers/gallery_test_helpers.dart';
import '../helpers/geocoding_test_helpers.dart';
import '../helpers/image_compress_test_helpers.dart';
import '../helpers/trip_test_helpers.dart';

// 旅行詳細画面を開き、利用者から見た振る舞いを確かめる（docs/travel-album/03_screen_design.md §4.3・§4.4）。
// 旅行の API は偽のサーバ（helpers の FakeTripBackend）で差し替える。
// 偽のサーバは API キーを照合するので、画面に渡す ApiService には同じキーを持たせる

const _apiKey = 'test-key';

/// 準備を長引かせるために選ぶ写真の枚数。準備は1枚ずつ別の isolate で進み、1枚に十数ミリ秒かかる。
/// 最初の送信の要求が届いて確かめるまでの間（数百ミリ秒）に準備が終わらない枚数にする
const _manyPhotos = 100;

FakeTripBackend _backendWith(List<Map<String, Object?>> trips) => FakeTripBackend(trips: trips, functionKey: _apiKey);

/// 送った写真の位置のうち、緯度・経度だけ。地名は端末の Geocoder（テストごとに偽物に差し替える）次第で変わるので、
/// EXIF の読み取りを確かめるテストは地名を見ない
Map<String, Object?> _coordinatesOf(Map<String, Object?> photo) {
  final location = photo['location'] as Map<String, Object?>;
  return {'latitude': location['latitude'], 'longitude': location['longitude']};
}

/// サーバに届いたサムネイルを作った圧縮の結果。届いたバイト列と同じバイト列を返した圧縮を探す。
/// 圧縮の呼び出しの件数や順には頼らない（作り直しなど、実装の都合で呼び出しが増えても、サーバに届いたものの寸法・画質・形式を見る）。
/// 届いていなければ、見つからないものとして失敗にする
CompressedImage _thumbnailReceived(FakeTripBackend backend, FakeImageCompress compress, Map<String, Object?> photo) {
  final received = backend.thumbnailsByPhotoId[photo['id']];
  if (received == null) fail('写真 ${photo['id']} のサムネイルがサーバに届いていない');
  return compress.results.firstWhere((r) => listEquals(r.bytes, received), orElse: () => fail('届いたサムネイルを作った圧縮が無い'));
}

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

/// 実時間を進めながら、画面を何度も進める（フェイクの時間は進まない）。
/// 送り直しの待ちが過ぎていないとき、実時間が進んでもファイルの読み込みも要求も起きない（届いた回数が増えない）ことを確かめるために使う。
/// 待ちが過ぎていれば、ファイルの読み込みから要求が届くまでに、実時間の経過と画面を進める操作の繰り返しが要る
/// （実時間を一度に待つだけでは、続きが進まず、早すぎる送り直しを見逃す）。繰り返しの回数と間隔は、見逃さないための余裕
/// 写真のサムネイルを出したあとに使うと、画像のキャッシュが端末の機能（path_provider）を探して落ちる（CLAUDE.md の「テストで踏みやすい点」）。出す前に使う
Future<void> _waitRealTime(WidgetTester tester) async {
  for (var i = 0; i < 20; i++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
    await tester.pump();
  }
}

/// 送信の要求が [count] 回届くまで待ち、その失敗の応答を処理させる（次の送り直しの待ちは、ここから数え始まる）
Future<void> _letUploadFail(WidgetTester tester, FakeTripBackend backend, int count) async {
  await waitUntilUploadsReceived(tester, backend, count);
  await tester.pump();
  await tester.pump();
}

/// 北海道の詳細で1枚を送る。1回目が一時的な失敗になっている偽のサーバで、2秒後の送り直しで写真が届くところまで進める。
/// 送り直しの待ちはフェイクの時間（pump）で進める。準備とファイルの読み込みは実時間でしか進まないので、待ちを過ぎたあとは実時間で要求が届くのを待つ
Future<void> _sendOnePhotoAndRetryAfterFailure(WidgetTester tester, FakeTripBackend backend) async {
  await openTripsTab(tester, backend);
  await tester.tap(find.text('北海道 2026秋'));
  await letFramesRun(tester);
  expect(find.text('写真を追加'), findsOneWidget);
  await tester.tap(find.text('写真を追加'));
  await waitUntilUploadsReceived(tester, backend, 1);
  await letFramesRun(tester);
  await tester.pump(const Duration(seconds: 2));
  await waitUntilUploaded(tester, backend, hokkaidoTripId);
  await letFramesRun(tester);
}

/// 「詳細を開く」ボタンだけのホーム画面から、[hokkaidoTripId] の旅行詳細を開く。
/// 詳細画面の前に画面がある状態にする（削除したら戻る先）。[theme] を渡すと、アプリのテーマが効いた状態になる（色を確かめるテストだけが渡す）
Future<void> openDetailFromHome(WidgetTester tester, FakeTripBackend backend, {ThemeData? theme}) async {
  final apiService = ApiService(baseUrl: testApiEndpoint, client: backend.client, functionKey: _apiKey);
  await openApp(
    tester,
    app: MaterialApp(
      theme: theme,
      home: Builder(
        builder: (context) => Scaffold(
          body: Center(
            child: ElevatedButton(
              onPressed: () => Navigator.push(
                context,
                MaterialPageRoute(builder: (_) => TripDetailScreen(apiService: apiService, uploadQueue: UploadQueue(apiService), tripId: hokkaidoTripId)),
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

  testWidgets(
      '1ページ目を読んだあとに別の端末で旅行が消され、続きのページが 404 になると、「この旅行は削除されています」と出し、「続きを読み込めませんでした」も編集・削除のメニューも出さない',
      (tester) async {
    final semantics = tester.ensureSemantics();
    final backend = _backendWith33Photos();
    await openDetailFromHome(tester, backend);
    // 別の端末で旅行が消された（偽のサーバは、無い旅行の写真の一覧を 404 TRIP_NOT_FOUND で返す）
    backend.trips.clear();

    await _scrollToEnd(tester);

    expect(find.text('この旅行は削除されています'), findsOneWidget);
    expect(find.byIcon(Icons.more_vert), findsNothing);
    expect(find.text('続きを読み込めませんでした'), findsNothing);
    semantics.dispose();
  });

  testWidgets(
      '旅行の取得のあとに別の端末で旅行が消され、開いた直後の写真の一覧（1ページ目）が 404 になると、「この旅行は削除されています」と出し、エラーの表示も編集・削除のメニューも出さない',
      (tester) async {
    final semantics = tester.ensureSemantics();
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 1)],
      functionKey: _apiKey,
      photosByTripId: {
        hokkaidoTripId: [
          photoJson(
              number: 1, tripId: hokkaidoTripId, takenAt: '2026-10-05T12:30:15')
        ],
      },
    );
    // 写真の一覧の応答を止め、旅行の取得が成功した後に別の端末で旅行が消された状態にしてから放す
    // （偽のサーバは、無い旅行の写真の一覧を 404 TRIP_NOT_FOUND で返す）
    final release = Completer<void>();
    backend.holds[TripRoute.photos] = release.future;
    await openDetailFromHome(tester, backend);
    expect(find.text('写真を読み込み中...'), findsOneWidget);
    backend.trips.clear();

    release.complete();
    await letFramesRun(tester);

    expect(find.text('この旅行は削除されています'), findsOneWidget);
    expect(find.byIcon(Icons.more_vert), findsNothing);
    expect(find.text('エラーが発生しました'), findsNothing);
    expect(find.text('再試行'), findsNothing);
    semantics.dispose();
  });

  testWidgets(
      '写真の一覧が封筒の無い 404 を返しても、写真の部分に「エラーが発生しました」を出し、「この旅行は削除されています」とは出さない',
      (tester) async {
    // 封筒の無い 404 は宛先の誤りやランタイムが返すもので、旅行が消えたことを表す TRIP_NOT_FOUND ではない（判定は code で行う。画面設計 §4.4）
    final semantics = tester.ensureSemantics();
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 1)],
      functionKey: _apiKey,
      photosByTripId: {
        hokkaidoTripId: [
          photoJson(
              number: 1, tripId: hokkaidoTripId, takenAt: '2026-10-05T12:30:15')
        ],
      },
    );
    backend.failNextWithoutEnvelope(TripRoute.photos,
        status: 404, body: 'Not Found');

    await openDetailFromHome(tester, backend);

    expect(find.text('エラーが発生しました'), findsOneWidget);
    expect(find.text('この旅行は削除されています'), findsNothing);
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

  testWidgets(
      '旅行詳細を開いたあとに別の端末で旅行が消され、下に引っ張った読み直しで写真の一覧が 404 になると、「この旅行は削除されています」と出し、編集・削除のメニューもエラーのスナックバーも出さない',
      (tester) async {
    final semantics = tester.ensureSemantics();
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 1)],
      functionKey: _apiKey,
      photosByTripId: {
        hokkaidoTripId: [
          photoJson(
              number: 1, tripId: hokkaidoTripId, takenAt: '2026-10-05T12:30:15')
        ],
      },
    );
    await openDetailFromHome(tester, backend);
    // 別の端末で旅行が消された（偽のサーバは、無い旅行の写真の一覧を 404 TRIP_NOT_FOUND で返す）
    backend.trips.clear();

    await tester.drag(find.byType(GridView), const Offset(0, 600));
    await letFramesRun(tester);

    expect(find.text('この旅行は削除されています'), findsOneWidget);
    expect(find.byIcon(Icons.more_vert), findsNothing);
    expect(find.byType(SnackBar), findsNothing);
    semantics.dispose();
  });

  testWidgets(
      '写真を選択中に別の端末で旅行が消され、下に引っ張った読み直しで写真の一覧が 404 になると、「この旅行は削除されています」と出し、選択中の見出しも下の操作も出さず、戻る操作で一度に前の画面に戻る',
      (tester) async {
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
    expect(find.text('1枚を選択中'), findsOneWidget);
    // 別の端末で旅行が消された
    backend.trips.clear();

    await tester.drag(find.byType(GridView), const Offset(0, 600));
    await letFramesRun(tester);

    expect(find.text('この旅行は削除されています'), findsOneWidget);
    expect(find.textContaining('選択中'), findsNothing);
    expect(find.text('旅行に入れる'), findsNothing);
    expect(find.text('旅行から外す'), findsNothing);
    expect(find.text('削除'), findsNothing);

    await tester.binding.handlePopRoute();
    await letFramesRun(tester);

    expect(find.byType(TripDetailScreen), findsNothing);
    expect(find.text('詳細を開く'), findsOneWidget);
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

  testWidgets('写真を削除したあとの旅行の取り直しで旅行が既に無い（404）と分かったときは、前の見出しを残さず、「この旅行は削除されています」と出し、編集・削除のメニューは出さない', (tester) async {
    // 取り直しの失敗では前の見出しを残すが、旅行が無いのは失敗ではなく事実。古い旅行名とメニューを残さない
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
    await tester.tap(find.text('削除'));
    await letFramesRun(tester);
    // 確認を出している間に、別の端末で旅行が消された
    backend.trips.clear();
    // 写真の一覧の読み直しは一時的な失敗（503）にする。404 になると、写真の一覧の側からも「削除されています」になり、
    // 旅行の取り直しの 404 だけで削除の表示になることを確かめられない
    backend.failNext(TripRoute.photos);

    await tapInDialog(tester, '削除');

    expect(find.text('この旅行は削除されています'), findsOneWidget);
    expect(find.byIcon(Icons.more_vert), findsNothing);
    expect(find.text('エラーが発生しました'), findsNothing);
    semantics.dispose();
  });

  testWidgets('写真を削除したあと、写真の一覧の 404 で「この旅行は削除されています」になってから、遅れて旅行の取得の成功が届いても、旅行名・編集・削除のメニュー・「写真を追加」は戻らない', (tester) async {
    // 旅行の取得は旅行が消される前に届いて 200 を返しており、その応答が写真の一覧の 404 より後に着く。古い成功で見出しが戻ると、無い旅行を編集・削除できるように見える
    final semantics = tester.ensureSemantics();
    final photosRelease = Completer<void>();
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
    final tripFetchesBefore = backend.tripFetchesReceived;
    final tripReply = backend.holdNextReply(TripRoute.detail);
    backend.holds[TripRoute.photos] = photosRelease.future;
    await tapInDialog(tester, '削除');
    // 旅行の取得は旅行があるうちに届いている（ここが崩れると、遅れた成功を作れない）。そのあとで旅行が消えた
    expect(backend.tripFetchesReceived, tripFetchesBefore + 1);
    backend.trips.clear();

    photosRelease.complete();
    await letFramesRun(tester);
    expect(find.text('この旅行は削除されています'), findsOneWidget);
    tripReply.complete();
    await letFramesRun(tester);

    expect(find.text('この旅行は削除されています'), findsOneWidget);
    expect(find.text('北海道 2026秋'), findsNothing);
    expect(find.byIcon(Icons.more_vert), findsNothing);
    expect(find.text('写真を追加'), findsNothing);
    semantics.dispose();
  });

  testWidgets('写真を旅行から外している間は、「外す」が「外しています...」になる', (tester) async {
    // 押せない・閉じないことは、同じ部品（確認のダイアログ）を通る削除の送信中のテストが見ている。ここでは文言だけを見る
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
    await tester.tap(find.text('旅行から外す'));
    await letFramesRun(tester);
    backend.holds[TripRoute.move] = release.future;

    await tapInDialog(tester, '外す');

    expect(inDialog(find.text('外しています...')), findsOneWidget);
    expect(inDialog(find.text('外す')), findsNothing);

    release.complete();
    await letFramesRun(tester);
    expect(find.text('1枚を旅行から外しました'), findsOneWidget);
    semantics.dispose();
  });

  testWidgets('選択モードの見出しの「すべて選択」は、見出しの背景と違う色の文字で出る（背景と同じ色だと読めない）', (tester) async {
    // アプリのテーマが効いた状態で見る。テーマのテキストボタンの文字色が、見出しの背景と同じ色だと、押せるのに文字が見えなくなる
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 1)],
      functionKey: _apiKey,
      photosByTripId: {
        hokkaidoTripId: [photoJson(number: 1, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:01:00')],
      },
    );
    await openDetailFromHome(tester, backend, theme: AppTheme.lightTheme);

    await tester.longPress(photoThumbnail('2026年10月5日 10:01'));
    await letFramesRun(tester);

    final appBar = find.byType(AppBar);
    final background = tester.widget<Material>(find.descendant(of: appBar, matching: find.byType(Material)).first).color;
    final selectAll = tester.renderObject<RenderParagraph>(find.descendant(of: appBar, matching: find.text('すべて選択')));
    expect(background, isNotNull);
    expect(selectAll.text.style?.color, isNotNull);
    expect(selectAll.text.style?.color, isNot(background));
  });

  testWidgets('選択モードでないときは写真のサムネイルに選択の状態を付けず、選択モードに入ると、選んでいない写真にも「選択の状態を持つが選択中でない」を付ける', (tester) async {
    // 選択の状態を常に付けると、読み上げが選択モードの外でも全部の写真を「未選択」と読む
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

    expect(tester.getSemantics(photoThumbnail('2026年10月5日 10:01')).hasFlag(SemanticsFlag.hasSelectedState), isFalse);

    await tester.longPress(photoThumbnail('2026年10月5日 10:02'));
    await letFramesRun(tester);

    final unselected = tester.getSemantics(photoThumbnail('2026年10月5日 10:01'));
    expect(unselected.hasFlag(SemanticsFlag.hasSelectedState), isTrue);
    expect(unselected.hasFlag(SemanticsFlag.isSelected), isFalse);
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

  testWidgets('旅行詳細の「写真を追加」でギャラリーから1枚選ぶと、その旅行宛てに送られ（写真の id は画像のバイト列の SHA-256）、「1枚を送信しました」と知らせて、写真の一覧と見出しの枚数に出る', (tester) async {
    // アプリ全体を開いて、旅行一覧から旅行詳細へ進む（送信の状態はアプリの根が持つので、画面だけを単独で開かない）。
    // 偽のサーバは、photoId が画像の SHA-256 と一致しない送信を 400 で断る。クライアントが正しいハッシュを送ったかは、写真が届いたことで分かる。
    // EXIF の無い画像（この PNG）では、撮影日時と位置のパートを省く。空文字のパートや緯度・経度の片方だけの送信は 400 で断られるので、省いていることも、写真が届くことで分かる
    final image = writeTestImage('hokkaido.png');
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('まだ写真がありません'), findsOneWidget);

    expect(find.text('写真を追加'), findsOneWidget);
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, hokkaidoTripId);
    await letFramesRun(tester);

    expect(backend.photosByTripId[hokkaidoTripId]!.map((photo) => photo['id']), [tinyPngSha256]);
    expect(find.text('1枚を送信しました'), findsOneWidget);
    expect(find.text('1枚 · 撮影日時なし'), findsOneWidget);
    expect(find.text('まだ写真がありません'), findsNothing);
  });

  testWidgets('EXIF に撮影日時と GPS がある写真を送ると、撮影日時（YYYY-MM-DDTHH:mm:ss）と緯度・経度（10進）がその写真に入り、写真の一覧に撮影日時が出る', (tester) async {
    // EXIF は、日時が `2026:10:05 10:20:30`、位置が北緯 43度30分・東経 141度15分（10進で 43.5 と 141.25）。画像の作り方は gallery_test_helpers.dart。
    final semantics = tester.ensureSemantics();
    final image = writeTestImage('hokkaido.jpg', bytes: exifJpegBytes());
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, hokkaidoTripId);
    await letFramesRun(tester);

    final photo = backend.photosByTripId[hokkaidoTripId]!.single;
    expect(photo['takenAt'], '2026-10-05T10:20:30');
    expect(_coordinatesOf(photo), {'latitude': 43.5, 'longitude': 141.25});
    expect(photoThumbnail('2026年10月5日 10:20'), findsOneWidget);
    semantics.dispose();
  });

  testWidgets('位置情報のある写真を送ると、端末の Geocoder で引いた都道府県と市区町村をつないだ地名（北海道旭川市）が、端末由来としてその写真に入る', (tester) async {
    // EXIF の位置は北緯 43.5・東経 141.25。偽の Geocoder（端末の機能。管理外の依存）は、その近くに対して、番地や区・郡・国まで含む結果を返す。
    // 地名にするのは、都道府県（administrativeArea）と市区町村（locality）だけ（docs/travel-album/06_processing_design.md §4.2）
    useFakeGeocoding(places: [
      (
        latitude: 43.5,
        longitude: 141.25,
        placemarks: [
          const Placemark(
            name: '1-1',
            street: '東光1条1丁目',
            country: '日本',
            isoCountryCode: 'JP',
            postalCode: '070-0031',
            administrativeArea: '北海道',
            subAdministrativeArea: '上川郡',
            locality: '旭川市',
            subLocality: '東光',
          ),
        ],
      ),
    ]);
    final image = writeTestImage('hokkaido.jpg', bytes: exifJpegBytes());
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, hokkaidoTripId);
    await letFramesRun(tester);

    final photo = backend.photosByTripId[hokkaidoTripId]!.single;
    expect(photo['location'], {'latitude': 43.5, 'longitude': 141.25, 'placeName': '北海道旭川市', 'placeSource': 'device'});
  });

  testWidgets('同じ場所（座標を小数3桁に丸めると同じ）で撮った2枚を送ると、Geocoder で引くのは1回だけで、2枚とも同じ地名が入る', (tester) async {
    // 1枚目は北緯 35度40分0秒・東経 139度45分0秒（10進で 35.66667 と 139.75）、2枚目は秒だけ1秒ずれる（35.66695 と 139.75028）。
    // どちらも小数3桁に丸めると 35.667 と 139.750。端末の Geocoder は管理外の依存で、引くたびに時間もかかるので、呼んだ回数は観察できる振る舞い。
    // 端末内のキャッシュ（shared_preferences）は、openTripsTab がテストごとに空にするので、他のテストの結果は持ち越されない。
    // 2枚の画像は座標が違うので、バイト列も写真の id も違う
    final geocoding = useFakeGeocoding(places: [
      (
        latitude: 35.6667,
        longitude: 139.75,
        placemarks: [const Placemark(administrativeArea: '東京都', locality: '千代田区')],
      ),
    ]);
    final first = writeTestImage('tokyo_1.jpg', bytes: exifJpegBytes(latitude: [35, 40, 0], longitude: [139, 45, 0]));
    final second = writeTestImage('tokyo_2.jpg', bytes: exifJpegBytes(latitude: [35, 40, 1], longitude: [139, 45, 1]));
    useGalleryReturning([first, second]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, hokkaidoTripId, count: 2);
    await letFramesRun(tester);

    expect(geocoding.lookups, hasLength(1));
    final photos = backend.photosByTripId[hokkaidoTripId]!;
    expect([for (final photo in photos) (photo['location'] as Map)['placeName']], ['東京都千代田区', '東京都千代田区']);
  });

  testWidgets('丸めて違う場所（緯度だけが 0.001 度以上離れている）で撮った2枚を送ると、それぞれを Geocoder で引き、それぞれの地名が入る', (tester) async {
    // 1枚目は北緯 34度40分0秒（34.66667）、2枚目は4秒北（34.66778）。東経は同じ 135度30分0秒（135.5）。
    // 小数3桁に丸めると 34.667 と 34.668 で違うが、小数2桁なら両方 34.67 になる（丸めが粗すぎると、隣の街の地名を使い回してしまう）
    final geocoding = useFakeGeocoding(places: [
      (latitude: 34.66667, longitude: 135.5, placemarks: [const Placemark(administrativeArea: '大阪府', locality: '大阪市')]),
      (latitude: 34.66778, longitude: 135.5, placemarks: [const Placemark(administrativeArea: '大阪府', locality: '堺市')]),
    ]);
    final first = writeTestImage('osaka_1.jpg', bytes: exifJpegBytes(latitude: [34, 40, 0], longitude: [135, 30, 0]));
    final second = writeTestImage('osaka_2.jpg', bytes: exifJpegBytes(latitude: [34, 40, 4], longitude: [135, 30, 0]));
    useGalleryReturning([first, second]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, hokkaidoTripId, count: 2);
    await letFramesRun(tester);

    expect(geocoding.lookups, hasLength(2));
    final photos = backend.photosByTripId[hokkaidoTripId]!;
    expect([for (final photo in photos) (photo['location'] as Map)['placeName']], ['大阪府大阪市', '大阪府堺市']);
  });

  testWidgets('丸めて違う場所（経度だけが 0.001 度以上離れている）で撮った2枚を送ると、それぞれを Geocoder で引き、それぞれの地名が入る', (tester) async {
    // 1枚目は東経 135度45分0秒（135.75）、2枚目は4秒東（135.75111）。北緯は同じ 35度0分0秒（35.0）。
    // 小数3桁に丸めると 135.750 と 135.751 で違う（経度を見ずに緯度だけで場所を決めると、東西に離れた街の地名を使い回してしまう）
    final geocoding = useFakeGeocoding(places: [
      (latitude: 35.0, longitude: 135.75, placemarks: [const Placemark(administrativeArea: '京都府', locality: '京都市')]),
      (latitude: 35.0, longitude: 135.75111, placemarks: [const Placemark(administrativeArea: '京都府', locality: '宇治市')]),
    ]);
    final first = writeTestImage('kyoto_1.jpg', bytes: exifJpegBytes(latitude: [35, 0, 0], longitude: [135, 45, 0]));
    final second = writeTestImage('kyoto_2.jpg', bytes: exifJpegBytes(latitude: [35, 0, 0], longitude: [135, 45, 4]));
    useGalleryReturning([first, second]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, hokkaidoTripId, count: 2);
    await letFramesRun(tester);

    expect(geocoding.lookups, hasLength(2));
    final photos = backend.photosByTripId[hokkaidoTripId]!;
    expect([for (final photo in photos) (photo['location'] as Map)['placeName']], ['京都府京都市', '京都府宇治市']);
  });

  testWidgets('Geocoder で地名を引くときは、言語に日本語（ja_JP）を指定する（端末の言語が英語でも、「北海道旭川市」の形で引く）', (tester) async {
    // 言語を指定しないと、端末の言語で返る（英語の端末だと "HokkaidoAsahikawa"）。端末の Geocoder は管理外の依存で、渡した引数が外から見える振る舞いなので、渡した言語を確かめる
    final geocoding = useFakeGeocoding(places: [
      (
        latitude: 43.7706,
        longitude: 142.3650,
        placemarks: [const Placemark(administrativeArea: '北海道', locality: '旭川市')],
      ),
    ]);
    final image = writeTestImage('asahikawa.jpg', bytes: exifJpegBytes(latitude: [43, 46, 14], longitude: [142, 21, 54]));
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, hokkaidoTripId);
    await letFramesRun(tester);

    expect([for (final lookup in geocoding.lookups) lookup.locale], [const Locale('ja', 'JP')]);
  });

  testWidgets('つないだ地名が空白だけなら、地名なしで送られる（空白だけの地名はサーバが 400 で断り、写真が届かなくなる）', (tester) async {
    // Geocoder が都道府県に空白だけを返した（市区町村は null）。前後の空白を除くと空になる（docs/travel-album/06_processing_design.md §4.2）
    useFakeGeocoding(places: [
      (
        latitude: 24.3333,
        longitude: 124.1667,
        placemarks: [const Placemark(country: '日本', administrativeArea: ' ', locality: null)],
      ),
    ]);
    final image = writeTestImage('ishigaki.jpg', bytes: exifJpegBytes(latitude: [24, 20, 0], longitude: [124, 10, 0]));
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, hokkaidoTripId);
    await letFramesRun(tester);

    final photo = backend.photosByTripId[hokkaidoTripId]!.single;
    expect((photo['location'] as Map)['placeName'], isNull);
    expect(find.text('1枚を送信しました'), findsOneWidget);
  });

  testWidgets('つないだ地名が101文字なら、地名なしで送られる（100文字を超える地名はサーバが 400 で断り、写真が届かなくなる）', (tester) async {
    useFakeGeocoding(places: [
      (
        latitude: 26.2,
        longitude: 127.6833,
        placemarks: [Placemark(administrativeArea: null, locality: 'あ' * 101)],
      ),
    ]);
    final image = writeTestImage('naha.jpg', bytes: exifJpegBytes(latitude: [26, 12, 0], longitude: [127, 41, 0]));
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, hokkaidoTripId);
    await letFramesRun(tester);

    final photo = backend.photosByTripId[hokkaidoTripId]!.single;
    expect((photo['location'] as Map)['placeName'], isNull);
    expect(find.text('1枚を送信しました'), findsOneWidget);
  });

  testWidgets('つないだ地名がちょうど100文字なら、そのまま地名として送られる', (tester) async {
    // 100文字の上限の境界。サーバは1〜100文字を受け付ける
    useFakeGeocoding(places: [
      (
        latitude: 27.0833,
        longitude: 142.2,
        placemarks: [Placemark(administrativeArea: null, locality: 'あ' * 100)],
      ),
    ]);
    final image = writeTestImage('chichijima.jpg', bytes: exifJpegBytes(latitude: [27, 5, 0], longitude: [142, 12, 0]));
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, hokkaidoTripId);
    await letFramesRun(tester);

    final photo = backend.photosByTripId[hokkaidoTripId]!.single;
    expect((photo['location'] as Map)['placeName'], 'あ' * 100);
  });

  testWidgets('Geocoder が失敗しても、その写真は地名なしで送られ、「1枚を送信しました」と知らせる', (tester) async {
    // 端末の Geocoder が例外を投げる（Google Play 開発者サービスが無い・ネットワークが無い、など）。地名は手がかりに過ぎないので、送信は止めない
    final geocoding = useFakeGeocoding(failWith: Exception('Geocoder が使えない'));
    final image = writeTestImage('sendai.jpg', bytes: exifJpegBytes(latitude: [38, 16, 0], longitude: [140, 52, 0]));
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, hokkaidoTripId);
    await letFramesRun(tester);

    expect(geocoding.lookups, hasLength(1));
    final photo = backend.photosByTripId[hokkaidoTripId]!.single;
    expect((photo['location'] as Map)['placeName'], isNull);
    expect(find.text('1枚を送信しました'), findsOneWidget);
  });

  testWidgets('Geocoder が地名を返さなくても（空の結果）、その写真は地名なしで送られ、「1枚を送信しました」と知らせる', (tester) async {
    // 本物の Geocoder は、引けなかった座標（海の上など）に空のリストを返す。偽物は、知らない場所に空のリストを返す
    final geocoding = useFakeGeocoding();
    final image = writeTestImage('fukuoka.jpg', bytes: exifJpegBytes(latitude: [33, 35, 0], longitude: [130, 24, 0]));
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, hokkaidoTripId);
    await letFramesRun(tester);

    expect(geocoding.lookups, hasLength(1));
    final photo = backend.photosByTripId[hokkaidoTripId]!.single;
    expect((photo['location'] as Map)['placeName'], isNull);
    expect(find.text('1枚を送信しました'), findsOneWidget);
  });

  testWidgets('引けなかった場所は端末に残さないので、同じ場所の次の写真は、もう一度 Geocoder で引く', (tester) async {
    // 引けなかった結果（空の結果）を残すと、一時的に引けなかっただけの場所の地名が、ずっと付かなくなる。
    // 2枚は同じ場所（北緯 34度41分0秒（34.68333）と、1秒南の 34度40分59秒（34.68306）。丸めるとどちらも 34.683。東経は同じ 135度11分0秒）。偽の Geocoder はこの場所を知らない
    final geocoding = useFakeGeocoding();
    final first = writeTestImage('kobe_1.jpg', bytes: exifJpegBytes(latitude: [34, 41, 0], longitude: [135, 11, 0]));
    final second = writeTestImage('kobe_2.jpg', bytes: exifJpegBytes(latitude: [34, 40, 59], longitude: [135, 11, 0]));
    useGalleryReturning([first, second]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, hokkaidoTripId, count: 2);
    await letFramesRun(tester);

    expect(geocoding.lookups, hasLength(2));
    final photos = backend.photosByTripId[hokkaidoTripId]!;
    expect([for (final photo in photos) (photo['location'] as Map)['placeName']], [null, null]);
  });

  testWidgets('Geocoder の結果に都道府県も市区町村も無ければ（null と空文字）、他の欄が埋まっていても、その写真は地名なしで送られ、「1枚を送信しました」と知らせる', (tester) async {
    // 町名（subLocality）や国は埋まっているが、地名にするのは都道府県と市区町村だけ（docs/travel-album/06_processing_design.md §4.2）。どちらも空なら地名なし。
    // 空の地名を送ると、サーバは 400（地名は1〜100文字）で断るので、写真が届くことでも、空の地名を送っていないことが分かる
    final geocoding = useFakeGeocoding(places: [
      (
        latitude: 36.5667,
        longitude: 136.65,
        placemarks: [
          const Placemark(
            name: '香林坊',
            country: '日本',
            isoCountryCode: 'JP',
            administrativeArea: null,
            locality: '',
            subLocality: '香林坊',
          ),
        ],
      ),
    ]);
    final image = writeTestImage('kanazawa.jpg', bytes: exifJpegBytes(latitude: [36, 34, 0], longitude: [136, 39, 0]));
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, hokkaidoTripId);
    await letFramesRun(tester);

    expect(geocoding.lookups, hasLength(1));
    final photo = backend.photosByTripId[hokkaidoTripId]!.single;
    expect((photo['location'] as Map)['placeName'], isNull);
    expect(find.text('1枚を送信しました'), findsOneWidget);
  });

  testWidgets('Geocoder の結果に市区町村が無く都道府県だけなら（locality が null）、地名はその都道府県になり、端末由来としてその写真に入る', (tester) async {
    // 島や海沿いなど、市区町村まで引けない場所。片方でもあれば、その分だけを地名にする（docs/travel-album/06_processing_design.md §4.2 は「どちらも空なら null」）
    useFakeGeocoding(places: [
      (
        latitude: 33.1,
        longitude: 139.78333,
        placemarks: [const Placemark(country: '日本', administrativeArea: '東京都', locality: null)],
      ),
    ]);
    final image = writeTestImage('hachijo.jpg', bytes: exifJpegBytes(latitude: [33, 6, 0], longitude: [139, 47, 0]));
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, hokkaidoTripId);
    await letFramesRun(tester);

    final photo = backend.photosByTripId[hokkaidoTripId]!.single;
    expect((photo['location'] as Map)['placeName'], '東京都');
    expect((photo['location'] as Map)['placeSource'], 'device');
  });

  testWidgets('都道府県も市区町村も無い結果は端末に残さないので、同じ場所の次の写真は、もう一度 Geocoder で引く', (tester) async {
    // 地名にならなかった結果を残すと、同じ場所の写真に地名がずっと付かなくなる。
    // 2枚は同じ場所（北緯 36度34分0秒と 36度34分1秒。丸めるとどちらも 36.567。東経は同じ 136度39分0秒）
    final geocoding = useFakeGeocoding(places: [
      (
        latitude: 36.5667,
        longitude: 136.65,
        placemarks: [const Placemark(country: '日本', administrativeArea: null, locality: '', subLocality: '香林坊')],
      ),
    ]);
    final first = writeTestImage('kanazawa_1.jpg', bytes: exifJpegBytes(latitude: [36, 34, 0], longitude: [136, 39, 0]));
    final second = writeTestImage('kanazawa_2.jpg', bytes: exifJpegBytes(latitude: [36, 34, 1], longitude: [136, 39, 0]));
    useGalleryReturning([first, second]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, hokkaidoTripId, count: 2);
    await letFramesRun(tester);

    expect(geocoding.lookups, hasLength(2));
    final photos = backend.photosByTripId[hokkaidoTripId]!;
    expect([for (final photo in photos) (photo['location'] as Map)['placeName']], [null, null]);
  });

  testWidgets('Geocoder が5秒たっても応答しなければ、その写真は地名なしで送られ、「1枚を送信しました」と知らせる', (tester) async {
    // 端末の Geocoder が固まる。引き始めてから 4.999 秒の間はまだ待ち（写真は送られない）、5 秒で諦めて送る。
    // 時間はフェイクの時間で進める（実時間の 5 秒は待たない）。画面を進める letFramesRun は 1.5 秒ずつ進めてしまうので、引かれるのを待つ間は使わない。
    // 引き始めの時刻は、引かれたのを見つけるまでフェイクの時間を進めていないので、そこから数えられる
    final geocoding = useFakeGeocoding(hangs: true);
    final image = writeTestImage('nagano.jpg', bytes: exifJpegBytes(latitude: [36, 39, 0], longitude: [138, 11, 0]));
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await waitUntilLookedUp(tester, geocoding, 1);
    await tester.pump(const Duration(milliseconds: 4999));
    await _waitRealTime(tester);
    expect(backend.uploadsReceived, 0);

    await tester.pump(const Duration(milliseconds: 1));
    await waitUntilUploaded(tester, backend, hokkaidoTripId);
    await letFramesRun(tester);

    final photo = backend.photosByTripId[hokkaidoTripId]!.single;
    expect((photo['location'] as Map)['placeName'], isNull);
    expect(find.text('1枚を送信しました'), findsOneWidget);
  });

  testWidgets('南緯・西経の EXIF の写真を送ると、緯度・経度は負の値で入る', (tester) async {
    // EXIF の向きが S（南緯）・W（西経）のとき、10進の度は負になる（-43.5 と -141.25）
    final image = writeTestImage('south_west.jpg', bytes: exifJpegBytes(latitudeRef: 'S', longitudeRef: 'W'));
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, hokkaidoTripId);
    await letFramesRun(tester);

    final photo = backend.photosByTripId[hokkaidoTripId]!.single;
    expect(_coordinatesOf(photo), {'latitude': -43.5, 'longitude': -141.25});
  });

  testWidgets('写真を送ると、長辺320px・画質70のJPEGのサムネイルを付けて送り、その写真にサムネイルが入る', (tester) async {
    // 4000x3000 の写真。画像の圧縮（端末のネイティブの機能。管理外の依存）は偽物に差し替え、渡した引数から決まる寸法・画質・形式を結果として読む。
    // 偽物は本物と同じく、短辺が渡した最小の値になるまで縮める。幅と高さの最小を両方 320 にすると 426x320 になるので、長辺 320 には 320x240 になる渡し方が要る。
    // 圧縮は端末のネイティブの機能で、別の isolate（準備の compute）からは呼べない。この偽物が呼ばれる（結果が残る）ことで、メインの isolate で呼んでいることも分かる
    final compress = useFakeImageCompress();
    final image = writeTestImage('wide.png', bytes: pngBytesOfSize(4000, 3000));
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, hokkaidoTripId);
    await letFramesRun(tester);

    final photo = backend.photosByTripId[hokkaidoTripId]!.single;
    expect(photo['thumbnailUrl'], isNotNull);
    final thumbnail = _thumbnailReceived(backend, compress, photo);
    expect((thumbnail.width, thumbnail.height, thumbnail.quality, thumbnail.format), (320, 240, 70, CompressFormat.jpeg));
  });

  testWidgets('縦長の写真（3000x4000）でも、長辺が320pxのサムネイル（240x320）になる', (tester) async {
    // 偽の圧縮は短辺が渡した最小の値になるまで縮めるので、縦長のときは高さだけに 320 を渡さないと 320x426 になる
    final compress = useFakeImageCompress();
    final image = writeTestImage('tall.png', bytes: pngBytesOfSize(3000, 4000));
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, hokkaidoTripId);
    await letFramesRun(tester);

    final photo = backend.photosByTripId[hokkaidoTripId]!.single;
    final thumbnail = _thumbnailReceived(backend, compress, photo);
    expect((thumbnail.width, thumbnail.height, thumbnail.quality, thumbnail.format), (240, 320, 70, CompressFormat.jpeg));
  });

  testWidgets('サムネイルを作れなかった写真も、サムネイル無しで送られ、「1枚を送信しました」と知らせる', (tester) async {
    // 圧縮が例外を投げる（画像を読めない・端末の機能が使えない）。サムネイルは一覧の表示用で、無くても写真は保存できるので、送信は止めない。
    // サムネイルのパートは省かれる（空のパートは 400 で断られるので、写真が届くことでも分かる）
    useFakeImageCompress(failWith: Exception('サムネイルを作れない'));
    final image = writeTestImage('hokkaido.png', bytes: pngBytesOfSize(4000, 3000));
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, hokkaidoTripId);
    await letFramesRun(tester);

    final photo = backend.photosByTripId[hokkaidoTripId]!.single;
    expect(photo['thumbnailUrl'], isNull);
    expect(backend.thumbnailsByPhotoId, isEmpty);
    expect(find.text('1枚を送信しました'), findsOneWidget);
  });

  testWidgets('2枚のうち2枚目の準備（ファイルの読み込み）に失敗しても、「画像の読み込みに失敗しました」と知らせ、読めた1枚目は送られて「1枚を送信しました」と知らせる', (tester) async {
    // 準備は1枚ずつ進む。途中の1枚で失敗しても、それまでに準備できた分が列に残ったまま送られなくならない。2枚目は存在しないパス
    final first = writeTestImage('first.png');
    final missing = File('${first.parent.path}/no_such_image.png');
    useGalleryReturning([first, missing]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await waitUntilFound(tester, find.text('画像の読み込みに失敗しました'));

    expect(find.text('画像の読み込みに失敗しました'), findsOneWidget);
    await waitUntilUploaded(tester, backend, hokkaidoTripId);
    await letFramesRun(tester);
    expect(backend.photosByTripId[hokkaidoTripId]!.map((photo) => photo['id']), [tinyPngSha256]);
    // 2つの知らせは順に出る。先の「読み込みに失敗しました」が消えてから、あとの知らせが出る
    await pumpUntilFound(tester, find.text('1枚を送信しました'));
    expect(find.text('1枚を送信しました'), findsOneWidget);
  });

  testWidgets('3枚のうち2枚目の準備に失敗しても、3枚目の準備は続け、「画像の読み込みに失敗しました」と知らせ、読めた1枚目と3枚目が送られて「2枚を送信しました」と知らせる', (tester) async {
    // 失敗した写真より後に選んだ写真を、捨てない。2枚目は存在しないパス
    final first = writeTestImage('first.png');
    final missing = File('${first.parent.path}/no_such_image.png');
    final third = writeTestImage('third.png', bytes: [...tinyPngBytes, 0]);
    useGalleryReturning([first, missing, third]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await waitUntilFound(tester, find.text('画像の読み込みに失敗しました'));

    expect(find.text('画像の読み込みに失敗しました'), findsOneWidget);
    await waitUntilUploaded(tester, backend, hokkaidoTripId, count: 2);
    await letFramesRun(tester);
    expect(backend.photosByTripId[hokkaidoTripId]!.length, 2);
    expect(backend.photosByTripId[hokkaidoTripId]!.map((photo) => photo['id']), contains(tinyPngSha256));
    // 2つの知らせは順に出る。先の「読み込みに失敗しました」が消えてから、あとの知らせが出る
    await pumpUntilFound(tester, find.text('2枚を送信しました'));
    expect(find.text('2枚を送信しました'), findsOneWidget);
  });

  testWidgets('送信している間に設定をリセットしてアプリが送信の列を作り直しても、送信の応答が返ったときに例外は出ず、作り直した後の画面に送信の知らせは出ない', (tester) async {
    // 設定が変わると、前の設定の列は破棄される。破棄された列の送信が終わっても、閉じたストリームへ流したり、破棄済みの通知を呼んだりしない
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
    await resetSettingsAndGoBack(tester);
    expect(find.text('API設定が完了していません'), findsOneWidget);

    release.complete();
    await letFramesRun(tester);

    expect(find.textContaining('送信'), findsNothing);
  });

  testWidgets('EXIF の撮影日時が実在しない日時（時計が未設定のカメラの 0000:00:00 00:00:00）の写真は、撮影日時を省いて送られて届き、位置はそのまま入る', (tester) async {
    // 実在しない日時を送ると、サーバに 400 で断られ、何度送っても届かない。偽のサーバも、実在しない日時は 400 で断る
    final image = writeTestImage('unset_clock.jpg', bytes: exifJpegBytes(dateTimeOriginal: '0000:00:00 00:00:00'));
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, hokkaidoTripId);
    await letFramesRun(tester);

    final photo = backend.photosByTripId[hokkaidoTripId]!.single;
    expect(photo['takenAt'], isNull);
    expect(_coordinatesOf(photo), {'latitude': 43.5, 'longitude': 141.25});
  });

  testWidgets('EXIF の緯度が範囲外（95度）の写真は、位置を省いて送られて届き、撮影日時はそのまま入る', (tester) async {
    // 範囲外の位置を送ると、サーバに 400 で断られ、何度送っても届かない。偽のサーバも、範囲外は 400 で断る
    final image = writeTestImage('bad_gps.jpg', bytes: exifJpegBytes(latitude: [95, 0, 0]));
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, hokkaidoTripId);
    await letFramesRun(tester);

    final photo = backend.photosByTripId[hokkaidoTripId]!.single;
    expect(photo['location'], isNull);
    expect(photo['takenAt'], '2026-10-05T10:20:30');
  });

  testWidgets('「写真を追加」でギャラリーの読み込みに失敗すると、「画像の読み込みに失敗しました」と知らせ、何も送らない', (tester) async {
    useGalleryReturning([], failWith: Exception('ギャラリーを開けない'));
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await letFramesRun(tester);

    expect(find.text('画像の読み込みに失敗しました'), findsOneWidget);
    expect(backend.photosByTripId[hokkaidoTripId] ?? [], isEmpty);
    expect(find.text('まだ写真がありません'), findsOneWidget);
  });

  testWidgets('2枚を送っている間は、旅行詳細の上部に「送信中 0/2」を出し、1枚の応答が返ると「送信中 1/2」に変わり、2枚目の応答が返るとバナーを消して「2枚を送信しました」と知らせる', (tester) async {
    // 偽のサーバは、届いた2回の送信の応答をそれぞれ保留する（同時に2本送られる）。届いた時点で写真は偽のサーバに入っている。
    // 応答を返すと完了と数える
    final first = writeTestImage('first.png');
    final second = writeTestImage('second.png', bytes: [...tinyPngBytes, 0]);
    useGalleryReturning([first, second]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    final firstReply = backend.holdNextReply(TripRoute.upload);
    final secondReply = backend.holdNextReply(TripRoute.upload);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.textContaining('送信中'), findsNothing);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, hokkaidoTripId, count: 2);
    await letFramesRun(tester);

    expect(backend.photosByTripId[hokkaidoTripId]!.length, 2);
    expect(find.text('送信中 0/2'), findsOneWidget);

    firstReply.complete();
    await letFramesRun(tester);

    expect(find.text('送信中 1/2'), findsOneWidget);

    secondReply.complete();
    await letFramesRun(tester);

    expect(find.textContaining('送信中'), findsNothing);
    expect(find.text('2枚を送信しました'), findsOneWidget);
  });

  testWidgets('100枚を選ぶと、準備が済んだ写真から送り始め、準備が終わるまでの間は、旅行詳細の上部に「写真を準備中... k/100」を出す', (tester) async {
    // 準備は1枚ずつ別の isolate で進む。100枚の準備は、最初の送信の要求が偽のサーバに届いたあともしばらく続く（準備が終わるとバナーは消える）。
    // k は準備の進み具合で変わるので、分母と形式で見る。1枚目の応答は保留して、1枚目の送信が終わったことによる表示の変化を混ぜない
    useGalleryReturning(writeTestImages(_manyPhotos));
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    final firstReply = backend.holdNextReply(TripRoute.upload);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 1);
    await tester.pump();

    expect(preparingBanner(_manyPhotos), findsOneWidget);
    // 最初の1枚は準備が済んでいて、全部は済んでいない（k は準備の進み具合で変わるので、範囲で見る）
    expect(preparedCountInBanner(_manyPhotos), inInclusiveRange(1, _manyPhotos - 1));
    // 後片付け: 保留した応答を返す（応答を待つ間の時間切れのタイマーを、テストの終わりに残さない）
    firstReply.complete();
  });

  testWidgets('最初の1枚の送信が残りの準備より先に終わっても、準備中の写真が残っている間は「N枚を送信しました」と知らせず、全部が終わってから「100枚を送信しました」を1回だけ知らせる', (tester) async {
    // 今回は1枚目の応答を保留しないので、1枚目の送信は準備が終わる前に終わる。準備中の写真が残っているので、送信の区切りにはならない。
    // 1枚目の送信が終わった時点で送信の列が空になるよう、2枚目だけは 16MB のファイルにする（準備に数百ミリ秒かかる。残りの98枚は小さく、準備の終わりはさらに遅れる）
    final files = writeTestImages(_manyPhotos);
    final medium = writeTestImage('medium.png', bytes: Uint8List(16 * 1024 * 1024));
    useGalleryReturning([files.first, medium, ...files.skip(2)]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, hokkaidoTripId);
    await letFramesRun(tester);

    expect(preparingBanner(_manyPhotos), findsOneWidget);
    expect(find.textContaining('を送信しました'), findsNothing);

    await waitUntilFound(tester, find.text('100枚を送信しました'), step: const Duration(milliseconds: 1));

    expect(find.text('100枚を送信しました'), findsOneWidget);
    expect(find.textContaining('を送信しました'), findsOneWidget);
  });

  testWidgets('1枚の送信の応答が60秒返らないときは、時間切れにして2秒後に送り直し、その送り直しが成功すれば、「1枚を送信しました」と知らせ、送信できなかった行は出ない', (tester) async {
    // 1回目の応答は保留して返さない（通信が固まった状態）。時間切れは通信の失敗と同じ扱いで、2秒後に送り直す。
    // 送り直しの待ちと同じく、時間切れもフェイクの時間（pump）で進める。要求が届いてから時間は進めていないので、
    // 時間切れは 60 秒、送り直しはその 2 秒後。1ミリ秒手前では届かず、1ミリ秒進めると届く
    final image = writeTestImage('hokkaido.png');
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    final firstReply = backend.holdNextReply(TripRoute.upload);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 1);
    await tester.pump(const Duration(milliseconds: 61999));
    await _waitRealTime(tester);
    expect(backend.uploadsReceived, 1);
    await tester.pump(const Duration(milliseconds: 1));
    await waitUntilUploadsReceived(tester, backend, 2);
    // 時間切れのあとに、保留していた1回目の応答が遅れて届いても、結果は変わらない
    firstReply.complete();
    await letFramesRun(tester);

    await pumpUntilFound(tester, find.text('1枚を送信しました'));
    expect(find.text('1枚を送信しました'), findsOneWidget);
    expect(find.textContaining('送信できませんでした'), findsNothing);
  });

  testWidgets('1枚の送信が1回目に 503 で失敗しても、2秒後の送り直しで成功すれば、写真は届いて「1枚を送信しました」と知らせ、送信できなかった行は出ない', (tester) async {
    // 通信の失敗・429・503 は自動で送り直す（2秒 → 4秒 → 8秒）
    final image = writeTestImage('hokkaido.png');
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    backend.failNext(TripRoute.upload);

    await _sendOnePhotoAndRetryAfterFailure(tester, backend);

    expect(backend.photosByTripId[hokkaidoTripId]!.map((photo) => photo['id']), [tinyPngSha256]);
    await pumpUntilFound(tester, find.text('1枚を送信しました'));
    expect(find.text('1枚を送信しました'), findsOneWidget);
    expect(find.textContaining('送信できませんでした'), findsNothing);
  });

  testWidgets('1枚の送信が1回目に 429（封筒の無い「混雑」の応答）で失敗しても、2秒後の送り直しで成功すれば、写真は届いて「1枚を送信しました」と知らせ、送信できなかった行は出ない', (tester) async {
    // 429 は、アプリではなく従量課金プランの Functions ランタイムが過負荷のときに、封筒なしで返す
    final image = writeTestImage('hokkaido.png');
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    backend.failNextWithoutEnvelope(TripRoute.upload, status: 429);

    await _sendOnePhotoAndRetryAfterFailure(tester, backend);

    expect(backend.photosByTripId[hokkaidoTripId]!.map((photo) => photo['id']), [tinyPngSha256]);
    await pumpUntilFound(tester, find.text('1枚を送信しました'));
    expect(find.text('1枚を送信しました'), findsOneWidget);
    expect(find.textContaining('送信できませんでした'), findsNothing);
  });

  testWidgets('1枚の送信が1回目に通信の失敗（応答が返らない）になっても、2秒後の送り直しで成功すれば、写真は届いて「1枚を送信しました」と知らせ、送信できなかった行は出ない', (tester) async {
    // 通信が切れて応答が返らない失敗は、HTTP クライアントの例外として届く
    final image = writeTestImage('hokkaido.png');
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    backend.failNextWithConnectionError(TripRoute.upload);

    await _sendOnePhotoAndRetryAfterFailure(tester, backend);

    expect(backend.photosByTripId[hokkaidoTripId]!.map((photo) => photo['id']), [tinyPngSha256]);
    await pumpUntilFound(tester, find.text('1枚を送信しました'));
    expect(find.text('1枚を送信しました'), findsOneWidget);
    expect(find.textContaining('送信できませんでした'), findsNothing);
  });

  testWidgets('503 で失敗した送信は、2秒・4秒・8秒の間隔を空けて送り直し、それより早くは送り直さない', (tester) async {
    // 送り直しの待ちはフェイクの時間。待ちの1ミリ秒手前では実時間を進めても要求は届かず、1ミリ秒進めると届く。
    // 要求が届いた回数は、偽のサーバが受け取った要求の数（送り直しの間隔を、サーバから見た要求の届き方で確かめる）
    final image = writeTestImage('hokkaido.png');
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    for (var i = 0; i < 4; i++) {
      backend.failNext(TripRoute.upload);
    }
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await _letUploadFail(tester, backend, 1);
    await tester.pump(const Duration(milliseconds: 1999));
    await _waitRealTime(tester);
    expect(backend.uploadsReceived, 1);
    await tester.pump(const Duration(milliseconds: 1));
    await _letUploadFail(tester, backend, 2);

    await tester.pump(const Duration(milliseconds: 3999));
    await _waitRealTime(tester);
    expect(backend.uploadsReceived, 2);
    await tester.pump(const Duration(milliseconds: 1));
    await _letUploadFail(tester, backend, 3);

    await tester.pump(const Duration(milliseconds: 7999));
    await _waitRealTime(tester);
    expect(backend.uploadsReceived, 3);
    await tester.pump(const Duration(milliseconds: 1));
    await _letUploadFail(tester, backend, 4);
  });

  testWidgets('送り直しは3回までで、4回とも 503 で失敗したら、それ以上は送らず、バナーに「1枚を送信できませんでした」を出す', (tester) async {
    // 間隔は前のテストが見る。ここでは各回の待ちを十分に（実際の間隔より長く）進め、最後の失敗のあとにどれだけ待っても送られないことを見る
    final image = writeTestImage('hokkaido.png');
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    for (var i = 0; i < 4; i++) {
      backend.failNext(TripRoute.upload);
    }
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await _letUploadFail(tester, backend, 1);
    await tester.pump(const Duration(seconds: 3));
    await _letUploadFail(tester, backend, 2);
    await tester.pump(const Duration(seconds: 5));
    await _letUploadFail(tester, backend, 3);
    await tester.pump(const Duration(seconds: 9));
    await _letUploadFail(tester, backend, 4);
    await tester.pump(const Duration(seconds: 16));
    await _waitRealTime(tester);
    await letFramesRun(tester);

    expect(backend.uploadsReceived, 4);
    expect(backend.photosByTripId[hokkaidoTripId] ?? [], isEmpty);
    expect(find.text('1枚を送信できませんでした（サービスに一時的に接続できません。しばらく待ってから再試行してください。）'), findsOneWidget);
    expect(find.text('送り直す'), findsOneWidget);
  });

  testWidgets('送り先の旅行が別の端末で消されていて 404 になったら、同じ旅行宛ての残りの写真は送らずに失敗にし、バナーに「3枚を送信できませんでした（旅行が見つかりません）」を出す', (tester) async {
    // 詳細を開いたあとで、偽のサーバから旅行を消す（画面は取り直さないので、詳細は開いたまま）。
    // 同時に送るのは2本。1枚目と2枚目の応答（どちらも 404）を保留して、3枚目の準備が済み、待ちに入った（「送信中 0/3」）ところで返す。
    // こうすると、3枚目は 404 が返る前に送られることがなく、送らないことを、届いた要求がちょうど2回であることで決定的に見られる
    final first = writeTestImage('first.png');
    final second = writeTestImage('second.png', bytes: [...tinyPngBytes, 0]);
    final third = writeTestImage('third.png', bytes: [...tinyPngBytes, 0, 0]);
    useGalleryReturning([first, second, third]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);
    backend.trips.clear();
    final firstReply = backend.holdNextReply(TripRoute.upload);
    final secondReply = backend.holdNextReply(TripRoute.upload);

    await tester.tap(find.text('写真を追加'));
    await waitUntilFound(tester, find.text('送信中 0/3'));
    expect(find.text('送信中 0/3'), findsOneWidget);
    firstReply.complete();
    secondReply.complete();
    await _waitRealTime(tester);
    await letFramesRun(tester);

    expect(backend.uploadsReceived, 2);
    expect(backend.photosByTripId[hokkaidoTripId] ?? [], isEmpty);
    expect(find.text('3枚を送信できませんでした（旅行が見つかりません）'), findsOneWidget);
  });

  testWidgets('送信がサーバの 413（ファイルが大きすぎる）で失敗すると、バナーはサーバが返した文言を理由に添えて「1枚を送信できませんでした（ファイルサイズが大きすぎます）」を出す', (tester) async {
    // 500・503 などは固定の文言、それ以外のステータスはサーバの `message` が理由になる（`ApiException.userMessage`）。413 は送り直しの対象ではない
    final image = writeTestImage('hokkaido.png');
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    backend.failNext(TripRoute.upload, status: 413, code: 'FILE_TOO_LARGE', message: 'ファイルサイズが大きすぎます');
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 1);
    await _waitRealTime(tester);
    await letFramesRun(tester);

    expect(find.text('1枚を送信できませんでした（ファイルサイズが大きすぎます）'), findsOneWidget);
  });

  testWidgets('送った2枚のうち1枚が、別の旅行に送信済みの写真（200）なら、「2枚を送信しました（1枚は送信済みでした。別の旅行か、旅行に属さない写真にあります）」と知らせ、北海道には新しい1枚だけが入る', (tester) async {
    // 写真の id は画像の SHA-256 なので、同じ写真は何度送っても1枚になる。偽のサーバは、既にある id には 200 で既存の写真（京都にある）を返す。
    // 送信済みの1枚も、送れた枚数（2枚）に数える
    final alreadySent = writeTestImage('already_sent.png');
    final fresh = writeTestImage('fresh.png', bytes: [...tinyPngBytes, 0]);
    useGalleryReturning([alreadySent, fresh]);
    final backend = FakeTripBackend(
      trips: [
        tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0),
        tripJson(id: kyotoTripId, name: '京都', photoCount: 1),
      ],
      photosByTripId: {
        kyotoTripId: [photoJson(number: 0, tripId: kyotoTripId)..['id'] = tinyPngSha256],
      },
    );
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, hokkaidoTripId);
    await letFramesRun(tester);

    expect(backend.photosByTripId[hokkaidoTripId]!.length, 1);
    expect(backend.photosByTripId[kyotoTripId]!.length, 1);
    await pumpUntilFound(tester, find.textContaining('を送信しました'));
    expect(find.text('2枚を送信しました（1枚は送信済みでした。別の旅行か、旅行に属さない写真にあります）'), findsOneWidget);
  });

  testWidgets('送り先の旅行が消えていて 404 になったあとに準備が済んだ同じ旅行宛ての写真も、送らずに失敗にし、バナーに「100枚を送信できませんでした（旅行が見つかりません）」を出す', (tester) async {
    // 100枚を選び、同時に送る1枚目と2枚目の応答（どちらも 404）を保留する。2本が届いた時点で準備はまだ続いているので、
    // 応答を返したあとに準備が済む写真がある。それらも送られない（届いた要求は2回のまま）
    useGalleryReturning(writeTestImages(_manyPhotos));
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);
    backend.trips.clear();
    final firstReply = backend.holdNextReply(TripRoute.upload);
    final secondReply = backend.holdNextReply(TripRoute.upload);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 2);
    await tester.pump();
    expect(preparingBanner(_manyPhotos), findsOneWidget);
    firstReply.complete();
    secondReply.complete();
    await waitUntilFound(tester, find.textContaining('送信できませんでした'), step: const Duration(milliseconds: 1));

    expect(backend.uploadsReceived, 2);
    expect(find.text('100枚を送信できませんでした（旅行が見つかりません）'), findsOneWidget);
  });

  testWidgets('旅行が無いと分かった画面でも、この旅行宛ての送信の失敗のバナーは出したままにし、「閉じる」で消せる', (tester) async {
    // 先に送信が 404（旅行が見つかりません）で失敗し、そのあと下に引っ張った読み直しで写真の一覧も 404 になって、画面が「この旅行は削除されています」になる。
    // 順は決まっている（送信の失敗を見届けてから読み直す）。画面設計 §4.4: 送れなかった写真を「閉じる」で片付けられるよう、バナーは出したままにする
    final image = writeTestImage('hokkaido.png');
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);
    backend.trips.clear();
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 1);
    await letFramesRun(tester);
    expect(find.text('1枚を送信できませんでした（旅行が見つかりません）'), findsOneWidget);

    await tester.drag(find.byType(RefreshIndicator), const Offset(0, 600));
    await letFramesRun(tester);

    expect(find.text('この旅行は削除されています'), findsOneWidget);
    expect(find.text('1枚を送信できませんでした（旅行が見つかりません）'), findsOneWidget);
    expect(find.text('閉じる'), findsOneWidget);
    await tester.tap(find.text('閉じる'));
    await letFramesRun(tester);
    expect(find.textContaining('送信できませんでした'), findsNothing);
  });

  testWidgets('送り直しを待っている写真があるときに、同じ旅行宛ての別の写真が 404 になったら、待っている写真も送り直さずに失敗にし、バナーに「2枚を送信できませんでした（旅行が見つかりません）」を出す', (tester) async {
    // 同時に送る2枚のうち、1枚目の要求が 503（2秒後に送り直す）、2枚目の要求が 404 になる（失敗は、要求が届いた順に割り当てる）。
    // 2枚目の 404 で旅行が無いと分かった以上、待ちが明けた1枚目も送らない（届いた要求は2回のまま）
    final first = writeTestImage('first.png');
    final second = writeTestImage('second.png', bytes: [...tinyPngBytes, 0]);
    useGalleryReturning([first, second]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    backend.failNext(TripRoute.upload);
    backend.failNext(TripRoute.upload, status: 404, code: 'TRIP_NOT_FOUND', message: '指定された旅行が見つかりません');
    // 3回目の要求（送り直しが送られてしまったとき）も失敗にして、写真が届いて画面に出る（サムネイルのあとの実時間の待ちで落ちる）ことを避ける
    backend.failNext(TripRoute.upload);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await _letUploadFail(tester, backend, 2);
    await tester.pump(const Duration(seconds: 2));
    await _waitRealTime(tester);
    await letFramesRun(tester);

    expect(backend.uploadsReceived, 2);
    expect(find.text('2枚を送信できませんでした（旅行が見つかりません）'), findsOneWidget);
  });

  testWidgets('旅行が消えていて失敗した写真を「閉じる」で消しても、消えた旅行は覚えていて、同じ旅行へ選び直した写真は送らずに失敗にし、「1枚を送信できませんでした（旅行が見つかりません）」を出す', (tester) async {
    // 一区切りや「閉じる」では、消えた旅行を忘れない（忘れるのは「送り直す」を押したとき）。選び直した写真の要求は偽のサーバに届かない
    final first = writeTestImage('first.png');
    useGalleryReturning([first]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);
    backend.trips.clear();
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 1);
    await letFramesRun(tester);
    expect(find.text('1枚を送信できませんでした（旅行が見つかりません）'), findsOneWidget);
    await tester.tap(find.text('閉じる'));
    await letFramesRun(tester);
    expect(find.textContaining('送信できませんでした'), findsNothing);
    final second = writeTestImage('second.png', bytes: [...tinyPngBytes, 0]);
    useGalleryReturning([second]);

    await tester.tap(find.text('写真を追加'));
    await waitUntilFound(tester, find.text('1枚を送信できませんでした（旅行が見つかりません）'));
    await _waitRealTime(tester);

    expect(backend.uploadsReceived, 1);
    expect(find.text('1枚を送信できませんでした（旅行が見つかりません）'), findsOneWidget);
  });

  testWidgets('旅行が消えていて失敗した写真は、旅行が戻ってから「送り直す」で送れて、そのあとに同じ旅行へ選んだ写真も届く（「送り直す」で消えた旅行を忘れる）', (tester) async {
    // 送り直しで届いた写真は、偽のサーバから取り除いておく（別の端末で消された状態）。取り除かないと、読み直した一覧にサムネイルが出て、
    // そのあとの準備の実時間の待ちで、画像のキャッシュが端末の機能（path_provider）を探して落ちる
    final first = writeTestImage('first.png');
    useGalleryReturning([first]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);
    backend.trips.clear();
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 1);
    await letFramesRun(tester);
    expect(find.text('1枚を送信できませんでした（旅行が見つかりません）'), findsOneWidget);
    backend.trips.add(tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0));
    final retryReply = backend.holdNextReply(TripRoute.upload);

    await tester.tap(find.text('送り直す'));
    await waitUntilUploadsReceived(tester, backend, 2);
    backend.photosByTripId[hokkaidoTripId]!.clear();
    retryReply.complete();
    await letFramesRun(tester);
    expect(find.textContaining('送信できませんでした'), findsNothing);
    final second = writeTestImage('second.png', bytes: [...tinyPngBytes, 0]);
    useGalleryReturning([second]);
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, hokkaidoTripId);
    await letFramesRun(tester);

    expect(backend.uploadsReceived, 3);
    expect(backend.photosByTripId[hokkaidoTripId]!.length, 1);
    expect(find.textContaining('送信できませんでした'), findsNothing);
  });

  testWidgets('2枚が別の理由で失敗したときは、バナーに後に失敗した方の理由を添える（先に 413、後に 500 なら、500 の理由）', (tester) async {
    // 同時に送る2枚の応答を保留し、先に 413 の応答を返してから、500 の応答を返す。失敗の順は、応答を返した順で決まる
    final first = writeTestImage('first.png');
    final second = writeTestImage('second.png', bytes: [...tinyPngBytes, 0]);
    useGalleryReturning([first, second]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    backend.failNext(TripRoute.upload, status: 413, code: 'FILE_TOO_LARGE', message: 'ファイルサイズが大きすぎます');
    backend.failNext(TripRoute.upload, status: 500, code: 'INTERNAL_ERROR', message: '写真の保存に失敗しました');
    final tooLargeReply = backend.holdNextReply(TripRoute.upload);
    final serverErrorReply = backend.holdNextReply(TripRoute.upload);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 2);
    await letFramesRun(tester);
    tooLargeReply.complete();
    await letFramesRun(tester);

    serverErrorReply.complete();
    await letFramesRun(tester);

    expect(find.text('2枚を送信できませんでした（$serverErrorMessage）'), findsOneWidget);
  });

  testWidgets('2枚のうち1枚の送信がサーバの失敗（500）になると、送れた1枚だけを「1枚を送信しました」と知らせ、バナーに「1枚を送信できませんでした」と「送り直す」「閉じる」を出す', (tester) async {
    // 500 は自動の送り直しの対象ではない（通信の失敗・429・503 だけが対象）。どちらの1枚が失敗するかは問わず、届いた枚数で見る
    final first = writeTestImage('first.png');
    final second = writeTestImage('second.png', bytes: [...tinyPngBytes, 0]);
    useGalleryReturning([first, second]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    backend.failNext(TripRoute.upload, status: 500, code: 'INTERNAL_ERROR', message: '写真の保存に失敗しました');
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, hokkaidoTripId);
    await letFramesRun(tester);

    expect(backend.photosByTripId[hokkaidoTripId]!.length, 1);
    expect(find.text('1枚を送信できませんでした（$serverErrorMessage）'), findsOneWidget);
    expect(find.text('送り直す'), findsOneWidget);
    expect(find.text('閉じる'), findsOneWidget);
    expect(find.text('1枚を送信しました'), findsOneWidget);
  });

  testWidgets('2枚とも送信がサーバの失敗（500）になると、送れた分が無いので知らせは出さず、バナーに「2枚を送信できませんでした」を出し、「送り直す」で2枚とも届いてバナーが消え、「2枚を送信しました」と知らせる', (tester) async {
    // 送れた分が0枚の間は「N枚を送信しました」を出さない。送り直しで全部届いたときに初めて出る
    final first = writeTestImage('first.png');
    final second = writeTestImage('second.png', bytes: [...tinyPngBytes, 0]);
    useGalleryReturning([first, second]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    backend.failNext(TripRoute.upload, status: 500, code: 'INTERNAL_ERROR', message: '写真の保存に失敗しました');
    backend.failNext(TripRoute.upload, status: 500, code: 'INTERNAL_ERROR', message: '写真の保存に失敗しました');
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 2);
    await letFramesRun(tester);
    expect(find.text('2枚を送信できませんでした（$serverErrorMessage）'), findsOneWidget);
    expect(find.textContaining('を送信しました'), findsNothing);
    expect(backend.photosByTripId[hokkaidoTripId] ?? [], isEmpty);

    await tester.tap(find.text('送り直す'));
    await waitUntilUploaded(tester, backend, hokkaidoTripId, count: 2);
    await letFramesRun(tester);

    expect(find.text('送り直す'), findsNothing);
    expect(find.textContaining('送信できませんでした'), findsNothing);
    expect(find.text('2枚を送信しました'), findsOneWidget);
  });

  testWidgets('送信に失敗した1枚のバナーの「閉じる」を押すと、バナー（「送り直す」も）が消え、失敗した写真は送られないまま', (tester) async {
    // 失敗した項目を列から消すだけで、端末の写真は消えない（選び直せば送れる）
    final first = writeTestImage('first.png');
    final second = writeTestImage('second.png', bytes: [...tinyPngBytes, 0]);
    useGalleryReturning([first, second]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    backend.failNext(TripRoute.upload, status: 500, code: 'INTERNAL_ERROR', message: '写真の保存に失敗しました');
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, hokkaidoTripId);
    await letFramesRun(tester);
    expect(find.text('1枚を送信できませんでした（$serverErrorMessage）'), findsOneWidget);

    await tester.tap(find.text('閉じる'));
    await letFramesRun(tester);

    expect(find.textContaining('送信できませんでした'), findsNothing);
    expect(find.text('送り直す'), findsNothing);
    expect(find.text('閉じる'), findsNothing);
    expect(find.textContaining('送信中'), findsNothing);
    expect(backend.photosByTripId[hokkaidoTripId]!.length, 1);
  });

  testWidgets('京都宛ての写真100枚を準備している間に北海道の詳細を開いても、「写真を準備中」は出ない（旅行一覧は全体を数えるので、戻ると「写真を準備中... k/100」が出る）', (tester) async {
    // 最初の送信の要求が届いた時点で一覧へ戻る。準備はまだ続いている（準備が終わるとバナーは消える）
    useGalleryReturning(writeTestImages(_manyPhotos));
    final backend = FakeTripBackend(trips: [
      tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0),
      tripJson(id: kyotoTripId, name: '京都', photoCount: 0),
    ]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('京都'));
    await letFramesRun(tester);
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 1);
    await tester.pageBack();
    await letFramesRun(tester);
    expect(preparingBanner(_manyPhotos), findsOneWidget);

    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);

    expect(find.byType(TripDetailScreen), findsOneWidget);
    expect(find.textContaining('写真を準備中'), findsNothing);
    // 否定が通るのは準備が終わったからではない（一覧に戻ると、準備はまだ続いている）
    await tester.pageBack();
    await letFramesRun(tester);
    expect(preparingBanner(_manyPhotos), findsOneWidget);
  });

  testWidgets('京都宛ての写真を送っている間に北海道の詳細を開いても、バナーは出ない（旅行詳細は、その旅行宛ての分だけを数える）', (tester) async {
    // 旅行一覧は全体を数えるので、京都宛ての送信中は一覧に「送信中 0/1」が出る。北海道の詳細には、北海道宛ての項目が無いので出ない
    final image = writeTestImage('kyoto.png');
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [
      tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0),
      tripJson(id: kyotoTripId, name: '京都', photoCount: 0),
    ]);
    final reply = backend.holdNextReply(TripRoute.upload);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('京都'));
    await letFramesRun(tester);
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, kyotoTripId);
    await letFramesRun(tester);
    await tester.pageBack();
    await letFramesRun(tester);
    expect(find.text('送信中 0/1'), findsOneWidget);

    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);

    expect(find.byType(TripDetailScreen), findsOneWidget);
    expect(find.textContaining('送信中'), findsNothing);
    reply.complete();
    await letFramesRun(tester);
  });

  testWidgets('この旅行宛ての送信が進んでいる間に「削除」を選ぶと、旅行の削除の確認の前に「送信中の写真があります。送信を止めて削除しますか？」と確かめ、「キャンセル」なら何もせず、送信は続く', (tester) async {
    // 写真が0枚の旅行を使う（サーバの写真のサムネイルを出さないので、実時間を進めても path_provider が要らない）。応答は保留して送信中にする
    final image = writeTestImage('hokkaido.png');
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    final reply = backend.holdNextReply(TripRoute.upload);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 1);
    await letFramesRun(tester);

    await openDeleteDialog(tester);

    expect(inDialog(find.text('送信中の写真があります。送信を止めて削除しますか？')), findsOneWidget);
    expect(inDialog(find.text('キャンセル')), findsOneWidget);
    expect(inDialog(find.text('削除')), findsOneWidget);
    // 旅行の削除のダイアログ（0枚なら「「北海道 2026秋」を削除しますか？」）はまだ出ていない
    expect(find.textContaining('を削除しますか？'), findsNothing);
    expect(find.text('旅行を削除'), findsNothing);

    await tapInDialog(tester, 'キャンセル');

    expect(find.byType(Dialog), findsNothing);
    expect(find.byType(TripDetailScreen), findsOneWidget);
    expect(backend.deletePhotosSent, isEmpty);
    // 送信は続いている。止めていないので、応答が返れば完了と数える
    reply.complete();
    await letFramesRun(tester);
    expect(find.text('1枚を送信しました'), findsOneWidget);
  });

  testWidgets('送信を止めて削除すると、この旅行宛ての残りの写真は送らず、失敗にも完了の知らせにも数えない（送信中だった分の結果も知らせない）', (tester) async {
    // 3枚のうち2枚は同時に送信中（応答を保留）、3枚目は送信待ち。写真が0枚の旅行なので、実時間を進めても path_provider は要らない
    final first = writeTestImage('first.png');
    final second = writeTestImage('second.png', bytes: [...tinyPngBytes, 0]);
    final third = writeTestImage('third.png', bytes: [...tinyPngBytes, 0, 0]);
    useGalleryReturning([first, second, third]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    final firstReply = backend.holdNextReply(TripRoute.upload);
    final secondReply = backend.holdNextReply(TripRoute.upload);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 2);
    await letFramesRun(tester);
    await openDeleteDialog(tester);
    await tapInDialog(tester, '削除');
    await tapInDialog(tester, '削除');
    expect(find.byType(TripDetailScreen), findsNothing);
    expect(find.textContaining('旅行を削除しました'), findsOneWidget);

    firstReply.complete();
    secondReply.complete();
    await _waitRealTime(tester);
    await letFramesRun(tester);
    // スナックバーは順に出るので、「旅行を削除しました」が消えるまで進めてから、送信の知らせが出ていないことを見る
    await tester.pump(const Duration(seconds: 5));
    await letFramesRun(tester);

    expect(find.textContaining('旅行を削除しました'), findsNothing);
    expect(backend.uploadsReceived, 2);
    expect(find.textContaining('送信できませんでした'), findsNothing);
    expect(find.textContaining('枚を送信しました'), findsNothing);
  });

  testWidgets('送信を止めるかの確認で「削除」を選んでも、旅行の削除のダイアログで「キャンセル」したら、送信は続ける（残りの写真も送り、完了を知らせる）', (tester) async {
    // 3枚のうち2枚は同時に送信中（応答を保留）、3枚目は送信待ち。写真が0枚の旅行なので、実時間を進めても path_provider は要らない
    final first = writeTestImage('first.png');
    final second = writeTestImage('second.png', bytes: [...tinyPngBytes, 0]);
    final third = writeTestImage('third.png', bytes: [...tinyPngBytes, 0, 0]);
    useGalleryReturning([first, second, third]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    final firstReply = backend.holdNextReply(TripRoute.upload);
    final secondReply = backend.holdNextReply(TripRoute.upload);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 2);
    await letFramesRun(tester);
    await openDeleteDialog(tester);
    await tapInDialog(tester, '削除');
    expect(find.textContaining('を削除しますか？'), findsOneWidget);

    await tapInDialog(tester, 'キャンセル');

    expect(find.byType(Dialog), findsNothing);
    expect(find.byType(TripDetailScreen), findsOneWidget);
    expect(backend.deletePhotosSent, isEmpty);
    firstReply.complete();
    secondReply.complete();
    // 届いた写真は偽のサーバから取り除いておく（別の端末で消された状態）。取り除かないと、読み直した一覧にサムネイルが出て、
    // 実時間の待ちで画像のキャッシュが端末の機能（path_provider）を探して落ちる。画面は進めずに、実時間だけで3枚目の到着を待つ
    await waitUntilUploadsReceived(tester, backend, 3);
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 200)));
    backend.photosByTripId[hokkaidoTripId]!.clear();
    await letFramesRun(tester);
    expect(backend.uploadsReceived, 3);
    expect(find.text('3枚を送信しました'), findsOneWidget);
  });

  testWidgets('写真を準備中のあいだも、この旅行宛ての送信が進んでいるものとして、「削除」を選ぶと旅行の削除の前に「送信中の写真があります。送信を止めて削除しますか？」と確かめる', (tester) async {
    // 準備を止める: 位置情報のある写真の Geocoder が固まる（5秒の時間切れまで準備中のまま。フェイクの時間で進める）。まだ1枚も送信の列に入っていない
    final geocoding = useFakeGeocoding(hangs: true);
    final image = writeTestImage('nagano.jpg', bytes: exifJpegBytes(latitude: [36, 39, 0], longitude: [138, 11, 0]));
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    await tester.tap(find.text('写真を追加'));
    await waitUntilLookedUp(tester, geocoding, 1);
    await tester.pump();
    expect(backend.uploadsReceived, 0);

    await openDeleteDialog(tester);

    expect(inDialog(find.text('送信中の写真があります。送信を止めて削除しますか？')), findsOneWidget);
    expect(find.textContaining('を削除しますか？'), findsNothing);
    // 後片付け: 確認を閉じ、準備の時間切れを過ぎて送信を終わらせる（時間切れのタイマーを、テストの終わりに残さない）。
    // 届いた写真は偽のサーバから取り除く（サムネイルを出して、実時間の待ちで path_provider を探して落ちないように）
    await tapInDialog(tester, 'キャンセル');
    await tester.pump(const Duration(seconds: 5));
    await waitUntilUploadsReceived(tester, backend, 1);
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 200)));
    backend.photosByTripId[hokkaidoTripId]?.clear();
    await letFramesRun(tester);
  });

  testWidgets('この旅行宛ての写真がサーバの失敗（500）で失敗しているだけなら、「削除」を選んでも送信を止める確認は出さず、旅行の削除のダイアログを出す', (tester) async {
    // 失敗した写真は自動では送り直されず、進行中の送信ではない（バナーの「送り直す」「閉じる」は利用者が選ぶ）
    final image = writeTestImage('hokkaido.png');
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    backend.failNext(TripRoute.upload, status: 500, code: 'INTERNAL_ERROR', message: '写真の保存に失敗しました');
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 1);
    await letFramesRun(tester);
    expect(find.text('1枚を送信できませんでした（$serverErrorMessage）'), findsOneWidget);

    await openDeleteDialog(tester);

    expect(find.text('送信中の写真があります。送信を止めて削除しますか？'), findsNothing);
    expect(find.textContaining('を削除しますか？'), findsOneWidget);
  });

  testWidgets('写真を準備している最中に送信を止めて削除したら、準備が済んでもその写真は送らず、失敗にも完了の知らせにも数えない', (tester) async {
    // 準備を止める: 位置情報のある写真の Geocoder が固まる（フェイクの時間で5秒進めると準備が済む）。準備中に削除を確定し、そのあとで準備を済ませる
    final geocoding = useFakeGeocoding(hangs: true);
    final image = writeTestImage('nagano.jpg', bytes: exifJpegBytes(latitude: [36, 39, 0], longitude: [138, 11, 0]));
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    await tester.tap(find.text('写真を追加'));
    await waitUntilLookedUp(tester, geocoding, 1);
    await tester.pump();
    await openDeleteDialog(tester);
    await tapInDialog(tester, '削除');
    await tapInDialog(tester, '削除');
    expect(find.byType(TripDetailScreen), findsNothing);
    expect(find.textContaining('旅行を削除しました'), findsOneWidget);

    await tester.pump(const Duration(seconds: 5));
    await _waitRealTime(tester);
    // スナックバーは順に出るので、「旅行を削除しました」が消えるまで進めてから、送信の知らせが出ていないことを見る
    await tester.pump(const Duration(seconds: 5));
    await letFramesRun(tester);

    expect(backend.uploadsReceived, 0);
    expect(find.textContaining('送信できませんでした'), findsNothing);
    expect(find.textContaining('枚を送信しました'), findsNothing);
  });

  testWidgets('送り直しを待っている写真があるときに送信を止めて削除したら、待ちが過ぎても送り直さない', (tester) async {
    // 1回目が 503 で失敗して2秒の待ちに入る。待ちの間（2秒より手前）に削除を確定する。
    // openDeleteDialog や tapInDialog は画面を1.5秒ずつ進めて待ちを過ぎてしまうので、ここでは300ミリ秒ずつ進める
    final image = writeTestImage('hokkaido.png');
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    backend.failNext(TripRoute.upload);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    await tester.tap(find.text('写真を追加'));
    await _letUploadFail(tester, backend, 1);

    await tester.tap(find.byIcon(Icons.more_vert));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    await tester.tap(find.text('削除'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    await tester.tap(inDialog(find.text('削除')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    await tester.tap(inDialog(find.text('削除')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    await tester.pump(const Duration(seconds: 3));
    expect(find.byType(TripDetailScreen), findsNothing);
    await _waitRealTime(tester);

    expect(backend.uploadsReceived, 1);
  });
}
