import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../helpers/app_test_helpers.dart';
import '../helpers/trip_test_helpers.dart';

// 写真のタグ（docs/03_screen_design.md §5.7。C-3b。02 §5 #57）。
// 入口は旅行詳細の写真のグリッドから開く写真ビューア。写真の上のタグは画像の大きさが要るので、
// 偽のサーバから画像（横 40・縦 20 の PNG）を読み込ませる（useImageCacheOf）

/// 横 40・縦 20（横長 2:1）の PNG
final _image = base64Decode(
    'iVBORw0KGgoAAAANSUhEUgAAACgAAAAUCAIAAABwJOjsAAAAJElEQVR4nGM4UaExIIhh1OJRi0ctHrV41OJRi0ctHrV45FgMAJcsZT0VWwT2AAAAAElFTkSuQmCC');

const _takenAt = '2026年10月6日 10:15';

/// タグ（名前・種類・位置・出どころ。04 §2）
Map<String, Object?> _tag(String name,
        {String kind = 'food', double x = 0.5, double y = 0.5}) =>
    {'name': name, 'kind': kind, 'x': x, 'y': y, 'source': 'user'};

/// 撮影日時が 2026年10月6日 10:15 の写真（[number] が 2 なら 10月7日）
Map<String, Object?> _photo(
        {List<Map<String, Object?>> tags = const [],
        String? category = 'food',
        int number = 1}) =>
    photoJson(
        number: number,
        tripId: hokkaidoTripId,
        takenAt: '2026-10-${(5 + number).toString().padLeft(2, '0')}T10:15:00',
        tags: tags)
      ..['category'] = category;

