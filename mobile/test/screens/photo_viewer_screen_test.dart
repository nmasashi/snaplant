import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../helpers/app_test_helpers.dart';
import '../helpers/trip_test_helpers.dart';

// 写真ビューア（docs/travel-album/03_screen_design.md §4.6）。入口は旅行詳細の写真のグリッド

/// ビューアで1枚分だけ左右にスワイプする（[toNext] なら次の写真へ）。
/// 画面の幅（480）を超えて引くと2枚分進むので、幅より短く払う
Future<void> _swipe(WidgetTester tester, {required bool toNext}) async {
  await tester.fling(
      find.byType(PageView), Offset(toNext ? -300 : 300, 0), 1000);
  await letFramesRun(tester);
}

void main() {
  testWidgets('旅行詳細で写真をタップすると写真ビューアが開き、その写真の撮影日時と地名を出す', (tester) async {
    // サムネイルは撮影日時を読み上げ用ラベルとしてだけ持ち、Text は出さない。
    // よって find.text で見つかる撮影日時と地名は、ビューアが出したもの
    final semantics = tester.ensureSemantics();
    final tapped = photoJson(
        number: 2, tripId: hokkaidoTripId, takenAt: '2026-10-05T12:30:15')
      ..['location'] = {
        'latitude': 43.7706,
        'longitude': 142.365,
        'placeName': '北海道旭川市',
        'placeSource': 'device'
      };
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 3)],
      functionKey: 'test-key',
      photosByTripId: {
        hokkaidoTripId: [
          photoJson(
              number: 1,
              tripId: hokkaidoTripId,
              takenAt: '2026-10-06T10:15:00'),
          tapped,
          photoJson(
              number: 3,
              tripId: hokkaidoTripId,
              takenAt: '2026-10-07T18:45:00'),
        ],
      },
    );
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);

    await tester.tap(photoThumbnail('2026年10月5日 12:30'));
    await letFramesRun(tester);

    expect(find.text('北海道旭川市'), findsOneWidget);
    expect(find.text('2026年10月5日 12:30'), findsOneWidget);
    semantics.dispose();
  });

  testWidgets('写真ビューアで左にスワイプすると一覧の次の写真に、右にスワイプすると前の写真に移る', (tester) async {
    // 撮影日時はビューアだけが Text で出す（サムネイルは読み上げ用ラベルのみ）
    final semantics = tester.ensureSemantics();
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 3)],
      functionKey: 'test-key',
      photosByTripId: {
        hokkaidoTripId: [
          photoJson(
              number: 1,
              tripId: hokkaidoTripId,
              takenAt: '2026-10-06T10:15:00'),
          photoJson(
              number: 2,
              tripId: hokkaidoTripId,
              takenAt: '2026-10-05T12:30:15'),
          photoJson(
              number: 3,
              tripId: hokkaidoTripId,
              takenAt: '2026-10-07T18:45:00'),
        ],
      },
    );
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    await tester.tap(photoThumbnail('2026年10月5日 12:30'));
    await letFramesRun(tester);

    await _swipe(tester, toNext: true);

    expect(find.text('2026年10月7日 18:45').hitTestable(), findsOneWidget);
    expect(find.text('2026年10月5日 12:30').hitTestable(), findsNothing);

    await _swipe(tester, toNext: false);

    expect(find.text('2026年10月5日 12:30').hitTestable(), findsOneWidget);

    await _swipe(tester, toNext: false);

    expect(find.text('2026年10月6日 10:15').hitTestable(), findsOneWidget);
    expect(find.text('2026年10月7日 18:45').hitTestable(), findsNothing);
    semantics.dispose();
  });

  testWidgets(
      '写真ビューアは、地名が無ければ緯度・経度を小数4桁で、位置情報が無ければ「位置情報なし」を、撮影日時が無ければ「撮影日時なし」を出す',
      (tester) async {
    // サムネイルの読み上げ用ラベルにも「撮影日時なし」が入るので、
    // 画面に出ている Text だけを hitTestable で見分ける
    final semantics = tester.ensureSemantics();
    final coordinatesOnly = photoJson(
        number: 1, tripId: hokkaidoTripId, takenAt: '2026-10-05T12:30:15')
      ..['location'] = {
        'latitude': 43.77,
        'longitude': 142.36,
        'placeName': null,
        'placeSource': null
      };
    final needsRounding = photoJson(
        number: 2, tripId: hokkaidoTripId, takenAt: '2026-10-06T10:15:00')
      ..['location'] = {
        'latitude': 43.770649,
        'longitude': 142.360049,
        'placeName': null,
        'placeSource': null
      };
    final noTakenAtNoLocation =
        photoJson(number: 3, tripId: hokkaidoTripId, takenAt: null);
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 3)],
      functionKey: 'test-key',
      photosByTripId: {
        hokkaidoTripId: [coordinatesOnly, needsRounding, noTakenAtNoLocation],
      },
    );
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);

    await tester.tap(photoThumbnail('2026年10月5日 12:30'));
    await letFramesRun(tester);

    expect(find.text('43.7700, 142.3600').hitTestable(), findsOneWidget);

    await _swipe(tester, toNext: true);

    expect(find.text('43.7706, 142.3600').hitTestable(), findsOneWidget);

    await _swipe(tester, toNext: true);

    expect(find.text('撮影日時なし').hitTestable(), findsOneWidget);
    expect(find.text('位置情報なし').hitTestable(), findsOneWidget);
    semantics.dispose();
  });

  testWidgets('写真ビューアで読み込んだ末尾の写真まで来ると、一覧が次のページを読み、続けてスワイプできる', (tester) async {
    // 1ページ目は30枚（10:01〜10:30）、2ページ目は3枚（10:31〜10:33）。
    // 1ページ目の末尾（10:30）のサムネイルを出すにはグリッドを下端近くまで送る必要があり、
    // その時点でグリッド自身が2ページ目を要求する（末尾の6枚以内が描かれると読む）。
    // これは避けられないので、2ページ目の応答を止めておき、ビューアを開いて10:30に着いてから放す。
    // ビューアが開いた時点では2ページ目は一覧に無く、放した後に一覧の配列が伸びる。
    // ビューアが開いた時点の写真しか持たなければ、10:30で止まって次に進めない
    final semantics = tester.ensureSemantics();
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 33)],
      functionKey: 'test-key',
      pageSize: 30,
      photosByTripId: {
        hokkaidoTripId: [
          for (var n = 1; n <= 33; n++)
            photoJson(
                number: n,
                tripId: hokkaidoTripId,
                takenAt: '2026-10-05T10:${n.toString().padLeft(2, '0')}:00'),
        ],
      },
    );
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    final release = Completer<void>();
    backend.holds[TripRoute.photos] = release.future;
    await tester.drag(find.byType(GridView), const Offset(0, -5000));
    await letFramesRun(tester);
    await tester.tap(photoThumbnail('2026年10月5日 10:30'));
    await letFramesRun(tester);
    expect(find.text('2026年10月5日 10:30').hitTestable(), findsOneWidget);
    release.complete();
    await letFramesRun(tester);

    await _swipe(tester, toNext: true);

    expect(find.text('2026年10月5日 10:31').hitTestable(), findsOneWidget);

    await _swipe(tester, toNext: true);

    expect(find.text('2026年10月5日 10:32').hitTestable(), findsOneWidget);
    semantics.dispose();
  });

  testWidgets('グリッドを下端まで送っていなくても、写真ビューアで読み込んだ末尾の写真まで来ると、一覧が次のページを読み、続けてスワイプできる',
      (tester) async {
    // 1ページ目は30枚（10:01〜10:30）、2ページ目は3枚（10:31〜10:33）。
    // グリッドは送らず、先頭の方の10:15を開く。グリッドが続きを読むのは末尾の6枚以内（10:25〜）を組み立てたときだけなので、
    // この時点で2ページ目は要求されていない
    final semantics = tester.ensureSemantics();
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 33)],
      functionKey: 'test-key',
      pageSize: 30,
      photosByTripId: {
        hokkaidoTripId: [
          for (var n = 1; n <= 33; n++)
            photoJson(
                number: n,
                tripId: hokkaidoTripId,
                takenAt: '2026-10-05T10:${n.toString().padLeft(2, '0')}:00'),
        ],
      },
    );
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    // 2ページ目の応答を止めておく。グリッドが既に要求していれば、止まっている間は
    // 末尾に「読み込み中...」が出るので、出ていないことで「まだ要求していない」を確かめる
    // （偽のサーバに届いた一覧の要求の数は数えていないための間接的な確認）
    final release = Completer<void>();
    backend.holds[TripRoute.photos] = release.future;
    await tester.pump();
    expect(find.text('読み込み中...'), findsNothing);
    await tester.tap(photoThumbnail('2026年10月5日 10:15'));
    await letFramesRun(tester);
    expect(find.text('2026年10月5日 10:15').hitTestable(), findsOneWidget);
    release.complete();
    await letFramesRun(tester);

    for (var i = 0; i < 15; i++) {
      await _swipe(tester, toNext: true);
    }

    expect(find.text('2026年10月5日 10:30').hitTestable(), findsOneWidget);

    await _swipe(tester, toNext: true);

    expect(find.text('2026年10月5日 10:31').hitTestable(), findsOneWidget);
    semantics.dispose();
  });
}
