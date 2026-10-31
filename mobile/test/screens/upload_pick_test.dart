import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../helpers/app_test_helpers.dart';
import '../helpers/gallery_test_helpers.dart';
import '../helpers/trip_test_helpers.dart';

// 「写真を追加」で写真を選ぶ（docs/03_screen_design.md §4.7.1）を、利用者から見た振る舞いで確かめる。
// ボタンの「写真を読み込み中...」、選ぶ画面の読み込みの失敗、一部の写真が読めなかったときの知らせ。
// 送信の状態はアプリの根が持つので、アプリ全体を開いて旅行一覧から旅行詳細へ進む。旅行の API は偽のサーバ（helpers の FakeTripBackend）、
// OS のギャラリーは端末の機能なので偽物に差し替える

const _apiKey = 'test-key';

void main() {
  testWidgets('3枚のうち2枚目の準備（ファイルの読み込み）に失敗しても、3枚目の準備は続け、「画像の読み込みに失敗しました」と知らせ、読めた1枚目と3枚目が送られて「2枚を送信しました」と知らせる', (tester) async {
    // 準備は1枚ずつ進む。途中の1枚で失敗しても、それまでに準備できた分が列に残ったまま送られなくならず、失敗した写真より後に選んだ写真も捨てない。2枚目は存在しないパス
    final first = writeTestImage('first.png');
    final missing = File('${first.parent.path}/no_such_image.png');
    final third = writeTestImage('third.png', bytes: [...tinyPngBytes, 0]);
    useGalleryReturning([first, missing, third]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await waitUntilFound(tester, find.text('画像の読み込みに失敗しました'));

    expect(find.text('画像の読み込みに失敗しました'), findsOneWidget);
    await waitUntilUploaded(tester, backend, hokkaidoTripId, count: 2);
    await letFramesRun(tester);
    expect(backend.photosByTripId[hokkaidoTripId]!.length, 2);
    expect(backend.photosByTripId[hokkaidoTripId]!.map((photo) => photo['id']), contains(tinyPngSha256));
    // 2つの知らせは順に出る。先の「読み込みに失敗しました」が消えてから、あとの知らせが出る
    await pumpUntilFound(tester, find.text('2枚を送信しました'));
    expect(find.text('2枚を送信しました'), findsOneWidget);
  });

  testWidgets('「写真を追加」を押してから写真を受け取るまで、ボタンを「写真を読み込み中...」（回転する印つき）にして押せなくし、選ぶ画面を何も選ばずに閉じたら、ボタンを「写真を追加」に戻し、もう一度押せば選ぶ画面を開ける', (tester) async {
    // ギャラリーの返事を保留して、選ぶ画面を開いてから写真を受け取るまでの間をつくる。2回目に押しても選ぶ画面は開き直されない。
    // 閉じるまでの間は「写真を読み込み中...」のまま。何も選ばれなかったときも、ボタンは元に戻る（受け取った後に戻ることは、100枚を選ぶテストで見る）
    final release = Completer<void>();
    final gallery = useGalleryReturning([], hold: release.future);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await letFramesRun(tester);

    expect(find.text('写真を読み込み中...'), findsOneWidget);
    expect(find.descendant(of: find.byType(FloatingActionButton), matching: find.byType(CircularProgressIndicator)), findsOneWidget);
    expect(find.text('写真を追加'), findsNothing);
    await tester.tap(find.text('写真を読み込み中...'));
    await letFramesRun(tester);
    expect(gallery.openCount, 1);

    release.complete();
    await letFramesRun(tester);

    expect(find.text('写真を追加'), findsOneWidget);
    expect(find.text('写真を読み込み中...'), findsNothing);
    await tester.tap(find.text('写真を追加'));
    await letFramesRun(tester);
    expect(gallery.openCount, 2);
  });

  testWidgets('写真を受け取るのを待っている間に選択モードに入って抜けても、ボタンは「写真を読み込み中...」のままで、選ぶ画面を二重に開かない', (tester) async {
    // 選択モードの間は右下のボタンが外れる。抜けて作り直されたボタンが待ちの状態を忘れて「写真を追加」に戻ると、押せてしまう
    final release = Completer<void>();
    final gallery = useGalleryReturning([], hold: release.future);
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 1)],
      functionKey: _apiKey,
      photosByTripId: {
        hokkaidoTripId: [photoJson(number: 1, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:01:00')],
      },
    );
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    await tester.tap(find.text('写真を追加'));
    await letFramesRun(tester);
    expect(find.text('写真を読み込み中...'), findsOneWidget);
    await tester.longPress(photoThumbnail('2026年10月5日 10:01'));
    await letFramesRun(tester);
    expect(find.byType(FloatingActionButton), findsNothing);

    await tester.tap(find.descendant(of: find.byType(AppBar), matching: find.byIcon(Icons.close)));
    await letFramesRun(tester);

    expect(find.text('写真を読み込み中...'), findsOneWidget);
    expect(find.text('写真を追加'), findsNothing);
    await tester.tap(find.byType(FloatingActionButton));
    await letFramesRun(tester);
    expect(gallery.openCount, 1);
    release.complete();
    await letFramesRun(tester);
  });

  testWidgets('ギャラリーの読み込みに失敗して選ぶ画面が閉じたら、「画像の読み込みに失敗しました」と知らせ、何も送らず、ボタンを「写真を追加」に戻す', (tester) async {
    final release = Completer<void>();
    useGalleryReturning([], failWith: Exception('ギャラリーを開けない'), hold: release.future);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    await tester.tap(find.text('写真を追加'));
    await letFramesRun(tester);
    expect(find.text('写真を読み込み中...'), findsOneWidget);

    release.complete();
    await letFramesRun(tester);

    expect(find.text('画像の読み込みに失敗しました'), findsOneWidget);
    expect(backend.photosByTripId[hokkaidoTripId] ?? [], isEmpty);
    expect(find.text('まだ写真がありません'), findsOneWidget);
    expect(find.text('写真を追加'), findsOneWidget);
    expect(find.text('写真を読み込み中...'), findsNothing);
  });

  testWidgets('写真を受け取るのを待っている間にボタンが外れていても、読み込みに失敗したら「画像の読み込みに失敗しました」を出す', (tester) async {
    // 選択モードの間は右下のボタンが外れ、押したボタンの context は生きていない。知らせる先の ScaffoldMessenger は生きている
    final release = Completer<void>();
    useGalleryReturning([], failWith: Exception('ギャラリーを開けない'), hold: release.future);
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 1)],
      functionKey: _apiKey,
      photosByTripId: {
        hokkaidoTripId: [photoJson(number: 1, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:01:00')],
      },
    );
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    await tester.tap(find.text('写真を追加'));
    await letFramesRun(tester);
    await tester.longPress(photoThumbnail('2026年10月5日 10:01'));
    await letFramesRun(tester);
    expect(find.byType(FloatingActionButton), findsNothing);

    release.complete();
    await letFramesRun(tester);

    expect(find.text('画像の読み込みに失敗しました'), findsOneWidget);
  });

}
