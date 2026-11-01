import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show MethodChannel;
import 'package:flutter_test/flutter_test.dart';

import '../helpers/app_test_helpers.dart';
import '../helpers/gallery_test_helpers.dart';
import '../helpers/image_compress_test_helpers.dart';
import '../helpers/trip_test_helpers.dart';
import '../helpers/upload_test_helpers.dart';

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

      await tapBack(tester);
      await letFramesRun(tester);
      await tester.tap(find.text('北海道 2026秋'));
      await letFramesRun(tester);
      expect(_chip('すべて'), findsOneWidget);
      expect(find.text('タイムラインはまだありません'), findsNothing);
      semantics.dispose();
    });

    testWidgets('「タイムライン」から「写真」に戻しても写真の一覧を読み直さず、スクロールの位置と読み込んだページのまま出す', (tester) async {
      // 1ページ30枚で33枚。下端まで送って2ページ目（10:31〜10:33）まで読み、末尾の 10:33 を出した状態で切り替える。
      // 読み直すと先頭のページだけになり、位置も先頭に戻るので、10:33 は出ない
      final semantics = tester.ensureSemantics();
      final backend = FakeTripBackend(
        trips: [hokkaidoTrip(photoCount: 33)],
        functionKey: 'test-key',
        pageSize: 30,
        photosByTripId: {
          hokkaidoTripId: [
            for (var n = 1; n <= 33; n++)
              photoJson(number: n, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:${n.toString().padLeft(2, '0')}:00'),
          ],
        },
      );
      await openTripsTab(tester, backend);
      await tester.tap(find.text('北海道 2026秋'));
      await letFramesRun(tester);
      await tester.drag(photoGridScroll(), const Offset(0, -5000));
      await letFramesRun(tester);
      await tester.drag(photoGridScroll(), const Offset(0, -5000));
      await letFramesRun(tester);
      expect(photoThumbnail('2026年10月5日 10:33'), findsOneWidget);

      await _showTimeline(tester);
      expect(photoThumbnail('2026年10月5日 10:33'), findsNothing);
      await tester.tap(find.text('写真'));
      await letFramesRun(tester);

      expect(photoThumbnail('2026年10月5日 10:33'), findsOneWidget);
      semantics.dispose();
    });

    group('隠している間の読み直し', () {
      // 送った写真のサムネイルを出したまま実時間を進めるので、画像のキャッシュの置き場（path_provider）を一時ディレクトリに差し替える
      // （pending_photo_tiles_test.dart と同じ。テストごとに差し替えると互いに干渉する）
      late Directory cacheDirectory;
      const channel = MethodChannel('plugins.flutter.io/path_provider');

      setUpAll(() {
        cacheDirectory = Directory.systemTemp.createTempSync('snaplant_image_cache');
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            .setMockMethodCallHandler(channel, (call) async => cacheDirectory.path);
      });

      tearDownAll(() {
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, null);
        try {
          cacheDirectory.deleteSync(recursive: true);
        } catch (_) {
          // キャッシュの掃除のタイマーなどが使っている間は消せないことがある。一時ディレクトリなので残っても構わない
        }
      });

      testWidgets('「タイムライン」を出している間に送信が一区切りついたら、隠したまま写真の一覧を読み直し、「写真」に戻すと送った写真が出る', (tester) async {
        // 送信の応答を止めておき、「タイムライン」に切り替えてから放す。一区切りの読み直しは隠したグリッドで起きる
        final semantics = tester.ensureSemantics();
        useFakeImageCompress();
        useGalleryReturning([writeTestImage('one.png', bytes: [...tinyPngBytes, 1])]);
        final backend = await _openTripDetail(tester);
        final release = backend.holdNextReply(TripRoute.upload);
        await tester.tap(find.text('写真を追加'));
        await waitUntilUploadsReceived(tester, backend, 1);
        await letFramesRun(tester);
        await _showTimeline(tester);

        release.complete();
        await waitRealTime(tester);
        await letFramesRun(tester);
        await tester.tap(find.text('写真'));
        await letFramesRun(tester);

        // 送った写真（撮影日時なし）が、読み直した一覧に出ている
        await waitUntilFound(tester, find.bySemanticsLabel(RegExp('^撮影日時なし')));
        expect(find.bySemanticsLabel(RegExp('^撮影日時なし')), findsOneWidget);
        // キャッシュの掃除のタイマーを済ませる
        await tester.pump(const Duration(seconds: 20));
        semantics.dispose();
      });
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

    testWidgets('下に引っ張ると読み直し、解析が終わっていれば「タイムラインを作る」を押せるようにし、残りの枚数を消す',
        (tester) async {
      final backend = await _openTripDetail(tester, pendingPhotoCount: 3);
      await _showTimeline(tester);
      backend.pendingPhotoCountByTripId[hokkaidoTripId] = 0;

      await tester.drag(find.text('タイムラインはまだありません'), const Offset(0, 600));
      await letFramesRun(tester);
      expect(find.textContaining('解析中の写真があと'), findsNothing);
      expect(_button(tester, 'タイムラインを作る').onPressed, isNotNull);
    });

    testWidgets('下に引っ張った読み直しに失敗したら、表示はそのままで、エラーの文言をスナックバーに出す', (tester) async {
      final backend = await _openTripDetail(tester, pendingPhotoCount: 3);
      await _showTimeline(tester);
      backend.failNext(TripRoute.timeline);

      await tester.drag(find.text('タイムラインはまだありません'), const Offset(0, 600));
      await letFramesRun(tester);
      expect(find.text('サービスに一時的に接続できません。しばらく待ってから再試行してください。'), findsOneWidget);
      expect(find.text('エラーが発生しました'), findsNothing);
      expect(find.text('解析中の写真があと 3 枚あります。終わると作れます。'), findsOneWidget);
    });

    testWidgets('下に引っ張って読み直している間は、読み込み中にせず今の表示のままにする', (tester) async {
      final backend = await _openTripDetail(tester, pendingPhotoCount: 3);
      await _showTimeline(tester);
      backend.pendingPhotoCountByTripId[hokkaidoTripId] = 0;
      final hold = backend.holdNextReply(TripRoute.timeline);

      await tester.drag(find.text('タイムラインはまだありません'), const Offset(0, 600));
      await letFramesRun(tester);
      expect(find.text('タイムラインを読み込み中...'), findsNothing);
      expect(find.text('解析中の写真があと 3 枚あります。終わると作れます。'), findsOneWidget);

      hold.complete();
      await letFramesRun(tester);
      expect(find.textContaining('解析中の写真があと'), findsNothing);
    });

    testWidgets('作っている間に下に引っ張った読み直しに失敗しても、5 秒ごとの下書きの読み直しは続ける', (tester) async {
      final backend = await _openTripDetail(tester,
          timeline: _timeline(draft: _draft('proposing', step: 'propose')));
      await _showTimeline(tester);
      backend.failNext(TripRoute.timeline);

      await tester.drag(find.text('タイムラインの案を作っています'), const Offset(0, 600));
      await letFramesRun(tester);
      expect(find.text('サービスに一時的に接続できません。しばらく待ってから再試行してください。'), findsOneWidget);
      expect(find.text('タイムラインの案を作っています'), findsOneWidget);

      // ワーカーが区切りの案を出した
      backend.timelinesByTripId[hokkaidoTripId] =
          _timeline(draft: _draft('reviewing'));
      await _waitForPoll(tester);
      expect(find.text('タイムラインの案ができました'), findsOneWidget);
    });

    testWidgets('操作を送っている間は、下に引っ張っても読み直さない', (tester) async {
      final backend = await _openTripDetail(tester);
      await _showTimeline(tester);
      final createHold = Completer<void>();
      backend.holds[TripRoute.timelineCreate] = createHold.future;
      await tester.tap(find.text('タイムラインを作る'));
      await letFramesRun(tester);
      final reads = backend.timelineReadsReceived;

      await tester.drag(find.text('タイムラインはまだありません'), const Offset(0, 600));
      await letFramesRun(tester);
      expect(backend.timelineReadsReceived, reads);
      createHold.complete();
      await letFramesRun(tester);

      // 送り終えたら引っ張れる（上の引っ張りが空振りでなかった印）
      await tester.drag(find.text('タイムラインの案を作っています'), const Offset(0, 600));
      await letFramesRun(tester);
      expect(backend.timelineReadsReceived, reads + 1);
    });

    testWidgets('下に引っ張った読み直しの応答が「タイムラインを作る」の後に届いても、作っている間の表示を戻さない', (tester) async {
      final backend = await _openTripDetail(tester);
      await _showTimeline(tester);
      final hold = backend.holdNextReply(TripRoute.timeline);
      await tester.drag(find.text('タイムラインはまだありません'), const Offset(0, 600));
      await letFramesRun(tester);
      await tester.tap(find.text('タイムラインを作る'));
      await letFramesRun(tester);

      hold.complete();
      await letFramesRun(tester);
      expect(find.text('タイムラインの案を作っています'), findsOneWidget);
      expect(find.text('タイムラインはまだありません'), findsNothing);
    });

    testWidgets('下に引っ張った読み直しで旅行が消えていたと分かったら、「この旅行は削除されています」を出す', (tester) async {
      final backend = await _openTripDetail(tester, pendingPhotoCount: 3);
      await _showTimeline(tester);
      backend.trips.clear();

      await tester.drag(find.text('タイムラインはまだありません'), const Offset(0, 600));
      await letFramesRun(tester);
      expect(find.text('この旅行は削除されています'), findsOneWidget);
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

    testWidgets(
        '作っている間は 5 秒ごとに下書きを読み直し、案ができたら「タイムラインの案ができました」と「案を確認する」を出す（「やめる」は出さない）',
        (tester) async {
      final backend = await _openTripDetail(tester,
          timeline: _timeline(draft: _draft('proposing', step: 'propose')));
      await _showTimeline(tester);
      expect(find.text('タイムラインの案を作っています'), findsOneWidget);
      expect(backend.timelineDraftReadsReceived, 0);

      await _waitForPoll(tester);
      expect(backend.timelineDraftReadsReceived, 1);
      // ワーカーが拾った（待ち → 処理中）だけでは表示は変わらない
      backend.timelinesByTripId[hokkaidoTripId] = _timeline(
          draft: _draft('proposing', step: 'propose', state: 'running'));
      await _waitForPoll(tester);
      expect(backend.timelineDraftReadsReceived, 2);
      expect(find.text('タイムラインの案を作っています'), findsOneWidget);

      backend.timelinesByTripId[hokkaidoTripId] =
          _timeline(draft: _draft('reviewing'));
      await _waitForPoll(tester);
      expect(find.text('タイムラインの案ができました'), findsOneWidget);
      expect(find.text('場面の分け方を確かめてから、AI が見出しとまとめを書きます。'), findsOneWidget);
      expect(find.text('案を確認する'), findsOneWidget);
      expect(find.text('やめる'), findsNothing);
      expect(find.text('タイムラインの案を作っています'), findsNothing);
    });

    testWidgets('案ができたら、下書きの読み直しをやめる', (tester) async {
      final backend = await _openTripDetail(tester,
          timeline: _timeline(draft: _draft('proposing', step: 'propose')));
      await _showTimeline(tester);
      backend.timelinesByTripId[hokkaidoTripId] =
          _timeline(draft: _draft('reviewing'));
      await _waitForPoll(tester);
      expect(find.text('タイムラインの案ができました'), findsOneWidget);

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
      expect(find.text('タイムラインの案を作っています'), findsOneWidget);
      expect(find.text('エラーが発生しました'), findsNothing);

      backend.timelinesByTripId[hokkaidoTripId] =
          _timeline(draft: _draft('reviewing'));
      await _waitForPoll(tester);
      expect(find.text('タイムラインの案ができました'), findsOneWidget);
    });

    testWidgets('案ができて読み直したタイムラインが読めなくても、表示は変えず、5 秒後にもう一度読む',
        (tester) async {
      final backend = await _openTripDetail(tester,
          timeline: _timeline(draft: _draft('proposing', step: 'propose')));
      await _showTimeline(tester);
      backend.timelinesByTripId[hokkaidoTripId] =
          _timeline(draft: _draft('reviewing'));
      backend.failNext(TripRoute.timeline);

      await _waitForPoll(tester);
      expect(find.text('エラーが発生しました'), findsNothing);
      expect(find.text('タイムラインの案を作っています'), findsOneWidget);

      await _waitForPoll(tester);
      expect(find.text('タイムラインの案ができました'), findsOneWidget);
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

      await tapBack(tester);
      await letFramesRun(tester);
      await _waitForPoll(tester);
      await _waitForPoll(tester);
      expect(backend.timelineDraftReadsReceived, 1);
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

  group('タイムラインの操作', () {
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
      expect(find.text('タイムラインの案を作っています'), findsOneWidget);
    });

    testWidgets(
        '読んだ後に別の端末が下書きを無くしていたら（404 TIMELINE_NOT_FOUND）、「タイムラインが変わりました。読み直しました」を出して読み直す',
        (tester) async {
      final backend = await _openTripDetail(tester,
          timeline: _timeline(
              draft: _draft('writing',
                  step: 'write', state: 'failed', lastError: 'ai')));
      await _showTimeline(tester);
      backend.timelinesByTripId.remove(hokkaidoTripId);

      await tester.tap(find.text('もう一度'));
      await letFramesRun(tester);
      expect(find.text('タイムラインが変わりました。読み直しました'), findsOneWidget);
      expect(find.text('タイムラインはまだありません'), findsOneWidget);
    });

    testWidgets('作れなかったら（409 TIMELINE_PHOTOS_PROCESSING・TIMELINE_NO_DATED_PHOTOS）、エラーの文言を出して読み直す',
        (tester) async {
      for (final (code, message) in [
        ('TIMELINE_PHOTOS_PROCESSING', '解析中の写真があります。終わってから作ってください'),
        ('TIMELINE_NO_DATED_PHOTOS', '撮影日時のある写真がありません'),
      ]) {
        final backend = await _openTripDetail(tester);
        await _showTimeline(tester);
        // 読み直したことを、解析中の枚数が出ることで確かめる（受け付けを断られた後に写真が増えた想定）
        backend.pendingPhotoCountByTripId[hokkaidoTripId] = 2;
        backend.failNext(TripRoute.timelineCreate,
            status: 409, code: code, message: message);

        await tester.tap(find.text('タイムラインを作る'));
        await letFramesRun(tester);
        expect(find.text(message), findsOneWidget, reason: code);
        expect(find.text('解析中の写真があと 2 枚あります。終わると作れます。'), findsOneWidget,
            reason: code);
      }
    });

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
      expect(find.text('タイムラインの案を作っています'), findsOneWidget);
    });

    testWidgets('操作を送っている間は、タイムラインの操作のボタンを押せない', (tester) async {
      final backend = await _openTripDetail(tester,
          timeline: _timeline(
              draft: _draft('writing',
                  step: 'write', state: 'failed', lastError: 'ai')));
      await _showTimeline(tester);
      final hold = backend.holdNextReply(TripRoute.timelineWrite);
      backend.failNext(TripRoute.timelineWrite);

      await tester.tap(find.text('もう一度'));
      await letFramesRun(tester);
      expect(_button(tester, 'もう一度').onPressed, isNull);
      expect(_button(tester, '案を確認する').onPressed, isNull);

      // 失敗したら表示はそのまま、また押せる
      hold.complete();
      await letFramesRun(tester);
      expect(_button(tester, 'もう一度').onPressed, isNotNull);
      expect(_button(tester, '案を確認する').onPressed, isNotNull);
    });
  });
}
