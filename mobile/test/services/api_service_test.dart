import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:snaplant_mobile/models/plant.dart';
import 'package:snaplant_mobile/services/api_service.dart';

// サーバ（Azure Functions）は ApiService から見てプロセス外の依存。
// HTTP 層を MockClient で差し替え、サーバが返しうるレスポンスを再現する。

/// サーバの実際のヘッダに合わせる（charset なしの application/json）
const _jsonHeaders = {'content-type': 'application/json'};

ApiService _serviceReturning(int statusCode, Object body) {
  return ApiService(
    baseUrl: 'https://api.example.test',
    client: MockClient((_) async => http.Response(
          body is String ? body : json.encode(body),
          statusCode,
          headers: _jsonHeaders,
        )),
  );
}

const _createRequest = PlantCreateRequest(
  name: '桜',
  characteristics: '春に咲く',
  confidence: 95.0,
  imagePath: 'https://stsnaplant.blob.core.windows.net/images/a.jpg',
);

void main() {
  group('エラーレスポンス', () {
    test('サーバが返したエラーコードとメッセージを例外が保持する', () async {
      final service = _serviceReturning(409, {
        'success': false,
        'error': {
          'code': 'IMAGE_ALREADY_SAVED',
          'message': 'この画像は既に保存されています',
        },
      });

      final error = await _captureApiException(() => service.savePlant(_createRequest));

      expect(error.statusCode, 409);
      expect(error.code, 'IMAGE_ALREADY_SAVED');
      expect(error.message, 'この画像は既に保存されています');
    });

    test('封筒の形でないエラーボディでもステータスを添えた日本語のメッセージを返す', () async {
      // Azure のフロントが返す HTML など、アプリの封筒を経由しないエラー
      final service = _serviceReturning(413, '<html><body>Request Entity Too Large</body></html>');

      final error = await _captureApiException(() => service.savePlant(_createRequest));

      expect(error.code, isNull);
      expect(error.userMessage, 'サーバーでエラーが発生しました（ステータス: 413）');
    });
  });

  group('ユーザー向けメッセージ', () {
    test('409はサーバが返した日本語のメッセージをそのまま表示する', () async {
      final service = _serviceReturning(409, {
        'success': false,
        'error': {
          'code': 'IMAGE_ALREADY_SAVED',
          'message': 'この画像は既に保存されています',
        },
      });

      final error = await _captureApiException(() => service.savePlant(_createRequest));

      expect(error.userMessage, 'この画像は既に保存されています');
    });

    test('503は接続できない状態なので時間を置いた再試行を促す', () async {
      final service = _serviceReturning(503, {
        'success': false,
        'error': {
          'code': 'DATABASE_ERROR',
          'message': 'データベースに接続できません',
        },
      });

      final error = await _captureApiException(() => service.savePlant(_createRequest));

      expect(error.userMessage, 'サービスに一時的に接続できません。しばらく待ってから再試行してください。');
    });

    test('502は上流がエラーを返した状態なので同じ操作の繰り返しを促さない', () async {
      final service = _serviceReturning(502, {
        'success': false,
        'error': {
          'code': 'AI_SERVICE_ERROR',
          'message': '植物識別サービスでエラーが発生しました',
        },
      });

      final error = await _captureApiException(
        () => service.identifyPlant('https://stsnaplant.blob.core.windows.net/temp-images/a.jpg'),
      );

      expect(error.userMessage, '外部サービスでエラーが発生しました。繰り返し発生する場合は、時間を置いてからお試しください。');
    });
  });
}

Future<ApiException> _captureApiException(Future<Object?> Function() action) async {
  try {
    await action();
  } on ApiException catch (e) {
    return e;
  }
  fail('ApiException が投げられなかった');
}
