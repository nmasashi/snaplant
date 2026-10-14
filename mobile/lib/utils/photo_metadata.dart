import 'package:exif/exif.dart';
import 'package:flutter/foundation.dart';

/// 写真の EXIF から読んだ撮影日時と位置（docs/travel-album/03_screen_design.md §4.7「準備」）
class PhotoMetadata {
  const PhotoMetadata({this.takenAt, this.latitude, this.longitude});

  /// 撮影日時 `YYYY-MM-DDTHH:mm:ss`（タイムゾーン無し。EXIF に記録されないため、撮った土地の時刻のまま）
  final String? takenAt;

  /// 緯度・経度（10進の度。南緯・西経は負）。どちらか一方だけになることは無い
  final double? latitude;
  final double? longitude;

  static const none = PhotoMetadata();
}

/// EXIF の `DateTimeOriginal`（`YYYY:MM:DD HH:mm:ss`）
final _exifDateTime =
    RegExp(r'^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$');

/// 画像のバイト列から撮影日時と位置を読む。読めない項目は null（読めなくても送信は止めない）
Future<PhotoMetadata> readPhotoMetadata(Uint8List bytes) async {
  final Map<String, IfdTag> tags;
  try {
    tags = await readExifFromBytes(bytes);
  } catch (e) {
    debugPrint('readPhotoMetadata: EXIF の読み取りエラー: $e');
    return PhotoMetadata.none;
  }
  final latitude = _toDegrees(
      tags['GPS GPSLatitude'], tags['GPS GPSLatitudeRef']?.printable);
  final longitude = _toDegrees(
      tags['GPS GPSLongitude'], tags['GPS GPSLongitudeRef']?.printable);
  // 片方だけでは位置にならない（サーバも片方だけを 400 にする）
  final hasLocation = latitude != null && longitude != null;
  return PhotoMetadata(
    takenAt: _toTakenAt(tags['EXIF DateTimeOriginal']?.printable),
    latitude: hasLocation ? latitude : null,
    longitude: hasLocation ? longitude : null,
  );
}

String? _toTakenAt(String? exifDateTime) {
  final match = exifDateTime == null
      ? null
      : _exifDateTime.firstMatch(exifDateTime.trim());
  if (match == null) return null;
  return '${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}';
}

/// 度・分・秒の3つの分数を10進の度に直す
double? _toDegrees(IfdTag? tag, String? ref) {
  if (tag == null) return null;
  final parts =
      tag.values.toList().whereType<Ratio>().map((r) => r.toDouble()).toList();
  if (parts.length != 3 || parts.any((p) => !p.isFinite)) return null;
  final degrees = parts[0] + parts[1] / 60 + parts[2] / 3600;
  return (ref == 'S' || ref == 'W') ? -degrees : degrees;
}
