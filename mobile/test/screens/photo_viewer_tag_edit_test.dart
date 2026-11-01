import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../helpers/app_test_helpers.dart';
import '../helpers/trip_test_helpers.dart';

// タグを直す（docs/03_screen_design.md §5.9.3。C-4d。02 §5 #61）。
// 入口は旅行詳細の写真のグリッドから開く写真ビューア。写真の上の吹き出しは画像の大きさが要るので、
// 偽のサーバから画像（横 40・縦 20 の PNG）を読み込ませる（useImageCacheOf）

/// 横 40・縦 20（横長 2:1）の PNG
final _image = base64Decode(
    'iVBORw0KGgoAAAANSUhEUgAAACgAAAAUCAIAAABwJOjsAAAAJElEQVR4nGM4UaExIIhh1OJRi0ctHrV41OJRi0ctHrV45FgMAJcsZT0VWwT2AAAAAElFTkSuQmCC');

const _takenAt = '2026年10月6日 10:15';

/// タグ（名前・種類・位置・出どころ。04 §2）
Map<String, Object?> _tag(String name,
        {String kind = 'food', double x = 0.5, double y = 0.5, String source = 'user'}) =>
    {'name': name, 'kind': kind, 'x': x, 'y': y, 'source': source};

/// 撮影日時が 2026年10月6日 10:15 の食べ物の写真
Map<String, Object?> _photo({List<Map<String, Object?>> tags = const []}) => photoJson(
    number: 1, tripId: hokkaidoTripId, takenAt: '2026-10-06T10:15:00', tags: tags)
  ..['category'] = 'food';

/// 旅行詳細を開き、1枚目の写真をタップしてビューアを開く。[waitFor] が出るまで画像を読み込ませる
Future<FakeTripBackend> _openViewer(WidgetTester tester, Map<String, Object?> photo,
    {required Finder waitFor}) async {
  final backend = FakeTripBackend(
    trips: [hokkaidoTrip(photoCount: 1)],
    functionKey: 'test-key',
    photosByTripId: {
      hokkaidoTripId: [photo]
    },
  );
  useImageCacheOf(backend, _image);
  await openTripsTab(tester, backend);
  await tester.tap(find.text('北海道 2026秋'));
  await letFramesRun(tester);
  await tester.tap(photoThumbnail(_takenAt));
  await letFramesRun(tester);
  await pumpUntilImageShown(tester, waitFor);
  expect(waitFor, findsWidgets);
  return backend;
}

/// 偽のサーバにある1枚目の写真のタグ
List<Object?> _storedTags(FakeTripBackend backend) =>
    backend.photosByTripId[hokkaidoTripId]!.first['tags'] as List<Object?>;

/// 写真の上の、名前が [name] の吹き出し
Finder _onPhoto(String name) => find.descendant(
    of: find.byType(InteractiveViewer), matching: find.text(name));

/// 下の情報のタグの一覧の、名前が [name] の札の名前
Finder _chipLabel(String name) =>
    find.descendant(of: find.byType(RawChip), matching: find.text(name));

/// 画像の中の割合 ([x], [y]) の画面の位置（横長 2:1 の画像を、写真の枠の中に縦横の比を保って中央に収める。§5.1）
Offset _at(WidgetTester tester, double x, double y) {
  final box = tester.getRect(find.byType(InteractiveViewer));
  final width = math.min(box.width, box.height * 2);
  final rect = Rect.fromCenter(center: box.center, width: width, height: width / 2);
  return Offset(rect.left + rect.width * x, rect.top + rect.height * y);
}

/// シートの中の [finder]
Finder _inSheet(Finder finder) => find.descendant(of: find.byType(BottomSheet), matching: finder);

/// シートの種類の選択肢 [label]
Finder _option(String label) => _inSheet(find.widgetWithText(RadioListTile<String>, label));

/// シートの「保存」
FilledButton _saveButton(WidgetTester tester) =>
    tester.widget<FilledButton>(_inSheet(find.widgetWithText(FilledButton, '保存')));

/// 上のバーの「タグを付ける」
IconButton _addButton(WidgetTester tester) => tester.widget<IconButton>(
    find.ancestor(of: find.byTooltip('タグを付ける'), matching: find.byType(IconButton)));

