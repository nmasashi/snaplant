import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../helpers/app_test_helpers.dart';
import '../helpers/trip_test_helpers.dart';

// 写真の分類の表示と、解析のやり直し（docs/03_screen_design.md §5.1・§5.4・§5.5。段階3）。
// 入口は旅行詳細の写真のグリッドと、そこから開く写真ビューア

/// 解析の進み具合（processing）。[step] は分類（classify）か識別（identify）。段階2・3の写真は null のこともある
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
        String? step = 'classify',
        String? hint,
        String? comment,
        String? commentSource}) =>
    photoJson(number: 1, tripId: hokkaidoTripId, takenAt: '2026-10-06T10:15:00')
      ..['category'] = category
      ..['processing'] = _processing(state, step: step)
      ..['hint'] = hint
      ..['comment'] = comment
      ..['commentSource'] = commentSource;

const _takenAt = '2026年10月6日 10:15';

/// [number] 枚目の写真。撮影日時は旅行の最初の日（2026年10月5日）の {9 + number}:15（複数の写真を並べるときに、撮影日時で見分ける。
/// 同じ日にして、日の見出しで行が分かれないようにする）
Map<String, Object?> _photoAt(int number, {String? category, String state = 'done', String? step = 'classify'}) =>
    photoJson(number: number, tripId: hokkaidoTripId, takenAt: '2026-10-05T${9 + number}:15:00')
      ..['category'] = category
      ..['processing'] = _processing(state, step: step);

/// [_photoAt] の写真の、サムネイルの読み上げ用ラベル
String _takenAtOf(int number) => '2026年10月5日 ${9 + number}:15';

/// 旅行詳細を開き、[photos]（撮影日時は 2026年10月5日 10:15 から1時間ずつ）の1枚目をタップしてビューアを開く
Future<FakeTripBackend> _openViewerOf(WidgetTester tester, List<({String? category, String state, String? step})> photos) async {
  final backend = FakeTripBackend(
    trips: [hokkaidoTrip(photoCount: photos.length)],
    functionKey: 'test-key',
    photosByTripId: {
      hokkaidoTripId: [
        for (final (i, p) in photos.indexed) _photoAt(i + 1, category: p.category, state: p.state, step: p.step),
      ]
    },
  );
  await openTripsTab(tester, backend);
  await tester.tap(find.text('北海道 2026秋'));
  await letFramesRun(tester);
  await tester.tap(photoThumbnail(_takenAtOf(1)));
  await letFramesRun(tester);
  return backend;
}

/// ビューアで次の写真へ送る
Future<void> _flingToNext(WidgetTester tester) async {
  await tester.fling(find.byType(PageView), const Offset(-300, 0), 1000);
  await letFramesRun(tester);
}

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

/// ビューアの画面の中（横位置が画面の幅の内側）にある [text] の数
int _countOnScreen(WidgetTester tester, String text) {
  final screenWidth = tester.view.physicalSize.width / tester.view.devicePixelRatio;
  return find.text(text).evaluate().where((element) {
    final x = tester.getCenter(find.byElementPredicate((e) => e == element)).dx;
    return x >= 0 && x <= screenWidth;
  }).length;
}

/// やり直しダイアログの「やり直す」
Finder get _dialogRetry =>
    find.descendant(of: find.byType(AlertDialog), matching: find.text('やり直す'));

/// 偽のサーバにある写真（やり直しで書き換わる）
Map<String, Object?> _stored(FakeTripBackend backend) =>
    backend.photosByTripId[hokkaidoTripId]!.single;

