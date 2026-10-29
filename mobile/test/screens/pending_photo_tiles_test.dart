import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show MethodChannel;
import 'package:flutter_test/flutter_test.dart';

import '../helpers/app_test_helpers.dart';
import '../helpers/gallery_test_helpers.dart';
import '../helpers/image_compress_test_helpers.dart';
import '../helpers/trip_test_helpers.dart';

// 送信中・失敗の写真(端末の画像)を、写真のグリッドにサーバの写真と並べて出す振る舞いを確かめる
// （docs/03_screen_design.md §4.4）。入口は旅行詳細と「旅行に属さない写真」の画面。
//
// このファイルのテストは、サーバの写真のサムネイルを出したまま、実時間を進める(tester.runAsync。送信の要求が届くのを待つため)。
// 画像のキャッシュ(flutter_cache_manager)は、そのとき端末のディレクトリを path_provider で探すので、
// ファイルの全体で一時ディレクトリに差し替える(setUpAll)。キャッシュの管理は最初に開いたディレクトリを覚えて共有するため、
// テストごとに差し替えると互いに干渉する。trip_detail_screen_test.dart に置かないのも同じ理由
// (あちらは画像の取得まで進まないテストの集まりで、path_provider を差し替えない)

const _apiKey = 'test-key';

/// グリッドの中の端末の画像のマス（FileImage か MemoryImage の画像）。サーバの写真は CachedNetworkImage で、どちらでもない。
/// 画像の読み込みの最適化で FileImage が ResizeImage（cacheWidth を指定したとき）に包まれても、見た目は変わらないので、包まれていてもいなくても数える
final deviceImageTiles = find.descendant(
    of: photoGridScroll(),
    matching: find.byWidgetPredicate((widget) {
      if (widget is! Image) return false;
      // 端末の画像は、ファイルから読むか、準備で作ったサムネイルのバイト列から出す（縮小の包みの有無は問わない）
      final image = widget.image;
      final provider = image is ResizeImage ? image.imageProvider : image;
      return provider is FileImage || provider is MemoryImage;
    }));

