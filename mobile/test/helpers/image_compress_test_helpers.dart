import 'dart:convert';
import 'dart:io';
import 'dart:math' show max, min;
import 'dart:typed_data';

import 'package:flutter/services.dart' show MethodChannel;
import 'package:flutter_image_compress/flutter_image_compress.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:plugin_platform_interface/plugin_platform_interface.dart';

import 'gallery_test_helpers.dart';

// 端末の画像の圧縮（flutter_image_compress。サムネイルを作る）を使う画面のテストが共有する偽物と、寸法を指定した画像。
// 画像の圧縮は画面から見てプロセス外の依存（端末のネイティブの機能）なので、プラットフォーム層を差し替える
// （gallery_test_helpers.dart のギャラリーと同じ考え方）

/// 偽物が作った画像1枚。何を渡されて何を作ったかを、テストが結果として読む
class CompressedImage {
  const CompressedImage({
    required this.width,
    required this.height,
    required this.quality,
    required this.format,
    required this.bytes,
  });

  /// 作った画像の幅・高さ（ピクセル）。元の画像を、渡された最小の幅・高さでネイティブの実装と同じ規則で縮めたもの
  final int width;
  final int height;

  /// 渡された画質（0〜100）
  final int quality;

  /// 渡された出力の形式
  final CompressFormat format;

  /// 返したバイト列（JPEG の印 `FF D8 FF` で始まる。中身は幅・高さ・画質を読める文字列で、本物の画像ではない）
  final Uint8List bytes;
}

/// 端末の画像の圧縮の偽物。渡された元の画像と引数から、作る画像の寸法を決めて返す。
///
/// - 元の画像の寸法は PNG のヘッダ（IHDR）から読む。PNG 以外は読めないので、[pngBytesOfSize] で作った画像を使う
/// - 縮め方は Android のネイティブの実装（`calcScale`）と同じ: 倍率 = `max(1, min(幅 / minWidth, 高さ / minHeight))`、
///   作る寸法 = 元の寸法 / 倍率（小数点以下は切り捨て）。つまり**短い辺**が最小の値になるまで縮める（長辺ではない）。
///   `minWidth` と `minHeight` を同じ値にして渡すと、短辺がその値になり、長辺はそれより長くなる。
///   iOS の実装は別の規則だが、このアプリは Android 向け（CLAUDE.md）。向きの補正（EXIF の回転）と `keepExif` は再現しない
/// - 返すバイト列は [CompressedImage.bytes]。ファイルへ書く API（compressAndGetFile）なら、そのバイト列を書く
/// - 作った画像は [results] に、呼ばれた順に残す
class FakeImageCompress extends FlutterImageCompressPlatform with MockPlatformInterfaceMixin {
  FakeImageCompress({this.failWith});

  /// 指定すると、圧縮のたびにこの例外を投げる（画像を読めない・端末の機能が使えない状況）。何も作らないので [results] には残らない
  final Object? failWith;

  /// 作った画像（呼ばれた順）
  final List<CompressedImage> results = [];

  @override
  FlutterImageCompressValidator get validator =>
      FlutterImageCompressValidator(const MethodChannel('fake_image_compress'))..ignoreCheckSupportPlatform = true;

  @override
  Future<Uint8List> compressWithList(
    Uint8List image, {
    int minWidth = 1920,
    int minHeight = 1080,
    int quality = 95,
    int rotate = 0,
    int inSampleSize = 1,
    bool autoCorrectionAngle = true,
    CompressFormat format = CompressFormat.jpeg,
    bool keepExif = false,
  }) async {
    return _compress(image, minWidth, minHeight, quality, format).bytes;
  }

