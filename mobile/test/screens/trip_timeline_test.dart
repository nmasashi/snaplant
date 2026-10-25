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
    {int pendingPhotoCount = 0}) async {
  final backend = FakeTripBackend(
    trips: [hokkaidoTrip(photoCount: 1)],
    functionKey: 'test-key',
    photosByTripId: {hokkaidoTripId: _hokkaidoPhotos()},
  );
  backend.pendingPhotoCountByTripId[hokkaidoTripId] = pendingPhotoCount;
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

      await tester.tap(find.text('再試行'));
      await letFramesRun(tester);
      expect(find.text('エラーが発生しました'), findsNothing);
      expect(find.text('タイムラインはまだありません'), findsOneWidget);
    });

    testWidgets('通信が切れて読めなかったときも、エラーの文言を出す', (tester) async {
      final backend = await _openTripDetail(tester);
      backend.failNextWithConnectionError(TripRoute.timeline);

      await _showTimeline(tester);
      expect(find.text('エラーが発生しました'), findsOneWidget);
      expect(find.text('ネットワークに接続できません。インターネット接続を確認してください。'), findsOneWidget);
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
}
