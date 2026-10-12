import 'dart:async';

import 'package:flutter/material.dart';
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

  testWidgets('旅行を作るダイアログで旅行名が空白だけのまま「作成」を押すと、入力欄の下に注意を出し、旅行は作られない', (tester) async {
    useSecureStorage(TestFlutterSecureStoragePlatform({'api_key': 'saved-key'}));
    SharedPreferences.setMockInitialValues({});
    await useDefaultEndpoint(tester);
    // 送られたら成功して旅行が増える偽のサーバ。送られなかったことは、旅行が増えず、ダイアログが開いたままであることで見る
    final server = tripServer([], unassignedPhotoCount: 0);
    await openApp(tester, app: SnapPlantApp(httpClient: server));
    await tester.tap(find.text('旅行'));
    await letFramesRun(tester);
    await tester.tap(find.byType(FloatingActionButton));
    await letFramesRun(tester);
    // 「旅行を作る」は一覧の案内文・ボタン・ダイアログの見出しに出るので、ダイアログの中に絞って見る
    final dialog = find.byType(Dialog);
    expect(find.descendant(of: dialog, matching: find.text('旅行を作る')), findsOneWidget);
    await tester.enterText(find.descendant(of: dialog, matching: find.byType(TextField)).first, '   ');

    await tester.tap(find.descendant(of: dialog, matching: find.text('作成')));
    await letFramesRun(tester);

    expect(find.descendant(of: dialog, matching: find.text('旅行名を入力してください')), findsOneWidget);
    expect(find.text('旅行を作成しました'), findsNothing);
    // 一覧には旅行が増えておらず、0件の案内のまま
    expect(find.text('まだ旅行がありません'), findsOneWidget);
  });

  testWidgets('旅行を作るダイアログで旅行名を入れて「作成」を押すと、ダイアログが閉じて「旅行を作成しました」と出て、一覧に新しい旅行が加わる', (tester) async {
    useSecureStorage(TestFlutterSecureStoragePlatform({'api_key': 'saved-key'}));
    SharedPreferences.setMockInitialValues({});
    await useDefaultEndpoint(tester);
    // 作った旅行は偽のサーバが覚え、読み直した一覧に載せる。最初の一覧は0件
    final server = tripServer([], unassignedPhotoCount: 0);
    await openApp(tester, app: SnapPlantApp(httpClient: server));
    await tester.tap(find.text('旅行'));
    await letFramesRun(tester);
    await tester.tap(find.byType(FloatingActionButton));
    await letFramesRun(tester);
    final dialog = find.byType(Dialog);
    await tester.enterText(find.descendant(of: dialog, matching: find.byType(TextField)).first, '北海道 2026秋');

    await tester.tap(find.descendant(of: dialog, matching: find.text('作成')));
    await letFramesRun(tester);

    expect(find.byType(Dialog), findsNothing);
    expect(find.text('旅行を作成しました'), findsOneWidget);
    expect(find.text('北海道 2026秋'), findsOneWidget);
    expect(find.text('0枚 · 撮影日時なし'), findsOneWidget);
    expect(find.text('まだ旅行がありません'), findsNothing);
  });

  testWidgets('旅行の作成にサーバが失敗を返すと、ダイアログは開いたまま旅行名が残り、エラーの文言を出す', (tester) async {
    useSecureStorage(TestFlutterSecureStoragePlatform({'api_key': 'saved-key'}));
    SharedPreferences.setMockInitialValues({});
    await useDefaultEndpoint(tester);
    // 400 の文言はサーバのものがそのまま画面に出る（ApiException.userMessage）
    final server = tripServer([], unassignedPhotoCount: 0, rejectCreateWith: '旅行名は100文字以内で指定してください');
    await openApp(tester, app: SnapPlantApp(httpClient: server));
    await tester.tap(find.text('旅行'));
    await letFramesRun(tester);
    await tester.tap(find.byType(FloatingActionButton));
    await letFramesRun(tester);
    final dialog = find.byType(Dialog);
    await tester.enterText(find.descendant(of: dialog, matching: find.byType(TextField)).first, '北海道 2026秋');

    await tester.tap(find.descendant(of: dialog, matching: find.text('作成')));
    await letFramesRun(tester);

    expect(find.text('旅行名は100文字以内で指定してください'), findsOneWidget);
    expect(find.byType(Dialog), findsOneWidget);
    expect(find.descendant(of: dialog, matching: find.text('北海道 2026秋')), findsOneWidget);
    expect(find.text('旅行を作成しました'), findsNothing);
  });

  testWidgets('旅行の行をタップすると旅行詳細が開き、上部に旅行名、その下に取り直した枚数と撮影の期間を出す', (tester) async {
    useSecureStorage(TestFlutterSecureStoragePlatform({'api_key': 'saved-key'}));
    SharedPreferences.setMockInitialValues({});
    await useDefaultEndpoint(tester);
    const tripId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    // 一覧では10枚、詳細では12枚（一覧を読んだ後に写真が増えた）。詳細が取り直していれば12枚が出る
    final server = tripServer(
      [
        tripJson(
          id: tripId,
          name: '北海道 2026秋',
          photoCount: 10,
          firstTakenAt: '2026-10-05T09:00:00',
          lastTakenAt: '2026-10-07T17:30:00',
        ),
      ],
      unassignedPhotoCount: 0,
      tripDetails: {
        tripId: tripJson(
          id: tripId,
          name: '北海道 2026秋',
          photoCount: 12,
          firstTakenAt: '2026-10-05T09:00:00',
          lastTakenAt: '2026-10-08T17:30:00',
        ),
      },
    );
    await openApp(tester, app: SnapPlantApp(httpClient: server));
    await tester.tap(find.text('旅行'));
    await letFramesRun(tester);

    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);

    expect(find.descendant(of: find.byType(AppBar), matching: find.text('北海道 2026秋')), findsOneWidget);
    expect(find.text('12枚 · 2026/10/05 〜 2026/10/08'), findsOneWidget);
  });

  testWidgets('旅行詳細で旅行を削除して一覧に戻ると、消した旅行が一覧になく、旅行に属さない写真の枚数が移った分だけ増えている', (tester) async {
    useSecureStorage(TestFlutterSecureStoragePlatform({'api_key': 'saved-key'}));
    SharedPreferences.setMockInitialValues({});
    await useDefaultEndpoint(tester);
    const hokkaidoId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    final hokkaido = tripJson(
      id: hokkaidoId,
      name: '北海道 2026秋',
      photoCount: 12,
      firstTakenAt: '2026-10-05T09:00:00',
      lastTakenAt: '2026-10-08T17:30:00',
    );
    // 削除した旅行は、偽のサーバが以降の一覧から外し、写真（既定の「写真は残す」）の枚数だけ未所属を増やす
    final server = tripServer(
      [
        hokkaido,
        tripJson(
          id: '3f2504e0-4f89-41d3-9a0c-0305e82c3302',
          name: '大阪',
          photoCount: 3,
          firstTakenAt: '2026-09-20T10:00:00',
          lastTakenAt: '2026-09-20T18:00:00',
        ),
      ],
      unassignedPhotoCount: 8,
      tripDetails: {hokkaidoId: hokkaido},
    );
    await openApp(tester, app: SnapPlantApp(httpClient: server));
    await tester.tap(find.text('旅行'));
    await letFramesRun(tester);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    await tester.tap(find.byIcon(Icons.more_vert));
    await letFramesRun(tester);
    await tester.tap(find.text('削除'));
    await letFramesRun(tester);
    final dialog = find.byType(Dialog);

    await tester.tap(find.descendant(of: dialog, matching: find.text('削除')));
    await letFramesRun(tester);

    expect(find.text('北海道 2026秋'), findsNothing);
    expect(find.text('大阪'), findsOneWidget);
    expect(find.text('20枚'), findsOneWidget);
  });

  testWidgets('旅行一覧は、最初の読み込みが終わるまで「旅行一覧を読み込み中...」を出し、読み込めたら消して一覧を出す', (tester) async {
    useSecureStorage(TestFlutterSecureStoragePlatform({'api_key': 'saved-key'}));
    SharedPreferences.setMockInitialValues({});
    await useDefaultEndpoint(tester);
    // 応答を止めておき、読み込み中の状態を見る
    final release = Completer<void>();
    final server = tripServer([], unassignedPhotoCount: 8, holdListUntil: release.future);
    await openApp(tester, app: SnapPlantApp(httpClient: server));
    await tester.tap(find.text('旅行'));
    await letFramesRun(tester);
    expect(find.text('旅行一覧を読み込み中...'), findsOneWidget);
    expect(find.text('旅行に属さない写真'), findsNothing);

    release.complete();
    await letFramesRun(tester);

    expect(find.text('旅行一覧を読み込み中...'), findsNothing);
    expect(find.text('旅行に属さない写真'), findsOneWidget);
  });

  testWidgets('旅行一覧を下に引っ張ると読み直し、別の端末で作られた旅行が出る', (tester) async {
    useSecureStorage(TestFlutterSecureStoragePlatform({'api_key': 'saved-key'}));
    SharedPreferences.setMockInitialValues({});
    await useDefaultEndpoint(tester);
    final osaka = tripJson(id: '3f2504e0-4f89-41d3-9a0c-0305e82c3302', name: '大阪', photoCount: 3);
    // 最初の一覧は旅行1件。2回目以降は、その間に別の端末で作られた旅行が加わる
    final server = tripServer(
      [osaka],
      unassignedPhotoCount: 0,
      tripsFromSecondList: [
        tripJson(id: '3f2504e0-4f89-41d3-9a0c-0305e82c3303', name: '京都', photoCount: 0),
        osaka,
      ],
    );
    await openApp(tester, app: SnapPlantApp(httpClient: server));
    await tester.tap(find.text('旅行'));
    await letFramesRun(tester);
    expect(find.text('京都'), findsNothing);

    await tester.fling(find.text('旅行に属さない写真'), const Offset(0, 400), 1000);
    await letFramesRun(tester);

    expect(find.text('京都'), findsOneWidget);
    expect(find.text('大阪'), findsOneWidget);
  });

  testWidgets('旅行を作っている間は「作成」が「作成中...」になり、押し直しても旅行は二重に作られない', (tester) async {
    useSecureStorage(TestFlutterSecureStoragePlatform({'api_key': 'saved-key'}));
    SharedPreferences.setMockInitialValues({});
    await useDefaultEndpoint(tester);
    // 作成の応答を止めておき、作成中の状態を見る
    final release = Completer<void>();
    final server = tripServer([], unassignedPhotoCount: 0, holdCreateUntil: release.future);
    await openApp(tester, app: SnapPlantApp(httpClient: server));
    await tester.tap(find.text('旅行'));
    await letFramesRun(tester);
    await tester.tap(find.byType(FloatingActionButton));
    await letFramesRun(tester);
    final dialog = find.byType(Dialog);
    await tester.enterText(find.descendant(of: dialog, matching: find.byType(TextField)).first, '北海道 2026秋');

    await tester.tap(find.descendant(of: dialog, matching: find.text('作成')));
    await letFramesRun(tester);

    expect(find.descendant(of: dialog, matching: find.text('作成中...')), findsOneWidget);
    expect(find.descendant(of: dialog, matching: find.text('作成')), findsNothing);

    // 作成中のボタンを押し直しても、応答が返った後に旅行が1つしか載らない
    await tester.tap(find.descendant(of: dialog, matching: find.text('作成中...')));
    release.complete();
    await letFramesRun(tester);

    expect(find.text('北海道 2026秋'), findsOneWidget);
  });
}
