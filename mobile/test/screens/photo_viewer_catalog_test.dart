import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:snaplant_mobile/screens/catalog_entry_screen.dart';

import '../helpers/app_test_helpers.dart';
import '../helpers/trip_test_helpers.dart';

// 写真ビューアの図鑑の項目へのリンク・分類と合わない写真・コメントの編集
// （docs/travel-album/03_screen_design.md §6.3。段階4の 4-3c）。入口は旅行詳細の写真のグリッドから開く写真ビューア

const _takenAt = '2026年10月6日 10:15';

/// 撮影日時が 2026年10月6日 10:15 の、識別が済んだ植物の写真（ソメイヨシノ）
Map<String, Object?> _photo(
        {bool matchesKind = true,
        String? comment,
        String? commentSource,
        String state = 'done'}) =>
    identifiedPhotoJson(
        number: 1,
        kind: 'plant',
        name: 'ソメイヨシノ',
        tripId: hokkaidoTripId,
        takenAt: '2026-10-06T10:15:00',
        matchesKind: matchesKind,
        description: 'サクラの栽培品種')
      ..['comment'] = comment
      ..['commentSource'] = commentSource
      ..['processing'] = {
        'state': state,
        'step': 'classify',
        'attempts': 0,
        'lastError': null,
        'updatedAt': '2026-10-18T03:00:00.000Z'
      };

/// 旅行詳細を開き、写真をタップしてビューアを開く
Future<FakeTripBackend> _openViewer(
    WidgetTester tester, Map<String, Object?> photo) async {
  final backend = FakeTripBackend(
    trips: [hokkaidoTrip(photoCount: 1)],
    functionKey: 'test-key',
    photosByTripId: {
      hokkaidoTripId: [photo]
    },
  );
  await openTripsTab(tester, backend);
  await tester.tap(find.text('北海道 2026秋'));
  await letFramesRun(tester);
  await tester.tap(photoThumbnail(_takenAt));
  await letFramesRun(tester);
  return backend;
}

/// 偽のサーバにある写真（コメントの編集で書き換わる）
Map<String, Object?> _stored(FakeTripBackend backend) =>
    backend.photosByTripId[hokkaidoTripId]!.single;

/// コメントの編集ダイアログの「保存」
Finder get _save =>
    find.descendant(of: find.byType(AlertDialog), matching: find.text('保存'));

