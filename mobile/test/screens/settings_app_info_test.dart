import 'package:flutter_secure_storage/test/test_flutter_secure_storage_platform.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../helpers/app_test_helpers.dart';

// 設定画面のアプリ情報（docs/03_screen_design.md §4.9）。
// 設定画面は、何も保存されていない初回の起動で自動で開くので、その形で開く（サーバは使わない）

void main() {
  testWidgets('設定画面のアプリ情報の最後に、地図のデータの出典「© OpenStreetMap contributors」を出す（名所のタグの候補に使う。ODbL）', (tester) async {
    useSecureStorage(TestFlutterSecureStoragePlatform({}));
    SharedPreferences.setMockInitialValues({});
    // SettingsService はシングルトンで前のテストのエンドポイントを持ち越すので、setMockInitialValues では消えない
    await clearSavedEndpoint(tester);

    await openApp(tester);

    expect(find.text('地図のデータ'), findsOneWidget);
    expect(find.text('© OpenStreetMap contributors'), findsOneWidget);
    // アプリ情報の表の最後の行（開発者の行の後）
    expect(tester.getTopLeft(find.text('地図のデータ')).dy, greaterThan(tester.getTopLeft(find.text('開発者')).dy));
  });
}