/// 写真の上の吹き出し [name] を押して、直すシートを開く
Future<void> _openEditSheet(WidgetTester tester, String name) async {
  await tester.tap(_onPhoto(name));
  await letFramesRun(tester);
}

/// 吹き出し [name] の直すシートで「位置を動かす」を押す
Future<void> _startMoving(WidgetTester tester, String name) async {
  await _openEditSheet(tester, name);
  await tester.tap(_inSheet(find.text('位置を動かす')));
  await letFramesRun(tester);
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets('写真の上の吹き出しを押すと「タグを直す」シートを開き、今の名前と種類が入っている。「キャンセル」では何も送らない', (tester) async {
    final tags = [_tag('ご飯', source: 'ai', x: 0.2), _tag('羊蹄山', kind: 'landscape', x: 0.7)];
    final backend = await _openViewer(tester, _photo(tags: tags), waitFor: _onPhoto('羊蹄山'));

    await _openEditSheet(tester, '羊蹄山');

    expect(_inSheet(find.text('タグを直す')), findsOneWidget);
    expect(tester.widget<TextField>(_inSheet(find.byType(TextField))).controller!.text, '羊蹄山');
    expect(tester.widget<RadioListTile<String>>(_option('風景')).checked, isTrue);
    expect(find.text('「羊蹄山」のタグを消しますか？'), findsNothing);

    await tester.tap(_inSheet(find.text('キャンセル')));
    await letFramesRun(tester);
    expect(find.byType(BottomSheet), findsNothing);
    expect(_storedTags(backend), tags);
    await finishImageLoading(tester);
  });

  testWidgets('下の情報の札の名前を押しても「タグを直す」シートを開く', (tester) async {
    await _openViewer(tester, _photo(tags: [_tag('ご飯')]), waitFor: _onPhoto('ご飯'));

    await tester.tap(_chipLabel('ご飯'));
    await letFramesRun(tester);

    expect(_inSheet(find.text('タグを直す')), findsOneWidget);
    expect(tester.widget<TextField>(_inSheet(find.byType(TextField))).controller!.text, 'ご飯');
    await finishImageLoading(tester);
  });

  testWidgets('名前と種類を直して保存すると、そのタグだけを置き換えて送り（出どころは user、位置はそのまま）、シートを閉じて表示を変える', (tester) async {
    final backend = await _openViewer(
        tester, _photo(tags: [_tag('ご飯', source: 'ai', x: 0.2, y: 0.3), _tag('夕食', x: 0.6, y: 0.6)]),
        waitFor: _onPhoto('夕食'));

    await _openEditSheet(tester, 'ご飯');
    await tester.enterText(_inSheet(find.byType(TextField)), '  白ご飯 ');
    await tester.pump();
    await tester.tap(_option('その他'));
    await tester.pump();
    await tester.tap(_inSheet(find.text('保存')));
    await letFramesRun(tester);

    expect(_storedTags(backend), [
      _tag('白ご飯', kind: 'other', x: 0.2, y: 0.3),
      _tag('夕食', x: 0.6, y: 0.6),
    ]);
    expect(find.byType(BottomSheet), findsNothing);
    expect(_onPhoto('白ご飯'), findsOneWidget);
    expect(_chipLabel('白ご飯'), findsOneWidget);
    await finishImageLoading(tester);
  });

  testWidgets('名前が前後の空白を除いて空なら「保存」を押せない', (tester) async {
    await _openViewer(tester, _photo(tags: [_tag('ご飯')]), waitFor: _onPhoto('ご飯'));

    await _openEditSheet(tester, 'ご飯');
    await tester.enterText(_inSheet(find.byType(TextField)), '   ');
    await tester.pump();

    expect(_saveButton(tester).onPressed, isNull);
    await finishImageLoading(tester);
  });

  testWidgets('保存に失敗したらシートに留まって理由を出す', (tester) async {
    final backend = await _openViewer(tester, _photo(tags: [_tag('ご飯')]), waitFor: _onPhoto('ご飯'));
    backend.failNext(TripRoute.updatePhoto,
        status: 500, code: 'INTERNAL_ERROR', message: '写真の更新に失敗しました');

    await _openEditSheet(tester, 'ご飯');
    await tester.enterText(_inSheet(find.byType(TextField)), '白ご飯');
    await tester.pump();
    await tester.tap(_inSheet(find.text('保存')));
    await letFramesRun(tester);

    expect(_inSheet(find.text(serverErrorMessage)), findsOneWidget);
    expect(_inSheet(find.text('タグを直す')), findsOneWidget);
    expect(_storedTags(backend), [_tag('ご飯')]);
    await finishImageLoading(tester);
  });

  testWidgets('「位置を動かす」でシートを閉じて案内を出し、写真の上をタップすると、そのタグの位置だけを変えて送る（出どころは user）', (tester) async {
    final backend = await _openViewer(
        tester, _photo(tags: [_tag('ご飯', source: 'ai', x: 0.2, y: 0.3), _tag('夕食', x: 0.6, y: 0.6)]),
        waitFor: _onPhoto('夕食'));

    await _startMoving(tester, 'ご飯');
    expect(find.byType(BottomSheet), findsNothing);
    expect(find.text('新しい位置をタップしてください'), findsOneWidget);
    expect(find.text('やめる'), findsOneWidget);

    await tester.tapAt(_at(tester, 0.8, 0.75));
    await letFramesRun(tester);

    final stored = _storedTags(backend).cast<Map<Object?, Object?>>();
    expect(stored, hasLength(2));
    expect([stored[0]['name'], stored[0]['kind'], stored[0]['source']], ['ご飯', 'food', 'user']);
    expect(stored[0]['x'] as num, closeTo(0.8, 0.01));
    expect(stored[0]['y'] as num, closeTo(0.75, 0.01));
    expect(stored[1], _tag('夕食', x: 0.6, y: 0.6));
    expect(find.text('新しい位置をタップしてください'), findsNothing);
    await finishImageLoading(tester);
  });

  testWidgets('動かす間は「タグを付ける」を押せず、「やめる」と端末の戻る操作では何も送らずに終える（ビューアは閉じない）', (tester) async {
    final tags = [_tag('ご飯', x: 0.2, y: 0.3)];
    final backend = await _openViewer(tester, _photo(tags: tags), waitFor: _onPhoto('ご飯'));

    await _startMoving(tester, 'ご飯');
    expect(_addButton(tester).onPressed, isNull);
    await tester.tap(find.text('やめる'));
    await letFramesRun(tester);
    expect(find.text('新しい位置をタップしてください'), findsNothing);

    await _startMoving(tester, 'ご飯');
    await tester.binding.handlePopRoute();
    await letFramesRun(tester);
    expect(find.text('新しい位置をタップしてください'), findsNothing);
    expect(find.text(_takenAt), findsOneWidget);

    expect(_storedTags(backend), tags);
    await finishImageLoading(tester);
  });

  testWidgets('動かした位置を送れなかったら、理由をスナックバーに出し、タグはそのまま', (tester) async {
    final tags = [_tag('ご飯', x: 0.2, y: 0.3)];
    final backend = await _openViewer(tester, _photo(tags: tags), waitFor: _onPhoto('ご飯'));
    backend.failNext(TripRoute.updatePhoto,
        status: 500, code: 'INTERNAL_ERROR', message: '写真の更新に失敗しました');

    await _startMoving(tester, 'ご飯');
    await tester.tapAt(_at(tester, 0.8, 0.75));
    await letFramesRun(tester);

    expect(find.text(serverErrorMessage), findsOneWidget);
    expect(_storedTags(backend), tags);
    await finishImageLoading(tester);
  });

  testWidgets('「このタグを消す」で確認を出し、「消す」でそのタグを除いて送る', (tester) async {
    final backend = await _openViewer(
        tester, _photo(tags: [_tag('ご飯', source: 'ai', x: 0.2), _tag('夕食', x: 0.7)]),
        waitFor: _onPhoto('夕食'));

    await _openEditSheet(tester, '夕食');
    await tester.tap(_inSheet(find.text('このタグを消す')));
    await letFramesRun(tester);
    expect(find.byType(BottomSheet), findsNothing);
    expect(find.text('「夕食」のタグを消しますか？'), findsOneWidget);
    await tester.tap(find.text('消す'));
    await letFramesRun(tester);

    expect(_storedTags(backend), [_tag('ご飯', source: 'ai', x: 0.2)]);
    await finishImageLoading(tester);
  });
}
