import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../helpers/app_test_helpers.dart';
import '../helpers/trip_test_helpers.dart';

// 区切りの確認画面（docs/03_screen_design.md §8.4。段階5の 5-3b）。
// 入口は旅行詳細の「タイムライン」の「案を確認する」。区切りの保存は偽のサーバが本物と同じ決まりで場面を組み直す

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
  // 地名の無い写真（2日目の昼）。地名の無い場面のテストでだけ使う
  7: timelinePhotoJson(7, '2026-10-06T12:00:00'),
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

/// 文言が [label] のボタン（押せるかを見る）
ButtonStyleButton _button(WidgetTester tester, String label) =>
    tester.widget<ButtonStyleButton>(find.ancestor(
        of: find.text(label), matching: find.bySubtype<ButtonStyleButton>()));

/// 「案を確認する」で案の確認画面を開く
Future<void> _openReview(WidgetTester tester) async {
  await tester.tap(find.text('案を確認する'));
  await letFramesRun(tester);
}

void main() {
  group('区切りの確認画面を開く', () {
    testWidgets(
        '確かめ待ちの「案を確認する」で開き、説明・日ごとの見出し・場面のカード・同じ日の場面の間の「つなげる」（日の境目には置かない）・日時なし・見出しを付けるボタンを出す',
        (tester) async {
      final semantics = tester.ensureSemantics();
      await _openTimeline(tester);
      expect(find.text('タイムラインの案ができました'), findsOneWidget);

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
      // 1日目の朝ごはんと小樽の間だけ。1日目と2日目の境目には置かない
      expect(find.text('つなげる'), findsOneWidget);

      // 場面のサムネイルの並びも Scrollable なので、送るのは画面のリストに限る
      await tester.scrollUntilVisible(find.text('日時なし'), 200,
          scrollable: find.byType(Scrollable).first);
      await tester.pump();
      expect(find.text('9:10 · 北海道札幌市 · 1枚'), findsOneWidget);
      expect(photoThumbnail('撮影日時なし'), findsOneWidget);
      // 写真のある日は2日、場面は3つ
      expect(find.text('この区切りで見出しを付ける'), findsOneWidget);
      expect(find.text('2日で 3 場面 · 見出しと一言は AI が書きます'), findsOneWidget);
      semantics.dispose();
    });

    testWidgets('区切りの直しの下書きでは、説明を「写真を長押しすると…」から出して足した場面とつなげた場面の文の扱いを添え、下のボタンを「この区切りで保存」にし（AI を使わない）、地名の無い場面はカードの上を「{時刻} · {N}枚」にする',
        (tester) async {
      await _openTimeline(tester,
          draft: _reviewingDraft(reason: 'recut', scenes: const [
            [
              [1, 2],
              [3, 4]
            ],
            [
              [5],
              [7]
            ],
          ]));
      await _openReview(tester);

      expect(
          find.text(
              '写真を長押しすると『ここで区切る』、場面の境目の『つなげる』で前の場面とまとめられます。新しくできた場面は見出しなしになります。つなげると、後ろの場面の見出しと一言は消えます。'),
          findsOneWidget);
      expect(find.text('この区切りで保存'), findsOneWidget);
      expect(find.text('2日で 4 場面 · 見出しと一言はそのまま残します'), findsOneWidget);
      expect(find.text('この区切りで見出しを付ける'), findsNothing);
      await tester.scrollUntilVisible(find.text('12:00 · 1枚'), 200,
          scrollable: find.byType(Scrollable).first);
      expect(find.text('12:00 · 1枚'), findsOneWidget);
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
      expect(find.text('タイムラインの案を作っています'), findsOneWidget);
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

  group('区切りを直す', () {
    /// 偽のサーバの下書きの、日ごとの場面の最初の写真の id
    List<List<String>> savedStarts(FakeTripBackend backend) {
      final draft = backend.timelinesByTripId[hokkaidoTripId]!['draft']
          as Map<String, Object?>;
      return [
        for (final day in draft['days'] as List)
          [
            for (final scene in (day as Map)['scenes'] as List)
              (scene as Map)['startPhotoId'] as String
          ]
      ];
    }

    /// 番号の写真の id
    String idOf(int number) => _photos[number]!['id'] as String;

    testWidgets('写真を長押しして「この写真から新しい場面」を選ぶと、そこで区切って保存し、応答で描き直す', (tester) async {
      final semantics = tester.ensureSemantics();
      final backend = await _openTimeline(tester);
      await _openReview(tester);

      await tester.longPress(photoThumbnail('2026年10月5日 07:58'));
      await letFramesRun(tester);
      await tester.tap(find.text('この写真から新しい場面'));
      await letFramesRun(tester);

      expect(savedStarts(backend), [
        [idOf(1), idOf(2), idOf(3)],
        [idOf(5)]
      ]);
      expect(find.text('7:50 · 北海道千歳市 · 1枚'), findsOneWidget);
      expect(find.text('7:58 · 北海道千歳市 · 1枚'), findsOneWidget);
      expect(find.text('つなげる'), findsNWidgets(2));
      semantics.dispose();
    });

    testWidgets('場面の最初の写真を長押ししても、「この写真から新しい場面」は出さない', (tester) async {
      final semantics = tester.ensureSemantics();
      await _openTimeline(tester);
      await _openReview(tester);

      await tester.longPress(photoThumbnail('2026年10月5日 07:50'));
      await letFramesRun(tester);
      expect(find.text('この写真から新しい場面'), findsNothing);
      semantics.dispose();
    });

    testWidgets('「つなげる」を押すと、前の場面とまとめて保存し、応答で描き直す', (tester) async {
      final backend = await _openTimeline(tester);
      await _openReview(tester);

      await tester.tap(find.text('つなげる'));
      await letFramesRun(tester);

      expect(savedStarts(backend), [
        [idOf(1)],
        [idOf(5)]
      ]);
      expect(find.text('7:50〜11:40 · 北海道千歳市、北海道小樽市 · 4枚'), findsOneWidget);
      expect(find.text('つなげる'), findsNothing);
    });

    testWidgets('保存している間は、ほかの操作（つなげる・長押し・メニュー・見出しを付ける）を受け付けない', (tester) async {
      final semantics = tester.ensureSemantics();
      final backend = await _openTimeline(tester);
      await _openReview(tester);
      final hold = backend.holdNextReply(TripRoute.timelineScenes);

      await tester.tap(find.text('つなげる'));
      await letFramesRun(tester);
      expect(_button(tester, 'つなげる').onPressed, isNull);
      expect(_button(tester, 'この区切りで見出しを付ける').onPressed, isNull);
      await tester.longPress(photoThumbnail('2026年10月5日 07:58'));
      await letFramesRun(tester);
      expect(find.text('この写真から新しい場面'), findsNothing);
      await tester.tap(find.byIcon(Icons.more_vert));
      await letFramesRun(tester);
      expect(find.text('区切り案を出し直す'), findsNothing);

      hold.complete();
      await letFramesRun(tester);
      semantics.dispose();
    });

    testWidgets('保存に失敗したら、エラーの文言を出し、表示はそのまま', (tester) async {
      final backend = await _openTimeline(tester);
      await _openReview(tester);
      backend.failNext(TripRoute.timelineScenes);

      await tester.tap(find.text('つなげる'));
      await letFramesRun(tester);
      expect(find.text('サービスに一時的に接続できません。しばらく待ってから再試行してください。'), findsOneWidget);
      expect(find.text('7:50〜7:58 · 北海道千歳市 · 2枚'), findsOneWidget);
      expect(_button(tester, 'つなげる').onPressed, isNotNull);
    });

    testWidgets('保存のときに下書きが別の端末で変わっていたら（409）、知らせて旅行詳細に戻り、タイムラインを読み直す',
        (tester) async {
      final backend = await _openTimeline(tester);
      await _openReview(tester);
      // 別の端末が区切り案を出し直した
      backend.timelinesByTripId[hokkaidoTripId] = _timelineOf({
        ..._reviewingDraft(),
        'phase': 'proposing',
        'job': {'step': 'propose', 'state': 'pending', 'lastError': null},
      });

      await tester.tap(find.text('つなげる'));
      await letFramesRun(tester);
      expect(find.text('タイムラインが変わりました。読み直しました'), findsOneWidget);
      expect(find.text('区切りを確認'), findsNothing);
      expect(find.text('タイムラインの案を作っています'), findsOneWidget);
    });

    testWidgets('保存のときに旅行が別の端末で消されていたら、旅行詳細に戻って「この旅行は削除されています」を出す',
        (tester) async {
      final backend = await _openTimeline(tester);
      await _openReview(tester);
      backend.trips.clear();

      await tester.tap(find.text('つなげる'));
      await letFramesRun(tester);
      expect(find.text('区切りを確認'), findsNothing);
      expect(find.text('この旅行は削除されています'), findsOneWidget);
    });

    testWidgets('見出しと一言を書けなかった下書きでも「案を確認する」から区切りを直せ、戻ると旅行詳細が今の状態（確かめ待ち）を出す',
        (tester) async {
      await _openTimeline(tester, draft: _writeFailedDraft());
      expect(find.text('見出しと一言を書けませんでした'), findsOneWidget);

      await _openReview(tester);
      expect(find.text('区切りを確認'), findsOneWidget);
      expect(find.text('7:50〜7:58 · 北海道千歳市 · 2枚'), findsOneWidget);

      // 区切りを直すと確かめ待ちに戻るのはサーバの決まり（05 §5.15）
      await tester.tap(find.text('つなげる'));
      await letFramesRun(tester);
      await tester.tap(find.byIcon(Icons.close));
      await letFramesRun(tester);
      expect(find.text('タイムラインの案ができました'), findsOneWidget);
    });
  });

  group('見出しを付ける・出し直す・やめる', () {
    testWidgets('見出しを付けるのに失敗したら、エラーの文言を出し、区切りの確認画面のまま', (tester) async {
      final backend = await _openTimeline(tester);
      await _openReview(tester);
      backend.failNext(TripRoute.timelineWrite);

      await tester.tap(find.text('この区切りで見出しを付ける'));
      await letFramesRun(tester);
      expect(find.text('サービスに一時的に接続できません。しばらく待ってから再試行してください。'), findsOneWidget);
      expect(find.text('区切りを確認'), findsOneWidget);
      expect(_button(tester, 'この区切りで見出しを付ける').onPressed, isNotNull);
    });

    testWidgets('「この区切りで見出しを付ける」を押すと、見出しと一言を書かせて旅行詳細に戻る', (tester) async {
      final backend = await _openTimeline(tester);
      await _openReview(tester);

      await tester.tap(find.text('この区切りで見出しを付ける'));
      await letFramesRun(tester);

      expect(
          (backend.timelinesByTripId[hokkaidoTripId]!['draft'] as Map)['phase'],
          'writing');
      expect(find.text('区切りを確認'), findsNothing);
      expect(find.text('見出しと一言を書いています'), findsOneWidget);
    });

    testWidgets('見出しを付けるのを送っている間は、ほかの操作を受け付けない', (tester) async {
      final backend = await _openTimeline(tester);
      await _openReview(tester);
      final hold = backend.holdNextReply(TripRoute.timelineWrite);

      await tester.tap(find.text('この区切りで見出しを付ける'));
      await letFramesRun(tester);
      expect(_button(tester, 'この区切りで見出しを付ける').onPressed, isNull);
      expect(_button(tester, 'つなげる').onPressed, isNull);
      await tester.tap(find.byIcon(Icons.more_vert));
      await letFramesRun(tester);
      expect(find.text('区切り案を出し直す'), findsNothing);

      hold.complete();
      await letFramesRun(tester);
    });

    testWidgets('完成版がある下書き（区切りの直し・作り直し）の「区切り案を出し直す」は、作り直しと同じダイアログで、手で直した文と区切りが消えると知らせる',
        (tester) async {
      for (final reason in ['recut', 'rebuild']) {
        // 1つのテストの中で開き直すので、前の木（開いている画面）を消してから開く
        await tester.pumpWidget(const SizedBox());
        final backend =
            await _openTimeline(tester, draft: _reviewingDraft(reason: reason));
        await _openReview(tester);

        await tester.tap(find.byIcon(Icons.more_vert));
        await letFramesRun(tester);
        await tester.tap(find.text('区切り案を出し直す'));
        await letFramesRun(tester);

        // 完成版があれば、区切り案を出し直すことは最初から作り直すこと（03 §8.4・§8.6）
        expect(inDialog(find.text('タイムラインを作り直しますか？')), findsOneWidget,
            reason: reason);
        expect(
            inDialog(find.text(
                '今のタイムラインを消して、今の写真で AI が最初から作り直します。手で直した文と場面の分け方も消え、元には戻せません。')),
            findsOneWidget,
            reason: reason);
        await tapInDialog(tester, '作り直す');
        // 区切りの案から作り直す受付（POST …/timeline）を送り、旅行詳細に戻る
        expect(
            (backend.timelinesByTripId[hokkaidoTripId]!['draft'] as Map)['phase'],
            'proposing',
            reason: reason);
        expect(find.text('区切りを確認'), findsNothing, reason: reason);
      }
    });

    testWidgets('メニューの「区切り案を出し直す」は確認のダイアログを出し、「キャンセル」なら何もせず、「出し直す」で区切りの案から作り直して旅行詳細に戻る',
        (tester) async {
      final backend = await _openTimeline(tester);
      await _openReview(tester);

      await tester.tap(find.byIcon(Icons.more_vert));
      await letFramesRun(tester);
      await tester.tap(find.text('区切り案を出し直す'));
      await letFramesRun(tester);
      expect(inDialog(find.text('AI がもう一度区切りの案を出します。この画面で直した区切りは消えます。')),
          findsOneWidget);
      await tapInDialog(tester, 'キャンセル');
      expect(
          (backend.timelinesByTripId[hokkaidoTripId]!['draft'] as Map)['phase'],
          'reviewing');
      expect(find.text('区切りを確認'), findsOneWidget);

      await tester.tap(find.byIcon(Icons.more_vert));
      await letFramesRun(tester);
      await tester.tap(find.text('区切り案を出し直す'));
      await letFramesRun(tester);
      await tapInDialog(tester, '出し直す');

      expect(find.text('区切りを確認'), findsNothing);
      expect(find.text('タイムラインの案を作っています'), findsOneWidget);
    });

    testWidgets('メニューの「やめる」は「作りかけのタイムラインを捨てますか？」を出し、「キャンセル」なら何もせず、「捨てる」で下書きを消して旅行詳細に戻る',
        (tester) async {
      final backend = await _openTimeline(tester);
      await _openReview(tester);

      await tester.tap(find.byIcon(Icons.more_vert));
      await letFramesRun(tester);
      await tester.tap(find.text('やめる'));
      await letFramesRun(tester);
      expect(inDialog(find.text('作りかけのタイムラインを捨てますか？')), findsOneWidget);
      await tapInDialog(tester, 'キャンセル');
      expect(
          (backend.timelinesByTripId[hokkaidoTripId]!['draft'] as Map)['phase'],
          'reviewing');
      expect(find.text('区切りを確認'), findsOneWidget);

      await tester.tap(find.byIcon(Icons.more_vert));
      await letFramesRun(tester);
      await tester.tap(find.text('やめる'));
      await letFramesRun(tester);
      await tapInDialog(tester, '捨てる');

      expect(backend.timelinesByTripId[hokkaidoTripId], isNull);
      expect(find.text('区切りを確認'), findsNothing);
      expect(find.text('タイムラインはまだありません'), findsOneWidget);
    });

    testWidgets('メニューの操作で下書きが別の端末で変わっていたら（409）、知らせて旅行詳細に戻る', (tester) async {
      final backend = await _openTimeline(tester);
      await _openReview(tester);
      backend.failNext(TripRoute.timelineCreate,
          status: 409,
          code: 'TIMELINE_STATE_CONFLICT',
          message: 'タイムラインが変わったか、作っている途中です。読み直してください');

      await tester.tap(find.byIcon(Icons.more_vert));
      await letFramesRun(tester);
      await tester.tap(find.text('区切り案を出し直す'));
      await letFramesRun(tester);
      await tapInDialog(tester, '出し直す');

      expect(find.text('タイムラインが変わりました。読み直しました'), findsOneWidget);
      expect(find.text('区切りを確認'), findsNothing);
    });
  });
}
