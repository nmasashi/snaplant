import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:snaplant_mobile/screens/catalog_screen.dart';

import '../helpers/app_test_helpers.dart';
import '../helpers/trip_test_helpers.dart';

// 図鑑のタブ（docs/03_screen_design.md §6.1。段階4の 4-3a）。
// 入口は下のタブの「図鑑」（起動時のタブ）。図鑑の API は偽のサーバ（FakeTripBackend）が返す

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
  testWidgets('アプリを開くと図鑑のタブが開き、種類のタブを種類の一覧の順に出し、最初の種類（植物）の項目を並べる',
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

  testWidgets('種類のタブの文字は、選んでいるタブは白、選んでいないタブは薄い白で出す（見出しの緑の上で読めるように）',
      (tester) async {
    await openCatalogTab(tester, _backend());
    // 先頭以外を選ぶ（開いた直後は「選んでいるタブ」と「先頭のタブ」の区別がつかないため）
    await tester.tap(_kindTab('食べ物'));
    await letFramesRun(tester);

    Color? colorOf(String label) => tester
        .widget<RichText>(
            find.descendant(of: _kindTab(label), matching: find.byType(RichText)))
        .text
        .style
        ?.color;
    expect(colorOf('食べ物'), Colors.white);
    expect(colorOf('植物'), Colors.white70);
    expect(colorOf('風景'), Colors.white70);
  });

  testWidgets('種類のタブの表示名と順は、アプリの表ではなく種類の一覧の応答に従う', (tester) async {
    // 種類はサーバの定義表が決める（05 §5.14）。応答に無い種類のタブは出さない
    final backend = _backend()
      ..catalogKinds = [
        {'kind': 'food', 'label': 'ごはん', 'fields': <Object?>[]},
        {'kind': 'plant', 'label': '植物', 'fields': <Object?>[]},
      ];
    await openCatalogTab(tester, backend);

    expect(_kindTab('風景'), findsNothing);
    expect(_kindTab('食べ物'), findsNothing);
    expect(tester.getTopLeft(_kindTab('ごはん')).dx,
        lessThan(tester.getTopLeft(_kindTab('植物')).dx));
    // 最初の種類（食べ物）の項目を並べる
    expect(find.text('味噌ラーメン'), findsOneWidget);
    expect(find.text('ソメイヨシノ'), findsNothing);
  });

  testWidgets('種類が1つ（植物だけ）なら種類のタブを出さず、その種類の項目を並べる', (tester) async {
    // 図鑑に載せるのは植物だけ（02 §5 #51）。タブが1つだけの帯は出さない（03 §6.1）
    final backend = _backend()
      ..catalogKinds = [
        {'kind': 'plant', 'label': '植物', 'fields': <Object?>[]},
      ];
    await openCatalogTab(tester, backend);

    // 帯ごと無いことを見る（表示名の無いタブの帯でも落ちるように）。下のタブの旅行の画面は見ない
    expect(
        find.descendant(
            of: find.byType(CatalogScreen), matching: find.byType(TabBar)),
        findsNothing);
    expect(find.text('ソメイヨシノ'), findsOneWidget);
    expect(find.text('ハナトリカブト'), findsOneWidget);
  });

  testWidgets('信頼度が小数でも四捨五入して出し、説明と特徴が無い項目も並べる', (tester) async {
    // 信頼度は数（小数もある）で、説明と特徴は AI が返さなければ null（05 §3.3.1）
    final backend =
        FakeTripBackend(functionKey: 'test-key', catalogEntriesByKind: {
      'plant': [
        catalogEntryJson('plant', 'ユキノシタ',
            confidence: 87.6, description: null, characteristics: null),
      ],
    });
    await openCatalogTab(tester, backend);

    expect(find.text('ユキノシタ'), findsOneWidget);
    expect(find.text('88%'), findsOneWidget);
  });

  testWidgets('種類のタブを切り替えると、その種類の項目を並べる', (tester) async {
    await openCatalogTab(tester, _backend());

    await tester.tap(_kindTab('食べ物'));
    await letFramesRun(tester);

    expect(find.text('味噌ラーメン'), findsOneWidget);
    expect(find.text('2枚'), findsOneWidget);
    expect(find.text('ソメイヨシノ'), findsNothing);
  });

  testWidgets('項目が無い種類は「{表示名}の項目はまだありません」と案内し、下に引っ張ると読み直す', (tester) async {
    final backend = _backend();
    await openCatalogTab(tester, backend);
    await tester.tap(_kindTab('風景'));
    await letFramesRun(tester);

    expect(find.text('風景の項目はまだありません'), findsOneWidget);
    expect(find.text('識別が済んだ写真が、ここにまとまります'), findsOneWidget);

    backend.catalogEntriesByKind['landscape'] = [
      catalogEntryJson('landscape', '函館山')
    ];

    await tester.drag(find.text('風景の項目はまだありません'), const Offset(0, 300));
    await letFramesRun(tester);

    expect(find.text('函館山'), findsOneWidget);
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
    await tester.dragUntilVisible(
        find.text('植物049'), find.byType(ListView), const Offset(0, 100));
    expect(find.text('植物049'), findsOneWidget);
    expect(find.text('植物050'), findsOneWidget);
  });

  testWidgets('2ページ目で外れた項目があっても、3ページ目の offset は 100（limit だけ進める）',
      (tester) async {
    final backend = FakeTripBackend(
        functionKey: 'test-key',
        catalogEntriesByKind: {'plant': _manyPlants(110)});
    backend.catalogVanishedNames.add('植物060');
    await openCatalogTab(tester, backend);

    for (var i = 0; i < 4; i++) {
      await tester.drag(find.byType(ListView), const Offset(0, -20000));
      await letFramesRun(tester);
    }

    expect(backend.catalogOffsetsReceived, [0, 50, 100]);
    expect(find.text('植物109'), findsOneWidget);
  });

  testWidgets('1ページ目の項目がすべて外れていても、続きを読んで並べる', (tester) async {
    // 行が無いので下端に近づくきっかけが来ない。それでも続きを読む（03 §6.1）
    final backend = FakeTripBackend(
        functionKey: 'test-key',
        catalogEntriesByKind: {'plant': _manyPlants(60)});
    backend.catalogVanishedNames.addAll(
        [for (var i = 0; i < 50; i++) '植物${i.toString().padLeft(3, '0')}']);
    await openCatalogTab(tester, backend);

    expect(find.text('植物050'), findsOneWidget);
    expect(find.text('植物の項目はまだありません'), findsNothing);
  });

  testWidgets('別の種類のタブへ移ってから戻ると、先頭から読み直す', (tester) async {
    // 種類タブを切り替えるたびに先頭から読み込み直す（03 §6.1）
    final backend = _backend();
    await openCatalogTab(tester, backend);
    backend.catalogEntriesByKind['plant']!
        .insert(0, catalogEntryJson('plant', 'アジサイ'));

    await tester.tap(_kindTab('食べ物'));
    await letFramesRun(tester);
    await tester.tap(_kindTab('植物'));
    await letFramesRun(tester);

    expect(find.text('アジサイ'), findsOneWidget);
  });

  testWidgets('種類の一覧を読んでいる間も、種類のタブを出した後に項目を読んでいる間も「図鑑を読み込み中...」を出す', (tester) async {
    final backend = _backend();
    final releaseKinds = Completer<void>();
    final releaseEntries = Completer<void>();
    backend.holds[TripRoute.catalogKinds] = releaseKinds.future;
    backend.holds[TripRoute.catalogEntries] = releaseEntries.future;
    await openCatalogTab(tester, backend);

    expect(_kindTab('植物'), findsNothing);
    expect(find.text('図鑑を読み込み中...'), findsOneWidget);

    releaseKinds.complete();
    await letFramesRun(tester);
    expect(_kindTab('植物'), findsOneWidget);
    expect(find.text('図鑑を読み込み中...'), findsOneWidget);

    releaseEntries.complete();
    await letFramesRun(tester);
    expect(find.text('ソメイヨシノ'), findsOneWidget);
  });

  testWidgets('一覧を出したまま下に引っ張った読み直しに失敗したら、一覧はそのままにしてエラーをスナックバーに出す',
      (tester) async {
    final backend = _backend();
    await openCatalogTab(tester, backend);
    backend.failNext(TripRoute.catalogEntries);

    await tester.drag(find.byType(ListView), const Offset(0, 300));
    await letFramesRun(tester);

    expect(find.text('ソメイヨシノ'), findsOneWidget);
    expect(
        find.descendant(
            of: find.byType(SnackBar),
            matching: find.text('サービスに一時的に接続できません。しばらく待ってから再試行してください。')),
        findsOneWidget);
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

    testWidgets('サーバに接続できなければ、接続を確かめるよう案内する', (tester) async {
      final backend = _backend();
      backend.failNextWithConnectionError(TripRoute.catalogKinds);
      await openCatalogTab(tester, backend);

      expect(find.text('ネットワークに接続できません。インターネット接続を確認してください。'), findsOneWidget);
    });

    testWidgets('項目の一覧を読めなければ、エラーと「再試行」を出し、再試行で読み直す', (tester) async {
      final backend = _backend();
      backend.failNext(TripRoute.catalogEntries,
          status: 500, code: 'INTERNAL_ERROR', message: '図鑑の一覧の取得に失敗しました');
      await openCatalogTab(tester, backend);

      expect(find.text('エラーが発生しました'), findsOneWidget);
      // 500 はアプリが言い換える（ApiException.userMessage）
      expect(find.text('サーバーで問題が発生しています。しばらく待ってから再試行してください。'), findsOneWidget);

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

  group('読み直しと続きの読み込みが重なったとき', () {
    /// 一覧を先頭まで戻してから下に引っ張る
    Future<void> pullToRefresh(WidgetTester tester) async {
      await tester.drag(find.byType(ListView), const Offset(0, 20000));
      await tester.pump();
      await tester.drag(find.byType(ListView), const Offset(0, 300));
      await letFramesRun(tester);
    }

    Future<void> dragToBottom(WidgetTester tester) async {
      await tester.drag(find.byType(ListView), const Offset(0, -20000));
      await letFramesRun(tester);
    }

    testWidgets('続きを読んでいる間の読み直しが失敗しても、続きの結果を並べ、「読み込み中...」のまま止まらない',
        (tester) async {
      final backend = FakeTripBackend(
          functionKey: 'test-key',
          catalogEntriesByKind: {'plant': _manyPlants(60)});
      await openCatalogTab(tester, backend);
      final moreReply = backend.holdNextReply(TripRoute.catalogEntries);
      await dragToBottom(tester);
      backend.failNext(TripRoute.catalogEntries);

      await pullToRefresh(tester);
      moreReply.complete();
      await letFramesRun(tester);
      await dragToBottom(tester);

      expect(find.text('読み込み中...'), findsNothing);
      expect(find.text('植物059'), findsOneWidget);
    });

    testWidgets('読み直しの間に始めた続きは、読み直しの結果が先に出たら捨て、読み直した1ページ目の続きから読む',
        (tester) async {
      // 読み直しは1ページ目（50件）に戻る。その前の位置（100件目）からの続きを、戻った一覧の後ろにつながない
      final backend = FakeTripBackend(
          functionKey: 'test-key',
          catalogEntriesByKind: {'plant': _manyPlants(160)});
      await openCatalogTab(tester, backend);
      await dragToBottom(tester);
      await dragToBottom(tester);
      final before = [...backend.catalogOffsetsReceived];
      expect(before.last, greaterThan(0));
      final refreshReply = backend.holdNextReply(TripRoute.catalogEntries);
      final moreReply = backend.holdNextReply(TripRoute.catalogEntries);

      await pullToRefresh(tester);
      await dragToBottom(tester);
      refreshReply.complete();
      await letFramesRun(tester);
      moreReply.complete();
      await letFramesRun(tester);
      await dragToBottom(tester);

      await dragToBottom(tester);

      // 読み直し（0）・重なった続き（前の位置の次。捨てる）・読み直した1ページ目の続き（50）・その次（100）。
      // 重なった続きを捨てずにつなぐと、その分だけ位置が進み、次は 100 ではなくなる
      expect(backend.catalogOffsetsReceived.take(before.length + 4),
          [...before, 0, before.last + 50, 50, 100]);
    });
  });
}
