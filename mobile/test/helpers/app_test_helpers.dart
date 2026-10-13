import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage_platform_interface/flutter_secure_storage_platform_interface.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:snaplant_mobile/main.dart';
import 'package:snaplant_mobile/services/settings_service.dart';

// アプリ全体（SnapPlantApp）を開くテストが共有する準備。
// 端末の設定の保存先（セキュアストレージ）の差し替え、実機の解像度でのアプリの起動、
// 宛先とキーを見分ける偽のサーバ、設定のリセットの操作を持つ

/// テストの間だけセキュアストレージを [platform] に差し替え、テストが終わったら差し替える前のものに戻す。
/// セキュアストレージは全テストで共有する1つの置き場なので、戻さないと次のテストが偽物を引き継ぐ
void useSecureStorage(FlutterSecureStoragePlatform platform) {
  final original = FlutterSecureStoragePlatform.instance;
  FlutterSecureStoragePlatform.instance = platform;
  addTearDown(() => FlutterSecureStoragePlatform.instance = original);
}

/// [app]（既定は SnapPlantApp）を実機の解像度で開き、起動時の初期化（設定の読み出し）を進める
Future<void> openApp(WidgetTester tester, {Widget app = const SnapPlantApp()}) async {
  // 画面が想定している実機の解像度に合わせる。
  // ただし密度は 3.5 でなく 3.0（幅 480dp）にする。アプリ本来のテーマではカードの余白が広く、
  // テスト環境の既定のフォント（全角も半角も1文字が1em幅）では、設定画面の「開発者」行が
  // 幅 411dp に収まらず RenderFlex の溢れで落ちるため（実機のフォントでは収まる）
  tester.view.physicalSize = const Size(1440, 2960);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);

  await tester.pumpWidget(app);
  await letFramesRun(tester);
}

/// 読み込み中のスピナーで pumpAndSettle が終わらないため、pump で数フレーム進める。
/// 画面遷移のアニメーションや非同期の設定の読み出しが終わるまで繰り返す
Future<void> letFramesRun(WidgetTester tester) async {
  for (var i = 0; i < 5; i++) {
    await tester.pump(const Duration(milliseconds: 300));
  }
}

/// テストが端末に保存する API のエンドポイント。本番の URL ではない値にする
const testApiEndpoint = 'https://func-test.example.net';

/// [testApiEndpoint] のホスト。偽のサーバが宛先の照合に使う
const testApiHost = 'func-test.example.net';

/// GET /api/plants に、宛先のホストと API キー（`?code=`）の組ごとに決めた植物 1 件の一覧を返す偽のサーバ。
/// [plantNames] に無い組（宛先かキーの取り違え）と、それ以外のメソッドやパスは 404 にする。
/// [succeedFirst] を渡すと、一覧の取得はその回数目までだけ成功し、以降は 500 を返す
/// （読み直したかどうかを、読み直したときの失敗で見分けるため）
MockClient plantServer(
  Map<({String host, String code}), String> plantNames, {
  int? succeedFirst,
}) {
  var listRequests = 0;
  return MockClient((request) async {
    if (request.method != 'GET' || request.url.path != '/api/plants') {
      return http.Response('', 404);
    }
    final plantName = plantNames[(
      host: request.url.host,
      code: request.url.queryParameters['code'] ?? '',
    )];
    if (plantName == null) return http.Response('', 404);
    listRequests++;
    // サーバの実際のヘッダに合わせる（charset なしの application/json。無いと日本語が化ける）
    const headers = {'content-type': 'application/json'};
    if (succeedFirst != null && listRequests > succeedFirst) {
      return http.Response(
        json.encode({
          'success': false,
          'error': {'code': 'INTERNAL_ERROR', 'message': 'サーバーエラー'},
        }),
        500,
        headers: headers,
      );
    }
    return http.Response(
      json.encode({
        'success': true,
        'data': {
          'plants': [
            {
              'id': 'plant-1',
              'name': plantName,
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
      headers: headers,
    );
  });
}

/// 設定画面を開いて設定をリセットし、確認ダイアログで「リセット」を選んで、設定画面から戻る。
/// 設定ボタン（歯車）が見えている画面から呼ぶ
Future<void> resetSettingsAndGoBack(WidgetTester tester) async {
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
}

/// 端末に API のエンドポイント（[testApiEndpoint]）を保存した状態にする。
/// SettingsService はシングルトンで最初に取った SharedPreferences を持ち越すため、
/// SharedPreferences.setMockInitialValues では、前のテストが保存したエンドポイントを上書きできない。
/// SettingsService を通して保存し、前のテストの値に依らないようにする
Future<void> saveTestEndpoint(WidgetTester tester) async {
  await tester.runAsync(() async {
    final settings = await SettingsService.getInstance();
    await settings.saveApiEndpoint(testApiEndpoint);
  });
}

/// 端末に API のエンドポイントを保存していない状態にする。
/// [saveTestEndpoint] と同じ理由で、SettingsService を通して消す
Future<void> clearSavedEndpoint(WidgetTester tester) async {
  await tester.runAsync(() async {
    final settings = await SettingsService.getInstance();
    await settings.resetApiEndpoint();
  });
}
