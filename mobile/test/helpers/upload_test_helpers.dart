import 'package:flutter_test/flutter_test.dart';

import 'trip_test_helpers.dart';

// 写真の送信（docs/03_screen_design.md §4.7・§4.4.3）を確かめる画面のテストが共有する補助。
// 送信のテストは 03 の節ごとにファイルを分けている（upload_*_test.dart・trip_detail_delete_test.dart）

/// 準備を長引かせるために選ぶ写真の枚数。準備は1枚ずつ別の isolate で進み、1枚に十数ミリ秒かかる。
/// 最初の送信の要求が届いて確かめるまでの間（数百ミリ秒）に準備が終わらない枚数にする
const manyPhotos = 100;

/// 実時間を進めながら、画面を何度も進める（フェイクの時間は進まない）。
/// 送り直しの待ちが過ぎていないとき、実時間が進んでもファイルの読み込みも要求も起きない（届いた回数が増えない）ことを確かめるために使う。
/// 待ちが過ぎていれば、ファイルの読み込みから要求が届くまでに、実時間の経過と画面を進める操作の繰り返しが要る
/// （実時間を一度に待つだけでは、続きが進まず、早すぎる送り直しを見逃す）。繰り返しの回数と間隔は、見逃さないための余裕
/// 写真のサムネイルを出したあとに使うと、画像のキャッシュが端末の機能（path_provider）を探して落ちる（CLAUDE.md の「テストで踏みやすい点」）。出す前に使う
Future<void> waitRealTime(WidgetTester tester) async {
  for (var i = 0; i < 20; i++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
    await tester.pump();
  }
}

/// 送信の要求が [count] 回（そのテストで届いた回数の累計）届くまで待ち、その失敗の応答を処理させる（次の送り直しの待ちは、ここから数え始まる）
Future<void> letUploadFail(WidgetTester tester, FakeTripBackend backend, int count) async {
  await waitUntilUploadsReceived(tester, backend, count);
  await tester.pump();
  await tester.pump();
}
