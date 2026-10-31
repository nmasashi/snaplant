
import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart' show listEquals;
import 'package:flutter_image_compress/flutter_image_compress.dart' show CompressFormat;
import 'package:flutter_test/flutter_test.dart';
import 'package:geocoding_platform_interface/geocoding_platform_interface.dart' show Placemark;

import '../helpers/app_test_helpers.dart';
import '../helpers/gallery_test_helpers.dart';
import '../helpers/geocoding_test_helpers.dart';
import '../helpers/image_compress_test_helpers.dart';
import '../helpers/trip_test_helpers.dart';
import '../helpers/upload_test_helpers.dart';

// 選んだ写真の送信の準備（docs/03_screen_design.md §4.7.2）を、利用者から見た振る舞いで確かめる。
// EXIF の撮影日時と位置、地名（端末の Geocoder）、サムネイル、準備が済んだ順に送り始めることと「写真を準備中」。
// 送信の状態はアプリの根が持つので、アプリ全体を開いて旅行一覧から旅行詳細へ進む。旅行の API は偽のサーバ（helpers の FakeTripBackend）、
// ギャラリー・Geocoder・画像の圧縮は端末の機能なので偽物に差し替える。共有の補助は helpers/upload_test_helpers.dart

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

void main() {
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
    await waitRealTime(tester);
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

  testWidgets('100枚を選ぶと、準備が済んだ写真から送り始め、準備が終わるまでの間は、旅行詳細の上部に「写真を準備中... k/100」を出す。写真を受け取ったら、準備が続いている間も、ボタンは「写真を追加」に戻って押せる', (tester) async {
    // 準備は1枚ずつ別の isolate で進む。100枚の準備は、最初の送信の要求が偽のサーバに届いたあともしばらく続く（準備が終わるとバナーは消える）。
    // k は準備の進み具合で変わるので、分母と形式で見る。1枚目の応答は保留して、1枚目の送信が終わったことによる表示の変化を混ぜない。
    // ボタンを押せなくするのは写真を受け取るまで。受け取った後の準備（100枚で数秒かかる）の間は、次の写真を選べる（送信が終わったことでボタンが戻るのではない）
    final gallery = useGalleryReturning(writeTestImages(manyPhotos));
    final backend = FakeTripBackend(trips: [tripJson(id: hokkaidoTripId, name: '北海道 2026秋', photoCount: 0)]);
    final firstReply = backend.holdNextReply(TripRoute.upload);
    await openTripsTab(tester, backend);
    await tester.tap(find.text('北海道 2026秋'));
    await letFramesRun(tester);
    expect(find.text('写真を追加'), findsOneWidget);

    await tester.tap(find.text('写真を追加'));
    await waitUntilUploadsReceived(tester, backend, 1);
    await tester.pump();

    expect(preparingBanner(manyPhotos), findsOneWidget);
    // 最初の1枚は準備が済んでいて、全部は済んでいない（k は準備の進み具合で変わるので、範囲で見る）
    expect(preparedCountInBanner(manyPhotos), inInclusiveRange(1, manyPhotos - 1));

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

}
