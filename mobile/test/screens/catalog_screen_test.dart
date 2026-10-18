import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../helpers/app_test_helpers.dart';
import '../helpers/trip_test_helpers.dart';

// 図鑑のタブ（docs/travel-album/03_screen_design.md §6.1。段階4の 4-3a）。
// 入口は下のタブの「図鑑（新）」。図鑑の API は偽のサーバ（FakeTripBackend）が返す

/// 植物と食べ物の項目を持つ偽のサーバ
FakeTripBackend _backend() => FakeTripBackend(
      functionKey: 'test-key',
      catalogEntriesByKind: {
        'plant': [
          catalogEntryJson('plant', 'ソメイヨシノ', confidence: 92, photoCount: 3),
          catalogEntryJson('plant', 'ハナトリカブト', confidence: 48, photoCount: 1),
        ],
        'food': [
          catalogEntryJson('food', '味噌ラーメン', confidence: 75, photoCount: 2)
        ],
      },
    );

/// 名前に番号を付けた [count] 件の植物の項目（ページを確かめる用。番号順が名前順）
List<Map<String, Object?>> _manyPlants(int count) => [
      for (var i = 0; i < count; i++)
        catalogEntryJson('plant', '植物${i.toString().padLeft(3, '0')}'),
    ];

/// 種類のタブ（Tab）
Finder _kindTab(String label) => find.widgetWithText(Tab, label);