  @override
  Future<Uint8List?> compressWithFile(
    String path, {
    int minWidth = 1920,
    int minHeight = 1080,
    int inSampleSize = 1,
    int quality = 95,
    int rotate = 0,
    bool autoCorrectionAngle = true,
    CompressFormat format = CompressFormat.jpeg,
    bool keepExif = false,
    int numberOfRetries = 5,
  }) async {
    // 同期で読む（テストの偽の時間の中でも、ファイルの読み込みの完了を待たずに済む）
    return _compress(File(path).readAsBytesSync(), minWidth, minHeight, quality, format).bytes;
  }

  @override
  Future<XFile?> compressAndGetFile(
    String path,
    String targetPath, {
    int minWidth = 1920,
    int minHeight = 1080,
    int inSampleSize = 1,
    int quality = 95,
    int rotate = 0,
    bool autoCorrectionAngle = true,
    CompressFormat format = CompressFormat.jpeg,
    bool keepExif = false,
    int numberOfRetries = 5,
  }) async {
    final compressed = _compress(File(path).readAsBytesSync(), minWidth, minHeight, quality, format);
    File(targetPath).writeAsBytesSync(compressed.bytes);
    return XFile(targetPath);
  }

  @override
  Future<Uint8List?> compressAssetImage(
    String assetName, {
    int minWidth = 1920,
    int minHeight = 1080,
    int quality = 95,
    int rotate = 0,
    bool autoCorrectionAngle = true,
    CompressFormat format = CompressFormat.jpeg,
    bool keepExif = false,
  }) {
    throw UnsupportedError('アセットの画像を圧縮するテストは書いていない');
  }

  @override
  Future<void> showNativeLog(bool value) async {}

  @override
  void ignoreCheckSupportPlatform(bool bool) {}

  CompressedImage _compress(Uint8List source, int minWidth, int minHeight, int quality, CompressFormat format) {
    if (failWith != null) throw failWith!;
    final data = ByteData.sublistView(source);
    final isPng = source.length >= 24 && source[0] == 0x89 && source[1] == 0x50 && source[2] == 0x4E && source[3] == 0x47;
    if (!isPng) throw UnsupportedError('偽の画像の圧縮が寸法を読めるのは PNG だけ。pngBytesOfSize で作った画像を使う');
    final width = data.getUint32(16);
    final height = data.getUint32(20);
    final scale = max(1.0, min(width / minWidth, height / minHeight));
    final destWidth = (width / scale).toInt();
    final destHeight = (height / scale).toInt();
    final compressed = CompressedImage(
      width: destWidth,
      height: destHeight,
      quality: quality,
      format: format,
      bytes: Uint8List.fromList([
        0xFF, 0xD8, 0xFF, 0xE0, // SOI と APP0（JPEG の印）
        ...utf8.encode('fake thumbnail ${destWidth}x$destHeight quality=$quality'),
        0xFF, 0xD9, // EOI
      ]),
    );
    results.add(compressed);
    return compressed;
  }
}

/// 画像の圧縮を偽物に差し替えて返す（テストが終わったら戻す）。[failWith] を渡すと、圧縮のたびにその例外を投げる
FakeImageCompress useFakeImageCompress({Object? failWith}) {
  final original = FlutterImageCompressPlatform.instance;
  final fake = FakeImageCompress(failWith: failWith);
  FlutterImageCompressPlatform.instance = fake;
  addTearDown(() => FlutterImageCompressPlatform.instance = original);
  return fake;
}

/// 寸法が [width] × [height] の PNG のバイト列。[tinyPngBytes] のヘッダの寸法だけを書き換えたもの。
/// 画像として表示はできない（本体は 1x1 のまま）。寸法を読む偽の画像の圧縮に、大きな写真を渡すために使う。
/// 寸法ごとに中身が違うので、写真の id（SHA-256）も寸法ごとに違う
List<int> pngBytesOfSize(int width, int height) {
  final bytes = Uint8List.fromList(tinyPngBytes);
  ByteData.sublistView(bytes)
    ..setUint32(16, width)
    ..setUint32(20, height);
  return bytes;
}
