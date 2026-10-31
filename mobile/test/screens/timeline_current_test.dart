import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../helpers/app_test_helpers.dart';
import '../helpers/trip_test_helpers.dart';

// 完成したタイムライン（docs/03_screen_design.md §8.3・§8.6。段階5の 5-4a）。
// 入口は旅行詳細の「タイムライン」。作成日時は端末の時刻（日本時間）で出すので、日本時間で動くことを前提にする

/// 場面の写真（番号から id を作る。地名と名前は場面の欄で持つので、写真には持たせない）
Map<String, Object?> _photo(int number, String? takenAt,
        {String category = 'landscape'}) =>
    timelinePhotoJson(number, takenAt, category: category);

/// 完成版の場面（05 §5.15 の `current.days[].scenes[]`）
Map<String, Object?> _scene(
  List<Map<String, Object?>> photos, {
  required String? label,
  required String? note,
  List<String> placeNames = const [],
  List<String> names = const [],
  String startedBy = 'ai',
}) =>
    {
      ...timelineSceneJson(photos, startedBy: startedBy),
      'placeNames': placeNames,
      'names': names,
      'label': label,
      'labelSource': label == null ? null : 'ai',
      'note': note,
      'noteSource': note == null ? null : 'ai',
    };

/// 完成版（1日目は利用者がタイトルを直した日、3日目は AI の文だけの日。2日目は写真が無い）
Map<String, Object?> _current() => {
      'writtenAt': '2026-10-25T09:10:00.000Z',
      'days': [
        {
          'date': '2026-10-05',
          'dayNumber': 1,
          'title': '小樽の運河と寿司',
          'titleSource': 'user',
          'summary': '朝は市場で海鮮丼、昼は運河を歩いた。',
          'summarySource': 'ai',
          'scenes': [
            _scene(
                [
                  _photo(1, '2026-10-05T07:50:00', category: 'food'),
                  _photo(2, '2026-10-05T07:58:00', category: 'food'),
                ],
                label: '朝ごはん',
                note: '港の市場で海鮮丼。',
                placeNames: ['北海道千歳市'],
                names: ['海鮮丼'],
                startedBy: 'day'),
            _scene(
                [
                  for (var n = 3; n <= 8; n++)
                    _photo(n, '2026-10-05T1${n - 3}:10:00'),
                ],
                label: '小樽運河さんぽ',
                note: null,
                placeNames: ['北海道小樽市', '北海道余市町']),
          ],
        },
        {
          'date': '2026-10-07',
          'dayNumber': 3,
          'title': '旭川',
          'titleSource': 'ai',
          'summary': 'ラーメンを食べた。',
          'summarySource': 'ai',
          'scenes': [
            _scene([_photo(9, '2026-10-07T12:00:00', category: 'food')],
                label: '昼ごはん',
                note: '醤油ラーメン。',
                names: ['醤油ラーメン'],
                startedBy: 'day'),
          ],
        },
      ],
    };

/// タイムライン（完成版と、あれば下書き）
Map<String, Object?> _timelineOf({Map<String, Object?>? draft}) => {
      'current': _current(),
      'draft': draft,
      'changes': {'added': 0, 'removed': 0},
    };

/// 旅行詳細の「タイムライン」を開く
Future<FakeTripBackend> _openTimeline(WidgetTester tester,
    {Map<String, Object?>? draft,
    int pendingPhotoCount = 0,
    Map<String, Object?>? current,
    Map<String, Object?>? changes}) async {
  final backend = FakeTripBackend(
    trips: [hokkaidoTrip(photoCount: 10)],
    functionKey: 'test-key',
    // 写真ビューアで開く写真（07:58）。07:50 の写真は旅行に無い（作った後に消えた）
    photosByTripId: {
      hokkaidoTripId: [
        photoJson(
            number: 2, tripId: hokkaidoTripId, takenAt: '2026-10-05T07:58:00'),
      ],
    },
  );
  backend.timelinesByTripId[hokkaidoTripId] = {
    ..._timelineOf(draft: draft),
    if (current != null) 'current': current,
    if (changes != null) 'changes': changes,
  };
  backend.pendingPhotoCountByTripId[hokkaidoTripId] = pendingPhotoCount;
  // 1つのテストの中で開き直すとき、前のアプリの木（開いている画面）を残さない
  await tester.pumpWidget(const SizedBox());
  await openTripsTab(tester, backend);
  await tester.tap(find.text('北海道 2026秋'));
  await letFramesRun(tester);
  await tester.tap(find.text('タイムライン'));
  await letFramesRun(tester);
  return backend;
}

/// 文言が [label] のボタン（押せるかを見る）
ButtonStyleButton _button(WidgetTester tester, String label) =>
    tester.widget<ButtonStyleButton>(find.ancestor(
        of: find.text(label), matching: find.bySubtype<ButtonStyleButton>()));

/// 旅行詳細の上のバーのメニューを開く
Future<void> _openMenu(WidgetTester tester) async {
  await tester.tap(find.byIcon(Icons.more_vert));
  await letFramesRun(tester);
}

/// 旅行詳細の上のバーのメニューから [label] を選ぶ
Future<void> _chooseFromMenu(WidgetTester tester, String label) async {
  await _openMenu(tester);
  await tester.tap(find.text(label));
  await letFramesRun(tester);
}

/// メニューの項目 [label]（押せるかを見る）
PopupMenuItem<Object?> _menuItem(WidgetTester tester, String label) =>
    tester.widget<PopupMenuItem<Object?>>(find.ancestor(
        of: find.text(label),
        matching: find.byWidgetPredicate((widget) => widget is PopupMenuItem)));

