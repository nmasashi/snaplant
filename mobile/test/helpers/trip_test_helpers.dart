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
  String? description,
  String? firstTakenAt,
  String? lastTakenAt,
}) {
  return {
    'id': id,
    'name': name,
    'description': description,
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
/// POST /api/trips には、本文の `name` で旅行を作って 201 を返し、以降の一覧の先頭に加える（0枚・撮影日時なし）。
/// それ以外のメソッドやパス（図鑑タブの GET /api/plants を含む）は 404 にする。
/// 図鑑タブは旅行のテストの関心の外で、404 でもエラー表示になるだけで旅行タブには影響しない。
/// [failFirst] を渡すと、一覧の取得は最初のその回数だけ 503（データベースに接続できない）を返し、以降は成功する
/// （再試行で読み直したかどうかを、2回目の成功で見分けるため）。
/// [rejectCreateWith] を渡すと、作成は 400 `INVALID_REQUEST`（message はその文言）で拒み、旅行は作らない。
/// GET /api/trips/{tripId} には、[tripDetails]（旅行の id から詳細の旅行 JSON への表）の旅行を返す。表に無い id は 404。
/// PUT /api/trips/{tripId} には、本文の `name`（前後の空白を除く）と `description` で表の旅行を置き換え、200 `{ trip }` を返す。
/// 一覧と詳細で同じ旅行の値（枚数など）を変えておくと、詳細を開いたときに取り直したかどうかが見分けられる。
/// 作成を「送らない」ことは、送られたら成功してしまうこの偽のサーバで、成功した結果（ダイアログが閉じる・
/// 「旅行を作成しました」・一覧に増える）が現れないことで確かめる（呼び出しの有無は検証しない）
MockClient tripServer(
  List<Map<String, Object?>> trips, {
  required int unassignedPhotoCount,
  int failFirst = 0,
  String? rejectCreateWith,
  Map<String, Map<String, Object?>> tripDetails = const {},
}) {
  var listRequests = 0;
  final created = <Map<String, Object?>>[];
  // PUT で置き換えるため、渡された表を写して持つ
  final details = {...tripDetails};
  return MockClient((request) async {
    if (request.method == 'PUT' && request.url.path.startsWith('/api/trips/')) {
      final id = request.url.pathSegments.last;
      final current = details[id];
      if (current == null) return http.Response('', 404);
      // 実際のサーバと同じく全体置き換え（name は前後の空白を除く。description は省略か null で消える）
      final body = json.decode(request.body) as Map<String, dynamic>;
      final replaced = {
        ...current,
        'name': (body['name'] as String).trim(),
        'description': body['description'],
      };
      details[id] = replaced;
      return http.Response(
        json.encode({
          'success': true,
          'data': {'trip': replaced},
        }),
        200,
        headers: const {'content-type': 'application/json'},
      );
    }
    if (request.method == 'POST' && request.url.path == '/api/trips') {
      if (rejectCreateWith != null) {
        return http.Response(
          json.encode({
            'success': false,
            'error': {'code': 'INVALID_REQUEST', 'message': rejectCreateWith},
          }),
          400,
          headers: const {'content-type': 'application/json'},
        );
      }
      final body = json.decode(request.body) as Map<String, dynamic>;
      final trip = tripJson(
        id: '3f2504e0-4f89-41d3-9a0c-0305e82c33${created.length.toString().padLeft(2, '0')}',
        name: (body['name'] as String).trim(),
        photoCount: 0,
      );
      created.insert(0, trip);
      return http.Response(
        json.encode({
          'success': true,
          'data': {'trip': trip},
        }),
        201,
        headers: const {'content-type': 'application/json'},
      );
    }
    if (request.method == 'GET' && request.url.path.startsWith('/api/trips/')) {
      final trip = details[request.url.pathSegments.last];
      if (trip == null) return http.Response('', 404);
      return http.Response(
        json.encode({
          'success': true,
          'data': {'trip': trip},
        }),
        200,
        headers: const {'content-type': 'application/json'},
      );
    }
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
          'trips': [...created, ...trips],
          'total': created.length + trips.length,
          'unassignedPhotoCount': unassignedPhotoCount,
        },
      }),
      200,
      // サーバの実際のヘッダに合わせる（charset なしの application/json。無いと日本語が化ける）
      headers: const {'content-type': 'application/json'},
    );
  });
}