/// 旅行詳細を開き、1枚目の写真をタップしてビューアを開く（[more] の写真は後ろに並べる）。
/// [loadImage] なら画像を読み込ませ、[waitFor] が出るまで待つ
Future<FakeTripBackend> _openViewer(
    WidgetTester tester, Map<String, Object?> photo,
    {List<Map<String, Object?>> more = const [],
    bool loadImage = true,
    Finder? waitFor}) async {
  final backend = FakeTripBackend(
    trips: [hokkaidoTrip(photoCount: 1 + more.length)],
    functionKey: 'test-key',
    photosByTripId: {
      hokkaidoTripId: [photo, ...more]
    },
  );
  if (loadImage) useImageCacheOf(backend, _image);
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

/// 写真の上の、名前が [name] のタグ
Finder _onPhoto(String name) => find.descendant(
    of: find.byType(InteractiveViewer), matching: find.text(name));

/// 下の情報のタグの一覧の、名前が [name] の札（押せる札も含めて、札の部品で探す）
Finder _chip(String name) => find.widgetWithText(RawChip, name);

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

/// 上のバーの「タグを付ける」
IconButton _addButton(WidgetTester tester) => tester.widget<IconButton>(
    find.ancestor(of: find.byTooltip('タグを付ける'), matching: find.byType(IconButton)));

/// シートの中の [text]
Finder _inSheet(Finder finder) =>
    find.descendant(of: find.byType(BottomSheet), matching: finder);

/// シートの種類の選択肢 [label]
Finder _option(String label) => _inSheet(find.widgetWithText(RadioListTile<String>, label));

/// 「タグを付ける」を押し、画像の中の割合 ([x], [y]) をタップしてシートを開く
Future<void> _startAdding(WidgetTester tester, double x, double y) async {
  await tester.tap(find.byTooltip('タグを付ける'));
  await letFramesRun(tester);
  await tester.tapAt(_at(tester, x, y));
  await letFramesRun(tester);
}

void main() {
  group('タグを見る', () {
    testWidgets(
        '写真の上の各タグの位置に名前を出し、下の情報に「タグ:」とタグの札を保存順に並べる（同じ名前も）。写真をタップして隠すと写真の上のタグも消える',
        (tester) async {
      final tags = [
        _tag('海鮮丼', x: 0.25, y: 0.75),
        _tag('味噌汁', x: 0.7, y: 0.2),
        _tag('海鮮丼', x: 0.8, y: 0.8),
        _tag('刺身', x: 0.4, y: 0.4),
      ];
      await _openViewer(tester, _photo(tags: tags), waitFor: _onPhoto('味噌汁'));

      // 名前は吹き出しで、タグの位置の真上に出す（§5.9。C-4c）。同じ名前のタグもあるので、名前ごとに「どれかがその位置にある」で見る
      for (final tag in tags) {
        final point = _at(tester, tag['x'] as double, tag['y'] as double);
        final labels = _onPhoto(tag['name'] as String);
        final rects = [
          for (var i = 0; i < labels.evaluate().length; i++)
            tester.getRect(labels.at(i))
        ];
        expect(
            rects.any((rect) =>
                (rect.center.dx - point.dx).abs() < 2 &&
                rect.bottom < point.dy &&
                point.dy - rect.bottom < 24),
            isTrue,
            reason: '$tag');
      }
      expect(find.text('タグ:'), findsOneWidget);
      expect(_chip('海鮮丼'), findsNWidgets(2));
      // 札は保存順（海鮮丼・味噌汁・海鮮丼・刺身）
      final order = [
        _chip('海鮮丼').first,
        _chip('味噌汁'),
        _chip('海鮮丼').last,
        _chip('刺身'),
      ].map((chip) => tester.getTopLeft(chip)).toList();
      for (var i = 1; i < order.length; i++) {
        final before = order[i - 1];
        final after = order[i];
        expect(after.dy > before.dy || (after.dy == before.dy && after.dx > before.dx),
            isTrue,
            reason: '$i 枚目の札が前の札の後ろにある');
      }

      // 写真をタップして上のバーと下の情報を隠すと、写真の上のタグも消える
      await tester.tapAt(_at(tester, 0.5, 0.5));
      await letFramesRun(tester);
      expect(find.byType(AppBar), findsNothing);
      expect(_onPhoto('味噌汁'), findsNothing);
      await finishImageLoading(tester);
    });

    testWidgets('タグが無ければ「タグ:」の行を出さない', (tester) async {
      await _openViewer(tester, _photo(), loadImage: false);

      expect(find.text('タグ:'), findsNothing);
      expect(find.byType(Chip), findsNothing);
    });

    testWidgets('画像を読み込めないときは写真の上にタグを出さず、下の情報の一覧には出す', (tester) async {
      await _openViewer(tester, _photo(tags: [_tag('海鮮丼')]), loadImage: false);

      expect(_onPhoto('海鮮丼'), findsNothing);
      expect(_chip('海鮮丼'), findsOneWidget);
    });
  });

  group('タグを付ける', () {
    testWidgets(
        '「タグを付ける」で案内を出し、写真の上をタップするとその位置でシートを開き、名前と種類（既定は写真のカテゴリ）を保存すると、今のタグの後ろに足して送り、写真の上と一覧に出す',
        (tester) async {
      final backend = await _openViewer(
          tester, _photo(tags: [_tag('海鮮丼', x: 0.2, y: 0.2)], category: 'food'),
          waitFor: _onPhoto('海鮮丼'));

      await tester.tap(find.byTooltip('タグを付ける'));
      await letFramesRun(tester);
      expect(find.text('タグを付ける場所をタップしてください'), findsOneWidget);
      await tester.tapAt(_at(tester, 0.25, 0.75));
      await letFramesRun(tester);

      expect(_inSheet(find.text('タグを付ける')), findsOneWidget);
      // 選ばれているかは読み上げの「選択済み」で見る
      expect(tester.getSemantics(_option('食べ物')), containsSemantics(isChecked: true));
      await tester.enterText(_inSheet(find.byType(TextField)), '  味噌汁 ');
      await tester.pump();
      await tester.tap(_inSheet(find.text('保存')));
      await letFramesRun(tester);

      final stored = _storedTags(backend);
      expect(stored, hasLength(2));
      expect(stored.first, _tag('海鮮丼', x: 0.2, y: 0.2));
      final added = stored.last as Map<String, Object?>;
      expect(added['name'], '味噌汁');
      expect(added['kind'], 'food');
      expect(added['x'] as double, closeTo(0.25, 0.02));
      expect(added['y'] as double, closeTo(0.75, 0.02));
      expect(find.byType(BottomSheet), findsNothing);
      expect(find.text('タグを付ける場所をタップしてください'), findsNothing);
      expect(_onPhoto('味噌汁'), findsOneWidget);
      expect(_chip('味噌汁'), findsOneWidget);
      await finishImageLoading(tester);
    });

    testWidgets('種類は選び直せ、写真のカテゴリが無ければ既定は「その他」', (tester) async {
      final backend = await _openViewer(
          tester, _photo(tags: [_tag('海鮮丼')], category: null),
          waitFor: _onPhoto('海鮮丼'));

      await _startAdding(tester, 0.5, 0.5);
      expect(tester.getSemantics(_option('その他')), containsSemantics(isChecked: true));
      await tester.enterText(_inSheet(find.byType(TextField)), '紅葉');
      await tester.tap(_inSheet(find.text('植物')));
      await tester.pump();
      await tester.tap(_inSheet(find.text('保存')));
      await letFramesRun(tester);

      expect((_storedTags(backend).last as Map)['kind'], 'plant');
      await finishImageLoading(tester);
    });

    testWidgets(
        '付ける間は、画像の外（余白）のタップでは何もせず、上のバーも隠さず、前後の写真へも移らない。「やめる」で付けずに終わる',
        (tester) async {
      await _openViewer(tester, _photo(tags: [_tag('海鮮丼')]),
          more: [_photo(number: 2)], waitFor: _onPhoto('海鮮丼'));
      await tester.tap(find.byTooltip('タグを付ける'));
      await letFramesRun(tester);

      // 横長の画像の上の余白
      final rect = _imageRect(tester);
      final box = tester.getRect(find.byType(InteractiveViewer));
      expect(rect.top - box.top, greaterThan(40), reason: '余白がある');
      await tester.tapAt(Offset(box.center.dx, (box.top + rect.top) / 2));
      await letFramesRun(tester);
      expect(find.byType(BottomSheet), findsNothing);
      expect(find.byType(AppBar), findsOneWidget);

      await tester.drag(find.byType(PageView), const Offset(-400, 0));
      await letFramesRun(tester);
      expect(find.text(_takenAt), findsOneWidget);

      await tester.tap(find.text('やめる'));
      await letFramesRun(tester);
      expect(find.text('タグを付ける場所をタップしてください'), findsNothing);
      // 付ける間を終えたら、写真のタップで上のバーを隠せる
      await tester.tapAt(_at(tester, 0.5, 0.9));
      await letFramesRun(tester);
      expect(find.byType(AppBar), findsNothing);
      await finishImageLoading(tester);
    });

    testWidgets('シートの「キャンセル」では何も送らず、付ける間のまま（別の場所をタップし直せる）', (tester) async {
      final backend = await _openViewer(tester, _photo(tags: [_tag('海鮮丼')]),
          waitFor: _onPhoto('海鮮丼'));

      await _startAdding(tester, 0.5, 0.5);
      await tester.enterText(_inSheet(find.byType(TextField)), '味噌汁');
      await tester.tap(_inSheet(find.text('キャンセル')));
      await letFramesRun(tester);

      expect(find.byType(BottomSheet), findsNothing);
      expect(_storedTags(backend), [_tag('海鮮丼')]);
      expect(find.text('タグを付ける場所をタップしてください'), findsOneWidget);
      await tester.tapAt(_at(tester, 0.3, 0.3));
      await letFramesRun(tester);
      expect(find.byType(BottomSheet), findsOneWidget);
      await finishImageLoading(tester);
    });

    testWidgets('名前が前後の空白を除いて空なら「保存」を押せず、名前は 30 文字で止める', (tester) async {
      await _openViewer(tester, _photo(tags: [_tag('海鮮丼')]),
          waitFor: _onPhoto('海鮮丼'));
      await _startAdding(tester, 0.5, 0.5);

      ButtonStyleButton save() => tester.widget<ButtonStyleButton>(find.ancestor(
          of: _inSheet(find.text('保存')), matching: find.bySubtype<ButtonStyleButton>()));
      expect(save().onPressed, isNull);
      await tester.enterText(_inSheet(find.byType(TextField)), '   ');
      await tester.pump();
      expect(save().onPressed, isNull);
      await tester.enterText(_inSheet(find.byType(TextField)), 'あ' * 31);
      await tester.pump();
      expect(tester.widget<TextField>(_inSheet(find.byType(TextField))).controller!.text,
          'あ' * 30);
      expect(save().onPressed, isNotNull);
      await finishImageLoading(tester);
    });

    testWidgets('保存に失敗したらシートに留まって理由を出し、押し直せる。保存を待っている間は「キャンセル」「保存」もシートの外のタップも下へ払う操作も効かない',
        (tester) async {
      final backend = await _openViewer(tester, _photo(tags: [_tag('海鮮丼')]),
          waitFor: _onPhoto('海鮮丼'));
      await _startAdding(tester, 0.5, 0.5);
      await tester.enterText(_inSheet(find.byType(TextField)), '味噌汁');
      await tester.pump();

      final reply = backend.holdNextReply(TripRoute.updatePhoto);
      addTearDown(() {
        if (!reply.isCompleted) reply.complete();
      });
      backend.failNext(TripRoute.updatePhoto,
          status: 500, code: 'INTERNAL_ERROR', message: '写真の更新に失敗しました');
      await tester.tap(_inSheet(find.text('保存')));
      await tester.pump();
      // 待っている間は、シートの外のタップでも下へ払っても閉じず、「キャンセル」「保存」も押せない
      await tester.tapAt(const Offset(10, 10));
      await tester.pump();
      await tester.drag(_inSheet(find.text('タグを付ける')), const Offset(0, 500));
      await tester.pump();
      expect(find.byType(BottomSheet), findsOneWidget);
      for (final label in ['キャンセル', '保存']) {
        expect(
            tester.widget<ButtonStyleButton>(find.ancestor(
                    of: _inSheet(find.text(label)),
                    matching: find.bySubtype<ButtonStyleButton>()))
                .onPressed,
            isNull,
            reason: label);
      }
      reply.complete();
      await letFramesRun(tester);

      expect(find.byType(BottomSheet), findsOneWidget);
      expect(_inSheet(find.text(serverErrorMessage)), findsOneWidget);
      expect(_storedTags(backend), [_tag('海鮮丼')]);

      // 失敗した後は、そのまま押し直せる
      await tester.tap(_inSheet(find.text('保存')));
      await letFramesRun(tester);
      expect(find.byType(BottomSheet), findsNothing);
      expect(_storedTags(backend), hasLength(2));
      await finishImageLoading(tester);
    });

    testWidgets('付ける間に端末の戻る操作をすると、付ける間を終え、ビューアは閉じない', (tester) async {
      await _openViewer(tester, _photo(tags: [_tag('海鮮丼')]), loadImage: false);
      await tester.tap(find.byTooltip('タグを付ける'));
      await letFramesRun(tester);

      await tester.binding.handlePopRoute();
      await letFramesRun(tester);

      expect(find.text('タグを付ける場所をタップしてください'), findsNothing);
      expect(find.text(_takenAt), findsOneWidget);
    });

    testWidgets('付ける間に写真を削除したら、次の写真では付ける間を終える', (tester) async {
      await _openViewer(tester, _photo(tags: [_tag('海鮮丼')]),
          more: [_photo(number: 2)], loadImage: false);
      await tester.tap(find.byTooltip('タグを付ける'));
      await letFramesRun(tester);

      await tester.tap(find.descendant(
          of: find.byType(AppBar), matching: find.text('削除')));
      await letFramesRun(tester);
      await tester.tap(find.descendant(
          of: find.byType(AlertDialog), matching: find.text('削除')));
      await letFramesRun(tester);

      expect(find.text('2026年10月7日 10:15'), findsOneWidget);
      expect(find.text('タグを付ける場所をタップしてください'), findsNothing);
    });

    testWidgets('画像を読み込めないときは、付ける間に写真をタップしても何もしない', (tester) async {
      await _openViewer(tester, _photo(tags: [_tag('海鮮丼')]), loadImage: false);
      await tester.tap(find.byTooltip('タグを付ける'));
      await letFramesRun(tester);

      await tester.tapAt(tester.getCenter(find.byType(InteractiveViewer)));
      await letFramesRun(tester);

      expect(find.byType(BottomSheet), findsNothing);
      expect(find.byType(AppBar), findsOneWidget);
      expect(find.text('タグを付ける場所をタップしてください'), findsOneWidget);
    });

    testWidgets('タグが 20 個ある写真では「タグを付ける」を押せない', (tester) async {
      await _openViewer(
          tester, _photo(tags: [for (var i = 0; i < 20; i++) _tag('タグ$i')]),
          loadImage: false);

      expect(_addButton(tester).onPressed, isNull);
    });

    testWidgets('タグが 19 個の写真では「タグを付ける」を押せる', (tester) async {
      await _openViewer(
          tester, _photo(tags: [for (var i = 0; i < 19; i++) _tag('タグ$i')]),
          loadImage: false);

      expect(_addButton(tester).onPressed, isNotNull);
    });
  });

  group('タグを消す', () {
    testWidgets(
        '写真の上のタグの直すシートの「このタグを消す」で確認を出し、「キャンセル」なら何もせず、「消す」で押したタグだけを除いて送る（同じ名前の他のタグは残る）',
        (tester) async {
      final backend = await _openViewer(
          tester,
          _photo(tags: [
            _tag('海鮮丼', x: 0.3, y: 0.3),
            _tag('味噌汁', x: 0.5, y: 0.5),
            _tag('海鮮丼', x: 0.7, y: 0.7),
          ]),
          waitFor: _onPhoto('味噌汁'));

      // 吹き出しはタグの位置の上に出る。押すと直すシートを開く（§5.9.3）
      await tester.tapAt(_at(tester, 0.7, 0.7) + const Offset(0, -20));
      await letFramesRun(tester);
      await tester.tap(_inSheet(find.text('このタグを消す')));
      await letFramesRun(tester);
      // 直すシートを閉じてから確認を出す（§5.9.3）
      expect(find.byType(BottomSheet), findsNothing);
      expect(find.text('「海鮮丼」のタグを消しますか？'), findsOneWidget);
      await tester.tap(find.text('キャンセル'));
      await letFramesRun(tester);
      expect(_storedTags(backend), hasLength(3));

      await tester.tapAt(_at(tester, 0.7, 0.7) + const Offset(0, -20));
      await letFramesRun(tester);
      await tester.tap(_inSheet(find.text('このタグを消す')));
      await letFramesRun(tester);
      await tester.tap(find.text('消す'));
      await letFramesRun(tester);

      expect(_storedTags(backend),
          [_tag('海鮮丼', x: 0.3, y: 0.3), _tag('味噌汁', x: 0.5, y: 0.5)]);
      expect(_chip('海鮮丼'), findsOneWidget);
      await finishImageLoading(tester);
    });

    testWidgets('下の情報の札の「✕」でも同じ確認を出して消す（読み上げ「{名前}のタグを消す」）', (tester) async {
      final backend = await _openViewer(
          tester, _photo(tags: [_tag('海鮮丼'), _tag('味噌汁')]),
          loadImage: false);

      // 押した札のタグを消す（最後の札でなくても）
      await tester.tap(find.byTooltip('海鮮丼のタグを消す'));
      await letFramesRun(tester);
      expect(find.text('「海鮮丼」のタグを消しますか？'), findsOneWidget);
      await tester.tap(find.text('消す'));
      await letFramesRun(tester);

      expect(_storedTags(backend), [_tag('味噌汁')]);
      expect(_chip('海鮮丼'), findsNothing);
    });

    testWidgets('消すのに失敗したら理由をスナックバーに出し、表示はそのまま', (tester) async {
      final backend = await _openViewer(
          tester, _photo(tags: [_tag('海鮮丼'), _tag('味噌汁')]),
          loadImage: false);
      backend.failNext(TripRoute.updatePhoto,
          status: 500, code: 'INTERNAL_ERROR', message: '写真の更新に失敗しました');

      await tester.tap(find.byTooltip('味噌汁のタグを消す'));
      await letFramesRun(tester);
      await tester.tap(find.text('消す'));
      await letFramesRun(tester);

      expect(find.text(serverErrorMessage), findsOneWidget);
      expect(_chip('味噌汁'), findsOneWidget);
      expect(_storedTags(backend), hasLength(2));
    });

    testWidgets('付ける間に札の「✕」で消している間は、写真の上をタップしてもシートを開かない（消す前のタグで保存して、消したタグを戻さない）',
        (tester) async {
      final backend = await _openViewer(
          tester, _photo(tags: [_tag('海鮮丼', x: 0.3), _tag('味噌汁', x: 0.7)]),
          waitFor: _onPhoto('味噌汁'));
      await tester.tap(find.byTooltip('タグを付ける'));
      await letFramesRun(tester);
      final reply = backend.holdNextReply(TripRoute.updatePhoto);

      await tester.tap(find.byTooltip('味噌汁のタグを消す'));
      await letFramesRun(tester);
      await tester.tap(find.text('消す'));
      await tester.pump();
      await tester.tapAt(_at(tester, 0.5, 0.9));
      await tester.pump();
      expect(find.byType(BottomSheet), findsNothing);

      reply.complete();
      await letFramesRun(tester);
      expect(_storedTags(backend), [_tag('海鮮丼', x: 0.3)]);
      await finishImageLoading(tester);
    });

    testWidgets('消している間は、ほかのタグの「✕」・写真の上の名前・「タグを付ける」を押せない', (tester) async {
      final backend = await _openViewer(
          tester, _photo(tags: [_tag('海鮮丼', x: 0.3), _tag('味噌汁', x: 0.7)]),
          waitFor: _onPhoto('味噌汁'));
      final reply = backend.holdNextReply(TripRoute.updatePhoto);

      await tester.tap(find.byTooltip('味噌汁のタグを消す'));
      await letFramesRun(tester);
      await tester.tap(find.text('消す'));
      await tester.pump();

      expect(_addButton(tester).onPressed, isNull);
      await tester.tap(find.byTooltip('海鮮丼のタグを消す'), warnIfMissed: false);
      await tester.pump();
      expect(find.text('「海鮮丼」のタグを消しますか？'), findsNothing, reason: '一覧の✕');
      await tester.tap(_onPhoto('海鮮丼'), warnIfMissed: false);
      await tester.pump();
      expect(find.text('タグを直す'), findsNothing, reason: '写真の上の名前');

      reply.complete();
      await letFramesRun(tester);
      expect(_storedTags(backend), [_tag('海鮮丼', x: 0.3)]);
      // 消し終えたら、また押せる
      expect(_addButton(tester).onPressed, isNotNull);
      await tester.tap(find.byTooltip('海鮮丼のタグを消す'));
      await letFramesRun(tester);
      expect(find.text('「海鮮丼」のタグを消しますか？'), findsOneWidget);
      await finishImageLoading(tester);
    });
  });
}
