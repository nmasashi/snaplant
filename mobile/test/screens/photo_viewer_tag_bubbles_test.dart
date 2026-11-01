import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:snaplant_mobile/main.dart';

import '../helpers/app_test_helpers.dart';
import '../helpers/trip_test_helpers.dart';

// タグの見せ方と直し方（docs/03_screen_design.md §5.9。C-4c。02 §5 #61）。
// 吹き出しの位置は画像の大きさが要るので、偽のサーバから画像（横 40・縦 20 の PNG）を読み込ませる（useImageCacheOf）

/// 横 40・縦 20（横長 2:1）の PNG
final _image = base64Decode(
    'iVBORw0KGgoAAAANSUhEUgAAACgAAAAUCAIAAABwJOjsAAAAJElEQVR4nGM4UaExIIhh1OJRi0ctHrV41OJRi0ctHrV45FgMAJcsZT0VWwT2AAAAAElFTkSuQmCC');

const _takenAt = '2026年10月6日 10:15';

/// タグ（名前・種類・位置・出どころ。04 §2）
Map<String, Object?> _tag(String name,
        {double x = 0.5, double y = 0.5, String source = 'user'}) =>
    {'name': name, 'kind': 'food', 'x': x, 'y': y, 'source': source};

/// 撮影日時が 2026年10月6日 10:15 の食べ物の写真（[number] が 2 なら 10月7日）
Map<String, Object?> _photo(
    {List<Map<String, Object?>> tags = const [],
    int number = 1,
    Map<String, Object?>? processing}) {
  final photo = photoJson(
      number: number,
      tripId: hokkaidoTripId,
      takenAt: '2026-10-${(5 + number).toString().padLeft(2, '0')}T10:15:00',
      tags: tags)
    ..['category'] = 'food';
  if (processing != null) photo['processing'] = processing;
  return photo;
}

/// 旅行詳細を開き、1枚目の写真をタップしてビューアを開く。[waitFor] が出るまで画像を読み込ませる
Future<FakeTripBackend> _openViewer(WidgetTester tester, List<Map<String, Object?>> photos,
    {Finder? waitFor}) async {
  final backend = FakeTripBackend(
    trips: [hokkaidoTrip(photoCount: photos.length)],
    functionKey: 'test-key',
    photosByTripId: {hokkaidoTripId: photos},
  );
  useImageCacheOf(backend, _image);
  await openTripsTab(tester, backend);
  await tester.tap(find.text('北海道 2026秋'));
  await letFramesRun(tester);
  await tester.tap(photoThumbnail(_takenAt));
  await letFramesRun(tester);
  if (waitFor != null) await pumpUntilImageShown(tester, waitFor);
  return backend;
}

/// 偽のサーバにある1枚目の写真のタグ
List<Object?> _storedTags(FakeTripBackend backend) =>
    backend.photosByTripId[hokkaidoTripId]!.first['tags'] as List<Object?>;

/// 写真の上の、名前が [name] の吹き出し
Finder _onPhoto(String name) => find.descendant(
    of: find.byType(InteractiveViewer), matching: find.text(name));

/// 画像の中の割合 ([x], [y]) の画面の位置（横長 2:1 の画像を、写真の枠の中に縦横の比を保って中央に収める。§5.1）
Offset _at(WidgetTester tester, double x, double y) {
  final box = tester.getRect(find.byType(InteractiveViewer));
  final width = math.min(box.width, box.height * 2);
  final rect = Rect.fromCenter(center: box.center, width: width, height: width / 2);
  return Offset(rect.left + rect.width * x, rect.top + rect.height * y);
}

