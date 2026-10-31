import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:snaplant_mobile/screens/trip_detail_screen.dart';

import '../helpers/app_test_helpers.dart';
import '../helpers/gallery_test_helpers.dart';
import '../helpers/trip_test_helpers.dart';
import '../helpers/upload_test_helpers.dart';

// 送信の進み具合バナーと完了の知らせ（docs/03_screen_design.md §4.7.4）を、利用者から見た振る舞いで確かめる。
// 「送信中 N/M」、失敗の行とその理由、「N枚を送信しました」、画面ごとに数える宛先、旅行が無いと分かった画面のバナー。
// 送信の状態はアプリの根が持つので、アプリ全体を開いて旅行一覧から旅行詳細へ進む。旅行の API は偽のサーバ（helpers の FakeTripBackend）、
// OS のギャラリーは端末の機能なので偽物に差し替える。共有の補助は helpers/upload_test_helpers.dart
// 画像の圧縮は差し替えない（テスト環境では未登録で例外になり、サムネイル無しで送る経路を通る）。サムネイルを付けて送ることは upload_prepare_test.dart が見る

void main() {
  testWidgets('2枚を送っている間は、旅行詳細の上部に「送信中 0/2」を出し、1枚の応答が返ると「送信中 1/2」に変わり、2枚目の応答が返るとバナーを消して「2枚を送信しました」と知らせる', (tester) async {
    // 偽のサーバは、届いた2回の送信の応答をそれぞれ保留する（同時に2本送られる）。届いた時点で写真は偽のサーバに入っている。
    // 応答を返すと完了と数える
    final first = writeTestImage('first.png');
    final second = writeTestImage('second.png', bytes: [...tinyPngBytes, 0]);
    useGalleryReturning([first, second]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    final firstReply = backend.holdNextReply(TripRoute.upload);
    final secondReply = backend.holdNextReply(TripRoute.upload);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.textContaining('送信中'), findsNothing);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, hokkaidoTripId, count: 2);
    await letFramesRun(tester);

    expect(backend.photosByTripId[hokkaidoTripId]!.length, 2);
    expect(find.text('送信中 0/2'), findsOneWidget);

    firstReply.complete();
    await letFramesRun(tester);

    expect(find.text('送信中 1/2'), findsOneWidget);

    secondReply.complete();
    await letFramesRun(tester);

    expect(find.textContaining('送信中'), findsNothing);
    expect(find.text('2枚を送信しました'), findsOneWidget);
  });

  testWidgets('最初の1枚の送信が残りの準備より先に終わっても、準備中の写真が残っている間は「N枚を送信しました」と知らせず、全部が終わってから「100枚を送信しました」を1回だけ知らせる', (tester) async {
    // 今回は1枚目の応答を保留しないので、1枚目の送信は準備が終わる前に終わる。準備中の写真が残っているので、送信の区切りにはならない。
    // 1枚目の送信が終わった時点で送信の列が空になるよう、2枚目だけは 16MB のファイルにする（準備に数百ミリ秒かかる。残りの98枚は小さく、準備の終わりはさらに遅れる）
    final files = writeTestImages(manyPhotos);
    final medium = writeTestImage('medium.png', bytes: Uint8List(16 * 1024 * 1024));
    useGalleryReturning([files.first, medium, ...files.skip(2)]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, hokkaidoTripId);
    await letFramesRun(tester);

    expect(preparingBanner(manyPhotos), findsOneWidget);
    expect(find.textContaining('を送信しました'), findsNothing);

    await waitUntilFound(tester, find.text('100枚を送信しました'), step: const Duration(milliseconds: 1));

    expect(find.text('100枚を送信しました'), findsOneWidget);
    expect(find.textContaining('を送信しました'), findsOneWidget);
  });

  testWidgets('送信がサーバの 413（ファイルが大きすぎる）で失敗すると、バナーはサーバが返した文言を理由に添えて「1枚を送信できませんでした（ファイルサイズが大きすぎます）」を出す', (tester) async {
    // 500・503 などは固定の文言、それ以外のステータスはサーバの `message` が理由になる（`ApiException.userMessage`）。413 は送り直しの対象ではない
    final image = writeTestImage('hokkaido.png');
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    backend.failNext(TripRoute.upload, status: 413, code: 'FILE_TOO_LARGE', message: 'ファイルサイズが大きすぎます');
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 1);
    await waitRealTime(tester);
    await letFramesRun(tester);

    expect(find.text('1枚を送信できませんでした（ファイルサイズが大きすぎます）'), findsOneWidget);
  });

  testWidgets('送った2枚のうち1枚が、別の旅行に送信済みの写真（200）なら、「2枚を送信しました（1枚は送信済みでした。別の旅行か、旅行に属さない写真にあります）」と知らせ、北海道には新しい1枚だけが入る', (tester) async {
    // 写真の id は画像の SHA-256 なので、同じ写真は何度送っても1枚になる。偽のサーバは、既にある id には 200 で既存の写真（京都にある）を返す。
    // 送信済みの1枚も、送れた枚数（2枚）に数える
    final alreadySent = writeTestImage('already_sent.png');
    final fresh = writeTestImage('fresh.png', bytes: [...tinyPngBytes, 0]);
    useGalleryReturning([alreadySent, fresh]);
    final backend = FakeTripBackend(
      trips: [
        tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0),
        tripJson(id: kyotoTripId, name: '京都', photoCount: 1),
      ],
      photosByTripId: {
        kyotoTripId: [photoJson(number: 0, tripId: kyotoTripId)..['id'] = tinyPngSha256],
      },
    );
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, hokkaidoTripId);
    await letFramesRun(tester);

    expect(backend.photosByTripId[hokkaidoTripId]!.length, 1);
    expect(backend.photosByTripId[kyotoTripId]!.length, 1);
    await pumpUntilFound(tester, find.textContaining('を送信しました'));
    expect(find.text('2枚を送信しました（1枚は送信済みでした。別の旅行か、旅行に属さない写真にあります）'), findsOneWidget);
  });

  testWidgets('旅行が無いと分かった画面でも、この旅行宛ての送信の失敗のバナーは出したままにし、「閉じる」で消せる', (tester) async {
    // 先に送信が 404（旅行が見つかりません）で失敗し、そのあと下に引っ張った読み直しで写真の一覧も 404 になって、画面が「この旅行は削除されています」になる。
    // 順は決まっている（送信の失敗を見届けてから読み直す）。画面設計 §4.7.4: 送れなかった写真を「閉じる」で片付けられるよう、バナーは出したままにする
    final image = writeTestImage('hokkaido.png');
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);
    backend.trips.clear();
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 1);
    await letFramesRun(tester);
    expect(find.text('1枚を送信できませんでした（旅行が見つかりません）'), findsOneWidget);

    await tester.drag(find.byType(RefreshIndicator), const Offset(0, 600));
    await letFramesRun(tester);

    expect(find.text('この旅行は削除されています'), findsOneWidget);
    expect(find.text('1枚を送信できませんでした（旅行が見つかりません）'), findsOneWidget);
    expect(find.text('閉じる'), findsOneWidget);
    await tester.tap(find.text('閉じる'));
    await letFramesRun(tester);
    expect(find.textContaining('送信できませんでした'), findsNothing);
  });

  testWidgets('2枚が別の理由で失敗したときは、バナーに後に失敗した方の理由を添える（先に 413、後に 500 なら、500 の理由）', (tester) async {
    // 同時に送る2枚の応答を保留し、先に 413 の応答を返してから、500 の応答を返す。失敗の順は、応答を返した順で決まる
    final first = writeTestImage('first.png');
    final second = writeTestImage('second.png', bytes: [...tinyPngBytes, 0]);
    useGalleryReturning([first, second]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    backend.failNext(TripRoute.upload, status: 413, code: 'FILE_TOO_LARGE', message: 'ファイルサイズが大きすぎます');
    backend.failNext(TripRoute.upload, status: 500, code: 'INTERNAL_ERROR', message: '写真の保存に失敗しました');
    final tooLargeReply = backend.holdNextReply(TripRoute.upload);
    final serverErrorReply = backend.holdNextReply(TripRoute.upload);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 2);
    await letFramesRun(tester);
    tooLargeReply.complete();
    await letFramesRun(tester);

    serverErrorReply.complete();
    await letFramesRun(tester);

    expect(find.text('2枚を送信できませんでした（$serverErrorMessage）'), findsOneWidget);
  });

  testWidgets('2枚のうち1枚の送信がサーバの失敗（500）になると、送れた1枚だけを「1枚を送信しました」と知らせ、バナーに「1枚を送信できませんでした」と「送り直す」「閉じる」を出す。「閉じる」を押すと、バナー（「送り直す」も）が消え、失敗した写真は送られないまま', (tester) async {
    // 500 は自動の送り直しの対象ではない（通信の失敗・429・503 だけが対象）。どちらの1枚が失敗するかは問わず、届いた枚数で見る。
    // 「閉じる」は失敗した項目を列から消すだけで、端末の写真は消えない（選び直せば送れる）
    final first = writeTestImage('first.png');
    final second = writeTestImage('second.png', bytes: [...tinyPngBytes, 0]);
    useGalleryReturning([first, second]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    backend.failNext(TripRoute.upload, status: 500, code: 'INTERNAL_ERROR', message: '写真の保存に失敗しました');
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, hokkaidoTripId);
    await letFramesRun(tester);

    expect(backend.photosByTripId[hokkaidoTripId]!.length, 1);
    expect(find.text('1枚を送信できませんでした（$serverErrorMessage）'), findsOneWidget);
    expect(find.text('送り直す'), findsOneWidget);
    expect(find.text('閉じる'), findsOneWidget);
    expect(find.text('1枚を送信しました'), findsOneWidget);

    await tester.tap(find.text('閉じる'));
    await letFramesRun(tester);

    expect(find.textContaining('送信できませんでした'), findsNothing);
    expect(find.text('送り直す'), findsNothing);
    expect(find.text('閉じる'), findsNothing);
    expect(find.textContaining('送信中'), findsNothing);
    expect(backend.photosByTripId[hokkaidoTripId]!.length, 1);
  });

  testWidgets('2枚とも送信がサーバの失敗（500）になると、送れた分が無いので知らせは出さず、バナーに「2枚を送信できませんでした」を出し、「送り直す」で2枚とも届いてバナーが消え、「2枚を送信しました」と知らせる', (tester) async {
    // 送れた分が0枚の間は「N枚を送信しました」を出さない。送り直しで全部届いたときに初めて出る
    final first = writeTestImage('first.png');
    final second = writeTestImage('second.png', bytes: [...tinyPngBytes, 0]);
    useGalleryReturning([first, second]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    backend.failNext(TripRoute.upload, status: 500, code: 'INTERNAL_ERROR', message: '写真の保存に失敗しました');
    backend.failNext(TripRoute.upload, status: 500, code: 'INTERNAL_ERROR', message: '写真の保存に失敗しました');
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 2);
    await letFramesRun(tester);
    expect(find.text('2枚を送信できませんでした（$serverErrorMessage）'), findsOneWidget);
    expect(find.textContaining('を送信しました'), findsNothing);
    expect(backend.photosByTripId[hokkaidoTripId] ?? [], isEmpty);

    await tester.tap(find.text('送り直す'));
    await waitUntilUploaded(tester, backend, hokkaidoTripId, count: 2);
    await letFramesRun(tester);

    expect(find.text('送り直す'), findsNothing);
    expect(find.textContaining('送信できませんでした'), findsNothing);
    expect(find.text('2枚を送信しました'), findsOneWidget);
  });

  testWidgets('京都宛ての写真100枚を準備している間に北海道の詳細を開いても、「写真を準備中」は出ない（旅行一覧は全体を数えるので、戻ると「写真を準備中... k/100」が出る）', (tester) async {
    // 最初の送信の要求が届いた時点で一覧へ戻る。準備はまだ続いている（準備が終わるとバナーは消える）
    useGalleryReturning(writeTestImages(manyPhotos));
    final backend = FakeTripBackend(trips: [
      tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0),
      tripJson(id: kyotoTripId, name: '京都', photoCount: 0),
    ]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('京都'));
    await letFramesRun(tester);
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 1);
    await tapBack(tester);
    await letFramesRun(tester);
    expect(preparingBanner(manyPhotos), findsOneWidget);

    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);

    expect(find.byType(TripDetailScreen), findsOneWidget);
    expect(find.textContaining('写真を準備中'), findsNothing);
    // 否定が通るのは準備が終わったからではない（一覧に戻ると、準備はまだ続いている）
    await tapBack(tester);
    await letFramesRun(tester);
    expect(preparingBanner(manyPhotos), findsOneWidget);
  });

  testWidgets('京都宛ての写真を送っている間に北海道の詳細を開いても、バナーは出ない（旅行詳細は、その旅行宛ての分だけを数える）', (tester) async {
    // 旅行一覧は全体を数えるので、京都宛ての送信中は一覧に「送信中 0/1」が出る。北海道の詳細には、北海道宛ての項目が無いので出ない
    final image = writeTestImage('kyoto.png');
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [
      tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0),
      tripJson(id: kyotoTripId, name: '京都', photoCount: 0),
    ]);
    final reply = backend.holdNextReply(TripRoute.upload);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('京都'));
    await letFramesRun(tester);
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, kyotoTripId);
    await letFramesRun(tester);
    await tapBack(tester);
    await letFramesRun(tester);
    expect(find.text('送信中 0/1'), findsOneWidget);

    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);

    expect(find.byType(TripDetailScreen), findsOneWidget);
    expect(find.textContaining('送信中'), findsNothing);
    reply.complete();
    await letFramesRun(tester);
  });

}
