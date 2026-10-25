import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../helpers/app_test_helpers.dart';
import '../helpers/trip_test_helpers.dart';

// 完成したタイムライン（docs/03_screen_design.md §8.3・§8.6。段階5の 5-4a）。
// 入口は旅行詳細の「タイムライン」。作成日時は端末の時刻（日本時間）で出すので、日本時間で動くことを前提にする

/// 場面の写真（番号から id を作る。地名と名前は場面の欄で持つので、写真には持たせない）
Map<String, Object?> _photo(int number, String? takenAt,
        {String category = 'landscape'}) =>
    timelinePhotoJson(number, takenAt, category: category);

/// 完成版の場面（05 §5.15 の `current.days[].scenes[]`）
Map<String, Object?> _scene(
  List<Map<String, Object?>> photos, {
  required String? label,
  required String? note,
  List<String> placeNames = const [],
  List<String> names = const [],
  String startedBy = 'ai',
}) =>
    {
      ...timelineSceneJson(photos, startedBy: startedBy),
      'placeNames': placeNames,
      'names': names,
      'label': label,
      'labelSource': label == null ? null : 'ai',
      'note': note,
      'noteSource': note == null ? null : 'ai',
    };

/// 完成版（1日目は利用者がタイトルを直した日、3日目は AI の文だけの日。2日目は写真が無い）
Map<String, Object?> _current() => {
      'writtenAt': '2026-10-25T09:10:00.000Z',
      'days': [
        {
          'date': '2026-10-05',
          'dayNumber': 1,
          'title': '小樽の運河と寿司',
          'titleSource': 'user',
          'summary': '朝は市場で海鮮丼、昼は運河を歩いた。',
          'summarySource': 'ai',
          'scenes': [
            _scene(
                [
                  _photo(1, '2026-10-05T07:50:00', category: 'food'),
                  _photo(2, '2026-10-05T07:58:00', category: 'food'),
                ],
                label: '朝ごはん',
                note: '港の市場で海鮮丼。',
                placeNames: ['北海道千歳市'],
                names: ['海鮮丼'],
                startedBy: 'day'),
            _scene(
                [
                  for (var n = 3; n <= 8; n++)
                    _photo(n, '2026-10-05T1${n - 3}:10:00'),
                ],
                label: '小樽運河さんぽ',
                note: null,
                placeNames: ['北海道小樽市']),
          ],
        },
        {
          'date': '2026-10-07',
          'dayNumber': 3,
          'title': '旭川',
          'titleSource': 'ai',
          'summary': 'ラーメンを食べた。',
          'summarySource': 'ai',
          'scenes': [
            _scene([_photo(9, '2026-10-07T12:00:00', category: 'food')],
                label: '昼ごはん',
                note: '醤油ラーメン。',
                names: ['醤油ラーメン'],
                startedBy: 'day'),
          ],
        },
      ],
      'undatedPhotos': [_photo(10, null, category: 'other')],
    };

/// タイムライン（完成版と、あれば下書き）
Map<String, Object?> _timelineOf({Map<String, Object?>? draft}) => {
      'current': _current(),
      'draft': draft,
      'changes': {'added': 0, 'removed': 0},
      'droppedEdits': <Object?>[],
    };

/// 旅行詳細の「タイムライン」を開く
Future<FakeTripBackend> _openTimeline(WidgetTester tester,
    {Map<String, Object?>? draft,
    int pendingPhotoCount = 0,
    Map<String, Object?>? current,
    Map<String, Object?>? changes,
    List<Object?>? droppedEdits}) async {
  final backend = FakeTripBackend(
    trips: [hokkaidoTrip(photoCount: 10)],
    functionKey: 'test-key',
    // 写真ビューアで開く写真（07:58）。07:50 の写真は旅行に無い（作った後に消えた）
    photosByTripId: {
      hokkaidoTripId: [
        photoJson(
            number: 2, tripId: hokkaidoTripId, takenAt: '2026-10-05T07:58:00'),
        // 日時なしの写真
        photoJson(number: 10, tripId: hokkaidoTripId),
      ],
    },
  );
  backend.timelinesByTripId[hokkaidoTripId] = {
    ..._timelineOf(draft: draft),
    if (current != null) 'current': current,
    if (changes != null) 'changes': changes,
    if (droppedEdits != null) 'droppedEdits': droppedEdits,
  };
  backend.pendingPhotoCountByTripId[hokkaidoTripId] = pendingPhotoCount;
  await openTripsTab(tester, backend);
  await tester.tap(find.text('北海道 2026秋'));
  await letFramesRun(tester);
  await tester.tap(find.text('タイムライン'));
  await letFramesRun(tester);
  return backend;
}

/// 文言が [label] のボタン（押せるかを見る）
ButtonStyleButton _button(WidgetTester tester, String label) =>
    tester.widget<ButtonStyleButton>(find.ancestor(
        of: find.text(label), matching: find.bySubtype<ButtonStyleButton>()));

