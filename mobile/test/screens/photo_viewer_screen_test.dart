import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../helpers/app_test_helpers.dart';
import '../helpers/trip_test_helpers.dart';

// 写真ビューア（docs/03_screen_design.md §4.6）。入口は旅行詳細の写真のグリッド
//
// 偽のサーバの写真は、本物の API と同じく sortAt の昇順で並べる（photoJson は sortAt = takenAt）。

/// ビューアで1枚分だけ左右にスワイプする（[toNext] なら次の写真へ）。
/// 画面の幅（480）を超えて引くと2枚分進むので、幅より短く払う
Future<void> _swipe(WidgetTester tester, {required bool toNext}) async {
  await tester.fling(
      find.byType(PageView), Offset(toNext ? -300 : 300, 0), 1000);
  await letFramesRun(tester);
}

/// [text] がビューアの画面の中（横位置が画面の幅の内側）にあるか。
/// PageView が隣のページを先に組み立てていても（画面の外の右や左に置かれる）、
/// 出ている写真のものだけを数える。スナックバーが下の情報を覆うと hitTestable で見られないため、位置で見る。
/// `find.text` は複数の要素に当たりうるので、1つでも画面の中にあれば true
bool _isOnScreen(WidgetTester tester, String text) {
  final screenWidth =
      tester.view.physicalSize.width / tester.view.devicePixelRatio;
  return find.text(text).evaluate().any((element) {
    final x = tester.getCenter(find.byElementPredicate((e) => e == element)).dx;
    return x >= 0 && x <= screenWidth;
  });
}

