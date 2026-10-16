import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:image_picker_platform_interface/image_picker_platform_interface.dart';
import 'package:plugin_platform_interface/plugin_platform_interface.dart';

// 端末のギャラリー（OS の画像選択）を使う画面のテストが共有する、ギャラリーの偽物と、テストの画像。
// ギャラリーは画面から見てプロセス外の依存なので、プラットフォーム層を差し替える（camera_screen_test.dart と同じ考え方）

/// 1x1 の PNG（本物の画像のバイト列）
const tinyPngBytes = <int>[
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
  0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0xF8, 0xFF, 0xFF, 0xFF,
  0x7F, 0x00, 0x09, 0xFB, 0x03, 0xFD, 0x2A, 0x86, 0xE3, 0x8A, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
  0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
];

/// [tinyPngBytes] の SHA-256（16進・小文字）。画像のバイト列から `photoId` が決まることを、テスト側の計算ではなくリテラルで確かめる
const tinyPngSha256 = 'd5a51b6aed15684ec8c123e30fe5703155359d6543b6d7b47cb5766ef44939de';

/// 複数選択のギャラリーの偽物。選ばれるたびに、渡されたファイルをまとめて返す（[failWith] を渡すと例外を投げる）
class FakeMultiGallery extends ImagePickerPlatform with MockPlatformInterfaceMixin {
  FakeMultiGallery(this.files, {this.failWith});

  /// 選ばれるファイル（選ばずに閉じる状況は、空のリスト）
  final List<File> files;

  /// 指定すると、選ぶたびにこの例外を投げる
  final Object? failWith;

  @override
  Future<List<XFile>> getMultiImageWithOptions({
    MultiImagePickerOptions options = const MultiImagePickerOptions(),
  }) async {
    if (failWith != null) throw failWith!;
    return [for (final file in files) XFile(file.path)];
  }
}

/// ギャラリーを [files] を返す偽物に差し替える（テストが終わったら戻す）
void useGalleryReturning(List<File> files, {Object? failWith}) {
  final original = ImagePickerPlatform.instance;
  ImagePickerPlatform.instance = FakeMultiGallery(files, failWith: failWith);
  addTearDown(() => ImagePickerPlatform.instance = original);
}

const _tempDirectoryPrefix = 'snaplant_gallery_test_';

/// 前の実行で消せずに残った一時ディレクトリを消したか（この実行の中で1回だけ消す）
bool _sweptStaleDirectories = false;

/// 前の実行で残った [_tempDirectoryPrefix] の一時ディレクトリを消す。消せないもの（まだ掴まれている）は飛ばす。
/// Windows では、画像を掴んだままのファイルがあると、テストの終了時に消せない。しかも Windows は一時ディレクトリを自動では消さないので、
/// 放っておくとテストを回すたびに溜まる。**1時間以上前のものだけ**を消す: テストは複数のファイルが並行して走るので、
/// 今まさに別のテストが使っているディレクトリを消さないため（1回の実行は1時間もかからない）
void _sweepStaleTempDirectories() {
  if (_sweptStaleDirectories) return;
  _sweptStaleDirectories = true;
  final threshold = DateTime.now().subtract(const Duration(hours: 1));
  try {
    for (final entry in Directory.systemTemp.listSync(followLinks: false)) {
      if (entry is! Directory || !entry.uri.pathSegments.where((s) => s.isNotEmpty).last.startsWith(_tempDirectoryPrefix)) {
        continue;
      }
      try {
        if (entry.statSync().modified.isBefore(threshold)) entry.deleteSync(recursive: true);
      } on FileSystemException {
        // まだ掴まれている。次の実行で消す
      }
    }
  } on FileSystemException {
    // 一時ディレクトリを一覧できない。掃除は諦める（テストには影響しない）
  }
}

/// 画像を置く一時ディレクトリを作る（テスト終了時に削除する。消せなければ、次の実行の最初に [_sweepStaleTempDirectories] が消す）
Directory _createTempDirectory() {
  _sweepStaleTempDirectories();
  final dir = Directory.systemTemp.createTempSync(_tempDirectoryPrefix);
  addTearDown(() {
    try {
      dir.deleteSync(recursive: true);
    } on FileSystemException {
      // Windows では画像が掴んだままのファイルを消せない
    }
  });
  return dir;
}

/// 一時ディレクトリに画像ファイルを書く（テスト終了時に削除する）。中身は [bytes]（既定は [tinyPngBytes]）
File writeTestImage(String name, {List<int> bytes = tinyPngBytes}) {
  final dir = _createTempDirectory();
  return File('${dir.path}/$name')..writeAsBytesSync(bytes);
}

