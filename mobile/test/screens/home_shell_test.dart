import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/test/test_flutter_secure_storage_platform.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:snaplant_mobile/main.dart';

import '../helpers/app_test_helpers.dart';

// アプリ全体を開き、ホーム（下のタブ「図鑑」「旅行」）の利用者から見た振る舞いを確かめる
// （docs/travel-album/03_screen_design.md §4.1）。
// サーバを差し込まないテストでは、API キーがある状態で開くと図鑑タブは一覧を取得し、テスト環境の HTTP は常に 400 を返すので
// 「エラーが発生しました」の表示になる（その図鑑の中身は見ない）。サーバの応答が要るテストは MockClient を差し込む。

/// サーバの実際のヘッダに合わせる（charset なしの application/json。無いと日本語が化ける）
const _jsonHeaders = {'content-type': 'application/json'};

void main() {
  testWidgets('アプリを開くと下に図鑑と旅行のタブがあり、旅行のタブを押すと旅行の画面に切り替わる', (tester) async {
    useSecureStorage(TestFlutterSecureStoragePlatform({'api_key': 'saved-key'}));
    SharedPreferences.setMockInitialValues({});
    await openApp(tester);
    expect(find.text('図鑑'), findsOneWidget);
    expect(find.text('旅行'), findsOneWidget);
    // 起動時は図鑑なので、画面上部はまだ「旅行」ではない
    expect(find.descendant(of: find.byType(AppBar), matching: find.text('旅行')), findsNothing);

    await tester.tap(find.text('旅行'));
    await letFramesRun(tester);

    expect(find.descendant(of: find.byType(AppBar), matching: find.text('旅行')), findsOneWidget);
  });

  testWidgets('旅行のタブの設定ボタンから設定をリセットして戻ると、設定を促す表示になる', (tester) async {
    useSecureStorage(TestFlutterSecureStoragePlatform({'api_key': 'saved-key'}));
    SharedPreferences.setMockInitialValues({});
    await openApp(tester);
    await tester.tap(find.text('旅行'));
    await letFramesRun(tester);
    await tester.tap(find.byIcon(Icons.settings));
    await letFramesRun(tester);
    await tester.ensureVisible(find.text('設定をリセット'));
    await tester.pump();
    await tester.tap(find.text('設定をリセット'));
    await letFramesRun(tester);
    await tester.tap(find.text('リセット'));
    await letFramesRun(tester);

    await tester.tap(find.byIcon(Icons.arrow_back));
    await letFramesRun(tester);

    expect(find.text('API設定が完了していません'), findsOneWidget);
  });

  testWidgets('旅行のタブの設定ボタンから設定画面を開き、何も変えずに戻っても、旅行のタブのまま', (tester) async {
    useSecureStorage(TestFlutterSecureStoragePlatform({'api_key': 'saved-key'}));
    SharedPreferences.setMockInitialValues({});
    await openApp(tester);
    await tester.tap(find.text('旅行'));
    await letFramesRun(tester);
    await tester.tap(find.byIcon(Icons.settings));
    await letFramesRun(tester);

    await tester.tap(find.byIcon(Icons.arrow_back));
    await letFramesRun(tester);

    expect(find.descendant(of: find.byType(AppBar), matching: find.text('旅行')), findsOneWidget);
  });

  testWidgets('旅行のタブに切り替えて図鑑に戻っても、読み込んだ植物の一覧はそのまま表示される（読み直さない）', (tester) async {
    useSecureStorage(TestFlutterSecureStoragePlatform({'api_key': 'saved-key'}));
    SharedPreferences.setMockInitialValues({});
    // 一覧の取得は1回目だけ成功し、2回目以降は失敗する。図鑑が読み直していれば、戻ったときにエラー表示になる
    var plantListRequests = 0;
    final server = MockClient((request) async {
      if (request.method != 'GET' || request.url.path != '/api/plants') {
        return http.Response('', 404);
      }
      plantListRequests++;
      if (plantListRequests > 1) {
        return http.Response(
          json.encode({
            'success': false,
            'error': {'code': 'INTERNAL_ERROR', 'message': 'サーバーエラー'},
          }),
          500,
          headers: _jsonHeaders,
        );
      }
      return http.Response(
        json.encode({
          'success': true,
          'data': {
            'plants': [
              {
                'id': 'plant-1',
                'name': '桜',
                'characteristics': '春に咲く',
                'imagePath': 'https://stsnaplant.blob.core.windows.net/images/a.jpg',
                'confidence': 95.0,
                'createdAt': '2026-10-01T09:00:00.000Z',
              },
            ],
            'total': 1,
          },
        }),
        200,
        headers: _jsonHeaders,
      );
    });
    await openApp(tester, app: SnapPlantApp(httpClient: server));
    expect(find.text('桜'), findsOneWidget);
    await tester.tap(find.text('旅行'));
    await letFramesRun(tester);

    await tester.tap(find.text('図鑑'));
    await letFramesRun(tester);

    expect(find.text('桜'), findsOneWidget);
    expect(find.text('エラーが発生しました'), findsNothing);
  });
}
