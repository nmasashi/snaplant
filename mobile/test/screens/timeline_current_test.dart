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

/// タイムライン（完成版と、あれば下書き）。
/// `droppedEdits` は入れない: 5-5c のアプリは読まず、5-5d で API から消える（05 §5.15）。入れておくと、必ず読む形に戻る退行を捕まえられない
Map<String, Object?> _timelineOf({Map<String, Object?>? draft}) => {
      'current': _current(),
      'draft': draft,
      'changes': {'added': 0, 'removed': 0},
    };

/// 旅行詳細の「タイムライン」を開く
Future<FakeTripBackend> _openTimeline(WidgetTester tester,
    {Map<String, Object?>? draft,
    int pendingPhotoCount = 0,
    Map<String, Object?>? current,
    Map<String, Object?>? changes}) async {
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
  };
  backend.pendingPhotoCountByTripId[hokkaidoTripId] = pendingPhotoCount;
  // 1つのテストの中で開き直すとき、前のアプリの木（開いている画面）を残さない
  await tester.pumpWidget(const SizedBox());
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

/// 写真が変わった案内の枠の中の [text]（上の「作り直す」と見分ける）
Finder _inChangesNotice(String text) => find.descendant(
    of: find.ancestor(
        of: find.textContaining('作った後に写真が'), matching: find.byType(Card)),
    matching: find.text(text));

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

    testWidgets('下書きの理由・段階ごとに、完成版を出したまま上に案内を出し、「区切りを直す」「作り直す」を出さない',
        (tester) async {
      // 1つのテストで下書きを取り替えながらアプリを開き直す（開き直すたびに木は作り直される）
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
        await _openTimeline(tester, draft: draft);

        for (final text in texts) {
          expect(find.text(text), findsOneWidget, reason: label);
        }
        expect(find.text('朝ごはん'), findsOneWidget, reason: label);
        expect(find.text('区切りを直す'), findsNothing, reason: label);
        expect(find.text('作り直す'), findsNothing, reason: label);
      }
    });

    testWidgets('区切りの直しで見出しと一言を書き直せなかった下書き（AI なしにする前のもの）で「もう一度」を押すと、その場で保存されてタイムラインを読み直し、案内を消す', (tester) async {
      final backend = await _openTimeline(tester,
          draft: draftOf('recut', 'writing', step: 'write', state: 'failed'));
      // 本物は下書きの区切りを完成版に当てる（偽物は描き直さないので、当てた後の完成版をここで置く）。
      // 1日目の2つの場面をつなげた区切り: 後ろの「小樽運河さんぽ」の文は捨てられる（06 §8.6）。読み直せば、それが消える
      final applied = _current();
      final day1 = (applied['days'] as List).first as Map<String, Object?>;
      day1['scenes'] = [
        _scene([
          _photo(1, '2026-10-05T07:50:00', category: 'food'),
          _photo(2, '2026-10-05T07:58:00', category: 'food'),
          for (var n = 3; n <= 8; n++) _photo(n, '2026-10-05T1${n - 3}:10:00'),
        ], label: '朝ごはん', note: '港の市場で海鮮丼。', startedBy: 'day'),
      ];
      backend.timelinesByTripId[hokkaidoTripId] = {
        ...backend.timelinesByTripId[hokkaidoTripId]!,
        'current': applied
      };

      await tester.tap(find.text('もう一度'));
      await letFramesRun(tester);

      expect(backend.timelinesByTripId[hokkaidoTripId]!['draft'], isNull);
      expect(find.text('小樽運河さんぽ'), findsNothing);
      expect(find.text('見出しと一言を書き直せませんでした'), findsNothing);
      expect(find.text('区切りを直す'), findsOneWidget);
      expect(find.text('タイムラインの操作に失敗しました'), findsNothing);
    });

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
      expect(
          find.text(
              '写真を長押しすると『ここで区切る』、場面の境目の『つなげる』で前の場面とまとめられます。新しくできた場面は見出しなしになります。つなげると、後ろの場面の見出しと一言は消えます。'),
          findsOneWidget);

      await tester.tap(find.byIcon(Icons.close));
      await letFramesRun(tester);
      expect(find.text('区切りを直している途中です'), findsOneWidget);
    });

    testWidgets('区切りを直して確認画面の下のボタンを押すと、AI を待たずにその場で保存して旅行詳細に戻り、直している途中の案内を出さずに完成版を出す', (tester) async {
      final backend = await _openTimeline(tester);
      await tester.tap(find.text('区切りを直す'));
      await letFramesRun(tester);

      await tester.tap(find.text('この区切りで保存'));
      await letFramesRun(tester);

      expect(backend.timelinesByTripId[hokkaidoTripId]!['draft'], isNull);
      expect(find.text('区切りを確認'), findsNothing);
      expect(find.text('区切りを直している途中です'), findsNothing);
      expect(find.text('見出しと一言を書き直しています'), findsNothing);
      expect(find.text('タイムラインの操作に失敗しました'), findsNothing);
      expect(find.textContaining('ネットワーク'), findsNothing);
      expect(find.text('朝ごはん'), findsOneWidget);
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
              '今の写真で、AI が区切りの案から作り直します。手で直した文と区切りは消えます。書き終えるまでは今のタイムラインのままです。')),
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
      await tapBack(tester);
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

      await tapBack(tester);
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

  testWidgets('タイトルもまとめも無い日は印を出さず、見出しの無い場面（区切りを直して足した場面）は見出しの所に「見出しなし」と出し、一言の無い場面はその行を出さない', (tester) async {
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
    // 見出しの印は出さず、見出しの所に「見出しなし」と出す（編集のボタンで書ける。§8.3）
    expect(find.byIcon(Icons.circle), findsNothing);
    expect(find.text('見出しなし'), findsOneWidget);
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

    testWidgets('場面の編集のボタンで、今の見出しと一言を入れたシートを開き、見出しを直して保存すると描き直し、一言は送らず AI の文のまま残る',
        (tester) async {
      final semantics = tester.ensureSemantics();
      final backend = await _openTimeline(tester);

      await openSceneSheet(tester);
      expect(find.text('場面を編集'), findsOneWidget);
      expect(find.text('空にすると、AI が書いた文に戻ります（AI が書いていない場面は空になります）'), findsOneWidget);
      expect(tester.widget<TextField>(field('見出し')).controller!.text, '朝ごはん');
      expect(
          tester.widget<TextField>(field('一言')).controller!.text, '港の市場で海鮮丼。');

      await tester.enterText(field('見出し'), '市場の朝ごはん');
      await tester.tap(find.text('保存'));
      await letFramesRun(tester);

      expect(find.text('場面を編集'), findsNothing);
      expect(find.text('市場の朝ごはん'), findsOneWidget);
      expect(find.text('朝ごはん'), findsNothing);
      // 直していない一言は送らず、AI の文のまま残る
      expect(sceneOf(backend, breakfastId)['labelSource'], 'user');
      expect(sceneOf(backend, breakfastId)['noteSource'], 'ai');
      semantics.dispose();
    });

    testWidgets('日の編集のボタンで「N日目を編集」を開き、まとめを直して保存すると描き直す', (tester) async {
      final semantics = tester.ensureSemantics();
      await _openTimeline(tester);

      await tester.tap(find.bySemanticsLabel('この日を編集').first);
      await letFramesRun(tester);
      expect(find.text('1日目を編集'), findsOneWidget);
      // 日は区切りを直しても足されないので、いつも AI の文がある（場面の「AI が書いていない場面は…」は添えない）
      expect(find.text('空にすると、AI が書いた文に戻ります'), findsOneWidget);
      expect(
          tester.widget<TextField>(field('タイトル')).controller!.text, '小樽の運河と寿司');
      expect(tester.widget<TextField>(field('まとめ')).controller!.text,
          '朝は市場で海鮮丼、昼は運河を歩いた。');

      await tester.enterText(field('まとめ'), '市場と運河の一日。');
      await tester.tap(find.text('保存'));
      await letFramesRun(tester);

      expect(find.text('1日目を編集'), findsNothing);
      expect(find.text('市場と運河の一日。'), findsOneWidget);
      // 直したのは1日目（ほかの日を直していない）
      expect(find.text('朝は市場で海鮮丼、昼は運河を歩いた。'), findsNothing);
      semantics.dispose();
    });

    testWidgets('前後の空白だけを変えた欄は変えていないものとして、何も変えていなければ送らずに閉じる', (tester) async {
      final semantics = tester.ensureSemantics();
      final backend = await _openTimeline(tester);
      // 送ってしまうと、この失敗でシートが開いたままになる
      backend.failNext(TripRoute.timelineScenePatch);

      await openSceneSheet(tester);
      await tester.enterText(field('見出し'), '  朝ごはん  ');
      await tester.tap(find.text('保存'));
      await letFramesRun(tester);

      expect(find.text('場面を編集'), findsNothing);
      expect(find.text('サービスに一時的に接続できません。しばらく待ってから再試行してください。'), findsNothing);
      semantics.dispose();
    });

    testWidgets('場面の「見出し」「一言」の欄は 30・200 文字、日の「タイトル」「まとめ」の欄は 40・400 文字で止める',
        (tester) async {
      final semantics = tester.ensureSemantics();
      await _openTimeline(tester);

      for (final (sheet, limits) in [
        ('場面', {'見出し': 30, '一言': 200}),
        ('日', {'タイトル': 40, 'まとめ': 400}),
      ]) {
        await tester.tap(find.bySemanticsLabel('この$sheetを編集').first);
        await letFramesRun(tester);
        for (final MapEntry(key: label, value: limit) in limits.entries) {
          await tester.enterText(field(label), 'あ' * (limit + 1));
          await tester.pump();
          expect(tester.widget<TextField>(field(label)).controller!.text.length,
              limit, reason: '$sheetの「$label」');
        }
        await tester.tap(find.text('キャンセル'));
        await letFramesRun(tester);
      }
      semantics.dispose();
    });

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

    testWidgets('「見出しなし」の場面（区切りを直して足した場面）は見出しを書けて、空にすると「見出しなし」に戻る', (tester) async {
      final semantics = tester.ensureSemantics();
      // 最初の場面は AI の文が無い（区切りを直して足した場面。05 §5.15）
      final current = _current();
      final firstScene = ((current['days'] as List).first as Map<String, Object?>)['scenes'] as List;
      firstScene[0] = {...firstScene[0] as Map<String, Object?>, 'label': null, 'labelSource': null};
      final backend = await _openTimeline(tester, current: current);
      backend.timelineAiTexts['$breakfastId:label'] = null;
      expect(find.text('見出しなし'), findsOneWidget);

      await openSceneSheet(tester);
      await tester.enterText(field('見出し'), '市場');
      await tester.tap(find.text('保存'));
      await letFramesRun(tester);
      expect(find.text('市場'), findsOneWidget);
      expect(find.text('見出しなし'), findsNothing);

      await openSceneSheet(tester);
      await tester.enterText(field('見出し'), '');
      await tester.tap(find.text('保存'));
      await letFramesRun(tester);
      expect(find.text('見出しなし'), findsOneWidget);
      semantics.dispose();
    });

    testWidgets('保存している間は、「保存」をもう一度押しても1回だけ保存し、下に引いても端末の戻る操作でも閉じず「キャンセル」「保存」も押せず、応答が届いたら閉じてタイムラインに戻る',
        (tester) async {
      final semantics = tester.ensureSemantics();
      final backend = await _openTimeline(tester);
      final reply = backend.holdNextReply(TripRoute.timelineScenePatch);

      await openSceneSheet(tester);
      await tester.enterText(field('見出し'), '市場の朝ごはん');
      // 2回目は、押せなくなった描き直しが届く前に押す
      await tester.tap(find.text('保存'));
      await tester.tap(find.text('保存'), warnIfMissed: false);
      await tester.pump();
      expect(_button(tester, '保存').onPressed, isNull);
      expect(_button(tester, 'キャンセル').onPressed, isNull);
      await tester.drag(find.text('場面を編集'), const Offset(0, 600));
      await letFramesRun(tester);
      expect(find.text('場面を編集'), findsOneWidget);
      // 端末の戻る操作（Android の戻るジェスチャーと同じ経路で PopScope を通る）。
      // 画面の戻るボタン（tapBack）はシートの下の旅行詳細の戻るボタンを狙い、実際はシートの外の幕に当たってしまう
      await tester.binding.handlePopRoute();
      // 閉じていくシートも、閉じ終えるまでは見つかる。閉じ終えるだけの時間を進めてから見る
      await letFramesRun(tester);
      expect(find.text('場面を編集'), findsOneWidget);

      reply.complete();
      await letFramesRun(tester);
      // 旅行詳細のタイムラインのまま（2回目の応答で旅行詳細まで閉じない）
      expect(find.text('場面を編集'), findsNothing);
      expect(find.text('タイムライン'), findsOneWidget);
      expect(find.text('市場の朝ごはん'), findsOneWidget);
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

    testWidgets('保存のときに別の端末がタイムラインを変えていたら（409）、その場面が無くなっていたら（404）、閉じて知らせ、読み直す',
        (tester) async {
      final semantics = tester.ensureSemantics();
      for (final (label, status, code, message) in [
        (
          '409',
          409,
          'TIMELINE_STATE_CONFLICT',
          'タイムラインが変わったか、作っている途中です。読み直してください'
        ),
        ('404', 404, 'TIMELINE_NOT_FOUND', 'その場面はタイムラインにありません'),
      ]) {
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

        expect(find.text('場面を編集'), findsNothing, reason: label);
        expect(find.text('タイムラインが変わりました。読み直しました'), findsOneWidget,
            reason: label);
        expect(find.text('作り直しの区切りの案を作っています'), findsOneWidget,
            reason: label);
      }
      semantics.dispose();
    });

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

  group('作った後に写真が変わった案内', () {
    testWidgets('作った後に写真が増えた・消えた枚数の案内を作成日時の上に「あとで」「作り直す」と出し、「作り直す」は作り直しの確認を出し、「あとで」で隠した案内は読み直すとまた出す',
        (tester) async {
      final semantics = tester.ensureSemantics();
      for (final (label, added, removed, text) in [
        ('増えて消えたら', 3, 2, '作った後に写真が 3 枚増え、2 枚消えました。今のタイムラインには入っていません。'),
        ('消えただけなら', 0, 2, '作った後に写真が 2 枚消えました。今のタイムラインには入っていません。'),
        ('増えただけなら', 3, 0, '作った後に写真が 3 枚増えました。今のタイムラインには入っていません。'),
      ]) {
        await _openTimeline(tester,
            changes: {'added': added, 'removed': removed});

        expect(find.text(text), findsOneWidget, reason: label);
        expect(find.text('あとで'), findsOneWidget, reason: label);
        // 上の「作り直す」と、案内の「作り直す」
        expect(find.text('作り直す'), findsNWidgets(2), reason: label);
      }
      expect(tester.getTopLeft(find.textContaining('作った後に写真が')).dy,
          lessThan(tester.getTopLeft(find.textContaining('に作成')).dy));

      await tester.tap(_inChangesNotice('作り直す'));
      await letFramesRun(tester);
      expect(inDialog(find.text('タイムラインを作り直しますか？')), findsOneWidget);
      await tapInDialog(tester, 'キャンセル');

      await tester.tap(find.text('あとで'));
      await letFramesRun(tester);
      expect(find.textContaining('作った後に写真が'), findsNothing);
      expect(find.text('作り直す'), findsOneWidget);

      // 写真ビューアを開いて閉じると、同じ表示のままタイムラインを読み直す（§8.3）
      await tester.tap(photoThumbnail('2026年10月5日 07:58'));
      await letFramesRun(tester);
      await tapBack(tester);
      await letFramesRun(tester);
      expect(find.text('作った後に写真が 3 枚増えました。今のタイムラインには入っていません。'), findsOneWidget);
      semantics.dispose();
    });

    testWidgets('下書きがある間は、写真が変わっても案内を出さない', (tester) async {
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

    testWidgets('解析中の写真がある間は、写真が変わった案内の「作り直す」も押せない', (tester) async {
      await _openTimeline(tester,
          changes: {'added': 3, 'removed': 0}, pendingPhotoCount: 2);

      expect(
          tester
              .widget<ButtonStyleButton>(find.ancestor(
                  of: _inChangesNotice('作り直す'),
                  matching: find.bySubtype<ButtonStyleButton>()))
              .onPressed,
          isNull);
    });

    testWidgets('操作を送っている間は、日と場面の編集のボタンも押せない', (tester) async {
      // 送っている間の扱いは §8.1 と同じ。全ケースは trip_timeline_test.dart の「操作を送っている間は…」で通している
      final semantics = tester.ensureSemantics();
      final backend = await _openTimeline(tester);
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

      reply.complete();
      await letFramesRun(tester);
      semantics.dispose();
    });
  });
}
