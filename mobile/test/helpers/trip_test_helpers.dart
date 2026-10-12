import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

// 旅行一覧など、旅行アルバムの API を呼ぶ画面のテストが共有する偽のサーバ

/// 旅行（TripSummary）の JSON を作る。表紙は付けない（coverThumbnailUrl は null）。
/// [firstTakenAt]・[lastTakenAt] はタイムゾーン無しの撮影日時（`2026-10-05T09:00:00`）で、撮影日時のある写真が無ければ null
Map<String, Object?> tripJson({
  required String id,
  required String name,
  required int photoCount,
  String? firstTakenAt,
  String? lastTakenAt,
}) {
  return {
    'id': id,
    'name': name,
    'description': null,
    'tags': <String>[],
    'createdAt': '2026-10-01T09:00:00.000Z',
    'updatedAt': '2026-10-01T09:00:00.000Z',
    'photoCount': photoCount,
    'firstTakenAt': firstTakenAt,
    'lastTakenAt': lastTakenAt,
    'coverThumbnailUrl': null,
  };
}

/// GET /api/trips に、[trips]（この順）と [unassignedPhotoCount] を返す偽のサーバ。
/// それ以外のメソッドやパス（図鑑タブの GET /api/plants を含む）は 404 にする。
/// 図鑑タブは旅行のテストの関心の外で、404 でもエラー表示になるだけで旅行タブには影響しない。
/// [failFirst] を渡すと、一覧の取得は最初のその回数だけ 503（データベースに接続できない）を返し、以降は成功する
/// （再試行で読み直したかどうかを、2回目の成功で見分けるため）
MockClient tripServer(
  List<Map<String, Object?>> trips, {
  required int unassignedPhotoCount,
  int failFirst = 0,
}) {
  var listRequests = 0;
  return MockClient((request) async {
    if (request.method != 'GET' || request.url.path != '/api/trips') {
      return http.Response('', 404);
    }
    listRequests++;
    if (listRequests <= failFirst) {
      return http.Response(
        json.encode({
          'success': false,
          'error': {'code': 'DATABASE_ERROR', 'message': 'データベースに接続できません'},
        }),
        503,
        headers: const {'content-type': 'application/json'},
      );
    }
    return http.Response(
      json.encode({
        'success': true,
        'data': {
          'trips': trips,
          'total': trips.length,
          'unassignedPhotoCount': unassignedPhotoCount,
        },
      }),
      200,
      // サーバの実際のヘッダに合わせる（charset なしの application/json。無いと日本語が化ける）
      headers: const {'content-type': 'application/json'},
    );
  });
}
