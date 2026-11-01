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

/// 撮影日時が 2026年10月6日 10:15 の食べ物の写真（[number] が 2 なら 10月7日）
Map<String, Object?> _photo({List<Map<String, Object?>> tags = const [], int number = 1}) => photoJson(
    number: number,
    tripId: hokkaidoTripId,
    takenAt: '2026-10-${(5 + number).toString().padLeft(2, '0')}T10:15:00',
    tags: tags)
  ..['category'] = 'food';

/// 旅行詳細を開き、1枚目の写真をタップしてビューアを開く（[more] の写真は後ろに並べる）。
/// [waitFor] があれば、それが出るまで画像を読み込ませる（無ければ画像を読み込ませない）
Future<FakeTripBackend> _openViewer(WidgetTester tester, Map<String, Object?> photo,
    {Finder? waitFor, List<Map<String, Object?>> more = const []}) async {
  final backend = FakeTripBackend(
    trips: [hokkaidoTrip(photoCount: 1 + more.length)],
    functionKey: 'test-key',
    photosByTripId: {
      hokkaidoTripId: [photo, ...more]
    },
  );
  if (waitFor != null) useImageCacheOf(backend, _image);
  await openTripsTab(tester, backend);
  await tester.tap(find.text('北海道 2026秋'));
  await letFramesRun(tester);
  await tester.tap(photoThumbnail(_takenAt));
  await letFramesRun(tester);
  if (waitFor != null) {
    await pumpUntilImageShown(tester, waitFor);
    expect(waitFor, findsWidgets);
  }
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

/// 画像が描かれている範囲（横長 2:1 の画像を、写真の枠の中に縦横の比を保って中央に収める。§5.1）
Rect _imageRect(WidgetTester tester) {
  final box = tester.getRect(find.byType(InteractiveViewer));
  final width = math.min(box.width, box.height * 2);
  return Rect.fromCenter(center: box.center, width: width, height: width / 2);
}

/// 画像の中の割合 ([x], [y]) の画面の位置
Offset _at(WidgetTester tester, double x, double y) {
  final rect = _imageRect(tester);
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

  testWidgets(
      '写真の上の吹き出しか下の情報の札の名前を押すと「タグを直す」シートを開き、今の名前と種類が入っている。名前が前後の空白を除いて空なら「保存」を押せず、「キャンセル」では何も送らない',
      (tester) async {
    final tags = [_tag('ご飯', source: 'ai', x: 0.2), _tag('羊蹄山', kind: 'landscape', x: 0.7)];
    final backend = await _openViewer(tester, _photo(tags: tags), waitFor: _onPhoto('羊蹄山'));

    // 写真の上の吹き出しから
    await _openEditSheet(tester, '羊蹄山');

    expect(_inSheet(find.text('タグを直す')), findsOneWidget);
    expect(tester.widget<TextField>(_inSheet(find.byType(TextField))).controller!.text, '羊蹄山');
    expect(tester.widget<RadioListTile<String>>(_option('風景')).checked, isTrue);
    expect(find.text('「羊蹄山」のタグを消しますか？'), findsNothing);

    await tester.tap(_inSheet(find.text('キャンセル')));
    await letFramesRun(tester);
    expect(find.byType(BottomSheet), findsNothing);
    expect(_storedTags(backend), tags);

    // 下の情報の札の名前から。名前を空白だけにすると「保存」を押せない（付けるシートと同じ。§5.7）
    await tester.tap(_chipLabel('ご飯'));
    await letFramesRun(tester);

    expect(_inSheet(find.text('タグを直す')), findsOneWidget);
    expect(tester.widget<TextField>(_inSheet(find.byType(TextField))).controller!.text, 'ご飯');
    await tester.enterText(_inSheet(find.byType(TextField)), '   ');
    await tester.pump();
    expect(_saveButton(tester).onPressed, isNull);

    await tester.tap(_inSheet(find.text('キャンセル')));
    await letFramesRun(tester);
    expect(find.byType(BottomSheet), findsNothing);
    expect(_storedTags(backend), tags);
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

  testWidgets('名前（前後の空白を除いて）と種類が今のままなら「保存」を押せない', (tester) async {
    await _openViewer(tester, _photo(tags: [_tag('ご飯', source: 'ai')]), waitFor: _onPhoto('ご飯'));

    await _openEditSheet(tester, 'ご飯');
    expect(_saveButton(tester).onPressed, isNull, reason: '開いたまま');
    await tester.enterText(_inSheet(find.byType(TextField)), ' ご飯 ');
    await tester.pump();
    expect(_saveButton(tester).onPressed, isNull, reason: '前後の空白だけ');

    await tester.tap(_option('その他'));
    await tester.pump();
    expect(_saveButton(tester).onPressed, isNotNull, reason: '種類を変えた');
    await tester.tap(_option('食べ物'));
    await tester.pump();
    expect(_saveButton(tester).onPressed, isNull, reason: '種類を戻した');

    await tester.enterText(_inSheet(find.byType(TextField)), '白ご飯');
    await tester.pump();
    expect(_saveButton(tester).onPressed, isNotNull, reason: '名前を変えた');
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

  testWidgets('動かす間に札の「✕」でほかのタグを消したら、動かす間を終え、写真の上をタップしても何も送らない', (tester) async {
    final backend = await _openViewer(
        tester, _photo(tags: [_tag('ご飯', x: 0.2, y: 0.3), _tag('夕食', x: 0.6, y: 0.6)]),
        waitFor: _onPhoto('夕食'));

    await _startMoving(tester, '夕食');
    await tester.tap(find.byTooltip('ご飯のタグを消す'));
    await letFramesRun(tester);
    await tester.tap(find.text('消す'));
    await letFramesRun(tester);

    expect(find.text('新しい位置をタップしてください'), findsNothing);
    await tester.tapAt(_at(tester, 0.8, 0.75));
    await letFramesRun(tester);
    expect(_storedTags(backend), [_tag('夕食', x: 0.6, y: 0.6)]);
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
    expect(find.text('新しい位置をタップしてください'), findsNothing);
    // 表示はそのまま: 吹き出しは元の位置（0.2, 0.3）の真上
    final bubble = tester.getRect(_onPhoto('ご飯'));
    final point = _at(tester, 0.2, 0.3);
    expect((bubble.center.dx - point.dx).abs(), lessThan(2));
    expect(bubble.bottom, lessThan(point.dy));
    expect(_storedTags(backend), tags);
    await finishImageLoading(tester);
  });

  testWidgets('動かす間は、画像の外（余白）のタップでは何もせず、上のバーも隠さず、前後の写真へも移らない', (tester) async {
    final tags = [_tag('ご飯', x: 0.2, y: 0.3)];
    final backend = await _openViewer(tester, _photo(tags: tags),
        more: [_photo(number: 2)], waitFor: _onPhoto('ご飯'));
    await _startMoving(tester, 'ご飯');

    final box = tester.getRect(find.byType(InteractiveViewer));
    await tester.tapAt(Offset(box.center.dx, (box.top + _imageRect(tester).top) / 2));
    await letFramesRun(tester);
    expect(find.byType(AppBar), findsOneWidget);
    expect(find.text('新しい位置をタップしてください'), findsOneWidget);

    await tester.drag(find.byType(PageView), const Offset(-400, 0));
    await letFramesRun(tester);
    expect(find.text(_takenAt), findsOneWidget);
    expect(_storedTags(backend), tags);
    await finishImageLoading(tester);
  });

  testWidgets('動かす間に一覧の続きのページが届いても、動かす間を終えず、開いている写真のそのタグを動かせる', (tester) async {
    // 1ページ目は30枚（10:01〜10:30）、2ページ目は1枚（10:31）。グリッドを末尾まで払って2ページ目を要求させ、その返事を止めておく。
    // 読み込み済みの末尾の 10:30 を開いて動かす間に入ってから、2ページ目を届け、写真の上をタップする
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 31)],
      functionKey: 'test-key',
      pageSize: 30,
      photosByTripId: {
        hokkaidoTripId: [
          for (var n = 1; n <= 31; n++)
            photoJson(
                number: n,
                tripId: hokkaidoTripId,
                takenAt: '2026-10-05T10:${n.toString().padLeft(2, '0')}:00',
                tags: n == 30 ? [_tag('ご飯', source: 'ai')] : const []),
        ],
      },
    );
    useImageCacheOf(backend, _image);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    final reply = backend.holdNextReply(TripRoute.photos);
    await tester.drag(photoGridScroll(), const Offset(0, -5000));
    await letFramesRun(tester);
    await tester.tap(photoThumbnail('2026年10月5日 10:30'));
    await letFramesRun(tester);
    await pumpUntilImageShown(tester, _onPhoto('ご飯'));

    await _startMoving(tester, 'ご飯');
    expect(backend.photoPagesReceived, 2, reason: '2ページ目を要求している');
    reply.complete();
    await letFramesRun(tester);

    expect(find.text('新しい位置をタップしてください'), findsOneWidget);
    expect(find.text('2026年10月5日 10:30').hitTestable(), findsOneWidget, reason: '開いている写真のまま');
    await tester.tapAt(_at(tester, 0.8, 0.75));
    await letFramesRun(tester);
    final photos = backend.photosByTripId[hokkaidoTripId]!;
    final moved = (photos[29]['tags'] as List).single as Map;
    expect([moved['name'], moved['source']], ['ご飯', 'user']);
    expect(moved['x'] as num, closeTo(0.8, 0.01));
    expect(moved['y'] as num, closeTo(0.75, 0.01));
    expect(photos[30]['tags'], isEmpty, reason: '届いた 10:31 は変えない');
    await finishImageLoading(tester);
  });

  testWidgets('動かす間に写真を削除したら、次の写真では動かす間を終える', (tester) async {
    // 札の名前から開けば、画像を読み込まなくても動かす間に入れる
    await _openViewer(tester, _photo(tags: [_tag('ご飯')]), more: [_photo(number: 2, tags: [_tag('夕食')])]);
    await tester.tap(_chipLabel('ご飯'));
    await letFramesRun(tester);
    await tester.tap(_inSheet(find.text('位置を動かす')));
    await letFramesRun(tester);

    await tester.tap(find.descendant(of: find.byType(AppBar), matching: find.text('削除')));
    await letFramesRun(tester);
    await tester.tap(find.descendant(of: find.byType(AlertDialog), matching: find.text('削除')));
    await letFramesRun(tester);

    expect(find.text('2026年10月7日 10:15'), findsOneWidget);
    expect(find.text('新しい位置をタップしてください'), findsNothing);
  });

  testWidgets('動かした位置を送っている間は、吹き出しを押しても直すシートを開かず、「タグを付ける」を押せない', (tester) async {
    final backend = await _openViewer(
        tester, _photo(tags: [_tag('ご飯', x: 0.2, y: 0.3), _tag('夕食', x: 0.7, y: 0.6)]),
        waitFor: _onPhoto('夕食'));
    await _startMoving(tester, 'ご飯');
    final reply = backend.holdNextReply(TripRoute.updatePhoto);

    await tester.tapAt(_at(tester, 0.8, 0.75));
    await tester.pump();
    expect(_addButton(tester).onPressed, isNull);
    await tester.tap(_onPhoto('夕食'), warnIfMissed: false);
    await tester.pump();
    expect(find.text('タグを直す'), findsNothing);

    reply.complete();
    await letFramesRun(tester);
    expect(_addButton(tester).onPressed, isNotNull);
    await finishImageLoading(tester);
  });

  testWidgets('直したタグの保存を待っている間は、「位置を動かす」「このタグを消す」を押せない', (tester) async {
    final backend = await _openViewer(tester, _photo(tags: [_tag('ご飯')]), waitFor: _onPhoto('ご飯'));
    final reply = backend.holdNextReply(TripRoute.updatePhoto);

    await _openEditSheet(tester, 'ご飯');
    await tester.enterText(_inSheet(find.byType(TextField)), '白ご飯');
    await tester.pump();
    await tester.tap(_inSheet(find.text('保存')));
    await tester.pump();

    for (final label in ['位置を動かす', 'このタグを消す']) {
      final button = tester.widget<TextButton>(
          find.ancestor(of: _inSheet(find.text(label)), matching: find.byWidgetPredicate((w) => w is TextButton)).first);
      expect(button.onPressed, isNull, reason: label);
    }

    reply.complete();
    await letFramesRun(tester);
    await finishImageLoading(tester);
  });

  testWidgets('タグを付ける間・動かす間は、吹き出しを押しても直すシートを開かず、その位置のタップになる', (tester) async {
    final backend = await _openViewer(
        tester, _photo(tags: [_tag('ご飯', x: 0.3, y: 0.5), _tag('夕食', x: 0.7, y: 0.5)]),
        waitFor: _onPhoto('夕食'));

    // 付ける間: 付けるシートを開く
    await tester.tap(find.byTooltip('タグを付ける'));
    await letFramesRun(tester);
    await tester.tap(_onPhoto('ご飯'));
    await letFramesRun(tester);
    expect(_inSheet(find.text('タグを付ける')), findsOneWidget);
    expect(_inSheet(find.text('タグを直す')), findsNothing);
    await tester.tap(_inSheet(find.text('キャンセル')));
    await letFramesRun(tester);
    await tester.tap(find.text('やめる'));
    await letFramesRun(tester);

    // 動かす間: 押した吹き出しの場所へ動かす（吹き出しはタグの位置の上にある）
    await _startMoving(tester, '夕食');
    await tester.tap(_onPhoto('ご飯'));
    await letFramesRun(tester);
    expect(find.byType(BottomSheet), findsNothing);
    final moved = _storedTags(backend)[1] as Map<Object?, Object?>;
    expect(moved['x'] as num, closeTo(0.3, 0.05));
    expect(moved['y'] as num, lessThan(0.5));
    await finishImageLoading(tester);
  });

  // 「このタグを消す」で確認を出して消すことは、§5.7 の「消す」と同じ確認・送り方なので photo_viewer_tags_test.dart の「タグを消す」で見る
}
