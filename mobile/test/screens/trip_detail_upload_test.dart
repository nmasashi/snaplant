import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart' show listEquals;
import 'package:flutter_image_compress/flutter_image_compress.dart' show CompressFormat;
import 'package:flutter_test/flutter_test.dart';
import 'package:geocoding_platform_interface/geocoding_platform_interface.dart' show Placemark;
import 'package:snaplant_mobile/screens/trip_detail_screen.dart';

import '../helpers/app_test_helpers.dart';
import '../helpers/gallery_test_helpers.dart';
import '../helpers/geocoding_test_helpers.dart';
import '../helpers/image_compress_test_helpers.dart';
import '../helpers/trip_test_helpers.dart';

// 旅行詳細画面の「写真を追加」からの写真の送信を、利用者から見た振る舞いで確かめる（docs/03_screen_design.md §4.3・§4.4）。
// 送信の状態はアプリの根が持つので、アプリ全体を開いて旅行一覧から旅行詳細へ進む。旅行の API は偽のサーバ（helpers の FakeTripBackend）、
// ギャラリー・Geocoder・画像の圧縮は端末の機能なので偽物に差し替える。
// 画面の一覧・選択・編集・削除は trip_detail_screen_test.dart（ファイルを分けているのは、テストが並行して走るようにするため。同じ画面の入口）

const _apiKey = 'test-key';

/// 準備を長引かせるために選ぶ写真の枚数。準備は1枚ずつ別の isolate で進み、1枚に十数ミリ秒かかる。
/// 最初の送信の要求が届いて確かめるまでの間（数百ミリ秒）に準備が終わらない枚数にする
const _manyPhotos = 100;

/// 送った写真の位置のうち、緯度・経度だけ（位置が無ければ null の組）。地名は端末の Geocoder（テストごとに偽物に差し替える）次第で変わるので、
/// EXIF の読み取りを確かめるテストは地名を見ない
(double?, double?) _coordinatesOf(Map<String, Object?> photo) {
  final location = photo['location'] as Map<String, Object?>?;
  return (location?['latitude'] as double?, location?['longitude'] as double?);
}

/// 送った写真の地名と、その出どころ。写真ごとの地名を見るテストは、場所（緯度の整数の度）で写真を引き当てる（届く順は送る順と限らない）
(String?, String?) _placeOf(Map<String, Object?> photo) {
  final location = photo['location'] as Map<String, Object?>;
  return (location['placeName'] as String?, location['placeSource'] as String?);
}

/// 写真の緯度の整数の度
int _latitudeDegreesOf(Map<String, Object?> photo) => ((photo['location'] as Map<String, Object?>)['latitude'] as num).toInt();

/// サーバに届いたサムネイルを作った圧縮の結果。届いたバイト列と同じバイト列を返した圧縮を探す。
/// 圧縮の呼び出しの件数や順には頼らない（作り直しなど、実装の都合で呼び出しが増えても、サーバに届いたものの寸法・画質・形式を見る）。
/// 届いていなければ、見つからないものとして失敗にする
CompressedImage _thumbnailReceived(FakeTripBackend backend, FakeImageCompress compress, Map<String, Object?> photo) {
  final received = backend.thumbnailsByPhotoId[photo['id']];
  if (received == null) fail('写真 ${photo['id']} のサムネイルがサーバに届いていない');
  return compress.results.firstWhere((r) => listEquals(r.bytes, received), orElse: () => fail('届いたサムネイルを作った圧縮が無い'));
}

/// 実時間を進めながら、画面を何度も進める（フェイクの時間は進まない）。
/// 送り直しの待ちが過ぎていないとき、実時間が進んでもファイルの読み込みも要求も起きない（届いた回数が増えない）ことを確かめるために使う。
/// 待ちが過ぎていれば、ファイルの読み込みから要求が届くまでに、実時間の経過と画面を進める操作の繰り返しが要る
/// （実時間を一度に待つだけでは、続きが進まず、早すぎる送り直しを見逃す）。繰り返しの回数と間隔は、見逃さないための余裕
/// 写真のサムネイルを出したあとに使うと、画像のキャッシュが端末の機能（path_provider）を探して落ちる（CLAUDE.md の「テストで踏みやすい点」）。出す前に使う
Future<void> _waitRealTime(WidgetTester tester) async {
  for (var i = 0; i < 20; i++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
    await tester.pump();
  }
}

/// 送信の要求が [count] 回届くまで待ち、その失敗の応答を処理させる（次の送り直しの待ちは、ここから数え始まる）
Future<void> _letUploadFail(WidgetTester tester, FakeTripBackend backend, int count) async {
  await waitUntilUploadsReceived(tester, backend, count);
  await tester.pump();
  await tester.pump();
}

