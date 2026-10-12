import 'package:flutter/material.dart';
import 'package:flutter_secure_storage_platform_interface/flutter_secure_storage_platform_interface.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:snaplant_mobile/main.dart';

// アプリ全体（SnapPlantApp）を開くテストが共有する準備。
// 端末の設定の保存先（セキュアストレージ）の差し替えと、実機の解像度でのアプリの起動を持つ

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
