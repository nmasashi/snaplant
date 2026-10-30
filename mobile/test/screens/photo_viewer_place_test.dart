import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../helpers/app_test_helpers.dart';
import '../helpers/trip_test_helpers.dart';

// 解析を頼むダイアログの「場所」の欄（docs/03_screen_design.md §5.4。C-2。02 §5 #53）。
// 場所には写真の撮影地を入れておき、直すと写真の撮影地も変わる。入口は旅行詳細の写真のグリッドから開く写真ビューア

const _takenAt = '2026年10月6日 10:15';

/// 撮影日時が 2026年10月6日 10:15 の、食べ物の写真。[location] は撮影地（無ければ null）
Map<String, Object?> _photo(Map<String, Object?>? location) =>
    photoJson(number: 1, tripId: hokkaidoTripId, takenAt: '2026-10-06T10:15:00')
      ..['category'] = 'food'
      ..['location'] = location
      ..['processing'] = {
        'state': 'done',
        'step': 'classify',
        'attempts': 0,
        'lastError': null,
        'updatedAt': '2026-10-18T03:00:00.000Z'
      };

/// 端末が地名を引いた撮影地（函館市）
const _hakodate = {
  'latitude': 41.77,
  'longitude': 140.73,
  'placeName': '函館市',
  'placeSource': 'device'
};

/// 旅行詳細を開き、写真をタップしてビューアを開き、上のバーのボタンでダイアログを開く
Future<FakeTripBackend> _openDialog(
    WidgetTester tester, Map<String, Object?> photo) async {
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
  await tester.tap(photoThumbnail(_takenAt));
  await letFramesRun(tester);
  await tester.tap(find.byTooltip('コメントを書いてもらう'));
  await letFramesRun(tester);
  return backend;
}

/// 偽のサーバにある写真の撮影地
Object? _storedLocation(FakeTripBackend backend) =>
    backend.photosByTripId[hokkaidoTripId]!.single['location'];

/// ダイアログの「場所」の欄
Finder get _placeField => find.widgetWithText(TextField, '場所');

/// ダイアログの頼むボタン
Finder get _submit => find.descendant(
    of: find.byType(AlertDialog), matching: find.text('書いてもらう'));

/// [text] がダイアログの外（ビューアの下の情報）にあるか
Finder _outsideDialog(String text) => find.byElementPredicate((element) =>
    element.widget is Text &&
    (element.widget as Text).data == text &&
    element.findAncestorWidgetOfExactType<AlertDialog>() == null);

void main() {
  testWidgets('場所の欄に写真の撮影地を入れておき、直すと撮影地も変わることを知らせる', (tester) async {
    await _openDialog(tester, _photo(_hakodate));

    expect(find.descendant(of: _placeField, matching: find.text('函館市')),
        findsOneWidget);
    expect(find.text('写真の撮影地を入れています。直すと撮影地も変わります'), findsOneWidget);
  });

  testWidgets('場所を直して頼むと、写真の撮影地が手で直した地名になり、ビューアの場所の表示も変わる', (tester) async {
    final backend = await _openDialog(tester, _photo(_hakodate));

    await tester.enterText(_placeField, '函館朝市');
    await tester.tap(_submit);
    await letFramesRun(tester);

    expect(_storedLocation(backend), {
      'latitude': 41.77,
      'longitude': 140.73,
      'placeName': '函館朝市',
      'placeSource': 'user'
    });
    expect(_outsideDialog('函館朝市'), findsOneWidget);
  });

  testWidgets('場所を変えずに頼むと、撮影地は端末が引いた地名のまま（手で直したものにしない）', (tester) async {
    // 手で直したもの（placeSource: user）になると、端末の地名か利用者の地名かが分からなくなる
    final backend = await _openDialog(tester, _photo(_hakodate));

    await tester.tap(_submit);
    await letFramesRun(tester);

    expect(_storedLocation(backend), _hakodate);
  });

  testWidgets('位置情報の無い写真は、場所の欄が空で、書くと撮影地として残ることを知らせ、書いて頼むと撮影地になる',
      (tester) async {
    final backend = await _openDialog(tester, _photo(null));

    expect(find.text('この写真には位置情報がありません。書くと撮影地として残ります'), findsOneWidget);
    await tester.enterText(_placeField, '函館朝市');
    await tester.tap(_submit);
    await letFramesRun(tester);

    expect(_storedLocation(backend), {
      'latitude': null,
      'longitude': null,
      'placeName': '函館朝市',
      'placeSource': 'user'
    });
    expect(_outsideDialog('函館朝市'), findsOneWidget);
    expect(_outsideDialog('位置情報なし'), findsNothing);
  });
}
