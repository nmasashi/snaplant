import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../helpers/app_test_helpers.dart';
import '../helpers/trip_test_helpers.dart';

// 場面の写真の一覧（docs/03_screen_design.md §8.8。U-1a）。
// 入口は旅行詳細の「タイムライン」の完成版（§8.3）の場面のタップ

/// 場面の写真（番号から id を作る）
Map<String, Object?> _photo(int number, String takenAt,
        {String category = 'landscape'}) =>
    timelinePhotoJson(number, takenAt, category: category);

/// 完成版の場面（05 §5.15 の `current.days[].scenes[]`）
Map<String, Object?> _scene(List<Map<String, Object?>> photos,
        {required String? label, List<String> placeNames = const []}) =>
    {
      ...timelineSceneJson(photos),
      'placeNames': placeNames,
      'label': label,
      'labelSource': label == null ? null : 'ai',
      'note': null,
      'noteSource': null,
    };

/// 朝ごはん（写真 1・2）、小樽運河さんぽ（写真 3〜8 の6枚）、見出しの無い場面（写真 9 の1枚。地名なし）の1日
List<Map<String, Object?>> _scenes() => [
      _scene(
          [
            _photo(1, '2026-10-05T07:50:00', category: 'food'),
            _photo(2, '2026-10-05T07:58:00', category: 'food'),
          ],
          label: '朝ごはん',
          placeNames: ['北海道千歳市']),
      _scene(
          [
            for (var n = 3; n <= 8; n++)
              _photo(n, '2026-10-05T1${n - 3}:10:00'),
          ],
          label: '小樽運河さんぽ',
          placeNames: ['北海道小樽市', '北海道余市町']),
      _scene([_photo(9, '2026-10-05T18:30:00')], label: null),
    ];

/// 完成版（[scenes] の1日だけ）
Map<String, Object?> _current(List<Map<String, Object?>> scenes) => {
      'writtenAt': '2026-10-25T09:10:00.000Z',
      'days': [
        {
          'date': '2026-10-05',
          'dayNumber': 1,
          'title': '小樽の運河と寿司',
          'titleSource': 'ai',
          'summary': '朝は市場で海鮮丼、昼は運河を歩いた。',
          'summarySource': 'ai',
          'scenes': scenes,
        },
      ],
    };

/// タイムライン（完成版と、あれば下書き）
Map<String, Object?> _timelineOf(
        {List<Map<String, Object?>>? scenes, Map<String, Object?>? draft}) =>
    {
      'current': _current(scenes ?? _scenes()),
      'draft': draft,
      'changes': {'added': 0, 'removed': 0},
    };

/// 別の端末が作り直しを始めた後のタイムライン（API は完成版を消して下書きを作る。5-6b）
final _rebuilding = {
  'current': null,
  'draft': {
    'id': '0b8e1c5a-0000-4000-8000-000000000099',
    'reason': 'create',
    'phase': 'proposing',
    'job': {'step': 'propose', 'state': 'pending', 'lastError': null},
    'startedAt': '2026-10-26T09:00:00.000Z',
  },
  'changes': null,
};

/// 旅行詳細の「タイムライン」を開く（[timeline] を渡さなければ [_timelineOf] の完成版だけ）
Future<FakeTripBackend> _openTimeline(WidgetTester tester,
    {Map<String, Object?>? timeline}) async {
  final backend = FakeTripBackend(
    trips: [hokkaidoTrip(photoCount: 9)],
    functionKey: 'test-key',
    // 写真ビューアで開く写真（07:58）。07:50 の写真は旅行に無い（作った後に消えた）
    photosByTripId: {
      hokkaidoTripId: [
        photoJson(
            number: 2, tripId: hokkaidoTripId, takenAt: '2026-10-05T07:58:00'),
      ],
    },
  );
  backend.timelinesByTripId[hokkaidoTripId] = timeline ?? _timelineOf();
  // 1つのテストの中で開き直すとき、前のアプリの木（開いている画面）を残さない
  await tester.pumpWidget(const SizedBox());
  await openTripsTab(tester, backend);
  await tester.tap(find.text('北海道 2026秋'));
  await letFramesRun(tester);
  await tester.tap(find.text('タイムライン'));
  await letFramesRun(tester);
  return backend;
}