void main() {
  testWidgets('旅行詳細の「写真を追加」でギャラリーから1枚選ぶと、その旅行宛てに送られ（写真の id は画像のバイト列の SHA-256）、「1枚を送信しました」と知らせて、写真の一覧と見出しの枚数に出る', (tester) async {
    // アプリ全体を開いて、旅行一覧から旅行詳細へ進む（送信の状態はアプリの根が持つので、画面だけを単独で開かない）。
    // 偽のサーバは、photoId が画像の SHA-256 と一致しない送信を 400 で断る。クライアントが正しいハッシュを送ったかは、写真が届いたことで分かる。
    // EXIF の無い画像（この PNG）では、撮影日時と位置のパートを省く。空文字のパートや緯度・経度の片方だけの送信は 400 で断られるので、省いていることも、写真が届くことで分かる
    final image = writeTestImage('hokkaido.png');
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('まだ写真がありません'), findsOneWidget);

    expect(find.text('写真を追加'), findsOneWidget);
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, hokkaidoTripId);
    await letFramesRun(tester);

    expect(backend.photosByTripId[hokkaidoTripId]!.map((photo) => photo['id']), [tinyPngSha256]);
    expect(find.text('1枚を送信しました'), findsOneWidget);
    expect(find.text('1枚 · 撮影日時なし'), findsOneWidget);
    expect(find.text('まだ写真がありません'), findsNothing);
  });

  testWidgets('EXIF に撮影日時と GPS がある写真を送ると、撮影日時（YYYY-MM-DDTHH:mm:ss）と緯度・経度（10進。南緯・西経は負）がその写真に入って写真の一覧に撮影日時が出る。実在しない日時（時計が未設定のカメラの 0000:00:00 00:00:00）は撮影日時を、範囲外の緯度（95度）は位置を省いて送られて届く', (tester) async {
    // 4枚を一度に送る。EXIF は、日時が `2026:10:05 10:20:30`、位置が北緯 43度30分・東経 141度15分（10進で 43.5 と 141.25）。画像の作り方は gallery_test_helpers.dart。
    // 届く順は送る順と限らないので、写真ごとの（撮影日時, 緯度, 経度）の組を順を問わずに比べる。
    // 実在しない日時や範囲外の位置を送ると、サーバに 400 で断られ、何度送っても届かない。偽のサーバも同じく 400 で断るので、届くことで省いたことが分かる
    final semantics = tester.ensureSemantics();
    useGalleryReturning([
      writeTestImage('hokkaido.jpg', bytes: exifJpegBytes()),
      writeTestImage('south_west.jpg', bytes: exifJpegBytes(latitudeRef: 'S', longitudeRef: 'W')),
      writeTestImage('unset_clock.jpg', bytes: exifJpegBytes(dateTimeOriginal: '0000:00:00 00:00:00')),
      writeTestImage('bad_gps.jpg', bytes: exifJpegBytes(latitude: [95, 0, 0])),
    ]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, hokkaidoTripId, count: 4);
    await letFramesRun(tester);

    final photos = backend.photosByTripId[hokkaidoTripId]!;
    expect(
      [for (final photo in photos) (photo['takenAt'], _coordinatesOf(photo).$1, _coordinatesOf(photo).$2)],
      unorderedEquals([
        ('2026-10-05T10:20:30', 43.5, 141.25),
        ('2026-10-05T10:20:30', -43.5, -141.25),
        (null, 43.5, 141.25),
        ('2026-10-05T10:20:30', null, null),
      ]),
    );
    expect(photoThumbnail('2026年10月5日 10:20'), findsNWidgets(3));
    semantics.dispose();
  });

  testWidgets('位置情報のある写真を送ると、端末の Geocoder で日本語（ja_JP）で引いた都道府県と市区町村をつないだ地名（北海道旭川市）が端末由来としてその写真に入る。都道府県だけの結果はその都道府県、ちょうど100文字の地名はそのまま入り、空白だけ・101文字・都道府県も市区町村も無い・引けなかった（空の結果）場所は地名なしで送られる', (tester) async {
    // 7枚を一度に送る。場所（緯度の整数の度）ごとに偽の Geocoder（端末の機能。管理外の依存）の結果を変え、写真ごとの地名を緯度で引き当てる。
    // 地名にするのは、都道府県（administrativeArea）と市区町村（locality）だけ（docs/06_processing_design.md §4.2）。番地や区・郡・国・町名は使わない。
    // 空白だけ・空・100文字超えの地名はサーバが 400 で断り写真が届かなくなるので、届くことでも、そういう地名を送っていないことが分かる。
    // 言語を指定しないと、端末の言語で返る（英語の端末だと "HokkaidoAsahikawa"）。渡した言語は Geocoder へ渡す引数なので、外から見える振る舞いとして確かめる。
    // 北緯 34 度（福岡沖）は偽の Geocoder が知らない場所（空のリスト。本物が引けなかった座標に返すのと同じ）
    final geocoding = useFakeGeocoding(places: [
      (
        latitude: 43.0,
        longitude: 141.0,
        placemarks: [
          const Placemark(
            name: '1-1',
            street: '東光1条1丁目',
            country: '日本',
            isoCountryCode: 'JP',
            postalCode: '070-0031',
            administrativeArea: '北海道',
            subAdministrativeArea: '上川郡',
            locality: '旭川市',
            subLocality: '東光',
          ),
        ],
      ),
      (latitude: 33.0, longitude: 139.0, placemarks: [const Placemark(country: '日本', administrativeArea: '東京都', locality: null)]),
      (latitude: 27.0, longitude: 142.0, placemarks: [Placemark(administrativeArea: null, locality: 'あ' * 100)]),
      (latitude: 24.0, longitude: 124.0, placemarks: [const Placemark(country: '日本', administrativeArea: ' ', locality: null)]),
      (latitude: 26.0, longitude: 127.0, placemarks: [Placemark(administrativeArea: null, locality: 'あ' * 101)]),
      (
        latitude: 36.0,
        longitude: 136.0,
        placemarks: [const Placemark(name: '香林坊', country: '日本', isoCountryCode: 'JP', administrativeArea: null, locality: '', subLocality: '香林坊')],
      ),
    ]);
    useGalleryReturning([
      writeTestImage('asahikawa.jpg', bytes: exifJpegBytes(latitude: [43, 0, 0], longitude: [141, 0, 0])),
      writeTestImage('hachijo.jpg', bytes: exifJpegBytes(latitude: [33, 0, 0], longitude: [139, 0, 0])),
      writeTestImage('chichijima.jpg', bytes: exifJpegBytes(latitude: [27, 0, 0], longitude: [142, 0, 0])),
      writeTestImage('ishigaki.jpg', bytes: exifJpegBytes(latitude: [24, 0, 0], longitude: [124, 0, 0])),
      writeTestImage('naha.jpg', bytes: exifJpegBytes(latitude: [26, 0, 0], longitude: [127, 0, 0])),
      writeTestImage('kanazawa.jpg', bytes: exifJpegBytes(latitude: [36, 0, 0], longitude: [136, 0, 0])),
      writeTestImage('fukuoka.jpg', bytes: exifJpegBytes(latitude: [34, 0, 0], longitude: [130, 0, 0])),
    ]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, hokkaidoTripId, count: 7);
    await letFramesRun(tester);

    final photos = backend.photosByTripId[hokkaidoTripId]!;
    expect({for (final photo in photos) _latitudeDegreesOf(photo): _placeOf(photo)}, {
      43: ('北海道旭川市', 'device'),
      33: ('東京都', 'device'),
      27: ('あ' * 100, 'device'),
      24: (null, null),
      26: (null, null),
      36: (null, null),
      34: (null, null),
    });
    expect([for (final lookup in geocoding.lookups) lookup.locale], List.filled(7, const Locale('ja', 'JP')));
    expect(find.text('7枚を送信しました'), findsOneWidget);
  });

  testWidgets('同じ場所（座標を小数3桁に丸めると同じ）で撮った2枚は Geocoder で1回だけ引いて同じ地名を入れ、緯度か経度が 0.001 度以上離れた2枚はそれぞれ引いてそれぞれの地名を入れる。引けなかった（空の結果）場所と、都道府県も市区町村も無かった場所は端末に残さず、同じ場所の次の写真はもう一度引く', (tester) async {
    // 5組の2枚（10枚）を一度に送る。端末の Geocoder は管理外の依存で、引くたびに時間もかかるので、呼んだ回数は観察できる振る舞い。
    // 端末内のキャッシュ（shared_preferences）は、openTripsTab がテストごとに空にするので、他のテストの結果は持ち越されない。
    // 各組の2枚は座標が違うので、バイト列も写真の id も違う。届く順は送る順と限らないので、地名は順を問わずに比べる。
    // - 東京: 北緯 35度40分0秒・東経 139度45分0秒（10進で 35.66667 と 139.75）と、秒だけ1秒ずれた（35.66695 と 139.75028）。どちらも小数3桁に丸めると 35.667 と 139.750 → 1回
    // - 大阪: 北緯 34度40分0秒（34.66667）と4秒北（34.66778）。東経は同じ 135度30分0秒。小数3桁に丸めると 34.667 と 34.668 で違うが、小数2桁なら両方 34.67
    //   （丸めが粗すぎると、隣の街の地名を使い回してしまう）→ 2回
    // - 京都: 東経 135度45分0秒（135.75）と4秒東（135.75111）。北緯は同じ 35度0分0秒。小数3桁に丸めると 135.750 と 135.751 で違う
    //   （経度を見ずに緯度だけで場所を決めると、東西に離れた街の地名を使い回してしまう）→ 2回
    // - 神戸: 北緯 34度41分0秒と1秒南（丸めるとどちらも 34.683）。偽の Geocoder が知らない場所。引けなかった結果を残すと、
    //   一時的に引けなかっただけの場所の地名がずっと付かなくなる → 2回
    // - 金沢: 北緯 36度34分0秒と1秒北（丸めるとどちらも 36.567）。都道府県が null で市区町村が空の結果。地名にならなかった結果を残すと、
    //   同じ場所の写真に地名がずっと付かなくなる → 2回
    final geocoding = useFakeGeocoding(places: [
      (latitude: 35.6667, longitude: 139.75, placemarks: [const Placemark(administrativeArea: '東京都', locality: '千代田区')]),
      (latitude: 34.66667, longitude: 135.5, placemarks: [const Placemark(administrativeArea: '大阪府', locality: '大阪市')]),
      (latitude: 34.66778, longitude: 135.5, placemarks: [const Placemark(administrativeArea: '大阪府', locality: '堺市')]),
      (latitude: 35.0, longitude: 135.75, placemarks: [const Placemark(administrativeArea: '京都府', locality: '京都市')]),
      (latitude: 35.0, longitude: 135.75111, placemarks: [const Placemark(administrativeArea: '京都府', locality: '宇治市')]),
      (latitude: 36.5667, longitude: 136.65, placemarks: [const Placemark(country: '日本', administrativeArea: null, locality: '', subLocality: '香林坊')]),
    ]);
    useGalleryReturning([
      writeTestImage('tokyo_1.jpg', bytes: exifJpegBytes(latitude: [35, 40, 0], longitude: [139, 45, 0])),
      writeTestImage('tokyo_2.jpg', bytes: exifJpegBytes(latitude: [35, 40, 1], longitude: [139, 45, 1])),
      writeTestImage('osaka_1.jpg', bytes: exifJpegBytes(latitude: [34, 40, 0], longitude: [135, 30, 0])),
      writeTestImage('osaka_2.jpg', bytes: exifJpegBytes(latitude: [34, 40, 4], longitude: [135, 30, 0])),
      writeTestImage('kyoto_1.jpg', bytes: exifJpegBytes(latitude: [35, 0, 0], longitude: [135, 45, 0])),
      writeTestImage('kyoto_2.jpg', bytes: exifJpegBytes(latitude: [35, 0, 0], longitude: [135, 45, 4])),
      writeTestImage('kobe_1.jpg', bytes: exifJpegBytes(latitude: [34, 41, 0], longitude: [135, 11, 0])),
      writeTestImage('kobe_2.jpg', bytes: exifJpegBytes(latitude: [34, 40, 59], longitude: [135, 11, 0])),
      writeTestImage('kanazawa_1.jpg', bytes: exifJpegBytes(latitude: [36, 34, 0], longitude: [136, 39, 0])),
      writeTestImage('kanazawa_2.jpg', bytes: exifJpegBytes(latitude: [36, 34, 1], longitude: [136, 39, 0])),
    ]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, hokkaidoTripId, count: 10);
    await letFramesRun(tester);

    expect(geocoding.lookups, hasLength(9));
    final photos = backend.photosByTripId[hokkaidoTripId]!;
    expect(
      [for (final photo in photos) (photo['location'] as Map)['placeName']],
      unorderedEquals(['東京都千代田区', '東京都千代田区', '大阪府大阪市', '大阪府堺市', '京都府京都市', '京都府宇治市', null, null, null, null]),
    );
  });

  testWidgets('Geocoder が失敗しても、その写真は地名なしで送られ、「1枚を送信しました」と知らせる', (tester) async {
    // 端末の Geocoder が例外を投げる（Google Play 開発者サービスが無い・ネットワークが無い、など）。地名は手がかりに過ぎないので、送信は止めない
    final geocoding = useFakeGeocoding(failWith: Exception('Geocoder が使えない'));
    final image = writeTestImage('sendai.jpg', bytes: exifJpegBytes(latitude: [38, 16, 0], longitude: [140, 52, 0]));
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, hokkaidoTripId);
    await letFramesRun(tester);

    expect(geocoding.lookups, hasLength(1));
    final photo = backend.photosByTripId[hokkaidoTripId]!.single;
    expect((photo['location'] as Map)['placeName'], isNull);
    expect(find.text('1枚を送信しました'), findsOneWidget);
  });

  testWidgets('Geocoder が5秒たっても応答しなければ、その写真は地名なしで送られ、「1枚を送信しました」と知らせる', (tester) async {
    // 端末の Geocoder が固まる。引き始めてから 4.999 秒の間はまだ待ち（写真は送られない）、5 秒で諦めて送る。
    // 時間はフェイクの時間で進める（実時間の 5 秒は待たない）。画面を進める letFramesRun は 1.5 秒ずつ進めてしまうので、引かれるのを待つ間は使わない。
    // 引き始めの時刻は、引かれたのを見つけるまでフェイクの時間を進めていないので、そこから数えられる
    final geocoding = useFakeGeocoding(hangs: true);
    final image = writeTestImage('nagano.jpg', bytes: exifJpegBytes(latitude: [36, 39, 0], longitude: [138, 11, 0]));
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await waitUntilLookedUp(tester, geocoding, 1);
    await tester.pump(const Duration(milliseconds: 4999));
    await _waitRealTime(tester);
    expect(backend.uploadsReceived, 0);

    await tester.pump(const Duration(milliseconds: 1));
    await waitUntilUploaded(tester, backend, hokkaidoTripId);
    await letFramesRun(tester);

    final photo = backend.photosByTripId[hokkaidoTripId]!.single;
    expect((photo['location'] as Map)['placeName'], isNull);
    expect(find.text('1枚を送信しました'), findsOneWidget);
  });

  testWidgets('写真を送ると、長辺320px・画質70のJPEGのサムネイル（横長の 4000x3000 は 320x240、縦長の 3000x4000 は 240x320）を付けて送り、その写真にサムネイルが入る', (tester) async {
    // 画像の圧縮（端末のネイティブの機能。管理外の依存）は偽物に差し替え、渡した引数から決まる寸法・画質・形式を結果として読む。
    // 偽物は本物と同じく、短辺が渡した最小の値になるまで縮める。幅と高さの最小を両方 320 にすると 426x320 になるので、長辺 320 には 320x240 になる渡し方が要る
    // （縦長のときは高さだけに 320 を渡さないと 320x426 になる）。
    // 圧縮は端末のネイティブの機能で、別の isolate（準備の compute）からは呼べない。この偽物が呼ばれる（結果が残る）ことで、メインの isolate で呼んでいることも分かる
    final compress = useFakeImageCompress();
    useGalleryReturning([
      writeTestImage('wide.png', bytes: pngBytesOfSize(4000, 3000)),
      writeTestImage('tall.png', bytes: pngBytesOfSize(3000, 4000)),
    ]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, hokkaidoTripId, count: 2);
    await letFramesRun(tester);

    final photos = backend.photosByTripId[hokkaidoTripId]!;
    expect([for (final photo in photos) photo['thumbnailUrl']], everyElement(isNotNull));
    final thumbnails = [for (final photo in photos) _thumbnailReceived(backend, compress, photo)];
    expect(
      [for (final t in thumbnails) (t.width, t.height, t.quality, t.format)],
      unorderedEquals([(320, 240, 70, CompressFormat.jpeg), (240, 320, 70, CompressFormat.jpeg)]),
    );
  });

  testWidgets('サムネイルを作れなかった写真も、サムネイル無しで送られ、「1枚を送信しました」と知らせる', (tester) async {
    // 圧縮が例外を投げる（画像を読めない・端末の機能が使えない）。サムネイルは一覧の表示用で、無くても写真は保存できるので、送信は止めない。
    // サムネイルのパートは省かれる（空のパートは 400 で断られるので、写真が届くことでも分かる）
    useFakeImageCompress(failWith: Exception('サムネイルを作れない'));
    final image = writeTestImage('hokkaido.png', bytes: pngBytesOfSize(4000, 3000));
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, hokkaidoTripId);
    await letFramesRun(tester);

    final photo = backend.photosByTripId[hokkaidoTripId]!.single;
    expect(photo['thumbnailUrl'], isNull);
    expect(backend.thumbnailsByPhotoId, isEmpty);
    expect(find.text('1枚を送信しました'), findsOneWidget);
  });

  testWidgets('3枚のうち2枚目の準備（ファイルの読み込み）に失敗しても、3枚目の準備は続け、「画像の読み込みに失敗しました」と知らせ、読めた1枚目と3枚目が送られて「2枚を送信しました」と知らせる', (tester) async {
    // 準備は1枚ずつ進む。途中の1枚で失敗しても、それまでに準備できた分が列に残ったまま送られなくならず、失敗した写真より後に選んだ写真も捨てない。2枚目は存在しないパス
    final first = writeTestImage('first.png');
    final missing = File('${first.parent.path}/no_such_image.png');
    final third = writeTestImage('third.png', bytes: [...tinyPngBytes, 0]);
    useGalleryReturning([first, missing, third]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await waitUntilFound(tester, find.text('画像の読み込みに失敗しました'));

    expect(find.text('画像の読み込みに失敗しました'), findsOneWidget);
    await waitUntilUploaded(tester, backend, hokkaidoTripId, count: 2);
    await letFramesRun(tester);
    expect(backend.photosByTripId[hokkaidoTripId]!.length, 2);
    expect(backend.photosByTripId[hokkaidoTripId]!.map((photo) => photo['id']), contains(tinyPngSha256));
    // 2つの知らせは順に出る。先の「読み込みに失敗しました」が消えてから、あとの知らせが出る
    await pumpUntilFound(tester, find.text('2枚を送信しました'));
    expect(find.text('2枚を送信しました'), findsOneWidget);
  });

  testWidgets('送信している間に設定をリセットしてアプリが送信の列を作り直しても、送信の応答が返ったときに例外は出ず、作り直した後の画面に送信の知らせは出ない', (tester) async {
    // 設定が変わると、前の設定の列は破棄される。破棄された列の送信が終わっても、閉じたストリームへ流したり、破棄済みの通知を呼んだりしない
    final image = writeTestImage('hokkaido.png');
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    final release = Completer<void>();
    backend.holds[TripRoute.upload] = release.future;
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 1);
    await letFramesRun(tester);
    await tapBack(tester);
    await letFramesRun(tester);
    await resetSettingsAndGoBack(tester);
    expect(find.text('API設定が完了していません'), findsOneWidget);

    release.complete();
    await letFramesRun(tester);

    expect(find.textContaining('送信'), findsNothing);
  });

  testWidgets('「写真を追加」を押してから写真を受け取るまで、ボタンを「写真を読み込み中...」（回転する印つき）にして押せなくし、選ぶ画面を何も選ばずに閉じたら、ボタンを「写真を追加」に戻し、もう一度押せば選ぶ画面を開ける', (tester) async {
    // ギャラリーの返事を保留して、選ぶ画面を開いてから写真を受け取るまでの間をつくる。2回目に押しても選ぶ画面は開き直されない。
    // 閉じるまでの間は「写真を読み込み中...」のまま。何も選ばれなかったときも、ボタンは元に戻る（受け取った後に戻ることは、100枚を選ぶテストで見る）
    final release = Completer<void>();
    final gallery = useGalleryReturning([], hold: release.future);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await letFramesRun(tester);

    expect(find.text('写真を読み込み中...'), findsOneWidget);
    expect(find.descendant(of: find.byType(FloatingActionButton), matching: find.byType(CircularProgressIndicator)), findsOneWidget);
    expect(find.text('写真を追加'), findsNothing);
    await tester.tap(find.text('写真を読み込み中...'));
    await letFramesRun(tester);
    expect(gallery.openCount, 1);

    release.complete();
    await letFramesRun(tester);

    expect(find.text('写真を追加'), findsOneWidget);
    expect(find.text('写真を読み込み中...'), findsNothing);
    await tester.tap(find.text('写真を追加'));
    await letFramesRun(tester);
    expect(gallery.openCount, 2);
  });

  testWidgets('写真を受け取るのを待っている間に選択モードに入って抜けても、ボタンは「写真を読み込み中...」のままで、選ぶ画面を二重に開かない', (tester) async {
    // 選択モードの間は右下のボタンが外れる。抜けて作り直されたボタンが待ちの状態を忘れて「写真を追加」に戻ると、押せてしまう
    final release = Completer<void>();
    final gallery = useGalleryReturning([], hold: release.future);
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 1)],
      functionKey: _apiKey,
      photosByTripId: {
        hokkaidoTripId: [photoJson(number: 1, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:01:00')],
      },
    );
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    await tester.tap(find.text('写真を追加'));
    await letFramesRun(tester);
    expect(find.text('写真を読み込み中...'), findsOneWidget);
    await tester.longPress(photoThumbnail('2026年10月5日 10:01'));
    await letFramesRun(tester);
    expect(find.byType(FloatingActionButton), findsNothing);

    await tester.tap(find.descendant(of: find.byType(AppBar), matching: find.byIcon(Icons.close)));
    await letFramesRun(tester);

    expect(find.text('写真を読み込み中...'), findsOneWidget);
    expect(find.text('写真を追加'), findsNothing);
    await tester.tap(find.byType(FloatingActionButton));
    await letFramesRun(tester);
    expect(gallery.openCount, 1);
    release.complete();
    await letFramesRun(tester);
  });

  testWidgets('ギャラリーの読み込みに失敗して選ぶ画面が閉じたら、「画像の読み込みに失敗しました」と知らせ、何も送らず、ボタンを「写真を追加」に戻す', (tester) async {
    final release = Completer<void>();
    useGalleryReturning([], failWith: Exception('ギャラリーを開けない'), hold: release.future);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    await tester.tap(find.text('写真を追加'));
    await letFramesRun(tester);
    expect(find.text('写真を読み込み中...'), findsOneWidget);

    release.complete();
    await letFramesRun(tester);

    expect(find.text('画像の読み込みに失敗しました'), findsOneWidget);
    expect(backend.photosByTripId[hokkaidoTripId] ?? [], isEmpty);
    expect(find.text('まだ写真がありません'), findsOneWidget);
    expect(find.text('写真を追加'), findsOneWidget);
    expect(find.text('写真を読み込み中...'), findsNothing);
  });

  testWidgets('写真を受け取るのを待っている間にボタンが外れていても、読み込みに失敗したら「画像の読み込みに失敗しました」を出す', (tester) async {
    // 選択モードの間は右下のボタンが外れ、押したボタンの context は生きていない。知らせる先の ScaffoldMessenger は生きている
    final release = Completer<void>();
    useGalleryReturning([], failWith: Exception('ギャラリーを開けない'), hold: release.future);
    final backend = FakeTripBackend(
      trips: [hokkaidoTrip(photoCount: 1)],
      functionKey: _apiKey,
      photosByTripId: {
        hokkaidoTripId: [photoJson(number: 1, tripId: hokkaidoTripId, takenAt: '2026-10-05T10:01:00')],
      },
    );
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    await tester.tap(find.text('写真を追加'));
    await letFramesRun(tester);
    await tester.longPress(photoThumbnail('2026年10月5日 10:01'));
    await letFramesRun(tester);
    expect(find.byType(FloatingActionButton), findsNothing);

    release.complete();
    await letFramesRun(tester);

    expect(find.text('画像の読み込みに失敗しました'), findsOneWidget);
  });

  testWidgets('2枚を送っている間は、旅行詳細の上部に「送信中 0/2」を出し、1枚の応答が返ると「送信中 1/2」に変わり、2枚目の応答が返るとバナーを消して「2枚を送信しました」と知らせる', (tester) async {
    // 偽のサーバは、届いた2回の送信の応答をそれぞれ保留する（同時に2本送られる）。届いた時点で写真は偽のサーバに入っている。
    // 応答を返すと完了と数える
    final first = writeTestImage('first.png');
    final second = writeTestImage('second.png', bytes: [...tinyPngBytes, 0]);
    useGalleryReturning([first, second]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    final firstReply = backend.holdNextReply(TripRoute.upload);
    final secondReply = backend.holdNextReply(TripRoute.upload);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.textContaining('送信中'), findsNothing);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, hokkaidoTripId, count: 2);
    await letFramesRun(tester);

    expect(backend.photosByTripId[hokkaidoTripId]!.length, 2);
    expect(find.text('送信中 0/2'), findsOneWidget);

    firstReply.complete();
    await letFramesRun(tester);

    expect(find.text('送信中 1/2'), findsOneWidget);

    secondReply.complete();
    await letFramesRun(tester);

    expect(find.textContaining('送信中'), findsNothing);
    expect(find.text('2枚を送信しました'), findsOneWidget);
  });

  testWidgets('100枚を選ぶと、準備が済んだ写真から送り始め、準備が終わるまでの間は、旅行詳細の上部に「写真を準備中... k/100」を出す。写真を受け取ったら、準備が続いている間も、ボタンは「写真を追加」に戻って押せる', (tester) async {
    // 準備は1枚ずつ別の isolate で進む。100枚の準備は、最初の送信の要求が偽のサーバに届いたあともしばらく続く（準備が終わるとバナーは消える）。
    // k は準備の進み具合で変わるので、分母と形式で見る。1枚目の応答は保留して、1枚目の送信が終わったことによる表示の変化を混ぜない。
    // ボタンを押せなくするのは写真を受け取るまで。受け取った後の準備（100枚で数秒かかる）の間は、次の写真を選べる（送信が終わったことでボタンが戻るのではない）
    final gallery = useGalleryReturning(writeTestImages(_manyPhotos));
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    final firstReply = backend.holdNextReply(TripRoute.upload);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 1);
    await tester.pump();

    expect(preparingBanner(_manyPhotos), findsOneWidget);
    // 最初の1枚は準備が済んでいて、全部は済んでいない（k は準備の進み具合で変わるので、範囲で見る）
    expect(preparedCountInBanner(_manyPhotos), inInclusiveRange(1, _manyPhotos - 1));

    // 2回目に選ばれるのは空（準備を増やさない）
    gallery.files = [];
    final addButton = find.descendant(of: find.byType(FloatingActionButton), matching: find.text('写真を追加'));
    expect(addButton, findsOneWidget);
    await tester.tap(addButton);
    await tester.pump();

    expect(gallery.openCount, 2);
    // 後片付け: 保留した応答を返す（応答を待つ間の時間切れのタイマーを、テストの終わりに残さない）
    firstReply.complete();
  });

  testWidgets('最初の1枚の送信が残りの準備より先に終わっても、準備中の写真が残っている間は「N枚を送信しました」と知らせず、全部が終わってから「100枚を送信しました」を1回だけ知らせる', (tester) async {
    // 今回は1枚目の応答を保留しないので、1枚目の送信は準備が終わる前に終わる。準備中の写真が残っているので、送信の区切りにはならない。
    // 1枚目の送信が終わった時点で送信の列が空になるよう、2枚目だけは 16MB のファイルにする（準備に数百ミリ秒かかる。残りの98枚は小さく、準備の終わりはさらに遅れる）
    final files = writeTestImages(_manyPhotos);
    final medium = writeTestImage('medium.png', bytes: Uint8List(16 * 1024 * 1024));
    useGalleryReturning([files.first, medium, ...files.skip(2)]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, hokkaidoTripId);
    await letFramesRun(tester);

    expect(preparingBanner(_manyPhotos), findsOneWidget);
    expect(find.textContaining('を送信しました'), findsNothing);

    await waitUntilFound(tester, find.text('100枚を送信しました'), step: const Duration(milliseconds: 1));

    expect(find.text('100枚を送信しました'), findsOneWidget);
    expect(find.textContaining('を送信しました'), findsOneWidget);
  });

  testWidgets('1枚の送信の応答が60秒返らないときは、時間切れにして2秒後に送り直し、その送り直しが成功すれば、「1枚を送信しました」と知らせ、送信できなかった行は出ない', (tester) async {
    // 1回目の応答は保留して返さない（通信が固まった状態）。時間切れは通信の失敗と同じ扱いで、2秒後に送り直す。
    // 送り直しの待ちと同じく、時間切れもフェイクの時間（pump）で進める。要求が届いてから時間は進めていないので、
    // 時間切れは 60 秒、送り直しはその 2 秒後。1ミリ秒手前では届かず、1ミリ秒進めると届く
    final image = writeTestImage('hokkaido.png');
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    final firstReply = backend.holdNextReply(TripRoute.upload);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 1);
    await tester.pump(const Duration(milliseconds: 61999));
    await _waitRealTime(tester);
    expect(backend.uploadsReceived, 1);
    await tester.pump(const Duration(milliseconds: 1));
    await waitUntilUploadsReceived(tester, backend, 2);
    // 時間切れのあとに、保留していた1回目の応答が遅れて届いても、結果は変わらない
    firstReply.complete();
    await letFramesRun(tester);

    await pumpUntilFound(tester, find.text('1枚を送信しました'));
    expect(find.text('1枚を送信しました'), findsOneWidget);
    expect(find.textContaining('送信できませんでした'), findsNothing);
  });

  testWidgets('送信が1回目に 503・429（封筒の無い「混雑」の応答）・通信の失敗（応答が返らない）になっても、2秒後の送り直しで成功すれば、写真は届いて「3枚を送信しました」と知らせ、送信できなかった行は出ない', (tester) async {
    // 通信の失敗・429・503 は自動で送り直す（2秒 → 4秒 → 8秒）。3枚を一度に送り、1回目の要求に届いた順に 503・429・通信の失敗を割り当てる。
    // 同時に送るのは2本で、送り直しを待つ間も枠はふさがったままなので、3枚目は先の2枚の送り直しが済んでから送られる。
    // 429 は、アプリではなく従量課金プランの Functions ランタイムが過負荷のときに、封筒なしで返す。通信が切れて応答が返らない失敗は、HTTP クライアントの例外として届く。
    // 送り直しの待ちはフェイクの時間（pump）で進める。準備とファイルの読み込みは実時間でしか進まないので、待ちを過ぎたあとは実時間で要求が届くのを待つ
    useGalleryReturning([
      writeTestImage('first.png'),
      writeTestImage('second.png', bytes: [...tinyPngBytes, 0]),
      writeTestImage('third.png', bytes: [...tinyPngBytes, 0, 0]),
    ]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    backend.failNext(TripRoute.upload);
    backend.failNextWithoutEnvelope(TripRoute.upload, status: 429);
    backend.failNextWithConnectionError(TripRoute.upload);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await _letUploadFail(tester, backend, 2);
    await letFramesRun(tester);
    await tester.pump(const Duration(seconds: 2));
    await waitUntilUploaded(tester, backend, hokkaidoTripId, count: 2);
    await letFramesRun(tester);
    await _letUploadFail(tester, backend, 5);
    await letFramesRun(tester);
    await tester.pump(const Duration(seconds: 2));
    await waitUntilUploaded(tester, backend, hokkaidoTripId, count: 3);
    await letFramesRun(tester);

    expect(backend.photosByTripId[hokkaidoTripId]!, hasLength(3));
    await pumpUntilFound(tester, find.text('3枚を送信しました'));
    expect(find.text('3枚を送信しました'), findsOneWidget);
    expect(find.textContaining('送信できませんでした'), findsNothing);
  });

  testWidgets('503 で失敗した送信は、2秒・4秒・8秒の間隔を空けて送り直し、それより早くは送り直さない', (tester) async {
    // 送り直しの待ちはフェイクの時間。待ちの1ミリ秒手前では実時間を進めても要求は届かず、1ミリ秒進めると届く。
    // 要求が届いた回数は、偽のサーバが受け取った要求の数（送り直しの間隔を、サーバから見た要求の届き方で確かめる）
    final image = writeTestImage('hokkaido.png');
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    for (var i = 0; i < 4; i++) {
      backend.failNext(TripRoute.upload);
    }
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await _letUploadFail(tester, backend, 1);
    await tester.pump(const Duration(milliseconds: 1999));
    await _waitRealTime(tester);
    expect(backend.uploadsReceived, 1);
    await tester.pump(const Duration(milliseconds: 1));
    await _letUploadFail(tester, backend, 2);

    await tester.pump(const Duration(milliseconds: 3999));
    await _waitRealTime(tester);
    expect(backend.uploadsReceived, 2);
    await tester.pump(const Duration(milliseconds: 1));
    await _letUploadFail(tester, backend, 3);

    await tester.pump(const Duration(milliseconds: 7999));
    await _waitRealTime(tester);
    expect(backend.uploadsReceived, 3);
    await tester.pump(const Duration(milliseconds: 1));
    await _letUploadFail(tester, backend, 4);
  });

  testWidgets('送り直しは3回までで、4回とも 503 で失敗したら、それ以上は送らず、バナーに「1枚を送信できませんでした」を出す', (tester) async {
    // 間隔は前のテストが見る。ここでは各回の待ちを十分に（実際の間隔より長く）進め、最後の失敗のあとにどれだけ待っても送られないことを見る
    final image = writeTestImage('hokkaido.png');
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    for (var i = 0; i < 4; i++) {
      backend.failNext(TripRoute.upload);
    }
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await _letUploadFail(tester, backend, 1);
    await tester.pump(const Duration(seconds: 3));
    await _letUploadFail(tester, backend, 2);
    await tester.pump(const Duration(seconds: 5));
    await _letUploadFail(tester, backend, 3);
    await tester.pump(const Duration(seconds: 9));
    await _letUploadFail(tester, backend, 4);
    await tester.pump(const Duration(seconds: 16));
    await _waitRealTime(tester);
    await letFramesRun(tester);

    expect(backend.uploadsReceived, 4);
    expect(backend.photosByTripId[hokkaidoTripId] ?? [], isEmpty);
    expect(find.text('1枚を送信できませんでした（サービスに一時的に接続できません。しばらく待ってから再試行してください。）'), findsOneWidget);
    expect(find.text('送り直す'), findsOneWidget);
  });

  testWidgets('送り先の旅行が別の端末で消されていて 404 になったら、同じ旅行宛ての残りの写真は送らずに失敗にし、バナーに「3枚を送信できませんでした（旅行が見つかりません）」を出す', (tester) async {
    // 詳細を開いたあとで、偽のサーバから旅行を消す（画面は取り直さないので、詳細は開いたまま）。
    // 同時に送るのは2本。1枚目と2枚目の応答（どちらも 404）を保留して、3枚目の準備が済み、待ちに入った（「送信中 0/3」）ところで返す。
    // こうすると、3枚目は 404 が返る前に送られることがなく、送らないことを、届いた要求がちょうど2回であることで決定的に見られる
    final first = writeTestImage('first.png');
    final second = writeTestImage('second.png', bytes: [...tinyPngBytes, 0]);
    final third = writeTestImage('third.png', bytes: [...tinyPngBytes, 0, 0]);
    useGalleryReturning([first, second, third]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);
    backend.trips.clear();
    final firstReply = backend.holdNextReply(TripRoute.upload);
    final secondReply = backend.holdNextReply(TripRoute.upload);

    await tester.tap(find.text('写真を追加'));
    await waitUntilFound(tester, find.text('送信中 0/3'));
    expect(find.text('送信中 0/3'), findsOneWidget);
    firstReply.complete();
    secondReply.complete();
    await _waitRealTime(tester);
    await letFramesRun(tester);

    expect(backend.uploadsReceived, 2);
    expect(backend.photosByTripId[hokkaidoTripId] ?? [], isEmpty);
    expect(find.text('3枚を送信できませんでした（旅行が見つかりません）'), findsOneWidget);
  });

  testWidgets('送信がサーバの 413（ファイルが大きすぎる）で失敗すると、バナーはサーバが返した文言を理由に添えて「1枚を送信できませんでした（ファイルサイズが大きすぎます）」を出す', (tester) async {
    // 500・503 などは固定の文言、それ以外のステータスはサーバの `message` が理由になる（`ApiException.userMessage`）。413 は送り直しの対象ではない
    final image = writeTestImage('hokkaido.png');
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    backend.failNext(TripRoute.upload, status: 413, code: 'FILE_TOO_LARGE', message: 'ファイルサイズが大きすぎます');
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 1);
    await _waitRealTime(tester);
    await letFramesRun(tester);

    expect(find.text('1枚を送信できませんでした（ファイルサイズが大きすぎます）'), findsOneWidget);
  });

  testWidgets('送った2枚のうち1枚が、別の旅行に送信済みの写真（200）なら、「2枚を送信しました（1枚は送信済みでした。別の旅行か、旅行に属さない写真にあります）」と知らせ、北海道には新しい1枚だけが入る', (tester) async {
    // 写真の id は画像の SHA-256 なので、同じ写真は何度送っても1枚になる。偽のサーバは、既にある id には 200 で既存の写真（京都にある）を返す。
    // 送信済みの1枚も、送れた枚数（2枚）に数える
    final alreadySent = writeTestImage('already_sent.png');
    final fresh = writeTestImage('fresh.png', bytes: [...tinyPngBytes, 0]);
    useGalleryReturning([alreadySent, fresh]);
    final backend = FakeTripBackend(
      trips: [
        tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0),
        tripJson(id: kyotoTripId, name: '京都', photoCount: 1),
      ],
      photosByTripId: {
        kyotoTripId: [photoJson(number: 0, tripId: kyotoTripId)..['id'] = tinyPngSha256],
      },
    );
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, hokkaidoTripId);
    await letFramesRun(tester);

    expect(backend.photosByTripId[hokkaidoTripId]!.length, 1);
    expect(backend.photosByTripId[kyotoTripId]!.length, 1);
    await pumpUntilFound(tester, find.textContaining('を送信しました'));
    expect(find.text('2枚を送信しました（1枚は送信済みでした。別の旅行か、旅行に属さない写真にあります）'), findsOneWidget);
  });

  testWidgets('送り先の旅行が消えていて 404 になったあとに準備が済んだ同じ旅行宛ての写真も、送らずに失敗にし、バナーに「100枚を送信できませんでした（旅行が見つかりません）」を出す', (tester) async {
    // 100枚を選び、同時に送る1枚目と2枚目の応答（どちらも 404）を保留する。2本が届いた時点で準備はまだ続いているので、
    // 応答を返したあとに準備が済む写真がある。それらも送られない（届いた要求は2回のまま）
    useGalleryReturning(writeTestImages(_manyPhotos));
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);
    backend.trips.clear();
    final firstReply = backend.holdNextReply(TripRoute.upload);
    final secondReply = backend.holdNextReply(TripRoute.upload);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 2);
    await tester.pump();
    expect(preparingBanner(_manyPhotos), findsOneWidget);
    firstReply.complete();
    secondReply.complete();
    await waitUntilFound(tester, find.textContaining('送信できませんでした'), step: const Duration(milliseconds: 1));

    expect(backend.uploadsReceived, 2);
    expect(find.text('100枚を送信できませんでした（旅行が見つかりません）'), findsOneWidget);
  });

  testWidgets('旅行が無いと分かった画面でも、この旅行宛ての送信の失敗のバナーは出したままにし、「閉じる」で消せる', (tester) async {
    // 先に送信が 404（旅行が見つかりません）で失敗し、そのあと下に引っ張った読み直しで写真の一覧も 404 になって、画面が「この旅行は削除されています」になる。
    // 順は決まっている（送信の失敗を見届けてから読み直す）。画面設計 §4.4: 送れなかった写真を「閉じる」で片付けられるよう、バナーは出したままにする
    final image = writeTestImage('hokkaido.png');
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);
    backend.trips.clear();
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 1);
    await letFramesRun(tester);
    expect(find.text('1枚を送信できませんでした（旅行が見つかりません）'), findsOneWidget);

    await tester.drag(find.byType(RefreshIndicator), const Offset(0, 600));
    await letFramesRun(tester);

    expect(find.text('この旅行は削除されています'), findsOneWidget);
    expect(find.text('1枚を送信できませんでした（旅行が見つかりません）'), findsOneWidget);
    expect(find.text('閉じる'), findsOneWidget);
    await tester.tap(find.text('閉じる'));
    await letFramesRun(tester);
    expect(find.textContaining('送信できませんでした'), findsNothing);
  });

  testWidgets('送り直しを待っている写真があるときに、同じ旅行宛ての別の写真が 404 になったら、待っている写真も送り直さずに失敗にし、バナーに「2枚を送信できませんでした（旅行が見つかりません）」を出す', (tester) async {
    // 同時に送る2枚のうち、1枚目の要求が 503（2秒後に送り直す）、2枚目の要求が 404 になる（失敗は、要求が届いた順に割り当てる）。
    // 2枚目の 404 で旅行が無いと分かった以上、待ちが明けた1枚目も送らない（届いた要求は2回のまま）
    final first = writeTestImage('first.png');
    final second = writeTestImage('second.png', bytes: [...tinyPngBytes, 0]);
    useGalleryReturning([first, second]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    backend.failNext(TripRoute.upload);
    backend.failNext(TripRoute.upload, status: 404, code: 'TRIP_NOT_FOUND', message: '指定された旅行が見つかりません');
    // 3回目の要求（送り直しが送られてしまったとき）も失敗にして、写真が届いて画面に出る（サムネイルのあとの実時間の待ちで落ちる）ことを避ける
    backend.failNext(TripRoute.upload);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await _letUploadFail(tester, backend, 2);
    await tester.pump(const Duration(seconds: 2));
    await _waitRealTime(tester);
    await letFramesRun(tester);

    expect(backend.uploadsReceived, 2);
    expect(find.text('2枚を送信できませんでした（旅行が見つかりません）'), findsOneWidget);
  });

  testWidgets('旅行が消えていて失敗した写真を「閉じる」で消しても、消えた旅行は覚えていて、同じ旅行へ選び直した写真は送らずに失敗にし、「1枚を送信できませんでした（旅行が見つかりません）」を出す', (tester) async {
    // 一区切りや「閉じる」では、消えた旅行を忘れない（忘れるのは「送り直す」を押したとき）。選び直した写真の要求は偽のサーバに届かない
    final first = writeTestImage('first.png');
    useGalleryReturning([first]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);
    backend.trips.clear();
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 1);
    await letFramesRun(tester);
    expect(find.text('1枚を送信できませんでした（旅行が見つかりません）'), findsOneWidget);
    await tester.tap(find.text('閉じる'));
    await letFramesRun(tester);
    expect(find.textContaining('送信できませんでした'), findsNothing);
    final second = writeTestImage('second.png', bytes: [...tinyPngBytes, 0]);
    useGalleryReturning([second]);

    await tester.tap(find.text('写真を追加'));
    await waitUntilFound(tester, find.text('1枚を送信できませんでした（旅行が見つかりません）'));
    await _waitRealTime(tester);

    expect(backend.uploadsReceived, 1);
    expect(find.text('1枚を送信できませんでした（旅行が見つかりません）'), findsOneWidget);
  });

  testWidgets('旅行が消えていて失敗した写真は、旅行が戻ってから「送り直す」で送れて、そのあとに同じ旅行へ選んだ写真も届く（「送り直す」で消えた旅行を忘れる）', (tester) async {
    // 送り直しで届いた写真は、偽のサーバから取り除いておく（別の端末で消された状態）。取り除かないと、読み直した一覧にサムネイルが出て、
    // そのあとの準備の実時間の待ちで、画像のキャッシュが端末の機能（path_provider）を探して落ちる
    final first = writeTestImage('first.png');
    useGalleryReturning([first]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);
    backend.trips.clear();
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 1);
    await letFramesRun(tester);
    expect(find.text('1枚を送信できませんでした（旅行が見つかりません）'), findsOneWidget);
    backend.trips.add(tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0));
    final retryReply = backend.holdNextReply(TripRoute.upload);

    await tester.tap(find.text('送り直す'));
    await waitUntilUploadsReceived(tester, backend, 2);
    backend.photosByTripId[hokkaidoTripId]!.clear();
    retryReply.complete();
    await letFramesRun(tester);
    expect(find.textContaining('送信できませんでした'), findsNothing);
    final second = writeTestImage('second.png', bytes: [...tinyPngBytes, 0]);
    useGalleryReturning([second]);
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, hokkaidoTripId);
    await letFramesRun(tester);

    expect(backend.uploadsReceived, 3);
    expect(backend.photosByTripId[hokkaidoTripId]!.length, 1);
    expect(find.textContaining('送信できませんでした'), findsNothing);
  });

  testWidgets('2枚が別の理由で失敗したときは、バナーに後に失敗した方の理由を添える（先に 413、後に 500 なら、500 の理由）', (tester) async {
    // 同時に送る2枚の応答を保留し、先に 413 の応答を返してから、500 の応答を返す。失敗の順は、応答を返した順で決まる
    final first = writeTestImage('first.png');
    final second = writeTestImage('second.png', bytes: [...tinyPngBytes, 0]);
    useGalleryReturning([first, second]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    backend.failNext(TripRoute.upload, status: 413, code: 'FILE_TOO_LARGE', message: 'ファイルサイズが大きすぎます');
    backend.failNext(TripRoute.upload, status: 500, code: 'INTERNAL_ERROR', message: '写真の保存に失敗しました');
    final tooLargeReply = backend.holdNextReply(TripRoute.upload);
    final serverErrorReply = backend.holdNextReply(TripRoute.upload);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 2);
    await letFramesRun(tester);
    tooLargeReply.complete();
    await letFramesRun(tester);

    serverErrorReply.complete();
    await letFramesRun(tester);

    expect(find.text('2枚を送信できませんでした（$serverErrorMessage）'), findsOneWidget);
  });

  testWidgets('2枚のうち1枚の送信がサーバの失敗（500）になると、送れた1枚だけを「1枚を送信しました」と知らせ、バナーに「1枚を送信できませんでした」と「送り直す」「閉じる」を出す。「閉じる」を押すと、バナー（「送り直す」も）が消え、失敗した写真は送られないまま', (tester) async {
    // 500 は自動の送り直しの対象ではない（通信の失敗・429・503 だけが対象）。どちらの1枚が失敗するかは問わず、届いた枚数で見る。
    // 「閉じる」は失敗した項目を列から消すだけで、端末の写真は消えない（選び直せば送れる）
    final first = writeTestImage('first.png');
    final second = writeTestImage('second.png', bytes: [...tinyPngBytes, 0]);
    useGalleryReturning([first, second]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    backend.failNext(TripRoute.upload, status: 500, code: 'INTERNAL_ERROR', message: '写真の保存に失敗しました');
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, hokkaidoTripId);
    await letFramesRun(tester);

    expect(backend.photosByTripId[hokkaidoTripId]!.length, 1);
    expect(find.text('1枚を送信できませんでした（$serverErrorMessage）'), findsOneWidget);
    expect(find.text('送り直す'), findsOneWidget);
    expect(find.text('閉じる'), findsOneWidget);
    expect(find.text('1枚を送信しました'), findsOneWidget);

    await tester.tap(find.text('閉じる'));
    await letFramesRun(tester);

    expect(find.textContaining('送信できませんでした'), findsNothing);
    expect(find.text('送り直す'), findsNothing);
    expect(find.text('閉じる'), findsNothing);
    expect(find.textContaining('送信中'), findsNothing);
    expect(backend.photosByTripId[hokkaidoTripId]!.length, 1);
  });

  testWidgets('2枚とも送信がサーバの失敗（500）になると、送れた分が無いので知らせは出さず、バナーに「2枚を送信できませんでした」を出し、「送り直す」で2枚とも届いてバナーが消え、「2枚を送信しました」と知らせる', (tester) async {
    // 送れた分が0枚の間は「N枚を送信しました」を出さない。送り直しで全部届いたときに初めて出る
    final first = writeTestImage('first.png');
    final second = writeTestImage('second.png', bytes: [...tinyPngBytes, 0]);
    useGalleryReturning([first, second]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    backend.failNext(TripRoute.upload, status: 500, code: 'INTERNAL_ERROR', message: '写真の保存に失敗しました');
    backend.failNext(TripRoute.upload, status: 500, code: 'INTERNAL_ERROR', message: '写真の保存に失敗しました');
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 2);
    await letFramesRun(tester);
    expect(find.text('2枚を送信できませんでした（$serverErrorMessage）'), findsOneWidget);
    expect(find.textContaining('を送信しました'), findsNothing);
    expect(backend.photosByTripId[hokkaidoTripId] ?? [], isEmpty);

    await tester.tap(find.text('送り直す'));
    await waitUntilUploaded(tester, backend, hokkaidoTripId, count: 2);
    await letFramesRun(tester);

    expect(find.text('送り直す'), findsNothing);
    expect(find.textContaining('送信できませんでした'), findsNothing);
    expect(find.text('2枚を送信しました'), findsOneWidget);
  });

  testWidgets('京都宛ての写真100枚を準備している間に北海道の詳細を開いても、「写真を準備中」は出ない（旅行一覧は全体を数えるので、戻ると「写真を準備中... k/100」が出る）', (tester) async {
    // 最初の送信の要求が届いた時点で一覧へ戻る。準備はまだ続いている（準備が終わるとバナーは消える）
    useGalleryReturning(writeTestImages(_manyPhotos));
    final backend = FakeTripBackend(trips: [
      tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0),
      tripJson(id: kyotoTripId, name: '京都', photoCount: 0),
    ]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('京都'));
    await letFramesRun(tester);
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 1);
    await tapBack(tester);
    await letFramesRun(tester);
    expect(preparingBanner(_manyPhotos), findsOneWidget);

    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);

    expect(find.byType(TripDetailScreen), findsOneWidget);
    expect(find.textContaining('写真を準備中'), findsNothing);
    // 否定が通るのは準備が終わったからではない（一覧に戻ると、準備はまだ続いている）
    await tapBack(tester);
    await letFramesRun(tester);
    expect(preparingBanner(_manyPhotos), findsOneWidget);
  });

  testWidgets('京都宛ての写真を送っている間に北海道の詳細を開いても、バナーは出ない（旅行詳細は、その旅行宛ての分だけを数える）', (tester) async {
    // 旅行一覧は全体を数えるので、京都宛ての送信中は一覧に「送信中 0/1」が出る。北海道の詳細には、北海道宛ての項目が無いので出ない
    final image = writeTestImage('kyoto.png');
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [
      tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0),
      tripJson(id: kyotoTripId, name: '京都', photoCount: 0),
    ]);
    final reply = backend.holdNextReply(TripRoute.upload);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('京都'));
    await letFramesRun(tester);
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, kyotoTripId);
    await letFramesRun(tester);
    await tapBack(tester);
    await letFramesRun(tester);
    expect(find.text('送信中 0/1'), findsOneWidget);

    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);

    expect(find.byType(TripDetailScreen), findsOneWidget);
    expect(find.textContaining('送信中'), findsNothing);
    reply.complete();
    await letFramesRun(tester);
  });

  testWidgets('この旅行宛ての送信が進んでいる間に「削除」を選ぶと、旅行の削除の確認の前に「送信中の写真があります。送信を止めて削除しますか？」と確かめ、「キャンセル」なら何もせず、送信は続く', (tester) async {
    // 写真が0枚の旅行を使う（サーバの写真のサムネイルを出さないので、実時間を進めても path_provider が要らない）。応答は保留して送信中にする
    final image = writeTestImage('hokkaido.png');
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    final reply = backend.holdNextReply(TripRoute.upload);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 1);
    await letFramesRun(tester);

    await openDeleteDialog(tester);

    expect(inDialog(find.text('送信中の写真があります。送信を止めて削除しますか？')), findsOneWidget);
    expect(inDialog(find.text('キャンセル')), findsOneWidget);
    expect(inDialog(find.text('削除')), findsOneWidget);
    // 旅行の削除のダイアログ（0枚なら「「北海道 2026秋」を削除しますか？」）はまだ出ていない
    expect(find.textContaining('を削除しますか？'), findsNothing);
    expect(find.text('旅行を削除'), findsNothing);

    await tapInDialog(tester, 'キャンセル');

    expect(find.byType(Dialog), findsNothing);
    expect(find.byType(TripDetailScreen), findsOneWidget);
    expect(backend.deletePhotosSent, isEmpty);
    // 送信は続いている。止めていないので、応答が返れば完了と数える
    reply.complete();
    await letFramesRun(tester);
    expect(find.text('1枚を送信しました'), findsOneWidget);
  });

  testWidgets('送信を止めて削除すると、この旅行宛ての残りの写真は送らず、失敗にも完了の知らせにも数えない（送信中だった分の結果も、送り終えていた分も知らせず、失敗していた写真の「送信できませんでした」も旅行の一覧に残さない）', (tester) async {
    // 先に1枚が 500 で失敗している（自動では送り直さない）。そのあと4枚を選び、1枚目は送れていて、2枚目と3枚目は同時に送信中（応答を保留）、4枚目は送信待ち。
    // 写真が0枚の旅行なので、実時間を進めても path_provider は要らない
    final failed = writeTestImage('failed.png');
    final sent = writeTestImage('sent.png', bytes: [...tinyPngBytes, 0]);
    final sendingA = writeTestImage('sending_a.png', bytes: [...tinyPngBytes, 0, 0]);
    final sendingB = writeTestImage('sending_b.png', bytes: [...tinyPngBytes, 0, 0, 0]);
    final waiting = writeTestImage('waiting.png', bytes: [...tinyPngBytes, 0, 0, 0, 0]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    backend.failNext(TripRoute.upload, status: 500, code: 'INTERNAL_ERROR', message: '写真の保存に失敗しました');
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    useGalleryReturning([failed]);
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 1);
    await letFramesRun(tester);
    expect(find.textContaining('1枚を送信できませんでした'), findsOneWidget);
    backend.holdNextReply(TripRoute.upload).complete();
    final sendingReplyA = backend.holdNextReply(TripRoute.upload);
    final sendingReplyB = backend.holdNextReply(TripRoute.upload);
    useGalleryReturning([sent, sendingA, sendingB, waiting]);
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 4);
    await letFramesRun(tester);
    await openDeleteDialog(tester);
    await tapInDialog(tester, '削除');
    await tapInDialog(tester, '削除');
    expect(find.byType(TripDetailScreen), findsNothing);
    expect(find.textContaining('旅行を削除しました'), findsOneWidget);

    sendingReplyA.complete();
    sendingReplyB.complete();
    await _waitRealTime(tester);
    await letFramesRun(tester);
    // スナックバーは順に出るので、「旅行を削除しました」が消えるまで進めてから、送信の知らせが出ていないことを見る
    await tester.pump(const Duration(seconds: 5));
    await letFramesRun(tester);

    expect(find.textContaining('旅行を削除しました'), findsNothing);
    expect(backend.uploadsReceived, 4);
    expect(find.textContaining('送信できませんでした'), findsNothing);
    expect(find.textContaining('枚を送信しました'), findsNothing);
  });

  testWidgets('送信を止めるかの確認で「削除」を選んでも、旅行の削除のダイアログで「キャンセル」したら、送信は続ける（残りの写真も送り、完了を知らせる）', (tester) async {
    // 3枚のうち2枚は同時に送信中（応答を保留）、3枚目は送信待ち。写真が0枚の旅行なので、実時間を進めても path_provider は要らない
    final first = writeTestImage('first.png');
    final second = writeTestImage('second.png', bytes: [...tinyPngBytes, 0]);
    final third = writeTestImage('third.png', bytes: [...tinyPngBytes, 0, 0]);
    useGalleryReturning([first, second, third]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    final firstReply = backend.holdNextReply(TripRoute.upload);
    final secondReply = backend.holdNextReply(TripRoute.upload);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 2);
    await letFramesRun(tester);
    await openDeleteDialog(tester);
    await tapInDialog(tester, '削除');
    expect(find.textContaining('を削除しますか？'), findsOneWidget);

    await tapInDialog(tester, 'キャンセル');

    expect(find.byType(Dialog), findsNothing);
    expect(find.byType(TripDetailScreen), findsOneWidget);
    expect(backend.deletePhotosSent, isEmpty);
    firstReply.complete();
    secondReply.complete();
    // 届いた写真は偽のサーバから取り除いておく（別の端末で消された状態）。取り除かないと、読み直した一覧にサムネイルが出て、
    // 実時間の待ちで画像のキャッシュが端末の機能（path_provider）を探して落ちる。画面は進めずに、実時間だけで3枚目の到着を待つ。
    // 取り除くと、見出しの枚数（photoCount）と実際の写真が食い違う状態になるが、これはサムネイルの画像を取りに行かせないための後始末で、この後は枚数を見ない
    await waitUntilUploaded(tester, backend, hokkaidoTripId, count: 3);
    backend.photosByTripId[hokkaidoTripId]!.clear();
    await letFramesRun(tester);
    expect(backend.uploadsReceived, 3);
    expect(find.text('3枚を送信しました'), findsOneWidget);
  });

  testWidgets('この旅行宛ての写真がサーバの失敗（500）で失敗しているだけなら、「削除」を選んでも送信を止める確認は出さず、旅行の削除のダイアログを出す', (tester) async {
    // 失敗した写真は自動では送り直されず、進行中の送信ではない（バナーの「送り直す」「閉じる」は利用者が選ぶ）
    final image = writeTestImage('hokkaido.png');
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    backend.failNext(TripRoute.upload, status: 500, code: 'INTERNAL_ERROR', message: '写真の保存に失敗しました');
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 1);
    await letFramesRun(tester);
    expect(find.text('1枚を送信できませんでした（$serverErrorMessage）'), findsOneWidget);

    await openDeleteDialog(tester);

    expect(find.text('送信中の写真があります。送信を止めて削除しますか？'), findsNothing);
    expect(find.textContaining('を削除しますか？'), findsOneWidget);
  });

  testWidgets('写真を準備中のあいだも、この旅行宛ての送信が進んでいるものとして、「削除」を選ぶと旅行の削除の前に「送信中の写真があります。送信を止めて削除しますか？」と確かめる。準備中に送信を止めて削除したら、準備が済んでもその写真は送らず、失敗にも完了の知らせにも数えず、残りの写真の準備をやめて旅行一覧に「写真を準備中」を出さない', (tester) async {
    // 準備を止める: 位置情報のある写真の Geocoder が固まる（5秒の時間切れまで準備中のまま。フェイクの時間で進める）。まだ1枚も送信の列に入っていない。
    // 3枚は中身（座標）を変えて、別の写真にする。準備中に削除を確定し、そのあとで1枚目の準備を済ませる（地名の時間切れ）
    final geocoding = useFakeGeocoding(hangs: true);
    useGalleryReturning([
      writeTestImage('nagano1.jpg', bytes: exifJpegBytes(latitude: [36, 39, 0], longitude: [138, 11, 0])),
      writeTestImage('nagano2.jpg', bytes: exifJpegBytes(latitude: [36, 40, 0], longitude: [138, 12, 0])),
      writeTestImage('nagano3.jpg', bytes: exifJpegBytes(latitude: [36, 41, 0], longitude: [138, 13, 0])),
    ]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    await tester.tap(find.text('写真を追加'));
    await waitUntilLookedUp(tester, geocoding, 1);
    await tester.pump();
    expect(backend.uploadsReceived, 0);

    await openDeleteDialog(tester);

    expect(inDialog(find.text('送信中の写真があります。送信を止めて削除しますか？')), findsOneWidget);
    expect(find.textContaining('を削除しますか？'), findsNothing);

    await tapInDialog(tester, '削除');
    await tapInDialog(tester, '削除');
    expect(find.byType(TripDetailScreen), findsNothing);
    expect(find.textContaining('旅行を削除しました'), findsOneWidget);

    await tester.pump(const Duration(seconds: 5));
    await _waitRealTime(tester);
    // スナックバーは順に出るので、「旅行を削除しました」が消えるまで進めてから、送信の知らせが出ていないことを見る
    await tester.pump(const Duration(seconds: 5));
    await letFramesRun(tester);

    expect(find.textContaining('旅行を削除しました'), findsNothing);
    expect(backend.uploadsReceived, 0);
    expect(find.textContaining('送信できませんでした'), findsNothing);
    expect(find.textContaining('枚を送信しました'), findsNothing);
    expect(preparingBanner(3), findsNothing);
    // 残りの2枚は準備しない（地名を引くのは、削除の前に準備を始めていた1枚目だけ）
    expect(geocoding.lookups, hasLength(1));
    // 後片付け: 残りの準備があっても時間切れのタイマーをテストの終わりに残さない
    await tester.pump(const Duration(seconds: 5));
    await _waitRealTime(tester);
    await tester.pump(const Duration(seconds: 5));
    await _waitRealTime(tester);
  });

  testWidgets('送り直しを待っている写真があるときに送信を止めて削除したら、待ちが過ぎても送り直さない', (tester) async {
    // 1回目が 503 で失敗して2秒の待ちに入る。待ちの間（2秒より手前）に削除を確定する。
    // openDeleteDialog や tapInDialog は画面を1.5秒ずつ進めて待ちを過ぎてしまうので、ここでは300ミリ秒ずつ進める
    final image = writeTestImage('hokkaido.png');
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    backend.failNext(TripRoute.upload);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    await tester.tap(find.text('写真を追加'));
    await _letUploadFail(tester, backend, 1);

    await tester.tap(find.byIcon(Icons.more_vert));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    await tester.tap(find.text('削除'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    await tester.tap(inDialog(find.text('削除')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    await tester.tap(inDialog(find.text('削除')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    await tester.pump(const Duration(seconds: 3));
    expect(find.byType(TripDetailScreen), findsNothing);
    await _waitRealTime(tester);

    expect(backend.uploadsReceived, 1);
  });

  testWidgets('旅行の削除が失敗したら、送信の取り消しを解き、取り消した送信中の写真は回転する印のマスに残さず送信中とも数えず、その後にこの旅行へ追加した写真は送る', (tester) async {
    // 1枚目は送信中（応答を保留）。削除の要求を 503 で失敗させて詳細に留まる。取り消した写真は戻らず、取り消しを解かれたあとで追加する2枚目は送られる。
    // 写真が0枚の旅行なので、実時間を進めても path_provider は要らない
    final first = writeTestImage('first.png');
    final second = writeTestImage('second.png', bytes: [...tinyPngBytes, 0]);
    useGalleryReturning([first]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    final firstReply = backend.holdNextReply(TripRoute.upload);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 1);
    await letFramesRun(tester);
    backend.failNext(TripRoute.delete);
    await openDeleteDialog(tester);
    await tapInDialog(tester, '削除');
    await tapInDialog(tester, '削除');
    expect(find.byType(TripDetailScreen), findsOneWidget);
    await tapInDialog(tester, 'キャンセル');

    expect(find.byType(CircularProgressIndicator), findsNothing);
    expect(find.text('送信中 0/1'), findsNothing);
    expect(find.text('まだ写真がありません'), findsOneWidget);
    // 取り消し済みなので、もう一度「削除」を選んでも送信の確認は出ず、旅行の削除のダイアログが出る
    await openDeleteDialog(tester);
    expect(find.text('送信中の写真があります。送信を止めて削除しますか？'), findsNothing);
    expect(find.textContaining('を削除しますか？'), findsOneWidget);
    await tapInDialog(tester, 'キャンセル');

    // 1枚目の結果は取り消し済みなので知らされない。届いた写真は偽のサーバから取り除いておく（サムネイルを出さない）
    backend.photosByTripId[hokkaidoTripId]!.clear();
    firstReply.complete();
    await _waitRealTime(tester);
    await letFramesRun(tester);
    // スナックバーは順に出るので、削除の失敗の知らせが消えるまで進める
    await tester.pump(const Duration(seconds: 5));
    await letFramesRun(tester);
    useGalleryReturning([second]);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploaded(tester, backend, hokkaidoTripId);
    // 見出しの枚数（photoCount）と実際の写真が食い違う状態になるが、サムネイルの画像を取りに行かせないための後始末で、この後は枚数を見ない
    backend.photosByTripId[hokkaidoTripId]!.clear();
    await letFramesRun(tester);

    expect(backend.uploadsReceived, 2);
    expect(find.text('1枚を送信しました'), findsOneWidget);
  });

  testWidgets('送り直しを待っていた写真を取り消した後に削除が失敗しても、その写真は送らない', (tester) async {
    // 1回目が 503 で失敗して2秒の待ちに入る。待ちの間（2秒より手前）に削除を確定し、削除の要求も 503 で失敗させる。
    // 失敗が待ちの明ける前に起きていることは、組み立ての途中で確かめる（openDeleteDialog や tapInDialog は1.5秒ずつ進めて待ちを過ぎてしまうので、300ミリ秒ずつ進める）
    final image = writeTestImage('hokkaido.png');
    useGalleryReturning([image]);
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    backend.failNext(TripRoute.upload);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    await tester.tap(find.text('写真を追加'));
    await _letUploadFail(tester, backend, 1);
    backend.failNext(TripRoute.delete);

    await tester.tap(find.byIcon(Icons.more_vert));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    await tester.tap(find.text('削除'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    await tester.tap(inDialog(find.text('削除')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    await tester.tap(inDialog(find.text('削除')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    // 削除の失敗が表示され、まだ送り直しの待ちが明けていない（2回目の要求は届いていない）
    expect(find.byType(TripDetailScreen), findsOneWidget);
    expect(find.text('サービスに一時的に接続できません。しばらく待ってから再試行してください。'), findsOneWidget);
    expect(backend.uploadsReceived, 1);
    await tester.tap(inDialog(find.text('キャンセル')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(backend.uploadsReceived, 1);

    await tester.pump(const Duration(seconds: 3));
    await _waitRealTime(tester);

    expect(backend.uploadsReceived, 1);
    expect(find.text('1枚を送信しました'), findsNothing);
  });
}
