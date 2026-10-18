import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../helpers/app_test_helpers.dart';
import '../helpers/trip_test_helpers.dart';

// 写真の分類の表示と、解析のやり直し（docs/travel-album/03_screen_design.md §5.1・§5.4・§5.5。段階3）。
// 入口は旅行詳細の写真のグリッドと、そこから開く写真ビューア

/// 解析の進み具合（processing）
Map<String, Object?> _processing(String state) => {
      'state': state,
      'step': 'classify',
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

/// 下の情報の「やり直す」（分類に失敗したときに出る。上のバーのものを除く）
Finder get _infoRetry => find.byElementPredicate((element) =>
    element.widget is Text &&
    (element.widget as Text).data == 'やり直す' &&
    element.findAncestorWidgetOfExactType<AppBar>() == null);

/// [text] がビューアの画面の中（横位置が画面の幅の内側）にあるか。PageView は隣のページも組み立てておくので、出ている写真のものだけを数える
bool _isOnScreen(WidgetTester tester, String text) {
  final screenWidth =
      tester.view.physicalSize.width / tester.view.devicePixelRatio;
  return find.text(text).evaluate().any((element) {
    final x = tester.getCenter(find.byElementPredicate((e) => e == element)).dx;
    return x >= 0 && x <= screenWidth;
  });
}

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
      // 知らないキー（後の段階で足された種類など）はキーのまま出す
      ('insect', 'insect')
    ]) {
      testWidgets('分類の結果が $category の写真は、カテゴリを「$label」と出す', (tester) async {
        await _openViewer(tester, _photo(category: category));

        expect(find.text(label), findsOneWidget);
      });
    }

    testWidgets('どれにも当てはまらない（other）写真には、カテゴリを出さない', (tester) async {
      // 図鑑に載らない写真の寄せ集めで、出しても見分けの役に立たない（03 §5.1。02 §5 #33）
      await _openViewer(tester, _photo(category: 'other'));

      expect(find.text('その他'), findsNothing);
      expect(find.text('other'), findsNothing);
    });

    testWidgets('分類の前の写真（カテゴリが無い）には、カテゴリを出さない', (tester) async {
      await _openViewer(tester, _photo(category: null, state: 'none'));

      for (final label in ['植物', '食べ物', '風景']) {
        expect(find.text(label), findsNothing);
      }
    });

    testWidgets('やり直しで分類を待っている間も、前回のカテゴリを出し続ける', (tester) async {
      // 前回の結果は、やり直しの結果が出るまで残る（05 §5.7）
      await _openViewer(tester, _photo(category: 'food', state: 'pending'));

      expect(find.text('食べ物'), findsOneWidget);
      expect(find.text('分類中...'), findsOneWidget);
    });
  });

  group('写真ビューアの分類の状態', () {
    for (final state in ['pending', 'classifying']) {
      testWidgets('分類を待っている・している写真（$state）は「分類中...」と出す', (tester) async {
        await _openViewer(tester, _photo(state: state));

        expect(find.text('分類中...'), findsOneWidget);
      });
    }

    testWidgets('上限まで分類に失敗した写真は「分類に失敗しました」と、下の情報にも「やり直す」を出す', (tester) async {
      await _openViewer(tester, _photo(state: 'failed'));

      expect(find.text('分類に失敗しました'), findsOneWidget);
      expect(_infoRetry, findsOneWidget);
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
    testWidgets('上のバーの「やり直す」で、手がかりの欄とコメントが置き換わる旨を出すダイアログを開く', (tester) async {
      await _openViewer(tester, _photo(category: 'food'));

      await tester.tap(_barRetry);
      await letFramesRun(tester);

      expect(find.text('解析をやり直す'), findsOneWidget);
      expect(find.text('手がかり（任意）'), findsOneWidget);
      expect(find.text('今のコメントは AI の結果で置き換わります'), findsOneWidget);
      expect(find.text('0/500'), findsOneWidget);
    });

    testWidgets('ダイアログに手がかりを書いて頼むと、受け付けられ、ビューアの表示が「分類中...」になる', (tester) async {
      final backend = await _openViewer(tester, _photo(category: 'food'));

      await tester.tap(_barRetry);
      await letFramesRun(tester);
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

      await tester.tap(_infoRetry);
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

    testWidgets('受け付けを待っている間は、端末の戻る操作でもダイアログを閉じず、受け付けたら閉じて「分類中...」になる',
        (tester) async {
      // 待っている間に閉じると、受け付けられたのに表示が古いまま残り、もう一度頼むことになる
      final backend = await _openViewer(tester, _photo(category: 'food'));
      final release = Completer<void>();
      // 途中の確かめで落ちても、止めた応答を残さない（後のテストに保留中の要求を持ち越さない）
      addTearDown(() {
        if (!release.isCompleted) release.complete();
      });
      backend.holds[TripRoute.process] = release.future;

      await tester.tap(_barRetry);
      await letFramesRun(tester);
      await tester.tap(_dialogRetry);
      await letFramesRun(tester);
      await tester.binding.handlePopRoute();
      await letFramesRun(tester);

      expect(find.byType(AlertDialog), findsOneWidget);
      release.complete();
      await letFramesRun(tester);
      expect(find.byType(AlertDialog), findsNothing);
      expect(find.text('分類中...'), findsOneWidget);
    });

    testWidgets('最後の写真を消して続きのページを待っている間に「やり直す」を押しても、何も起きない', (tester) async {
      // 読み込み済みの写真が無い間は、やり直す写真が無い（1ページ目が1枚、続きがある旅行）
      final backend = FakeTripBackend(
        trips: [hokkaidoTrip(photoCount: 2)],
        functionKey: 'test-key',
        pageSize: 1,
        photosByTripId: {
          hokkaidoTripId: [
            _photo(category: 'food'),
            photoJson(
                number: 2,
                tripId: hokkaidoTripId,
                takenAt: '2026-10-07T10:15:00'),
          ]
        },
      );
      // 一覧は1ページ目が届くとすぐ続きを読むので、1ページ目は返し、続き（2ページ目）の応答だけを止める
      final firstPage = Completer<void>();
      final release = Completer<void>();
      // 途中の確かめで落ちても、止めた応答を残さない（後のテストに保留中の要求を持ち越さない）
      addTearDown(() {
        if (!firstPage.isCompleted) firstPage.complete();
        if (!release.isCompleted) release.complete();
      });
      backend.holds[TripRoute.photos] = firstPage.future;
      await openTripsTab(tester, backend);
      await tester.tap(find.text('北海道 2026秋'));
      await letFramesRun(tester);
      backend.holds[TripRoute.photos] = release.future;
      firstPage.complete();
      await letFramesRun(tester);
      await tester.tap(photoThumbnail(_takenAt));
      await letFramesRun(tester);
      await tester.tap(
          find.descendant(of: find.byType(AppBar), matching: find.text('削除')));
      await letFramesRun(tester);
      await tester.tap(find.descendant(
          of: find.byType(AlertDialog), matching: find.text('削除')));
      await letFramesRun(tester);

      await tester.tap(_barRetry);
      await letFramesRun(tester);

      expect(tester.takeException(), isNull);
      expect(find.byType(AlertDialog), findsNothing);
      // どの写真のやり直しも頼んでいない
      expect(
          backend.photosByTripId[hokkaidoTripId]!
              .map((photo) => (photo['processing'] as Map)['state']),
          isNot(contains('pending')));
      // 続きのページが届いたら、次の写真が出る
      release.complete();
      await letFramesRun(tester);
      expect(_isOnScreen(tester, '2026年10月7日 10:15'), isTrue);
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

    testWidgets('受け付けられなかった後、ダイアログからそのままもう一度頼める', (tester) async {
      // 失敗は1回分だけ。留まったダイアログで押し直すと受け付けられる（§5.4 の「留まる」は、その場で頼み直すため）
      final backend = await _openViewer(tester, _photo(category: 'food'));
      backend.failNext(TripRoute.process);
      await tester.tap(_barRetry);
      await letFramesRun(tester);
      await tester.tap(_dialogRetry);
      await letFramesRun(tester);

      await tester.tap(_dialogRetry);
      await letFramesRun(tester);

      expect(find.byType(AlertDialog), findsNothing);
      expect(find.text('やり直しを受け付けました'), findsOneWidget);
      expect((_stored(backend)['processing'] as Map)['state'], 'pending');
    });

    testWidgets('2枚目を見ているときに頼むと、2枚目だけがやり直しになり、1枚目に戻っても1枚目の表示は変わらない',
        (tester) async {
      // 宛先の写真の取り違えと、一覧の別の写真を受け付けた写真で置き換える誤りを見分けるため、写真を2枚にする
      final backend = FakeTripBackend(
        trips: [hokkaidoTrip(photoCount: 2)],
        functionKey: 'test-key',
        photosByTripId: {
          hokkaidoTripId: [
            _photo(category: 'food'),
            photoJson(
                number: 2,
                tripId: hokkaidoTripId,
                takenAt: '2026-10-07T10:15:00')
              ..['category'] = 'landscape'
              ..['processing'] = _processing('done'),
          ]
        },
      );
      await openTripsTab(tester, backend);
      await tester.tap(find.text('北海道 2026秋'));
      await letFramesRun(tester);
      await tester.tap(photoThumbnail(_takenAt));
      await letFramesRun(tester);
      await tester.fling(find.byType(PageView), const Offset(-300, 0), 1000);
      await letFramesRun(tester);

      await tester.tap(_barRetry);
      await letFramesRun(tester);
      await tester.tap(_dialogRetry);
      await letFramesRun(tester);

      final states = [
        for (final photo in backend.photosByTripId[hokkaidoTripId]!)
          (photo['processing'] as Map)['state']
      ];
      expect(states, ['done', 'pending']);
      await tester.fling(find.byType(PageView), const Offset(300, 0), 1000);
      await letFramesRun(tester);
      expect(_isOnScreen(tester, '食べ物'), isTrue);
      expect(_isOnScreen(tester, '分類中...'), isFalse);
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
      // 識別中（段階4）も、分類が済んでいない写真として印を付ける（§5.5）
      ('identifying', '、分類中'),
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