/// タイムラインを編集する画面の上のバーの見出し
final _editTitle =
    find.descendant(of: find.byType(AppBar), matching: find.text('タイムラインを編集'));

/// 写真が変わった案内の枠の中の [text]
Finder _inChangesNotice(String text) => find.descendant(
    of: find.ancestor(
        of: find.textContaining('作った後に写真が'), matching: find.byType(Card)),
    matching: find.text(text));

/// タイムラインのリストを [finder] が見えるところまで送る
Future<void> _scrollTo(WidgetTester tester, Finder finder) async {
  await tester.scrollUntilVisible(finder, 200,
      scrollable: find.byType(Scrollable).first);
  await tester.pump();
}

void main() {
  group('完成したタイムラインの表示', () {
    testWidgets('日ごとに見出し・タイトル・まとめ・印と、場面を縦の時間の線の形（左に始まりの時刻、右に見出しと枚数・写真・終わりの時刻と地名）で並べ、一番下に作成日時を出す（一言・名前・操作のボタンは出さない）',
        (tester) async {
      // 作成日時は端末の時刻で出す。日本時間でないと期待値が合わない（CI は TZ=Asia/Tokyo）
      expect(DateTime(2026, 10, 25).timeZoneOffset, const Duration(hours: 9));
      final semantics = tester.ensureSemantics();
      await _openTimeline(tester);

      expect(find.text('タイムラインができました'), findsNothing);
      expect(find.text('区切りを直す'), findsNothing);
      expect(find.text('作り直す'), findsNothing);

      expect(find.text('1日目'), findsOneWidget);
      expect(find.text('10月5日（月）'), findsOneWidget);
      expect(find.text('小樽の運河と寿司'), findsOneWidget);
      expect(find.text('朝は市場で海鮮丼、昼は運河を歩いた。'), findsOneWidget);
      // タイトルを利用者が直した日
      expect(find.text('編集済み'), findsOneWidget);

      // 場面: 左に始まりの時刻、右に見出しと枚数、写真、一番下に終わりの時刻と地名（縦の時間の線の形。U-1b）
      expect(find.text('7:50'), findsOneWidget);
      expect(find.text('朝ごはん'), findsOneWidget);
      expect(find.text('2枚'), findsOneWidget);
      expect(find.text('〜7:58 · 北海道千歳市'), findsOneWidget);
      // 始まりの時刻は右の欄（見出し・写真・終わりの時刻の行）より左の欄に置く
      expect(tester.getTopRight(find.text('7:50')).dx,
          lessThanOrEqualTo(tester.getTopLeft(find.text('〜7:58 · 北海道千歳市')).dx));
      expect(tester.getTopLeft(find.text('2枚')).dx,
          greaterThan(tester.getTopRight(find.text('朝ごはん')).dx));
      expect(
          tester.getTopLeft(find.text('〜7:58 · 北海道千歳市')).dy,
          greaterThan(
              tester.getBottomLeft(photoThumbnail('2026年10月5日 07:58')).dy));
      // 場面の一言と、写真の識別の名前は出さない（02 §5 #55）
      expect(find.text('港の市場で海鮮丼。'), findsNothing);
      expect(find.textContaining('· 海鮮丼'), findsNothing);
      // 場面に編集のボタンは置かない（見出しは場面の写真の一覧から直す。§8.8）
      final sceneTop = tester.getTopLeft(find.text('7:50')).dy;
      final sceneBottom =
          tester.getBottomLeft(find.text('〜7:58 · 北海道千歳市')).dy;
      final buttons = find.byType(IconButton);
      for (var i = 0; i < buttons.evaluate().length; i++) {
        final y = tester.getCenter(buttons.at(i)).dy;
        expect(y < sceneTop || y > sceneBottom, isTrue,
            reason: '場面の範囲にボタンがある（y=$y）');
      }

      await _scrollTo(tester, find.text('〜15:10 · 北海道小樽市、北海道余市町'));
      expect(find.text('10:10'), findsOneWidget);
      expect(find.text('6枚'), findsOneWidget);
      // 6枚なら全部出す（大きい2枚と小さい4枚）
      for (var hour = 10; hour <= 15; hour++) {
        expect(photoThumbnail('2026年10月5日 $hour:10'), findsOneWidget);
      }
      expect(find.textContaining(RegExp(r'[+＋]\s*\d')), findsNothing);

      await _scrollTo(tester, find.text('昼ごはん'));
      expect(find.text('3日目'), findsOneWidget);
      expect(find.text('10月7日（水）'), findsOneWidget);
      // タイトルもまとめも AI の文の日
      expect(find.text('AI のまとめ'), findsOneWidget);
      // 1枚で地名の無い場面は、終わりの時刻と地名の行を出さない
      expect(find.text('12:00'), findsOneWidget);
      expect(find.text('1枚'), findsOneWidget);
      expect(find.textContaining('〜12:00'), findsNothing);
      expect(find.textContaining('醤油ラーメン'), findsNothing);

      await _scrollTo(tester, find.text('10月25日 18:10 に作成'));
      expect(tester.getTopLeft(find.text('10月25日 18:10 に作成')).dy,
          greaterThan(tester.getTopLeft(find.text('昼ごはん')).dy));
      semantics.dispose();
    });

    testWidgets('場面の写真は最初の2枚を大きく並べ、3枚目からを小さく1行に並べ、7枚以上なら小さい列の4つ目を「+{残り}枚」にする',
        (tester) async {
      await _openTimeline(tester, current: {
        'writtenAt': '2026-10-25T09:10:00.000Z',
        'days': [
          {
            'date': '2026-10-05',
            'dayNumber': 1,
            'title': null,
            'titleSource': null,
            'summary': null,
            'summarySource': null,
            'scenes': [
              _scene([
                for (var n = 1; n <= 7; n++) _photo(n, '2026-10-05T1$n:00:00'),
              ], label: '小樽運河さんぽ', note: null),
            ],
          },
        ],
      });

      final large = [
        photoThumbnail('2026年10月5日 11:00'),
        photoThumbnail('2026年10月5日 12:00'),
      ];
      final small = [
        for (var hour = 13; hour <= 15; hour++)
          photoThumbnail('2026年10月5日 $hour:00'),
      ];
      for (final thumbnail in [...large, ...small]) {
        expect(thumbnail, findsOneWidget);
      }
      // 7枚のうち5枚を出し、残りの2枚を「+2枚」
      expect(photoThumbnail('2026年10月5日 16:00'), findsNothing);
      expect(find.text('+2枚'), findsOneWidget);

      // 大きい2枚が1行目、小さい列がその下の1行
      final largeTop = tester.getTopLeft(large[0]).dy;
      expect(tester.getTopLeft(large[1]).dy, largeTop);
      for (final thumbnail in [...small, find.text('+2枚')]) {
        expect(tester.getTopLeft(thumbnail).dy,
            greaterThan(tester.getBottomLeft(large[0]).dy - 1));
      }
      expect(tester.getTopLeft(small[2]).dy, tester.getTopLeft(small[0]).dy);
      // 撮影の順に左から
      expect(tester.getTopLeft(large[1]).dx,
          greaterThan(tester.getTopLeft(large[0]).dx));
      expect(tester.getTopLeft(small[1]).dx,
          greaterThan(tester.getTopLeft(small[0]).dx));
      expect(tester.getTopLeft(small[2]).dx,
          greaterThan(tester.getTopLeft(small[1]).dx));
      expect(tester.getSize(large[0]).width,
          greaterThan(tester.getSize(small[0]).width * 1.5));
      // 小さい列の4つ目が「+2枚」
      expect(tester.getCenter(find.text('+2枚')).dx,
          greaterThan(tester.getTopRight(small[2]).dx));
    });

    testWidgets('左の始まりの時刻をタップしても、場面の写真の一覧を開く', (tester) async {
      await _openTimeline(tester);

      await tester.tap(find.text('7:50'));
      await letFramesRun(tester);

      expect(
          find.descendant(of: find.byType(AppBar), matching: find.text('朝ごはん')),
          findsOneWidget);
    });
  });

  group('旅行詳細のメニュー', () {
    testWidgets(
        'タイムラインを開いていると、「タイムラインを編集」「タイムラインを作り直す」「旅行を編集」「旅行を削除」の順に並べる',
        (tester) async {
      await _openTimeline(tester);

      await _openMenu(tester);
      final labels = ['タイムラインを編集', 'タイムラインを作り直す', '旅行を編集', '旅行を削除'];
      final tops = [
        for (final label in labels) tester.getTopLeft(find.text(label)).dy
      ];
      expect(tops, orderedEquals([...tops]..sort()));
      for (final label in labels.take(2)) {
        expect(_menuItem(tester, label).enabled, isTrue, reason: label);
      }
    });

    testWidgets('「写真」を開いているときは、タイムラインの項目を出さない', (tester) async {
      await _openTimeline(tester);
      await tester.tap(find.text('写真'));
      await letFramesRun(tester);

      await _openMenu(tester);
      expect(find.text('旅行を編集'), findsOneWidget);
      expect(find.text('旅行を削除'), findsOneWidget);
      expect(find.text('タイムラインを編集'), findsNothing);
      expect(find.text('タイムラインを作り直す'), findsNothing);
    });

    testWidgets('解析中の写真がある間は「タイムラインを作り直す」を押せず、残りの枚数を添える（「タイムラインを編集」は押せる）',
        (tester) async {
      await _openTimeline(tester, pendingPhotoCount: 2);

      await _openMenu(tester);
      expect(_menuItem(tester, 'タイムラインを作り直す').enabled, isFalse);
      expect(find.text('解析中の写真があと 2 枚'), findsOneWidget);
      expect(_menuItem(tester, 'タイムラインを編集').enabled, isTrue);
    });

    testWidgets('タイムラインを下に引っ張ると読み直し、解析が終わっていれば「タイムラインを作り直す」を押せる',
        (tester) async {
      final backend = await _openTimeline(tester, pendingPhotoCount: 2);
      backend.pendingPhotoCountByTripId[hokkaidoTripId] = 0;

      await tester.drag(find.text('1日目'), const Offset(0, 600));
      await letFramesRun(tester);
      await _openMenu(tester);
      expect(_menuItem(tester, 'タイムラインを作り直す').enabled, isTrue);
      expect(find.textContaining('解析中の写真があと'), findsNothing);
    });

    testWidgets('タイムラインを編集している途中は、タイムラインの項目を出さない', (tester) async {
      await _openTimeline(tester, draft: {
        'id': '0b8e1c5a-0000-4000-8000-000000000099',
        'reason': 'recut',
        'phase': 'reviewing',
        'job': null,
        'startedAt': '2026-10-26T09:00:00.000Z',
      });

      await _openMenu(tester);
      expect(find.text('旅行を編集'), findsOneWidget);
      expect(find.text('タイムラインを編集'), findsNothing);
      expect(find.text('タイムラインを作り直す'), findsNothing);
    });
  });

  group('完成版の上の下書きの案内', () {
    /// 完成版の上の下書き（区切りの直し。作る・作り直しの下書きは作っている間の表示になる。trip_timeline_test.dart）
    Map<String, Object?> draftOf(String reason, String phase,
            {String? step, String state = 'pending'}) =>
        {
          'id': '0b8e1c5a-0000-4000-8000-000000000099',
          'reason': reason,
          'phase': phase,
          'job': step == null
              ? null
              : {
                  'step': step,
                  'state': state,
                  'lastError': state == 'failed' ? 'ai' : null
                },
          'startedAt': '2026-10-26T09:00:00.000Z',
        };

    testWidgets('区切りの直しの下書きの段階ごとに、完成版を出したまま上に案内を出す',
        (tester) async {
      // 1つのテストで下書きを取り替えながらアプリを開き直す（開き直すたびに木は作り直される）
      for (final (label, draft, texts) in [
      (
        '区切りの直しの途中のとき',
        draftOf('recut', 'reviewing'),
        ['タイムラインを編集している途中です', '続ける', 'やめる']
      ),
      (
        '文を書き直せなかったとき',
        draftOf('recut', 'writing', step: 'write', state: 'failed'),
        ['見出しと一言を書き直せませんでした', 'もう一度', '案を確認する', 'やめる']
      ),
    ]) {
        await _openTimeline(tester, draft: draft);

        for (final text in texts) {
          expect(find.text(text), findsOneWidget, reason: label);
        }
        expect(find.text('朝ごはん'), findsOneWidget, reason: label);
      }
    });

    testWidgets('区切りの直しで見出しと一言を書き直せなかった下書き（AI なしにする前のもの）で「もう一度」を押すと、その場で保存されてタイムラインを読み直し、案内を消す', (tester) async {
      final backend = await _openTimeline(tester,
          draft: draftOf('recut', 'writing', step: 'write', state: 'failed'));
      // 本物は下書きの区切りを完成版に当てる（偽物は描き直さないので、当てた後の完成版をここで置く）。
      // 1日目の2つの場面をつなげた区切り: 後ろの「小樽運河さんぽ」の文は捨てられる（06 §8.6）。読み直せば、それが消える
      final applied = _current();
      final day1 = (applied['days'] as List).first as Map<String, Object?>;
      day1['scenes'] = [
        _scene([
          _photo(1, '2026-10-05T07:50:00', category: 'food'),
          _photo(2, '2026-10-05T07:58:00', category: 'food'),
          for (var n = 3; n <= 8; n++) _photo(n, '2026-10-05T1${n - 3}:10:00'),
        ], label: '朝ごはん', note: '港の市場で海鮮丼。', startedBy: 'day'),
      ];
      backend.timelinesByTripId[hokkaidoTripId] = {
        ...backend.timelinesByTripId[hokkaidoTripId]!,
        'current': applied
      };

      await tester.tap(find.text('もう一度'));
      await letFramesRun(tester);

      expect(backend.timelinesByTripId[hokkaidoTripId]!['draft'], isNull);
      expect(find.text('小樽運河さんぽ'), findsNothing);
      expect(find.text('見出しと一言を書き直せませんでした'), findsNothing);
      expect(find.text('朝ごはん'), findsOneWidget);
      expect(find.text('タイムラインの操作に失敗しました'), findsNothing);
    });

    testWidgets('編集している途中の「やめる」は確認のダイアログを出し、「キャンセル」なら何もせず、「やめる」で下書きを消して完成版だけに戻る',
        (tester) async {
      final backend =
          await _openTimeline(tester, draft: draftOf('recut', 'reviewing'));

      await tester.tap(find.text('やめる'));
      await letFramesRun(tester);
      expect(inDialog(find.text('編集をやめて、今のタイムラインのままにしますか？')), findsOneWidget);
      await tapInDialog(tester, 'キャンセル');
      expect(backend.timelinesByTripId[hokkaidoTripId]!['draft'], isNotNull);
      expect(find.text('タイムラインを編集している途中です'), findsOneWidget);

      await tester.tap(find.text('やめる'));
      await letFramesRun(tester);
      await tapInDialog(tester, 'やめる');

      expect(backend.timelinesByTripId[hokkaidoTripId]!['draft'], isNull);
      expect(find.text('タイムラインを編集している途中です'), findsNothing);
      expect(find.text('朝ごはん'), findsOneWidget);
    });

    testWidgets('「続ける」でタイムラインを編集する画面を開く', (tester) async {
      await _openTimeline(tester, draft: {
        ...draftOf('recut', 'reviewing'),
        'days': <Object?>[],
      });

      await tester.tap(find.text('続ける'));
      await letFramesRun(tester);
      expect(_editTitle, findsOneWidget);
    });
  });

  group('タイムラインを編集・作り直す', () {
    testWidgets('「タイムラインを編集」を選ぶと、完成版の区切りを写した下書きを作り、案の確認画面を開く', (tester) async {
      final backend = await _openTimeline(tester);

      await _chooseFromMenu(tester, 'タイムラインを編集');
      expect(
          (backend.timelinesByTripId[hokkaidoTripId]!['draft']
              as Map)['reason'],
          'recut');
      expect(_editTitle, findsOneWidget);
      expect(
          find.text(
              '写真を長押しすると『ここで区切る』、場面の境目の『つなげる』で前の場面とまとめられます。新しくできた場面は見出しなしになります。つなげると、後ろの場面の見出しと一言は消えます。'),
          findsOneWidget);

      await tester.tap(find.byIcon(Icons.close));
      await letFramesRun(tester);
      expect(find.text('タイムラインを編集している途中です'), findsOneWidget);
    });

    testWidgets('区切りを直して確認画面の下のボタンを押すと、AI を待たずにその場で保存して旅行詳細に戻り、直している途中の案内を出さずに完成版を出す', (tester) async {
      final backend = await _openTimeline(tester);
      await _chooseFromMenu(tester, 'タイムラインを編集');

      await tester.tap(find.text('保存'));
      await letFramesRun(tester);

      expect(backend.timelinesByTripId[hokkaidoTripId]!['draft'], isNull);
      expect(_editTitle, findsNothing);
      expect(find.text('タイムラインを編集している途中です'), findsNothing);
      expect(find.text('見出しと一言を書き直しています'), findsNothing);
      expect(find.text('タイムラインの操作に失敗しました'), findsNothing);
      expect(find.textContaining('ネットワーク'), findsNothing);
      expect(find.text('朝ごはん'), findsOneWidget);
    });

    testWidgets('「タイムラインを編集」のときに別の端末が作り直しを始めていたら（409）、知らせて読み直す', (tester) async {
      final backend = await _openTimeline(tester);
      backend.timelinesByTripId[hokkaidoTripId] = _timelineOf(draft: {
        'id': '0b8e1c5a-0000-4000-8000-000000000099',
        'reason': 'rebuild',
        'phase': 'proposing',
        'job': {'step': 'propose', 'state': 'pending', 'lastError': null},
        'startedAt': '2026-10-26T09:00:00.000Z',
      });

      await _chooseFromMenu(tester, 'タイムラインを編集');
      expect(find.text('タイムラインが変わりました。読み直しました'), findsOneWidget);
      expect(_editTitle, findsNothing);
      expect(find.text('タイムラインの案を作っています'), findsOneWidget);
    });

    testWidgets('「作り直す」は確認のダイアログを出し、「作り直す」で今のタイムラインを消して作り始め、作っている間の表示にする',
        (tester) async {
      final backend = await _openTimeline(tester);

      await _chooseFromMenu(tester, 'タイムラインを作り直す');
      expect(inDialog(find.text('タイムラインを作り直しますか？')), findsOneWidget);
      expect(
          inDialog(find.text(
              '今のタイムラインを消して、今の写真で AI が最初から作り直します。手で直した文と場面の分け方も消え、元には戻せません。')),
          findsOneWidget);
      await tapInDialog(tester, '作り直す');

      expect(
          (backend.timelinesByTripId[hokkaidoTripId]!['draft'] as Map)['phase'],
          'proposing');
      expect(find.text('タイムラインの案を作っています'), findsOneWidget);
      expect(find.text('朝ごはん'), findsNothing);
    });

    testWidgets('「タイムラインを編集」を送っている間は、メニューの「タイムラインを編集」「タイムラインを作り直す」を押せない',
        (tester) async {
      // 送っている間の扱いは §8.1 と同じ。全ケースは trip_timeline_test.dart の「操作を送っている間は…」で通している
      final backend = await _openTimeline(tester);
      final reply = backend.holdNextReply(TripRoute.timelineRecut);

      await _chooseFromMenu(tester, 'タイムラインを編集');
      await _openMenu(tester);
      expect(_menuItem(tester, 'タイムラインを編集').enabled, isFalse);
      expect(_menuItem(tester, 'タイムラインを作り直す').enabled, isFalse);

      reply.complete();
      await letFramesRun(tester);
    });

    /// 1日目の2つ目の場面（小樽）の見出しと一言を [label]・[note] にした完成版
    Map<String, Object?> currentWithSecondScene(
        {required String? label, required String? note}) {
      final current = _current();
      final scenes = ((current['days'] as List).first as Map)['scenes'] as List;
      scenes[1] = {...scenes[1] as Map<String, Object?>, 'label': label, 'note': note};
      return current;
    }

    /// 偽のサーバの下書きの1日目の場面の数
    int firstDaySceneCount(FakeTripBackend backend) =>
        (((backend.timelinesByTripId[hokkaidoTripId]!['draft'] as Map)['days']
                as List)
            .first as Map)['scenes'].length as int;

    testWidgets(
        '編集で「つなげる」とき、後ろの場面に見出しか一言があれば、消える見出しと一言を添えて確かめ、「キャンセル」なら何もせず、「つなげる」でつなげる',
        (tester) async {
      final backend = await _openTimeline(tester,
          current: currentWithSecondScene(label: '小樽運河さんぽ', note: '運河沿いを歩いた。'));
      await _chooseFromMenu(tester, 'タイムラインを編集');

      await tester.tap(find.text('つなげる'));
      await letFramesRun(tester);
      expect(inDialog(find.text('場面をつなげますか？')), findsOneWidget);
      expect(inDialog(find.text('つなげると、後ろの場面の見出しと一言は消えます。')), findsOneWidget);
      expect(inDialog(find.text('消える見出し: 小樽運河さんぽ')), findsOneWidget);
      expect(inDialog(find.text('消える一言: 運河沿いを歩いた。')), findsOneWidget);
      await tapInDialog(tester, 'キャンセル');
      expect(firstDaySceneCount(backend), 2);

      await tester.tap(find.text('つなげる'));
      await letFramesRun(tester);
      await tapInDialog(tester, 'つなげる');
      expect(firstDaySceneCount(backend), 1);
    });

    testWidgets('編集で最初の写真を外した場面を「つなげる」ときも、消える見出しと一言を添えて確かめる（場面の id は外した写真のまま）', (tester) async {
      final semantics = tester.ensureSemantics();
      final backend = await _openTimeline(tester,
          current: currentWithSecondScene(label: '小樽運河さんぽ', note: '運河沿いを歩いた。'));
      await _chooseFromMenu(tester, 'タイムラインを編集');
      await tester.longPress(photoThumbnail('2026年10月5日 10:10'));
      await letFramesRun(tester);
      await tester.tap(find.text('タイムラインから外す'));
      await letFramesRun(tester);
      await tester.tap(find.text('外す'));
      await letFramesRun(tester);

      await tester.tap(find.text('つなげる'));
      await letFramesRun(tester);
      expect(inDialog(find.text('消える見出し: 小樽運河さんぽ')), findsOneWidget);
      await tapInDialog(tester, 'キャンセル');
      expect(firstDaySceneCount(backend), 2);
      semantics.dispose();
    });

    testWidgets('編集で「つなげる」とき、後ろの場面に一言だけがあれば、消える一言だけを添えて確かめる',
        (tester) async {
      final backend = await _openTimeline(tester,
          current: currentWithSecondScene(label: null, note: '運河沿いを歩いた。'));
      await _chooseFromMenu(tester, 'タイムラインを編集');

      await tester.tap(find.text('つなげる'));
      await letFramesRun(tester);
      expect(inDialog(find.text('消える一言: 運河沿いを歩いた。')), findsOneWidget);
      expect(inDialog(find.textContaining('消える見出し')), findsNothing);
      await tapInDialog(tester, 'キャンセル');
      expect(firstDaySceneCount(backend), 2);
    });

    testWidgets('編集で「つなげる」とき、後ろの場面に見出しも一言も無ければ、確かめずにつなげる',
        (tester) async {
      final backend = await _openTimeline(tester,
          current: currentWithSecondScene(label: null, note: null));
      await _chooseFromMenu(tester, 'タイムラインを編集');

      await tester.tap(find.text('つなげる'));
      await letFramesRun(tester);
      expect(inDialog(find.text('場面をつなげますか？')), findsNothing);
      expect(firstDaySceneCount(backend), 1);
    });

    testWidgets('「作り直す」のダイアログで「キャンセル」を押すと、何もしない', (tester) async {
      final backend = await _openTimeline(tester);

      await _chooseFromMenu(tester, 'タイムラインを作り直す');
      await tapInDialog(tester, 'キャンセル');

      expect(backend.timelinesByTripId[hokkaidoTripId]!['draft'], isNull);
      expect(find.text('朝ごはん'), findsOneWidget);
    });
  });

  testWidgets('タイトルもまとめも無い日は印を出さず、見出しの無い場面（区切りを直して足した場面）は見出しの所に「見出しなし」と出し、1枚の場面は終わりの時刻を出さずに地名だけを出す', (tester) async {
    await _openTimeline(tester, current: {
      'writtenAt': '2026-10-25T09:10:00.000Z',
      'days': [
        {
          'date': '2026-10-05',
          'dayNumber': 1,
          'title': null,
          'titleSource': null,
          'summary': null,
          'summarySource': null,
          'scenes': [
            _scene([_photo(1, '2026-10-05T07:50:00')],
                label: null, note: null, placeNames: ['北海道千歳市']),
          ],
        },
      ],
    });

    expect(find.text('1日目'), findsOneWidget);
    // 1枚の場面は終わりの時刻を出さず、地名だけ
    expect(find.text('7:50'), findsOneWidget);
    expect(find.text('北海道千歳市'), findsOneWidget);
    expect(find.textContaining('〜7:50'), findsNothing);
    expect(find.text('AI のまとめ'), findsNothing);
    expect(find.text('編集済み'), findsNothing);
    // 見出しの印は出さず、見出しの所に「見出しなし」と出す（場面の写真の一覧で書ける。§8.8）
    expect(find.byIcon(Icons.circle), findsNothing);
    expect(find.text('見出しなし'), findsOneWidget);
  });

  group('日の文を直す（編集シート。場面の見出しは timeline_scene_photos_test.dart）', () {
    /// シートの [label] の欄
    Finder field(String label) => find.widgetWithText(TextField, label);

    /// 1日目の編集シートを開く（日と場面のシートに共通する扱いは、日のシートで確かめる）
    Future<void> openDaySheet(WidgetTester tester) async {
      await tester.tap(find.bySemanticsLabel('この日を編集').first);
      await letFramesRun(tester);
    }

    testWidgets('日の編集のボタンで「N日目を編集」を開き、まとめを直して保存すると描き直す', (tester) async {
      final semantics = tester.ensureSemantics();
      await _openTimeline(tester);

      await tester.tap(find.bySemanticsLabel('この日を編集').first);
      await letFramesRun(tester);
      expect(find.text('1日目を編集'), findsOneWidget);
      // 日は区切りを直しても足されないので、いつも AI の文がある（場面の「AI が書いていない場面は…」は添えない）
      expect(find.text('空にすると、AI が書いた文に戻ります'), findsOneWidget);
      expect(
          tester.widget<TextField>(field('タイトル')).controller!.text, '小樽の運河と寿司');
      expect(tester.widget<TextField>(field('まとめ')).controller!.text,
          '朝は市場で海鮮丼、昼は運河を歩いた。');

      await tester.enterText(field('まとめ'), '市場と運河の一日。');
      await tester.tap(find.text('保存'));
      await letFramesRun(tester);

      expect(find.text('1日目を編集'), findsNothing);
      expect(find.text('市場と運河の一日。'), findsOneWidget);
      // 直したのは1日目（ほかの日を直していない）
      expect(find.text('朝は市場で海鮮丼、昼は運河を歩いた。'), findsNothing);
      semantics.dispose();
    });

    testWidgets('変えていない欄は送らず、AI の文のまま残る', (tester) async {
      final semantics = tester.ensureSemantics();
      final backend = await _openTimeline(tester);
      // 3日目はタイトルもまとめも AI の文
      await _scrollTo(tester, find.text('3日目'));
      await tester.tap(find.bySemanticsLabel('この日を編集').last);
      await letFramesRun(tester);
      expect(find.text('3日目を編集'), findsOneWidget);

      await tester.enterText(field('タイトル'), '旭川のラーメン');
      await tester.tap(find.text('保存'));
      await letFramesRun(tester);

      expect(find.text('旭川のラーメン'), findsOneWidget);
      final days = (backend.timelinesByTripId[hokkaidoTripId]!['current']
              as Map<String, Object?>)['days'] as List;
      final third = days.cast<Map<String, Object?>>()
          .firstWhere((day) => day['date'] == '2026-10-07');
      expect(third['titleSource'], 'user');
      expect(third['summarySource'], 'ai');
      semantics.dispose();
    });

    testWidgets('前後の空白だけを変えた欄は変えていないものとして、何も変えていなければ送らずに閉じる', (tester) async {
      final semantics = tester.ensureSemantics();
      final backend = await _openTimeline(tester);
      // 送ってしまうと、この失敗でシートが開いたままになる
      backend.failNext(TripRoute.timelineDayPatch);

      await openDaySheet(tester);
      await tester.enterText(field('タイトル'), '  小樽の運河と寿司  ');
      await tester.tap(find.text('保存'));
      await letFramesRun(tester);

      expect(find.text('1日目を編集'), findsNothing);
      expect(find.text('サービスに一時的に接続できません。しばらく待ってから再試行してください。'), findsNothing);
      semantics.dispose();
    });

    testWidgets('日の「タイトル」「まとめ」の欄は 40・400 文字で止める',
        (tester) async {
      final semantics = tester.ensureSemantics();
      await _openTimeline(tester);

      await openDaySheet(tester);
      for (final (label, limit) in [('タイトル', 40), ('まとめ', 400)]) {
        await tester.enterText(field(label), 'あ' * (limit + 1));
        await tester.pump();
        expect(tester.widget<TextField>(field(label)).controller!.text.length,
            limit, reason: label);
      }
      semantics.dispose();
    });

    testWidgets('保存している間は、「保存」をもう一度押しても1回だけ保存し、下に引いても端末の戻る操作でも閉じず「キャンセル」「保存」も押せず、応答が届いたら閉じてタイムラインに戻る',
        (tester) async {
      final semantics = tester.ensureSemantics();
      final backend = await _openTimeline(tester);
      final reply = backend.holdNextReply(TripRoute.timelineDayPatch);

      await openDaySheet(tester);
      await tester.enterText(field('まとめ'), '市場と運河の一日。');
      // 2回目は、押せなくなった描き直しが届く前に押す
      await tester.tap(find.text('保存'));
      await tester.tap(find.text('保存'), warnIfMissed: false);
      await tester.pump();
      expect(_button(tester, '保存').onPressed, isNull);
      expect(_button(tester, 'キャンセル').onPressed, isNull);
      await tester.drag(find.text('1日目を編集'), const Offset(0, 600));
      await letFramesRun(tester);
      expect(find.text('1日目を編集'), findsOneWidget);
      // 端末の戻る操作（Android の戻るジェスチャーと同じ経路で PopScope を通る）。
      // 画面の戻るボタン（tapBack）はシートの下の旅行詳細の戻るボタンを狙い、実際はシートの外の幕に当たってしまう
      await tester.binding.handlePopRoute();
      // 閉じていくシートも、閉じ終えるまでは見つかる。閉じ終えるだけの時間を進めてから見る
      await letFramesRun(tester);
      expect(find.text('1日目を編集'), findsOneWidget);

      reply.complete();
      await letFramesRun(tester);
      // 旅行詳細のタイムラインのまま（2回目の応答で旅行詳細まで閉じない）
      expect(find.text('1日目を編集'), findsNothing);
      expect(find.text('タイムライン'), findsOneWidget);
      expect(find.text('市場と運河の一日。'), findsOneWidget);
      semantics.dispose();
    });

    testWidgets('保存に失敗したら、シートを開いたままエラーの文言を出す', (tester) async {
      final semantics = tester.ensureSemantics();
      final backend = await _openTimeline(tester);
      backend.failNext(TripRoute.timelineDayPatch);

      await openDaySheet(tester);
      await tester.enterText(field('まとめ'), '市場と運河の一日。');
      await tester.tap(find.text('保存'));
      await letFramesRun(tester);

      expect(find.text('1日目を編集'), findsOneWidget);
      expect(find.text('サービスに一時的に接続できません。しばらく待ってから再試行してください。'), findsOneWidget);
      expect(_button(tester, '保存').onPressed, isNotNull);
      semantics.dispose();
    });

    testWidgets('保存のときに別の端末がタイムラインを変えていたら（409）、その日が無くなっていたら（404）、閉じて知らせ、読み直す',
        (tester) async {
      final semantics = tester.ensureSemantics();
      for (final (label, status, code, message) in [
        (
          '409',
          409,
          'TIMELINE_STATE_CONFLICT',
          'タイムラインが変わったか、作っている途中です。読み直してください'
        ),
        ('404', 404, 'TIMELINE_NOT_FOUND', 'その日はタイムラインにありません'),
      ]) {
        final backend = await _openTimeline(tester);
        backend.failNext(TripRoute.timelineDayPatch,
            status: status, code: code, message: message);
        // 読み直したことを、作っている間の表示が出ることで確かめる
        backend.timelinesByTripId[hokkaidoTripId] = _timelineOf(draft: {
          'id': '0b8e1c5a-0000-4000-8000-000000000099',
          'reason': 'rebuild',
          'phase': 'proposing',
          'job': {'step': 'propose', 'state': 'pending', 'lastError': null},
          'startedAt': '2026-10-26T09:00:00.000Z',
        });

        await openDaySheet(tester);
        await tester.enterText(field('まとめ'), '市場と運河の一日。');
        await tester.tap(find.text('保存'));
        await letFramesRun(tester);

        expect(find.text('1日目を編集'), findsNothing, reason: label);
        expect(find.text('タイムラインが変わりました。読み直しました'), findsOneWidget,
            reason: label);
        expect(find.text('タイムラインの案を作っています'), findsOneWidget,
            reason: label);
      }
      semantics.dispose();
    });

    testWidgets('保存のときに旅行が別の端末で消されていたら、閉じて「この旅行は削除されています」を出す', (tester) async {
      final semantics = tester.ensureSemantics();
      final backend = await _openTimeline(tester);

      await openDaySheet(tester);
      await tester.enterText(field('まとめ'), '市場と運河の一日。');
      backend.trips.clear();
      await tester.tap(find.text('保存'));
      await letFramesRun(tester);

      expect(find.text('1日目を編集'), findsNothing);
      expect(find.text('この旅行は削除されています'), findsOneWidget);
      // タイムラインが変わったのではない（読み直して気づくのではなく、保存の応答で旅行が無いと分かる）
      expect(find.text('タイムラインが変わりました。読み直しました'), findsNothing);
      semantics.dispose();
    });
  });

  group('作った後に写真が変わった案内', () {
    testWidgets('作った後に写真が増えた・消えた枚数の案内を一番上に「あとで」「作り直す」と出し、「作り直す」は作り直しの確認を出し、「あとで」で隠した案内は読み直すとまた出す',
        (tester) async {
      final semantics = tester.ensureSemantics();
      for (final (label, added, removed, text) in [
        ('増えて消えたら', 3, 2, '作った後に写真が 3 枚増え、2 枚消えました。今のタイムラインには入っていません。'),
        ('消えただけなら', 0, 2, '作った後に写真が 2 枚消えました。今のタイムラインには入っていません。'),
        ('増えただけなら', 3, 0, '作った後に写真が 3 枚増えました。今のタイムラインには入っていません。'),
      ]) {
        await _openTimeline(tester,
            changes: {'added': added, 'removed': removed});

        expect(find.text(text), findsOneWidget, reason: label);
        expect(find.text('あとで'), findsOneWidget, reason: label);
        expect(_inChangesNotice('作り直す'), findsOneWidget, reason: label);
      }
      expect(tester.getTopLeft(find.textContaining('作った後に写真が')).dy,
          lessThan(tester.getTopLeft(find.text('1日目')).dy));

      await tester.tap(_inChangesNotice('作り直す'));
      await letFramesRun(tester);
      expect(inDialog(find.text('タイムラインを作り直しますか？')), findsOneWidget);
      await tapInDialog(tester, 'キャンセル');

      await tester.tap(find.text('あとで'));
      await letFramesRun(tester);
      expect(find.textContaining('作った後に写真が'), findsNothing);
      expect(find.text('作り直す'), findsNothing);

      // 場面の写真の一覧を開いて閉じると、同じ表示のままタイムラインを読み直す（§8.3）
      await tester.tap(find.text('朝ごはん'));
      await letFramesRun(tester);
      await tapBack(tester);
      await letFramesRun(tester);
      expect(find.text('作った後に写真が 3 枚増えました。今のタイムラインには入っていません。'), findsOneWidget);
      semantics.dispose();
    });

    testWidgets('「あとで」で隠した案内は、下に引っ張って読み直すとまた出す', (tester) async {
      await _openTimeline(tester, changes: {'added': 3, 'removed': 0});
      await tester.tap(find.text('あとで'));
      await letFramesRun(tester);
      expect(find.textContaining('作った後に写真が'), findsNothing);

      await tester.drag(find.text('1日目'), const Offset(0, 600));
      await letFramesRun(tester);
      expect(find.text('作った後に写真が 3 枚増えました。今のタイムラインには入っていません。'), findsOneWidget);
    });

    testWidgets('下書きがある間は、写真が変わっても案内を出さない', (tester) async {
      await _openTimeline(tester, changes: {
        'added': 3,
        'removed': 2
      }, draft: {
        'id': '0b8e1c5a-0000-4000-8000-000000000099',
        'reason': 'recut',
        'phase': 'reviewing',
        'job': null,
        'startedAt': '2026-10-26T09:00:00.000Z',
      });

      expect(find.textContaining('作った後に写真が'), findsNothing);
      expect(find.text('タイムラインを編集している途中です'), findsOneWidget);
    });

    testWidgets('解析中の写真がある間は、写真が変わった案内の「作り直す」も押せない', (tester) async {
      await _openTimeline(tester,
          changes: {'added': 3, 'removed': 0}, pendingPhotoCount: 2);

      expect(
          tester
              .widget<ButtonStyleButton>(find.ancestor(
                  of: _inChangesNotice('作り直す'),
                  matching: find.bySubtype<ButtonStyleButton>()))
              .onPressed,
          isNull);
    });

    testWidgets('操作を送っている間は、日の編集のボタンも押せない', (tester) async {
      // 送っている間の扱いは §8.1 と同じ。全ケースは trip_timeline_test.dart の「操作を送っている間は…」で通している
      final semantics = tester.ensureSemantics();
      final backend = await _openTimeline(tester);
      final reply = backend.holdNextReply(TripRoute.timelineRecut);

      await _chooseFromMenu(tester, 'タイムラインを編集');
      expect(
          tester
              .widget<IconButton>(find.ancestor(
                  of: find.bySemanticsLabel('この日を編集').first,
                  matching: find.byType(IconButton)))
              .onPressed,
          isNull);

      reply.complete();
      await letFramesRun(tester);
      semantics.dispose();
    });
  });
}
