import 'dart:io';
import 'dart:ui' show SemanticsFlag;

import 'package:flutter/services.dart' show MethodChannel;
import 'package:flutter_test/flutter_test.dart';

import '../helpers/app_test_helpers.dart';
import '../helpers/gallery_test_helpers.dart';
import '../helpers/image_compress_test_helpers.dart';
import '../helpers/trip_test_helpers.dart';

// 複数選択と、旅行への出し入れ・削除（docs/03_screen_design.md §4.8）を、利用者から見た振る舞いで確かめる。
// 旅行の API は偽のサーバ（helpers の FakeTripBackend）。アプリ全体を開いて、旅行一覧から旅行詳細（または旅行に属さない写真の画面）へ進む。
// この節のほかのテストは、まだ trip_detail_screen_test.dart にある（節ごとに分ける前からあるファイル）

void main() {
  testWidgets('選択モード中に下に引っ張って読み直すと、別の端末で消された写真は選択から外れ、選択モードのまま残りの写真は選んだままになり、削除の確認も残りの枚数で出る', (tester) async {
    // 選択中かどうかは、サムネイルの読み上げ用ラベルを持つ Semantics の「選択中」の状態で見る（枚数だけでは、どの写真が残ったかを取り違えても通る）
    final semantics = tester.ensureSemantics();
    bool selected(String label) => tester.getSemantics(photoThumbnail(label)).hasFlag(SemanticsFlag.isSelected);
    final backend = FakeTripBackend(
      trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 3)],
      photosByTripId: {
        hokkaidoTripId: [
          photoJson(number: 1, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:01:00'),
          photoJson(number: 2, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:02:00'),
          photoJson(number: 3, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:03:00'),
        ],
      },
    );
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    await tester.longPress(photoThumbnail('2026年10月5日 10:01'));
    await letFramesRun(tester);
    await tester.tap(photoThumbnail('2026年10月5日 10:02'));
    await letFramesRun(tester);
    expect(find.text('2枚を選択中'), findsOneWidget);
    // 別の端末で、選んでいた 10:02 の写真が消された（偽のサーバの旅行の枚数も1枚減らす）
    backend.photosByTripId[hokkaidoTripId]!.removeAt(1);
    backend.trips.single['photoCount'] = (backend.trips.single['photoCount'] as int) - 1;

    await tester.drag(photoGridScroll(), const Offset(0, 600));
    await letFramesRun(tester);

    expect(photoThumbnail('2026年10月5日 10:02'), findsNothing);
    expect(find.text('1枚を選択中'), findsOneWidget);
    expect([selected('2026年10月5日 10:01'), selected('2026年10月5日 10:03')], [true, false]);
    await tester.tap(find.text('削除'));
    await letFramesRun(tester);
    expect(find.text('1枚の写真を削除しますか？\nこの操作は元に戻せません。'), findsOneWidget);
    semantics.dispose();
  });

  testWidgets('選択モード中に下に引っ張って読み直すと、読み直しで捨てた続きのページで選んでいた写真も選択から外れる', (tester) async {
    // 1ページ30枚にして、31〜33枚目を続きのページに置く。読み直しは先頭のページだけを読み、続きのページは捨てる（§3）。
    // 先頭のページで画面が埋まる枚数にする（埋まらないと、グリッドが続きのページをすぐに読み直す）
    final backend = FakeTripBackend(
      trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 33)],
      pageSize: 30,
      photosByTripId: {
        hokkaidoTripId: [
          for (var n = 1; n <= 33; n++)
            photoJson(number: n, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:${n.toString().padLeft(2, '0')}:00'),
        ],
      },
    );
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    // 下端まで送ると続きのページが届く。届いた写真が見えるまで、もう一度送る
    await tester.drag(photoGridScroll(), const Offset(0, -5000));
    await letFramesRun(tester);
    await tester.drag(photoGridScroll(), const Offset(0, -5000));
    await letFramesRun(tester);
    await tester.longPress(photoThumbnail('2026年10月5日 10:33'));
    await letFramesRun(tester);
    expect(find.text('1枚を選択中'), findsOneWidget);
    await tester.drag(photoGridScroll(), const Offset(0, 5000));
    await letFramesRun(tester);

    await tester.drag(photoGridScroll(), const Offset(0, 600));
    await letFramesRun(tester);

    expect(photoThumbnail('2026年10月5日 10:33'), findsNothing);
    expect(find.text('0枚を選択中'), findsOneWidget);
  });

  // 旅行に属さない写真の画面は、下に引っ張っても見出しのために旅行を取り直さない（画面全体が描き直されない）。
  // 選択が絞られたことは選択の知らせだけで見出しに届くので、旅行詳細とは別に確かめる。
  // 選んでいた写真だけが消えて 0 枚になっても、選択モードは抜けない（§4.8「選んだ枚数が 0 になっても選択モードのまま」）
  testWidgets('旅行に属さない写真の画面でも、選択モード中に下に引っ張って読み直すと、別の端末で消された写真は選択から外れ、0枚になっても選択モードのまま「0枚を選択中」を出す', (tester) async {
    final backend = FakeTripBackend(
      trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)],
      unassignedPhotoCount: 2,
      photosByTripId: {
        'none': [
          photoJson(number: 1, takenAt: '2026-09-01T10:15:00'),
          photoJson(number: 2, takenAt: '2026-09-02T12:30:00'),
        ],
      },
    );
    await openTripsTab(tester, backend);
    await tester.tap(find.text('旅行に属さない写真'));
    await letFramesRun(tester);
    await tester.longPress(photoThumbnail('2026年9月2日 12:30'));
    await letFramesRun(tester);
    expect(find.text('1枚を選択中'), findsOneWidget);
    // 別の端末で、選んでいた 9月2日 の写真が消された（偽のサーバの未所属の枚数も揃える。この画面の読み直しでは読まれない）
    backend.photosByTripId['none']!.removeAt(1);
    backend.unassignedPhotoCount -= 1;

    await tester.drag(photoGridScroll(), const Offset(0, 600));
    await letFramesRun(tester);

    expect(photoThumbnail('2026年9月2日 12:30'), findsNothing);
    expect(find.text('0枚を選択中'), findsOneWidget);
  });

  group('送信の一区切り', () {
    // 送信が一区切りつくと、画面はグリッドを作り直して先頭のページから読み直す。読み直したサムネイルを出したまま実時間を進めるので、
    // 画像のキャッシュの置き場（path_provider）を一時ディレクトリに差し替える（pending_photo_tiles_test.dart と同じ。テストごとに差し替えると互いに干渉する）
    late Directory cacheDirectory;
    const channel = MethodChannel('plugins.flutter.io/path_provider');

    setUpAll(() {
      cacheDirectory = Directory.systemTemp.createTempSync('snaplant_image_cache');
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) async => cacheDirectory.path);
    });

    tearDownAll(() {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, null);
      try {
        cacheDirectory.deleteSync(recursive: true);
      } catch (_) {
        // キャッシュの掃除のタイマーなどが使っている間は消せないことがある。一時ディレクトリなので残っても構わない
      }
    });

    testWidgets('選択モード中に送信が一区切りついて一覧を読み直すと、別の端末で消された写真は選択から外れ、残りの写真は選んだままになる', (tester) async {
      final semantics = tester.ensureSemantics();
      useFakeImageCompress();
      useGalleryReturning([writeTestImage('one.png', bytes: [...tinyPngBytes, 1])]);
      final backend = FakeTripBackend(
        trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 2)],
        photosByTripId: {
          hokkaidoTripId: [
            photoJson(number: 1, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:01:00'),
            photoJson(number: 2, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:02:00'),
          ],
        },
      );
      final release = backend.holdNextReply(TripRoute.upload);
      await openTripsTab(tester, backend);
      await tester.tap(find.text('北海道 2026秋'));
      await letFramesRun(tester);
      // 選択モードでは「写真を追加」が隠れるので、先に送って応答を止めておく
      await tester.tap(find.text('写真を追加'));
      await waitUntilUploadsReceived(tester, backend, 1);
      await letFramesRun(tester);
      await tester.longPress(photoThumbnail('2026年10月5日 10:01'));
      await letFramesRun(tester);
      await tester.tap(photoThumbnail('2026年10月5日 10:02'));
      await letFramesRun(tester);
      expect(find.text('2枚を選択中'), findsOneWidget);
      // 別の端末で、選んでいた 10:02 の写真が消された（偽のサーバの旅行の枚数も1枚減らす。送った写真は届いた時点で数えられている）
      backend.photosByTripId[hokkaidoTripId]!.removeAt(1);
      backend.trips.single['photoCount'] = (backend.trips.single['photoCount'] as int) - 1;

      release.complete();
      // 送った写真（撮影日時なし）が一覧に出たら、読み直しが済んでいる
      await waitUntilFound(tester, find.bySemanticsLabel(RegExp('^撮影日時なし')));
      await letFramesRun(tester);

      expect(photoThumbnail('2026年10月5日 10:02'), findsNothing);
      expect(find.text('1枚を選択中'), findsOneWidget);
      expect(tester.getSemantics(photoThumbnail('2026年10月5日 10:01')).hasFlag(SemanticsFlag.isSelected), isTrue);
      // キャッシュの掃除のタイマーを済ませる
      await tester.pump(const Duration(seconds: 20));
      semantics.dispose();
    });
  });
}