/// 一時ディレクトリに、中身が全部違う画像ファイルを [count] 枚書く（テスト終了時に削除する）。
/// 準備（読み込みとハッシュ）に時間をかける代わりに、枚数を増やして準備を長引かせるために使う。
/// 準備は1枚ずつ別の isolate で行うので、大きなファイル1枚と違い、メモリを食わず、準備の終わりが枚数に比例して遅れる。
/// 中身は [tinyPngBytes] に、通し番号の2バイトを足したもの（写真の id は画像のバイト列の SHA-256 なので、全部違う写真になる）
List<File> writeTestImages(int count) {
  final dir = _createTempDirectory();
  return [
    for (var i = 0; i < count; i++)
      File('${dir.path}/photo_$i.png')..writeAsBytesSync([...tinyPngBytes, i >> 8, i & 0xFF]),
  ];
}

/// EXIF 付きの JPEG のバイト列（SOI、EXIF を入れた APP1、EOI だけの、画像の本体を持たない最小の JPEG）。
/// EXIF は次の値だけを持つ。小さな固定のバイト列を手で組み立てているので、EXIF を読む側のテストに使う（画像として表示はできない）。
/// - `DateTimeOriginal`: [dateTimeOriginal]（既定は `2026:10:05 10:20:30`。`YYYY:MM:DD HH:mm:ss` の19文字。実在しない日時も渡せる）
/// - GPS: 緯度は [latitude]（度・分・秒。既定は 43度30分0秒で10進の 43.5）、経度は [longitude]（既定は 141度15分0秒で10進の 141.25）。範囲外の値も渡せる。向きは [latitudeRef]（既定は北 `N`、南なら `S`）と [longitudeRef]（既定は東 `E`、西なら `W`）
///
/// 作り方: TIFF（リトルエンディアン）の IFD0 が Exif IFD（オフセット 38）と GPS IFD（オフセット 56）を指し、
/// 値の本体は 110（撮影日時の20バイト）・130（緯度の分数3つ）・154（経度の分数3つ）に置く。全長は 178 バイト
List<int> exifJpegBytes({
  String dateTimeOriginal = '2026:10:05 10:20:30',
  String latitudeRef = 'N',
  String longitudeRef = 'E',
  List<int> latitude = const [43, 30, 0],
  List<int> longitude = const [141, 15, 0],
}) {
  final tiff = ByteData(178);
  var at = 0;
  void u16(int v) {
    tiff.setUint16(at, v, Endian.little);
    at += 2;
  }

  void u32(int v) {
    tiff.setUint32(at, v, Endian.little);
    at += 4;
  }

  void entry(int tag, int type, int count, int value) {
    u16(tag);
    u16(type);
    u32(count);
    u32(value);
  }

  // 値が4バイトに収まる ASCII（'N\0' など）は、オフセットの場所に値そのものを置く
  int ascii2(String letter) => letter.codeUnitAt(0);

  // ヘッダ（II、42、IFD0 のオフセット 8）
  tiff.setUint8(0, 0x49);
  tiff.setUint8(1, 0x49);
  at = 2;
  u16(42);
  u32(8);
  // IFD0（オフセット 8）: Exif IFD へのポインタ、GPS IFD へのポインタ
  u16(2);
  entry(0x8769, 4, 1, 38);
  entry(0x8825, 4, 1, 56);
  u32(0);
  // Exif IFD（オフセット 38）: DateTimeOriginal（ASCII 20バイト。値は 110）
  u16(1);
  entry(0x9003, 2, 20, 110);
  u32(0);
  // GPS IFD（オフセット 56）: 緯度の向き・緯度・経度の向き・経度
  u16(4);
  entry(0x0001, 2, 2, ascii2(latitudeRef));
  entry(0x0002, 5, 3, 130);
  entry(0x0003, 2, 2, ascii2(longitudeRef));
  entry(0x0004, 5, 3, 154);
  u32(0);
  // 値の本体
  final dateTime = ascii.encode(dateTimeOriginal);
  for (var i = 0; i < dateTime.length; i++) {
    tiff.setUint8(110 + i, dateTime[i]);
  }
  at = 130;
  for (final degreesMinutesSeconds in [...latitude, ...longitude]) {
    u32(degreesMinutesSeconds);
    u32(1);
  }

  final app1Length = 2 + 6 + tiff.lengthInBytes;
  return [
    0xFF, 0xD8, // SOI
    0xFF, 0xE1, app1Length >> 8, app1Length & 0xFF, // APP1
    ...ascii.encode('Exif'), 0, 0,
    ...tiff.buffer.asUint8List(),
    0xFF, 0xD9, // EOI
  ];
}
