import 'dart:async';

import 'package:flutter/widgets.dart' show Locale;
import 'package:flutter_test/flutter_test.dart';
import 'package:geocoding_platform_interface/geocoding_platform_interface.dart';
import 'package:plugin_platform_interface/plugin_platform_interface.dart';

// 端末の Geocoder（緯度・経度から地名を引く。geocoding）を使う画面のテストが共有する偽物。
// Geocoder は画面から見てプロセス外の依存（端末の機能。Google Play 開発者サービス）なので、プラットフォーム層を差し替える
// （gallery_test_helpers.dart のギャラリーと同じ考え方）

/// 偽の Geocoder が知っている場所。この座標の近く（緯度・経度とも 0.001 度以内）を引くと、[placemarks] を返す
typedef FakePlace = ({double latitude, double longitude, List<Placemark> placemarks});

/// 端末の Geocoder の偽物。知っている場所の近くを引くと対応する [Placemark] を返し、知らない場所には空のリストを返す
/// （本物の Geocoder が、引けなかった座標に返すのと同じ）。[failWith] を渡すと、引くたびにその例外を投げ、[hangs] なら応答を返さない。
/// 引いた座標は [lookups] に、引いた順に残す（同じ場所を何度も引かないことを確かめるときだけ使う）
class FakeGeocoding extends Geocoding with MockPlatformInterfaceMixin {
  FakeGeocoding({this.places = const [], this.failWith, this.hangs = false}) : super.implementation(const GeocodingCreationParams());

  final List<FakePlace> places;
  final Object? failWith;

  /// true なら、引いても応答を返さない（端末の Geocoder が固まった状況）
  final bool hangs;

  /// 引いた座標（緯度・経度。引いた順）
  final List<({double latitude, double longitude})> lookups = [];

  @override
  Future<List<Placemark>> placemarkFromCoordinates(double latitude, double longitude, {Locale? locale}) async {
    lookups.add((latitude: latitude, longitude: longitude));
    if (failWith != null) throw failWith!;
    if (hangs) return Completer<List<Placemark>>().future;
    for (final place in places) {
      if ((place.latitude - latitude).abs() < 0.001 && (place.longitude - longitude).abs() < 0.001) {
        return place.placemarks;
      }
    }
    return const [];
  }

  @override
  Future<bool> isPresent() async => true;
}

class _FakeGeocodingFactory extends GeocodingPlatformFactory with MockPlatformInterfaceMixin {
  _FakeGeocodingFactory(this.geocoding);

  final FakeGeocoding geocoding;

  @override
  Geocoding createGeocoding(GeocodingCreationParams params) => geocoding;
}

/// 何も登録されていない状態（Android 以外の環境。引こうとすると UnimplementedError）。
/// `GeocodingPlatformFactory.instance` には null を戻せないので、テストが終わったらこれに戻す
class _UnregisteredGeocodingFactory extends GeocodingPlatformFactory with MockPlatformInterfaceMixin {}

/// 端末の Geocoder を偽物に差し替えて返す（テストが終わったら戻す）。
/// [places] にある場所の近くを引くと、その [Placemark] を返す。[failWith] を渡すと、引くたびにその例外を投げる
FakeGeocoding useFakeGeocoding({List<FakePlace> places = const [], Object? failWith, bool hangs = false}) {
  final original = GeocodingPlatformFactory.instance;
  final fake = FakeGeocoding(places: places, failWith: failWith, hangs: hangs);
  GeocodingPlatformFactory.instance = _FakeGeocodingFactory(fake);
  addTearDown(() => GeocodingPlatformFactory.instance = original ?? _UnregisteredGeocodingFactory());
  return fake;
}

/// 偽の Geocoder が [count] 回引かれるまで、実時間で少しずつ待つ（最長 10 秒。フェイクの時間は進めない）。
/// 写真の準備（ファイルの読み込みなど）は別の isolate で実時間で進むので、引かれるまでを待つために使う。
/// 届かなければ、引かれた回数を添えて失敗にする
Future<void> waitUntilLookedUp(WidgetTester tester, FakeGeocoding geocoding, int count) async {
  for (var i = 0; i < 200 && geocoding.lookups.length < count; i++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
  }
  if (geocoding.lookups.length < count) {
    fail('Geocoder が $count 回引かれるはずが、${geocoding.lookups.length} 回しか引かれなかった（待った時間は 10 秒）');
  }
}