void main() {
  // 表示の切り替えは端末に覚えるので、テストごとに空にする（最初は「表示中」）
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets('写真の上のタグを、名前を書いた吹き出しで出し、しっぽの先がタグの位置に来る（番号は付けない）', (tester) async {
    final tags = [_tag('ご飯', x: 0.25, y: 0.75), _tag('味噌汁', x: 0.7, y: 0.4)];
    await _openViewer(tester, [_photo(tags: tags)], waitFor: _onPhoto('味噌汁'));

    for (final tag in tags) {
      final point = _at(tester, tag['x'] as double, tag['y'] as double);
      final label = tester.getRect(_onPhoto(tag['name'] as String));
      // 名前は位置の真上に、横の中央をそろえて出す（しっぽの分だけ上）
      expect((label.center.dx - point.dx).abs(), lessThan(2), reason: '$tag');
      expect(label.bottom, lessThan(point.dy), reason: '$tag');
      expect(point.dy - label.bottom, lessThan(24), reason: '$tag');
    }
    expect(find.textContaining('1.'), findsNothing);
    await finishImageLoading(tester);
  });

  testWidgets('上のバーの「タグ 表示中」を押すと写真の上の吹き出しを隠して「タグ 非表示」にし、下の一覧は出したまま。もう一度押すと出す', (tester) async {
    await _openViewer(tester, [_photo(tags: [_tag('ご飯')])], waitFor: _onPhoto('ご飯'));

    expect(find.byTooltip('タグを隠す'), findsOneWidget);
    await tester.tap(find.text('タグ 表示中'));
    await letFramesRun(tester);

    expect(_onPhoto('ご飯'), findsNothing);
    expect(find.widgetWithText(Chip, 'ご飯'), findsOneWidget);
    expect(find.text('タグ 非表示'), findsOneWidget);
    expect(find.byTooltip('タグを出す'), findsOneWidget);

    await tester.tap(find.text('タグ 非表示'));
    await letFramesRun(tester);
    expect(_onPhoto('ご飯'), findsOneWidget);
    await finishImageLoading(tester);
  });

  testWidgets('表示の切り替えはアプリ全体で覚え、ビューアを開き直しても、アプリを開き直しても隠したまま', (tester) async {
    final backend = await _openViewer(tester, [_photo(tags: [_tag('ご飯')])], waitFor: _onPhoto('ご飯'));
    await tester.tap(find.text('タグ 表示中'));
    await letFramesRun(tester);

    await tapBack(tester);
    await letFramesRun(tester);
    await tester.tap(photoThumbnail(_takenAt));
    await letFramesRun(tester);
    expect(find.text('タグ 非表示'), findsOneWidget);
    expect(_onPhoto('ご飯'), findsNothing);
    await finishImageLoading(tester);

    // アプリを開き直す（木を消してから開く。CLAUDE.md）。openTripsTab は端末の保存を空にするので使わない
    await tester.pumpWidget(const SizedBox());
    await openApp(tester, app: SnapPlantApp(httpClient: backend.client));
    await tester.tap(find.text('旅行'));
    await letFramesRun(tester);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    await tester.tap(photoThumbnail(_takenAt));
    await letFramesRun(tester);
    expect(find.text('タグ 非表示'), findsOneWidget);
    await finishImageLoading(tester);
  });

  // 待っている（pending）と、している（tagging）
  for (final state in ['pending', 'tagging']) {
    testWidgets('タグの提案の段で $state の写真は「AI がタグを考えています…（写真を閉じても続きます）」を出し、「分類中...」は出さない', (tester) async {
      await _openViewer(tester, [
        _photo(processing: {'state': state, 'step': 'tag', 'attempts': 1, 'lastError': null, 'updatedAt': '2026-10-06T01:15:00.000Z'})
      ]);

      expect(find.text('AI がタグを考えています…（写真を閉じても続きます）'), findsOneWidget);
      expect(find.text('分類中...'), findsNothing);
      // カテゴリは決まっているので、手で直すボタンを出す
      expect(find.text('食べ物'), findsWidgets);
      await finishImageLoading(tester);
    });
  }

  // タグの提案を待っている写真のサムネイルに分類中の印を付けないこと（§5.5）は、photo_classification_test.dart のサムネイルの印の表で見る

  testWidgets('タグを付ける・消すときは、直さなかったタグを受け取った出どころのまま送り、新しく付けたタグは user で送る', (tester) async {
    final backend = await _openViewer(tester, [
      _photo(tags: [_tag('ご飯', x: 0.2, y: 0.3, source: 'ai'), _tag('夕食', x: 0.6, y: 0.6)])
    ], waitFor: _onPhoto('ご飯'));

    await tester.tap(find.byTooltip('タグを付ける'));
    await letFramesRun(tester);
    await tester.tapAt(_at(tester, 0.8, 0.8));
    await letFramesRun(tester);
    await tester.enterText(find.descendant(of: find.byType(BottomSheet), matching: find.byType(TextField)), '漬物');
    await tester.pump();
    await tester.tap(find.descendant(of: find.byType(BottomSheet), matching: find.text('保存')));
    await letFramesRun(tester);

    expect([for (final tag in _storedTags(backend)) (tag as Map)['source']], ['ai', 'user', 'user']);

    // 下の情報の札の「✕」で「夕食」を消す。残る AI のタグは ai のまま
    await tester.tap(find.byTooltip('夕食のタグを消す'));
    await letFramesRun(tester);
    await tester.tap(find.text('消す'));
    await letFramesRun(tester);

    expect([for (final tag in _storedTags(backend)) ((tag as Map)['name'], tag['source'])], [('ご飯', 'ai'), ('漬物', 'user')]);
    await finishImageLoading(tester);
  });
}
