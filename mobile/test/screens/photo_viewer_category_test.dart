import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../helpers/app_test_helpers.dart';
import '../helpers/trip_test_helpers.dart';

// 写真ビューアでカテゴリを手で直す（docs/03_screen_design.md §5.6。C-1。02 §5 #53）。
// 入口は旅行詳細の写真のグリッドから開く写真ビューア

const _takenAt = '2026年10月6日 10:15';

/// 撮影日時が 2026年10月6日 10:15 の写真。[category] と [state] で分類の結果と進み具合を決める
Map<String, Object?> _photo(
        {String? category,
        String state = 'done',
        String step = 'classify',
        int number = 1}) =>
    photoJson(
        number: number,
        tripId: hokkaidoTripId,
        takenAt: '2026-10-${(5 + number).toString().padLeft(2, '0')}T10:15:00')
      ..['category'] = category
      ..['processing'] = {
        'state': state,
        'step': step,
        'attempts': state == 'failed' ? 3 : 0,
        'lastError': state == 'failed' ? 'ai' : null,
        'updatedAt': '2026-10-18T03:00:00.000Z'
      };

/// 旅行詳細を開き、1枚目の写真をタップしてビューアを開く（[more] の写真は後ろに並べる）
Future<FakeTripBackend> _openViewer(
    WidgetTester tester, Map<String, Object?> photo,
    {List<Map<String, Object?>> more = const []}) async {
  final backend = FakeTripBackend(
    trips: [hokkaidoTrip(photoCount: 1 + more.length)],
    functionKey: 'test-key',
    photosByTripId: {
      hokkaidoTripId: [photo, ...more]
    },
  );
  await openTripsTab(tester, backend);
  await tester.tap(find.text('北海道 2026秋'));
  await letFramesRun(tester);
  await tester.tap(photoThumbnail(_takenAt));
  await letFramesRun(tester);
  return backend;
}

/// 偽のサーバにある1枚目の写真（カテゴリの保存で書き換わる）
Map<String, Object?> _stored(FakeTripBackend backend) =>
    backend.photosByTripId[hokkaidoTripId]!.first;

/// 上のバーの解析を頼むボタン（カテゴリで印と説明が変わる。植物「植物を調べる」、食べ物・風景「コメントを書いてもらう」、カテゴリの無い写真「分類し直す」。03 §5.4）
Finder get _barRetry => find.descendant(
    of: find.byType(AppBar),
    matching: find.byWidgetPredicate((widget) =>
        widget is IconButton &&
        const {'植物を調べる', 'コメントを書いてもらう', '分類し直す'}.contains(widget.tooltip)));

/// カテゴリを選ぶシートの選択肢 [label]
Finder _option(String label) =>
    find.descendant(of: find.byType(BottomSheet), matching: find.text(label));

/// シートの「保存」
Finder get _save =>
    find.descendant(of: find.byType(BottomSheet), matching: find.text('保存'));

