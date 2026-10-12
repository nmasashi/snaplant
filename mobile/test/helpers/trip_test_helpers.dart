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
/// GET /api/trips/{tripId} には、[tripDetails]（旅行の id から詳細の旅行 JSON への表）の旅行を返す。
/// 表に無い id は 404 `TRIP_NOT_FOUND`（別の端末などで消された旅行）の封筒を返す。
/// PUT /api/trips/{tripId} には、本文の `name`（前後の空白を除く）と `description` で表の旅行を置き換え、200 `{ trip }` を返す。
/// DELETE /api/trips/{tripId}?deletePhotos=true|false には、表の旅行を消して（以降の一覧からも外し、`false` なら
/// 写真の枚数だけ未所属の枚数を増やして）200 を返す。`false` なら写真は未所属に移したものとして
/// `detachedPhotoCount` に枚数を、`true` なら `deletedPhotoCount` に枚数を載せる。`deletePhotos` が無い・違う値なら 400。
/// [deletePhotosSent] を渡すと、削除の要求ごとの `deletePhotos` の値（無ければ null）をここに記録する。
/// 写真が0枚の旅行は `true` でも `false` でも応答が同じで、結果からは何を送ったか見分けられないときに使う
/// （API が `deletePhotos` を必須にしている、という要求そのものが確かめたいとき）。
/// [failDelete] が true なら、削除は 503 `DATABASE_ERROR`（旅行は消さない）で失敗する。
/// [deleteTripNotFound] が true なら、削除は 404 `TRIP_NOT_FOUND`（別の端末などで既に消されていた）で返す。
/// 詳細の取得（GET）は表の旅行を返したまま。
/// [holdListUntil] を渡すと、`GET /api/trips` の応答はそれが終わる（Completer の complete）まで返さない。
/// [tripsFromSecondList] を渡すと、`GET /api/trips` の2回目以降の一覧はこの旅行にする（別の端末で旅行が増えた想定。
/// 読み直したかどうかを、増えた旅行が出るかで見分けるため）。
/// [holdCreateUntil] を渡すと、`POST /api/trips` の応答はそれが終わるまで返さない（作成中の状態を見るため）。
/// 同じ旅行が二重に作られたかどうかは、作った旅行が一覧に何件載るかで見分けられる。
/// [failFirstDetail] を渡すと、詳細の取得（GET /api/trips/{tripId}）は最初のその回数だけ 503 を返し、以降は成功する。
/// 一覧と詳細で同じ旅行の値（枚数など）を変えておくと、詳細を開いたときに取り直したかどうかが見分けられる。
/// 作成を「送らない」ことは、送られたら成功してしまうこの偽のサーバで、成功した結果（ダイアログが閉じる・
/// 「旅行を作成しました」・一覧に増える）が現れないことで確かめる（呼び出しの有無は検証しない）
MockClient tripServer(
  List<Map<String, Object?>> trips, {
  required int unassignedPhotoCount,
  int failFirst = 0,
  String? rejectCreateWith,
  Map<String, Map<String, Object?>> tripDetails = const {},
  List<String?>? deletePhotosSent,
  bool failDelete = false,
  bool deleteTripNotFound = false,
  Future<void>? holdListUntil,
  List<Map<String, Object?>>? tripsFromSecondList,
  int failFirstDetail = 0,
  Future<void>? holdCreateUntil,
}) {
  var detailRequests = 0;
  var listRequests = 0;
  final created = <Map<String, Object?>>[];
  // 削除で一覧と未所属の枚数にも反映するため、渡された一覧と枚数を写して持つ
  final listed = [...trips];
  var unassigned = unassignedPhotoCount;
  // PUT で置き換えるため、渡された表を写して持つ
  final details = {...tripDetails};
  return MockClient((request) async {
    if (request.method == 'DELETE' && request.url.path.startsWith('/api/trips/')) {
      final id = request.url.pathSegments.last;
      final current = details[id];
      // 実際のサーバと同じく、deletePhotos は小文字の true / false だけを受け付け、無ければ 400
      // （クライアントが何を載せたかを、返す枚数の違いで見分けるため）
      final deletePhotos = request.url.queryParameters['deletePhotos'];
      deletePhotosSent?.add(deletePhotos);
      if (deleteTripNotFound) {
        return http.Response(
          json.encode({
            'success': false,
            'error': {'code': 'TRIP_NOT_FOUND', 'message': '指定された旅行が見つかりません'},
          }),
          404,
          headers: const {'content-type': 'application/json'},
        );
      }
      if (failDelete) {
        return http.Response(
          json.encode({
            'success': false,
            'error': {'code': 'DATABASE_ERROR', 'message': 'データベースに接続できません'},
          }),
          503,
          headers: const {'content-type': 'application/json'},
        );
      }
      if (deletePhotos != 'true' && deletePhotos != 'false') {
        return http.Response(
          json.encode({
            'success': false,
            'error': {
              'code': 'INVALID_REQUEST',
              'message': deletePhotos == null ? '写真を削除するかどうかを指定してください' : '写真を削除するかどうかの指定が無効です',
            },
          }),
          400,
          headers: const {'content-type': 'application/json'},
        );
      }
      if (current == null) return http.Response('', 404);
      details.remove(id);
      listed.removeWhere((trip) => trip['id'] == id);
      created.removeWhere((trip) => trip['id'] == id);
      final photoCount = current['photoCount'] as int;
      if (deletePhotos == 'false') unassigned += photoCount;
      return http.Response(
        json.encode({
          'success': true,
          'data': {
            'message': '旅行が正常に削除されました',
            'deletedPhotoCount': deletePhotos == 'true' ? photoCount : 0,
            'detachedPhotoCount': deletePhotos == 'false' ? photoCount : 0,
          },
        }),
        200,
        headers: const {'content-type': 'application/json'},
      );
    }
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
      // 処理中の状態を見るため、作成の応答を [holdCreateUntil] が終わるまで止める
      if (holdCreateUntil != null) await holdCreateUntil;
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
      detailRequests++;
      if (detailRequests <= failFirstDetail) {
        return http.Response(
          json.encode({
            'success': false,
            'error': {'code': 'DATABASE_ERROR', 'message': 'データベースに接続できません'},
          }),
          503,
          headers: const {'content-type': 'application/json'},
        );
      }
      final trip = details[request.url.pathSegments.last];
      if (trip == null) {
        return http.Response(
          json.encode({
            'success': false,
            'error': {'code': 'TRIP_NOT_FOUND', 'message': '指定された旅行が見つかりません'},
          }),
          404,
          headers: const {'content-type': 'application/json'},
        );
      }
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
    // 読み込み中の状態を見るため、一覧の応答を [holdListUntil] が終わるまで止める
    if (holdListUntil != null) await holdListUntil;
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
    // 2回目以降の一覧は、別の端末で旅行が増減した想定で [tripsFromSecondList] に差し替える
    final shownTrips = listRequests >= 2 && tripsFromSecondList != null
        ? tripsFromSecondList
        : [...created, ...listed];
    return http.Response(
      json.encode({
        'success': true,
        'data': {
          'trips': shownTrips,
          'total': shownTrips.length,
          'unassignedPhotoCount': unassigned,
        },
      }),
      200,
      // サーバの実際のヘッダに合わせる（charset なしの application/json。無いと日本語が化ける）
      headers: const {'content-type': 'application/json'},
    );
  });
}
