import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:snaplant_mobile/screens/trip_detail_screen.dart';
import 'package:snaplant_mobile/services/api_service.dart';
import 'package:snaplant_mobile/services/upload_queue.dart';

import '../helpers/app_test_helpers.dart';
import '../helpers/trip_test_helpers.dart';

// 写真のサムネイル1枚の表示を、旅行詳細画面を通して確かめる（docs/travel-album/03_screen_design.md §3）。
// 画像の取得は cached_network_image（flutter_cache_manager）が端末のディレクトリとファイルを使う。
// テスト環境では端末の機能（path_provider）が無いので、プラットフォーム層を一時ディレクトリに差し替える。
// 画像の HTTP は flutter_test が必ず 400 を返すため、サムネイルは「読み込めない」状態になる。
// ファイルの読み書きと HTTP は実時間で進むので、tester.runAsync の中で待つ。
// キャッシュの管理（flutter_cache_manager）はこのファイル（テストを動かす isolate）の中で1つの共有物で、最初に開いた先を覚えるため、
// 画像を実際に取りに行くテストはこのファイルに置き、この1ファイルの中でも最初のテストにする

const _apiKey = 'test-key';

/// 端末の一時ディレクトリを [directory] に差し替える（テストが終わったら戻す）
void _useDirectoryForPathProvider(WidgetTester tester, Directory directory) {
  const channel = MethodChannel('plugins.flutter.io/path_provider');
  tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (call) async => directory.path);
  addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, null));
}

/// [finder] に当たるものが出るまで、実時間で少しずつ待つ（最長 5 秒）。出なくても例外にせず戻る（検証は呼び出し側）
Future<void> _waitUntilFound(WidgetTester tester, Finder finder) async {
  for (var i = 0; i < 50 && finder.evaluate().isEmpty; i++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 100)));
    await tester.pump(const Duration(milliseconds: 100));
  }
}

void main() {
  testWidgets('サムネイルは、画像を取得している間は「画像を読み込めません」を出さず、取得に失敗したときだけサムネイルの中に出す', (tester) async {
    final directory = Directory.systemTemp.createTempSync('snaplant_image_cache');
    addTearDown(() => directory.deleteSync(recursive: true));
    _useDirectoryForPathProvider(tester, directory);
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 1)],
      functionKey: _apiKey,
      photosByTripId: {
        hokkaidoTripId: [photoJson(number: 1, tripId: hokkaidoTripId, takenAt: '2026-10-05T12:30:15')],
      },
    );
    final apiService = ApiService(baseUrl: testApiEndpoint, client: backend.client, functionKey: _apiKey);

    await openApp(tester, app: MaterialApp(home: TripDetailScreen(apiService: apiService, uploadQueue: UploadQueue(apiService), tripId: hokkaidoTripId)));
    // 開いた直後は、画像を取得している途中（実時間を進めていない）。読み込めないときの表示はまだ出ない
    expect(find.text('画像を読み込めません'), findsNothing);

    await _waitUntilFound(tester, find.text('画像を読み込めません'));

    expect(find.text('画像を読み込めません'), findsOneWidget);
    // 画像の取得に付随する後始末のタイマー（キャッシュの掃除）を進めて、テストの終わりに残さない。
    // 掃除の間隔は flutter_cache_manager の CacheStore.cleanupRunMinInterval（3.4.1 で 10 秒）。
    // 間隔が多少変わっても残らないよう、その倍の 20 秒進める
    await tester.pump(const Duration(seconds: 20));
  });
}