void main() {
  testWidgets('下のタブの「図鑑（新）」を開くと、種類のタブを種類の一覧の順に出し、最初の種類（植物）の項目を並べる',
      (tester) async {
    await openCatalogTab(tester, _backend());

    for (final label in ['植物', '食べ物', '風景']) {
      expect(_kindTab(label), findsOneWidget);
    }
    // 項目の行: 名前・枚数・信頼度
    expect(find.text('ソメイヨシノ'), findsOneWidget);
    expect(find.text('3枚'), findsOneWidget);
    expect(find.text('92%'), findsOneWidget);
    expect(find.text('ハナトリカブト'), findsOneWidget);
    expect(find.text('48%'), findsOneWidget);
    expect(find.text('味噌ラーメン'), findsNothing);
  });

  testWidgets('種類のタブを切り替えると、その種類の項目を並べる', (tester) async {
    await openCatalogTab(tester, _backend());

    await tester.tap(_kindTab('食べ物'));
    await letFramesRun(tester);

    expect(find.text('味噌ラーメン'), findsOneWidget);
    expect(find.text('2枚'), findsOneWidget);
    expect(find.text('ソメイヨシノ'), findsNothing);
  });

  testWidgets('項目が無い種類は「{表示名}の項目はまだありません」と案内する', (tester) async {
    await openCatalogTab(tester, _backend());

    await tester.tap(_kindTab('風景'));
    await letFramesRun(tester);

    expect(find.text('風景の項目はまだありません'), findsOneWidget);
    expect(find.text('識別が済んだ写真が、ここにまとまります'), findsOneWidget);
  });

  testWidgets('アプリを開いても、図鑑のタブを開くまで図鑑の API を呼ばない', (tester) async {
    final backend = _backend();
    await openTripsTab(tester, backend);

    expect(backend.catalogRequestsReceived, 0);
  });

  testWidgets('下端まで動かすと続きを読み、offset は読んだ件数ではなく limit（50）だけ進める', (tester) async {
    // 1ページ目から1件が外れても（数えてから見出しを読むまでに写真が無くなった）、続きは 50 件目から。
    // 読んだ件数（49）で進めると、次のページで同じ項目が重なる（03 §6.1）
    final backend = FakeTripBackend(
        functionKey: 'test-key',
        catalogEntriesByKind: {'plant': _manyPlants(60)});
    backend.catalogVanishedNames.add('植物010');
    await openCatalogTab(tester, backend);

    await tester.drag(find.byType(ListView), const Offset(0, -20000));
    await letFramesRun(tester);
    await tester.drag(find.byType(ListView), const Offset(0, -20000));
    await letFramesRun(tester);

    expect(backend.catalogOffsetsReceived, [0, 50]);
    expect(find.text('植物059'), findsOneWidget);
    // 1ページ目の最後（植物049）と2ページ目の先頭（植物050）が1つずつ（重なっていない）
    await tester.dragUntilVisible(find.text('植物049'), find.byType(ListView), const Offset(0, 100));
    expect(find.text('植物049'), findsOneWidget);
    expect(find.text('植物050'), findsOneWidget);
  });

  testWidgets('総数まで読んだら、それ以上は続きを読まない', (tester) async {
    final backend = FakeTripBackend(
        functionKey: 'test-key',
        catalogEntriesByKind: {'plant': _manyPlants(50)});
    await openCatalogTab(tester, backend);

    await tester.drag(find.byType(ListView), const Offset(0, -20000));
    await letFramesRun(tester);

    expect(backend.catalogOffsetsReceived, [0]);
    expect(find.text('植物049'), findsOneWidget);
  });

  testWidgets('下に引っ張ると、先頭から読み直す', (tester) async {
    final backend = _backend();
    await openCatalogTab(tester, backend);
    backend.catalogEntriesByKind['plant']!
        .insert(0, catalogEntryJson('plant', 'アジサイ'));

    await tester.drag(find.byType(ListView), const Offset(0, 300));
    await letFramesRun(tester);

    expect(find.text('アジサイ'), findsOneWidget);
    expect(backend.catalogOffsetsReceived, [0, 0]);
  });

  group('読み込めないとき', () {
    testWidgets('種類の一覧を読めなければ、エラーと「再試行」を出し、再試行で読み直す', (tester) async {
      final backend = _backend();
      backend.failNext(TripRoute.catalogKinds);
      await openCatalogTab(tester, backend);

      expect(find.text('エラーが発生しました'), findsOneWidget);
      // 503 はアプリが言い換える（ApiException.userMessage）
      expect(find.text('サービスに一時的に接続できません。しばらく待ってから再試行してください。'), findsOneWidget);

      await tester.tap(find.text('再試行'));
      await letFramesRun(tester);

      expect(_kindTab('植物'), findsOneWidget);
      expect(find.text('ソメイヨシノ'), findsOneWidget);
    });

    testWidgets('項目の一覧を読めなければ、エラーと「再試行」を出し、再試行で読み直す', (tester) async {
      final backend = _backend();
      backend.failNext(TripRoute.catalogEntries,
          status: 500, code: 'INTERNAL_ERROR', message: '図鑑の一覧の取得に失敗しました');
      await openCatalogTab(tester, backend);

      expect(find.text('エラーが発生しました'), findsOneWidget);

      await tester.tap(find.text('再試行'));
      await letFramesRun(tester);

      expect(find.text('ソメイヨシノ'), findsOneWidget);
    });

    testWidgets('続きのページを読めなければ、一覧の下端に「続きを読み込めませんでした」と「再試行」を出す', (tester) async {
      final backend = FakeTripBackend(
          functionKey: 'test-key',
          catalogEntriesByKind: {'plant': _manyPlants(60)});
      await openCatalogTab(tester, backend);
      backend.failNext(TripRoute.catalogEntries);

      await tester.drag(find.byType(ListView), const Offset(0, -20000));
      await letFramesRun(tester);
      await tester.drag(find.byType(ListView), const Offset(0, -20000));
      await letFramesRun(tester);

      expect(find.text('続きを読み込めませんでした'), findsOneWidget);
      expect(find.text('植物049'), findsOneWidget);

      await tester.tap(find.text('再試行'));
      await letFramesRun(tester);
      await tester.drag(find.byType(ListView), const Offset(0, -20000));
      await letFramesRun(tester);

      expect(find.text('植物059'), findsOneWidget);
    });
  });
}
