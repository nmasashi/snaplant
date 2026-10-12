import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/test/test_flutter_secure_storage_platform.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:snaplant_mobile/main.dart';
import 'helpers/app_test_helpers.dart';

// アプリ全体（SnapPlantApp）を開き、利用者から見た設定の扱い（読み込み・未設定なら設定画面へ・
// 設定画面から戻ったら読み直す・読めなかったときの再試行）を確かめる。
// 設定の保存先（端末のセキュアストレージと SharedPreferences）は、アプリから見て
// プロセス外の依存なので、パッケージ同梱のテスト用の仕組みで差し替える。
// サーバ（Azure Functions）は、API キーがある状態で一覧を取得するテストでは偽のサーバ（helpers の plantServer）に差し替える。
// 偽のサーバは宛先のホストと API キーの組ごとに違う植物の一覧を返すので、一覧に出た植物の名前で
// 「どの設定で通信したか」「一覧が読み込まれたか」を確かめる。
// 「エラーが発生しました」は AppRoot の設定の読み込み失敗の見出しと同じ文言なので、一覧の読み込みの確認には使わない。
// キーが無い・読めない状態のテストでは一覧を取得しないので、サーバは差し替えない。

/// 端末に API キーもエンドポイントも保存されていない状態にする。
/// 呼び出し側は、テスト間で状態を持ち越さないよう各テストの冒頭で呼ぶ
void _givenNoSettingsSaved() {
  useSecureStorage(TestFlutterSecureStoragePlatform({}));
  SharedPreferences.setMockInitialValues({});
}

/// テストが [failReads] を立てた時点から、読み出しが失敗するセキュアストレージ。
/// 読み出しの回数に頼らず、「設定画面から戻る直前」から壊すために使う
class _SecureStorageWithFailureSwitch extends TestFlutterSecureStoragePlatform {
  _SecureStorageWithFailureSwitch(super.data);

  bool failReads = false;

  @override
  Future<String?> read({
    required String key,
    required Map<String, String> options,
  }) async {
    if (failReads) {
      throw PlatformException(code: 'Exception encountered', message: 'Failed to decrypt');
    }
    return super.read(key: key, options: options);
  }
}

