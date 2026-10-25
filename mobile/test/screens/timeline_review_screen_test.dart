import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../helpers/app_test_helpers.dart';
import '../helpers/trip_test_helpers.dart';

// 区切りの確認画面（docs/03_screen_design.md §8.4。段階5の 5-3b）。
// 入口は旅行詳細の「タイムライン」の「区切りを確認する」。区切りの保存は偽のサーバが本物と同じ決まりで場面を組み直す

/// 1日目（10月5日）の朝ごはん（2枚）と小樽（2枚）、2日目（10月6日）の札幌（1枚）、日時なし（1枚）
final _photos = {
  1: timelinePhotoJson(1, '2026-10-05T07:50:00',
      category: 'food', name: '海鮮丼', placeName: '北海道千歳市'),
  2: timelinePhotoJson(2, '2026-10-05T07:58:00',
      category: 'food', name: '海鮮丼', placeName: '北海道千歳市'),
  3: timelinePhotoJson(3, '2026-10-05T10:10:00',
      name: '小樽運河', placeName: '北海道小樽市'),
  4: timelinePhotoJson(4, '2026-10-05T11:40:00', placeName: '北海道小樽市'),
  5: timelinePhotoJson(5, '2026-10-06T09:10:00', placeName: '北海道札幌市'),
  6: timelinePhotoJson(6, null, category: 'other'),
};

/// 区切りを確かめられる下書き（既定は確かめ待ち）。[scenes] は日ごとの場面の写真の番号
Map<String, Object?> _reviewingDraft({
  String reason = 'create',
  String phase = 'reviewing',
  Map<String, Object?>? job,
  List<List<List<int>>> scenes = const [
    [
      [1, 2],
      [3, 4]
    ],
    [
      [5]
    ],
  ],
}) =>
    {
      'id': '0b8e1c5a-0000-4000-8000-000000000099',
      'reason': reason,
      'phase': phase,
      'job': job,
      'startedAt': '2026-10-25T09:00:00.000Z',
      'days': [
        for (final (index, day) in scenes.indexed)
          {
            'date': ['2026-10-05', '2026-10-06'][index],
            'dayNumber': index + 1,
            'scenes': [
              for (final (sceneIndex, numbers) in day.indexed)
                timelineSceneJson([for (final n in numbers) _photos[n]!],
                    startedBy: sceneIndex == 0 ? 'day' : 'ai'),
            ],
          },
      ],
      'undatedPhotos': [_photos[6]],
    };

/// 文を書くのに失敗した下書き
Map<String, Object?> _writeFailedDraft() => _reviewingDraft(
    phase: 'writing',
    job: {'step': 'write', 'state': 'failed', 'lastError': 'ai'});

/// タイムライン（完成版は無い）
Map<String, Object?> _timelineOf(Map<String, Object?>? draft) => {
      'current': null,
      'draft': draft,
      'changes': null,
      'droppedEdits': <Object?>[],
    };

/// 旅行詳細の「タイムライン」を開く
Future<FakeTripBackend> _openTimeline(WidgetTester tester,
    {Map<String, Object?>? draft}) async {
  final backend = FakeTripBackend(
    trips: [hokkaidoTrip(photoCount: 6)],
    functionKey: 'test-key',
    photosByTripId: {hokkaidoTripId: []},
  );
  backend.timelinesByTripId[hokkaidoTripId] =
      _timelineOf(draft ?? _reviewingDraft());
  await openTripsTab(tester, backend);
  await tester.tap(find.text('北海道 2026秋'));
  await letFramesRun(tester);
  await tester.tap(find.text('タイムライン'));
  await letFramesRun(tester);
  return backend;
}

/// 「区切りを確認する」で区切りの確認画面を開く
Future<void> _openReview(WidgetTester tester) async {
  await tester.tap(find.text('区切りを確認する'));
  await letFramesRun(tester);
}

