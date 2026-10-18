import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:snaplant_mobile/screens/photo_viewer_screen.dart';

import '../helpers/app_test_helpers.dart';
import '../helpers/trip_test_helpers.dart';

// 図鑑の項目詳細（docs/travel-album/03_screen_design.md §6.2。段階4の 4-3b）。
// 入口は図鑑のタブ（下のタブの「図鑑（新）」）の項目の行。項目の詳細は偽のサーバ（FakeTripBackend）が写真の識別から作る

/// 撮影日時（10月6日の [time]）のサムネイルの読み上げのラベル
String _label(String time) => '2026年10月6日 $time';

/// 植物の項目「ソメイヨシノ」の写真（10月6日の [time] に撮った写真）
Map<String, Object?> _sakura(int number, String time,
        {String? tripId = hokkaidoTripId,
        num confidence = 80,
        String? description = '日本で最も広く植えられているサクラ',
        String? characteristics = '淡い桃色の花を葉より先に咲かせる',
        Map<String, Object?> attributes = const {
          'scientificName': 'Prunus × yedoensis',
          'familyName': 'バラ科',
        }}) =>
    identifiedPhotoJson(
      number: number,
      kind: 'plant',
      name: 'ソメイヨシノ',
      tripId: tripId,
      takenAt: '2026-10-06T$time:00',
      confidence: confidence,
      description: description,
      characteristics: characteristics,
      attributes: attributes,
    );

/// 図鑑の一覧に「ソメイヨシノ」の行があり、その写真が北海道と京都の旅行にまたがる偽のサーバ
FakeTripBackend _backend({
  List<Map<String, Object?>>? hokkaidoPhotos,
  List<Map<String, Object?>>? kyotoPhotos,
  int pageSize = 100,
}) =>
    FakeTripBackend(
      functionKey: 'test-key',
      pageSize: pageSize,
      catalogEntriesByKind: {
        'plant': [catalogEntryJson('plant', 'ソメイヨシノ', photoCount: 3)],
      },
      photosByTripId: {
        hokkaidoTripId: hokkaidoPhotos ??
            [
              _sakura(1, '10:00'),
              _sakura(2, '11:00', confidence: 92),
            ],
        kyotoTripId: kyotoPhotos ?? [_sakura(3, '12:00', tripId: kyotoTripId)],
      },
    );

/// 図鑑のタブを開き、[name] の項目の行をタップする
Future<void> _openEntry(WidgetTester tester, FakeTripBackend backend,
    {String name = 'ソメイヨシノ'}) async {
  await openCatalogTab(tester, backend);
  await tester.tap(find.text(name));
  await letFramesRun(tester);
}

