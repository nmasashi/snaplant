import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_secure_storage/test/test_flutter_secure_storage_platform.dart';
import 'package:flutter_secure_storage_platform_interface/flutter_secure_storage_platform_interface.dart';
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

/// 1回目の読み出しだけ失敗するセキュアストレージ。
/// Android の encryptedSharedPreferences は、復号できないと（バックアップの復元や
/// 再インストールの後など）PlatformException を投げる。2回目以降は普通に読める
class _SecureStorageFailingOnFirstRead extends TestFlutterSecureStoragePlatform {
  _SecureStorageFailingOnFirstRead() : super({});

  bool _hasFailed = false;

  @override
  Future<String?> read({
    required String key,
    required Map<String, String> options,
  }) async {
    if (!_hasFailed) {
      _hasFailed = true;
      throw PlatformException(code: 'Exception encountered', message: 'Failed to decrypt');
    }
    return super.read(key: key, options: options);
  }
}

/// 保存済みの設定を最初の1回だけ読めない状態にする（読み直せば、キーは未設定）
void _givenFirstReadOfSettingsFails() {
  FlutterSecureStoragePlatform.instance = _SecureStorageFailingOnFirstRead();
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

  testWidgets('保存済みの設定を読めなかったときに「再試行」を押すと、設定を読み直す', (tester) async {
    _givenFirstReadOfSettingsFails();
    await _openPlantListScreen(tester);
    expect(find.text('API設定の読み込みに失敗しました'), findsOneWidget);

    await tester.tap(find.text('再試行'));
    await _letFramesRun(tester);

    expect(find.text('API設定の読み込みに失敗しました'), findsNothing);
    expect(find.text('API設定が完了していません'), findsOneWidget);
  });

  testWidgets('設定をリセットして一覧画面に戻ると、消したキーで通信し続けず「API設定が完了していません」と表示する', (tester) async {
    FlutterSecureStorage.setMockInitialValues({'api_key': 'old-key'});
    SharedPreferences.setMockInitialValues({});
    await _openPlantListScreen(tester);
    // キーが保存済みなので設定画面には移らず、通信して（テスト環境の HTTP は 400 を返す）エラー表示になっている
    expect(find.text('エラーが発生しました'), findsOneWidget);
    await tester.tap(find.byIcon(Icons.settings));
    await _letFramesRun(tester);
    await tester.ensureVisible(find.text('設定をリセット'));
    await tester.pump();
    await tester.tap(find.text('設定をリセット'));
    await _letFramesRun(tester);
    await tester.tap(find.text('リセット'));
    await _letFramesRun(tester);

    await tester.tap(find.byIcon(Icons.arrow_back));
    await _letFramesRun(tester);

    expect(find.text('API設定が完了していません'), findsOneWidget);
  });
}
