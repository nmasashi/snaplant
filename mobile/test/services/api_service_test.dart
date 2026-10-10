import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:snaplant_mobile/models/api_response.dart';
import 'package:snaplant_mobile/models/plant.dart';
import 'package:snaplant_mobile/services/api_service.dart';

// サーバ（Azure Functions）は ApiService から見てプロセス外の依存。
// HTTP 層を MockClient で差し替え、サーバが返しうるレスポンスを再現する。

/// サーバの実際のヘッダに合わせる（charset なしの application/json）
const _jsonHeaders = {'content-type': 'application/json'};

/// 指定したメソッドとパスへのリクエストにだけ応答する。
/// 宛先を間違えた場合は 404 になるので、パスの誤りもテストで検出できる
ApiService _serviceResponding(String method, String path, int statusCode, Object body) {
  return ApiService(
    baseUrl: 'https://api.example.test',
    client: MockClient((request) async {
      if (request.method != method || request.url.path != path) {
        return http.Response('', 404);
      }
      return http.Response(body is String ? body : json.encode(body), statusCode, headers: _jsonHeaders);
    }),
  );
}

/// サーバが返す植物ドキュメント（`docs/06_api_openapi.yaml` の Plant）
Map<String, dynamic> _plantJson({String id = 'plant-1', double confidence = 95.0}) => {
      'id': id,
      'name': '桜',
      'scientificName': 'Prunus serrulata',
      'familyName': 'バラ科',
      'description': '日本の代表的な花木',
      'characteristics': '春に咲く',
      'confidence': confidence,
      'imagePath': 'https://stsnaplant.blob.core.windows.net/images/a.jpg',
      'createdAt': '2026-10-01T09:00:00.000Z',
      'updatedAt': '2026-10-02T09:00:00.000Z',
    };

const _identificationJson = {
  'isPlant': true,
  'confidence': 95.0,
  'reason': '葉と花の形状から植物と判断',
  'candidates': [
    {'name': '桜', 'characteristics': '春に咲く', 'confidence': 95.0},
  ],
};

const _createRequest = PlantCreateRequest(
  name: '桜',
  characteristics: '春に咲く',
  confidence: 95.0,
  imagePath: 'https://stsnaplant.blob.core.windows.net/images/a.jpg',
);

