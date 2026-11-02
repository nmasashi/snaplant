import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../helpers/app_test_helpers.dart';
import '../helpers/trip_test_helpers.dart';

// 写真ビューアでお気に入りを付け外す（docs/03_screen_design.md §5.10.1。F-3。02 §5 #63）。
// 入口は旅行詳細の写真のグリッドから開く写真ビューア

const _takenAt = '2026年10月6日 10:15';

/// 撮影日時が 2026年10月6日 10:15 の、旅行「北海道」の写真
Map<String, Object?> _photo({bool favorite = false}) =>
    photoJson(number: 1, tripId: hokkaidoTripId, takenAt: '2026-10-06T10:15:00')
      ..['category'] = 'food'
      ..['favorite'] = favorite;

/// 旅行詳細を開き、1枚目の写真をタップしてビューアを開く
Future<FakeTripBackend> _openViewer(WidgetTester tester, Map<String, Object?> photo) async {
  final backend = FakeTripBackend(
    trips: [hokkaidoTrip(photoCount: 1)],
    functionKey: 'test-key',
    photosByTripId: {
      hokkaidoTripId: [photo]
    },
  );
  await openTripsTab(tester, backend);
  await tester.tap(find.text('北海道 2026秋'));
  await letFramesRun(tester);
  await tester.tap(find.bySemanticsLabel(photo['favorite'] == true ? '$_takenAt、お気に入り' : _takenAt));
  await letFramesRun(tester);
  return backend;
}

/// 偽のサーバにある写真のお気に入り
Object? _stored(FakeTripBackend backend) => backend.photosByTripId[hokkaidoTripId]!.first['favorite'];

/// 上のバーのハート（読み上げ [tooltip]）のボタン
IconButton _heart(WidgetTester tester, String tooltip) =>
    tester.widget<IconButton>(find.ancestor(of: find.byTooltip(tooltip), matching: find.byType(IconButton)));

/// 上のバーに塗ったハートが出ているか
Finder _filledHeart() => find.descendant(of: find.byType(AppBar), matching: find.byIcon(Icons.favorite));

void main() {
  testWidgets('上のバーのハートを押すと、すぐ塗ったハートになり、お気に入りとして送る。もう一度押すと外す', (tester) async {
    final backend = await _openViewer(tester, _photo());

    expect(find.byTooltip('お気に入りにする'), findsOneWidget);
    expect(_filledHeart(), findsNothing);
    await tester.tap(find.byTooltip('お気に入りにする'));
    await letFramesRun(tester);

    expect(_stored(backend), isTrue);
    expect(find.byTooltip('お気に入りから外す'), findsOneWidget);
    expect(_filledHeart(), findsOneWidget);

    await tester.tap(find.byTooltip('お気に入りから外す'));
    await letFramesRun(tester);
    expect(_stored(backend), isFalse);
    expect(find.byTooltip('お気に入りにする'), findsOneWidget);
    expect(_filledHeart(), findsNothing);
  });

  testWidgets('お気に入りの写真を開くと、塗ったハート（読み上げ「お気に入りから外す」）で出る', (tester) async {
    await _openViewer(tester, _photo(favorite: true));

    expect(find.byTooltip('お気に入りから外す'), findsOneWidget);
    expect(_filledHeart(), findsOneWidget);
  });

  testWidgets('送れなかったら印を元に戻し、理由をスナックバーに出す', (tester) async {
    final backend = await _openViewer(tester, _photo());
    backend.failNext(TripRoute.updatePhoto, status: 500, code: 'INTERNAL_ERROR', message: '写真の更新に失敗しました');

    await tester.tap(find.byTooltip('お気に入りにする'));
    await letFramesRun(tester);

    expect(find.text(serverErrorMessage), findsOneWidget);
    expect(find.byTooltip('お気に入りにする'), findsOneWidget);
    expect(_filledHeart(), findsNothing);
    expect(_stored(backend), isNot(true));
  });

  testWidgets('送っている間は、印を替えたままハートを押せない。届いたら押せる', (tester) async {
    final backend = await _openViewer(tester, _photo());
    final reply = backend.holdNextReply(TripRoute.updatePhoto);

    await tester.tap(find.byTooltip('お気に入りにする'));
    await tester.pump();

    expect(_filledHeart(), findsOneWidget);
    expect(_heart(tester, 'お気に入りから外す').onPressed, isNull);

    reply.complete();
    await letFramesRun(tester);
    expect(_heart(tester, 'お気に入りから外す').onPressed, isNotNull);
    expect(_stored(backend), isTrue);
  });

  testWidgets('ビューアで付けて旅行詳細へ戻ると、一覧のサムネイルにお気に入りの印が付く（一覧の写真を置き換える）', (tester) async {
    await _openViewer(tester, _photo());
    await tester.tap(find.byTooltip('お気に入りにする'));
    await letFramesRun(tester);

    await tapBack(tester);
    await letFramesRun(tester);

    expect(find.bySemanticsLabel('$_takenAt、お気に入り'), findsOneWidget);
  });

  testWidgets('旅行に属さない写真の画面から開いたビューアには、ハートを出さない', (tester) async {
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 0)],
      functionKey: 'test-key',
      unassignedPhotoCount: 1,
      photosByTripId: {
        'none': [photoJson(number: 1, takenAt: '2026-09-01T10:15:00')]
      },
    );
    await openTripsTab(tester, backend);
    await tester.tap(find.text('旅行に属さない写真'));
    await letFramesRun(tester);
    await tester.tap(photoThumbnail('2026年9月1日 10:15'));
    await letFramesRun(tester);

    expect(find.byTooltip('タグを付ける'), findsOneWidget, reason: 'ビューアは開いている');
    expect(find.byTooltip('お気に入りにする'), findsNothing);
    expect(find.byTooltip('お気に入りから外す'), findsNothing);
  });

  testWidgets('図鑑の項目詳細から開いたビューアには、旅行の写真でもハートを出さない', (tester) async {
    final backend = FakeTripBackend(
      functionKey: 'test-key',
      catalogEntriesByKind: {
        'plant': [catalogEntryJson('plant', 'ソメイヨシノ', photoCount: 1)]
      },
      photosByTripId: {
        hokkaidoTripId: [
          identifiedPhotoJson(number: 1, kind: 'plant', name: 'ソメイヨシノ', tripId: hokkaidoTripId, takenAt: '2026-10-06T10:00:00')
            ..['favorite'] = true
        ]
      },
    );
    await openCatalogTab(tester, backend);
    await tester.tap(find.text('ソメイヨシノ'));
    await letFramesRun(tester);
    await tester.tap(photoThumbnail('2026年10月6日 10:00'));
    await letFramesRun(tester);

    expect(find.byTooltip('タグを付ける'), findsOneWidget, reason: 'ビューアは開いている');
    expect(find.byTooltip('お気に入りにする'), findsNothing);
    expect(find.byTooltip('お気に入りから外す'), findsNothing);
  });
}
