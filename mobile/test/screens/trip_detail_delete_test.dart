
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:snaplant_mobile/screens/trip_detail_screen.dart';

import '../helpers/app_test_helpers.dart';
import '../helpers/gallery_test_helpers.dart';
import '../helpers/geocoding_test_helpers.dart';
import '../helpers/trip_test_helpers.dart';
import '../helpers/upload_test_helpers.dart';

// 旅行詳細の「削除」（docs/03_screen_design.md §4.4.3）のうち、この旅行宛ての送信があるときの振る舞いを確かめる。
// 送信を止めるかの確認、取り消した写真を送らず数えないこと、削除が失敗したときの扱い。
// §4.4.3 のほかのテスト（中の写真の扱い・削除のダイアログ）は、今は trip_detail_screen_test.dart にある（§4.4 を節ごとのファイルに分けるときにここへ寄せる）
// 送信の状態はアプリの根が持つので、アプリ全体を開いて旅行一覧から旅行詳細へ進む。旅行の API は偽のサーバ（helpers の FakeTripBackend）、
// ギャラリー・Geocoder・画像の圧縮は端末の機能なので偽物に差し替える。共有の補助は helpers/upload_test_helpers.dart

void main() {
  testWidgets('この旅行宛ての送信が進んでいる間に「削除」を選ぶと、旅行の削除の確認の前に「送信中の写真があります。送信を止めて削除しますか？」と確かめ、「キャンセル」なら何もせず、送信は続く', (tester) async {
    // 写真が0枚の旅行を使う（サーバの写真のサムネイルを出さないので、実時間を進めても path_provider が要らない）。応答は保留して送信中にする
    final image = writeTestImage('hokkaido.png');
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    final reply = backend.holdNextReply(TripRoute.upload);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 1);
    await letFramesRun(tester);

    await openDeleteDialog(tester);

    expect(inDialog(find.text('送信中の写真があります。送信を止めて削除しますか？')), findsOneWidget);
    expect(inDialog(find.text('キャンセル')), findsOneWidget);
    expect(inDialog(find.text('削除')), findsOneWidget);
    // 旅行の削除のダイアログ（0枚なら「「北海道 2026秋」を削除しますか？」）はまだ出ていない
    expect(find.textContaining('を削除しますか？'), findsNothing);
    expect(find.text('旅行を削除'), findsNothing);

    await tapInDialog(tester, 'キャンセル');

    expect(find.byType(Dialog), findsNothing);
    expect(find.byType(TripDetailScreen), findsOneWidget);
    expect(backend.deletePhotosSent, isEmpty);
    // 送信は続いている。止めていないので、応答が返れば完了と数える
    reply.complete();
    await letFramesRun(tester);
    expect(find.text('1枚を送信しました'), findsOneWidget);
  });

  testWidgets('送信を止めて削除すると、この旅行宛ての残りの写真は送らず、失敗にも完了の知らせにも数えない（送信中だった分の結果も、送り終えていた分も知らせず、失敗していた写真の「送信できませんでした」も旅行の一覧に残さない）', (tester) async {
    // 先に1枚が 500 で失敗している（自動では送り直さない）。そのあと4枚を選び、1枚目は送れていて、2枚目と3枚目は同時に送信中（応答を保留）、4枚目は送信待ち。
    // 写真が0枚の旅行なので、実時間を進めても path_provider は要らない
    final failed = writeTestImage('failed.png');
    final sent = writeTestImage('sent.png', bytes: [...tinyPngBytes, 0]);
    final sendingA = writeTestImage('sending_a.png', bytes: [...tinyPngBytes, 0, 0]);
    final sendingB = writeTestImage('sending_b.png', bytes: [...tinyPngBytes, 0, 0, 0]);
    final waiting = writeTestImage('waiting.png', bytes: [...tinyPngBytes, 0, 0, 0, 0]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    backend.failNext(TripRoute.upload, status: 500, code: 'INTERNAL_ERROR', message: '写真の保存に失敗しました');
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    useGalleryReturning([failed]);
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 1);
    await letFramesRun(tester);
    expect(find.textContaining('1枚を送信できませんでした'), findsOneWidget);
    backend.holdNextReply(TripRoute.upload).complete();
    final sendingReplyA = backend.holdNextReply(TripRoute.upload);
    final sendingReplyB = backend.holdNextReply(TripRoute.upload);
    useGalleryReturning([sent, sendingA, sendingB, waiting]);
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 4);
    await letFramesRun(tester);
    await openDeleteDialog(tester);
    await tapInDialog(tester, '削除');
    await tapInDialog(tester, '削除');
    expect(find.byType(TripDetailScreen), findsNothing);
    expect(find.textContaining('旅行を削除しました'), findsOneWidget);

    sendingReplyA.complete();
    sendingReplyB.complete();
    await waitRealTime(tester);
    await letFramesRun(tester);
    // スナックバーは順に出るので、「旅行を削除しました」が消えるまで進めてから、送信の知らせが出ていないことを見る
    await tester.pump(const Duration(seconds: 5));
    await letFramesRun(tester);

    expect(find.textContaining('旅行を削除しました'), findsNothing);
    expect(backend.uploadsReceived, 4);
    expect(find.textContaining('送信できませんでした'), findsNothing);
    expect(find.textContaining('枚を送信しました'), findsNothing);
  });

  testWidgets('送信を止めるかの確認で「削除」を選んでも、旅行の削除のダイアログで「キャンセル」したら、送信は続ける（残りの写真も送り、完了を知らせる）', (tester) async {
    // 3枚のうち2枚は同時に送信中（応答を保留）、3枚目は送信待ち。写真が0枚の旅行なので、実時間を進めても path_provider は要らない
    final first = writeTestImage('first.png');
    final second = writeTestImage('second.png', bytes: [...tinyPngBytes, 0]);
    final third = writeTestImage('third.png', bytes: [...tinyPngBytes, 0, 0]);
    useGalleryReturning([first, second, third]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    final firstReply = backend.holdNextReply(TripRoute.upload);
    final secondReply = backend.holdNextReply(TripRoute.upload);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 2);
    await letFramesRun(tester);
    await openDeleteDialog(tester);
    await tapInDialog(tester, '削除');
    expect(find.textContaining('を削除しますか？'), findsOneWidget);

    await tapInDialog(tester, 'キャンセル');

    expect(find.byType(Dialog), findsNothing);
    expect(find.byType(TripDetailScreen), findsOneWidget);
    expect(backend.deletePhotosSent, isEmpty);
    firstReply.complete();
    secondReply.complete();
    // 届いた写真は偽のサーバから取り除いておく（別の端末で消された状態）。取り除かないと、読み直した一覧にサムネイルが出て、
    // 実時間の待ちで画像のキャッシュが端末の機能（path_provider）を探して落ちる。画面は進めずに、実時間だけで3枚目の到着を待つ。
    // 取り除くと、見出しの枚数（photoCount）と実際の写真が食い違う状態になるが、これはサムネイルの画像を取りに行かせないための後始末で、この後は枚数を見ない
    await waitUntilUploaded(tester, backend, hokkaidoTripId, count: 3);
    backend.photosByTripId[hokkaidoTripId]!.clear();
    await letFramesRun(tester);
    expect(backend.uploadsReceived, 3);
    expect(find.text('3枚を送信しました'), findsOneWidget);
  });

  testWidgets('この旅行宛ての写真がサーバの失敗（500）で失敗しているだけなら、「削除」を選んでも送信を止める確認は出さず、旅行の削除のダイアログを出す', (tester) async {
    // 失敗した写真は自動では送り直されず、進行中の送信ではない（バナーの「送り直す」「閉じる」は利用者が選ぶ）
    final image = writeTestImage('hokkaido.png');
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    backend.failNext(TripRoute.upload, status: 500, code: 'INTERNAL_ERROR', message: '写真の保存に失敗しました');
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 1);
    await letFramesRun(tester);
    expect(find.text('1枚を送信できませんでした（$serverErrorMessage）'), findsOneWidget);

    await openDeleteDialog(tester);

    expect(find.text('送信中の写真があります。送信を止めて削除しますか？'), findsNothing);
    expect(find.textContaining('を削除しますか？'), findsOneWidget);
  });

  testWidgets('写真を準備中のあいだも、この旅行宛ての送信が進んでいるものとして、「削除」を選ぶと旅行の削除の前に「送信中の写真があります。送信を止めて削除しますか？」と確かめる。準備中に送信を止めて削除したら、準備が済んでもその写真は送らず、失敗にも完了の知らせにも数えず、残りの写真の準備をやめて旅行一覧に「写真を準備中」を出さない', (tester) async {
    // 準備を止める: 位置情報のある写真の Geocoder が固まる（5秒の時間切れまで準備中のまま。フェイクの時間で進める）。まだ1枚も送信の列に入っていない。
    // 3枚は中身（座標）を変えて、別の写真にする。準備中に削除を確定し、そのあとで1枚目の準備を済ませる（地名の時間切れ）
    final geocoding = useFakeGeocoding(hangs: true);
    useGalleryReturning([
      writeTestImage('nagano1.jpg', bytes: exifJpegBytes(latitude: [36, 39, 0], longitude: [138, 11, 0])),
      writeTestImage('nagano2.jpg', bytes: exifJpegBytes(latitude: [36, 40, 0], longitude: [138, 12, 0])),
      writeTestImage('nagano3.jpg', bytes: exifJpegBytes(latitude: [36, 41, 0], longitude: [138, 13, 0])),
    ]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    await tester.tap(find.text('写真を追加'));
    await waitUntilLookedUp(tester, geocoding, 1);
    await tester.pump();
    expect(backend.uploadsReceived, 0);

    await openDeleteDialog(tester);

    expect(inDialog(find.text('送信中の写真があります。送信を止めて削除しますか？')), findsOneWidget);
    expect(find.textContaining('を削除しますか？'), findsNothing);

    await tapInDialog(tester, '削除');
    await tapInDialog(tester, '削除');
    expect(find.byType(TripDetailScreen), findsNothing);
    expect(find.textContaining('旅行を削除しました'), findsOneWidget);

    await tester.pump(const Duration(seconds: 5));
    await waitRealTime(tester);
    // スナックバーは順に出るので、「旅行を削除しました」が消えるまで進めてから、送信の知らせが出ていないことを見る
    await tester.pump(const Duration(seconds: 5));
    await letFramesRun(tester);

    expect(find.textContaining('旅行を削除しました'), findsNothing);
    expect(backend.uploadsReceived, 0);
    expect(find.textContaining('送信できませんでした'), findsNothing);
    expect(find.textContaining('枚を送信しました'), findsNothing);
    expect(preparingBanner(3), findsNothing);
    // 残りの2枚は準備しない（地名を引くのは、削除の前に準備を始めていた1枚目だけ）
    expect(geocoding.lookups, hasLength(1));
    // 後片付け: 残りの準備があっても時間切れのタイマーをテストの終わりに残さない
    await tester.pump(const Duration(seconds: 5));
    await waitRealTime(tester);
    await tester.pump(const Duration(seconds: 5));
    await waitRealTime(tester);
  });

  testWidgets('送り直しを待っている写真があるときに送信を止めて削除したら、待ちが過ぎても送り直さない', (tester) async {
    // 1回目が 503 で失敗して2秒の待ちに入る。待ちの間（2秒より手前）に削除を確定する。
    // openDeleteDialog や tapInDialog は画面を1.5秒ずつ進めて待ちを過ぎてしまうので、ここでは300ミリ秒ずつ進める
    final image = writeTestImage('hokkaido.png');
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    backend.failNext(TripRoute.upload);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    await tester.tap(find.text('写真を追加'));
    await letUploadFail(tester, backend, 1);

    await tester.tap(find.byIcon(Icons.more_vert));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    await tester.tap(find.text('旅行を削除'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    await tester.tap(inDialog(find.text('削除')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    await tester.tap(inDialog(find.text('削除')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    await tester.pump(const Duration(seconds: 3));
    expect(find.byType(TripDetailScreen), findsNothing);
    await waitRealTime(tester);

    expect(backend.uploadsReceived, 1);
  });

  testWidgets('旅行の削除が失敗したら、送信の取り消しを解き、取り消した送信中の写真は回転する印のマスに残さず送信中とも数えず、その後にこの旅行へ追加した写真は送る', (tester) async {
    // 1枚目は送信中（応答を保留）。削除の要求を 503 で失敗させて詳細に留まる。取り消した写真は戻らず、取り消しを解かれたあとで追加する2枚目は送られる。
    // 写真が0枚の旅行なので、実時間を進めても path_provider は要らない
    final first = writeTestImage('first.png');
    final second = writeTestImage('second.png', bytes: [...tinyPngBytes, 0]);
    useGalleryReturning([first]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    final firstReply = backend.holdNextReply(TripRoute.upload);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 1);
    await letFramesRun(tester);
    backend.failNext(TripRoute.delete);
    await openDeleteDialog(tester);
    await tapInDialog(tester, '削除');
    await tapInDialog(tester, '削除');
    expect(find.byType(TripDetailScreen), findsOneWidget);
    await tapInDialog(tester, 'キャンセル');

    expect(find.byType(CircularProgressIndicator), findsNothing);
    expect(find.text('送信中 0/1'), findsNothing);
    expect(find.text('まだ写真がありません'), findsOneWidget);
    // 取り消し済みなので、もう一度「削除」を選んでも送信の確認は出ず、旅行の削除のダイアログが出る
    await openDeleteDialog(tester);
    expect(find.text('送信中の写真があります。送信を止めて削除しますか？'), findsNothing);
    expect(find.textContaining('を削除しますか？'), findsOneWidget);
    await tapInDialog(tester, 'キャンセル');

    // 1枚目の結果は取り消し済みなので知らされない。届いた写真は偽のサーバから取り除いておく（サムネイルを出さない）
    backend.photosByTripId[hokkaidoTripId]!.clear();
    firstReply.complete();
    await waitRealTime(tester);
    await letFramesRun(tester);
    // スナックバーは順に出るので、削除の失敗の知らせが消えるまで進める
    await tester.pump(const Duration(seconds: 5));
    await letFramesRun(tester);
    useGalleryReturning([second]);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, hokkaidoTripId);
    // 見出しの枚数（photoCount）と実際の写真が食い違う状態になるが、サムネイルの画像を取りに行かせないための後始末で、この後は枚数を見ない
    backend.photosByTripId[hokkaidoTripId]!.clear();
    await letFramesRun(tester);

    expect(backend.uploadsReceived, 2);
    expect(find.text('1枚を送信しました'), findsOneWidget);
  });

  testWidgets('送り直しを待っていた写真を取り消した後に削除が失敗しても、その写真は送らない', (tester) async {
    // 1回目が 503 で失敗して2秒の待ちに入る。待ちの間（2秒より手前）に削除を確定し、削除の要求も 503 で失敗させる。
    // 失敗が待ちの明ける前に起きていることは、組み立ての途中で確かめる（openDeleteDialog や tapInDialog は1.5秒ずつ進めて待ちを過ぎてしまうので、300ミリ秒ずつ進める）
    final image = writeTestImage('hokkaido.png');
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    backend.failNext(TripRoute.upload);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    await tester.tap(find.text('写真を追加'));
    await letUploadFail(tester, backend, 1);
    backend.failNext(TripRoute.delete);

    await tester.tap(find.byIcon(Icons.more_vert));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    await tester.tap(find.text('旅行を削除'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    await tester.tap(inDialog(find.text('削除')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    await tester.tap(inDialog(find.text('削除')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    // 削除の失敗が表示され、まだ送り直しの待ちが明けていない（2回目の要求は届いていない）
    expect(find.byType(TripDetailScreen), findsOneWidget);
    expect(find.text('サービスに一時的に接続できません。しばらく待ってから再試行してください。'), findsOneWidget);
    expect(backend.uploadsReceived, 1);
    await tester.tap(inDialog(find.text('キャンセル')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(backend.uploadsReceived, 1);

    await tester.pump(const Duration(seconds: 3));
    await waitRealTime(tester);

    expect(backend.uploadsReceived, 1);
    expect(find.text('1枚を送信しました'), findsNothing);
  });
}
