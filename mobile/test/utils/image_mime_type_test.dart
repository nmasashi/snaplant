import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:snaplant_mobile/utils/image_mime_type.dart';

/// 先頭のシグネチャの後ろに本文らしき 0 を足して、実際のファイルに近い長さにする
Uint8List _bytes(List<int> header) => Uint8List.fromList([...header, ...List.filled(16, 0)]);

void main() {
  group('画像の種類をファイルの先頭バイトから判定する', () {
    test('PNGのシグネチャはimage/pngになる', () {
      final png = _bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

      expect(detectImageMimeType(png), 'image/png');
    });

    test('JPEGのシグネチャはimage/jpegになる', () {
      final jpeg = _bytes([0xFF, 0xD8, 0xFF, 0xE0]);

      expect(detectImageMimeType(jpeg), 'image/jpeg');
    });

    test('GIFのシグネチャはimage/gifになる', () {
      final gif = _bytes('GIF89a'.codeUnits);

      expect(detectImageMimeType(gif), 'image/gif');
    });

    test('古い形式のGIF87aもimage/gifになる', () {
      final gif87 = _bytes('GIF87a'.codeUnits);

      expect(detectImageMimeType(gif87), 'image/gif');
    });

    test('WebPのシグネチャはimage/webpになる', () {
      // RIFF + 4バイトのサイズ + WEBP
      final webp = _bytes([...'RIFF'.codeUnits, 0x24, 0x00, 0x00, 0x00, ...'WEBP'.codeUnits]);

      expect(detectImageMimeType(webp), 'image/webp');
    });

    test('WebP以外のRIFF形式（WAVなど）はWebPと判定しない', () {
      final wav = _bytes([...'RIFF'.codeUnits, 0x24, 0x00, 0x00, 0x00, ...'WAVE'.codeUnits]);

      expect(detectImageMimeType(wav), 'image/jpeg');
    });

    test('判定できない形式は従来の既定値image/jpegになる', () {
      final unknown = _bytes([0x00, 0x01, 0x02, 0x03]);

      expect(detectImageMimeType(unknown), 'image/jpeg');
    });

    test('シグネチャに満たない短いデータは既定値image/jpegになる', () {
      // PNG の先頭2バイトだけ。途中で切れたデータを PNG と誤判定しない
      final truncated = Uint8List.fromList([0x89, 0x50]);

      expect(detectImageMimeType(truncated), 'image/jpeg');
    });
  });
}