/// タイムラインを開き、見出しが [label] の場面の写真の一覧を開く
Future<FakeTripBackend> _openScene(WidgetTester tester, String label,
    {Map<String, Object?>? timeline}) async {
  final backend = await _openTimeline(tester, timeline: timeline);
  await tester.tap(find.text(label));
  await letFramesRun(tester);
  return backend;
}

/// 上のバーの [text]（場面の写真の一覧の見出し）
Finder _appBarText(String text) =>
    find.descendant(of: find.byType(AppBar), matching: find.text(text));

/// 完成版の朝ごはんの場面の見出しを [label] に替える（別の端末で直した）
void _relabelBreakfast(FakeTripBackend backend, String label) {
  final scenes = _scenes();
  scenes[0] = {...scenes[0], 'label': label};
  backend.timelinesByTripId[hokkaidoTripId] = _timelineOf(scenes: scenes);
}

/// 上のバーの「見出しを編集」のボタン
IconButton _editButton(WidgetTester tester) =>
    tester.widget<IconButton>(find.ancestor(
        of: find.bySemanticsLabel('見出しを編集'),
        matching: find.byType(IconButton)));

/// 上のバーの「見出しを編集」を押してシートを開く
Future<void> _openSheet(WidgetTester tester) async {
  await tester.tap(find.bySemanticsLabel('見出しを編集'));
  await letFramesRun(tester);
}

/// シートの「見出し」の欄
final _labelField = find.widgetWithText(TextField, '見出し');

/// 見出しの欄に [text] を書いて保存する
Future<void> _saveLabel(WidgetTester tester, String text) async {
  await tester.enterText(_labelField, text);
  await tester.tap(find.text('保存'));
  await letFramesRun(tester);
}

/// 写真 [number] から始まる場面の id
String _sceneId(int number) => timelinePhotoJson(number, null)['id'] as String;

/// 完成版の場面を偽のサーバから探す
Map<String, Object?> _sceneOf(FakeTripBackend backend, int startPhotoNumber) {
  final current = backend.timelinesByTripId[hokkaidoTripId]!['current']
      as Map<String, Object?>;
  return [
    for (final day in current['days'] as List)
      for (final scene in (day as Map)['scenes'] as List)
        scene as Map<String, Object?>
  ].firstWhere((scene) => scene['startPhotoId'] == _sceneId(startPhotoNumber));
}