/// グリッドの中の回転する印（CircularProgressIndicator）。送信中の端末の画像のマスに付く
/// （サーバの写真のマスの待ち表示は印ではなく色の面で、進み具合のバナーの印はグリッドの外）
final spinnerInGrid = find.descendant(
    of: photoGridScroll(), matching: find.byType(CircularProgressIndicator));

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Directory cacheDirectory;
  const channel = MethodChannel('plugins.flutter.io/path_provider');

  setUpAll(() {
    cacheDirectory =
        Directory.systemTemp.createTempSync('snaplant_image_cache');
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async => cacheDirectory.path);
  });

  tearDownAll(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
    try {
      cacheDirectory.deleteSync(recursive: true);
    } catch (_) {
      // キャッシュの掃除のタイマーなどが使っている間は消せないことがある。一時ディレクトリなので残っても構わない
    }
  });

  testWidgets('この旅行宛てに送信中の写真があると、サーバの写真の後ろに端末の画像のマスを回転する印付きで並べる',
      (tester) async {
    // 端末の画像のマスは、グリッドの中の回転する印（CircularProgressIndicator）で見分ける。サーバの写真のマスの待ち表示は印ではなく色の面で、
    // 進み具合のバナーの印はグリッドの外なので、グリッドの中の印は端末の画像のマスだけに付く。
    // 並びは、サーバの写真の読み上げ用ラベルのマスの位置と、印の位置を比べて見る
    useFakeImageCompress();
    final semantics = tester.ensureSemantics();
    final image = writeTestImage('hokkaido.png');
    useGalleryReturning([image]);
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
    final release = Completer<void>();
    backend.holds[TripRoute.upload] = release.future;
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(photoThumbnail('2026年10月5日 12:30'), findsOneWidget);
    expect(spinnerInGrid, findsNothing);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 1);
    await letFramesRun(tester);

    expect(spinnerInGrid, findsOneWidget);
    final serverTile = tester.getRect(photoThumbnail('2026年10月5日 12:30'));
    final spinner = tester.getCenter(spinnerInGrid);
    // サーバの写真と同じ行で、その右隣（3列のグリッドの2列目）に並ぶ
    expect(spinner.dy, greaterThan(serverTile.top));
    expect(spinner.dy, lessThan(serverTile.bottom));
    expect(spinner.dx, greaterThan(serverTile.right));
    // 後始末: 送信を終わらせ、完了の知らせ（スナックバー）と画像のキャッシュの掃除のタイマー
    // （flutter_cache_manager の CacheStore.cleanupRunMinInterval。3.4.1 で 10 秒）が過ぎるまで進める（タイマーを残して終えない）
    release.complete();
    await waitUntilUploaded(tester, backend, hokkaidoTripId, count: 2);
    await letFramesRun(tester);
    await tester.pump(const Duration(seconds: 20));
    semantics.dispose();
  });

  testWidgets('送信に失敗した写真は、サーバの写真の後ろに端末の画像のマスを「!」付きで並べ、回転する印は付けない',
      (tester) async {
    // 失敗は、自動では送り直さない 500。端末の画像のマスは、グリッドの中の「!」で見分ける。
    // 並びは、サーバの写真の読み上げ用ラベルのマスの位置と、「!」の位置を比べて見る
    useFakeImageCompress();
    final semantics = tester.ensureSemantics();
    final image = writeTestImage('hokkaido.png');
    useGalleryReturning([image]);
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
    backend.failNext(TripRoute.upload,
        status: 500, code: 'INTERNAL_ERROR', message: '写真の保存に失敗しました');
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    final markInGrid =
        find.descendant(of: photoGridScroll(), matching: find.text('!'));

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 1);
    await waitUntilFound(tester, find.textContaining('1枚を送信できませんでした'));
    await letFramesRun(tester);

    expect(markInGrid, findsOneWidget);
    expect(spinnerInGrid, findsNothing);
    final serverTile = tester.getRect(photoThumbnail('2026年10月5日 12:30'));
    final mark = tester.getCenter(markInGrid);
    // サーバの写真と同じ行で、その右隣（3列のグリッドの2列目）に並ぶ
    expect(mark.dy, greaterThan(serverTile.top));
    expect(mark.dy, lessThan(serverTile.bottom));
    expect(mark.dx, greaterThan(serverTile.right));
    // 後始末: 失敗の行を「閉じる」で消して列を空にし、画像のキャッシュの掃除のタイマーが過ぎるまで進める
    await tester.tap(find.text('閉じる'));
    await letFramesRun(tester);
    await tester.pump(const Duration(seconds: 20));
    semantics.dispose();
  });

  testWidgets('送れた写真は一区切りまで印を付けずに端末の画像のまま並べ、一区切りで一覧を取り直してサーバの写真として並び直す',
      (tester) async {
    // 2枚を送り、1枚目は送れて、2枚目の応答は止める（一区切りは、送信の列が空になったとき）。
    // 端末の画像のマスは、グリッドの中の FileImage の画像で見分ける（サーバの写真は CachedNetworkImage で、FileImage ではない）。
    // 2枚の画像は撮影日時を持たないので、サーバの写真のうち送った2枚は「撮影日時なし」のラベルのマスで数える
    // （旅行の見出しの「N枚 · 撮影日時なし」と混ざらないよう、ラベルの先頭で探す）
    useFakeImageCompress();
    final semantics = tester.ensureSemantics();
    final first = writeTestImage('first.png', bytes: [...tinyPngBytes, 1]);
    final second = writeTestImage('second.png', bytes: [...tinyPngBytes, 2]);
    useGalleryReturning([first, second]);
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
    // 1回目の応答はすぐ返し、2回目の応答だけ止める（要求は届いた順に使う）
    backend.holdNextReply(TripRoute.upload).complete();
    final release = backend.holdNextReply(TripRoute.upload);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    final markInGrid =
        find.descendant(of: photoGridScroll(), matching: find.text('!'));
    final sentPhotoTiles = find.bySemanticsLabel(RegExp('^撮影日時なし'));

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 2);
    await letFramesRun(tester);

    // 一区切りの前: 送れた1枚目も端末の画像のまま並び、印が付くのは送信中の2枚目だけ
    expect(deviceImageTiles, findsNWidgets(2));
    expect(spinnerInGrid, findsOneWidget);
    expect(markInGrid, findsNothing);
    expect(sentPhotoTiles, findsNothing);

    release.complete();
    await waitUntilFound(tester, sentPhotoTiles);
    await letFramesRun(tester);

    // 一区切りの後: 一覧を取り直してサーバの写真3枚になり、端末の画像と印は残らない
    expect(photoThumbnail('2026年10月5日 12:30'), findsOneWidget);
    expect(sentPhotoTiles, findsNWidgets(2));
    expect(deviceImageTiles, findsNothing);
    expect(spinnerInGrid, findsNothing);
    expect(markInGrid, findsNothing);
    // 後始末: 画像のキャッシュの掃除のタイマーが過ぎるまで進める
    await tester.pump(const Duration(seconds: 20));
    semantics.dispose();
  });

  testWidgets('送信の途中で一覧を読み直しても、送れた写真をサーバの写真と端末の画像の二重に並べない', (tester) async {
    // 2枚を送り、1枚目は送れて（サーバの一覧に入る）、2枚目はサーバに入る前で止める（要求の処理自体を止めるので、2枚目はサーバの一覧に入らない）。一区切りの前にグリッドを下に引っ張って読み直す。
    // 送れた1枚目はサーバの写真として1回だけ並び、端末の画像のマスは送信中の2枚目の1つだけになる
    useFakeImageCompress();
    final semantics = tester.ensureSemantics();
    final first = writeTestImage('first.png', bytes: [...tinyPngBytes, 1]);
    final second = writeTestImage('second.png', bytes: [...tinyPngBytes, 2]);
    useGalleryReturning([first, second]);
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
    final release = Completer<void>();
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    final sentPhotoTiles = find.bySemanticsLabel(RegExp('^撮影日時なし'));
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 1);
    backend.holds[TripRoute.upload] = release.future;
    await waitUntilUploadsReceived(tester, backend, 2);
    await letFramesRun(tester);
    expect(deviceImageTiles, findsNWidgets(2));

    await tester.drag(photoGridScroll(), const Offset(0, 600));
    await letFramesRun(tester);

    expect(sentPhotoTiles, findsOneWidget);
    expect(deviceImageTiles, findsOneWidget);
    expect(spinnerInGrid, findsOneWidget);
    // 後始末: 送信を終わらせ、完了の知らせと画像のキャッシュの掃除のタイマーが過ぎるまで進める
    release.complete();
    await waitUntilUploaded(tester, backend, hokkaidoTripId, count: 3);
    await letFramesRun(tester);
    await tester.pump(const Duration(seconds: 20));
    semantics.dispose();
  });

  testWidgets('送信の途中で読み直してサーバの写真として並んだ写真を消しても、端末の画像として並べ直さない', (tester) async {
    // 2枚を送り、1枚目は送れて、2枚目はサーバに入る前で止める（一区切りは来ない）。グリッドを読み直すと送れた1枚目がサーバの写真として並ぶ。
    // それを写真ビューアで消しても、送信の列に残っている1枚目を端末の画像として並べ直さない（端末の画像のマスは送信中の2枚目の1つだけ）。
    // 送れた1枚目は撮影日時を持たないので、「撮影日時なし」のラベルのマスで見分ける。並びの最後なので、消すとビューアは閉じて旅行詳細へ戻る
    useFakeImageCompress();
    final semantics = tester.ensureSemantics();
    final first = writeTestImage('first.png', bytes: [...tinyPngBytes, 1]);
    final second = writeTestImage('second.png', bytes: [...tinyPngBytes, 2]);
    useGalleryReturning([first, second]);
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
    final release = Completer<void>();
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    final sentPhotoTiles = find.bySemanticsLabel(RegExp('^撮影日時なし'));
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 1);
    backend.holds[TripRoute.upload] = release.future;
    await waitUntilUploadsReceived(tester, backend, 2);
    await letFramesRun(tester);
    await tester.drag(photoGridScroll(), const Offset(0, 600));
    await letFramesRun(tester);
    expect(sentPhotoTiles, findsOneWidget);
    expect(deviceImageTiles, findsOneWidget);
    await tester.tap(sentPhotoTiles);
    await letFramesRun(tester);
    await tester.tap(
        find.descendant(of: find.byType(AppBar), matching: find.text('削除')));
    await letFramesRun(tester);

    await tapInDialog(tester, '削除');

    expect(find.byType(PageView), findsNothing);
    expect(sentPhotoTiles, findsNothing);
    expect(deviceImageTiles, findsOneWidget);
    expect(spinnerInGrid, findsOneWidget);
    // 後始末: 送信を終わらせ、完了の知らせと画像のキャッシュの掃除のタイマーが過ぎるまで進める
    release.complete();
    await waitUntilUploaded(tester, backend, hokkaidoTripId, count: 2);
    await letFramesRun(tester);
    await tester.pump(const Duration(seconds: 20));
    semantics.dispose();
  });

  testWidgets('他の旅行宛てに送信中の写真は、別の旅行の詳細には端末の画像のマスとして並べない', (tester) async {
    // 北海道の詳細から送って応答を止めたまま、一覧に戻って京都を開く。京都のグリッドには、サーバの写真（1枚）のマスだけが並ぶ。
    // 北海道の詳細を開き直すと端末の画像のマスが並ぶので、「並べない」が項目が無いせいではないことも確かめる
    useFakeImageCompress();
    final semantics = tester.ensureSemantics();
    final image = writeTestImage('hokkaido.png');
    useGalleryReturning([image]);
    final backend = FakeTripBackend(
      trips: [
        hokkaidoTrip(photoCount: 1),
        tripJson(id: kyotoTripId, name: '京都', photoCount: 1),
      ],
      functionKey: _apiKey,
      photosByTripId: {
        hokkaidoTripId: [
          photoJson(
              number: 1, tripId: hokkaidoTripId, takenAt: '2026-10-05T12:30:15')
        ],
        kyotoTripId: [
          photoJson(
              number: 2, tripId: kyotoTripId, takenAt: '2026-10-06T09:00:00')
        ],
      },
    );
    // 要求の処理ごと止める（サーバはまだ写真を保存していない）。応答だけを止めると、北海道を開き直したときに
    // 写真がサーバの写真として並び、送信中の端末の画像としては並ばない（二重に並べないため）
    final release = Completer<void>();
    backend.holds[TripRoute.upload] = release.future;
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 1);
    await letFramesRun(tester);
    expect(deviceImageTiles, findsOneWidget);

    await tapBack(tester);
    await letFramesRun(tester);
    await tester.tap(find.text('京都'));
    await letFramesRun(tester);

    expect(photoThumbnail('2026年10月6日 09:00'), findsOneWidget);
    expect(deviceImageTiles, findsNothing);

    await tapBack(tester);
    await letFramesRun(tester);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(deviceImageTiles, findsOneWidget);
    // 後始末: 送信を終わらせ、完了の知らせと画像のキャッシュの掃除のタイマーが過ぎるまで進める
    release.complete();
    await waitUntilUploaded(tester, backend, hokkaidoTripId, count: 2);
    await letFramesRun(tester);
    await tester.pump(const Duration(seconds: 20));
    semantics.dispose();
  });

  testWidgets('「旅行に属さない写真」の画面では、旅行を指定せずに送信中の写真だけを、サーバの写真の後ろに端末の画像のマスで並べる',
      (tester) async {
    // 先に北海道の詳細から1枚を送り（応答は止める）、一覧に戻って「旅行に属さない写真」を開き、そこから別の1枚を送る（これも止める）。
    // この画面に並ぶ端末の画像のマスは後から送った1枚だけで、北海道宛ての1枚は並ばない
    useFakeImageCompress();
    final semantics = tester.ensureSemantics();
    final forTrip = writeTestImage('hokkaido.png');
    final forNone = writeTestImage('none.png', bytes: [...tinyPngBytes, 7]);
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 0)],
      unassignedPhotoCount: 1,
      functionKey: _apiKey,
      photosByTripId: {
        'none': [photoJson(number: 1, takenAt: '2026-10-05T12:30:15')],
      },
    );
    final releaseForTrip = backend.holdNextReply(TripRoute.upload);
    final releaseForNone = backend.holdNextReply(TripRoute.upload);
    await openTripsTab(tester, backend);
    useGalleryReturning([forTrip]);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 1);
    await letFramesRun(tester);
    await tapBack(tester);
    await letFramesRun(tester);
    await tester.tap(find.text('旅行に属さない写真'));
    await letFramesRun(tester);
    expect(photoThumbnail('2026年10月5日 12:30'), findsOneWidget);
    expect(deviceImageTiles, findsNothing);

    useGalleryReturning([forNone]);
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 2);
    await letFramesRun(tester);

    expect(deviceImageTiles, findsOneWidget);
    expect(spinnerInGrid, findsOneWidget);
    final serverTile = tester.getRect(photoThumbnail('2026年10月5日 12:30'));
    final spinner = tester.getCenter(spinnerInGrid);
    // サーバの写真と同じ行で、その右隣（3列のグリッドの2列目）に並ぶ
    expect(spinner.dy, greaterThan(serverTile.top));
    expect(spinner.dy, lessThan(serverTile.bottom));
    expect(spinner.dx, greaterThan(serverTile.right));
    // 後始末: 2枚とも送信を終わらせ、完了の知らせと画像のキャッシュの掃除のタイマーが過ぎるまで進める
    releaseForTrip.complete();
    releaseForNone.complete();
    await waitUntilUploaded(tester, backend, 'none', count: 2);
    await waitUntilUploaded(tester, backend, hokkaidoTripId, count: 1);
    await letFramesRun(tester);
    await tester.pump(const Duration(seconds: 20));
    semantics.dispose();
  });

  testWidgets('写真が0枚の旅行でも、並べる端末の画像があれば「まだ写真がありません」ではなく端末の画像のマスを出す',
      (tester) async {
    // 端末の画像のマスは、グリッドの中の回転する印（CircularProgressIndicator）で見分ける。
    // 空の表示はグリッドではなく文言なので、印がグリッドの中にあれば、空の表示ではなくグリッドが出ている
    useFakeImageCompress();
    final semantics = tester.ensureSemantics();
    final image = writeTestImage('hokkaido.png');
    useGalleryReturning([image]);
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 0)],
      functionKey: _apiKey,
      photosByTripId: {hokkaidoTripId: []},
    );
    final release = backend.holdNextReply(TripRoute.upload);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('まだ写真がありません'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 1);
    await letFramesRun(tester);

    expect(find.text('まだ写真がありません'), findsNothing);
    expect(spinnerInGrid, findsOneWidget);
    // 後始末: 送信を終わらせ、完了の知らせと画像のキャッシュの掃除のタイマーが過ぎるまで進める
    release.complete();
    await waitUntilUploaded(tester, backend, hokkaidoTripId, count: 1);
    await letFramesRun(tester);
    await tester.pump(const Duration(seconds: 20));
    semantics.dispose();
  });

  testWidgets('サーバの写真の続きのページが残っている間は端末の画像を並べず、最後のページまで読んだら最後のサーバの写真の後ろに並べる',
      (tester) async {
    // 33枚の旅行（1ページ30枚、10:01〜10:33）。2ページ目の応答を止めたまま、1枚を送って送信中にする。
    // 端末の画像のマスは、グリッドの中の回転する印（CircularProgressIndicator）で見分ける。
    // 「並べない」が組み立てられていないだけで通らないよう、グリッドを下端まで送ってから確かめる
    useFakeImageCompress();
    final semantics = tester.ensureSemantics();
    final image = writeTestImage('hokkaido.png');
    useGalleryReturning([image]);
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 33)],
      functionKey: _apiKey,
      pageSize: 30,
      photosByTripId: {
        hokkaidoTripId: [
          for (var n = 1; n <= 33; n++)
            photoJson(
                number: n,
                tripId: hokkaidoTripId,
                takenAt: '2026-10-05T10:${n.toString().padLeft(2, '0')}:00'),
        ],
      },
    );
    // 要求の処理ごと止める（サーバはまだ写真を保存していない）。応答だけを止めると、2ページ目に写真が入り、
    // サーバの写真として並んで端末の画像としては並ばない（二重に並べないため）
    final releaseUpload = Completer<void>();
    backend.holds[TripRoute.upload] = releaseUpload.future;
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    final releasePage = Completer<void>();
    backend.holds[TripRoute.photos] = releasePage.future;
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 1);
    await letFramesRun(tester);

    await tester.drag(photoGridScroll(), const Offset(0, -5000));
    await letFramesRun(tester);

    // 2ページ目はまだ届いていない: 下端まで送っても端末の画像のマスは出ない
    expect(photoThumbnail('2026年10月5日 10:30'), findsOneWidget);
    expect(spinnerInGrid, findsNothing);

    releasePage.complete();
    await letFramesRun(tester);
    await tester.drag(photoGridScroll(), const Offset(0, -5000));
    await letFramesRun(tester);

    // 最後のページまで読んだ後: 端末の画像のマスが1つ、最後のサーバの写真（10:33）の後ろ（次の行）に並ぶ
    expect(spinnerInGrid, findsOneWidget);
    final lastServerTile = tester.getRect(photoThumbnail('2026年10月5日 10:33'));
    expect(
        tester.getCenter(spinnerInGrid).dy, greaterThan(lastServerTile.bottom));
    // 後始末: 送信を終わらせ、完了の知らせと画像のキャッシュの掃除のタイマーが過ぎるまで進める
    releaseUpload.complete();
    await waitUntilUploaded(tester, backend, hokkaidoTripId, count: 34);
    await letFramesRun(tester);
    await tester.pump(const Duration(seconds: 20));
    semantics.dispose();
  });
  testWidgets('旅行詳細でカテゴリを絞り込んでいる間は、送れなかった写真の端末の画像のマスを並べず、「すべて」に戻すと並べる',
      (tester) async {
    // 送れなかった写真はまだ分類されていないので、「すべて」のときだけ並べる（docs/03_screen_design.md §5.3）。
    // 失敗は、自動では送り直さない 500。「すべて」に戻すと並ぶことで、「並べない」が項目の無いせいではないことも確かめる
    useFakeImageCompress();
    final semantics = tester.ensureSemantics();
    final image = writeTestImage('hokkaido.png');
    useGalleryReturning([image]);
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 1)],
      functionKey: _apiKey,
      photosByTripId: {
        hokkaidoTripId: [
          photoJson(
              number: 1, tripId: hokkaidoTripId, takenAt: '2026-10-05T12:30:15')
            ..['category'] = 'food'
        ],
      },
    );
    backend.failNext(TripRoute.upload,
        status: 500, code: 'INTERNAL_ERROR', message: '写真の保存に失敗しました');
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    final markInGrid =
        find.descendant(of: photoGridScroll(), matching: find.text('!'));
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 1);
    await waitUntilFound(tester, find.textContaining('1枚を送信できませんでした'));
    await letFramesRun(tester);
    expect(markInGrid, findsOneWidget);

    await tester.tap(find.widgetWithText(ChoiceChip, '食べ物'));
    await letFramesRun(tester);

    expect(photoThumbnail('2026年10月5日 12:30'), findsOneWidget);
    expect(markInGrid, findsNothing);
    await tester.tap(find.widgetWithText(ChoiceChip, 'すべて'));
    await letFramesRun(tester);
    expect(markInGrid, findsOneWidget);
    // 後始末: 失敗の行を「閉じる」で消して列を空にし、画像のキャッシュの掃除のタイマーが過ぎるまで進める
    await tester.tap(find.text('閉じる'));
    await letFramesRun(tester);
    await tester.pump(const Duration(seconds: 20));
    semantics.dispose();
  });

  testWidgets('図鑑の項目詳細には、旅行を指定せずに送れなかった写真の端末の画像のマスを並べない', (tester) async {
    // 送信中の写真はまだ識別されていないので、項目詳細には並べない（docs/03_screen_design.md §6.2）
    useFakeImageCompress();
    final semantics = tester.ensureSemantics();
    final image = writeTestImage('unassigned.png');
    useGalleryReturning([image]);
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 0)],
      functionKey: _apiKey,
      unassignedPhotoCount: 1,
      catalogEntriesByKind: {
        'plant': [catalogEntryJson('plant', 'ソメイヨシノ')],
      },
      photosByTripId: {
        hokkaidoTripId: [],
        'none': [
          identifiedPhotoJson(
              number: 1,
              kind: 'plant',
              name: 'ソメイヨシノ',
              takenAt: '2026-10-05T12:30:15')
        ],
      },
    );
    backend.failNext(TripRoute.upload,
        status: 500, code: 'INTERNAL_ERROR', message: '写真の保存に失敗しました');
    await openTripsTab(tester, backend);
    await tester.tap(find.text('旅行に属さない写真'));
    await letFramesRun(tester);
    final markInGrid =
        find.descendant(of: photoGridScroll(), matching: find.text('!'));
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 1);
    await waitUntilFound(tester, find.textContaining('1枚を送信できませんでした'));
    await letFramesRun(tester);
    expect(markInGrid, findsOneWidget);
    await tapBack(tester);
    await letFramesRun(tester);

    await tester.tap(find.descendant(
        of: find.byType(NavigationBar), matching: find.text('図鑑')));
    await letFramesRun(tester);
    await tester.tap(find.text('ソメイヨシノ'));
    await letFramesRun(tester);

    expect(photoThumbnail('2026年10月5日 12:30'), findsOneWidget);
    expect(markInGrid, findsNothing);
    // 後始末: 旅行のタブの一覧に戻り、失敗の行を「閉じる」で消して列を空にし、画像のキャッシュの掃除のタイマーが過ぎるまで進める
    await tapBack(tester);
    await letFramesRun(tester);
    await tester.tap(find.text('旅行'));
    await letFramesRun(tester);
    await tester.tap(find.text('閉じる'));
    await letFramesRun(tester);
    await tester.pump(const Duration(seconds: 20));
    semantics.dispose();
  });
}
