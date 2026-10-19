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
Future<void> openApp(WidgetTester tester,
    {Widget app = const SnapPlantApp()}) async {
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

/// 図鑑の API（GET /api/catalog/kinds・GET /api/catalog/entries）に、宛先のホストと API キー（`?code=`）の組ごとに決めた
/// 表示名の種類1つ（植物）を返す偽のサーバ。項目は返さない（空の一覧）。旅行の一覧（GET /api/trips）は空で返す（[databaseDown] なら写真の一覧と一緒に 503）。図鑑のタブに出る種類のタブの名前で、どの設定で通信したかを見分ける。
/// [kindLabels] に無い組は、宛先が合っていてキーだけが違えば 401、宛先が違えば 404。それ以外のメソッドやパスは 404 にする。写真の一覧（GET /api/photos）は空のページ。
/// [succeedFirst] を渡すと、種類の一覧の取得はその回数目までだけ成功し、以降は 500 を返す
/// （読み直したかどうかを、読み直したときの失敗で見分けるため）
MockClient catalogServer(
  Map<({String host, String code}), String> kindLabels, {
  int? succeedFirst,
  bool databaseDown = false,
}) {
  var kindRequests = 0;
  return MockClient((request) async {
    final label = kindLabels[(
      host: request.url.host,
      code: request.url.queryParameters['code'] ?? '',
    )];
    if (request.method != 'GET') return http.Response('', 404);
    if (label == null) {
      // 宛先は合っていてキーだけが違えば、本物の Functions のランタイムと同じく封筒の無い 401。宛先が違えば 404（別のサーバ）
      final knownHost = kindLabels.keys.any((k) => k.host == request.url.host);
      return http.Response('', knownHost ? 401 : 404);
    }
    // サーバの実際のヘッダに合わせる（charset なしの application/json。無いと日本語が化ける）
    const headers = {'content-type': 'application/json'};
    switch (request.url.path) {
      case '/api/catalog/kinds':
        kindRequests++;
        if (succeedFirst != null && kindRequests > succeedFirst) {
          return http.Response(
            json.encode({
              'success': false,
              'error': {'code': 'INTERNAL_ERROR', 'message': '図鑑の種類の取得に失敗しました'},
            }),
            500,
            headers: headers,
          );
        }
        return http.Response(
          json.encode({
            'success': true,
            'data': {
              'kinds': [
                {'kind': 'plant', 'label': label, 'fields': <Object?>[]},
              ],
            },
          }),
          200,
          headers: headers,
        );
      case '/api/catalog/entries':
        return http.Response(
          json.encode({
            'success': true,
            'data': {'entries': <Object?>[], 'total': 0},
          }),
          200,
          headers: headers,
        );
      case '/api/photos':
        // 写真の一覧はデータベースを読む（クエリなので、コンテナが無ければ失敗する）。偽のサーバは写真を持たないので空のページ（[databaseDown] なら 503）
        if (databaseDown) {
          return http.Response(
            json.encode({
              'success': false,
              'error': {'code': 'DATABASE_ERROR', 'message': 'データベースに接続できません'},
            }),
            503,
            headers: headers,
          );
        }
        return http.Response(
          json.encode({
            'success': true,
            'data': {'photos': <Object?>[], 'continuationToken': null, 'urlExpiresAt': '2026-10-10T04:12:45.000Z'},
          }),
          200,
          headers: headers,
        );
      case '/api/trips':
        // 旅行の一覧はデータベースを読む。[databaseDown] なら本物と同じく 503 DATABASE_ERROR
        if (databaseDown) {
          return http.Response(
            json.encode({
              'success': false,
              'error': {'code': 'DATABASE_ERROR', 'message': 'データベースに接続できません'},
            }),
            503,
            headers: headers,
          );
        }
        return http.Response(
          json.encode({
            'success': true,
            'data': {'trips': <Object?>[], 'total': 0, 'unassignedPhotoCount': 0},
          }),
          200,
          headers: headers,
        );
      default:
        return http.Response('', 404);
    }
  });
}

/// 設定画面で設定をリセットし、確認ダイアログで「リセット」を選ぶ。設定画面に留まる
Future<void> resetSettingsOnScreen(WidgetTester tester) async {
  await tester.ensureVisible(find.text('設定をリセット'));
  await tester.pump();
  await tester.tap(find.text('設定をリセット'));
  await letFramesRun(tester);
  await tester.tap(find.text('リセット'));
  await letFramesRun(tester);
}

/// 設定画面を開いて設定をリセットし、確認ダイアログで「リセット」を選んで、設定画面から戻る。
/// 設定ボタン（歯車）が見えている画面から呼ぶ
Future<void> resetSettingsAndGoBack(WidgetTester tester) async {
  await tester.tap(find.byIcon(Icons.settings));
  await letFramesRun(tester);
  await resetSettingsOnScreen(tester);
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