void main() {
  group('図鑑の項目へのリンク', () {
    testWidgets('識別が済んだ写真は「{名前} >」を出し、タップすると種類と名前でその項目の詳細を開く', (tester) async {
      final semantics = tester.ensureSemantics();
      await _openViewer(tester, _photo());

      await tester.tap(find.text('ソメイヨシノ >'));
      await letFramesRun(tester);

      expect(find.byType(CatalogEntryScreen), findsOneWidget);
      expect(find.widgetWithText(AppBar, 'ソメイヨシノ'), findsOneWidget);
      // 見出しはその種類（植物）の欄で出す（種類の一覧を読んでから開く）
      expect(find.text('サクラの栽培品種'), findsOneWidget);
      expect(find.text('学名'), findsOneWidget);
      semantics.dispose();
    });

    testWidgets('種類の一覧を読めなければ、エラーの文言をスナックバーに出して開かない', (tester) async {
      final backend = await _openViewer(tester, _photo());
      backend.failNext(TripRoute.catalogKinds);

      await tester.tap(find.text('ソメイヨシノ >'));
      await letFramesRun(tester);

      expect(find.byType(CatalogEntryScreen), findsNothing);
      expect(
          find.descendant(
              of: find.byType(SnackBar),
              matching: find.text('サービスに一時的に接続できません。しばらく待ってから再試行してください。')),
          findsOneWidget);
    });

    testWidgets('分類と合わない写真は、リンクの代わりに案内と「やり直す」を出し、「やり直す」でやり直しダイアログを開く',
        (tester) async {
      await _openViewer(tester, _photo(matchesKind: false));

      expect(find.text('ソメイヨシノ >'), findsNothing);
      expect(find.text('分類と合わない写真です。やり直しで手がかりを付けてください'), findsOneWidget);

      await tester.tap(find.byElementPredicate((element) =>
          element.widget is Text &&
          (element.widget as Text).data == 'やり直す' &&
          element.findAncestorWidgetOfExactType<AppBar>() == null));
      await letFramesRun(tester);

      expect(find.text('解析をやり直す'), findsOneWidget);
    });

    testWidgets('種類の一覧に無い種類の写真は、その種類の欄の無い項目の詳細を開く', (tester) async {
      // 種類を減らした後の古い識別など。開けないままにせず、名前で項目の詳細を開く
      final backend = await _openViewer(tester, _photo());
      backend.catalogKinds.removeWhere((kind) => kind['kind'] == 'plant');

      await tester.tap(find.text('ソメイヨシノ >'));
      await letFramesRun(tester);

      expect(find.byType(CatalogEntryScreen), findsOneWidget);
      expect(find.widgetWithText(AppBar, 'ソメイヨシノ'), findsOneWidget);
      expect(find.text('学名'), findsNothing);
    });

    // 前回の識別は、やり直しの結果が出るまで残る（05 §5.7）
    for (final (matchesKind, label, text) in [
      (true, '項目へのリンク', 'ソメイヨシノ >'),
      (false, '分類と合わない写真の案内', '分類と合わない写真です。やり直しで手がかりを付けてください')
    ]) {
      testWidgets('やり直しを待っている間も、前回の識別から$labelを出す', (tester) async {
        await _openViewer(
            tester, _photo(matchesKind: matchesKind, state: 'pending'));

        expect(find.text('分類中...'), findsOneWidget);
        expect(find.text(text), findsOneWidget);
      });
    }
  });

  group('コメント', () {
    testWidgets('AI のコメントを出す', (tester) async {
      await _openViewer(tester, _photo(comment: '満開のサクラ', commentSource: 'ai'));

      expect(find.text('満開のサクラ'), findsOneWidget);
      expect(find.textContaining('（編集済み）'), findsNothing);
    });

    testWidgets('利用者が直したコメントには「（編集済み）」を付ける', (tester) async {
      await _openViewer(
          tester, _photo(comment: '旅の最初の一枚', commentSource: 'user'));

      expect(find.text('旅の最初の一枚（編集済み）'), findsOneWidget);
    });

    testWidgets('「コメントを編集」で今のコメントを入れたダイアログを開き、保存するとサーバのコメントと表示が変わる',
        (tester) async {
      final backend = await _openViewer(
          tester, _photo(comment: '満開のサクラ', commentSource: 'ai'));

      await tester.tap(find.text('コメントを編集'));
      await letFramesRun(tester);
      expect(find.text('コメントを編集'), findsNWidgets(2)); // ボタンとダイアログの見出し
      expect(
          find.descendant(
              of: find.byType(AlertDialog), matching: find.text('満開のサクラ')),
          findsOneWidget);
      expect(find.text('6/500'), findsOneWidget); // 最大500文字（03 §6.3）
      await tester.enterText(
          find.descendant(
              of: find.byType(AlertDialog), matching: find.byType(TextField)),
          '  北海道で見た桜  ');
      await tester.tap(_save);
      await letFramesRun(tester);

      expect(find.byType(AlertDialog), findsNothing);
      expect(_stored(backend)['comment'], '北海道で見た桜');
      expect(_stored(backend)['commentSource'], 'user');
      expect(find.text('北海道で見た桜（編集済み）'), findsOneWidget);
      expect(
          find.descendant(
              of: find.byType(SnackBar), matching: find.text('コメントを保存しました')),
          findsOneWidget);
    });

    testWidgets('空のまま保存すると、コメントを消す', (tester) async {
      final backend = await _openViewer(
          tester, _photo(comment: '満開のサクラ', commentSource: 'ai'));

      await tester.tap(find.text('コメントを編集'));
      await letFramesRun(tester);
      await tester.enterText(
          find.descendant(
              of: find.byType(AlertDialog), matching: find.byType(TextField)),
          '   ');
      await tester.tap(_save);
      await letFramesRun(tester);

      expect(_stored(backend)['comment'], isNull);
      expect(find.text('満開のサクラ'), findsNothing);
    });

    testWidgets('保存に失敗したら、ダイアログに留まって理由を出す', (tester) async {
      final backend = await _openViewer(
          tester, _photo(comment: '満開のサクラ', commentSource: 'ai'));
      backend.failNext(TripRoute.updatePhoto,
          status: 500, code: 'INTERNAL_ERROR', message: '写真の更新に失敗しました');

      await tester.tap(find.text('コメントを編集'));
      await letFramesRun(tester);
      await tester.enterText(
          find.descendant(
              of: find.byType(AlertDialog), matching: find.byType(TextField)),
          '北海道で見た桜');
      await tester.tap(_save);
      await letFramesRun(tester);

      expect(find.byType(AlertDialog), findsOneWidget);
      expect(find.text('サーバーで問題が発生しています。しばらく待ってから再試行してください。'), findsOneWidget);
      expect(_stored(backend)['comment'], '満開のサクラ');
    });

    testWidgets(
        '保存を待っている間は、入力欄と「保存」を押せず、端末の戻る操作でも「キャンセル」でもダイアログを閉じず、保存できたら閉じてコメントを出す',
        (tester) async {
      // 待っている間に閉じると、保存されたのに表示が古いまま残る（やり直しダイアログと同じ）
      final backend = await _openViewer(
          tester, _photo(comment: '満開のサクラ', commentSource: 'ai'));
      final release = Completer<void>();
      addTearDown(() {
        if (!release.isCompleted) release.complete();
      });
      backend.holds[TripRoute.updatePhoto] = release.future;

      await tester.tap(find.text('コメントを編集'));
      await letFramesRun(tester);
      await tester.enterText(
          find.descendant(
              of: find.byType(AlertDialog), matching: find.byType(TextField)),
          '北海道で見た桜');
      await tester.tap(_save);
      await letFramesRun(tester);
      await tester.binding.handlePopRoute();
      await letFramesRun(tester);
      await tester.tap(find.descendant(
          of: find.byType(AlertDialog), matching: find.text('キャンセル')));
      await letFramesRun(tester);

      expect(find.byType(AlertDialog), findsOneWidget);
      expect(
          tester
              .widget<TextField>(find.descendant(
                  of: find.byType(AlertDialog),
                  matching: find.byType(TextField)))
              .enabled,
          isFalse);
      expect(
          tester
              .widget<ButtonStyleButton>(find.ancestor(
                  of: _save,
                  matching: find.byWidgetPredicate(
                      (widget) => widget is ButtonStyleButton)))
              .enabled,
          isFalse);
      release.complete();
      await letFramesRun(tester);
      expect(find.byType(AlertDialog), findsNothing);
      expect(find.text('北海道で見た桜（編集済み）'), findsOneWidget);
    });

    testWidgets('コメントが長くても下の情報が画面からあふれず、「コメントを編集」を押せる（小さな端末）', (tester) async {
      // AI のコメントの長さはサーバで決めていない。下の情報が画面を占めると、写真と「コメントを編集」が見えなくなる
      await _openViewer(
          tester, _photo(comment: 'とても長いコメント。' * 80, commentSource: 'ai'));
      // アプリを開くときに画面の大きさを決め直すので、その後で小さな端末（360×640）にする
      tester.view.physicalSize = const Size(360 * 3, 640 * 3);
      tester.view.devicePixelRatio = 3;
      await letFramesRun(tester);

      final edit = find.text('コメントを編集');
      expect(tester.getRect(edit).bottom, lessThanOrEqualTo(640));
      await tester.tap(edit);
      await letFramesRun(tester);
      expect(find.byType(AlertDialog), findsOneWidget);
    });

    testWidgets('解析中の写真でも、コメントを編集できる', (tester) async {
      // 自動の解析は利用者のコメントを消さない（06 §3.2）。解析中で操作を止めるロックは無い
      final backend = await _openViewer(tester, _photo(state: 'pending'));

      await tester.tap(find.text('コメントを編集'));
      await letFramesRun(tester);
      await tester.enterText(
          find.descendant(
              of: find.byType(AlertDialog), matching: find.byType(TextField)),
          '解析を待っている写真');
      await tester.tap(_save);
      await letFramesRun(tester);

      expect(_stored(backend)['comment'], '解析を待っている写真');
      expect(find.text('解析を待っている写真（編集済み）'), findsOneWidget);
    });
  });
}