/// 1ページ目が30枚（10:01〜10:30）、2ページ目が3枚（10:31〜10:33）になる33枚の旅行の偽のサーバ
FakeTripBackend _thirtyThreePhotosBackend() => FakeTripBackend(
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

/// 旅行詳細を開き、[label] の写真のサムネイルをタップしてビューアを開く
Future<void> _openViewerOn(WidgetTester tester,
    List<Map<String, Object?>> photos, String label) async {
  final backend = FakeTripBackend(
    trips: [hokkaidoTrip(photoCount: photos.length)],
    functionKey: 'test-key',
    photosByTripId: {hokkaidoTripId: photos},
  );
  await openTripsTab(tester, backend);
  await tester.tap(find.text('北海道 2026秋'));
  await letFramesRun(tester);
  await tester.tap(photoThumbnail(label));
  await letFramesRun(tester);
}

void main() {
  testWidgets('旅行詳細で写真をタップすると写真ビューアが開き、その写真の撮影日時と地名を出す', (tester) async {
    // サムネイルは撮影日時を読み上げ用ラベルとしてだけ持ち、Text は出さない。
    // よって find.text で見つかる撮影日時と地名は、ビューアが出したもの
    final semantics = tester.ensureSemantics();
    final tapped = photoJson(
        number: 2, tripId: hokkaidoTripId, takenAt: '2026-10-06T10:15:00')
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
              takenAt: '2026-10-05T12:30:15'),
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

    await tester.tap(photoThumbnail('2026年10月6日 10:15'));
    await letFramesRun(tester);

    expect(find.text('北海道旭川市'), findsOneWidget);
    expect(find.text('2026年10月6日 10:15'), findsOneWidget);
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
              takenAt: '2026-10-05T12:30:15'),
          photoJson(
              number: 2,
              tripId: hokkaidoTripId,
              takenAt: '2026-10-06T10:15:00'),
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
    await tester.tap(photoThumbnail('2026年10月6日 10:15'));
    await letFramesRun(tester);

    await _swipe(tester, toNext: true);

    expect(find.text('2026年10月7日 18:45').hitTestable(), findsOneWidget);
    expect(find.text('2026年10月6日 10:15').hitTestable(), findsNothing);

    await _swipe(tester, toNext: false);

    expect(find.text('2026年10月6日 10:15').hitTestable(), findsOneWidget);

    await _swipe(tester, toNext: false);

    expect(find.text('2026年10月5日 12:30').hitTestable(), findsOneWidget);
    expect(find.text('2026年10月7日 18:45').hitTestable(), findsNothing);
    semantics.dispose();
  });

  testWidgets('写真ビューアは、地名が無ければ緯度・経度を小数4桁で出し（4桁を超える小数も4桁にする）、撮影日時が無ければ「撮影日時なし」を、位置情報が無ければ「位置情報なし」を出す',
      (tester) async {
    // サムネイルは撮影日時を読み上げ用ラベルとしてだけ持ち、Text は出さない
    // （撮影日時の無いサムネイルのラベルは「撮影日時なし」）。よって find.text で見つかるのはビューアが出したもの。
    // 43.770649 は丸めても切り捨てても 43.7706 になるので、丸め方までは固定しない。4桁で出すことだけを見る
    final semantics = tester.ensureSemantics();
    Map<String, Object?> at(int number, String time, double lat, double lng) =>
        photoJson(
            number: number,
            tripId: hokkaidoTripId,
            takenAt: '2026-10-05T$time:15')
          ..['location'] = {
            'latitude': lat,
            'longitude': lng,
            'placeName': null,
            'placeSource': null
          };

    await _openViewerOn(tester, [
      at(1, '12:30', 43.77, 142.36),
      at(2, '12:40', 43.770649, 142.360049),
      photoJson(number: 3, tripId: hokkaidoTripId, takenAt: null),
    ], '2026年10月5日 12:30');
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
    final backend = _thirtyThreePhotosBackend();
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    final release = Completer<void>();
    backend.holds[TripRoute.photos] = release.future;
    await tester.drag(photoGridScroll(), const Offset(0, -5000));
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

  testWidgets('続きのページの読み込みに失敗していたら、写真ビューアの読み込んだ末尾の写真でだけ「続きを読み込めませんでした」「再試行」を出し、「再試行」で続きを読んで先へスワイプできる', (tester) async {
    // 1ページ目は30枚（10:01〜10:30）、2ページ目は3枚（10:31〜10:33）。グリッドを下端まで送ると2ページ目を読むので、その1回を失敗させる。
    // 一覧（グリッド）にも同じ文言が出るが、ビューアの下に隠れているので、ビューアの中に出ていることは hitTestable で見る
    final semantics = tester.ensureSemantics();
    final backend = _thirtyThreePhotosBackend();
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    backend.failNext(TripRoute.photos);
    await tester.drag(photoGridScroll(), const Offset(0, -5000));
    await letFramesRun(tester);
    await tester.tap(photoThumbnail('2026年10月5日 10:30'));
    await letFramesRun(tester);
    expect(find.text('2026年10月5日 10:30').hitTestable(), findsOneWidget);
    expect(find.text('続きを読み込めませんでした').hitTestable(), findsOneWidget,
        reason: '読み込んだ末尾の写真（10:30）');

    await _swipe(tester, toNext: false);

    expect(find.text('2026年10月5日 10:29').hitTestable(), findsOneWidget);
    expect(find.text('続きを読み込めませんでした').hitTestable(), findsNothing,
        reason: '末尾でない写真（10:29）');

    await _swipe(tester, toNext: true);

    expect(find.text('2026年10月5日 10:30').hitTestable(), findsOneWidget);
    expect(find.text('続きを読み込めませんでした').hitTestable(), findsOneWidget,
        reason: '末尾の写真（10:30）へ戻った');
    await tester.tap(find.text('再試行').hitTestable());
    await letFramesRun(tester);
    expect(find.text('続きを読み込めませんでした').hitTestable(), findsNothing,
        reason: '「再試行」で続きを読めた');

    await _swipe(tester, toNext: true);

    expect(find.text('2026年10月5日 10:31').hitTestable(), findsOneWidget);
    semantics.dispose();
  });

  testWidgets('続きのページの読み込みに失敗していて、写真ビューアで読み込んだ末尾の写真を削除したら、続きを待つ間も「再試行」を出し、「再試行」で届いた次の写真へ移る',
      (tester) async {
    // 10:30 は読み込み済みの末尾だが、本当の末尾ではない（続きがある）。削除すると読み込み済みの写真を使い切り、続きを待つ（§4.6）
    final semantics = tester.ensureSemantics();
    final backend = _thirtyThreePhotosBackend();
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    backend.failNext(TripRoute.photos);
    await tester.drag(photoGridScroll(), const Offset(0, -5000));
    await letFramesRun(tester);
    await tester.tap(photoThumbnail('2026年10月5日 10:30'));
    await letFramesRun(tester);
    await tester.tap(
        find.descendant(of: find.byType(AppBar), matching: find.text('削除')));
    await letFramesRun(tester);
    await tapInDialog(tester, '削除');

    expect(find.byType(PageView), findsOneWidget);
    expect(find.text('続きを読み込めませんでした').hitTestable(), findsOneWidget);
    await tester.tap(find.text('再試行').hitTestable());
    await letFramesRun(tester);

    expect(_isOnScreen(tester, '2026年10月5日 10:31'), isTrue);
    expect(find.text('続きを読み込めませんでした').hitTestable(), findsNothing);
    semantics.dispose();
  });

  testWidgets('グリッドを下端まで送っていなくても、写真ビューアで読み込んだ末尾の写真まで来ると、一覧が次のページを読み、続けてスワイプできる',
      (tester) async {
    // 1ページ目は30枚（10:01〜10:30）、2ページ目は3枚（10:31〜10:33）。
    // グリッドは送らず、先頭の方の10:15を開く。グリッドが続きを読むのは末尾の6枚以内（10:25〜）を組み立てたときだけなので、
    // この時点で2ページ目は要求されていない
    final semantics = tester.ensureSemantics();
    final backend = _thirtyThreePhotosBackend();
    await openTripsTab(tester, backend);
    // 「まだ2ページ目を要求していない」を確かめるため、止める対象を2段にする。
    // 2ページ目の応答だけを止めておく形では、1ページ目を読んだ時点で既に2ページ目を要求していても、
    // 止める前に応答が済んでいれば「読み込み中...」が出ず、見逃す。
    // 偽のサーバは要求が届いた時点で holds を読むので、1ページ目（A）を止めている間に 2ページ目用の止め（B）に差し替え、
    // それから A を放す。1ページ目が済んだ後に出る要求は必ず B で止まり、末尾に「読み込み中...」が出る
    final releaseFirstPage = Completer<void>();
    final releaseSecondPage = Completer<void>();
    backend.holds[TripRoute.photos] = releaseFirstPage.future;
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    backend.holds[TripRoute.photos] = releaseSecondPage.future;
    releaseFirstPage.complete();
    await letFramesRun(tester);
    // 「写真」「タイムライン」の切り替え（03 §8.1）の分だけグリッドが下がり、10:15 は画面の下端の外にある。
    // 画面の下端に合うところまでだけ送る（上端まで送ると末尾の写真まで組み立て、グリッドが2ページ目を読んでしまう）
    await Scrollable.ensureVisible(tester.element(photoThumbnail('2026年10月5日 10:15')), alignment: 1);
    await tester.pump();
    expect(find.text('読み込み中...'), findsNothing);
    await tester.tap(photoThumbnail('2026年10月5日 10:15'));
    await letFramesRun(tester);
    expect(find.text('2026年10月5日 10:15').hitTestable(), findsOneWidget);
    releaseSecondPage.complete();
    await letFramesRun(tester);

    for (var i = 0; i < 15; i++) {
      await _swipe(tester, toNext: true);
    }

    expect(find.text('2026年10月5日 10:30').hitTestable(), findsOneWidget);

    await _swipe(tester, toNext: true);

    expect(find.text('2026年10月5日 10:31').hitTestable(), findsOneWidget);
    semantics.dispose();
  });

  testWidgets('写真ビューアを開いている間に旅行が無いと分かったら、ビューアを閉じて「この旅行は削除されています」を出す',
      (tester) async {
    // 1ページ目は30枚（10:01〜10:30）、2ページ目は3枚（10:31〜10:33）。
    // グリッドは送らずに10:15を開く（2ページ目は要求されていない。止め方は上のテストと同じ）。
    // 開いたあとで別の端末が旅行を消した状態にし、ビューアが末尾の10:30に来て読ませた続きのページで旅行が無いと分かる
    final semantics = tester.ensureSemantics();
    final backend = _thirtyThreePhotosBackend();
    await openTripsTab(tester, backend);
    final releaseFirstPage = Completer<void>();
    final releaseSecondPage = Completer<void>();
    backend.holds[TripRoute.photos] = releaseFirstPage.future;
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    backend.holds[TripRoute.photos] = releaseSecondPage.future;
    releaseFirstPage.complete();
    await letFramesRun(tester);
    // 「写真」「タイムライン」の切り替え（03 §8.1）の分だけグリッドが下がり、10:15 は画面の下端の外にある。
    // 画面の下端に合うところまでだけ送る（上端まで送ると末尾の写真まで組み立て、グリッドが2ページ目を読んでしまう）
    await Scrollable.ensureVisible(tester.element(photoThumbnail('2026年10月5日 10:15')), alignment: 1);
    await tester.pump();
    expect(find.text('読み込み中...'), findsNothing);
    await tester.tap(photoThumbnail('2026年10月5日 10:15'));
    await letFramesRun(tester);
    expect(find.byType(PageView), findsOneWidget);
    releaseSecondPage.complete();
    backend.trips.clear();

    for (var i = 0; i < 14; i++) {
      await _swipe(tester, toNext: true);
    }
    expect(find.text('2026年10月5日 10:29').hitTestable(), findsOneWidget);

    await _swipe(tester, toNext: true);

    expect(find.byType(PageView), findsNothing);
    expect(find.text('この旅行は削除されています'), findsOneWidget);
    semantics.dispose();
  });

  testWidgets('続きのページが残っているとき、写真ビューアで読み込んだ末尾の写真を削除しても一覧へ戻らず、続きを読んで次の写真へ移る',
      (tester) async {
    // 1ページ目は30枚（10:01〜10:30）、2ページ目は3枚（10:31〜10:33）。
    // 10:30 は読み込み済みの末尾だが、本当の末尾ではない（続きがある）。
    // 2ページ目の応答を止めたまま 10:30 を開いて削除を確定し、確定のあとで放す。
    // 止めている間にどの写真を出すかは固定せず、放したあとに 10:31 が画面に出ていることだけを見る。
    // 2ページ目は削除より前に届いた要求なので、中身は届いた時点で決める（holdNextReply）。
    // 応答だけを止めて、削除の確定より後に放す
    final semantics = tester.ensureSemantics();
    final backend = _thirtyThreePhotosBackend();
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    final release = backend.holdNextReply(TripRoute.photos);
    await tester.drag(photoGridScroll(), const Offset(0, -5000));
    await letFramesRun(tester);
    await tester.tap(photoThumbnail('2026年10月5日 10:30'));
    await letFramesRun(tester);
    expect(find.text('2026年10月5日 10:30').hitTestable(), findsOneWidget);
    await tester.tap(
        find.descendant(of: find.byType(AppBar), matching: find.text('削除')));
    await letFramesRun(tester);

    await tapInDialog(tester, '削除');

    expect(find.byType(PageView), findsOneWidget);
    release.complete();
    await letFramesRun(tester);
    expect(find.byType(PageView), findsOneWidget);
    expect(_isOnScreen(tester, '2026年10月5日 10:31'), isTrue);
    expect(_isOnScreen(tester, '2026年10月5日 10:30'), isFalse);
    semantics.dispose();
  });

  testWidgets('写真ビューアで削除して後ろの写真が読み込み済みの末尾に詰まったら、一覧が次のページを読み、続けてスワイプできる',
      (tester) async {
    // 1ページ目は30枚（10:01〜10:30）、2ページ目は3枚（10:31〜10:33）。
    // グリッドは送らずに10:15を開き、末尾から2枚目の10:29まで進む。10:29は読み込み済みの末尾ではないので、まだ続きは読まれない。
    // 10:29を削除すると10:30が今の位置に詰まって読み込み済みの末尾になるが、ページの位置は変わらない。
    // 2ページ目の止め方は上のテストと同じ（1ページ目の止めを2ページ目の止めに差し替える）。
    // 2ページ目の要求は削除のあとに届く。続きは並び順の位置から返るので、前の写真を消しても飛ばさず、
    // 次に出る写真は10:31になる
    final semantics = tester.ensureSemantics();
    final backend = _thirtyThreePhotosBackend();
    final releaseFirstPage = Completer<void>();
    final releaseSecondPage = Completer<void>();
    backend.holds[TripRoute.photos] = releaseFirstPage.future;
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    backend.holds[TripRoute.photos] = releaseSecondPage.future;
    releaseFirstPage.complete();
    await letFramesRun(tester);
    // 「写真」「タイムライン」の切り替え（03 §8.1）の分だけグリッドが下がり、10:15 は画面の下端の外にある。
    // 画面の下端に合うところまでだけ送る（上端まで送ると末尾の写真まで組み立て、グリッドが2ページ目を読んでしまう）
    await Scrollable.ensureVisible(tester.element(photoThumbnail('2026年10月5日 10:15')), alignment: 1);
    await tester.pump();
    await tester.tap(photoThumbnail('2026年10月5日 10:15'));
    await letFramesRun(tester);
    for (var i = 0; i < 14; i++) {
      await _swipe(tester, toNext: true);
    }
    expect(find.text('2026年10月5日 10:29').hitTestable(), findsOneWidget);
    // 前提の確認（検証ではない）。ビューアは不透明なルートで下のグリッドが画面外になり、
    // `find.text('読み込み中...')` では見えない。2ページ目の要求が届いた数で、まだ読まれていないことを確かめる。
    // 既に要求されていると、削除の後に読まれたのかが区別できず、テストが何も守らなくなる
    expect(backend.photoPagesReceived, 1);
    await tester.tap(
        find.descendant(of: find.byType(AppBar), matching: find.text('削除')));
    await letFramesRun(tester);
    await tapInDialog(tester, '削除');
    expect(_isOnScreen(tester, '2026年10月5日 10:30'), isTrue);
    releaseSecondPage.complete();
    await letFramesRun(tester);

    await _swipe(tester, toNext: true);

    expect(_isOnScreen(tester, '2026年10月5日 10:31'), isTrue);
    semantics.dispose();
  });

  testWidgets('写真ビューアで画面をタップすると上のバーと下の情報が消え、もう一度タップすると出る', (tester) async {
    // 上のバーは戻るボタンで見る（「削除」も同じバーにあり、同時に消える）。
    // 消えたことは、タップを受け取れる位置に無いこと（hitTestable）で確かめる
    final semantics = tester.ensureSemantics();
    final tapped = photoJson(
        number: 1, tripId: hokkaidoTripId, takenAt: '2026-10-05T12:30:15')
      ..['location'] = {
        'latitude': 43.7706,
        'longitude': 142.365,
        'placeName': '北海道旭川市',
        'placeSource': 'device'
      };
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 1)],
      functionKey: 'test-key',
      photosByTripId: {
        hokkaidoTripId: [tapped],
      },
    );
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    await tester.tap(photoThumbnail('2026年10月5日 12:30'));
    await letFramesRun(tester);
    expect(find.text('2026年10月5日 12:30').hitTestable(), findsOneWidget);
    expect(find.text('北海道旭川市').hitTestable(), findsOneWidget);
    expect(find.byType(BackButton).hitTestable(), findsOneWidget);

    await tester.tap(find.byType(PageView));
    await letFramesRun(tester);

    expect(find.text('2026年10月5日 12:30').hitTestable(), findsNothing);
    expect(find.text('北海道旭川市').hitTestable(), findsNothing);
    expect(find.byType(BackButton).hitTestable(), findsNothing);

    await tester.tap(find.byType(PageView));
    await letFramesRun(tester);

    expect(find.text('2026年10月5日 12:30').hitTestable(), findsOneWidget);
    expect(find.text('北海道旭川市').hitTestable(), findsOneWidget);
    expect(find.byType(BackButton).hitTestable(), findsOneWidget);
    semantics.dispose();
  });

  testWidgets('写真ビューアの「削除」で確認ダイアログを出し、確定すると写真を消して「写真を削除しました」を出し、次の写真へ移る',
      (tester) async {
    // 上のバーとダイアログのボタンはどちらも「削除」なので、AppBar / AlertDialog の中に絞って探す
    final semantics = tester.ensureSemantics();
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 3)],
      functionKey: 'test-key',
      photosByTripId: {
        hokkaidoTripId: [
          photoJson(
              number: 1,
              tripId: hokkaidoTripId,
              takenAt: '2026-10-05T12:30:15'),
          photoJson(
              number: 2,
              tripId: hokkaidoTripId,
              takenAt: '2026-10-06T10:15:00'),
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
    await tester.tap(photoThumbnail('2026年10月6日 10:15'));
    await letFramesRun(tester);
    await tester.tap(
        find.descendant(of: find.byType(AppBar), matching: find.text('削除')));
    await letFramesRun(tester);
    final dialog = find.byType(AlertDialog);
    expect(find.descendant(of: dialog, matching: find.text('写真を削除')),
        findsOneWidget);
    expect(
        find.descendant(
            of: dialog, matching: find.text('この写真を削除しますか？\nこの操作は元に戻せません。')),
        findsOneWidget);
    expect(find.descendant(of: dialog, matching: find.text('キャンセル')),
        findsOneWidget);

    await tapInDialog(tester, '削除');

    expect(
        backend.photosByTripId[hokkaidoTripId]!
            .map((photo) => photo['takenAt']),
        ['2026-10-05T12:30:15', '2026-10-07T18:45:00']);
    expect(find.text('写真を削除しました'), findsOneWidget);
    // 下の情報は「写真を削除しました」のスナックバーに覆われるので、hitTestable では見ない。
    // 画面の中にあるのが次の写真（10/7）で、前の写真（10/5）でも削除した写真（10/6）でもないことを位置で見る
    expect(_isOnScreen(tester, '2026年10月7日 18:45'), isTrue);
    expect(_isOnScreen(tester, '2026年10月5日 12:30'), isFalse);
    expect(_isOnScreen(tester, '2026年10月6日 10:15'), isFalse);
    semantics.dispose();
  });

  testWidgets('写真ビューアで最後の1枚を削除すると、「写真を削除しました」を出して旅行詳細へ戻り、一覧からその写真が消える',
      (tester) async {
    // 次の写真が無いので、前の写真に留まらず一覧へ戻る。
    // ビューアが閉じたことは PageView（ビューアだけが持つ）が無いことで見る
    final semantics = tester.ensureSemantics();
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 2)],
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
              takenAt: '2026-10-07T18:45:00'),
        ],
      },
    );
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    await tester.tap(photoThumbnail('2026年10月7日 18:45'));
    await letFramesRun(tester);
    await tester.tap(
        find.descendant(of: find.byType(AppBar), matching: find.text('削除')));
    await letFramesRun(tester);

    await tapInDialog(tester, '削除');

    expect(find.byType(PageView), findsNothing);
    expect(find.text('北海道 2026秋'), findsOneWidget);
    expect(photoThumbnail('2026年10月6日 10:15'), findsOneWidget);
    expect(photoThumbnail('2026年10月7日 18:45'), findsNothing);
    expect(find.text('写真を削除しました'), findsOneWidget);
    semantics.dispose();
  });

  testWidgets('写真ビューアで削除を確定したとき、その写真が既に無くて404が返っても、成功と同じ扱いで次の写真へ移る',
      (tester) async {
    // 別の端末で先に消された状況。偽のサーバは無い写真の削除に 404 PHOTO_NOT_FOUND を返す
    final semantics = tester.ensureSemantics();
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 3)],
      functionKey: 'test-key',
      photosByTripId: {
        hokkaidoTripId: [
          photoJson(
              number: 1,
              tripId: hokkaidoTripId,
              takenAt: '2026-10-05T12:30:15'),
          photoJson(
              number: 2,
              tripId: hokkaidoTripId,
              takenAt: '2026-10-06T10:15:00'),
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
    await tester.tap(photoThumbnail('2026年10月6日 10:15'));
    await letFramesRun(tester);
    await tester.tap(
        find.descendant(of: find.byType(AppBar), matching: find.text('削除')));
    await letFramesRun(tester);
    backend.photosByTripId[hokkaidoTripId]!.removeAt(1);

    await tapInDialog(tester, '削除');

    expect(find.byType(AlertDialog), findsNothing);
    expect(find.text('写真を削除しました'), findsOneWidget);
    // 下の情報はスナックバーに覆われるので、hitTestable では見ず、位置で見る
    expect(_isOnScreen(tester, '2026年10月7日 18:45'), isTrue);
    expect(_isOnScreen(tester, '2026年10月5日 12:30'), isFalse);
    expect(_isOnScreen(tester, '2026年10月6日 10:15'), isFalse);
    semantics.dispose();
  });

  testWidgets('写真ビューアで削除に失敗したら、ビューアに留まって写真を残し、エラーの文言を出す', (tester) async {
    // 失敗しても確認ダイアログは開いたまま（もう一度確定するか、キャンセルできる）
    final semantics = tester.ensureSemantics();
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 3)],
      functionKey: 'test-key',
      photosByTripId: {
        hokkaidoTripId: [
          photoJson(
              number: 1,
              tripId: hokkaidoTripId,
              takenAt: '2026-10-05T12:30:15'),
          photoJson(
              number: 2,
              tripId: hokkaidoTripId,
              takenAt: '2026-10-06T10:15:00'),
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
    await tester.tap(photoThumbnail('2026年10月6日 10:15'));
    await letFramesRun(tester);
    await tester.tap(
        find.descendant(of: find.byType(AppBar), matching: find.text('削除')));
    await letFramesRun(tester);
    backend.failNext(TripRoute.deletePhoto);

    await tapInDialog(tester, '削除');

    expect(find.text('サービスに一時的に接続できません。しばらく待ってから再試行してください。'), findsOneWidget);
    expect(
        backend.photosByTripId[hokkaidoTripId]!
            .map((photo) => photo['takenAt']),
        ['2026-10-05T12:30:15', '2026-10-06T10:15:00', '2026-10-07T18:45:00']);
    expect(find.text('写真を削除しました'), findsNothing);
    expect(find.byType(AlertDialog), findsOneWidget);
    expect(find.byType(PageView), findsOneWidget);
    expect(find.text('2026年10月6日 10:15'), findsOneWidget);
    semantics.dispose();
  });

  testWidgets('写真ビューアから戻ると、削除していなくても写真の一覧と見出しの枚数を読み直す', (tester) async {
    // ビューアを開いている間に、別の端末で写真が1枚増えた状況
    final semantics = tester.ensureSemantics();
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 2)],
      functionKey: 'test-key',
      photosByTripId: {
        hokkaidoTripId: [
          photoJson(
              number: 1,
              tripId: hokkaidoTripId,
              takenAt: '2026-10-05T12:30:15'),
          photoJson(
              number: 2,
              tripId: hokkaidoTripId,
              takenAt: '2026-10-06T10:15:00'),
        ],
      },
    );
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('2枚 · 2026/10/05 〜 2026/10/08'), findsOneWidget);
    await tester.tap(photoThumbnail('2026年10月5日 12:30'));
    await letFramesRun(tester);
    backend.photosByTripId[hokkaidoTripId]!.add(photoJson(
        number: 3, tripId: hokkaidoTripId, takenAt: '2026-10-07T18:45:00'));
    backend.trips.single['photoCount'] = 3;

    await tapBack(tester);
    await letFramesRun(tester);

    expect(find.text('3枚 · 2026/10/05 〜 2026/10/08'), findsOneWidget);
    expect(photoThumbnail('2026年10月7日 18:45'), findsOneWidget);
    semantics.dispose();
  });

  testWidgets('旅行に属さない写真の画面でも、写真をタップするとビューアが開き、戻ると一覧と枚数を読み直す', (tester) async {
    // §4.5: 旅行詳細と同じ部品なので、ビューアも戻ったときの読み直しも同じ。
    // 見出しの枚数は旅行の一覧（GET /api/trips）の unassignedPhotoCount から取り直す。
    // ビューアを開いている間に、別の端末で旅行に属さない写真が1枚増えた状況
    final semantics = tester.ensureSemantics();
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip()],
      unassignedPhotoCount: 2,
      photosByTripId: {
        'none': [
          photoJson(number: 1, takenAt: '2026-09-01T10:15:00'),
          photoJson(number: 2, takenAt: '2026-09-02T12:30:00'),
        ],
      },
    );
    await openTripsTab(tester, backend);
    await tester.tap(find.text('旅行に属さない写真'));
    await letFramesRun(tester);
    expect(find.text('2枚'), findsOneWidget);
    await tester.tap(photoThumbnail('2026年9月2日 12:30'));
    await letFramesRun(tester);
    expect(find.text('2026年9月2日 12:30').hitTestable(), findsOneWidget);
    backend.photosByTripId['none']!
        .add(photoJson(number: 3, takenAt: '2026-09-03T18:45:00'));
    backend.unassignedPhotoCount = 3;

    await tapBack(tester);
    await letFramesRun(tester);

    expect(find.text('3枚'), findsOneWidget);
    expect(photoThumbnail('2026年9月3日 18:45'), findsOneWidget);
    semantics.dispose();
  });
}