void main() {
  testWidgets('写真ビューアは、分類の結果が plant・food・landscape の写真にカテゴリを「植物」「食べ物」「風景」と出し、知らないキー（insect）はキーのまま出し、どれにも当てはまらない（other）写真は「その他」と出し、分類の前の写真にはカテゴリ名を出さず、やり直しで分類を待っている間も前回のカテゴリを出し続ける', (tester) async {
    // 7枚を1つの旅行に置き、ビューアで順に送って見る。PageView は隣のページも組み立てておくので、画面の中にあるものだけを数える。
    // 知らないキー（後の段階で足された種類など）はキーのまま出す。other は手で直せるように「その他」と出す（03 §5.6。02 §5 #53）。
    // 前回の結果は、やり直しの結果が出るまで残る（05 §5.7）
    final cases = [
      (category: 'plant', state: 'done', shown: ['植物'], hidden: <String>[]),
      (category: 'food', state: 'done', shown: ['食べ物'], hidden: <String>[]),
      (category: 'landscape', state: 'done', shown: ['風景'], hidden: <String>[]),
      (category: 'insect', state: 'done', shown: ['insect'], hidden: <String>[]),
      // other も手で直せるように「その他」のボタンで出す（C-1。02 §5 #53）。キーのままは出さない
      (category: 'other', state: 'done', shown: ['その他'], hidden: ['other']),
      (category: null, state: 'none', shown: <String>[], hidden: ['植物', '食べ物', '風景', 'その他']),
      (category: 'food', state: 'pending', shown: ['食べ物', '分類中...'], hidden: <String>[]),
    ];
    await _openViewerOf(tester, [for (final c in cases) (category: c.category, state: c.state, step: 'classify')]);

    for (final (i, c) in cases.indexed) {
      for (final text in c.shown) {
        expect(_isOnScreen(tester, text), isTrue, reason: '${i + 1}枚目（${c.category}・${c.state}）に「$text」が出る');
      }
      for (final text in c.hidden) {
        expect(_isOnScreen(tester, text), isFalse, reason: '${i + 1}枚目（${c.category}・${c.state}）に「$text」は出ない');
      }
      await _flingToNext(tester);
    }
  });

  testWidgets('写真ビューアは、分類を待っている・している写真（pending・classifying。step が無い段階2・3の写真も）に「分類中...」、識別を待っている・している写真（step が identify の pending・identifying）に「識別中...」を出し、上限まで失敗した写真には「分類に失敗しました」「識別に失敗しました」と下の情報の「やり直す」を出し、済んだ写真と解析の対象でない写真には何も出さない', (tester) async {
    // 9枚を1つの旅行に置き、ビューアで順に送って見る。分類の後の識別の待ちは、step が identify の pending（03 §5.1）。
    // 済んだ写真はカテゴリを持ち、解析の対象でない写真（段階2）は持たない。「やり直す」は上のバーにも出るので、失敗した写真では画面の中に2つある
    final cases = [
      (category: null, state: 'pending', step: 'classify', shown: ['分類中...'], retries: 1),
      (category: null, state: 'classifying', step: 'classify', shown: ['分類中...'], retries: 1),
      (category: null, state: 'pending', step: null, shown: ['分類中...'], retries: 1),
      (category: null, state: 'failed', step: 'classify', shown: ['分類に失敗しました'], retries: 2),
      (category: 'plant', state: 'pending', step: 'identify', shown: ['識別中...'], retries: 1),
      (category: 'plant', state: 'identifying', step: 'identify', shown: ['識別中...'], retries: 1),
      (category: 'plant', state: 'failed', step: 'identify', shown: ['識別に失敗しました'], retries: 2),
      (category: 'food', state: 'done', step: 'classify', shown: <String>[], retries: 1),
      (category: null, state: 'none', step: 'classify', shown: <String>[], retries: 1),
    ];
    const statuses = ['分類中...', '識別中...', '分類に失敗しました', '識別に失敗しました'];
    await _openViewerOf(tester, [for (final c in cases) (category: c.category, state: c.state, step: c.step)]);

    for (final (i, c) in cases.indexed) {
      final label = '${i + 1}枚目（${c.category}・${c.state}・${c.step}）';
      for (final text in statuses) {
        expect(_isOnScreen(tester, text), c.shown.contains(text), reason: '$label の「$text」');
      }
      expect(_countOnScreen(tester, 'やり直す'), c.retries, reason: '$label の「やり直す」の数');
      await _flingToNext(tester);
    }
  });

  group('解析のやり直し', () {
    testWidgets('上のバーの「やり直す」で、手がかりの欄とコメントが置き換わる旨を出すダイアログを開き、キャンセルすると何も頼まない', (tester) async {
      final backend = await _openViewer(tester, _photo(category: 'food'));

      await tester.tap(_barRetry);
      await letFramesRun(tester);

      expect(find.text('解析をやり直す'), findsOneWidget);
      expect(find.text('手がかり（任意）'), findsOneWidget);
      expect(find.text('今のコメントは AI の結果で置き換わります'), findsOneWidget);
      expect(find.text('0/500'), findsOneWidget);

      await tester.tap(find.text('キャンセル'));
      await letFramesRun(tester);

      expect(find.byType(AlertDialog), findsNothing);
      expect((_stored(backend)['processing'] as Map)['state'], 'done');
    });

    testWidgets('ダイアログに手がかりを書いて頼むと、受け付けられ、ビューアの表示が「分類中...」になり、一覧に戻るとその写真のサムネイルに分類中の印が付いている', (tester) async {
      final semantics = tester.ensureSemantics();
      final backend = await _openViewer(tester, _photo());

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

      await tapBack(tester);
      await letFramesRun(tester);

      expect(find.bySemanticsLabel('$_takenAt、分類中'), findsOneWidget);
      semantics.dispose();
    });

    testWidgets('やり直す範囲は選ばせず、カテゴリが識別の対象（植物・食べ物・風景）の写真は、カテゴリはそのままで名前（識別）だけをやり直す',
        (tester) async {
      // カテゴリは手で直す（03 §5.6）ので、やり直しで AI にカテゴリを決め直させない（02 §5 #53）
      final backend = await _openViewer(tester, _photo(category: 'food'));

      await tester.tap(_barRetry);
      await letFramesRun(tester);
      expect(find.text('やり直す範囲'), findsNothing);
      expect(find.text('カテゴリから'), findsNothing);
      expect(find.text('名前だけ'), findsNothing);
      await tester.tap(_dialogRetry);
      await letFramesRun(tester);

      expect(find.text('識別中...'), findsOneWidget);
      expect((_stored(backend)['processing'] as Map)['step'], 'identify');
      expect(find.widgetWithText(OutlinedButton, '食べ物'), findsOneWidget);
    });

    // 分類が済んでいない写真は、前のカテゴリが残っていても分類からやり直す（名前をやり直すと、頼んだ分類が捨てられる・失敗した分類が直らない）
    for (final state in ['failed', 'pending']) {
      testWidgets('分類が済んでいない（$state）写真は、前のカテゴリが残っていても分類からやり直す', (tester) async {
        final backend =
            await _openViewer(tester, _photo(category: 'food', state: state));

        await tester.tap(_barRetry);
        await letFramesRun(tester);
        await tester.tap(_dialogRetry);
        await letFramesRun(tester);

        expect((_stored(backend)['processing'] as Map)['step'], 'classify');
        expect(find.text('分類中...'), findsOneWidget);
      });
    }

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

    testWidgets('受け付けを待っている間は、端末の戻る操作でもダイアログを閉じず、受け付けたら閉じて「分類中...」になる',
        (tester) async {
      // 待っている間に閉じると、受け付けられたのに表示が古いまま残り、もう一度頼むことになる
      final backend = await _openViewer(tester, _photo());
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

    testWidgets('受け付けられなかったら、ダイアログに留まって理由を出し、そのままもう一度頼める', (tester) async {
      // 失敗は1回分だけ。留まったダイアログで押し直すと受け付けられる（§5.4 の「留まる」は、その場で頼み直すため）
      final backend = await _openViewer(tester, _photo(category: 'food'));
      backend.failNext(TripRoute.process);

      await tester.tap(_barRetry);
      await letFramesRun(tester);
      await tester.tap(_dialogRetry);
      await letFramesRun(tester);

      expect(find.byType(AlertDialog), findsOneWidget);
      expect(find.text('サービスに一時的に接続できません。しばらく待ってから再試行してください。'), findsOneWidget);
      expect((_stored(backend)['processing'] as Map)['state'], 'done');

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
  });

  testWidgets('サムネイルは、分類を待っている・している・識別している写真に砂時計の印と読み上げの「、分類中」を、上限まで失敗した写真に「!」の印と「、分類に失敗しました」を足し、分類が済んだ写真には印を付けない', (tester) async {
    // 5枚を1つの旅行に置く。識別中（段階4）も、分類が済んでいない写真として印を付ける（§5.5）
    final semantics = tester.ensureSemantics();
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 5)],
      functionKey: 'test-key',
      photosByTripId: {
        hokkaidoTripId: [
          _photoAt(1, state: 'pending'),
          _photoAt(2, state: 'classifying'),
          _photoAt(3, state: 'identifying'),
          _photoAt(4, state: 'failed'),
          _photoAt(5, category: 'food'),
        ]
      },
    );
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);

    expect(find.bySemanticsLabel('${_takenAtOf(1)}、分類中'), findsOneWidget);
    expect(find.bySemanticsLabel('${_takenAtOf(2)}、分類中'), findsOneWidget);
    expect(find.bySemanticsLabel('${_takenAtOf(3)}、分類中'), findsOneWidget);
    expect(find.bySemanticsLabel('${_takenAtOf(4)}、分類に失敗しました'), findsOneWidget);
    expect(find.bySemanticsLabel(_takenAtOf(5)), findsOneWidget);
    expect(find.byIcon(Icons.hourglass_empty), findsNWidgets(3));
    expect(find.text('!'), findsOneWidget);
    semantics.dispose();
  });
}
