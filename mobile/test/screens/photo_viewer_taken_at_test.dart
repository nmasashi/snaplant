import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../helpers/app_test_helpers.dart';
import '../helpers/trip_test_helpers.dart';

// 撮影日時を手で付ける（docs/03_screen_design.md §5.8。D-2）。入口は旅行詳細の写真のグリッドから開く写真ビューア。
// 旅行の API は偽のサーバ（helpers の FakeTripBackend。撮影日時の更新は本物と同じ規則で受ける）。
// 送った日時の手がかりは端末の時刻で出すので、日本時間で動くことを前提にする（CLAUDE.md「日時の表示のテスト」）

/// 撮影日時の無い写真（送った日時は 2026-10-10T03:12:45Z。日本時間で 10月10日 12:12）
const _undatedNumber = 1;

/// 旅行（期間は 10月3日〜10月6日）と、撮影日時の無い写真1枚・カメラが記録した撮影日時の写真1枚の偽のサーバ
FakeTripBackend _backend({String? takenAt, String? takenAtSource}) => FakeTripBackend(
      trips: [
        tripJson(
            id: hokkaidoTripId,
            name: '北海道 2026秋',
            photoCount: 2,
            firstTakenAt: '2026-10-03T09:00:00',
            lastTakenAt: '2026-10-06T18:00:00'),
      ],
      photosByTripId: {
        hokkaidoTripId: [
          photoJson(number: 2, tripId: hokkaidoTripId, takenAt: '2026-10-04T10:00:00'),
          photoJson(number: _undatedNumber, tripId: hokkaidoTripId, takenAt: takenAt, takenAtSource: takenAtSource),
        ],
      },
    );

/// 旅行詳細を開き、[label] で始まる読み上げのサムネイルをタップして写真ビューアを開く
Future<void> _openViewer(WidgetTester tester, FakeTripBackend backend, String label) async {
  await openTripsTab(tester, backend);
  await tester.tap(find.text('北海道 2026秋'));
  await letFramesRun(tester);
  await tester.tap(find.bySemanticsLabel(RegExp('^${RegExp.escape(label)}')));
  await letFramesRun(tester);
}

/// 偽のサーバの撮影日時の無い写真
Map<String, Object?> _storedPhoto(FakeTripBackend backend) =>
    backend.photosByTripId[hokkaidoTripId]!.firstWhere((photo) => photo['id'] == _undatedNumber.toRadixString(16).padLeft(64, '0'));

