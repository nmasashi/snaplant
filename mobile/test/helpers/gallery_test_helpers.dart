import 'dart:io';

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

/// 一時ディレクトリに画像ファイルを書く（テスト終了時に削除する）。中身は [bytes]（既定は [tinyPngBytes]）
File writeTestImage(String name, {List<int> bytes = tinyPngBytes}) {
  final dir = Directory.systemTemp.createTempSync('snaplant_gallery_test_');
  addTearDown(() {
    try {
      dir.deleteSync(recursive: true);
    } on FileSystemException {
      // Windows では画像が掴んだままのファイルを消せない。一時ディレクトリなので OS に任せる
    }
  });
  return File('${dir.path}/$name')..writeAsBytesSync(bytes);
}
