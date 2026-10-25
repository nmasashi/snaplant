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
    {Map<String, Object?>? draft, int pendingPhotoCount = 0}) async {
  final backend = FakeTripBackend(
    trips: [hokkaidoTrip(photoCount: 10)],
    functionKey: 'test-key',
    photosByTripId: {hokkaidoTripId: []},
  );
  backend.timelinesByTripId[hokkaidoTripId] = _timelineOf(draft: draft);
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
        '作り直しで区切りの案を作っている',
        draftOf('rebuild', 'proposing', step: 'propose'),
        ['作り直しの区切りの案を作っています', 'やめる']
      ),
      (
        '作り直しの確かめ待ち',
        draftOf('rebuild', 'reviewing'),
        ['作り直しの区切りの案ができました', '区切りを確認する', 'やめる']
      ),
      (
        '区切りの直しの途中',
        draftOf('recut', 'reviewing'),
        ['区切りを直している途中です', '続ける', 'やめる']
      ),
      (
        '文を書き直している',
        draftOf('rebuild', 'writing', step: 'write'),
        ['見出しと一言を書き直しています']
      ),
      (
        '作り直しの区切りの案を作れなかった',
        draftOf('rebuild', 'proposing', step: 'propose', state: 'failed'),
        ['作り直しの区切りの案を作れませんでした', 'もう一度', 'やめる']
      ),
      (
        '文を書き直せなかった',
        draftOf('recut', 'writing', step: 'write', state: 'failed'),
        ['見出しと一言を書き直せませんでした', 'もう一度', '区切りを確認する', 'やめる']
      ),
    ]) {
      testWidgets('$labelときは、完成版を出したまま上に案内を出し、「区切りを直す」「作り直す」を出さない',
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

    testWidgets('「作り直す」のダイアログで「キャンセル」を押すと、何もしない', (tester) async {
      final backend = await _openTimeline(tester);

      await tester.tap(find.text('作り直す'));
      await letFramesRun(tester);
      await tapInDialog(tester, 'キャンセル');

      expect(backend.timelinesByTripId[hokkaidoTripId]!['draft'], isNull);
      expect(find.text('作り直す'), findsOneWidget);
    });
  });
}
