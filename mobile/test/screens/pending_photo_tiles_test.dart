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
// （docs/travel-album/03_screen_design.md §4.4）。入口は旅行詳細と「旅行に属さない写真」の画面。
//
// このファイルのテストは、サーバの写真のサムネイルを出したまま、実時間を進める(tester.runAsync。送信の要求が届くのを待つため)。
// 画像のキャッシュ(flutter_cache_manager)は、そのとき端末のディレクトリを path_provider で探すので、
// ファイルの全体で一時ディレクトリに差し替える(setUpAll)。キャッシュの管理は最初に開いたディレクトリを覚えて共有するため、
// テストごとに差し替えると互いに干渉する。trip_detail_screen_test.dart に置かないのも同じ理由
// (あちらは画像の取得まで進まないテストの集まりで、path_provider を差し替えない)

const _apiKey = 'test-key';

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
    final spinnerInGrid = find.descendant(
        of: find.byType(GridView),
        matching: find.byType(CircularProgressIndicator));
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
        find.descendant(of: find.byType(GridView), matching: find.text('!'));
    final spinnerInGrid = find.descendant(
        of: find.byType(GridView),
        matching: find.byType(CircularProgressIndicator));

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
}