void main() {
  group('画像アップロード', () {
    late Directory tempDir;

    setUp(() async {
      tempDir = await Directory.systemTemp.createTemp('snaplant_test_');
    });

    tearDown(() async {
      await tempDir.delete(recursive: true);
    });

    /// 拡張子が .jpg のファイルに [bytes] を書いてアップロードし、送信したリクエストボディを返す。
    ///
    /// アップロードはサーバ（管理外の依存）に Blob を作らせるコマンドで、送信した
    /// Content-Type はサーバが Blob の Content-Type と拡張子を決める根拠になる。
    /// その契約はリクエストにしか現れないため、送信内容を検証する
    Future<String> uploadAsJpgFile(List<int> bytes) async {
      final file = File('${tempDir.path}/photo.jpg');
      await file.writeAsBytes([...bytes, ...List.filled(32, 0)]);
      late String sentBody;
      final service = ApiService(
        baseUrl: 'https://api.example.test',
        client: MockClient((request) async {
          sentBody = latin1.decode(request.bodyBytes);
          return http.Response(
            json.encode({
              'success': true,
              'data': {
                'imagePath': 'https://stsnaplant.blob.core.windows.net/images/a.png',
                'fileName': 'plant_image.jpg',
                'contentType': 'image/png',
                'fileSize': 40,
                'identificationResult': {'isPlant': true, 'candidates': []},
              },
            }),
            201,
            headers: _jsonHeaders,
          );
        }),
      );
      await service.uploadAndIdentifyImage(file);
      return sentBody;
    }

    /// multipart のパートヘッダ。ヘッダ名の大文字小文字と空白は HTTP 上意味を持たないので許す
    Matcher sendsContentType(String mimeType) =>
        matches(RegExp('content-type:\\s*${RegExp.escape(mimeType)}', caseSensitive: false));

    test('拡張子がjpgでも中身がPNGならimage/pngとして送る', () async {
      final sentBody = await uploadAsJpgFile([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

      expect(sentBody, sendsContentType('image/png'));
    });

    test('拡張子がjpgでも中身がWebPならimage/webpとして送る', () async {
      // WebP は判定に先頭12バイトが要り、4形式で最も長い。ファイルの読み込み量が足りないと誤判定する
      final sentBody = await uploadAsJpgFile([...'RIFF'.codeUnits, 0x24, 0x00, 0x00, 0x00, ...'WEBP'.codeUnits]);

      expect(sentBody, sendsContentType('image/webp'));
    });

    test('アップロードはdataから保存先のURLと識別結果を取り出す', () async {
      final file = File('${tempDir.path}/photo.jpg');
      await file.writeAsBytes([0xFF, 0xD8, 0xFF, 0xE0, ...List.filled(32, 0)]);
      final service = _serviceResponding('POST', '/api/images/upload', 201, {
        'success': true,
        'data': {
          'imagePath': 'https://stsnaplant.blob.core.windows.net/images/saved.jpg',
          'fileName': 'plant_image.jpg',
          'contentType': 'image/jpeg',
          'fileSize': 36,
          'identificationResult': _identificationJson,
        },
      });

      final result = await service.uploadAndIdentifyImage(file);

      expect((result['uploadResult'] as UploadResult).imagePath, 'https://stsnaplant.blob.core.windows.net/images/saved.jpg');
      expect((result['identificationResult'] as IdentificationResult).candidates.map((c) => c.name), ['桜']);
    });
  });

  // 封筒 { success, data } の内側のキーはエンドポイントごとに違う（CLAUDE.md の表）。
  // 過去に data を剥がし忘れて fromJson が失敗したことがあるため、全エンドポイントで固定する
  group('成功レスポンスの封筒を剥がす', () {
    test('一覧はdata.plantsから植物の要約を取り出す', () async {
      final service = _serviceResponding('GET', '/api/plants', 200, {
        'success': true,
        'data': {
          'plants': [
            {
              'id': 'plant-1',
              'name': '桜',
              'characteristics': '春に咲く',
              'imagePath': 'https://stsnaplant.blob.core.windows.net/images/a.jpg',
              'confidence': 95.0,
              'createdAt': '2026-10-01T09:00:00.000Z',
            },
          ],
          'total': 1,
        },
      });

      final plants = await service.getPlants();

      expect(plants.map((p) => p.name), ['桜']);
    });

    test('詳細はdata.plantから植物を取り出す', () async {
      final service = _serviceResponding('GET', '/api/plants/plant-1', 200, {
        'success': true,
        'data': {'plant': _plantJson()},
      });

      final plant = await service.getPlant('plant-1');

      expect(plant.id, 'plant-1');
    });

    test('保存はdata.plantから保存された植物を取り出す', () async {
      final service = _serviceResponding('POST', '/api/plants/save', 201, {
        'success': true,
        'data': {'plant': _plantJson(id: 'plant-new')},
      });

      final plant = await service.savePlant(_createRequest);

      expect(plant.id, 'plant-new');
    });

    test('更新はdata.plantから更新後の植物を取り出す', () async {
      final service = _serviceResponding('PUT', '/api/plants/plant-1', 200, {
        'success': true,
        'data': {'plant': _plantJson(confidence: 88.0)},
      });

      final plant = await service.updatePlant(
        'plant-1',
        'https://stsnaplant.blob.core.windows.net/images/b.jpg',
        88.0,
      );

      expect(plant.confidence, 88.0);
    });

    test('重複確認はdataそのものを結果として読む', () async {
      final service = _serviceResponding('GET', '/api/plants/check-duplicate', 200, {
        'success': true,
        'data': {
          'exists': true,
          'plant': {
            'id': 'plant-1',
            'name': '桜',
            'imagePath': 'https://stsnaplant.blob.core.windows.net/images/a.jpg',
            'confidence': 95.0,
            'createdAt': '2026-10-01T09:00:00.000Z',
          },
        },
      });

      final result = await service.checkDuplicate('桜');

      expect(result.plant?.id, 'plant-1');
    });
  });

  group('エラーレスポンス', () {
    test('サーバが返したエラーコードとメッセージを例外が保持する', () async {
      final service = _serviceResponding('POST', '/api/plants/save', 409, {
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

    test('削除の失敗でもサーバが返した理由をユーザーに伝える', () async {
      // 404 などは userMessage が固定文言を返すので、サーバの文言がそのまま出る 400 で確かめる
      final service = _serviceResponding('DELETE', '/api/plants/not-a-uuid', 400, {
        'success': false,
        'error': {
          'code': 'INVALID_REQUEST',
          'message': '植物IDの形式が無効です',
        },
      });

      final error = await _captureApiException(() => service.deletePlant('not-a-uuid'));

      expect(error.code, 'INVALID_REQUEST');
      expect(error.userMessage, '植物IDの形式が無効です');
    });

    test('封筒の形でないエラーボディでもステータスを添えた日本語のメッセージを返す', () async {
      // Azure のフロントが返す HTML など、アプリの封筒を経由しないエラー
      final service = _serviceResponding('POST', '/api/plants/save', 413, '<html><body>Request Entity Too Large</body></html>');

      final error = await _captureApiException(() => service.savePlant(_createRequest));

      expect(error.code, isNull);
      expect(error.userMessage, 'サーバーでエラーが発生しました（ステータス: 413）');
    });
  });

  group('ユーザー向けメッセージ', () {
    test('409はサーバが返した日本語のメッセージをそのまま表示する', () async {
      final service = _serviceResponding('POST', '/api/plants/save', 409, {
        'success': false,
        'error': {
          'code': 'IMAGE_ALREADY_SAVED',
          'message': 'この画像は既に保存されています',
        },
      });

      final error = await _captureApiException(() => service.savePlant(_createRequest));

      expect(error.userMessage, 'この画像は既に保存されています');
    });

    test('429は混雑による拒否なので時間を置いた再試行を促す', () async {
      // 従量課金プランの Functions ランタイムが過負荷時に返す。アプリを通らないので封筒にならない
      final service = _serviceResponding('POST', '/api/plants/save', 429, 'Too Busy');

      final error = await _captureApiException(() => service.savePlant(_createRequest));

      expect(error.userMessage, 'リクエスト数が制限を超えました。しばらく待ってから再試行してください。');
    });

    test('500はサーバ内部の文言を出さず定型のメッセージにする', () async {
      final service = _serviceResponding('POST', '/api/plants/save', 500, {
        'success': false,
        'error': {
          'code': 'INTERNAL_ERROR',
          'message': 'サーバー内部エラーが発生しました',
        },
      });

      final error = await _captureApiException(() => service.savePlant(_createRequest));

      expect(error.userMessage, 'サーバーで問題が発生しています。しばらく待ってから再試行してください。');
    });

    test('503は接続できない状態なので時間を置いた再試行を促す', () async {
      final service = _serviceResponding('POST', '/api/plants/save', 503, {
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
      // 502（上流の AI・ストレージがエラーを返した）を返すエンドポイントのうち、
      // クライアントが呼ぶのはアップロードだけなので、アップロードで再現する
      final tempDir = await Directory.systemTemp.createTemp('snaplant_test_');
      addTearDown(() => tempDir.delete(recursive: true));
      final file = File('${tempDir.path}/photo.jpg');
      await file.writeAsBytes([0xFF, 0xD8, 0xFF, 0xE0, ...List.filled(32, 0)]);
      final service = _serviceResponding('POST', '/api/images/upload', 502, {
        'success': false,
        'error': {
          'code': 'AI_SERVICE_ERROR',
          'message': '植物識別サービスでエラーが発生しました',
        },
      });

      final error = await _captureApiException(() => service.uploadAndIdentifyImage(file));

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
