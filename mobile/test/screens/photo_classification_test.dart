import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../helpers/app_test_helpers.dart';
import '../helpers/trip_test_helpers.dart';

// 写真の分類の表示と、解析のやり直し（docs/travel-album/03_screen_design.md §5.1・§5.4・§5.5。段階3）。
// 入口は旅行詳細の写真のグリッドと、そこから開く写真ビューア

/// 解析の進み具合（processing）
Map<String, Object?> _processing(String state, {String? step = 'classify'}) => {
      'state': state,
      'step': step,
      'attempts': state == 'failed' ? 3 : 0,
      'lastError': state == 'failed' ? 'ai' : null,
      'updatedAt': '2026-10-18T03:00:00.000Z'
    };

/// 撮影日時が 2026年10月6日 10:15 の写真。[category] と [state] で分類の結果と進み具合を決める
Map<String, Object?> _photo(
        {String? category,
        String state = 'done',
        String? hint,
        String? comment,
        String? commentSource}) =>
    photoJson(number: 1, tripId: hokkaidoTripId, takenAt: '2026-10-06T10:15:00')
      ..['category'] = category
      ..['processing'] = _processing(state)
      ..['hint'] = hint
      ..['comment'] = comment
      ..['commentSource'] = commentSource;

const _takenAt = '2026年10月6日 10:15';

/// 旅行詳細を開く（写真は [photo] の1枚）
Future<FakeTripBackend> _openTripDetail(
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
  return backend;
}

/// 旅行詳細を開き、写真をタップしてビューアを開く
Future<FakeTripBackend> _openViewer(
    WidgetTester tester, Map<String, Object?> photo) async {
  final backend = await _openTripDetail(tester, photo);
  await tester.tap(photoThumbnail(_takenAt));
  await letFramesRun(tester);
  return backend;
}

/// 上のバーの「やり直す」（失敗したときは下の情報にも同じ文言のボタンが出るので、バーの中に絞る）
Finder get _barRetry =>
    find.descendant(of: find.byType(AppBar), matching: find.text('やり直す'));

/// やり直しダイアログの「やり直す」
Finder get _dialogRetry =>
    find.descendant(of: find.byType(AlertDialog), matching: find.text('やり直す'));

/// 偽のサーバにある写真（やり直しで書き換わる）
Map<String, Object?> _stored(FakeTripBackend backend) =>
    backend.photosByTripId[hokkaidoTripId]!.single;