void main() {
  testWidgets('APIキーを入れずに設定画面から戻ると、読み込み中のまま止まらず「API設定が完了していません」と表示する', (tester) async {
    _givenNoSettingsSaved();
    await openApp(tester);
    // 起動時に設定画面へ自動で移っている
    expect(find.text('設定'), findsOneWidget);

    await tester.tap(find.byIcon(Icons.arrow_back));
    await letFramesRun(tester);

    expect(find.text('API設定が完了していません'), findsOneWidget);
    expect(find.text('設定を開く'), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsNothing);
  });

  testWidgets('保存済みの設定を読めなかったときに「再試行」を押すと、読み直した設定に応じた表示になる（キーが無ければ設定を促す）', (tester) async {
    final secureStorage = _SecureStorageWithFailureSwitch({})..failReads = true;
    useSecureStorage(secureStorage);
    SharedPreferences.setMockInitialValues({});
    await openApp(tester);
    expect(find.text('API設定の読み込みに失敗しました'), findsOneWidget);

    secureStorage.failReads = false;

    await tester.tap(find.text('再試行'));
    await letFramesRun(tester);

    expect(find.text('API設定の読み込みに失敗しました'), findsNothing);
    expect(find.text('API設定が完了していません'), findsOneWidget);
  });

  testWidgets('設定をリセットして戻ると、設定を促す表示になり、画像選択のボタンは出ない（API設定が無いまま画像選択へ進めない）', (tester) async {
    useSecureStorage(TestFlutterSecureStoragePlatform({'api_key': 'old-key'}));
    SharedPreferences.setMockInitialValues({});
    await useDefaultEndpoint(tester);
    final server = plantServer({(host: defaultApiHost, code: 'old-key'): '桜'});
    await openApp(tester, app: SnapPlantApp(httpClient: server));
    expect(find.text('桜'), findsOneWidget);

    await resetSettingsAndGoBack(tester);

    expect(find.text('API設定が完了していません'), findsOneWidget);
    expect(find.text('画像選択'), findsNothing);
  });

  testWidgets('設定済みの状態で設定画面から戻ったときに設定を読めなければ、古い設定で一覧を読み直さず「API設定の読み込みに失敗しました」と表示する', (tester) async {
    final secureStorage = _SecureStorageWithFailureSwitch({'api_key': 'old-key'});
    useSecureStorage(secureStorage);
    SharedPreferences.setMockInitialValues({});
    await useDefaultEndpoint(tester);
    final server = plantServer({(host: defaultApiHost, code: 'old-key'): '桜'});
    await openApp(tester, app: SnapPlantApp(httpClient: server));
    // キーが保存済みなので設定画面には移らず、一覧を読み込んでいる
    expect(find.text('桜'), findsOneWidget);
    await tester.tap(find.byIcon(Icons.settings));
    await letFramesRun(tester);
    expect(find.text('設定'), findsOneWidget);
    secureStorage.failReads = true;

    await tester.tap(find.byIcon(Icons.arrow_back));
    await letFramesRun(tester);

    expect(find.text('API設定の読み込みに失敗しました'), findsOneWidget);
  });

  testWidgets('設定を促す表示が出たあと、設定画面から戻ったときに設定を読めなければ、促す表示ではなく「API設定の読み込みに失敗しました」を再試行つきで表示する', (tester) async {
    final secureStorage = _SecureStorageWithFailureSwitch({});
    useSecureStorage(secureStorage);
    SharedPreferences.setMockInitialValues({});
    await openApp(tester);
    // キー未設定なので起動時に設定画面へ自動で移る。キーを入れずに戻ると、設定を促す表示になる
    await tester.tap(find.byIcon(Icons.arrow_back));
    await letFramesRun(tester);
    expect(find.text('API設定が完了していません'), findsOneWidget);
    await tester.tap(find.text('設定を開く'));
    await letFramesRun(tester);
    expect(find.text('設定'), findsOneWidget);
    secureStorage.failReads = true;

    await tester.tap(find.byIcon(Icons.arrow_back));
    await letFramesRun(tester);

    expect(find.text('API設定の読み込みに失敗しました'), findsOneWidget);
    expect(find.text('再試行'), findsOneWidget);
    expect(find.text('API設定が完了していません'), findsNothing);
  });

  testWidgets('APIキーを入れずに起動し、設定画面でキーを保存して戻ると、設定を促す表示が消えて一覧を読み込む', (tester) async {
    _givenNoSettingsSaved();
    await useDefaultEndpoint(tester);
    final server = plantServer({(host: defaultApiHost, code: 'new-function-key'): '桜'});
    await openApp(tester, app: SnapPlantApp(httpClient: server));
    // 起動時に設定画面へ自動で移っている
    expect(find.text('設定'), findsOneWidget);
    await tester.enterText(find.widgetWithText(TextFormField, 'APIキー'), 'new-function-key');
    await tester.ensureVisible(find.text('保存'));
    await tester.pump();

    await tester.tap(find.text('保存'));
    await letFramesRun(tester);

    expect(find.text('API設定が完了していません'), findsNothing);
    // キーが入ったので一覧を読み込む
    expect(find.text('桜'), findsOneWidget);
  });

  testWidgets('APIキーは変えずにエンドポイントだけ変えて設定を保存して戻ると、以後は新しいエンドポイントの植物の一覧を表示する', (tester) async {
    useSecureStorage(TestFlutterSecureStoragePlatform({'api_key': 'saved-function-key'}));
    // エンドポイントは未保存なので、アプリ既定の宛先（func-snaplant-mk0w7s38.azurewebsites.net）から一覧を取る
    SharedPreferences.setMockInitialValues({});
    await useDefaultEndpoint(tester);
    final server = plantServer({
      (host: defaultApiHost, code: 'saved-function-key'): '旧サーバの桜',
      (host: 'new-server.example.test', code: 'saved-function-key'): '新サーバの梅',
    });
    await openApp(tester, app: SnapPlantApp(httpClient: server));
    expect(find.text('旧サーバの桜'), findsOneWidget);
    await tester.tap(find.byIcon(Icons.settings));
    await letFramesRun(tester);
    await tester.enterText(
        find.widgetWithText(TextFormField, 'APIエンドポイント'), 'https://new-server.example.test');
    await tester.ensureVisible(find.text('保存'));
    await tester.pump();

    await tester.tap(find.text('保存'));
    await letFramesRun(tester);

    expect(find.text('新サーバの梅'), findsOneWidget);
    expect(find.text('旧サーバの桜'), findsNothing);
  });

  testWidgets('エンドポイントは変えずにAPIキーだけ変えて設定を保存して戻ると、以後は新しいキーの植物の一覧を表示する', (tester) async {
    useSecureStorage(TestFlutterSecureStoragePlatform({'api_key': 'old-function-key'}));
    SharedPreferences.setMockInitialValues({});
    await useDefaultEndpoint(tester);
    final server = plantServer({
      (host: defaultApiHost, code: 'old-function-key'): '旧キーの桜',
      (host: defaultApiHost, code: 'new-function-key'): '新キーの梅',
    });
    await openApp(tester, app: SnapPlantApp(httpClient: server));
    expect(find.text('旧キーの桜'), findsOneWidget);
    await tester.tap(find.byIcon(Icons.settings));
    await letFramesRun(tester);
    await tester.enterText(find.widgetWithText(TextFormField, 'APIキー'), 'new-function-key');
    await tester.ensureVisible(find.text('保存'));
    await tester.pump();

    await tester.tap(find.text('保存'));
    await letFramesRun(tester);

    expect(find.text('新キーの梅'), findsOneWidget);
    expect(find.text('旧キーの桜'), findsNothing);
  });
}