void main() {
  group('区切りの確認画面を開く', () {
    testWidgets('確かめ待ちの「区切りを確認する」で開き、説明・日ごとの見出し・場面のカード・日時なし・見出しを付けるボタンを出す',
        (tester) async {
      final semantics = tester.ensureSemantics();
      await _openTimeline(tester);
      expect(find.text('区切りの案ができました'), findsOneWidget);

      await _openReview(tester);
      expect(find.text('区切りを確認'), findsOneWidget);
      expect(
          find.text(
              'AI が写真を場面に区切りました。写真を長押しすると『ここで区切る』、場面の境目の『つなげる』で前の場面とまとめられます。'),
          findsOneWidget);
      expect(find.text('1日目'), findsOneWidget);
      expect(find.text('10月5日（月）'), findsOneWidget);
      expect(find.text('2日目'), findsOneWidget);
      expect(find.text('10月6日（火）'), findsOneWidget);
      expect(find.text('7:50〜7:58 · 北海道千歳市 · 2枚'), findsOneWidget);
      expect(find.text('10:10〜11:40 · 北海道小樽市 · 2枚'), findsOneWidget);
      expect(photoThumbnail('2026年10月5日 07:58'), findsOneWidget);

      await tester.scrollUntilVisible(find.text('日時なし'), 200);
      await tester.pump();
      expect(find.text('9:10 · 北海道札幌市 · 1枚'), findsOneWidget);
      expect(photoThumbnail('撮影日時なし'), findsOneWidget);
      // 写真のある日は2日、場面は3つ
      expect(find.text('この区切りで見出しを付ける'), findsOneWidget);
      expect(find.text('2日で 3 場面 · 見出しと一言は AI が書きます'), findsOneWidget);
      semantics.dispose();
    });

    testWidgets('場面の境目の「つなげる」は同じ日の場面の間にだけ置き、日の境目には置かない', (tester) async {
      await _openTimeline(tester);
      await _openReview(tester);

      expect(find.text('つなげる'), findsOneWidget);
    });

    testWidgets('区切りの直しの下書きでは、説明を「写真を長押しすると…」から出す', (tester) async {
      await _openTimeline(tester, draft: _reviewingDraft(reason: 'recut'));
      await _openReview(tester);

      expect(find.text('写真を長押しすると『ここで区切る』、場面の境目の『つなげる』で前の場面とまとめられます。'),
          findsOneWidget);
    });

    testWidgets('見出しと一言を書けなかった下書きにも「区切りを確認する」を出し、区切りの確認画面を開ける', (tester) async {
      await _openTimeline(tester, draft: _writeFailedDraft());
      expect(find.text('見出しと一言を書けませんでした'), findsOneWidget);

      await _openReview(tester);
      expect(find.text('区切りを確認'), findsOneWidget);
      expect(find.text('7:50〜7:58 · 北海道千歳市 · 2枚'), findsOneWidget);
    });

    testWidgets('読み込んでいる間は「区切りを読み込み中...」を出す', (tester) async {
      final backend = await _openTimeline(tester);
      final hold = backend.holdNextReply(TripRoute.timelineDraft);

      await _openReview(tester);
      expect(find.text('区切りを読み込み中...'), findsOneWidget);

      hold.complete();
      await letFramesRun(tester);
      expect(find.text('区切りを読み込み中...'), findsNothing);
      expect(find.text('1日目'), findsOneWidget);
    });

    testWidgets('読み込みに失敗したら「エラーが発生しました」とエラーの文言・「再試行」を出し、「再試行」で読み直す',
        (tester) async {
      final backend = await _openTimeline(tester);
      backend.failNext(TripRoute.timelineDraft);

      await _openReview(tester);
      expect(find.text('エラーが発生しました'), findsOneWidget);
      expect(find.text('サービスに一時的に接続できません。しばらく待ってから再試行してください。'), findsOneWidget);

      await tester.tap(find.text('再試行'));
      await letFramesRun(tester);
      expect(find.text('エラーが発生しました'), findsNothing);
      expect(find.text('1日目'), findsOneWidget);
    });

    testWidgets('開いたときに下書きが確かめられる状態でなくなっていたら、知らせて旅行詳細に戻り、タイムラインを読み直す',
        (tester) async {
      final backend = await _openTimeline(tester);
      // 別の端末が区切り案を出し直した
      backend.timelinesByTripId[hokkaidoTripId] = _timelineOf({
        ..._reviewingDraft(),
        'phase': 'proposing',
        'job': {'step': 'propose', 'state': 'pending', 'lastError': null},
      });

      await _openReview(tester);
      expect(find.text('タイムラインが変わりました。読み直しました'), findsOneWidget);
      expect(find.text('区切りを確認'), findsNothing);
      expect(find.text('区切りの案を作っています'), findsOneWidget);
    });

    testWidgets('開いたときに旅行が別の端末で消されていたら、旅行詳細に戻って「この旅行は削除されています」を出す',
        (tester) async {
      final backend = await _openTimeline(tester);
      backend.trips.clear();

      await _openReview(tester);
      expect(find.text('区切りを確認'), findsNothing);
      expect(find.text('この旅行は削除されています'), findsOneWidget);
    });

    testWidgets('「×」で旅行詳細に戻ると、タイムラインを読み直す', (tester) async {
      final backend = await _openTimeline(tester);
      await _openReview(tester);
      // 確かめている間に、別の端末が下書きをやめた
      backend.timelinesByTripId.remove(hokkaidoTripId);

      await tester.tap(find.byIcon(Icons.close));
      await letFramesRun(tester);
      expect(find.text('区切りを確認'), findsNothing);
      expect(find.text('タイムラインはまだありません'), findsOneWidget);
    });
  });
}
