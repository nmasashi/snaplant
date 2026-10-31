import 'dart:async';

import 'package:flutter_test/flutter_test.dart';

import '../helpers/app_test_helpers.dart';
import '../helpers/gallery_test_helpers.dart';
import '../helpers/trip_test_helpers.dart';
import '../helpers/upload_test_helpers.dart';

// 写真の送信（docs/03_screen_design.md §4.7.3）を、利用者から見た振る舞いで確かめる。
// 応答ごとの扱い（201・時間切れ・503・429・通信の失敗の送り直し、404 の旅行が見つからない）と、設定を変えたときの送信。
// 送信の状態はアプリの根が持つので、アプリ全体を開いて旅行一覧から旅行詳細へ進む。旅行の API は偽のサーバ（helpers の FakeTripBackend）、
// ギャラリー・Geocoder・画像の圧縮は端末の機能なので偽物に差し替える。共有の補助は helpers/upload_test_helpers.dart

void main() {
  testWidgets('旅行詳細の「写真を追加」でギャラリーから1枚選ぶと、その旅行宛てに送られ（写真の id は画像のバイト列の SHA-256）、「1枚を送信しました」と知らせて、写真の一覧と見出しの枚数に出る', (tester) async {
    // アプリ全体を開いて、旅行一覧から旅行詳細へ進む（送信の状態はアプリの根が持つので、画面だけを単独で開かない）。
    // 偽のサーバは、photoId が画像の SHA-256 と一致しない送信を 400 で断る。クライアントが正しいハッシュを送ったかは、写真が届いたことで分かる。
    // EXIF の無い画像（この PNG）では、撮影日時と位置のパートを省く。空文字のパートや緯度・経度の片方だけの送信は 400 で断られるので、省いていることも、写真が届くことで分かる
    final image = writeTestImage('hokkaido.png');
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('まだ写真がありません'), findsOneWidget);

    expect(find.text('写真を追加'), findsOneWidget);
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, hokkaidoTripId);
    await letFramesRun(tester);

    expect(backend.photosByTripId[hokkaidoTripId]!.map((photo) => photo['id']), [tinyPngSha256]);
    expect(find.text('1枚を送信しました'), findsOneWidget);
    expect(find.text('1枚 · 撮影日時なし'), findsOneWidget);
    expect(find.text('まだ写真がありません'), findsNothing);
  });

  testWidgets('送信している間に設定をリセットしてアプリが送信の列を作り直しても、送信の応答が返ったときに例外は出ず、作り直した後の画面に送信の知らせは出ない', (tester) async {
    // 設定が変わると、前の設定の列は破棄される。破棄された列の送信が終わっても、閉じたストリームへ流したり、破棄済みの通知を呼んだりしない
    final image = writeTestImage('hokkaido.png');
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    final release = Completer<void>();
    backend.holds[TripRoute.upload] = release.future;
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 1);
    await letFramesRun(tester);
    await tapBack(tester);
    await letFramesRun(tester);
    await resetSettingsAndGoBack(tester);
    expect(find.text('API設定が完了していません'), findsOneWidget);

    release.complete();
    await letFramesRun(tester);

    expect(find.textContaining('送信'), findsNothing);
  });

  testWidgets('1枚の送信の応答が60秒返らないときは、時間切れにして2秒後に送り直し、その送り直しが成功すれば、「1枚を送信しました」と知らせ、送信できなかった行は出ない', (tester) async {
    // 1回目の応答は保留して返さない（通信が固まった状態）。時間切れは通信の失敗と同じ扱いで、2秒後に送り直す。
    // 送り直しの待ちと同じく、時間切れもフェイクの時間（pump）で進める。要求が届いてから時間は進めていないので、
    // 時間切れは 60 秒、送り直しはその 2 秒後。1ミリ秒手前では届かず、1ミリ秒進めると届く
    final image = writeTestImage('hokkaido.png');
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    final firstReply = backend.holdNextReply(TripRoute.upload);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 1);
    await tester.pump(const Duration(milliseconds: 61999));
    await waitRealTime(tester);
    expect(backend.uploadsReceived, 1);
    await tester.pump(const Duration(milliseconds: 1));
    await waitUntilUploadsReceived(tester, backend, 2);
    // 時間切れのあとに、保留していた1回目の応答が遅れて届いても、結果は変わらない
    firstReply.complete();
    await letFramesRun(tester);

    await pumpUntilFound(tester, find.text('1枚を送信しました'));
    expect(find.text('1枚を送信しました'), findsOneWidget);
    expect(find.textContaining('送信できませんでした'), findsNothing);
  });

  testWidgets('送信が1回目に 503・429（封筒の無い「混雑」の応答）・通信の失敗（応答が返らない）になっても、2秒後の送り直しで成功すれば、写真は届いて「3枚を送信しました」と知らせ、送信できなかった行は出ない', (tester) async {
    // 通信の失敗・429・503 は自動で送り直す（2秒 → 4秒 → 8秒）。3枚を一度に送り、1回目の要求に届いた順に 503・429・通信の失敗を割り当てる。
    // 同時に送るのは2本で、送り直しを待つ間も枠はふさがったままなので、3枚目は先の2枚の送り直しが済んでから送られる。
    // 429 は、アプリではなく従量課金プランの Functions ランタイムが過負荷のときに、封筒なしで返す。通信が切れて応答が返らない失敗は、HTTP クライアントの例外として届く。
    // 送り直しの待ちはフェイクの時間（pump）で進める。準備とファイルの読み込みは実時間でしか進まないので、待ちを過ぎたあとは実時間で要求が届くのを待つ
    useGalleryReturning([
      writeTestImage('first.png'),
      writeTestImage('second.png', bytes: [...tinyPngBytes, 0]),
      writeTestImage('third.png', bytes: [...tinyPngBytes, 0, 0]),
    ]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    backend.failNext(TripRoute.upload);
    backend.failNextWithoutEnvelope(TripRoute.upload, status: 429);
    backend.failNextWithConnectionError(TripRoute.upload);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await letUploadFail(tester, backend, 2);
    await letFramesRun(tester);
    await tester.pump(const Duration(seconds: 2));
    await waitUntilUploaded(tester, backend, hokkaidoTripId, count: 2);
    await letFramesRun(tester);
    await letUploadFail(tester, backend, 5);
    await letFramesRun(tester);
    await tester.pump(const Duration(seconds: 2));
    await waitUntilUploaded(tester, backend, hokkaidoTripId, count: 3);
    await letFramesRun(tester);

    expect(backend.photosByTripId[hokkaidoTripId]!, hasLength(3));
    await pumpUntilFound(tester, find.text('3枚を送信しました'));
    expect(find.text('3枚を送信しました'), findsOneWidget);
    expect(find.textContaining('送信できませんでした'), findsNothing);
  });

  testWidgets('503 で失敗した送信は、2秒・4秒・8秒の間隔を空けて送り直し、それより早くは送り直さない', (tester) async {
    // 送り直しの待ちはフェイクの時間。待ちの1ミリ秒手前では実時間を進めても要求は届かず、1ミリ秒進めると届く。
    // 要求が届いた回数は、偽のサーバが受け取った要求の数（送り直しの間隔を、サーバから見た要求の届き方で確かめる）
    final image = writeTestImage('hokkaido.png');
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    for (var i = 0; i < 4; i++) {
      backend.failNext(TripRoute.upload);
    }
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await letUploadFail(tester, backend, 1);
    await tester.pump(const Duration(milliseconds: 1999));
    await waitRealTime(tester);
    expect(backend.uploadsReceived, 1);
    await tester.pump(const Duration(milliseconds: 1));
    await letUploadFail(tester, backend, 2);

    await tester.pump(const Duration(milliseconds: 3999));
    await waitRealTime(tester);
    expect(backend.uploadsReceived, 2);
    await tester.pump(const Duration(milliseconds: 1));
    await letUploadFail(tester, backend, 3);

    await tester.pump(const Duration(milliseconds: 7999));
    await waitRealTime(tester);
    expect(backend.uploadsReceived, 3);
    await tester.pump(const Duration(milliseconds: 1));
    await letUploadFail(tester, backend, 4);
  });

  testWidgets('送り直しは3回までで、4回とも 503 で失敗したら、それ以上は送らず、バナーに「1枚を送信できませんでした」を出す', (tester) async {
    // 間隔は前のテストが見る。ここでは各回の待ちを十分に（実際の間隔より長く）進め、最後の失敗のあとにどれだけ待っても送られないことを見る
    final image = writeTestImage('hokkaido.png');
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    for (var i = 0; i < 4; i++) {
      backend.failNext(TripRoute.upload);
    }
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await letUploadFail(tester, backend, 1);
    await tester.pump(const Duration(seconds: 3));
    await letUploadFail(tester, backend, 2);
    await tester.pump(const Duration(seconds: 5));
    await letUploadFail(tester, backend, 3);
    await tester.pump(const Duration(seconds: 9));
    await letUploadFail(tester, backend, 4);
    await tester.pump(const Duration(seconds: 16));
    await waitRealTime(tester);
    await letFramesRun(tester);

    expect(backend.uploadsReceived, 4);
    expect(backend.photosByTripId[hokkaidoTripId] ?? [], isEmpty);
    expect(find.text('1枚を送信できませんでした（サービスに一時的に接続できません。しばらく待ってから再試行してください。）'), findsOneWidget);
    expect(find.text('送り直す'), findsOneWidget);
  });

  testWidgets('送り先の旅行が別の端末で消されていて 404 になったら、同じ旅行宛ての残りの写真は送らずに失敗にし、バナーに「3枚を送信できませんでした（旅行が見つかりません）」を出す', (tester) async {
    // 詳細を開いたあとで、偽のサーバから旅行を消す（画面は取り直さないので、詳細は開いたまま）。
    // 同時に送るのは2本。1枚目と2枚目の応答（どちらも 404）を保留して、3枚目の準備が済み、待ちに入った（「送信中 0/3」）ところで返す。
    // こうすると、3枚目は 404 が返る前に送られることがなく、送らないことを、届いた要求がちょうど2回であることで決定的に見られる
    final first = writeTestImage('first.png');
    final second = writeTestImage('second.png', bytes: [...tinyPngBytes, 0]);
    final third = writeTestImage('third.png', bytes: [...tinyPngBytes, 0, 0]);
    useGalleryReturning([first, second, third]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);
    backend.trips.clear();
    final firstReply = backend.holdNextReply(TripRoute.upload);
    final secondReply = backend.holdNextReply(TripRoute.upload);

    await tester.tap(find.text('写真を追加'));
    await waitUntilFound(tester, find.text('送信中 0/3'));
    expect(find.text('送信中 0/3'), findsOneWidget);
    firstReply.complete();
    secondReply.complete();
    await waitRealTime(tester);
    await letFramesRun(tester);

    expect(backend.uploadsReceived, 2);
    expect(backend.photosByTripId[hokkaidoTripId] ?? [], isEmpty);
    expect(find.text('3枚を送信できませんでした（旅行が見つかりません）'), findsOneWidget);
  });

  testWidgets('送り先の旅行が消えていて 404 になったあとに準備が済んだ同じ旅行宛ての写真も、送らずに失敗にし、バナーに「100枚を送信できませんでした（旅行が見つかりません）」を出す', (tester) async {
    // 100枚を選び、同時に送る1枚目と2枚目の応答（どちらも 404）を保留する。2本が届いた時点で準備はまだ続いているので、
    // 応答を返したあとに準備が済む写真がある。それらも送られない（届いた要求は2回のまま）
    useGalleryReturning(writeTestImages(manyPhotos));
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);
    backend.trips.clear();
    final firstReply = backend.holdNextReply(TripRoute.upload);
    final secondReply = backend.holdNextReply(TripRoute.upload);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 2);
    await tester.pump();
    expect(preparingBanner(manyPhotos), findsOneWidget);
    firstReply.complete();
    secondReply.complete();
    await waitUntilFound(tester, find.textContaining('送信できませんでした'), step: const Duration(milliseconds: 1));

    expect(backend.uploadsReceived, 2);
    expect(find.text('100枚を送信できませんでした（旅行が見つかりません）'), findsOneWidget);
  });

  testWidgets('送り直しを待っている写真があるときに、同じ旅行宛ての別の写真が 404 になったら、待っている写真も送り直さずに失敗にし、バナーに「2枚を送信できませんでした（旅行が見つかりません）」を出す', (tester) async {
    // 同時に送る2枚のうち、1枚目の要求が 503（2秒後に送り直す）、2枚目の要求が 404 になる（失敗は、要求が届いた順に割り当てる）。
    // 2枚目の 404 で旅行が無いと分かった以上、待ちが明けた1枚目も送らない（届いた要求は2回のまま）
    final first = writeTestImage('first.png');
    final second = writeTestImage('second.png', bytes: [...tinyPngBytes, 0]);
    useGalleryReturning([first, second]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    backend.failNext(TripRoute.upload);
    backend.failNext(TripRoute.upload, status: 404, code: 'TRIP_NOT_FOUND', message: '指定された旅行が見つかりません');
    // 3回目の要求（送り直しが送られてしまったとき）も失敗にして、写真が届いて画面に出る（サムネイルのあとの実時間の待ちで落ちる）ことを避ける
    backend.failNext(TripRoute.upload);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await letUploadFail(tester, backend, 2);
    await tester.pump(const Duration(seconds: 2));
    await waitRealTime(tester);
    await letFramesRun(tester);

    expect(backend.uploadsReceived, 2);
    expect(find.text('2枚を送信できませんでした（旅行が見つかりません）'), findsOneWidget);
  });

  testWidgets('旅行が消えていて失敗した写真を「閉じる」で消しても、消えた旅行は覚えていて、同じ旅行へ選び直した写真は送らずに失敗にし、「1枚を送信できませんでした（旅行が見つかりません）」を出す', (tester) async {
    // 一区切りや「閉じる」では、消えた旅行を忘れない（忘れるのは「送り直す」を押したとき）。選び直した写真の要求は偽のサーバに届かない
    final first = writeTestImage('first.png');
    useGalleryReturning([first]);
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
    await tester.tap(find.text('閉じる'));
    await letFramesRun(tester);
    expect(find.textContaining('送信できませんでした'), findsNothing);
    final second = writeTestImage('second.png', bytes: [...tinyPngBytes, 0]);
    useGalleryReturning([second]);

    await tester.tap(find.text('写真を追加'));
    await waitUntilFound(tester, find.text('1枚を送信できませんでした（旅行が見つかりません）'));
    await waitRealTime(tester);

    expect(backend.uploadsReceived, 1);
    expect(find.text('1枚を送信できませんでした（旅行が見つかりません）'), findsOneWidget);
  });

  testWidgets('旅行が消えていて失敗した写真は、旅行が戻ってから「送り直す」で送れて、そのあとに同じ旅行へ選んだ写真も届く（「送り直す」で消えた旅行を忘れる）', (tester) async {
    // 送り直しで届いた写真は、偽のサーバから取り除いておく（別の端末で消された状態）。取り除かないと、読み直した一覧にサムネイルが出て、
    // そのあとの準備の実時間の待ちで、画像のキャッシュが端末の機能（path_provider）を探して落ちる
    final first = writeTestImage('first.png');
    useGalleryReturning([first]);
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
    backend.trips.add(tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0));
    final retryReply = backend.holdNextReply(TripRoute.upload);

    await tester.tap(find.text('送り直す'));
    await waitUntilUploadsReceived(tester, backend, 2);
    backend.photosByTripId[hokkaidoTripId]!.clear();
    retryReply.complete();
    await letFramesRun(tester);
    expect(find.textContaining('送信できませんでした'), findsNothing);
    final second = writeTestImage('second.png', bytes: [...tinyPngBytes, 0]);
    useGalleryReturning([second]);
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, hokkaidoTripId);
    await letFramesRun(tester);

    expect(backend.uploadsReceived, 3);
    expect(backend.photosByTripId[hokkaidoTripId]!.length, 1);
    expect(find.textContaining('送信できませんでした'), findsNothing);
  });

}
