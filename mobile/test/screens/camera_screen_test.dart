import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
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
  0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0xF8, 0xFF, 0xFF, 0xFF,
  0x7F, 0x00, 0x09, 0xFB, 0x03, 0xFD, 0x2A, 0x86, 0xE3, 0x8A, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
  0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
];

/// ギャラリーの偽物。選ばれるたびに、渡されたファイルを先頭から順に返す
class _FakeGallery extends ImagePickerPlatform with MockPlatformInterfaceMixin {
  _FakeGallery(this._files, {this.failWith});

  final List<File> _files;

  /// 指定すると、取り込みのたびにこの例外を投げる
  final Object? failWith;
  int _next = 0;

  @override
  Future<XFile?> getImageFromSource({
    required ImageSource source,
    ImagePickerOptions options = const ImagePickerOptions(),
  }) async {
    if (failWith != null) throw failWith!;
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

/// アップロードへの応答を [uploadResponse] が完了するまで保留するサーバ。
/// アップロードが届いた時点で [received] を完了させる（テストが応答待ちを確かめるため）
ApiService _serviceWhereUploadWaitsFor(
  Completer<http.Response> uploadResponse, {
  Completer<void>? received,
}) {
  return ApiService(
    baseUrl: 'https://api.example.test',
    client: MockClient((request) async {
      if (request.method == 'POST' && request.url.path == '/api/images/upload') {
        if (received != null && !received.isCompleted) received.complete();
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

/// 画像選択画面を、一覧画面の上に積んだ状態で開く。
/// ギャラリーは [galleryFiles] を順に返す（[galleryFailsWith] を渡すと取り込みで例外を投げる）
Future<void> _openCameraScreen(
  WidgetTester tester, {
  required ApiService apiService,
  required List<File> galleryFiles,
  Object? galleryFailsWith,
}) async {
  // 画面が想定している実機の解像度に合わせる
  tester.view.physicalSize = const Size(1440, 2960);
  tester.view.devicePixelRatio = 3.5;
  addTearDown(tester.view.reset);

  final originalPicker = ImagePickerPlatform.instance;
  ImagePickerPlatform.instance = _FakeGallery(galleryFiles, failWith: galleryFailsWith);
  addTearDown(() => ImagePickerPlatform.instance = originalPicker);

  // 戻る操作を試せるよう、一覧画面の上に積む
  await tester.pumpWidget(MaterialApp(
    home: Builder(
      builder: (context) => Scaffold(
        body: TextButton(
          onPressed: () => Navigator.push(
            context,
            MaterialPageRoute(builder: (_) => CameraScreen(apiService: apiService)),
          ),
          child: const Text('撮影画面を開く'),
        ),
      ),
    ),
  ));
  await tester.tap(find.text('撮影画面を開く'));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 500));
}

/// 画像選択画面を開き、ギャラリーから1枚選ぶところまで進める
Future<void> _openCameraScreenWithImageSelected(
  WidgetTester tester, {
  required ApiService apiService,
  required List<File> galleryFiles,
}) async {
  await _openCameraScreen(tester, apiService: apiService, galleryFiles: galleryFiles);
  await tester.tap(find.text('ギャラリーから選択'));
  await _runRealIoUntil(tester, () => find.text('別の画像を選択').evaluate().isNotEmpty, reason: '選んだ画像が表示されない');
}

/// 実際のファイル I/O は fake async の外で進める必要がある。
/// 本番コードが await する I/O の段数に依存しないよう、回数を決め打ちせず
/// [done] が真になるまで「実 I/O を少し待つ → pump」を繰り返す。
/// 進み切らなければ [reason] を添えて落とす（黙って空振りさせない）。
/// アニメーションやスピナーで pumpAndSettle が終わらないため、pump で進める
Future<void> _runRealIoUntil(
  WidgetTester tester,
  bool Function() done, {
  required String reason,
  int maxRounds = 100,
}) async {
  for (var i = 0; i < maxRounds; i++) {
    if (done()) return;
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
    await tester.pump(const Duration(milliseconds: 20));
  }
  if (!done()) fail('$maxRounds 回待っても条件を満たさなかった: $reason');
}

http.Response _uploadFailedWithAiServiceError() {
  return http.Response(
    json.encode({
      'success': false,
      'error': {
        'code': 'AI_SERVICE_ERROR',
        'message': '植物識別サービスでエラーが発生しました',
      },
    }),
    502,
    headers: _jsonHeaders,
  );
}

/// 画像を選んで識別を始め、処理中に画面を戻ってから、サーバが [response] を返したところまで進める
Future<void> _leaveWhileUploadingThenRespond(WidgetTester tester, http.Response response) async {
  final uploadResponse = Completer<http.Response>();
  final received = Completer<void>();
  await _openCameraScreenWithImageSelected(
    tester,
    apiService: _serviceWhereUploadWaitsFor(uploadResponse, received: received),
    galleryFiles: [_writeImage('first.png')],
  );
  await tester.tap(find.text('植物を識別する'));
  await _runRealIoUntil(tester, () => received.isCompleted, reason: 'アップロードがサーバに届かない');
  await tester.tap(find.byIcon(Icons.arrow_back));
  // 戻る操作は1フレーム目で始まり、次のフレームで進む
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 500));

  // 届いた後は実 I/O が無いので、マイクロタスクを流すだけで応答の処理まで進む
  uploadResponse.complete(response);
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
    final received = Completer<void>();
    await _openCameraScreenWithImageSelected(
      tester,
      apiService: _serviceWhereUploadWaitsFor(uploadResponse, received: received),
      galleryFiles: [_writeImage('first.png')],
    );

    await tester.tap(find.text('植物を識別する'));
    await _runRealIoUntil(tester, () => received.isCompleted, reason: 'アップロードがサーバに届かない');

    expect(find.text('アップロード中...'), findsOneWidget);
    expect(_isEnabled(tester, _buttonLabeled('別の画像を選択')), isFalse);

    // 後片付け: 保留を解いて処理を完了させる
    uploadResponse.complete(_uploadSucceeded());
    await _runRealIoUntil(tester, () => find.text('識別結果').evaluate().isNotEmpty, reason: '識別結果画面に移らない');
  });

  testWidgets('処理中に画面を戻ると、処理が終わっても例外にならず識別結果画面にも移らない', (tester) async {
    await _leaveWhileUploadingThenRespond(tester, _uploadSucceeded());

    expect(tester.takeException(), isNull);
    expect(find.text('識別結果'), findsNothing);
  });

  testWidgets('処理中に画面を戻ったあとでアップロードが失敗しても例外にならない', (tester) async {
    await _leaveWhileUploadingThenRespond(tester, _uploadFailedWithAiServiceError());

    expect(tester.takeException(), isNull);
  });

  testWidgets('ギャラリーから画像を取り込めなかったときは、例外の文字列ではなく決まった文言を表示する', (tester) async {
    await _openCameraScreen(
      tester,
      apiService: _serviceWhereUploadWaitsFor(Completer<http.Response>()),
      galleryFiles: [],
      galleryFailsWith: PlatformException(code: 'no_valid_image_uri', message: 'Cannot find the selected image.'),
    );

    await tester.tap(find.text('ギャラリーから選択'));
    await tester.pump();

    expect(find.text('画像の読み込みに失敗しました'), findsOneWidget);
    expect(find.textContaining('PlatformException'), findsNothing);
  });
}