void main() {
  testWidgets('図鑑の一覧の項目をタップすると項目詳細を開き、名前・信頼度・枚数・説明・特徴・種類の欄を出す', (tester) async {
    await _openEntry(tester, _backend());

    expect(find.widgetWithText(AppBar, 'ソメイヨシノ'), findsOneWidget);
    // 見出しは信頼度の最も高い写真（92）の識別から。枚数はサーバが数えた総数
    expect(find.text('92%'), findsOneWidget);
    expect(find.text('3枚'), findsOneWidget);
    expect(find.text('日本で最も広く植えられているサクラ'), findsOneWidget);
    expect(find.text('淡い桃色の花を葉より先に咲かせる'), findsOneWidget);
    expect(find.text('Prunus × yedoensis'), findsOneWidget);
    expect(find.text('バラ科'), findsOneWidget);
    // 欄は種類の一覧の fields の順（学名 → 科名）
    expect(tester.getTopLeft(find.text('学名')).dy,
        lessThan(tester.getTopLeft(find.text('科名')).dy));
  });

  testWidgets('説明・特徴・欄の値が無ければ「—」を出し、配列の欄は「、」でつなぐ', (tester) async {
    final backend = FakeTripBackend(
      functionKey: 'test-key',
      catalogEntriesByKind: {
        'food': [catalogEntryJson('food', '味噌ラーメン')],
      },
      photosByTripId: {
        hokkaidoTripId: [
          identifiedPhotoJson(
            number: 1,
            kind: 'food',
            name: '味噌ラーメン',
            tripId: hokkaidoTripId,
            description: null,
            characteristics: '',
            attributes: {
              'mainIngredients': ['中華麺', '味噌', 'もやし']
            },
          ),
        ],
      },
    );
    await openCatalogTab(tester, backend);
    await tester.tap(find.widgetWithText(Tab, '食べ物'));
    await letFramesRun(tester);
    await tester.tap(find.text('味噌ラーメン'));
    await letFramesRun(tester);

    expect(find.text('中華麺、味噌、もやし'), findsOneWidget);
    // 説明（null）・特徴（空）・料理のジャンル（キーが無い）
    expect(find.text('—'), findsNWidgets(3));
  });

  testWidgets('配列の欄が空なら「—」を出す', (tester) async {
    final backend = FakeTripBackend(
      functionKey: 'test-key',
      catalogEntriesByKind: {
        'food': [catalogEntryJson('food', '塩ラーメン')],
      },
      photosByTripId: {
        hokkaidoTripId: [
          identifiedPhotoJson(
            number: 1,
            kind: 'food',
            name: '塩ラーメン',
            tripId: hokkaidoTripId,
            description: '塩味のスープのラーメン',
            characteristics: '透き通ったスープ',
            attributes: {'genre': 'ラーメン', 'mainIngredients': <String>[]},
          ),
        ],
      },
    );
    await openCatalogTab(tester, backend);
    await tester.tap(find.widgetWithText(Tab, '食べ物'));
    await letFramesRun(tester);
    await tester.tap(find.text('塩ラーメン'));
    await letFramesRun(tester);

    expect(find.text('ラーメン'), findsOneWidget);
    // 主な食材（空の配列）だけ
    expect(find.text('—'), findsOneWidget);
  });

  testWidgets('その項目の写真を、旅行に属さない写真も含めて旅行をまたいで、サーバが返す順に並べる', (tester) async {
    // その項目の写真に絞るのはサーバ（05 §5.14）。偽のサーバも同じく名前・種類・matchesKind で絞るので、
    // 13:00〜15:00 の写真が並ばないのは、その前提（画面が別の宛先を読んでいない）の確かめ
    final semantics = tester.ensureSemantics();
    final backend = _backend(hokkaidoPhotos: [
      _sakura(1, '10:00'),
      identifiedPhotoJson(
          number: 4,
          kind: 'plant',
          name: 'ヤマザクラ',
          tripId: hokkaidoTripId,
          takenAt: '2026-10-06T13:00:00'),
      identifiedPhotoJson(
          number: 5,
          kind: 'food',
          name: 'ソメイヨシノ',
          tripId: hokkaidoTripId,
          takenAt: '2026-10-06T14:00:00'),
      identifiedPhotoJson(
          number: 6,
          kind: 'plant',
          name: 'ソメイヨシノ',
          tripId: hokkaidoTripId,
          takenAt: '2026-10-06T15:00:00',
          matchesKind: false),
    ]);
    backend.photosByTripId['none'] = [_sakura(7, '16:00', tripId: null)];
    await _openEntry(tester, backend);

    for (final time in ['10:00', '12:00', '16:00']) {
      expect(photoThumbnail(_label(time)), findsOneWidget, reason: time);
    }
    for (final time in ['13:00', '14:00', '15:00']) {
      expect(photoThumbnail(_label(time)), findsNothing, reason: time);
    }
    // 3列のグリッドの1行目に、サーバが返す順（sortAt の順）に左から並ぶ
    final first = tester.getTopLeft(photoThumbnail(_label('10:00')));
    final second = tester.getTopLeft(photoThumbnail(_label('12:00')));
    final third = tester.getTopLeft(photoThumbnail(_label('16:00')));
    expect(second.dy, first.dy);
    expect(third.dy, first.dy);
    expect(first.dx, lessThan(second.dx));
    expect(second.dx, lessThan(third.dx));
    semantics.dispose();
  });

  testWidgets('名前に記号や空白があっても、その名前のまま項目を開く', (tester) async {
    const name = 'A&B #1 + ?';
    final backend = FakeTripBackend(
      functionKey: 'test-key',
      catalogEntriesByKind: {
        'plant': [catalogEntryJson('plant', name)],
      },
      photosByTripId: {
        hokkaidoTripId: [
          identifiedPhotoJson(
              number: 1,
              kind: 'plant',
              name: name,
              tripId: hokkaidoTripId,
              description: '記号のある名前の説明'),
        ],
      },
    );
    await _openEntry(tester, backend, name: name);

    // 名前を取り違えて送ると、サーバは別の項目（写真なし）を返し、この説明は出ない
    expect(find.text('記号のある名前の説明'), findsOneWidget);
  });

  testWidgets('写真は続きのページで読み、見出しは続きのページの応答で書き換えない', (tester) async {
    // 見出しは1ページ目の entry で出す（読む間に見出しが入れ替わらないように。03 §6.2）
    final semantics = tester.ensureSemantics();
    final backend = _backend(pageSize: 2);
    final firstReply = backend.holdNextReply(TripRoute.catalogEntry);
    await openCatalogTab(tester, backend);
    await tester.tap(find.text('ソメイヨシノ'));
    await tester.pump();
    // 1ページ目を返した後に、信頼度のより高い写真が増えた（続きのページの entry は変わる）
    backend.photosByTripId[kyotoTripId]!.add(_sakura(8, '13:00',
        tripId: kyotoTripId, confidence: 99, description: '後から変わった説明'));

    firstReply.complete();
    await letFramesRun(tester);

    // 2ページ目にしか無い写真（12:00）が出る
    expect(photoThumbnail(_label('12:00')), findsOneWidget);
    expect(find.text('日本で最も広く植えられているサクラ'), findsOneWidget);
    expect(find.text('後から変わった説明'), findsNothing);
    expect(find.text('3枚'), findsOneWidget);
    semantics.dispose();
  });

  testWidgets('続きのページの応答で項目が無くなっていたら、続きは無いものとして読み終え、出している写真と見出しはそのまま',
      (tester) async {
    final semantics = tester.ensureSemantics();
    final backend = _backend(pageSize: 2);
    final firstReply = backend.holdNextReply(TripRoute.catalogEntry);
    await openCatalogTab(tester, backend);
    await tester.tap(find.text('ソメイヨシノ'));
    await tester.pump();
    // 1ページ目を返した後に、その名前の写真が全部消えた
    backend.photosByTripId[hokkaidoTripId]!.clear();
    backend.photosByTripId[kyotoTripId]!.clear();

    firstReply.complete();
    await letFramesRun(tester);
    await letFramesRun(tester);

    // 前提: 続きのページを読みに行った（他の確かめは、続きを読まなくても成り立つ）。読み終えたので3回目は読まない
    expect(backend.catalogEntryQueriesReceived, hasLength(2));
    expect(photoThumbnail(_label('10:00')), findsOneWidget);
    expect(find.text('3枚'), findsOneWidget);
    expect(find.text('読み込み中...'), findsNothing);
    expect(find.text('この項目には写真がありません'), findsNothing);
    semantics.dispose();
  });

  testWidgets('読み込んでいる間は「項目を読み込み中...」を出す', (tester) async {
    final backend = _backend();
    final release = Completer<void>();
    await openCatalogTab(tester, backend);
    backend.holds[TripRoute.catalogEntry] = release.future;
    await tester.tap(find.text('ソメイヨシノ'));
    await letFramesRun(tester);

    expect(find.text('項目を読み込み中...'), findsOneWidget);

    release.complete();
    await letFramesRun(tester);
    expect(find.text('3枚'), findsOneWidget);
  });

  testWidgets('その名前の写真が無ければ「この項目には写真がありません」と「戻る」を出し、戻ると図鑑の一覧を読み直す',
      (tester) async {
    // やり直しで名前が変わった直後など（一覧を読んだ後に写真が無くなった）
    final backend = _backend(hokkaidoPhotos: [], kyotoPhotos: []);
    await _openEntry(tester, backend);

    expect(find.text('この項目には写真がありません'), findsOneWidget);
    expect(find.text('写真が削除されたか、解析のやり直しで名前が変わりました'), findsOneWidget);
    backend.catalogEntriesByKind['plant']!.clear();

    await tester.tap(find.text('戻る'));
    await letFramesRun(tester);

    expect(find.text('植物の項目はまだありません'), findsOneWidget);
    expect(backend.catalogOffsetsReceived, [0, 0]);
  });

  testWidgets('その名前の写真が無いとき、端末の戻る操作で戻っても図鑑の一覧を読み直す', (tester) async {
    final backend = _backend(hokkaidoPhotos: [], kyotoPhotos: []);
    await _openEntry(tester, backend);
    expect(find.text('この項目には写真がありません'), findsOneWidget);
    backend.catalogEntriesByKind['plant']!.clear();

    await tester.binding.handlePopRoute();
    await letFramesRun(tester);

    expect(find.text('植物の項目はまだありません'), findsOneWidget);
    expect(backend.catalogOffsetsReceived, [0, 0]);
  });

  testWidgets('取得に失敗したら、エラーと「再試行」を出し、再試行で読み直す', (tester) async {
    final backend = _backend();
    backend.failNext(TripRoute.catalogEntry);
    await _openEntry(tester, backend);

    expect(find.text('エラーが発生しました'), findsOneWidget);
    // 503 はアプリが言い換える（ApiException.userMessage）
    expect(find.text('サービスに一時的に接続できません。しばらく待ってから再試行してください。'), findsOneWidget);

    await tester.tap(find.text('再試行'));
    await letFramesRun(tester);

    expect(find.text('3枚'), findsOneWidget);
  });

  testWidgets('写真をタップすると写真ビューアを開き、戻ると見出しと写真を読み直す', (tester) async {
    final semantics = tester.ensureSemantics();
    final backend = _backend();
    await _openEntry(tester, backend);

    await tester.tap(photoThumbnail(_label('10:00')));
    await letFramesRun(tester);
    expect(find.byType(PhotoViewerScreen), findsOneWidget);
    // ビューアを開いている間に、その名前の写真が増えた
    backend.photosByTripId[kyotoTripId]!
        .add(_sakura(9, '13:00', tripId: kyotoTripId));

    await tester.pageBack();
    await letFramesRun(tester);

    expect(photoThumbnail(_label('13:00')), findsOneWidget);
    expect(find.text('4枚'), findsOneWidget);
    semantics.dispose();
  });

  testWidgets('説明が長くても見出しが画面からあふれず、写真を出す（小さな端末）', (tester) async {
    // 説明は AI が返す文で、長さは決まっていない。見出しが画面を占めると写真のグリッドの高さが無くなる
    final semantics = tester.ensureSemantics();
    final backend = _backend(hokkaidoPhotos: [
      _sakura(1, '10:00', confidence: 95, description: 'とても長い説明。' * 60),
    ], kyotoPhotos: []);
    await openCatalogTab(tester, backend);
    // アプリを開くときに画面の大きさを決め直すので、その後で小さな端末（360×640）にする
    tester.view.physicalSize = const Size(360 * 3, 640 * 3);
    tester.view.devicePixelRatio = 3;
    await tester.tap(find.text('ソメイヨシノ'));
    await letFramesRun(tester);

    // 写真の1行（3列のマス）が収まる高さがある
    expect(tester.getSize(find.byType(GridView)).height, greaterThan(360 / 3));
    // 写真のマスが画面の中に収まっている
    expect(tester.getRect(photoThumbnail(_label('10:00'))).bottom,
        lessThanOrEqualTo(640));
    semantics.dispose();
  });

  testWidgets('古い読み直しの応答が後から届いても、見出しを古い内容に戻さない', (tester) async {
    // 下に引っ張った読み直しの間に写真ビューアから戻ると、読み直しが重なる。後から届いた古い応答で見出しを上書きしない
    final semantics = tester.ensureSemantics();
    final backend = _backend();
    await _openEntry(tester, backend);
    final staleReply = backend.holdNextReply(TripRoute.catalogEntry);
    final before = backend.catalogEntryQueriesReceived.length;
    await tester.drag(find.byType(GridView), const Offset(0, 300));
    await letFramesRun(tester);
    expect(backend.catalogEntryQueriesReceived, hasLength(before + 1));
    // 古い読み直しの要求が届いた後に、信頼度のより高い写真が増えた
    backend.photosByTripId[kyotoTripId]!.add(_sakura(9, '13:00',
        tripId: kyotoTripId, confidence: 99, description: '新しい説明'));
    await tester.tap(photoThumbnail(_label('10:00')));
    await letFramesRun(tester);
    await tester.pageBack();
    await letFramesRun(tester);
    expect(find.text('新しい説明'), findsOneWidget);

    staleReply.complete();
    await letFramesRun(tester);

    expect(find.text('新しい説明'), findsOneWidget);
    expect(find.text('4枚'), findsOneWidget);
    semantics.dispose();
  });

  testWidgets('取得の失敗の表示で、下に引っ張った読み直しと「再試行」が重なっても、出した写真の見出しを出す', (tester) async {
    // 引っ張った読み直しが成功し、後から始めた「再試行」が失敗したとき。写真は先に届いた読み直しの結果で出るので、見出しも同じ応答から出す
    final semantics = tester.ensureSemantics();
    final backend = _backend();
    backend.failNext(TripRoute.catalogEntry);
    await _openEntry(tester, backend);
    expect(find.text('エラーが発生しました'), findsOneWidget);
    final pullReply = backend.holdNextReply(TripRoute.catalogEntry);
    final before = backend.catalogEntryQueriesReceived.length;
    await tester.drag(find.text('エラーが発生しました'), const Offset(0, 300));
    await letFramesRun(tester);
    expect(backend.catalogEntryQueriesReceived, hasLength(before + 1));
    backend.failNext(TripRoute.catalogEntry);
    await tester.tap(find.text('再試行'));
    await letFramesRun(tester);

    pullReply.complete();
    await letFramesRun(tester);

    expect(photoThumbnail(_label('10:00')), findsOneWidget);
    expect(find.text('3枚'), findsOneWidget);
    semantics.dispose();
  });

  group('下に引っ張ったとき', () {
    testWidgets('見出しと写真を1ページ目から読み直す', (tester) async {
      final semantics = tester.ensureSemantics();
      final backend = _backend();
      await _openEntry(tester, backend);
      backend.photosByTripId[kyotoTripId]!.add(_sakura(9, '13:00',
          tripId: kyotoTripId, confidence: 99, description: '読み直した説明'));

      await tester.drag(find.byType(GridView), const Offset(0, 300));
      await letFramesRun(tester);

      expect(find.text('読み直した説明'), findsOneWidget);
      expect(find.text('4枚'), findsOneWidget);
      expect(photoThumbnail(_label('13:00')), findsOneWidget);
      semantics.dispose();
    });

    testWidgets('読み直したときに写真が無くなっていたら、見出しを消して「この項目には写真がありません」と「戻る」を出す',
        (tester) async {
      // 写真が0枚のグリッドも同じ見出しの文言を出すので、項目が無いときの説明と「戻る」、見出しが消えたことで見分ける
      final backend = _backend();
      await _openEntry(tester, backend);
      backend.photosByTripId[hokkaidoTripId]!.clear();
      backend.photosByTripId[kyotoTripId]!.clear();

      await tester.drag(find.byType(GridView), const Offset(0, 300));
      await letFramesRun(tester);

      expect(find.text('この項目には写真がありません'), findsOneWidget);
      expect(find.text('写真が削除されたか、解析のやり直しで名前が変わりました'), findsOneWidget);
      expect(find.text('戻る'), findsOneWidget);
      expect(find.text('3枚'), findsNothing);
    });
  });

  testWidgets('長押しで写真を選ぶと、操作は「削除」だけ（旅行へ入れる操作は無い）', (tester) async {
    final semantics = tester.ensureSemantics();
    await _openEntry(tester, _backend());

    await tester.longPress(photoThumbnail(_label('10:00')));
    await letFramesRun(tester);

    expect(find.text('1枚を選択中'), findsOneWidget);
    expect(find.text('削除'), findsOneWidget);
    expect(find.text('旅行に入れる'), findsNothing);
    semantics.dispose();
  });

  testWidgets('複数選択で写真を削除すると、見出しと写真を1ページ目から読み直す', (tester) async {
    // 信頼度の最も高い写真（92）を消すので、見出しは残った写真の識別（80）に変わる
    final semantics = tester.ensureSemantics();
    final backend = _backend();
    await _openEntry(tester, backend);
    await tester.longPress(photoThumbnail(_label('11:00')));
    await letFramesRun(tester);
    await tester.tap(find.text('削除'));
    await letFramesRun(tester);

    await tapInDialog(tester, '削除');

    expect(photoThumbnail(_label('11:00')), findsNothing);
    expect(find.text('2枚'), findsOneWidget);
    expect(find.text('80%'), findsOneWidget);
    semantics.dispose();
  });
}
