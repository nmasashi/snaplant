import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../helpers/app_test_helpers.dart';
import '../helpers/trip_test_helpers.dart';

// 旅行詳細のタイムライン（docs/03_screen_design.md §8.1・§8.2。段階5の 5-3a）。
// 入口は旅行詳細の「写真」「タイムライン」の切り替え。ワーカーが進んだこと（区切り案ができた・文を書き終えた）は、
// テストが偽のサーバのタイムラインを書き換えて表す

/// 旅行「北海道」の写真（撮影日時のある1枚。長押しで選択モードに入るのに使う）
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

/// 完成版（中身は 5-4 で出す。5-3a では有る・無いだけを見る。完成版だけのときの「タイムラインができました」は、5-4 で §8.3 の表示に置き換える仮の案内）
const _current = {
  'writtenAt': '2026-10-25T09:10:00.000Z',
  'days': <Object?>[],
  'undatedPhotos': <Object?>[],
};

/// タイムライン（05 §5.15 の `timeline`）
Map<String, Object?> _timeline(
        {Map<String, Object?>? draft, Map<String, Object?>? current}) =>
    {
      'current': current,
      'draft': draft,
      'changes': current == null ? null : {'added': 0, 'removed': 0},
      'droppedEdits': <Object?>[],
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

/// カテゴリのチップ
Finder _chip(String label) => find.widgetWithText(ChoiceChip, label);

/// 文言が [label] のボタン（押せるかを見る）
ButtonStyleButton _button(WidgetTester tester, String label) =>
    tester.widget<ButtonStyleButton>(find.ancestor(
        of: find.text(label), matching: find.bySubtype<ButtonStyleButton>()));

void main() {
  group('旅行詳細の「写真」「タイムライン」の切り替え', () {
    testWidgets('既定は「写真」でチップと「写真を追加」を出し、「タイムライン」ではどちらも出さず、旅行詳細を開き直すと「写真」に戻る',
        (tester) async {
      final semantics = tester.ensureSemantics();
      await _openTripDetail(tester);

      expect(find.text('写真'), findsOneWidget);
      expect(find.text('タイムライン'), findsOneWidget);
      expect(_chip('すべて'), findsOneWidget);
      expect(find.text('写真を追加'), findsOneWidget);
      expect(photoThumbnail('2026年10月5日 10:01'), findsOneWidget);

      await _showTimeline(tester);
      expect(_chip('すべて'), findsNothing);
      expect(find.text('写真を追加'), findsNothing);
      expect(photoThumbnail('2026年10月5日 10:01'), findsNothing);
      expect(find.text('タイムラインはまだありません'), findsOneWidget);

      await tester.pageBack();
      await letFramesRun(tester);
      await tester.tap(find.text('北海道 2026秋'));
      await letFramesRun(tester);
      expect(_chip('すべて'), findsOneWidget);
      expect(find.text('タイムラインはまだありません'), findsNothing);
      semantics.dispose();
    });

    testWidgets('写真を複数選択している間は、切り替えを出さない', (tester) async {
      final semantics = tester.ensureSemantics();
      await _openTripDetail(tester);
      expect(find.text('タイムライン'), findsOneWidget);

      await tester.longPress(photoThumbnail('2026年10月5日 10:01'));
      await letFramesRun(tester);
      expect(find.text('1枚を選択中'), findsOneWidget);
      expect(find.text('タイムライン'), findsNothing);
      semantics.dispose();
    });
  });

  group('タイムラインの読み込み', () {
    testWidgets('読み込んでいる間は「タイムラインを読み込み中...」を出す', (tester) async {
      final backend = await _openTripDetail(tester);
      final hold = backend.holdNextReply(TripRoute.timeline);

      await _showTimeline(tester);
      expect(find.text('タイムラインを読み込み中...'), findsOneWidget);

      hold.complete();
      await letFramesRun(tester);
      expect(find.text('タイムラインを読み込み中...'), findsNothing);
      expect(find.text('タイムラインはまだありません'), findsOneWidget);
    });

    testWidgets('読み込みに失敗したら「エラーが発生しました」とエラーの文言・「再試行」を出し、「再試行」で読み直す',
        (tester) async {
      final backend = await _openTripDetail(tester);
      backend.failNext(TripRoute.timeline);

      await _showTimeline(tester);
      expect(find.text('エラーが発生しました'), findsOneWidget);
      expect(find.text('サービスに一時的に接続できません。しばらく待ってから再試行してください。'), findsOneWidget);

      // 読み直している間は、エラーの表示を残さず読み込み中にする
      final hold = backend.holdNextReply(TripRoute.timeline);
      await tester.tap(find.text('再試行'));
      await letFramesRun(tester);
      expect(find.text('タイムラインを読み込み中...'), findsOneWidget);
      expect(find.text('エラーが発生しました'), findsNothing);

      hold.complete();
      await letFramesRun(tester);
      expect(find.text('タイムラインはまだありません'), findsOneWidget);
    });

    testWidgets('旅行が別の端末で消されていたら、「この旅行は削除されています」を出す', (tester) async {
      final backend = await _openTripDetail(tester);
      backend.trips.clear();

      await _showTimeline(tester);
      expect(find.text('この旅行は削除されています'), findsOneWidget);
      expect(find.text('エラーが発生しました'), findsNothing);
    });
  });

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
    testWidgets('「タイムラインを作る」を押すと作り始め、区切りの案を作っていることと「やめる」を出す', (tester) async {
      final backend = await _openTripDetail(tester);
      await _showTimeline(tester);

      await tester.tap(find.text('タイムラインを作る'));
      await letFramesRun(tester);
      expect(_draftOf(backend)?['phase'], 'proposing');
      expect(find.text('区切りの案を作っています'), findsOneWidget);
      expect(find.text('この画面を閉じても続きます。'), findsOneWidget);
      expect(find.text('やめる'), findsOneWidget);
      expect(find.text('タイムラインはまだありません'), findsNothing);
    });

    testWidgets('作っている間は 5 秒ごとに下書きを読み直し、区切りの案ができたら「区切りの案ができました」を出す',
        (tester) async {
      final backend = await _openTripDetail(tester,
          timeline: _timeline(draft: _draft('proposing', step: 'propose')));
      await _showTimeline(tester);
      expect(find.text('区切りの案を作っています'), findsOneWidget);
      expect(backend.timelineDraftReadsReceived, 0);

      await _waitForPoll(tester);
      expect(backend.timelineDraftReadsReceived, 1);
      // ワーカーが拾った（待ち → 処理中）だけでは表示は変わらない
      backend.timelinesByTripId[hokkaidoTripId] = _timeline(
          draft: _draft('proposing', step: 'propose', state: 'running'));
      await _waitForPoll(tester);
      expect(backend.timelineDraftReadsReceived, 2);
      expect(find.text('区切りの案を作っています'), findsOneWidget);

      backend.timelinesByTripId[hokkaidoTripId] =
          _timeline(draft: _draft('reviewing'));
      await _waitForPoll(tester);
      expect(find.text('区切りの案ができました'), findsOneWidget);
      expect(find.text('やめる'), findsOneWidget);
      expect(find.text('区切りの案を作っています'), findsNothing);
    });

    testWidgets('区切りの案ができたら、下書きの読み直しをやめる', (tester) async {
      final backend = await _openTripDetail(tester,
          timeline: _timeline(draft: _draft('proposing', step: 'propose')));
      await _showTimeline(tester);
      backend.timelinesByTripId[hokkaidoTripId] =
          _timeline(draft: _draft('reviewing'));
      await _waitForPoll(tester);
      expect(find.text('区切りの案ができました'), findsOneWidget);

      final reads = backend.timelineDraftReadsReceived;
      await _waitForPoll(tester);
      await _waitForPoll(tester);
      expect(backend.timelineDraftReadsReceived, reads);
    });

    testWidgets('作っている間の読み直しで旅行が消えていたと分かったら、「この旅行は削除されています」を出す',
        (tester) async {
      final backend = await _openTripDetail(tester,
          timeline: _timeline(draft: _draft('proposing', step: 'propose')));
      await _showTimeline(tester);
      backend.trips.clear();

      await _waitForPoll(tester);
      expect(find.text('この旅行は削除されています'), findsOneWidget);
    });

    testWidgets('下書きの読み直しに失敗しても表示は変えず、5 秒後にもう一度読む', (tester) async {
      final backend = await _openTripDetail(tester,
          timeline: _timeline(draft: _draft('proposing', step: 'propose')));
      await _showTimeline(tester);
      backend.failNext(TripRoute.timelineDraft);

      await _waitForPoll(tester);
      // 失敗を使い切った印
      expect(backend.timelineDraftReadsReceived, 1);
      expect(find.text('区切りの案を作っています'), findsOneWidget);
      expect(find.text('エラーが発生しました'), findsNothing);

      backend.timelinesByTripId[hokkaidoTripId] =
          _timeline(draft: _draft('reviewing'));
      await _waitForPoll(tester);
      expect(find.text('区切りの案ができました'), findsOneWidget);
    });

    for (final (label, failsRead) in [('届いた', false), ('失敗して届いた', true)]) {
      testWidgets('読み直しの応答を待つ間に「やめる」で表示が替わったら、遅れて$label応答で作っている表示に戻さない',
          (tester) async {
        final backend = await _openTripDetail(tester,
            timeline: _timeline(draft: _draft('proposing', step: 'propose')));
        await _showTimeline(tester);
        // 応答の中身は届いた時点（まだ作っている途中）で決まる
        if (failsRead) backend.failNext(TripRoute.timelineDraft);
        final hold = backend.holdNextReply(TripRoute.timelineDraft);
        await _waitForPoll(tester);

        await tester.tap(find.text('やめる'));
        await letFramesRun(tester);
        await tapInDialog(tester, '捨てる');
        expect(find.text('タイムラインはまだありません'), findsOneWidget);

        hold.complete();
        await letFramesRun(tester);
        expect(find.text('タイムラインはまだありません'), findsOneWidget);
        expect(find.text('区切りの案を作っています'), findsNothing);
      });
    }

    testWidgets('区切りの案ができて読み直したタイムラインが読めなくても、表示は変えず、5 秒後にもう一度読む',
        (tester) async {
      final backend = await _openTripDetail(tester,
          timeline: _timeline(draft: _draft('proposing', step: 'propose')));
      await _showTimeline(tester);
      backend.timelinesByTripId[hokkaidoTripId] =
          _timeline(draft: _draft('reviewing'));
      backend.failNext(TripRoute.timeline);

      await _waitForPoll(tester);
      expect(find.text('エラーが発生しました'), findsNothing);
      expect(find.text('区切りの案を作っています'), findsOneWidget);

      await _waitForPoll(tester);
      expect(find.text('区切りの案ができました'), findsOneWidget);
    });

    testWidgets('読み直したタイムラインの応答を待つ間に「捨てる」で読み直したら、遅れて届いた先の応答で表示を戻さない',
        (tester) async {
      final backend = await _openTripDetail(tester,
          timeline: _timeline(draft: _draft('proposing', step: 'propose')));
      await _showTimeline(tester);
      // 区切りの案ができ、読み直しの GET …/timeline を止める（応答の中身は届いた時点の「確かめ待ち」で決まる）
      backend.timelinesByTripId[hokkaidoTripId] =
          _timeline(draft: _draft('reviewing'));
      final hold = backend.holdNextReply(TripRoute.timeline);
      await _waitForPoll(tester);

      await tester.tap(find.text('やめる'));
      await letFramesRun(tester);
      await tapInDialog(tester, '捨てる');
      expect(find.text('タイムラインはまだありません'), findsOneWidget);

      hold.complete();
      await letFramesRun(tester);
      expect(find.text('タイムラインはまだありません'), findsOneWidget);
      expect(find.text('区切りの案ができました'), findsNothing);
    });

    testWidgets('読み直しの応答を待つ間に「捨てる」を押したら、遅れて届いた応答が段の変化を伝えても、捨てた下書きを出さない',
        (tester) async {
      final backend = await _openTripDetail(tester,
          timeline: _timeline(draft: _draft('proposing', step: 'propose')));
      await _showTimeline(tester);
      // 読み直しの応答は「確かめ待ち」で決まり、届くのを止める
      backend.timelinesByTripId[hokkaidoTripId] =
          _timeline(draft: _draft('reviewing'));
      final draftHold = backend.holdNextReply(TripRoute.timelineDraft);
      await _waitForPoll(tester);

      // 「捨てる」の後の読み直し（何も無い）も、届くのを止める
      final reloadHold = backend.holdNextReply(TripRoute.timeline);
      await tester.tap(find.text('やめる'));
      await letFramesRun(tester);
      await tapInDialog(tester, '捨てる');
      // 遅れて届いた読み直しが続けて読むタイムラインは、読めない
      backend.failNext(TripRoute.timeline);
      draftHold.complete();
      await letFramesRun(tester);
      reloadHold.complete();
      await letFramesRun(tester);

      expect(find.text('タイムラインはまだありません'), findsOneWidget);
      expect(find.text('区切りの案を作っています'), findsNothing);
    });

    testWidgets('操作の後の読み直しに失敗してエラーを出したら、遅れて届いた下書きの読み直しでエラーを消さない',
        (tester) async {
      final backend = await _openTripDetail(tester,
          timeline: _timeline(draft: _draft('proposing', step: 'propose')));
      await _showTimeline(tester);
      final draftHold = backend.holdNextReply(TripRoute.timelineDraft);
      await _waitForPoll(tester);

      backend.failNext(TripRoute.timelineDraftDelete,
          status: 409,
          code: 'TIMELINE_STATE_CONFLICT',
          message: 'タイムラインが変わったか、作っている途中です。読み直してください');
      backend.failNext(TripRoute.timeline);
      await tester.tap(find.text('やめる'));
      await letFramesRun(tester);
      await tapInDialog(tester, '捨てる');
      expect(find.text('エラーが発生しました'), findsOneWidget);

      draftHold.complete();
      await letFramesRun(tester);
      expect(find.text('エラーが発生しました'), findsOneWidget);
      expect(find.text('区切りの案を作っています'), findsNothing);
    });

    testWidgets('「写真」に戻すと、下書きの読み直しを止める', (tester) async {
      final backend = await _openTripDetail(tester,
          timeline: _timeline(draft: _draft('proposing', step: 'propose')));
      await _showTimeline(tester);
      await _waitForPoll(tester);
      expect(backend.timelineDraftReadsReceived, 1);

      await tester.tap(find.text('写真'));
      await letFramesRun(tester);
      await _waitForPoll(tester);
      await _waitForPoll(tester);
      expect(backend.timelineDraftReadsReceived, 1);
    });

    testWidgets('旅行詳細を閉じると、下書きの読み直しを止める', (tester) async {
      final backend = await _openTripDetail(tester,
          timeline: _timeline(draft: _draft('proposing', step: 'propose')));
      await _showTimeline(tester);
      await _waitForPoll(tester);
      expect(backend.timelineDraftReadsReceived, 1);

      await tester.pageBack();
      await letFramesRun(tester);
      await _waitForPoll(tester);
      await _waitForPoll(tester);
      expect(backend.timelineDraftReadsReceived, 1);
    });

    testWidgets('文を書いている間は、3つの段と「見出しと一言を書いています」を出し、書き終えたら読み直して完成版の仮の案内を出す',
        (tester) async {
      final backend = await _openTripDetail(tester,
          timeline: _timeline(draft: _draft('writing', step: 'write')));
      await _showTimeline(tester);
      expect(find.text('見出しと一言を書いています'), findsOneWidget);
      expect(find.text('この画面を閉じても続きます。'), findsOneWidget);
      for (final step in ['区切りの案', '区切りの確認', '見出しと一言']) {
        expect(find.text(step), findsOneWidget);
      }
      // 済んだ2つ（区切りの案・区切りの確認）に印
      expect(find.byIcon(Icons.check_circle), findsNWidgets(2));

      // 書き終えると、下書きが完成版に入れ替わる（06 §8.3）
      backend.timelinesByTripId[hokkaidoTripId] = _timeline(current: _current);
      await _waitForPoll(tester);
      expect(find.text('見出しと一言を書いています'), findsNothing);
      expect(find.text('タイムラインができました'), findsOneWidget);
    });

    testWidgets(
        '区切りの案を作っている間に失敗したら、「区切りの案を作れませんでした」と「もう一度」「やめる」を出し、「もう一度」で作り直す',
        (tester) async {
      final backend = await _openTripDetail(tester,
          timeline: _timeline(draft: _draft('proposing', step: 'propose')));
      await _showTimeline(tester);

      backend.timelinesByTripId[hokkaidoTripId] = _timeline(
          draft: _draft('proposing',
              step: 'propose', state: 'failed', lastError: 'ai'));
      await _waitForPoll(tester);
      expect(find.text('区切りの案を作れませんでした'), findsOneWidget);
      expect(find.text('区切りの案を作っています'), findsNothing);
      expect(find.text('やめる'), findsOneWidget);

      await tester.tap(find.text('もう一度'));
      await letFramesRun(tester);
      expect(_draftOf(backend)?['job'], containsPair('state', 'pending'));
      expect(find.text('区切りの案を作っています'), findsOneWidget);
    });

    testWidgets('見出しと一言を書けなかったら「見出しと一言を書けませんでした」と「もう一度」「やめる」を出し、「もう一度」で書き直す',
        (tester) async {
      final backend = await _openTripDetail(tester,
          timeline: _timeline(
              draft: _draft('writing',
                  step: 'write', state: 'failed', lastError: 'ai')));
      await _showTimeline(tester);
      expect(find.text('見出しと一言を書けませんでした'), findsOneWidget);
      expect(find.text('やめる'), findsOneWidget);

      await tester.tap(find.text('もう一度'));
      await letFramesRun(tester);
      expect(_draftOf(backend)?['job'],
          {'step': 'write', 'state': 'pending', 'lastError': null});
      expect(find.text('見出しと一言を書いています'), findsOneWidget);
    });
  });

  group('タイムラインの操作', () {
    testWidgets('「やめる」は確認のダイアログを出し、「捨てる」で下書きを消して読み直し、「キャンセル」なら何もしない',
        (tester) async {
      final backend = await _openTripDetail(tester,
          timeline: _timeline(draft: _draft('proposing', step: 'propose')));
      await _showTimeline(tester);

      await tester.tap(find.text('やめる'));
      await letFramesRun(tester);
      expect(inDialog(find.text('作りかけのタイムラインを捨てますか？')), findsOneWidget);
      await tapInDialog(tester, 'キャンセル');
      expect(_draftOf(backend), isNotNull);
      expect(find.text('区切りの案を作っています'), findsOneWidget);

      await tester.tap(find.text('やめる'));
      await letFramesRun(tester);
      await tapInDialog(tester, '捨てる');
      expect(backend.timelinesByTripId[hokkaidoTripId], isNull);
      expect(find.text('タイムラインはまだありません'), findsOneWidget);
      expect(find.text('区切りの案を作っています'), findsNothing);
    });

    testWidgets(
        '読んだ後に別の端末が作り始めていたら（409 TIMELINE_STATE_CONFLICT）、「タイムラインが変わりました。読み直しました」を出して読み直す',
        (tester) async {
      final backend = await _openTripDetail(tester);
      await _showTimeline(tester);
      backend.timelinesByTripId[hokkaidoTripId] =
          _timeline(draft: _draft('proposing', step: 'propose'));

      await tester.tap(find.text('タイムラインを作る'));
      await letFramesRun(tester);
      expect(find.text('タイムラインが変わりました。読み直しました'), findsOneWidget);
      expect(find.text('区切りの案を作っています'), findsOneWidget);
    });

    testWidgets(
        '読んだ後に別の端末が下書きをやめていたら（404 TIMELINE_NOT_FOUND）、「タイムラインが変わりました。読み直しました」を出して読み直す',
        (tester) async {
      final backend = await _openTripDetail(tester,
          timeline: _timeline(draft: _draft('reviewing')));
      await _showTimeline(tester);
      backend.timelinesByTripId.remove(hokkaidoTripId);

      await tester.tap(find.text('やめる'));
      await letFramesRun(tester);
      await tapInDialog(tester, '捨てる');
      expect(find.text('タイムラインが変わりました。読み直しました'), findsOneWidget);
      expect(find.text('タイムラインはまだありません'), findsOneWidget);
    });

    for (final (code, message) in [
      ('TIMELINE_PHOTOS_PROCESSING', '解析中の写真があります。終わってから作ってください'),
      ('TIMELINE_NO_DATED_PHOTOS', '撮影日時のある写真がありません'),
    ]) {
      testWidgets('作れなかったら（409 $code）、エラーの文言を出して読み直す', (tester) async {
        final backend = await _openTripDetail(tester);
        await _showTimeline(tester);
        // 読み直したことを、解析中の枚数が出ることで確かめる（受け付けを断られた後に写真が増えた想定）
        backend.pendingPhotoCountByTripId[hokkaidoTripId] = 2;
        backend.failNext(TripRoute.timelineCreate,
            status: 409, code: code, message: message);

        await tester.tap(find.text('タイムラインを作る'));
        await letFramesRun(tester);
        expect(find.text(message), findsOneWidget);
        expect(find.text('解析中の写真があと 2 枚あります。終わると作れます。'), findsOneWidget);
      });
    }

    testWidgets('操作で旅行が別の端末で消されていたと分かったら、「この旅行は削除されています」を出す', (tester) async {
      final backend = await _openTripDetail(tester);
      await _showTimeline(tester);
      backend.trips.clear();

      await tester.tap(find.text('タイムラインを作る'));
      await letFramesRun(tester);
      expect(find.text('この旅行は削除されています'), findsOneWidget);
    });

    testWidgets('操作がそれ以外の理由で失敗したら、エラーの文言を出し、表示はそのまま', (tester) async {
      final backend = await _openTripDetail(tester);
      await _showTimeline(tester);
      backend.failNext(TripRoute.timelineCreate);

      await tester.tap(find.text('タイムラインを作る'));
      await letFramesRun(tester);
      expect(find.text('サービスに一時的に接続できません。しばらく待ってから再試行してください。'), findsOneWidget);
      expect(find.text('タイムラインはまだありません'), findsOneWidget);
      expect(_button(tester, 'タイムラインを作る').onPressed, isNotNull);
    });

    testWidgets('「タイムラインを作る」を送っている間は、押せない', (tester) async {
      final backend = await _openTripDetail(tester);
      await _showTimeline(tester);
      final hold = backend.holdNextReply(TripRoute.timelineCreate);

      await tester.tap(find.text('タイムラインを作る'));
      await letFramesRun(tester);
      expect(_button(tester, 'タイムラインを作る').onPressed, isNull);

      hold.complete();
      await letFramesRun(tester);
      expect(find.text('区切りの案を作っています'), findsOneWidget);
    });

    testWidgets('操作を送っている間は、タイムラインの操作のボタンを押せない', (tester) async {
      final backend = await _openTripDetail(tester,
          timeline: _timeline(
              draft: _draft('proposing',
                  step: 'propose', state: 'failed', lastError: 'ai')));
      await _showTimeline(tester);
      final hold = backend.holdNextReply(TripRoute.timelineCreate);

      await tester.tap(find.text('もう一度'));
      await letFramesRun(tester);
      expect(_button(tester, 'もう一度').onPressed, isNull);
      expect(_button(tester, 'やめる').onPressed, isNull);

      hold.complete();
      await letFramesRun(tester);
      expect(find.text('区切りの案を作っています'), findsOneWidget);
      expect(_button(tester, 'やめる').onPressed, isNotNull);
    });
  });
}
