import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/test/test_flutter_secure_storage_platform.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:snaplant_mobile/main.dart';

import '../helpers/app_test_helpers.dart';

// アプリ全体を開き、ホーム（下のタブ「図鑑」「旅行」）の利用者から見た振る舞いを確かめる
// （docs/03_screen_design.md §4.1）。
// サーバを差し込まないテストでは、API キーがある状態で開くと図鑑タブは種類の一覧を取得し、テスト環境の HTTP は常に 400 を返すので
// 「エラーが発生しました」の表示になる（その図鑑の中身は見ない）。サーバの応答が要るテストは偽のサーバ（helpers の catalogServer）を差し込む。

void main() {
  testWidgets('アプリを開くと下に図鑑と旅行のタブがあり、旅行のタブを押すと旅行の画面に切り替わる', (tester) async {
    useSecureStorage(TestFlutterSecureStoragePlatform({'api_key': 'saved-key'}));
    SharedPreferences.setMockInitialValues({});
    await saveTestEndpoint(tester);
    await openApp(tester);
    // 図鑑の画面上部の見出しも「図鑑」なので、下のタブの中で探す
    expect(find.descendant(of: find.byType(NavigationBar), matching: find.text('図鑑')), findsOneWidget);
    expect(find.descendant(of: find.byType(NavigationBar), matching: find.text('旅行')), findsOneWidget);
    // 植物図鑑を差し替えたので、タブは2つだけ（03 §4.1）
    expect(find.byType(NavigationDestination), findsNWidgets(2));
    // 起動時は図鑑なので、画面上部はまだ「旅行」ではない
    expect(find.descendant(of: find.byType(AppBar), matching: find.text('旅行')), findsNothing);

    await tester.tap(find.text('旅行'));
    await letFramesRun(tester);

    expect(find.descendant(of: find.byType(AppBar), matching: find.text('旅行')), findsOneWidget);
  });

  testWidgets('旅行のタブの設定ボタンから設定をリセットして戻ると、設定を促す表示になる', (tester) async {
    useSecureStorage(TestFlutterSecureStoragePlatform({'api_key': 'saved-key'}));
    SharedPreferences.setMockInitialValues({});
    await saveTestEndpoint(tester);
    await openApp(tester);
    await tester.tap(find.text('旅行'));
    await letFramesRun(tester);

    await resetSettingsAndGoBack(tester);

    expect(find.text('API設定が完了していません'), findsOneWidget);
  });

  testWidgets('旅行のタブの設定ボタンから設定画面を開き、何も変えずに戻っても、旅行のタブのまま', (tester) async {
    useSecureStorage(TestFlutterSecureStoragePlatform({'api_key': 'saved-key'}));
    SharedPreferences.setMockInitialValues({});
    await saveTestEndpoint(tester);
    await openApp(tester);
    await tester.tap(find.text('旅行'));
    await letFramesRun(tester);
    await tester.tap(find.byIcon(Icons.settings));
    await letFramesRun(tester);

    await tapBack(tester);
    await letFramesRun(tester);

    expect(find.descendant(of: find.byType(AppBar), matching: find.text('旅行')), findsOneWidget);
  });

  testWidgets('旅行のタブに切り替えて図鑑に戻っても、読み込んだ図鑑はそのまま表示される（読み直さない）', (tester) async {
    useSecureStorage(TestFlutterSecureStoragePlatform({'api_key': 'saved-key'}));
    SharedPreferences.setMockInitialValues({});
    // 種類の一覧の取得は1回目だけ成功し、2回目以降は失敗する。図鑑が読み直していれば、戻ったときにエラー表示になる
    await saveTestEndpoint(tester);
    final server = catalogServer({(host: testApiHost, code: 'saved-key'): '桜'}, succeedFirst: 1);
    await openApp(tester, app: SnapPlantApp(httpClient: server));
    expect(find.text('桜'), findsOneWidget);
    await tester.tap(find.text('旅行'));
    await letFramesRun(tester);

    await tester.tap(find.descendant(of: find.byType(NavigationBar), matching: find.text('図鑑')));
    await letFramesRun(tester);

    expect(find.text('桜'), findsOneWidget);
    expect(find.text('エラーが発生しました'), findsNothing);
  });
}