void main() {
  group('写真ビューアのカテゴリ', () {
    for (final (category, label) in [
      ('plant', '植物'),
      ('food', '食べ物'),
      ('landscape', '風景'),
      ('other', 'その他')
    ]) {
      testWidgets('分類の結果が $category の写真は、カテゴリを「$label」と出す', (tester) async {
        await _openViewer(tester, _photo(category: category));

        expect(find.text(label), findsOneWidget);
      });
    }

    testWidgets('分類の前の写真（カテゴリが無い）には、カテゴリを出さない', (tester) async {
      await _openViewer(tester, _photo(category: null, state: 'none'));

      for (final label in ['植物', '食べ物', '風景', 'その他']) {
        expect(find.text(label), findsNothing);
      }
    });
  });

  group('写真ビューアの分類の状態', () {
    for (final state in ['pending', 'classifying']) {
      testWidgets('分類を待っている・している写真（$state）は「分類中...」と出す', (tester) async {
        await _openViewer(tester, _photo(state: state));

        expect(find.text('分類中...'), findsOneWidget);
      });
    }

    testWidgets('上限まで分類に失敗した写真は「分類に失敗しました」と、その場で押せる「やり直す」を出す', (tester) async {
      await _openViewer(tester, _photo(state: 'failed'));

      expect(find.text('分類に失敗しました'), findsOneWidget);
      // 上のバーの「やり直す」は1つ。全体で2つあるので、もう1つが下の情報の「やり直す」
      expect(
          find.descendant(of: find.byType(AppBar), matching: find.text('やり直す')),
          findsOneWidget);
      expect(find.text('やり直す'), findsNWidgets(2));
    });

    // 済んだ写真はカテゴリを持ち、解析の対象でない写真（段階2）は持たない
    for (final (state, category) in [('done', 'food'), ('none', null)]) {
      testWidgets('分類が済んだ写真・解析の対象でない写真（$state）には、分類の状態を出さない', (tester) async {
        await _openViewer(tester, _photo(category: category, state: state));

        expect(find.text('分類中...'), findsNothing);
        expect(find.text('分類に失敗しました'), findsNothing);
      });
    }
  });

  group('解析のやり直し', () {
    testWidgets('「やり直す」で開くダイアログに手がかりを書いて頼むと、受け付けられ、ビューアの表示が「分類中...」になる',
        (tester) async {
      final backend = await _openViewer(tester, _photo(category: 'food'));

      await tester.tap(_barRetry);
      await letFramesRun(tester);
      expect(find.text('解析をやり直す'), findsOneWidget);
      expect(find.text('今のコメントは AI の結果で置き換わります'), findsOneWidget);
      expect(find.text('0/500'), findsOneWidget);
      await tester.enterText(find.byType(TextField), 'これはサクラではなくウメ');
      await tester.tap(_dialogRetry);
      await letFramesRun(tester);

      expect(find.byType(AlertDialog), findsNothing);
      expect(find.text('やり直しを受け付けました'), findsOneWidget);
      expect(find.text('分類中...'), findsOneWidget);
      expect(_stored(backend)['hint'], 'これはサクラではなくウメ');
      expect((_stored(backend)['processing'] as Map)['state'], 'pending');
    });

    testWidgets('失敗した写真の下の「やり直す」からも頼める', (tester) async {
      final backend = await _openViewer(tester, _photo(state: 'failed'));

      await tester.tap(find
          .descendant(of: find.byType(Container), matching: find.text('やり直す'))
          .last);
      await letFramesRun(tester);
      await tester.tap(_dialogRetry);
      await letFramesRun(tester);

      expect((_stored(backend)['processing'] as Map)['state'], 'pending');
      expect(find.text('分類中...'), findsOneWidget);
    });

    testWidgets('利用者が書いたコメントがあれば、それを手がかりに事前に入れる', (tester) async {
      await _openViewer(tester,
          _photo(comment: '屋台のラーメン', commentSource: 'user', hint: '前回の手がかり'));

      await tester.tap(_barRetry);
      await letFramesRun(tester);

      expect(find.widgetWithText(TextField, '屋台のラーメン'), findsOneWidget);
    });

    testWidgets('利用者のコメントが無ければ、前回の手がかりを事前に入れる', (tester) async {
      await _openViewer(tester,
          _photo(comment: 'AI のコメント', commentSource: 'ai', hint: '前回の手がかり'));

      await tester.tap(_barRetry);
      await letFramesRun(tester);

      expect(find.widgetWithText(TextField, '前回の手がかり'), findsOneWidget);
    });

    testWidgets('手がかりが空白だけなら、手がかり無しで頼む', (tester) async {
      final backend = await _openViewer(tester, _photo(hint: '前回の手がかり'));

      await tester.tap(_barRetry);
      await letFramesRun(tester);
      await tester.enterText(find.byType(TextField), '   ');
      await tester.tap(_dialogRetry);
      await letFramesRun(tester);

      expect(_stored(backend)['hint'], isNull);
      expect((_stored(backend)['processing'] as Map)['state'], 'pending');
    });

    testWidgets('キャンセルすると、何も頼まない', (tester) async {
      final backend = await _openViewer(tester, _photo(category: 'food'));

      await tester.tap(_barRetry);
      await letFramesRun(tester);
      await tester.tap(find.text('キャンセル'));
      await letFramesRun(tester);

      expect(find.byType(AlertDialog), findsNothing);
      expect((_stored(backend)['processing'] as Map)['state'], 'done');
    });

    testWidgets('受け付けられなかったら、ダイアログに留まって理由を出す', (tester) async {
      final backend = await _openViewer(tester, _photo(category: 'food'));
      backend.failNext(TripRoute.process);

      await tester.tap(_barRetry);
      await letFramesRun(tester);
      await tester.tap(_dialogRetry);
      await letFramesRun(tester);

      expect(find.byType(AlertDialog), findsOneWidget);
      expect(find.text('サービスに一時的に接続できません。しばらく待ってから再試行してください。'), findsOneWidget);
      expect((_stored(backend)['processing'] as Map)['state'], 'done');
    });

    testWidgets('やり直しを頼んでから一覧に戻ると、その写真のサムネイルに分類中の印が付いている', (tester) async {
      final semantics = tester.ensureSemantics();
      await _openViewer(tester, _photo(category: 'food'));
      await tester.tap(_barRetry);
      await letFramesRun(tester);
      await tester.tap(_dialogRetry);
      await letFramesRun(tester);

      await tester.pageBack();
      await letFramesRun(tester);

      expect(find.bySemanticsLabel('$_takenAt、分類中'), findsOneWidget);
      semantics.dispose();
    });
  });

  group('サムネイルの分類の印', () {
    for (final (state, suffix) in [
      ('pending', '、分類中'),
      ('classifying', '、分類中'),
      ('failed', '、分類に失敗しました')
    ]) {
      testWidgets('$state の写真のサムネイルは、読み上げで「$suffix」を足す', (tester) async {
        final semantics = tester.ensureSemantics();
        await _openTripDetail(tester, _photo(state: state));

        expect(find.bySemanticsLabel('$_takenAt$suffix'), findsOneWidget);
        semantics.dispose();
      });
    }

    testWidgets('分類が済んだ写真のサムネイルには、印を付けない', (tester) async {
      final semantics = tester.ensureSemantics();
      await _openTripDetail(tester, _photo(category: 'food'));

      expect(find.bySemanticsLabel(_takenAt), findsOneWidget);
      expect(find.byIcon(Icons.hourglass_empty), findsNothing);
      expect(find.text('!'), findsNothing);
      semantics.dispose();
    });

    testWidgets('分類中の写真のサムネイルには、砂時計の印を付ける', (tester) async {
      await _openTripDetail(tester, _photo(state: 'classifying'));

      expect(find.byIcon(Icons.hourglass_empty), findsOneWidget);
      expect(find.text('!'), findsNothing);
    });

    testWidgets('分類に失敗した写真のサムネイルには、「!」の印を付ける', (tester) async {
      await _openTripDetail(tester, _photo(state: 'failed'));

      expect(find.text('!'), findsOneWidget);
      expect(find.byIcon(Icons.hourglass_empty), findsNothing);
    });
  });
}
