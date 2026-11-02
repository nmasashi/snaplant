import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../helpers/app_test_helpers.dart';
import '../helpers/gallery_test_helpers.dart';
import '../helpers/image_compress_test_helpers.dart';
import '../helpers/trip_test_helpers.dart';

// 旅行詳細のお気に入りの絞り込み（docs/03_screen_design.md §5.10.2。F-3。02 §5 #63）。
// 入口は旅行詳細のチップ（カテゴリのチップは §5.3 の category_filter_test.dart）

/// 分類が済んだ写真。[time] は 2026年10月6日のその時刻（サムネイルの読み上げ用ラベルで見分ける）
Map<String, Object?> _photo(int number, String category, String time, {bool favorite = false}) =>
    photoJson(number: number, tripId: hokkaidoTripId, takenAt: '2026-10-06T$time:00')
      ..['category'] = category
      ..['favorite'] = favorite
      ..['processing'] = {'state': 'done', 'step': 'classify', 'attempts': 1, 'lastError': null, 'updatedAt': '2026-10-18T03:00:00.000Z'};

/// サムネイルの読み上げ用ラベル（撮影日時。お気に入りなら「、お気に入り」が付く）
String _label(String time, {bool favorite = false}) => '2026年10月6日 $time${favorite ? '、お気に入り' : ''}';

/// 旅行詳細を開く
Future<FakeTripBackend> _openTripDetail(WidgetTester tester, List<Map<String, Object?>> photos) async {
  final backend = FakeTripBackend(
    trips: [hokkaidoTrip(photoCount: photos.length)],
    functionKey: 'test-key',
    photosByTripId: {hokkaidoTripId: photos},
  );
  await openTripsTab(tester, backend);
  await tester.tap(find.text('北海道 2026秋'));
  await letFramesRun(tester);
  return backend;
}

/// チップ
Finder _chip(String label) => find.widgetWithText(ChoiceChip, label);

/// [labels] のサムネイルが出ているか
List<bool> _shown(List<String> labels) => [for (final label in labels) find.bySemanticsLabel(label).evaluate().isNotEmpty];

void main() {
  testWidgets('「すべて」の次に「お気に入り」のチップがあり、選ぶとその旅行のお気に入りの写真だけを並べ、ほかのチップと同じく1つだけ選べる', (tester) async {
    final semantics = tester.ensureSemantics();
    await _openTripDetail(tester, [
      _photo(1, 'food', '10:00', favorite: true),
      _photo(2, 'landscape', '11:00'),
      _photo(3, 'food', '12:00'),
    ]);

    expect(tester.getTopLeft(_chip('お気に入り')).dx, greaterThan(tester.getTopLeft(_chip('すべて')).dx));
    expect(tester.getTopLeft(_chip('お気に入り')).dx, lessThan(tester.getTopLeft(_chip('植物')).dx));

    await tester.tap(_chip('お気に入り'));
    await letFramesRun(tester);

    expect(_shown([_label('10:00', favorite: true), _label('11:00'), _label('12:00')]), [true, false, false]);
    expect(tester.widget<ChoiceChip>(_chip('お気に入り')).selected, isTrue);
    expect(tester.widget<ChoiceChip>(_chip('すべて')).selected, isFalse);
    // 枚数も期間も旅行全体のまま（§5.3 と同じ）
    expect(find.text('3枚 · 2026/10/05 〜 2026/10/08'), findsOneWidget);

    await tester.tap(_chip('食べ物'));
    await letFramesRun(tester);
    expect(_shown([_label('10:00', favorite: true), _label('11:00'), _label('12:00')]), [true, false, true]);
    expect(tester.widget<ChoiceChip>(_chip('お気に入り')).selected, isFalse);
    semantics.dispose();
  });

  testWidgets('お気に入りの写真が無ければ「この旅行にお気に入りの写真はありません」の1行だけ', (tester) async {
    await _openTripDetail(tester, [_photo(1, 'food', '10:00')]);

    await tester.tap(_chip('お気に入り'));
    await letFramesRun(tester);

    expect(find.text('この旅行にお気に入りの写真はありません'), findsOneWidget);
    expect(find.text('「写真を追加」からギャラリーの写真を送りましょう'), findsNothing);
  });

  testWidgets('絞り込んだままビューアでお気に入りから外して戻ると、読み直した一覧から消える', (tester) async {
    final semantics = tester.ensureSemantics();
    await _openTripDetail(tester, [
      _photo(1, 'food', '10:00', favorite: true),
      _photo(2, 'landscape', '11:00', favorite: true),
    ]);
    await tester.tap(_chip('お気に入り'));
    await letFramesRun(tester);

    await tester.tap(find.bySemanticsLabel(_label('10:00', favorite: true)));
    await letFramesRun(tester);
    await tester.tap(find.byTooltip('お気に入りから外す'));
    await letFramesRun(tester);
    await tapBack(tester);
    await letFramesRun(tester);

    expect(_shown([_label('10:00', favorite: true), _label('10:00'), _label('11:00', favorite: true)]), [false, false, true]);
    expect(tester.widget<ChoiceChip>(_chip('お気に入り')).selected, isTrue);
    semantics.dispose();
  });

  testWidgets('お気に入りで絞り込んでいる間は、送れなかった写真の端末の画像のマスを並べず、「すべて」に戻すと並べる', (tester) async {
    // 送った写真はまだお気に入りではないので、「すべて」のときだけ並べる（§5.3 のカテゴリと同じ。§5.10.2）
    useFakeImageCompress();
    final semantics = tester.ensureSemantics();
    final image = writeTestImage('hokkaido-favorite.png');
    useGalleryReturning([image]);
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 1)],
      functionKey: 'test-key',
      photosByTripId: {
        hokkaidoTripId: [_photo(1, 'food', '10:00', favorite: true)]
      },
    );
    backend.failNext(TripRoute.upload, status: 500, code: 'INTERNAL_ERROR', message: '写真の保存に失敗しました');
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    final markInGrid = find.descendant(of: photoGridScroll(), matching: find.text('!'));
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 1);
    await waitUntilFound(tester, find.textContaining('1枚を送信できませんでした'));
    await letFramesRun(tester);
    expect(markInGrid, findsOneWidget);

    await tester.tap(_chip('お気に入り'));
    await letFramesRun(tester);

    expect(find.bySemanticsLabel(_label('10:00', favorite: true)), findsOneWidget);
    expect(markInGrid, findsNothing);
    await tester.tap(_chip('すべて'));
    await letFramesRun(tester);
    expect(markInGrid, findsOneWidget);
    // 後始末: 失敗の行を「閉じる」で消して列を空にし、画像のキャッシュの掃除のタイマーが過ぎるまで進める
    await tester.tap(find.text('閉じる'));
    await letFramesRun(tester);
    await tester.pump(const Duration(seconds: 20));
    semantics.dispose();
  });
}