/// タイムラインのリストを [finder] が見えるところまで送る
Future<void> _scrollTo(WidgetTester tester, Finder finder) async {
  await tester.scrollUntilVisible(finder, 200,
      scrollable: find.byType(Scrollable).first);
  await tester.pump();
}

void main() {
  group('完成したタイムラインの表示', () {
    testWidgets(
        '作成日時と「区切りを直す」「作り直す」を上に出し、日ごとに見出し・タイトル・まとめ・印と場面のカードを並べ、最後に日時なしを出す',
        (tester) async {
      // 作成日時は端末の時刻で出す。日本時間でないと期待値が合わない（CI は TZ=Asia/Tokyo）
      expect(DateTime(2026, 10, 25).timeZoneOffset, const Duration(hours: 9));
      final semantics = tester.ensureSemantics();
      await _openTimeline(tester);

      expect(find.text('タイムラインができました'), findsNothing);
      expect(find.text('10月25日 18:10 に作成'), findsOneWidget);
      expect(find.text('区切りを直す'), findsOneWidget);
      expect(find.text('作り直す'), findsOneWidget);

      expect(find.text('1日目'), findsOneWidget);
      expect(find.text('10月5日（月）'), findsOneWidget);
      expect(find.text('小樽の運河と寿司'), findsOneWidget);
      expect(find.text('朝は市場で海鮮丼、昼は運河を歩いた。'), findsOneWidget);
      // タイトルを利用者が直した日
      expect(find.text('編集済み'), findsOneWidget);

      expect(find.text('朝ごはん'), findsOneWidget);
      expect(find.text('7:50〜7:58 · 北海道千歳市 · 海鮮丼'), findsOneWidget);
      expect(find.text('港の市場で海鮮丼。'), findsOneWidget);
      expect(photoThumbnail('2026年10月5日 07:58'), findsOneWidget);

      await _scrollTo(tester, find.text('小樽運河さんぽ'));
      expect(find.text('10:10〜15:10 · 北海道小樽市'), findsOneWidget);
      // 6枚のうち4枚を出し、残りを「+2枚」
      expect(photoThumbnail('2026年10月5日 13:10'), findsOneWidget);
      expect(photoThumbnail('2026年10月5日 14:10'), findsNothing);
      expect(find.text('+2枚'), findsOneWidget);

      await _scrollTo(tester, find.text('昼ごはん'));
      expect(find.text('3日目'), findsOneWidget);
      expect(find.text('10月7日（水）'), findsOneWidget);
      // タイトルもまとめも AI の文の日
      expect(find.text('AI のまとめ'), findsOneWidget);
      expect(find.text('12:00 · 醤油ラーメン'), findsOneWidget);

      await _scrollTo(tester, find.text('日時なし'));
      expect(photoThumbnail('撮影日時なし'), findsOneWidget);
      semantics.dispose();
    });

    testWidgets('解析中の写真がある間は「作り直す」を押せず、残りの枚数を添える', (tester) async {
      await _openTimeline(tester, pendingPhotoCount: 2);

      expect(_button(tester, '作り直す').onPressed, isNull);
      expect(find.text('解析中の写真があと 2 枚あります'), findsOneWidget);
      expect(_button(tester, '区切りを直す').onPressed, isNotNull);
    });
  });

  group('完成版の上の下書きの案内', () {
    /// 完成版の上の下書き（作り直し・区切りの直し）
    Map<String, Object?> draftOf(String reason, String phase,
            {String? step, String state = 'pending'}) =>
        {
          'id': '0b8e1c5a-0000-4000-8000-000000000099',
          'reason': reason,
          'phase': phase,
          'job': step == null
              ? null
              : {
                  'step': step,
                  'state': state,
                  'lastError': state == 'failed' ? 'ai' : null
                },
          'startedAt': '2026-10-26T09:00:00.000Z',
        };

    for (final (label, draft, texts) in [
      (
        '作り直しで区切りの案を作っているとき',
        draftOf('rebuild', 'proposing', step: 'propose'),
        ['作り直しの区切りの案を作っています', 'やめる']
      ),
      (
        '作り直しの確かめ待ちのとき',
        draftOf('rebuild', 'reviewing'),
        ['作り直しの区切りの案ができました', '区切りを確認する', 'やめる']
      ),
      (
        '区切りの直しの途中のとき',
        draftOf('recut', 'reviewing'),
        ['区切りを直している途中です', '続ける', 'やめる']
      ),
      (
        '文を書き直しているとき',
        draftOf('rebuild', 'writing', step: 'write'),
        ['見出しと一言を書き直しています']
      ),
      (
        '作り直しの区切りの案を作れなかったとき',
        draftOf('rebuild', 'proposing', step: 'propose', state: 'failed'),
        ['作り直しの区切りの案を作れませんでした', 'もう一度', 'やめる']
      ),
      (
        '文を書き直せなかったとき',
        draftOf('recut', 'writing', step: 'write', state: 'failed'),
        ['見出しと一言を書き直せませんでした', 'もう一度', '区切りを確認する', 'やめる']
      ),
    ]) {
      testWidgets('$labelは、完成版を出したまま上に案内を出し、「区切りを直す」「作り直す」を出さない',
          (tester) async {
        await _openTimeline(tester, draft: draft);

        for (final text in texts) {
          expect(find.text(text), findsOneWidget);
        }
        expect(find.text('朝ごはん'), findsOneWidget);
        expect(find.text('区切りを直す'), findsNothing);
        expect(find.text('作り直す'), findsNothing);
      });
    }

    testWidgets('「やめる」は「作り直しをやめて、今のタイムラインのままにしますか？」を出し、「やめる」で下書きを消して完成版だけに戻る',
        (tester) async {
      final backend =
          await _openTimeline(tester, draft: draftOf('rebuild', 'reviewing'));

      await tester.tap(find.text('やめる'));
      await letFramesRun(tester);
      expect(inDialog(find.text('作り直しをやめて、今のタイムラインのままにしますか？')), findsOneWidget);
      await tapInDialog(tester, 'やめる');

      expect(backend.timelinesByTripId[hokkaidoTripId]!['draft'], isNull);
      expect(find.text('作り直しの区切りの案ができました'), findsNothing);
      expect(find.text('区切りを直す'), findsOneWidget);
    });

    testWidgets('「続ける」で区切りの直しの確認画面を開く', (tester) async {
      await _openTimeline(tester, draft: {
        ...draftOf('recut', 'reviewing'),
        'days': <Object?>[],
        'undatedPhotos': <Object?>[],
      });

      await tester.tap(find.text('続ける'));
      await letFramesRun(tester);
      expect(find.text('区切りを確認'), findsOneWidget);
    });
  });

  group('区切りを直す・作り直す', () {
    testWidgets('「区切りを直す」を押すと、完成版の区切りを写した下書きを作り、区切りの確認画面を開く', (tester) async {
      final backend = await _openTimeline(tester);

      await tester.tap(find.text('区切りを直す'));
      await letFramesRun(tester);
      expect(
          (backend.timelinesByTripId[hokkaidoTripId]!['draft']
              as Map)['reason'],
          'recut');
      expect(find.text('区切りを確認'), findsOneWidget);
      expect(find.text('写真を長押しすると『ここで区切る』、場面の境目の『つなげる』で前の場面とまとめられます。'),
          findsOneWidget);

      await tester.tap(find.byIcon(Icons.close));
      await letFramesRun(tester);
      expect(find.text('区切りを直している途中です'), findsOneWidget);
    });

    testWidgets('「区切りを直す」のときに別の端末が作り直しを始めていたら（409）、知らせて読み直す', (tester) async {
      final backend = await _openTimeline(tester);
      backend.timelinesByTripId[hokkaidoTripId] = _timelineOf(draft: {
        'id': '0b8e1c5a-0000-4000-8000-000000000099',
        'reason': 'rebuild',
        'phase': 'proposing',
        'job': {'step': 'propose', 'state': 'pending', 'lastError': null},
        'startedAt': '2026-10-26T09:00:00.000Z',
      });

      await tester.tap(find.text('区切りを直す'));
      await letFramesRun(tester);
      expect(find.text('タイムラインが変わりました。読み直しました'), findsOneWidget);
      expect(find.text('区切りを確認'), findsNothing);
      expect(find.text('作り直しの区切りの案を作っています'), findsOneWidget);
    });

    testWidgets('「作り直す」は確認のダイアログを出し、「作り直す」で作り直しを始めて、完成版の上に案内を出す',
        (tester) async {
      final backend = await _openTimeline(tester);

      await tester.tap(find.text('作り直す'));
      await letFramesRun(tester);
      expect(inDialog(find.text('タイムラインを作り直しますか？')), findsOneWidget);
      expect(
          inDialog(find.text(
              '今の写真で区切りの案を出し直し、確認した後に見出しと一言を書き直します。書き終えるまでは今のタイムラインのままです。手で直した文と区切りは、同じ日・同じ場面なら残ります。')),
          findsOneWidget);
      await tapInDialog(tester, '作り直す');

      expect(
          (backend.timelinesByTripId[hokkaidoTripId]!['draft']
              as Map)['reason'],
          'rebuild');
      expect(find.text('作り直しの区切りの案を作っています'), findsOneWidget);
      expect(find.text('朝ごはん'), findsOneWidget);
    });

    testWidgets('「区切りを直す」を送っている間は、「区切りを直す」「作り直す」を押せない', (tester) async {
      // 送っている間の扱いは §8.1 と同じ。全ケースは trip_timeline_test.dart の「操作を送っている間は…」で通している
      final backend = await _openTimeline(tester);
      final reply = backend.holdNextReply(TripRoute.timelineRecut);

      await tester.tap(find.text('区切りを直す'));
      await tester.pump();
      expect(_button(tester, '区切りを直す').onPressed, isNull);
      expect(_button(tester, '作り直す').onPressed, isNull);

      reply.complete();
      await letFramesRun(tester);
    });

    testWidgets('「作り直す」のダイアログで「キャンセル」を押すと、何もしない', (tester) async {
      final backend = await _openTimeline(tester);

      await tester.tap(find.text('作り直す'));
      await letFramesRun(tester);
      await tapInDialog(tester, 'キャンセル');

      expect(backend.timelinesByTripId[hokkaidoTripId]!['draft'], isNull);
      expect(find.text('作り直す'), findsOneWidget);
    });
  });

  group('サムネイルから写真ビューアを開く', () {
    testWidgets('場面のサムネイルをタップすると、その写真を写真ビューアで開き、閉じたらタイムラインを読み直す',
        (tester) async {
      final semantics = tester.ensureSemantics();
      final backend = await _openTimeline(tester);

      await tester.tap(photoThumbnail('2026年10月5日 07:58'));
      await letFramesRun(tester);
      expect(find.text('2026年10月5日 07:58').hitTestable(), findsOneWidget);

      // 開いている間に、別の端末が作り直しを始めた
      backend.timelinesByTripId[hokkaidoTripId] = _timelineOf(draft: {
        'id': '0b8e1c5a-0000-4000-8000-000000000099',
        'reason': 'rebuild',
        'phase': 'proposing',
        'job': {'step': 'propose', 'state': 'pending', 'lastError': null},
        'startedAt': '2026-10-26T09:00:00.000Z',
      });
      await tester.pageBack();
      await letFramesRun(tester);
      expect(find.text('作り直しの区切りの案を作っています'), findsOneWidget);
      semantics.dispose();
    });

    testWidgets('写真を読んでいる間にもう一度タップしても、写真ビューアは1つだけ開く', (tester) async {
      final semantics = tester.ensureSemantics();
      final backend = await _openTimeline(tester);
      final reply = backend.holdNextReply(TripRoute.getPhoto);

      await tester.tap(photoThumbnail('2026年10月5日 07:58'));
      await tester.pump();
      await tester.tap(photoThumbnail('2026年10月5日 07:58'));
      await tester.pump();
      reply.complete();
      await letFramesRun(tester);

      await tester.pageBack();
      await letFramesRun(tester);
      expect(find.text('2026年10月5日 07:58'), findsNothing);
      expect(find.text('朝ごはん'), findsOneWidget);
      semantics.dispose();
    });

    testWidgets('タップした写真が消えていたら、「この写真は削除されています」を出してタイムラインを読み直す',
        (tester) async {
      final semantics = tester.ensureSemantics();
      final backend = await _openTimeline(tester);
      // 写真 1 は旅行に無い（作った後に消えた）。読み直したことを、作り直しの案内が出ることで確かめる
      backend.timelinesByTripId[hokkaidoTripId] = _timelineOf(draft: {
        'id': '0b8e1c5a-0000-4000-8000-000000000099',
        'reason': 'rebuild',
        'phase': 'proposing',
        'job': {'step': 'propose', 'state': 'pending', 'lastError': null},
        'startedAt': '2026-10-26T09:00:00.000Z',
      });

      await tester.tap(photoThumbnail('2026年10月5日 07:50'));
      await letFramesRun(tester);
      expect(find.text('この写真は削除されています'), findsOneWidget);
      expect(find.text('作り直しの区切りの案を作っています'), findsOneWidget);
      semantics.dispose();
    });

    testWidgets('写真を読めなかったら、エラーの文言を出し、表示はそのまま', (tester) async {
      final semantics = tester.ensureSemantics();
      final backend = await _openTimeline(tester);
      backend.failNext(TripRoute.getPhoto);

      await tester.tap(photoThumbnail('2026年10月5日 07:58'));
      await letFramesRun(tester);
      expect(find.text('サービスに一時的に接続できません。しばらく待ってから再試行してください。'), findsOneWidget);
      expect(find.text('朝ごはん'), findsOneWidget);
      semantics.dispose();
    });
  });

  testWidgets('作り直しの区切りの確認画面の「やめる」は、作り直しをやめるダイアログを出し、完成版だけに戻る', (tester) async {
    final backend = await _openTimeline(tester, draft: {
      'id': '0b8e1c5a-0000-4000-8000-000000000099',
      'reason': 'rebuild',
      'phase': 'reviewing',
      'job': null,
      'startedAt': '2026-10-26T09:00:00.000Z',
      'days': <Object?>[],
      'undatedPhotos': <Object?>[],
    });
    await tester.tap(find.text('区切りを確認する'));
    await letFramesRun(tester);

    await tester.tap(find.byIcon(Icons.more_vert));
    await letFramesRun(tester);
    await tester.tap(find.text('やめる'));
    await letFramesRun(tester);
    expect(inDialog(find.text('作り直しをやめて、今のタイムラインのままにしますか？')), findsOneWidget);
    await tapInDialog(tester, 'やめる');

    expect(backend.timelinesByTripId[hokkaidoTripId]!['draft'], isNull);
    expect(find.text('区切りを確認'), findsNothing);
    expect(find.text('区切りを直す'), findsOneWidget);
  });

  testWidgets('タイトルもまとめも無い日は印を出さず、見出しも一言も無い場面はその行を出さない', (tester) async {
    await _openTimeline(tester, current: {
      'writtenAt': '2026-10-25T09:10:00.000Z',
      'days': [
        {
          'date': '2026-10-05',
          'dayNumber': 1,
          'title': null,
          'titleSource': null,
          'summary': null,
          'summarySource': null,
          'scenes': [
            _scene([_photo(1, '2026-10-05T07:50:00')],
                label: null, note: null, placeNames: ['北海道千歳市']),
          ],
        },
      ],
      'undatedPhotos': <Object?>[],
    });

    expect(find.text('1日目'), findsOneWidget);
    expect(find.text('7:50 · 北海道千歳市'), findsOneWidget);
    expect(find.text('AI のまとめ'), findsNothing);
    expect(find.text('編集済み'), findsNothing);
    // 見出しの行（印と見出し）を出さない
    expect(find.byIcon(Icons.circle), findsNothing);
    // 日時なしの写真が無ければ、見出しも出さない
    expect(find.text('日時なし'), findsNothing);
  });

  testWidgets('日時なしの写真のサムネイルをタップしても、写真ビューアで開く', (tester) async {
    final semantics = tester.ensureSemantics();
    await _openTimeline(tester);

    await _scrollTo(tester, find.text('日時なし'));
    await tester.tap(photoThumbnail('撮影日時なし'));
    await letFramesRun(tester);
    // 写真ビューアは撮影日時の代わりに「撮影日時なし」を出す
    expect(find.text('撮影日時なし').hitTestable(), findsOneWidget);
    expect(find.text('日時なし'), findsNothing);
    semantics.dispose();
  });

  group('日と場面の文を直す（編集シート）', () {
    /// 写真 1 から始まる場面（朝ごはん）の id
    final breakfastId = timelinePhotoJson(1, null)['id'] as String;

    /// 完成版の場面を偽のサーバから探す
    Map<String, Object?> sceneOf(FakeTripBackend backend, String startPhotoId) {
      final current = backend.timelinesByTripId[hokkaidoTripId]!['current']
          as Map<String, Object?>;
      return [
        for (final day in current['days'] as List)
          for (final scene in (day as Map)['scenes'] as List)
            scene as Map<String, Object?>
      ].firstWhere((scene) => scene['startPhotoId'] == startPhotoId);
    }

    /// シートの [label] の欄
    Finder field(String label) => find.widgetWithText(TextField, label);

    /// 最初の場面（朝ごはん）の編集シートを開く
    Future<void> openSceneSheet(WidgetTester tester) async {
      await tester.tap(find.bySemanticsLabel('この場面を編集').first);
      await letFramesRun(tester);
    }

    testWidgets('場面の編集のボタンで、今の見出しと一言を入れたシートを開き、見出しを直して保存すると描き直す',
        (tester) async {
      final semantics = tester.ensureSemantics();
      final backend = await _openTimeline(tester);

      await openSceneSheet(tester);
      expect(find.text('場面を編集'), findsOneWidget);
      expect(find.text('空にすると、AI が書いた文に戻ります'), findsOneWidget);
      expect(tester.widget<TextField>(field('見出し')).controller!.text, '朝ごはん');
      expect(
          tester.widget<TextField>(field('一言')).controller!.text, '港の市場で海鮮丼。');

      await tester.enterText(field('見出し'), '  市場の朝ごはん  ');
      await tester.tap(find.text('保存'));
      await letFramesRun(tester);

      expect(find.text('場面を編集'), findsNothing);
      expect(find.text('市場の朝ごはん'), findsOneWidget);
      expect(sceneOf(backend, breakfastId)['labelSource'], 'user');
      // 変えていない一言は送らない（AI の文のまま）
      expect(sceneOf(backend, breakfastId)['noteSource'], 'ai');
      semantics.dispose();
    });

    testWidgets('日の編集のボタンで「N日目を編集」を開き、まとめを直して保存すると描き直す', (tester) async {
      final semantics = tester.ensureSemantics();
      await _openTimeline(tester);

      await tester.tap(find.bySemanticsLabel('この日を編集').first);
      await letFramesRun(tester);
      expect(find.text('1日目を編集'), findsOneWidget);
      expect(
          tester.widget<TextField>(field('タイトル')).controller!.text, '小樽の運河と寿司');
      expect(tester.widget<TextField>(field('まとめ')).controller!.text,
          '朝は市場で海鮮丼、昼は運河を歩いた。');

      await tester.enterText(field('まとめ'), '市場と運河の一日。');
      await tester.tap(find.text('保存'));
      await letFramesRun(tester);

      expect(find.text('1日目を編集'), findsNothing);
      expect(find.text('市場と運河の一日。'), findsOneWidget);
      semantics.dispose();
    });

    testWidgets('何も変えずに保存したら、送らずに閉じる', (tester) async {
      final semantics = tester.ensureSemantics();
      final backend = await _openTimeline(tester);
      // 送ってしまうと、この失敗でシートが開いたままになる
      backend.failNext(TripRoute.timelineScenePatch);

      await openSceneSheet(tester);
      await tester.tap(find.text('保存'));
      await letFramesRun(tester);

      expect(find.text('場面を編集'), findsNothing);
      expect(find.text('サービスに一時的に接続できません。しばらく待ってから再試行してください。'), findsNothing);
      semantics.dispose();
    });

    testWidgets('前後の空白だけを変えた欄は変えていないものとして、送らずに閉じる', (tester) async {
      final semantics = tester.ensureSemantics();
      final backend = await _openTimeline(tester);
      // 送ってしまうと、この失敗でシートが開いたままになる
      backend.failNext(TripRoute.timelineScenePatch);

      await openSceneSheet(tester);
      await tester.enterText(field('見出し'), '  朝ごはん  ');
      await tester.tap(find.text('保存'));
      await letFramesRun(tester);

      expect(find.text('場面を編集'), findsNothing);
      semantics.dispose();
    });

    for (final (sheet, label, limit) in [
      ('場面', '見出し', 30),
      ('場面', '一言', 200),
      ('日', 'タイトル', 40),
      ('日', 'まとめ', 400),
    ]) {
      testWidgets('$sheetの「$label」の欄は $limit 文字で止める', (tester) async {
        final semantics = tester.ensureSemantics();
        await _openTimeline(tester);

        await tester.tap(find.bySemanticsLabel('この$sheetを編集').first);
        await letFramesRun(tester);
        await tester.enterText(field(label), 'あ' * (limit + 1));
        await tester.pump();

        expect(tester.widget<TextField>(field(label)).controller!.text.length,
            limit);
        semantics.dispose();
      });
    }

    testWidgets('欄を空にして保存すると、AI が書いた文に戻る', (tester) async {
      final semantics = tester.ensureSemantics();
      final backend = await _openTimeline(tester);
      backend.timelineAiTexts['$breakfastId:label'] = 'AI の朝ごはん';

      await openSceneSheet(tester);
      await tester.enterText(field('見出し'), '');
      await tester.tap(find.text('保存'));
      await letFramesRun(tester);

      expect(find.text('AI の朝ごはん'), findsOneWidget);
      expect(sceneOf(backend, breakfastId)['labelSource'], 'ai');
      semantics.dispose();
    });

    testWidgets('保存している間は、閉じられず「キャンセル」「保存」も押せない', (tester) async {
      final semantics = tester.ensureSemantics();
      final backend = await _openTimeline(tester);
      final reply = backend.holdNextReply(TripRoute.timelineScenePatch);

      await openSceneSheet(tester);
      await tester.enterText(field('見出し'), '市場の朝ごはん');
      await tester.tap(find.text('保存'));
      await tester.pump();
      expect(_button(tester, '保存').onPressed, isNull);
      expect(_button(tester, 'キャンセル').onPressed, isNull);
      await tester.pageBack();
      // 閉じていくシートも、閉じ終えるまでは見つかる。閉じ終えるだけの時間を進めてから見る
      await letFramesRun(tester);
      expect(find.text('場面を編集'), findsOneWidget);

      reply.complete();
      await letFramesRun(tester);
      expect(find.text('場面を編集'), findsNothing);
      semantics.dispose();
    });

    testWidgets('保存に失敗したら、シートを開いたままエラーの文言を出す', (tester) async {
      final semantics = tester.ensureSemantics();
      final backend = await _openTimeline(tester);
      backend.failNext(TripRoute.timelineScenePatch);

      await openSceneSheet(tester);
      await tester.enterText(field('見出し'), '市場の朝ごはん');
      await tester.tap(find.text('保存'));
      await letFramesRun(tester);

      expect(find.text('場面を編集'), findsOneWidget);
      expect(find.text('サービスに一時的に接続できません。しばらく待ってから再試行してください。'), findsOneWidget);
      expect(_button(tester, '保存').onPressed, isNotNull);
      semantics.dispose();
    });

    for (final (label, status, code, message) in [
      (
        '別の端末がタイムラインを変えていたら（409）',
        409,
        'TIMELINE_STATE_CONFLICT',
        'タイムラインが変わったか、作っている途中です。読み直してください'
      ),
      ('その場面が無くなっていたら（404）', 404, 'TIMELINE_NOT_FOUND', 'その場面はタイムラインにありません'),
    ]) {
      testWidgets('保存のときに$label、閉じて知らせ、読み直す', (tester) async {
        final semantics = tester.ensureSemantics();
        final backend = await _openTimeline(tester);
        backend.failNext(TripRoute.timelineScenePatch,
            status: status, code: code, message: message);
        // 読み直したことを、作り直しの案内が出ることで確かめる
        backend.timelinesByTripId[hokkaidoTripId] = _timelineOf(draft: {
          'id': '0b8e1c5a-0000-4000-8000-000000000099',
          'reason': 'rebuild',
          'phase': 'proposing',
          'job': {'step': 'propose', 'state': 'pending', 'lastError': null},
          'startedAt': '2026-10-26T09:00:00.000Z',
        });

        await openSceneSheet(tester);
        await tester.enterText(field('見出し'), '市場の朝ごはん');
        await tester.tap(find.text('保存'));
        await letFramesRun(tester);

        expect(find.text('場面を編集'), findsNothing);
        expect(find.text('タイムラインが変わりました。読み直しました'), findsOneWidget);
        expect(find.text('作り直しの区切りの案を作っています'), findsOneWidget);
        semantics.dispose();
      });
    }

    testWidgets('保存のときに旅行が別の端末で消されていたら、閉じて「この旅行は削除されています」を出す', (tester) async {
      final semantics = tester.ensureSemantics();
      final backend = await _openTimeline(tester);

      await openSceneSheet(tester);
      await tester.enterText(field('見出し'), '市場の朝ごはん');
      backend.trips.clear();
      await tester.tap(find.text('保存'));
      await letFramesRun(tester);

      expect(find.text('場面を編集'), findsNothing);
      expect(find.text('この旅行は削除されています'), findsOneWidget);
      // タイムラインが変わったのではない（読み直して気づくのではなく、保存の応答で旅行が無いと分かる）
      expect(find.text('タイムラインが変わりました。読み直しました'), findsNothing);
      semantics.dispose();
    });

    testWidgets('下書きがある間も、場面の文を直せる', (tester) async {
      final semantics = tester.ensureSemantics();
      await _openTimeline(tester, draft: {
        'id': '0b8e1c5a-0000-4000-8000-000000000099',
        'reason': 'rebuild',
        'phase': 'proposing',
        'job': {'step': 'propose', 'state': 'pending', 'lastError': null},
        'startedAt': '2026-10-26T09:00:00.000Z',
      });

      await openSceneSheet(tester);
      await tester.enterText(field('見出し'), '市場の朝ごはん');
      await tester.tap(find.text('保存'));
      await letFramesRun(tester);

      expect(find.text('市場の朝ごはん'), findsOneWidget);
      semantics.dispose();
    });
  });

  group('作った後に写真が変わった案内・残せなかった文', () {
    for (final (label, added, removed, text) in [
      ('増えて消えたら', 3, 2, '作った後に写真が 3 枚増え、2 枚消えました。今のタイムラインには入っていません。'),
      ('増えただけなら', 3, 0, '作った後に写真が 3 枚増えました。今のタイムラインには入っていません。'),
      ('消えただけなら', 0, 2, '作った後に写真が 2 枚消えました。今のタイムラインには入っていません。'),
    ]) {
      testWidgets('作った後に写真が$label、その枚数の案内と「あとで」「作り直す」を出す', (tester) async {
        await _openTimeline(tester,
            changes: {'added': added, 'removed': removed});

        expect(find.text(text), findsOneWidget);
        expect(find.text('あとで'), findsOneWidget);
        // 上の「作り直す」と、案内の「作り直す」
        expect(find.text('作り直す'), findsNWidgets(2));
      });
    }

    testWidgets('「あとで」を押すと、写真が変わった案内を隠す', (tester) async {
      await _openTimeline(tester, changes: {'added': 3, 'removed': 0});

      await tester.tap(find.text('あとで'));
      await letFramesRun(tester);
      expect(find.textContaining('作った後に写真が'), findsNothing);
      expect(find.text('作り直す'), findsOneWidget);
    });

    testWidgets('写真が変わった案内の「作り直す」は、作り直しの確認のダイアログを出す', (tester) async {
      await _openTimeline(tester, changes: {'added': 3, 'removed': 0});

      // 案内は作成日時の上に出すので、最初の「作り直す」が案内のもの
      await tester.tap(find.text('作り直す').first);
      await letFramesRun(tester);
      expect(inDialog(find.text('タイムラインを作り直しますか？')), findsOneWidget);
    });

    testWidgets('写真が変わっても、下書きがある間は案内を出さない', (tester) async {
      await _openTimeline(tester, changes: {
        'added': 3,
        'removed': 2
      }, draft: {
        'id': '0b8e1c5a-0000-4000-8000-000000000099',
        'reason': 'rebuild',
        'phase': 'proposing',
        'job': {'step': 'propose', 'state': 'pending', 'lastError': null},
        'startedAt': '2026-10-26T09:00:00.000Z',
      });

      expect(find.textContaining('作った後に写真が'), findsNothing);
      expect(find.text('作り直しの区切りの案を作っています'), findsOneWidget);
    });

    testWidgets('残せなかった文があれば、件数とその文・「閉じる」を出し、「閉じる」で消す', (tester) async {
      final backend = await _openTimeline(tester, droppedEdits: [
        {
          'kind': 'scene',
          'key': 'c4ca42',
          'field': 'label',
          'text': '小樽運河をのんびり'
        },
        {'kind': 'day', 'key': '2026-10-06', 'field': 'title', 'text': '札幌の休日'},
      ]);

      expect(find.text('場面や日が無くなったため、手で直した文のうち 2 件を残せませんでした'), findsOneWidget);
      expect(find.text('小樽運河をのんびり'), findsOneWidget);
      expect(find.text('札幌の休日'), findsOneWidget);

      await tester.tap(find.text('閉じる'));
      await letFramesRun(tester);
      expect(
          backend.timelinesByTripId[hokkaidoTripId]!['droppedEdits'], isEmpty);
      expect(find.textContaining('残せませんでした'), findsNothing);
    });

    testWidgets('残せなかった文は、下書きがある間も出す', (tester) async {
      await _openTimeline(tester, droppedEdits: [
        {'kind': 'day', 'key': '2026-10-06', 'field': 'title', 'text': '札幌の休日'},
      ], draft: {
        'id': '0b8e1c5a-0000-4000-8000-000000000099',
        'reason': 'rebuild',
        'phase': 'proposing',
        'job': {'step': 'propose', 'state': 'pending', 'lastError': null},
        'startedAt': '2026-10-26T09:00:00.000Z',
      });

      expect(find.text('場面や日が無くなったため、手で直した文のうち 1 件を残せませんでした'), findsOneWidget);
    });

    testWidgets('残せなかった文を閉じるのに失敗したら、エラーの文言を出し、文はそのまま', (tester) async {
      final backend = await _openTimeline(tester, droppedEdits: [
        {'kind': 'day', 'key': '2026-10-06', 'field': 'title', 'text': '札幌の休日'},
      ]);
      backend.failNext(TripRoute.timelineDroppedEditsDelete);

      await tester.tap(find.text('閉じる'));
      await letFramesRun(tester);
      expect(find.text('サービスに一時的に接続できません。しばらく待ってから再試行してください。'), findsOneWidget);
      expect(find.text('札幌の休日'), findsOneWidget);
    });

    testWidgets('「あとで」で隠した案内は、タイムラインを読み直すとまた出す', (tester) async {
      final semantics = tester.ensureSemantics();
      await _openTimeline(tester, changes: {'added': 3, 'removed': 0});
      await tester.tap(find.text('あとで'));
      await letFramesRun(tester);
      expect(find.textContaining('作った後に写真が'), findsNothing);

      // 写真ビューアを開いて閉じると、同じ表示のままタイムラインを読み直す（§8.3）
      await tester.tap(photoThumbnail('2026年10月5日 07:58'));
      await letFramesRun(tester);
      await tester.pageBack();
      await letFramesRun(tester);
      expect(find.text('作った後に写真が 3 枚増えました。今のタイムラインには入っていません。'), findsOneWidget);
      semantics.dispose();
    });

    testWidgets('解析中の写真がある間は、写真が変わった案内の「作り直す」も押せない', (tester) async {
      await _openTimeline(tester,
          changes: {'added': 3, 'removed': 0}, pendingPhotoCount: 2);

      // 案内は作成日時の上に出すので、最初の「作り直す」が案内のもの
      expect(
          tester
              .widget<ButtonStyleButton>(find.ancestor(
                  of: find.text('作り直す').first,
                  matching: find.bySubtype<ButtonStyleButton>()))
              .onPressed,
          isNull);
    });

    testWidgets('作り直しを受け付けた後も、残せなかった文の案内を出したまま', (tester) async {
      await _openTimeline(tester, droppedEdits: [
        {'kind': 'day', 'key': '2026-10-06', 'field': 'title', 'text': '札幌の休日'},
      ]);

      await tester.tap(find.text('作り直す'));
      await letFramesRun(tester);
      await tapInDialog(tester, '作り直す');

      expect(find.text('作り直しの区切りの案を作っています'), findsOneWidget);
      expect(find.text('札幌の休日'), findsOneWidget);
    });

    testWidgets('操作を送っている間は、日と場面の編集のボタンも残せなかった文の「閉じる」も押せない', (tester) async {
      // 送っている間の扱いは §8.1 と同じ。全ケースは trip_timeline_test.dart の「操作を送っている間は…」で通している
      final semantics = tester.ensureSemantics();
      final backend = await _openTimeline(tester, droppedEdits: [
        {'kind': 'day', 'key': '2026-10-06', 'field': 'title', 'text': '札幌の休日'},
      ]);
      final reply = backend.holdNextReply(TripRoute.timelineRecut);

      await tester.tap(find.text('区切りを直す'));
      await tester.pump();
      for (final label in ['この日を編集', 'この場面を編集']) {
        expect(
            tester
                .widget<IconButton>(find.ancestor(
                    of: find.bySemanticsLabel(label).first,
                    matching: find.byType(IconButton)))
                .onPressed,
            isNull);
      }
      expect(_button(tester, '閉じる').onPressed, isNull);

      reply.complete();
      await letFramesRun(tester);
      semantics.dispose();
    });
  });
}