void main() {
  group('場面の写真の一覧を開く', () {
    testWidgets('場面をタップすると、上のバーに見出し、上に日付・時刻・地名・枚数を出し、場面の写真を全部3列で並べる',
        (tester) async {
      final semantics = tester.ensureSemantics();
      await _openScene(tester, '小樽運河さんぽ');

      expect(_appBarText('小樽運河さんぽ'), findsOneWidget);
      expect(find.text('10月5日（月） 10:10〜15:10 · 北海道小樽市、北海道余市町 · 6枚'),
          findsOneWidget);
      // 完成版のカードは4枚まで（+2枚）だが、一覧は6枚全部
      expect(find.text('+2枚'), findsNothing);
      final thumbnails = [
        for (var hour = 10; hour <= 15; hour++)
          photoThumbnail('2026年10月5日 $hour:10'),
      ];
      for (final thumbnail in thumbnails) {
        expect(thumbnail, findsOneWidget);
      }
      // 3列: 1〜3枚目が1行目、4枚目から2行目
      final first = tester.getTopLeft(thumbnails[0]);
      expect(tester.getTopLeft(thumbnails[2]).dy, first.dy);
      expect(tester.getTopLeft(thumbnails[2]).dx, greaterThan(first.dx));
      expect(tester.getTopLeft(thumbnails[3]).dx, first.dx);
      expect(tester.getTopLeft(thumbnails[3]).dy, greaterThan(first.dy));
      semantics.dispose();
    });

    testWidgets('見出しの無い場面は上のバーに「見出しなし」と出し、地名が無ければ省く', (tester) async {
      await _openTimeline(tester);
      await tester.scrollUntilVisible(find.text('見出しなし'), 200,
          scrollable: find.byType(Scrollable).first);
      await tester.pump();
      await tester.tap(find.text('見出しなし'));
      await letFramesRun(tester);

      expect(_appBarText('見出しなし'), findsOneWidget);
      expect(find.text('10月5日（月） 18:30 · 1枚'), findsOneWidget);
    });

    testWidgets('操作を送っている間は、場面をタップしても一覧を開かない', (tester) async {
      // 送っている間の扱いは §8.1 と同じ。全ケースは trip_timeline_test.dart の「操作を送っている間は…」で通している
      final backend = await _openTimeline(tester);
      final reply = backend.holdNextReply(TripRoute.timelineRecut);
      await tester.tap(find.byIcon(Icons.more_vert));
      await letFramesRun(tester);
      await tester.tap(find.text('タイムラインを編集'));
      await tester.pump();

      await tester.tap(find.text('朝ごはん'));
      await letFramesRun(tester);
      expect(_appBarText('朝ごはん'), findsNothing);

      reply.complete();
      await letFramesRun(tester);
    });
  });

  group('写真ビューアを開く', () {
    testWidgets('写真をタップすると、その写真を写真ビューアで開き、閉じたら読み直して場面を描き直す', (tester) async {
      final semantics = tester.ensureSemantics();
      final backend = await _openScene(tester, '朝ごはん');

      await tester.tap(photoThumbnail('2026年10月5日 07:58'));
      await letFramesRun(tester);
      expect(find.text('2026年10月5日 07:58').hitTestable(), findsOneWidget);

      _relabelBreakfast(backend, '市場の朝ごはん');
      await tapBack(tester);
      await letFramesRun(tester);
      expect(_appBarText('市場の朝ごはん'), findsOneWidget);
      semantics.dispose();
    });

    testWidgets('写真を読んでいる間にもう一度タップしても、写真ビューアは1つだけ開く', (tester) async {
      final semantics = tester.ensureSemantics();
      final backend = await _openScene(tester, '朝ごはん');
      final reply = backend.holdNextReply(TripRoute.getPhoto);

      await tester.tap(photoThumbnail('2026年10月5日 07:58'));
      await tester.pump();
      await tester.tap(photoThumbnail('2026年10月5日 07:58'));
      await tester.pump();
      reply.complete();
      await letFramesRun(tester);

      await tapBack(tester);
      await letFramesRun(tester);
      expect(find.text('2026年10月5日 07:58'), findsNothing);
      expect(_appBarText('朝ごはん'), findsOneWidget);
      semantics.dispose();
    });

    testWidgets('タップした写真が消えていたら、「この写真は削除されています」を出して読み直す', (tester) async {
      final semantics = tester.ensureSemantics();
      final backend = await _openScene(tester, '朝ごはん');
      // 写真 1 は旅行に無い（作った後に消えた）。読み直したことを、見出しが替わることで確かめる
      _relabelBreakfast(backend, '市場の朝ごはん');

      await tester.tap(photoThumbnail('2026年10月5日 07:50'));
      await letFramesRun(tester);
      expect(find.text('この写真は削除されています'), findsOneWidget);
      expect(_appBarText('市場の朝ごはん'), findsOneWidget);
      semantics.dispose();
    });

    testWidgets('写真を読めなかったら、エラーの文言を出し、表示はそのまま', (tester) async {
      final semantics = tester.ensureSemantics();
      final backend = await _openScene(tester, '朝ごはん');
      backend.failNext(TripRoute.getPhoto);

      await tester.tap(photoThumbnail('2026年10月5日 07:58'));
      await letFramesRun(tester);
      expect(find.text('サービスに一時的に接続できません。しばらく待ってから再試行してください。'), findsOneWidget);
      expect(_appBarText('朝ごはん'), findsOneWidget);
      semantics.dispose();
    });

    testWidgets('閉じた後に読み直すと、完成版が無くなっていた・場面が無くなっていたら、旅行詳細に戻る', (tester) async {
      final semantics = tester.ensureSemantics();
      for (final (label, timeline, shown) in [
        ('作り直しが始まった', _rebuilding, 'タイムラインの案を作っています'),
        // 朝ごはんの写真を全部消した（場面ごと無くなる）
        ('場面が無くなった', _timelineOf(scenes: _scenes().sublist(1)), '小樽運河さんぽ'),
      ]) {
        final backend = await _openScene(tester, '朝ごはん');
        expect(_appBarText('朝ごはん'), findsOneWidget, reason: label);
        await tester.tap(photoThumbnail('2026年10月5日 07:58'));
        await letFramesRun(tester);

        backend.timelinesByTripId[hokkaidoTripId] = timeline;
        await tapBack(tester);
        await letFramesRun(tester);
        expect(_appBarText('朝ごはん'), findsNothing, reason: label);
        expect(find.text('タイムライン'), findsOneWidget, reason: label);
        expect(find.text(shown), findsOneWidget, reason: label);
      }
      semantics.dispose();
    });

    testWidgets('閉じた後の読み直しに失敗したら、表示はそのままでエラーの文言を出す', (tester) async {
      final semantics = tester.ensureSemantics();
      final backend = await _openScene(tester, '朝ごはん');
      await tester.tap(photoThumbnail('2026年10月5日 07:58'));
      await letFramesRun(tester);

      backend.failNext(TripRoute.timeline);
      await tapBack(tester);
      await letFramesRun(tester);
      expect(find.text('サービスに一時的に接続できません。しばらく待ってから再試行してください。'), findsOneWidget);
      expect(_appBarText('朝ごはん'), findsOneWidget);
      semantics.dispose();
    });
  });

  group('場面の見出しを直す', () {
    testWidgets(
        '「見出しを編集」で今の見出しだけのシートを開き、保存すると上のバーの見出しが替わり、一覧から戻るとタイムラインを読み直して直した見出しが出る',
        (tester) async {
      // 一覧を開いて何もせずに戻っても読み直すことは、timeline_current_test.dart の「作った後に写真が変わった案内」で確かめている
      final semantics = tester.ensureSemantics();
      final backend = await _openScene(tester, '朝ごはん');

      await _openSheet(tester);
      expect(find.text('見出しを編集'), findsOneWidget);
      expect(find.text('空にすると、AI が書いた見出しに戻ります（AI が書いていない場面は見出しなしになります）'),
          findsOneWidget);
      // 欄は見出しだけ（一言は直せない。§8.5）
      expect(find.byType(TextField), findsOneWidget);
      expect(tester.widget<TextField>(_labelField).controller!.text, '朝ごはん');

      await _saveLabel(tester, '市場の朝ごはん');
      expect(find.text('見出しを編集'), findsNothing);
      expect(_appBarText('市場の朝ごはん'), findsOneWidget);
      expect(_sceneOf(backend, 1)['labelSource'], 'user');

      await tapBack(tester);
      await letFramesRun(tester);
      expect(find.text('市場の朝ごはん'), findsOneWidget);
      semantics.dispose();
    });

    testWidgets('見出しの欄は 30 文字で止める', (tester) async {
      final semantics = tester.ensureSemantics();
      await _openScene(tester, '朝ごはん');
      await _openSheet(tester);

      await tester.enterText(_labelField, 'あ' * 31);
      await tester.pump();
      expect(tester.widget<TextField>(_labelField).controller!.text.length, 30);
      semantics.dispose();
    });

    testWidgets('見出しを空にして保存すると、AI が書いた見出しに戻り、AI が書いていない場面は「見出しなし」に戻る',
        (tester) async {
      final semantics = tester.ensureSemantics();
      final backend = await _openScene(tester, '朝ごはん');
      backend.timelineAiTexts['${_sceneId(1)}:label'] = 'AI の朝ごはん';
      await _openSheet(tester);
      await _saveLabel(tester, '');
      expect(_appBarText('AI の朝ごはん'), findsOneWidget);
      expect(_sceneOf(backend, 1)['labelSource'], 'ai');

      // 見出しの無い場面（区切りを直して足した場面。AI の見出しが無い）に書いて、空に戻す
      await tapBack(tester);
      await letFramesRun(tester);
      backend.timelineAiTexts['${_sceneId(9)}:label'] = null;
      await tester.scrollUntilVisible(find.text('見出しなし'), 200,
          scrollable: find.byType(Scrollable).first);
      await tester.pump();
      await tester.tap(find.text('見出しなし'));
      await letFramesRun(tester);
      await _openSheet(tester);
      await _saveLabel(tester, '夕方の散歩');
      expect(_appBarText('夕方の散歩'), findsOneWidget);
      await _openSheet(tester);
      await _saveLabel(tester, '');
      expect(_appBarText('見出しなし'), findsOneWidget);
      semantics.dispose();
    });

    testWidgets(
        '保存のときに別の端末がタイムラインを変えていたら（409）、その場面が無くなっていたら（404）、知らせて旅行詳細に戻り、読み直す',
        (tester) async {
      final semantics = tester.ensureSemantics();
      for (final (label, status, code, message) in [
        (
          '409',
          409,
          'TIMELINE_STATE_CONFLICT',
          'タイムラインが変わったか、作っている途中です。読み直してください'
        ),
        ('404', 404, 'TIMELINE_NOT_FOUND', 'その場面はタイムラインにありません'),
      ]) {
        final backend = await _openScene(tester, '朝ごはん');
        backend.failNext(TripRoute.timelineScenePatch,
            status: status, code: code, message: message);
        backend.timelinesByTripId[hokkaidoTripId] = _rebuilding;

        await _openSheet(tester);
        await _saveLabel(tester, '市場の朝ごはん');

        expect(find.text('見出しを編集'), findsNothing, reason: label);
        expect(find.text('タイムラインが変わりました。読み直しました'), findsOneWidget,
            reason: label);
        expect(_appBarText('朝ごはん'), findsNothing, reason: label);
        expect(find.text('タイムラインの案を作っています'), findsOneWidget, reason: label);
      }
      semantics.dispose();
    });

    testWidgets('保存のときに旅行が別の端末で消されていたら、旅行詳細に戻り「この旅行は削除されています」を出す',
        (tester) async {
      final semantics = tester.ensureSemantics();
      final backend = await _openScene(tester, '朝ごはん');
      await _openSheet(tester);
      backend.trips.clear();
      await _saveLabel(tester, '市場の朝ごはん');

      expect(find.text('見出しを編集'), findsNothing);
      expect(_appBarText('朝ごはん'), findsNothing);
      expect(find.text('この旅行は削除されています'), findsOneWidget);
      expect(find.text('タイムラインが変わりました。読み直しました'), findsNothing);
      semantics.dispose();
    });

    testWidgets('写真を読んでいる間と、写真ビューアを閉じた後に読み直している間は、「見出しを編集」を押せない',
        (tester) async {
      final semantics = tester.ensureSemantics();
      final backend = await _openScene(tester, '朝ごはん');
      expect(_editButton(tester).onPressed, isNotNull);

      final photoReply = backend.holdNextReply(TripRoute.getPhoto);
      await tester.tap(photoThumbnail('2026年10月5日 07:58'));
      await tester.pump();
      expect(_editButton(tester).onPressed, isNull, reason: '写真を読んでいる間');
      photoReply.complete();
      await letFramesRun(tester);

      final reloadReply = backend.holdNextReply(TripRoute.timeline);
      await tapBack(tester);
      await letFramesRun(tester);
      expect(_editButton(tester).onPressed, isNull, reason: '読み直している間');
      reloadReply.complete();
      await letFramesRun(tester);
      expect(_editButton(tester).onPressed, isNotNull);
      semantics.dispose();
    });

    testWidgets('タイムラインを編集している途中も、場面の見出しを直せる', (tester) async {
      final semantics = tester.ensureSemantics();
      await _openScene(tester, '朝ごはん',
          timeline: _timelineOf(draft: {
            'id': '0b8e1c5a-0000-4000-8000-000000000099',
            'reason': 'recut',
            'phase': 'reviewing',
            'job': null,
            'startedAt': '2026-10-26T09:00:00.000Z',
          }));

      await _openSheet(tester);
      await _saveLabel(tester, '市場の朝ごはん');
      expect(_appBarText('市場の朝ごはん'), findsOneWidget);
      semantics.dispose();
    });
  });
}
