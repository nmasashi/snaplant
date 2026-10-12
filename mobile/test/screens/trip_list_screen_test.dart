import 'package:flutter_secure_storage/test/test_flutter_secure_storage_platform.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:snaplant_mobile/main.dart';

import '../helpers/app_test_helpers.dart';
import '../helpers/trip_test_helpers.dart';

// アプリ全体を開き、旅行タブの旅行一覧の利用者から見た振る舞いを確かめる
// （docs/travel-album/03_screen_design.md §3・§4.2〜§4.4）。
// 旅行の API は偽のサーバ（helpers の tripServer）で差し替える。図鑑タブの GET /api/plants は 404 になるが、
// 図鑑タブは隠れていて、旅行タブの表示に影響しない

void main() {
  testWidgets('旅行一覧には、先頭に「旅行に属さない写真」の枚数、その下にサーバが返す順で旅行の名前・枚数・撮影の期間が並ぶ', (tester) async {
    useSecureStorage(TestFlutterSecureStoragePlatform({'api_key': 'saved-key'}));
    SharedPreferences.setMockInitialValues({});
    await useDefaultEndpoint(tester);
    // 並べ替えていないことが分かるよう、名前の順でも枚数の順でもない順に返す。
    // 期間の3通り: 日をまたぐ範囲、同じ日、撮影日時のある写真が無い
    final server = tripServer([
      tripJson(
        id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
        name: '北海道 2026秋',
        photoCount: 12,
        firstTakenAt: '2026-10-05T09:00:00',
        lastTakenAt: '2026-10-08T17:30:00',
      ),
      tripJson(
        id: '3f2504e0-4f89-41d3-9a0c-0305e82c3302',
        name: '大阪',
        photoCount: 3,
        firstTakenAt: '2026-09-20T10:00:00',
        lastTakenAt: '2026-09-20T18:00:00',
      ),
      tripJson(
        id: '3f2504e0-4f89-41d3-9a0c-0305e82c3303',
        name: '京都',
        photoCount: 0,
      ),
    ], unassignedPhotoCount: 8);
    await openApp(tester, app: SnapPlantApp(httpClient: server));

    await tester.tap(find.text('旅行'));
    await letFramesRun(tester);

    expect(find.text('8枚'), findsOneWidget);
    expect(find.text('12枚 · 2026/10/05 〜 2026/10/08'), findsOneWidget);
    expect(find.text('3枚 · 2026/09/20'), findsOneWidget);
    expect(find.text('0枚 · 撮影日時なし'), findsOneWidget);
    final unassignedTop = tester.getTopLeft(find.text('旅行に属さない写真')).dy;
    final hokkaidoTop = tester.getTopLeft(find.text('北海道 2026秋')).dy;
    final osakaTop = tester.getTopLeft(find.text('大阪')).dy;
    final kyotoTop = tester.getTopLeft(find.text('京都')).dy;
    expect(unassignedTop, lessThan(hokkaidoTop));
    expect(hokkaidoTop, lessThan(osakaTop));
    expect(osakaTop, lessThan(kyotoTop));
  });

  testWidgets('旅行が1件もないときも「旅行に属さない写真」の行は出し、その下に最初の旅行を作るよう促す', (tester) async {
    useSecureStorage(TestFlutterSecureStoragePlatform({'api_key': 'saved-key'}));
    SharedPreferences.setMockInitialValues({});
    await useDefaultEndpoint(tester);
    final server = tripServer([], unassignedPhotoCount: 5);
    await openApp(tester, app: SnapPlantApp(httpClient: server));

    await tester.tap(find.text('旅行'));
    await letFramesRun(tester);

    expect(find.text('旅行に属さない写真'), findsOneWidget);
    expect(find.text('5枚'), findsOneWidget);
    expect(find.text('まだ旅行がありません'), findsOneWidget);
    expect(find.text('「旅行を作る」から最初の旅行を作りましょう'), findsOneWidget);
    // 促す表示は先頭の行の下に出る
    expect(
      tester.getTopLeft(find.text('旅行に属さない写真')).dy,
      lessThan(tester.getTopLeft(find.text('まだ旅行がありません')).dy),
    );
  });

  testWidgets('旅行一覧の読み込みに失敗するとエラーと「再試行」を出し、「再試行」を押すと読み直して一覧を出す', (tester) async {
    useSecureStorage(TestFlutterSecureStoragePlatform({'api_key': 'saved-key'}));
    SharedPreferences.setMockInitialValues({});
    await useDefaultEndpoint(tester);
    // 1回目は 503、2回目は成功。再試行で読み直したかどうかを、2回目の成功で見分ける
    final server = tripServer([
      tripJson(
        id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
        name: '北海道 2026秋',
        photoCount: 12,
        firstTakenAt: '2026-10-05T09:00:00',
        lastTakenAt: '2026-10-08T17:30:00',
      ),
    ], unassignedPhotoCount: 8, failFirst: 1);
    await openApp(tester, app: SnapPlantApp(httpClient: server));
    await tester.tap(find.text('旅行'));
    await letFramesRun(tester);
    // 失敗したときの表示。一覧は出ていない
    expect(find.text('エラーが発生しました'), findsOneWidget);
    expect(find.text('サービスに一時的に接続できません。しばらく待ってから再試行してください。'), findsOneWidget);
    expect(find.text('北海道 2026秋'), findsNothing);

    await tester.tap(find.text('再試行'));
    await letFramesRun(tester);

    expect(find.text('北海道 2026秋'), findsOneWidget);
    expect(find.text('8枚'), findsOneWidget);
    expect(find.text('エラーが発生しました'), findsNothing);
  });
}