void main() {
  setUp(() {
    // 送った日時の手がかりを日本時間の文字列で見る
    expect(DateTime(2026, 10, 10).timeZoneOffset, const Duration(hours: 9), reason: '日本時間で動かす');
  });

  testWidgets('撮影日時の無い写真には「撮影日時なし」と「日時を付ける」を出し、カメラが記録した撮影日時の写真には出さない', (tester) async {
    final semantics = tester.ensureSemantics();
    final backend = _backend();
    await _openViewer(tester, backend, '撮影日時なし');

    expect(find.text('撮影日時なし'), findsOneWidget);
    expect(find.text('日時を付ける'), findsOneWidget);

    await tapBack(tester);
    await letFramesRun(tester);
    await tester.tap(find.bySemanticsLabel(RegExp('^2026年10月4日 10:00')));
    await letFramesRun(tester);

    expect(find.text('2026年10月4日 10:00'), findsOneWidget);
    expect(find.text('日時を付ける'), findsNothing);
    expect(find.text('変更'), findsNothing);
    semantics.dispose();
  });

  testWidgets('「日時を付ける」で、旅行の期間と送った日時を手がかりにしたシートを開き、選んだ日付で保存すると、撮影日時と「手で付けた日時」「変更」を出して「撮影日時を付けました」と知らせる', (tester) async {
    final semantics = tester.ensureSemantics();
    final backend = _backend();
    await _openViewer(tester, backend, '撮影日時なし');

    await tester.tap(find.text('日時を付ける'));
    await letFramesRun(tester);
    expect(find.text('撮影日時を付ける'), findsOneWidget);
    expect(find.text('「北海道 2026秋」の期間は 10月3日〜10月6日です。'), findsOneWidget);
    expect(find.text('この写真は 10月10日 12:12 に送りました。'), findsOneWidget);
    // 初期値は旅行の期間の初日の 12:00
    expect(find.text('2026年10月3日'), findsOneWidget);
    expect(find.text('12:00'), findsOneWidget);

    // 日付を 10月5日に選び直す（OS の日付の選択）
    await tester.tap(find.text('2026年10月3日'));
    await letFramesRun(tester);
    await tester.tap(find.text('5'));
    await tester.tap(find.text('OK'));
    await letFramesRun(tester);
    expect(find.text('2026年10月5日'), findsOneWidget);
    await tester.tap(find.text('保存'));
    await letFramesRun(tester);

    expect(_storedPhoto(backend)['takenAt'], '2026-10-05T12:00:00');
    expect(find.byType(BottomSheet), findsNothing);
    expect(find.text('撮影日時を付けました'), findsOneWidget);
    expect(find.text('2026年10月5日 12:00'), findsOneWidget);
    expect(find.text('手で付けた日時'), findsOneWidget);
    expect(find.text('変更'), findsOneWidget);
    semantics.dispose();
  });

  testWidgets('手で付けた撮影日時は「変更」のシートで今の日時から直せて、「日時を消す」で撮影日時なしに戻せる', (tester) async {
    final semantics = tester.ensureSemantics();
    final backend = _backend(takenAt: '2026-10-05T08:30:00', takenAtSource: 'user');
    await _openViewer(tester, backend, '2026年10月5日 08:30');
    expect(find.text('手で付けた日時'), findsOneWidget);

    await tester.tap(find.text('変更'));
    await letFramesRun(tester);
    expect(find.text('撮影日時を変える'), findsOneWidget);
    expect(find.text('2026年10月5日'), findsOneWidget);
    expect(find.text('08:30'), findsOneWidget);

    await tester.tap(find.text('日時を消す（撮影日時なしに戻す）'));
    await letFramesRun(tester);

    expect(_storedPhoto(backend)['takenAt'], isNull);
    expect(find.text('撮影日時を消しました'), findsOneWidget);
    expect(find.text('撮影日時なし'), findsOneWidget);
    expect(find.text('日時を付ける'), findsOneWidget);
    semantics.dispose();
  });

  testWidgets('旅行を読んでいる間は「保存」を押せず、読めたら期間の初日を初期値にして押せる', (tester) async {
    // 読む前に保存すると、期間の初日ではなく送った日で付いてしまう
    final semantics = tester.ensureSemantics();
    final backend = _backend();
    await _openViewer(tester, backend, '撮影日時なし');
    final reply = backend.holdNextReply(TripRoute.detail);
    addTearDown(() {
      if (!reply.isCompleted) reply.complete();
    });
    await tester.tap(find.text('日時を付ける'));
    await letFramesRun(tester);

    FilledButton save() => tester.widget<FilledButton>(find.ancestor(of: find.text('保存'), matching: find.byType(FilledButton)));
    expect(save().onPressed, isNull);

    reply.complete();
    await letFramesRun(tester);
    expect(save().onPressed, isNotNull);
    expect(find.text('2026年10月3日'), findsOneWidget);
    semantics.dispose();
  });

  testWidgets('変えるときは、旅行を読んでいる間も「保存」を押せ、今の日時のまま保存できる（初期値が今の日時で、旅行を読んでも替わらないので）', (tester) async {
    final semantics = tester.ensureSemantics();
    final backend = _backend(takenAt: '2026-10-05T08:30:00', takenAtSource: 'user');
    await _openViewer(tester, backend, '2026年10月5日 08:30');
    final reply = backend.holdNextReply(TripRoute.detail);
    addTearDown(() {
      if (!reply.isCompleted) reply.complete();
    });
    await tester.tap(find.text('変更'));
    await letFramesRun(tester);
    // まだ旅行を読んでいる（期間の手がかりが出ていない）
    expect(find.textContaining('の期間は'), findsNothing);
    // 送ったことを保存先の値で確かめるため、保存先の撮影日時を開いた後に消しておく（同じ値のままだと、送らなくても通る）
    _storedPhoto(backend)['takenAt'] = null;

    await tester.tap(find.text('保存'));
    await letFramesRun(tester);

    expect(_storedPhoto(backend)['takenAt'], '2026-10-05T08:30:00');
    expect(find.text('撮影日時を変えました'), findsOneWidget);
    reply.complete();
    await letFramesRun(tester);
    semantics.dispose();
  });

  testWidgets('日付の選択の範囲（1900〜2100 年）の外の手で付けた日時も、「変更」でそのまま保存すると同じ日時で保存される', (tester) async {
    final semantics = tester.ensureSemantics();
    final backend = _backend(takenAt: '0850-05-01T10:00:00', takenAtSource: 'user');
    await _openViewer(tester, backend, '0850年5月1日 10:00');
    await tester.tap(find.text('変更'));
    await letFramesRun(tester);
    // 送ったことを保存先の値で確かめるため、保存先の撮影日時を開いた後に消しておく（同じ値のままだと、送らなくても通る）
    _storedPhoto(backend)['takenAt'] = null;

    await tester.tap(find.text('保存'));
    await letFramesRun(tester);

    expect(_storedPhoto(backend)['takenAt'], '0850-05-01T10:00:00');
    expect(find.text('撮影日時を変えました'), findsOneWidget);
    semantics.dispose();
  });

  testWidgets('保存を待っている間は、下に払っても端末の戻る操作でもシートの外のタップでも閉じず、日付・時刻・「キャンセル」「保存」を押せず、保存が済むとシートを閉じる', (tester) async {
    final semantics = tester.ensureSemantics();
    final backend = _backend();
    await _openViewer(tester, backend, '撮影日時なし');
    await tester.tap(find.text('日時を付ける'));
    await letFramesRun(tester);
    final reply = backend.holdNextReply(TripRoute.updatePhoto);
    addTearDown(() {
      if (!reply.isCompleted) reply.complete();
    });

    await tester.tap(find.text('保存'));
    await tester.pump();
    await tester.drag(find.text('撮影日時を付ける'), const Offset(0, 500));
    await letFramesRun(tester);
    await tester.binding.handlePopRoute();
    await letFramesRun(tester);
    await tester.tapAt(const Offset(10, 10));
    await letFramesRun(tester);

    expect(find.byType(BottomSheet), findsOneWidget);
    for (final label in ['キャンセル', '保存', '2026年10月3日', '12:00']) {
      final button = tester.widget<ButtonStyleButton>(find.ancestor(
          of: find.descendant(of: find.byType(BottomSheet), matching: find.text(label)),
          matching: find.bySubtype<ButtonStyleButton>()));
      expect(button.onPressed, isNull, reason: label);
    }
    reply.complete();
    await letFramesRun(tester);
    expect(find.byType(BottomSheet), findsNothing);
    semantics.dispose();
  });

  testWidgets('「日時を消す」を送っている間は、「日時を消す」も「保存」も押せない', (tester) async {
    final semantics = tester.ensureSemantics();
    final backend = _backend(takenAt: '2026-10-05T08:30:00', takenAtSource: 'user');
    await _openViewer(tester, backend, '2026年10月5日 08:30');
    await tester.tap(find.text('変更'));
    await letFramesRun(tester);
    final reply = backend.holdNextReply(TripRoute.updatePhoto);
    addTearDown(() {
      if (!reply.isCompleted) reply.complete();
    });

    await tester.tap(find.text('日時を消す（撮影日時なしに戻す）'));
    await tester.pump();

    for (final label in ['日時を消す（撮影日時なしに戻す）', '保存']) {
      final button = tester.widget<ButtonStyleButton>(find.ancestor(
          of: find.descendant(of: find.byType(BottomSheet), matching: find.text(label)),
          matching: find.bySubtype<ButtonStyleButton>()));
      expect(button.onPressed, isNull, reason: label);
    }
    reply.complete();
    await letFramesRun(tester);
    semantics.dispose();
  });

  testWidgets('「変更」のシートで時刻を選び直して保存すると、その日時に直して「撮影日時を変えました」と知らせる', (tester) async {
    final semantics = tester.ensureSemantics();
    final backend = _backend(takenAt: '2026-10-05T08:30:00', takenAtSource: 'user');
    await _openViewer(tester, backend, '2026年10月5日 08:30');
    await tester.tap(find.text('変更'));
    await letFramesRun(tester);

    // OS の時刻の選択を、文字で入れる形に切り替えて 9:45 にする（テスト環境の時刻は 12 時間表記）
    await tester.tap(find.text('08:30'));
    await letFramesRun(tester);
    await tester.tap(find.byIcon(Icons.keyboard_outlined));
    await letFramesRun(tester);
    await tester.tap(find.byType(TextField).at(0));
    await tester.pump();
    await tester.enterText(find.byType(TextField).at(0), '9');
    await tester.pump();
    await tester.tap(find.byType(TextField).at(1));
    await tester.pump();
    await tester.enterText(find.byType(TextField).at(1), '45');
    await tester.pump();
    await tester.tap(find.text('OK'));
    await letFramesRun(tester);
    await tester.tap(find.text('保存'));
    await letFramesRun(tester);

    expect(_storedPhoto(backend)['takenAt'], '2026-10-05T09:45:00');
    expect(find.text('撮影日時を変えました'), findsOneWidget);
    semantics.dispose();
  });

  testWidgets('旅行を読めなければ、期間の手がかりを出さず、送った日の 12:00 を初期値にして保存できる', (tester) async {
    final semantics = tester.ensureSemantics();
    final backend = _backend();
    await _openViewer(tester, backend, '撮影日時なし');
    backend.failNext(TripRoute.detail);

    await tester.tap(find.text('日時を付ける'));
    await letFramesRun(tester);

    expect(find.text('2026年10月10日'), findsOneWidget);
    expect(find.textContaining('の期間は'), findsNothing);
    await tester.tap(find.text('保存'));
    await letFramesRun(tester);
    expect(_storedPhoto(backend)['takenAt'], '2026-10-10T12:00:00');
    semantics.dispose();
  });

  testWidgets('保存に失敗したらシートに留まって理由を出し（カメラが記録した撮影日時の 409 ならその文言）、そのまま押し直せる', (tester) async {
    final semantics = tester.ensureSemantics();
    final backend = _backend();
    await _openViewer(tester, backend, '撮影日時なし');
    await tester.tap(find.text('日時を付ける'));
    await letFramesRun(tester);
    backend.failNext(TripRoute.updatePhoto,
        status: 409, code: 'TAKEN_AT_FROM_CAMERA', message: 'カメラが記録した撮影日時は変えられません');

    await tester.tap(find.text('保存'));
    await letFramesRun(tester);

    expect(find.byType(BottomSheet), findsOneWidget);
    expect(find.text('カメラが記録した撮影日時は変えられません'), findsOneWidget);

    // 失敗した後は、そのまま押し直せる
    await tester.tap(find.text('保存'));
    await letFramesRun(tester);
    expect(find.byType(BottomSheet), findsNothing);
    expect(_storedPhoto(backend)['takenAt'], '2026-10-03T12:00:00');
    semantics.dispose();
  });
}
