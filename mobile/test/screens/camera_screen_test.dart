import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:image_picker_platform_interface/image_picker_platform_interface.dart';
import 'package:plugin_platform_interface/plugin_platform_interface.dart';
import 'package:snaplant_mobile/screens/camera_screen.dart';
import 'package:snaplant_mobile/services/api_service.dart';

// ギャラリー（OS の画像選択）とサーバ（Azure Functions）は、画面から見て
// プロセス外の依存なので差し替える。
// ギャラリーは ImagePickerPlatform の偽物が、あらかじめ渡した画像ファイルを順に返す。
// サーバは ApiService の HTTP 層を MockClient で差し替え、
// アップロードへの応答はテストが保留・解放を制御する。

const _jsonHeaders = {'content-type': 'application/json'};

/// 1x1 の PNG（Image.file が復号できる本物の画像）
const _tinyPng = <int>[
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
  0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0xF8, 0xFF, 0xFF, 0x3F,
  0x00, 0x05, 0xFE, 0x02, 0xFE, 0xDC, 0xCC, 0x59, 0xE7, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E,
  0x44, 0xAE, 0x42, 0x60, 0x82,
];

/// ギャラリーの偽物。選ばれるたびに、渡されたファイルを先頭から順に返す
class _FakeGallery extends ImagePickerPlatform with MockPlatformInterfaceMixin {
  _FakeGallery(this._files);

  final List<File> _files;
  int _next = 0;

  @override
  Future<XFile?> getImageFromSource({
    required ImageSource source,
    ImagePickerOptions options = const ImagePickerOptions(),
  }) async {
    return XFile(_files[_next++].path);
  }
}

/// 一時ディレクトリに画像ファイルを書く（テスト終了時に削除する）
File _writeImage(String name) {
  final dir = Directory.systemTemp.createTempSync('snaplant_camera_test_');
  addTearDown(() {
    try {
      dir.deleteSync(recursive: true);
    } on FileSystemException {
      // Windows では Image.file が掴んだままのファイルを消せない。一時ディレクトリなので OS に任せる
    }
  });
  return File('${dir.path}/$name')..writeAsBytesSync(_tinyPng);
}

/// アップロードへの応答を [uploadResponse] が完了するまで保留するサーバ
ApiService _serviceWhereUploadWaitsFor(Completer<http.Response> uploadResponse) {
  return ApiService(
    baseUrl: 'https://api.example.test',
    client: MockClient((request) async {
      if (request.method == 'POST' && request.url.path == '/api/images/upload') {
        return uploadResponse.future;
      }
      return http.Response('', 404);
    }),
  );
}

http.Response _uploadSucceeded() {
  return http.Response(
    json.encode({
      'success': true,
      'data': {
        'imagePath': 'https://stsnaplant.blob.core.windows.net/images/a.png',
        'fileName': 'plant_image.jpg',
        'contentType': 'image/png',
        'fileSize': _tinyPng.length,
        'identificationResult': {
          'isPlant': true,
          'confidence': 95.0,
          'candidates': [
            {'name': '桜', 'characteristics': '春に咲く', 'confidence': 95.0},
          ],
        },
      },
    }),
    200,
    headers: _jsonHeaders,
  );
}

/// 画像選択画面を開き、ギャラリーから1枚選ぶところまで進める
Future<void> _openCameraScreenWithImageSelected(
  WidgetTester tester, {
  required ApiService apiService,
  required List<File> galleryFiles,
}) async {
  // 画面が想定している実機の解像度に合わせる
  tester.view.physicalSize = const Size(1440, 2960);
  tester.view.devicePixelRatio = 3.5;
  addTearDown(tester.view.reset);

  final originalPicker = ImagePickerPlatform.instance;
  ImagePickerPlatform.instance = _FakeGallery(galleryFiles);
  addTearDown(() => ImagePickerPlatform.instance = originalPicker);

  await tester.pumpWidget(MaterialApp(home: CameraScreen(apiService: apiService)));
  await tester.tap(find.text('ギャラリーから選択'));
  await _letRealIoAndFramesRun(tester);
}

/// 実際のファイル I/O は fake async の外で進める必要がある。
/// アニメーションやスピナーで pumpAndSettle が終わらないため、pump で進める
Future<void> _letRealIoAndFramesRun(WidgetTester tester) async {
  await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 200)));
  await tester.pump(const Duration(milliseconds: 500));
}

/// ボタン本体（OutlinedButton.icon などの実体はサブクラス）を文言から探す
Finder _buttonLabeled(String label) {
  return find.ancestor(of: find.text(label), matching: find.byWidgetPredicate((w) => w is ButtonStyleButton));
}

bool _isEnabled(WidgetTester tester, Finder button) {
  return tester.widget<ButtonStyleButton>(button).enabled;
}

void main() {
  testWidgets('アップロードと識別の処理中は「別の画像を選択」を押せない', (tester) async {
    final uploadResponse = Completer<http.Response>();
    await _openCameraScreenWithImageSelected(
      tester,
      apiService: _serviceWhereUploadWaitsFor(uploadResponse),
      galleryFiles: [_writeImage('first.png')],
    );

    await tester.tap(find.text('植物を識別する'));
    await _letRealIoAndFramesRun(tester);

    expect(find.text('アップロード中...'), findsOneWidget);
    expect(_isEnabled(tester, _buttonLabeled('別の画像を選択')), isFalse);

    // 後片付け: 保留を解いて処理を完了させる
    uploadResponse.complete(_uploadSucceeded());
    await _letRealIoAndFramesRun(tester);
  });
}