void main() {
  testWidgets('カテゴリのボタンを押すと、「カテゴリを変える」のシートに4つの選択肢を出し、今のカテゴリを選んでおく',
      (tester) async {
    await _openViewer(tester, _photo(category: 'food'));

    await tester.tap(find.widgetWithText(OutlinedButton, '食べ物'));
    await letFramesRun(tester);

    expect(find.text('カテゴリを変える'), findsOneWidget);
    for (final label in ['植物', '食べ物', '風景', 'その他']) {
      expect(_option(label), findsOneWidget, reason: label);
    }
    expect(
        tester.getSemantics(find.widgetWithText(RadioListTile<String>, '食べ物')),
        containsSemantics(isChecked: true));
    expect(
        tester.getSemantics(find.widgetWithText(RadioListTile<String>, '植物')),
        containsSemantics(isChecked: false));
  });

  testWidgets(
      '植物を選ぶと品種を調べる旨を出し、保存すると手で決めたカテゴリになって「植物（変更済み）」「識別中...」「カテゴリを変えました」を出す',
      (tester) async {
    final backend = await _openViewer(tester, _photo(category: 'landscape'));

    await tester.tap(find.widgetWithText(OutlinedButton, '風景'));
    await letFramesRun(tester);
    await tester.tap(_option('植物'));
    await tester.pump();
    expect(find.text('植物にすると、品種を調べます。'), findsOneWidget);
    await tester.tap(_save);
    await letFramesRun(tester);

    expect(find.byType(BottomSheet), findsNothing);
    expect(find.text('カテゴリを変えました'), findsOneWidget);
    expect(find.widgetWithText(OutlinedButton, '植物（変更済み）'), findsOneWidget);
    expect(find.text('識別中...'), findsOneWidget);
    expect(_stored(backend)['category'], 'plant');
    expect(_stored(backend)['categorySource'], 'user');
  });

  testWidgets('今のカテゴリのまま保存すると、何も送らずに閉じる', (tester) async {
    // 送ると、AI のカテゴリが「手で決めた」ものになり「（変更済み）」が付く（コメントの編集と同じ）
    final backend = await _openViewer(tester, _photo(category: 'food'));

    await tester.tap(find.widgetWithText(OutlinedButton, '食べ物'));
    await letFramesRun(tester);
    await tester.tap(_save);
    await letFramesRun(tester);

    expect(find.byType(BottomSheet), findsNothing);
    expect(find.text('カテゴリを変えました'), findsNothing);
    expect(find.widgetWithText(OutlinedButton, '食べ物'), findsOneWidget);
    expect(_stored(backend)['categorySource'], isNull);
  });

  for (final (state, label) in [
    ('pending', '待っている'),
    ('classifying', 'している')
  ]) {
    testWidgets('分類を$labelカテゴリのある写真では、今のカテゴリのまま保存しても送り、手で決めたカテゴリにする',
        (tester) async {
      // 送らないと、後で AI の分類がカテゴリを書き換える（サーバは、分類中なら同じカテゴリでも分類を止める。05 §5.6）
      final backend =
          await _openViewer(tester, _photo(category: 'plant', state: state));

      await tester.tap(find.widgetWithText(OutlinedButton, '植物'));
      await letFramesRun(tester);
      // 植物のまま保存しても品種を調べ始めるので、その旨を出す
      expect(find.text('植物にすると、品種を調べます。'), findsOneWidget);
      await tester.tap(_save);
      await letFramesRun(tester);

      expect(find.widgetWithText(OutlinedButton, '植物（変更済み）'), findsOneWidget);
      expect(_stored(backend)['categorySource'], 'user');
      expect((_stored(backend)['processing'] as Map)['step'], 'identify');
    });
  }

  testWidgets('分類に失敗したカテゴリのある写真では、今のカテゴリのまま保存しても送り、失敗から出す', (tester) async {
    // 分類に失敗しても前のカテゴリが残っていることがある。手で決めれば、分類をやり直さずに済む（05 §5.6）
    final backend =
        await _openViewer(tester, _photo(category: 'food', state: 'failed'));

    await tester.tap(find.widgetWithText(OutlinedButton, '食べ物'));
    await letFramesRun(tester);
    await tester.tap(_save);
    await letFramesRun(tester);

    expect(find.widgetWithText(OutlinedButton, '食べ物（変更済み）'), findsOneWidget);
    expect(find.text('分類に失敗しました'), findsNothing);
    expect(_stored(backend)['categorySource'], 'user');
  });

  testWidgets('保存に失敗したら、シートに留まって理由を出す', (tester) async {
    final backend = await _openViewer(tester, _photo(category: 'food'));
    backend.failNext(TripRoute.updatePhoto,
        status: 500, code: 'INTERNAL_ERROR', message: '写真の更新に失敗しました');

    await tester.tap(find.widgetWithText(OutlinedButton, '食べ物'));
    await letFramesRun(tester);
    await tester.tap(_option('風景'));
    await tester.pump();
    await tester.tap(_save);
    await letFramesRun(tester);

    expect(find.byType(BottomSheet), findsOneWidget);
    expect(
        find.descendant(
            of: find.byType(BottomSheet),
            matching: find.text('サーバーで問題が発生しています。しばらく待ってから再試行してください。')),
        findsOneWidget);
    expect(_stored(backend)['category'], 'food');
  });

  testWidgets('その他の写真は、カテゴリのボタン「その他」を出し、上のバーの解析を頼むボタンは出さない（調べるものが無い）',
      (tester) async {
    await _openViewer(tester, _photo(category: 'other'));

    expect(find.widgetWithText(OutlinedButton, 'その他'), findsOneWidget);
    expect(_barRetry, findsNothing);
  });

  testWidgets('分類に失敗してカテゴリの無い写真は「カテゴリを選ぶ」から手で決められる', (tester) async {
    final backend =
        await _openViewer(tester, _photo(category: null, state: 'failed'));

    await tester.tap(find.widgetWithText(OutlinedButton, 'カテゴリを選ぶ'));
    await letFramesRun(tester);
    await tester.tap(_option('食べ物'));
    await tester.pump();
    await tester.tap(_save);
    await letFramesRun(tester);

    expect(find.widgetWithText(OutlinedButton, '食べ物（変更済み）'), findsOneWidget);
    expect(find.text('分類に失敗しました'), findsNothing);
    expect(_stored(backend)['category'], 'food');
  });

  testWidgets('保存を待っている間は、下へ払っても端末の戻る操作でもシートを閉じず、保存できたら閉じてカテゴリを出す',
      (tester) async {
    // 待っている間に閉じると、保存されたのに表示が古いまま残る（03 §5.6）
    final backend = await _openViewer(tester, _photo(category: 'food'));
    final release = Completer<void>();
    // 途中の確かめで落ちても、止めた応答を残さない
    addTearDown(() {
      if (!release.isCompleted) release.complete();
    });
    backend.holds[TripRoute.updatePhoto] = release.future;

    await tester.tap(find.widgetWithText(OutlinedButton, '食べ物'));
    await letFramesRun(tester);
    await tester.tap(_option('風景'));
    await tester.pump();
    await tester.tap(_save);
    await letFramesRun(tester);
    await tester.drag(find.text('カテゴリを変える'), const Offset(0, 500));
    await letFramesRun(tester);
    await tester.binding.handlePopRoute();
    await letFramesRun(tester);

    expect(find.byType(BottomSheet), findsOneWidget);
    release.complete();
    await letFramesRun(tester);
    expect(find.byType(BottomSheet), findsNothing);
    expect(find.widgetWithText(OutlinedButton, '風景（変更済み）'), findsOneWidget);
  });

  for (final (state, label) in [
    ('pending', '待っている'),
    ('classifying', 'している')
  ]) {
    testWidgets('分類を$labelカテゴリの無い写真には、カテゴリのボタンを出さない', (tester) async {
      await _openViewer(tester, _photo(category: null, state: state));

      expect(find.text('分類中...'), findsOneWidget);
      expect(find.text('カテゴリを選ぶ'), findsNothing);
    });
  }

  testWidgets('シートで「その他」に変えると、上のバーの解析を頼むボタンが消える', (tester) async {
    // 残ると、押したときに分類からやり直しになり、手で決めたカテゴリを AI に任せ直してしまう
    await _openViewer(tester, _photo(category: 'food'));
    expect(_barRetry, findsOneWidget);

    await tester.tap(find.widgetWithText(OutlinedButton, '食べ物'));
    await letFramesRun(tester);
    await tester.tap(_option('その他'));
    await tester.pump();
    await tester.tap(_save);
    await letFramesRun(tester);

    expect(find.widgetWithText(OutlinedButton, 'その他（変更済み）'), findsOneWidget);
    expect(_barRetry, findsNothing);
  });

  testWidgets('その他の写真から次の写真（植物）へ送ると、上のバーに解析を頼むボタンが出る', (tester) async {
    await _openViewer(tester, _photo(category: 'other'),
        more: [_photo(category: 'plant', number: 2)]);
    expect(_barRetry, findsNothing);

    await tester.fling(find.byType(PageView), const Offset(-300, 0), 1000);
    await letFramesRun(tester);

    expect(_barRetry, findsOneWidget);
  });
}
