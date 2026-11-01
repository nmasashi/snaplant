import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../helpers/app_test_helpers.dart';
import '../helpers/trip_test_helpers.dart';

// 作っている間（完成版が無いとき）（docs/03_screen_design.md §8.2。段階5の 5-3a・5-6）。
// 状態ごとの表示（表の各行）と、失敗した下書きの「もう一度」「やめる」。確かめ待ち（`phase: "reviewing"`）の行は、
// 下書きを読み直して案ができたことを見る timeline_switch_test.dart（§8.1）のテストが確かめている。
// 入口は旅行詳細の「写真」「タイムライン」の切り替え。ワーカーが進んだこと（文を書き終えた・案を作れなかった）は、
// テストが偽のサーバのタイムラインを書き換えて表す

/// 旅行「北海道」の写真（撮影日時のある1枚）
List<Map<String, Object?>> _hokkaidoPhotos() => [
      photoJson(
          number: 1, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:01:00'),
    ];

/// 旅行詳細を開く（「写真」のまま）
Future<FakeTripBackend> _openTripDetail(WidgetTester tester,
    {int pendingPhotoCount = 0, Map<String, Object?>? timeline}) async {
  final backend = FakeTripBackend(
    trips: [hokkaidoTrip(photoCount: 1)],
    functionKey: 'test-key',
    photosByTripId: {hokkaidoTripId: _hokkaidoPhotos()},
  );
  backend.pendingPhotoCountByTripId[hokkaidoTripId] = pendingPhotoCount;
  if (timeline != null) backend.timelinesByTripId[hokkaidoTripId] = timeline;
  // 1つのテストの中で開き直すとき、前のアプリの木を残さない
  await tester.pumpWidget(const SizedBox());
  await openTripsTab(tester, backend);
  await tester.tap(find.text('北海道 2026秋'));
  await letFramesRun(tester);
  return backend;
}

/// 「タイムライン」に切り替える
Future<void> _showTimeline(WidgetTester tester) async {
  await tester.tap(find.text('タイムライン'));
  await letFramesRun(tester);
}

/// 下書きの状態（05 §5.15 の `draft`）。[step] を省くと `job: null`（確かめ待ち）
Map<String, Object?> _draft(String phase,
        {String? step, String state = 'pending', String? lastError}) =>
    {
      'id': '0b8e1c5a-0000-4000-8000-000000000099',
      'reason': 'create',
      'phase': phase,
      'job': step == null
          ? null
          : {'step': step, 'state': state, 'lastError': lastError},
      'startedAt': '2026-10-25T09:00:00.000Z',
    };

/// 完成版（中身の表示は timeline_current_test.dart が見る。ここでは日の無い形で、完成版を出したことだけを見る）
const _current = {
  'writtenAt': '2026-10-25T09:10:00.000Z',
  'days': <Object?>[],
};

/// タイムライン（05 §5.15 の `timeline`）
Map<String, Object?> _timeline(
        {Map<String, Object?>? draft, Map<String, Object?>? current}) =>
    {
      'current': current,
      'draft': draft,
      'changes': current == null ? null : {'added': 0, 'removed': 0},
    };

/// 偽のサーバの下書き
Map<String, Object?>? _draftOf(FakeTripBackend backend) =>
    backend.timelinesByTripId[hokkaidoTripId]?['draft']
        as Map<String, Object?>?;

/// 下書きを読み直す間隔（5 秒）だけ時間を進め、届いた応答を画面に出す
Future<void> _waitForPoll(WidgetTester tester) async {
  await tester.pump(const Duration(seconds: 5));
  await letFramesRun(tester);
}

/// 文言が [label] のボタン（押せるかを見る）
ButtonStyleButton _button(WidgetTester tester, String label) =>
    tester.widget<ButtonStyleButton>(find.ancestor(
        of: find.text(label), matching: find.bySubtype<ButtonStyleButton>()));

void main() {
  group('タイムラインがまだ無いとき', () {
    testWidgets('解析中の写真があれば、案内と押せない「タイムラインを作る」と、残りの枚数を出す', (tester) async {
      await _openTripDetail(tester, pendingPhotoCount: 3);

      await _showTimeline(tester);
      expect(find.text('タイムラインはまだありません'), findsOneWidget);
      expect(find.text('写真を送り終えたら、日ごと・食事ごとにまとめたタイムラインを作れます。'), findsOneWidget);
      expect(_button(tester, 'タイムラインを作る').onPressed, isNull);
      expect(find.text('解析中の写真があと 3 枚あります。終わると作れます。'), findsOneWidget);
    });

    testWidgets('解析中の写真が無ければ、「タイムラインを作る」を押せ、残りの枚数を出さない', (tester) async {
      await _openTripDetail(tester);

      await _showTimeline(tester);
      expect(_button(tester, 'タイムラインを作る').onPressed, isNotNull);
      expect(find.textContaining('解析中の写真があと'), findsNothing);
    });
  });

  group('タイムラインを作っている間', () {
    testWidgets('「タイムラインを作る」を押すと作り始め、タイムラインの案を作っていることと待ち時間の見込みを出し、「やめる」は出さない',
        (tester) async {
      final backend = await _openTripDetail(tester);
      await _showTimeline(tester);

      await tester.tap(find.text('タイムラインを作る'));
      await letFramesRun(tester);
      expect(_draftOf(backend)?['phase'], 'proposing');
      expect(find.text('タイムラインの案を作っています'), findsOneWidget);
      expect(find.text('ふつうは1分ほどで終わります。混んでいると10分ほどかかることがあります。この画面を閉じても続きます。'),
          findsOneWidget);
      expect(find.text('やめる'), findsNothing);
      expect(find.text('タイムラインはまだありません'), findsNothing);
    });

    testWidgets('文を書いている間は、3つの段と「見出しとまとめを書いています」・待ち時間の見込みを出し、書き終えたら読み直して完成版を出す',
        (tester) async {
      final backend = await _openTripDetail(tester,
          timeline: _timeline(draft: _draft('writing', step: 'write')));
      await _showTimeline(tester);
      expect(find.text('見出しとまとめを書いています'), findsOneWidget);
      expect(find.text('ふつうは1分ほどで終わります。この画面を閉じても続きます。'), findsOneWidget);
      for (final step in ['タイムラインの案', '案の確認', '見出しとまとめ']) {
        expect(find.text(step), findsOneWidget);
      }
      // 済んだ2つ（タイムラインの案・案の確認）に印
      expect(find.byIcon(Icons.check_circle), findsNWidgets(2));

      // 書き終えると、下書きが完成版に入れ替わる（06 §8.3）
      backend.timelinesByTripId[hokkaidoTripId] = _timeline(current: _current);
      await _waitForPoll(tester);
      expect(find.text('見出しとまとめを書いています'), findsNothing);
      expect(find.textContaining('に作成'), findsOneWidget);
    });

    testWidgets(
        '案を作っている間に失敗したら、「タイムラインの案を作れませんでした」と「もう一度」「やめる」を出し、「もう一度」で作り直す',
        (tester) async {
      final backend = await _openTripDetail(tester,
          timeline: _timeline(draft: _draft('proposing', step: 'propose')));
      await _showTimeline(tester);

      backend.timelinesByTripId[hokkaidoTripId] = _timeline(
          draft: _draft('proposing',
              step: 'propose', state: 'failed', lastError: 'ai'));
      await _waitForPoll(tester);
      expect(find.text('タイムラインの案を作れませんでした'), findsOneWidget);
      expect(find.text('タイムラインの案を作っています'), findsNothing);
      expect(find.text('やめる'), findsOneWidget);

      await tester.tap(find.text('もう一度'));
      await letFramesRun(tester);
      expect(_draftOf(backend)?['job'], containsPair('state', 'pending'));
      expect(find.text('タイムラインの案を作っています'), findsOneWidget);
    });

    testWidgets(
        '見出しとまとめを書けなかったら「見出しとまとめを書けませんでした」と「もう一度」「案を確認する」「やめる」を出し、「もう一度」で書き直す',
        (tester) async {
      final backend = await _openTripDetail(tester,
          timeline: _timeline(
              draft: _draft('writing',
                  step: 'write', state: 'failed', lastError: 'ai')));
      await _showTimeline(tester);
      expect(find.text('見出しとまとめを書けませんでした'), findsOneWidget);
      expect(find.text('案を確認する'), findsOneWidget);
      expect(find.text('やめる'), findsOneWidget);

      await tester.tap(find.text('もう一度'));
      await letFramesRun(tester);
      expect(_draftOf(backend)?['job'],
          {'step': 'write', 'state': 'pending', 'lastError': null});
      expect(find.text('見出しとまとめを書いています'), findsOneWidget);
    });

    // 撮影日時のある写真を全部消した後などは「もう一度」が通らないので、失敗した下書きから抜けられるようにする（02 §5 #58）。
    // 案の失敗と文の失敗の両方で、同じ規則を通す（行ごとにアプリを開き直すので、状態を持ち越さない）
    for (final (name, draft, title) in [
      ('案', _draft('proposing', step: 'propose', state: 'failed', lastError: 'ai'), 'タイムラインの案を作れませんでした'),
      ('見出しとまとめ', _draft('writing', step: 'write', state: 'failed', lastError: 'ai'), '見出しとまとめを書けませんでした'),
    ]) {
      testWidgets(
          '失敗した下書き（$name）の「やめる」は、確認で「キャンセル」なら何もせず、「捨てる」なら下書きを捨てて「タイムラインはまだありません」に戻る',
          (tester) async {
        final backend = await _openTripDetail(tester, timeline: _timeline(draft: draft));
        await _showTimeline(tester);

        await tester.tap(find.text('やめる'));
        await letFramesRun(tester);
        expect(find.text('作りかけのタイムラインを捨てますか？'), findsOneWidget);
        await tapInDialog(tester, 'キャンセル');
        expect(_draftOf(backend), isNotNull);
        expect(find.text(title), findsOneWidget);

        await tester.tap(find.text('やめる'));
        await letFramesRun(tester);
        await tapInDialog(tester, '捨てる');

        expect(_draftOf(backend), isNull);
        expect(find.text('タイムラインはまだありません'), findsOneWidget);
      });
    }

    testWidgets('完成版が残っている作り直しの下書き（5-6b より前に始めたもの）の失敗の「やめる」で捨てると、残っている完成版に戻る',
        (tester) async {
      final backend = await _openTripDetail(tester,
          timeline: _timeline(current: _current, draft: {
            ..._draft('proposing', step: 'propose', state: 'failed', lastError: 'ai'),
            'reason': 'rebuild',
          }));
      await _showTimeline(tester);
      expect(find.text('タイムラインの案を作れませんでした'), findsOneWidget);

      await tester.tap(find.text('やめる'));
      await letFramesRun(tester);
      await tapInDialog(tester, '捨てる');

      expect(_draftOf(backend), isNull);
      expect(find.textContaining('に作成'), findsOneWidget);
      expect(find.text('タイムラインはまだありません'), findsNothing);
    });

    testWidgets('作り直しの下書き（rebuild。完成版が残っている）があれば、完成版があっても作っている間の表示にする',
        (tester) async {
      await _openTripDetail(tester,
          timeline: _timeline(
              current: _current,
              draft: {
                ..._draft('proposing', step: 'propose'),
                'reason': 'rebuild'
              }));
      await _showTimeline(tester);
      expect(find.text('タイムラインの案を作っています'), findsOneWidget);
      expect(find.textContaining('に作成'), findsNothing);
    });
  });
}
