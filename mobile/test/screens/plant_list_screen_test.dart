import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:snaplant_mobile/screens/plant_list_screen.dart';

// 設定の保存先（端末のセキュアストレージと SharedPreferences）は、画面から見て
// プロセス外の依存なので、パッケージ同梱のテスト用の仕組みで差し替える。
// サーバ（Azure Functions）は、このファイルのテストでは API キーが未設定なので呼ばれない。

/// 端末に API キーもエンドポイントも保存されていない状態にする。
/// 呼び出し側は、テスト間で状態を持ち越さないよう各テストの冒頭で呼ぶ
void _givenNoSettingsSaved() {
  FlutterSecureStorage.setMockInitialValues({});
  SharedPreferences.setMockInitialValues({});
}

/// 一覧画面を実機の解像度で開き、起動時の初期化（設定の読み出し）を進める
Future<void> _openPlantListScreen(WidgetTester tester) async {
  // 画面が想定している実機の解像度に合わせる
  tester.view.physicalSize = const Size(1440, 2960);
  tester.view.devicePixelRatio = 3.5;
  addTearDown(tester.view.reset);

  await tester.pumpWidget(const MaterialApp(home: PlantListScreen()));
  await _letFramesRun(tester);
}

/// 読み込み中のスピナーで pumpAndSettle が終わらないため、pump で数フレーム進める。
/// 画面遷移のアニメーションや非同期の設定の読み出しが終わるまで繰り返す
Future<void> _letFramesRun(WidgetTester tester) async {
  for (var i = 0; i < 5; i++) {
    await tester.pump(const Duration(milliseconds: 300));
  }
}

void main() {
  testWidgets('APIキーを入れずに設定画面から戻ると、読み込み中のまま止まらず「API設定が完了していません」と表示する', (tester) async {
    _givenNoSettingsSaved();
    await _openPlantListScreen(tester);
    // 起動時に設定画面へ自動で移っている
    expect(find.text('設定'), findsOneWidget);

    await tester.tap(find.byIcon(Icons.arrow_back));
    await _letFramesRun(tester);

    expect(find.text('API設定が完了していません'), findsOneWidget);
    expect(find.text('設定を開く'), findsOneWidget);
    expect(find.text('植物一覧を読み込み中...'), findsNothing);
  });
}
