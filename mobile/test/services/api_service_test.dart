import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:snaplant_mobile/services/api_service.dart';

// サーバ（Azure Functions）は ApiService から見てプロセス外の依存。
// HTTP 層を MockClient で差し替え、サーバが返しうるレスポンスを再現する。
// 旅行アルバムの各メソッドの data の読み方は、画面のテストが偽のサーバ越しに見る（CLAUDE.md「クライアント実装で踏みやすい罠」）。
// ここに残すのは、エンドポイントによらない封筒の契約（エラーの例外と利用者に見せる文言）と、写真の送信の Content-Type の決め方

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

/// シグネチャの後ろに本文らしき 0 を足して、実際のファイルに近い長さにする
List<int> _withBody(List<int> header) => [...header, ...List.filled(32, 0)];

/// 写真の id（画像の SHA-256 の16進。送る内容の形だけを満たせばよい）
final _photoId = 'a' * 64;

void main() {
  group('写真の送信の画像の Content-Type', () {
    /// [bytes] を写真として送り、送信したリクエストボディを返す。
    ///
    /// 写真の送信はサーバ（管理外の依存）に Blob を作らせるコマンドで、送信した
    /// Content-Type はサーバが Blob の Content-Type と拡張子を決める根拠になる。
    /// その契約はリクエストにしか現れないため、送信内容を検証する
    Future<String> uploadPhoto(List<int> bytes) async {
      late String sentBody;
      final service = ApiService(
        baseUrl: 'https://api.example.test',
        client: MockClient((request) async {
          sentBody = latin1.decode(request.bodyBytes);
          return http.Response(
            json.encode({
              'success': true,
              'data': {
                'photo': {
                  'id': _photoId,
                  'tripId': null,
                  'imageUrl': 'https://stsnaplant.blob.core.windows.net/photos/a.jpg?sig=test',
                  'thumbnailUrl': null,
                },
                'urlExpiresAt': '2026-10-10T04:12:45.000Z',
              },
            }),
            201,
            headers: _jsonHeaders,
          );
        }),
      );
      await service.uploadPhoto(photoId: _photoId, bytes: Uint8List.fromList(bytes));
      return sentBody;
    }

    /// multipart のパートヘッダ。ヘッダ名の大文字小文字と空白は HTTP 上意味を持たないので許す
    Matcher sendsContentType(String mimeType) =>
        matches(RegExp('content-type:\\s*${RegExp.escape(mimeType)}', caseSensitive: false));

    // 送る Content-Type は、ファイルの先頭バイトのシグネチャで決まる。
    // 判定は PNG・JPEG・GIF・WebP の4形式だけで、それ以外は既定値 image/jpeg にする。
    // 各行は (テスト名, 画像の中身, 送る Content-Type)
    final signatureCases = <(String, List<int>, String)>[
      ('中身がPNGならimage/pngとして送る', _withBody([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), 'image/png'),
      ('中身がJPEGならimage/jpegとして送る', _withBody([0xFF, 0xD8, 0xFF, 0xE0]), 'image/jpeg'),
      ('中身がGIFならimage/gifとして送る', _withBody('GIF89a'.codeUnits), 'image/gif'),
      ('中身が古い形式のGIF87aならimage/gifとして送る', _withBody('GIF87a'.codeUnits), 'image/gif'),
      // WebP は判定に先頭12バイトが要り、4形式で最も長い。読み込み量が足りないと誤判定する
      (
        '中身がWebPならimage/webpとして送る',
        _withBody([...'RIFF'.codeUnits, 0x24, 0x00, 0x00, 0x00, ...'WEBP'.codeUnits]),
        'image/webp',
      ),
      (
        'WebP以外のRIFF形式（WAVなど）はWebPと判定せず、既定のimage/jpegとして送る',
        _withBody([...'RIFF'.codeUnits, 0x24, 0x00, 0x00, 0x00, ...'WAVE'.codeUnits]),
        'image/jpeg',
      ),
      ('判定できない形式は既定のimage/jpegとして送る', _withBody([0x00, 0x01, 0x02, 0x03]), 'image/jpeg'),
      // PNG の先頭2バイトだけで終わるデータ。途中で切れたデータを PNG と誤判定しない
      ('シグネチャに満たない短い画像は既定のimage/jpegとして送る', [0x89, 0x50], 'image/jpeg'),
    ];

    test('中身の先頭バイトで PNG・JPEG・GIF・WebP を見分けて送り、それ以外は既定の image/jpeg として送る', () async {
      for (final (title, bytes, mimeType) in signatureCases) {
        final sentBody = await uploadPhoto(bytes);

        expect(sentBody, sendsContentType(mimeType), reason: title);
      }
    });
  });

  group('エラーレスポンス', () {
    test('サーバが返したエラーコードとメッセージを例外が保持し、400 などはメッセージをそのまま利用者に表示する（削除の失敗）', () async {
      // 404 などは userMessage が固定文言を返すので、サーバの文言がそのまま出る 400 で確かめる
      final service = _serviceResponding('DELETE', '/api/photos/not-a-hash', 400, {
        'success': false,
        'error': {
          'code': 'INVALID_REQUEST',
          'message': '写真IDの形式が無効です',
        },
      });

      final error = await _captureApiException(() => service.deletePhoto('not-a-hash'));

      expect(error.statusCode, 400);
      expect(error.code, 'INVALID_REQUEST');
      expect(error.message, '写真IDの形式が無効です');
      expect(error.userMessage, '写真IDの形式が無効です');
    });
  });

  // userMessage は利用者に見える文言で、ステータスごとに決まる（docs/05 §4.2）。
  // 例外の作り方（ApiException.fromResponse）と userMessage はエンドポイントによらず同じなので、表は旅行の作成で再現する。
  // ただしエラーを例外にする経路は JSON の要求と multipart の送信で別々なので、
  // 502 は実際に返る写真の送信の経路で見る（下の502）。
  // 各行は (テスト名, ステータス, レスポンスのボディ, 例外が持つエラーコード, 利用者に表示する文言)。
  // 封筒でないボディからはコードが読めないので null（クライアントはコードで分岐する）
  group('ユーザー向けメッセージ', () {
    final userMessageCases = <(String, int, Object, String?, String)>[
      (
        // Azure のフロントが返す HTML など、アプリの封筒を経由しないエラー
        '封筒の形でないエラーボディでもステータスを添えた日本語のメッセージを返す',
        413,
        '<html><body>Request Entity Too Large</body></html>',
        null,
        'サーバーでエラーが発生しました（ステータス: 413）',
      ),
      (
        // 従量課金プランの Functions ランタイムが過負荷時に返す。アプリを通らないので封筒にならない
        '429は混雑による拒否なので時間を置いた再試行を促す',
        429,
        'Too Busy',
        null,
        'サーバーが混雑しています。しばらく待ってから再試行してください。',
      ),
      (
        // Function Key が違う（Functions のランタイムが返す。アプリを通らないので封筒にならない）
        '401はAPIキーの確認を促す',
        401,
        '',
        null,
        'APIキーが無効です。設定を確認してください。',
      ),
      (
        '404は見つからない旨を伝え、サーバの文言は出さない',
        404,
        {
          'success': false,
          'error': {'code': 'TRIP_NOT_FOUND', 'message': '指定された旅行が見つかりません'},
        },
        'TRIP_NOT_FOUND',
        '要求されたデータが見つかりません。',
      ),
      (
        '500はサーバ内部の文言を出さず定型のメッセージにする',
        500,
        {
          'success': false,
          'error': {'code': 'INTERNAL_ERROR', 'message': '旅行の作成に失敗しました'},
        },
        'INTERNAL_ERROR',
        'サーバーで問題が発生しています。しばらく待ってから再試行してください。',
      ),
      (
        '503は接続できない状態なので時間を置いた再試行を促す',
        503,
        {
          'success': false,
          'error': {'code': 'DATABASE_ERROR', 'message': 'データベースに接続できません'},
        },
        'DATABASE_ERROR',
        'サービスに一時的に接続できません。しばらく待ってから再試行してください。',
      ),
    ];

    test('ステータスと封筒の有無に応じた日本語のメッセージを返す（413・429・401・404・500・503）', () async {
      for (final (title, statusCode, body, expectedCode, expectedMessage) in userMessageCases) {
        final service = _serviceResponding('POST', '/api/trips', statusCode, body);

        final error = await _captureApiException(() => service.createTrip('北海道', null));

        expect(error.code, expectedCode, reason: title);
        expect(error.userMessage, expectedMessage, reason: title);
      }
    });

    // 502（上流のストレージがエラーを返した）は写真の送信が返す（docs/05_api_design.md §5.1）。
    // 写真の送信は MultipartRequest を送って http.Response.fromStream で応答を作るので、
    // JSON の要求とはエラーを例外にする経路が別。表には入れず、実際に 502 が返る経路で再現する
    test('502は上流がエラーを返した状態なので同じ操作の繰り返しを促さない', () async {
      final service = _serviceResponding('POST', '/api/photos', 502, {
        'success': false,
        'error': {'code': 'STORAGE_ERROR', 'message': 'ストレージサービスでエラーが発生しました'},
      });

      final error = await _captureApiException(() =>
          service.uploadPhoto(photoId: _photoId, bytes: Uint8List.fromList(_withBody([0xFF, 0xD8, 0xFF, 0xE0]))));

      expect(error.code, 'STORAGE_ERROR');
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
