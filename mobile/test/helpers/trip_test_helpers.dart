import 'dart:async';
import 'dart:convert';

import 'package:crypto/crypto.dart' show sha256;
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/test/test_flutter_secure_storage_platform.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:snaplant_mobile/main.dart';

import 'app_test_helpers.dart';

// 旅行一覧・旅行詳細など、旅行アルバムの API を呼ぶ画面のテストが共有する偽のサーバと前置き

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

/// 写真（Photo。docs/travel-album/05_api_design.md §3.3）の JSON を作る。
/// [number] から 64 桁の小文字16進の id を作る（実際の id は画像の SHA-256）。サムネイルの URL は SAS 付きの形にする。
/// [takenAt] はタイムゾーン無しの撮影日時（`2026-10-05T12:30:15`）。[hasThumbnail] が false ならサムネイルが無い写真（thumbnailUrl が null）
Map<String, Object?> photoJson({
  required int number,
  String? tripId,
  String? takenAt,
  bool hasThumbnail = true,
}) {
  final id = number.toRadixString(16).padLeft(64, '0');
  const blobHost = 'https://stsnaplant.blob.core.windows.net/photos';
  return {
    'id': id,
    'tripId': tripId,
    'imageUrl': '$blobHost/$id.jpg?sv=2024-01-01&sig=test',
    'thumbnailUrl': hasThumbnail ? '$blobHost/$id.thumb.jpg?sv=2024-01-01&sig=test' : null,
    'contentType': 'image/jpeg',
    'fileSize': 1234567,
    'takenAt': takenAt,
    'takenAtSource': takenAt == null ? null : 'exif',
    'sortAt': takenAt ?? '2026-10-10T12:12:45',
    'location': null,
    'category': null,
    'tags': <String>[],
    'comment': null,
    'commentSource': null,
    'hint': null,
    'classification': null,
    'identification': null,
    'processing': {'state': 'none', 'step': null, 'attempts': 0, 'lastError': null, 'updatedAt': null},
    'uploadedAt': '2026-10-10T03:12:45.000Z',
    'updatedAt': '2026-10-10T03:12:45.000Z',
  };
}

// ---------------------------------------------------------------------------
// 状態を1つだけ持つ偽のサーバ

/// 偽のサーバが応答する宛先
enum TripRoute {
  /// GET /api/trips
  list,

  /// POST /api/trips
  create,

  /// GET /api/trips/{tripId}
  detail,

  /// PUT /api/trips/{tripId}
  update,

  /// DELETE /api/trips/{tripId}?deletePhotos=true|false
  delete,

  /// GET /api/photos?tripId=...&limit=...&continuationToken=...
  photos,

  /// POST /api/photos/move
  move,

  /// DELETE /api/photos/{photoId}
  deletePhoto,

  /// POST /api/photos（multipart）
  upload,
}

/// 旅行アルバムの API（`/api/trips` の5つと、写真の一覧 `GET /api/photos`・写真の移動 `POST /api/photos/move`・写真の削除 `DELETE /api/photos/{photoId}`・写真の送信 `POST /api/photos`）の偽のサーバ。
/// 状態は [trips]・[unassignedPhotoCount]・[photosByTripId] の3つだけで、
/// 一覧も詳細も作成・更新・削除も、この同じ旅行のリストを読み書きする。
///
/// - 写真は旅行ごとに [photosByTripId] に持つ（キーは旅行の id。旅行に属さない写真は `none`）。
///   `GET /api/photos` は `tripId` で絞り込み、入れた順（サーバが返す順）に `limit`（クライアントが送らなければ [pageSize]）枚ずつ返す。
///   続きがあるときの `continuationToken` は次の開始位置を表す文字列で、受け取ったものをそのまま次の要求に載せると続きが返る
///   （旅行が無い `tripId` は 404 `TRIP_NOT_FOUND`。`none` は旅行の確認をしない）
/// - `POST /api/photos/move` は、[photosByTripId] の写真を移し先の旅行（`tripId: null` なら `none`）の末尾へ動かし、写真の `tripId` を書き換える。
///   移した写真の元の旅行と移し先の旅行の `photoCount`（と [unassignedPhotoCount]）も合わせて更新する。
///   応答は `{ moved, notFound }`（どの旅行にも無い id が `notFound`）。移し先の旅行が無ければ 404 `TRIP_NOT_FOUND`。
///   `photoIds` が空なら 400 `INVALID_REQUEST`、200件を超えても 400（実際のサーバと同じ検証。分けずに送る・空のまとまりを送るクライアントを落とすため）。
///   `tripId` のキーが無いときも 400（旅行から外すには `tripId: null` を明示する）。
///   既にその旅行にある写真は、動かさずに `moved` に入れる。
/// - `POST /api/photos`（multipart）は、`photoId` が `image` の SHA-256 と一致しなければ 400「写真IDが画像の内容と一致しません」（実際のサーバと同じ）。
///   既にある id は 200 で既存を返し（冪等）、無ければ宛先（`tripId` が無ければ `none`）の末尾に足して 201 を返す。宛先の旅行の `photoCount`（と [unassignedPhotoCount]）も増やす。
///   `takenAt`・`latitude`・`longitude` は写真に反映する（`location` は緯度と経度を持つときだけ。地名は null）。
///   実際のサーバと同じく、`tripId` の形式・`takenAt` の形式・緯度と経度の片方だけ・位置情報の形式は 400（空文字のパートも「指定あり」として検証する）
/// - `DELETE /api/photos/{photoId}` は、写真を [photosByTripId] から取り除き、その旅行の `photoCount`（と [unassignedPhotoCount]）を減らす。
///   応答は `{ message }`。どの旅行にも無い id は 404 `PHOTO_NOT_FOUND`。
/// - 「別の端末で変わった」は、テストが [trips] を直接書き換えて表す（旅行を足す・消す・枚数を変える）
/// - 宛先ごとに、応答を止める（[holds]）・次の呼び出しを失敗させる（[failNext]）ことができる
/// - 次の1回の呼び出しだけ、応答の中身（[failNext] の失敗を含む）は届いた時点の状態で決めたまま、返すのを止める（[holdNextReply]）こともできる。
///   遅れて届く古い応答（止めている間に別の端末で状態が変わる）を表す
/// - ホストと API キー（`?code=`）が合わなければ 404 を返す。宛先やキーの取り違えを検出するため（`plantServer` と同じ考え方）
/// - 削除の要求の `deletePhotos` を [deletePhotosSent] に記録する。写真が0枚の旅行は `true` でも `false` でも応答が同じで、
///   結果からは何を送ったか見分けられない。二重に送られたかどうか（2回目は 404 になって成功扱いと区別しにくい）も、これで見る。
///   API が必須にしている `deletePhotos` を載せたかという、クライアントが送る要求そのものを確かめたいときだけ使う
class FakeTripBackend {
  FakeTripBackend({
    List<Map<String, Object?>> trips = const [],
    this.unassignedPhotoCount = 0,
    this.functionKey = 'saved-key',
    this.pageSize = 100,
    this.leadingEmptyPages = 0,
    Map<String, List<Map<String, Object?>>> photosByTripId = const {},
  })  : trips = [...trips],
        photosByTripId = {
          for (final entry in photosByTripId.entries) entry.key: [...entry.value],
        };

  /// 旅行（新しい順。`GET /api/trips` はこの順に返す）。作成は先頭に足し、更新と削除はここを書き換える
  final List<Map<String, Object?>> trips;

  /// `GET /api/photos` の1ページの枚数（`limit` が無いときの既定。実際のサーバは 100。画面を超える枚数を少なく用意するために減らせる）
  final int pageSize;

  /// `GET /api/photos` が、先頭から読むとき最初に返す「写真が0枚で、続きのトークンが付いた」ページの数。
  /// 実際のサーバは、空のページを何度か読み直してもまだ空のとき、空のページをトークン付きで返すことがある（写真があっても起きる）。
  /// トークンを渡して読み進めると、この数だけ空のページを返したあと、写真の先頭から返す
  final int leadingEmptyPages;

  /// 旅行に属さない写真の枚数。写真を残す削除で、その旅行の枚数だけ増える
  int unassignedPhotoCount;

  /// 旅行ごとの写真（キーは旅行の id、旅行に属さない写真は `none`）。`GET /api/photos` はこの並びのまま返す
  final Map<String, List<Map<String, Object?>>> photosByTripId;

  /// 受け付ける API キー
  final String functionKey;

  /// 宛先ごとに、応答を返すのをこの Future が終わるまで止める（Completer の future を入れる）
  final Map<TripRoute, Future<void>> holds = {};

  /// 削除の要求ごとの `deletePhotos` の値（無ければ null）
  final List<String?> deletePhotosSent = [];

  final Map<TripRoute, List<({int status, String code, String message})>> _failures = {};
  final Map<TripRoute, List<Future<void>>> _replyHolds = {};
  var _createdCount = 0;

  /// [route] の次の1回の呼び出しを、[status] の封筒つきのエラーで失敗させる。呼ぶたびに1回分積まれ、順に使われる
  void failNext(
    TripRoute route, {
    int status = 503,
    String code = 'DATABASE_ERROR',
    String message = 'データベースに接続できません',
  }) {
    _failures.putIfAbsent(route, () => []).add((status: status, code: code, message: message));
  }

  /// [route] の次の1回の呼び出しだけ、返すのを返り値の Completer が終わるまで止める。
  /// 応答の中身は呼び出しが届いた時点の状態で決まり、止めている間に状態を書き換えても変わらない（[holds] は解放されたときの状態で決まる）
  Completer<void> holdNextReply(TripRoute route) {
    final completer = Completer<void>();
    _replyHolds.putIfAbsent(route, () => []).add(completer.future);
    return completer;
  }

  /// この偽のサーバにつなぐ HTTP クライアント
  late final MockClient client = MockClient(_handle);

  Future<http.Response> _handle(http.Request request) async {
    if (request.url.host != testApiHost || request.url.queryParameters['code'] != functionKey) {
      return http.Response('', 404);
    }
    final route = _routeOf(request);
    if (route == null) return http.Response('', 404);
    if (route == TripRoute.delete) {
      deletePhotosSent.add(request.url.queryParameters['deletePhotos']);
    }
    final hold = holds[route];
    if (hold != null) await hold;
    // 応答の中身（失敗を含む）は届いた時点で決め、返すのを止める指定があれば、そのあとで返す
    final failures = _failures[route];
    final failure = failures != null && failures.isNotEmpty ? failures.removeAt(0) : null;
    final replyHolds = _replyHolds[route];
    final replyHold = replyHolds != null && replyHolds.isNotEmpty ? replyHolds.removeAt(0) : null;
    final response =
        failure != null ? _error(failure.status, failure.code, failure.message) : _respondTo(route, request);
    if (replyHold != null) await replyHold;
    return response;
  }

  http.Response _respondTo(TripRoute route, http.Request request) {
    switch (route) {
      case TripRoute.list:
        return _ok(200, {
          'trips': trips,
          'total': trips.length,
          'unassignedPhotoCount': unassignedPhotoCount,
        });
      case TripRoute.create:
        return _create(request);
      case TripRoute.detail:
        final trip = _find(request.url.pathSegments.last);
        return trip == null ? _notFound() : _ok(200, {'trip': trip});
      case TripRoute.update:
        return _update(request);
      case TripRoute.delete:
        return _delete(request);
      case TripRoute.photos:
        return _listPhotos(request);
      case TripRoute.move:
        return _movePhotos(request);
      case TripRoute.upload:
        return _uploadPhoto(request);
      case TripRoute.deletePhoto:
        return _deletePhoto(request);
    }
  }

  TripRoute? _routeOf(http.Request request) {
    final path = request.url.path;
    if (path == '/api/trips') {
      return switch (request.method) {
        'GET' => TripRoute.list,
        'POST' => TripRoute.create,
        _ => null,
      };
    }
    if (path.startsWith('/api/trips/') && request.url.pathSegments.length == 3) {
      return switch (request.method) {
        'GET' => TripRoute.detail,
        'PUT' => TripRoute.update,
        'DELETE' => TripRoute.delete,
        _ => null,
      };
    }
    if (path == '/api/photos' && request.method == 'GET') return TripRoute.photos;
    if (path == '/api/photos' && request.method == 'POST') return TripRoute.upload;
    if (path == '/api/photos/move' && request.method == 'POST') return TripRoute.move;
    if (path.startsWith('/api/photos/') && request.url.pathSegments.length == 3 && request.method == 'DELETE') {
      return TripRoute.deletePhoto;
    }
    return null;
  }

  Map<String, Object?>? _find(String id) {
    for (final trip in trips) {
      if (trip['id'] == id) return trip;
    }
    return null;
  }

  http.Response _create(http.Request request) {
    final body = json.decode(request.body) as Map<String, dynamic>;
    final trip = tripJson(
      id: '3f2504e0-4f89-41d3-9a0c-0305e82c${9000 + _createdCount++}',
      name: (body['name'] as String).trim(),
      description: body['description'] as String?,
      photoCount: 0,
    );
    trips.insert(0, trip);
    return _ok(201, {'trip': trip});
  }

  http.Response _update(http.Request request) {
    final trip = _find(request.url.pathSegments.last);
    if (trip == null) return _notFound();
    // 実際のサーバと同じく全体置き換え（name は前後の空白を除く。description は省略か null で消える）
    final body = json.decode(request.body) as Map<String, dynamic>;
    trip['name'] = (body['name'] as String).trim();
    trip['description'] = body['description'];
    return _ok(200, {'trip': trip});
  }

  http.Response _delete(http.Request request) {
    // 実際のサーバの順: deletePhotos の検証が先、旅行の有無が後
    final deletePhotos = request.url.queryParameters['deletePhotos'];
    if (deletePhotos == null) {
      return _error(400, 'INVALID_REQUEST', '写真を削除するかどうかを指定してください');
    }
    if (deletePhotos != 'true' && deletePhotos != 'false') {
      return _error(400, 'INVALID_REQUEST', '写真を削除するかどうかの指定が無効です');
    }
    final trip = _find(request.url.pathSegments.last);
    if (trip == null) return _notFound();
    trips.remove(trip);
    final photoCount = trip['photoCount'] as int;
    if (deletePhotos == 'false') unassignedPhotoCount += photoCount;
    return _ok(200, {
      'message': '旅行が正常に削除されました',
      'deletedPhotoCount': deletePhotos == 'true' ? photoCount : 0,
      'detachedPhotoCount': deletePhotos == 'false' ? photoCount : 0,
    });
  }

  http.Response _listPhotos(http.Request request) {
    final query = request.url.queryParameters;
    final tripId = query['tripId'];
    if (tripId == null) return _error(400, 'INVALID_REQUEST', '旅行を指定してください');
    if (tripId != 'none' && _find(tripId) == null) return _notFound();
    final photos = photosByTripId[tripId] ?? const <Map<String, Object?>>[];
    final limit = int.parse(query['limit'] ?? '$pageSize');
    final token = query['continuationToken'];
    const emptyTokenPrefix = 'empty-';
    final emptyPagesRead = token == null
        ? 0
        : token.startsWith(emptyTokenPrefix)
            ? int.parse(token.substring(emptyTokenPrefix.length))
            : leadingEmptyPages;
    if (emptyPagesRead < leadingEmptyPages) {
      return _ok(200, {
        'photos': <Map<String, Object?>>[],
        'continuationToken': '$emptyTokenPrefix${emptyPagesRead + 1}',
        'urlExpiresAt': '2026-10-10T04:12:45.000Z',
      });
    }
    final start = token == null || token.startsWith(emptyTokenPrefix) ? 0 : int.parse(token);
    final end = start + limit < photos.length ? start + limit : photos.length;
    return _ok(200, {
      'photos': photos.sublist(start, end),
      'continuationToken': end < photos.length ? '$end' : null,
      'urlExpiresAt': '2026-10-10T04:12:45.000Z',
    });
  }

  /// `POST /api/photos`（multipart。docs/travel-album/05_api_design.md §5.1）。
  /// 写真の id（`photoId`）は画像のバイト列の SHA-256 でなければ 400 にする（実際のサーバと同じ。クライアントが正しいハッシュを送ったかを結果で見るため）。
  /// 既にある id は、動かさずに 200 で既存を返す（冪等）。無ければ、宛先（`tripId` が無ければ `none`）の末尾に足し、枚数を増やして 201 を返す
  http.Response _uploadPhoto(http.Request request) {
    final parts = _parseMultipart(request);
    final photoId = parts['photoId']?.text;
    final image = parts['image'];
    // 実際のサーバの検証の順（docs/travel-album/05_api_design.md §5.1）のうち、クライアントが取り違えうるもの。
    // 値が無いときはパートごと省く。空文字のパートは「指定あり」として検証され、400 になる
    if (photoId == null || photoId.isEmpty) return _error(400, 'INVALID_REQUEST', '写真IDが指定されていません');
    if (image == null || image.filename == null) return _error(400, 'INVALID_REQUEST', '画像ファイルが指定されていません');
    final tripId = parts['tripId']?.text;
    if (tripId != null && !RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$').hasMatch(tripId)) {
      return _error(400, 'INVALID_REQUEST', '旅行IDの形式が無効です');
    }
    final takenAt = parts['takenAt']?.text;
    if (takenAt != null && !RegExp(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$').hasMatch(takenAt)) {
      return _error(400, 'INVALID_REQUEST', '撮影日時の形式が無効です');
    }
    final latitudeText = parts['latitude']?.text;
    final longitudeText = parts['longitude']?.text;
    if ((latitudeText == null) != (longitudeText == null)) {
      return _error(400, 'INVALID_REQUEST', '緯度と経度は両方指定してください');
    }
    final decimal = RegExp(r'^-?\d+(\.\d+)?$');
    final latitude = latitudeText == null ? null : double.tryParse(latitudeText);
    final longitude = longitudeText == null ? null : double.tryParse(longitudeText);
    if (latitudeText != null &&
        (!decimal.hasMatch(latitudeText) ||
            !decimal.hasMatch(longitudeText!) ||
            latitude!.abs() > 90 ||
            longitude!.abs() > 180)) {
      return _error(400, 'INVALID_REQUEST', '位置情報の形式が無効です');
    }
    if (sha256.convert(image.bytes).toString() != photoId) {
      return _error(400, 'INVALID_REQUEST', '写真IDが画像の内容と一致しません');
    }
    for (final photos in photosByTripId.values) {
      for (final photo in photos) {
        if (photo['id'] == photoId) return _ok(200, {'photo': photo, 'urlExpiresAt': '2026-10-10T04:12:45.000Z'});
      }
    }
    if (tripId != null && _find(tripId) == null) return _notFound();
    const blobHost = 'https://stsnaplant.blob.core.windows.net/photos';
    final photo = photoJson(number: 0, tripId: tripId, takenAt: takenAt)
      ..['id'] = photoId
      ..['imageUrl'] = '$blobHost/$photoId.jpg?sv=2024-01-01&sig=test'
      ..['thumbnailUrl'] = parts['thumbnail'] == null ? null : '$blobHost/$photoId.thumb.jpg?sv=2024-01-01&sig=test'
      ..['fileSize'] = image.bytes.length
      ..['location'] = latitude == null
          ? null
          : {'latitude': latitude, 'longitude': longitude, 'placeName': null, 'placeSource': null};
    final targetKey = tripId ?? 'none';
    photosByTripId.putIfAbsent(targetKey, () => []).add(photo);
    _addToPhotoCount(targetKey, 1);
    return _ok(201, {'photo': photo, 'urlExpiresAt': '2026-10-10T04:12:45.000Z'});
  }

  /// multipart/form-data の本文を、パートの名前ごとに分ける
  Map<String, _MultipartPart> _parseMultipart(http.Request request) {
    final contentType = request.headers['content-type'] ?? '';
    final boundary = RegExp(r'boundary=(?:"([^"]+)"|([^;]+))').firstMatch(contentType);
    final delimiter = '--${boundary?.group(1) ?? boundary?.group(2)}';
    // バイト列を1文字1バイトの文字列として扱うと、区切りで分けても中身のバイト列を壊さない
    final body = latin1.decode(request.bodyBytes);
    final parts = <String, _MultipartPart>{};
    // 先頭は区切りの前（空）、末尾は閉じの `--`
    for (final raw in body.split(delimiter).skip(1)) {
      if (raw.startsWith('--')) break;
      final headerEnd = raw.indexOf('\r\n\r\n');
      final headers = raw.substring(0, headerEnd);
      final content = raw.substring(headerEnd + 4, raw.length - 2);
      final name = RegExp(r'name="([^"]*)"').firstMatch(headers)!.group(1)!;
      final filename = RegExp(r'filename="([^"]*)"').firstMatch(headers)?.group(1);
      parts[name] = _MultipartPart(filename, latin1.encode(content));
    }
    return parts;
  }

  http.Response _deletePhoto(http.Request request) {
    final photoId = request.url.pathSegments.last;
    final sourceKey = photosByTripId.keys
        .where((key) => photosByTripId[key]!.any((photo) => photo['id'] == photoId))
        .firstOrNull;
    if (sourceKey == null) return _error(404, 'PHOTO_NOT_FOUND', '指定された写真が見つかりません');
    photosByTripId[sourceKey]!.removeWhere((photo) => photo['id'] == photoId);
    _addToPhotoCount(sourceKey, -1);
    return _ok(200, {'message': '写真が正常に削除されました'});
  }

  http.Response _movePhotos(http.Request request) {
    final body = json.decode(request.body) as Map<String, dynamic>;
    final photoIds = (body['photoIds'] as List<dynamic>).cast<String>();
    final tripId = body['tripId'] as String?;
    final targetKey = tripId ?? 'none';
    // 実際のサーバと同じ上限と順（検証が先、旅行の有無が後。docs/travel-album/05_api_design.md §5.5）
    if (photoIds.isEmpty) {
      return _error(400, 'INVALID_REQUEST', '写真IDが指定されていません');
    }
    if (photoIds.length > 200) {
      return _error(400, 'INVALID_REQUEST', '一度に移動できる写真は200枚までです');
    }
    // 外すときも `tripId: null` を明示する。キーが無いのは取り違えとして断る（実際のサーバの 7）
    if (!body.containsKey('tripId')) {
      return _error(400, 'INVALID_REQUEST', '移動先の旅行が指定されていません');
    }
    if (tripId != null && _find(tripId) == null) return _notFound();
    final moved = <String>[];
    final notFound = <String>[];
    for (final photoId in photoIds) {
      final sourceKey = photosByTripId.keys
          .where((key) => photosByTripId[key]!.any((photo) => photo['id'] == photoId))
          .firstOrNull;
      if (sourceKey == null) {
        notFound.add(photoId);
        continue;
      }
      moved.add(photoId);
      if (sourceKey == targetKey) continue;
      final photo = photosByTripId[sourceKey]!.firstWhere((photo) => photo['id'] == photoId);
      photosByTripId[sourceKey]!.remove(photo);
      photo['tripId'] = tripId;
      photosByTripId.putIfAbsent(targetKey, () => []).add(photo);
      _addToPhotoCount(sourceKey, -1);
      _addToPhotoCount(targetKey, 1);
    }
    return _ok(200, {'moved': moved, 'notFound': notFound});
  }

  /// 旅行（`none` なら旅行に属さない写真）の枚数を [delta] だけ増やす
  void _addToPhotoCount(String key, int delta) {
    if (key == 'none') {
      unassignedPhotoCount += delta;
      return;
    }
    final trip = _find(key);
    if (trip != null) trip['photoCount'] = (trip['photoCount'] as int) + delta;
  }

  http.Response _notFound() => _error(404, 'TRIP_NOT_FOUND', '指定された旅行が見つかりません');

  http.Response _ok(int status, Map<String, Object?> data) =>
      _respond(status, {'success': true, 'data': data});

  http.Response _error(int status, String code, String message) => _respond(status, {
        'success': false,
        'error': {'code': code, 'message': message},
      });

  // サーバの実際のヘッダに合わせる（charset なしの application/json。無いと日本語が化ける）
  http.Response _respond(int status, Map<String, Object?> body) =>
      http.Response(json.encode(body), status, headers: const {'content-type': 'application/json'});
}

// ---------------------------------------------------------------------------
// 旅行のテストが共有する前置き

/// 旅行「北海道 2026秋」の id
const hokkaidoTripId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

/// 旅行「北海道 2026秋」（[photoCount] 枚、2026/10/05 〜 2026/10/08）の JSON
Map<String, Object?> hokkaidoTrip({int photoCount = 12, String? description}) {
  return tripJson(
    id: hokkaidoTripId,
    name: '北海道 2026秋',
    description: description,
    photoCount: photoCount,
    firstTakenAt: '2026-10-05T09:00:00',
    lastTakenAt: '2026-10-08T17:30:00',
  );
}

/// ダイアログ（`Dialog`。`AlertDialog` を含む）の中で [matching] を探す。
/// 「旅行を作る」「削除」などの文言は、画面の他の場所にも出るので、ダイアログの中に絞って探す
Finder inDialog(Finder matching) => find.descendant(of: find.byType(Dialog), matching: matching);

/// ダイアログの [label] のボタンをタップして、画面を進める
Future<void> tapInDialog(WidgetTester tester, String label) async {
  await tester.tap(inDialog(find.text(label)));
  await letFramesRun(tester);
}

/// ダイアログの旅行名の欄（最初の入力欄）に [name] を入れる
Future<void> enterTripName(WidgetTester tester, String name) async {
  await tester.enterText(inDialog(find.byType(TextField)).first, name);
}

/// ダイアログのメモの欄（2つ目の入力欄）に [memo] を入れる
Future<void> enterTripMemo(WidgetTester tester, String memo) async {
  await tester.enterText(inDialog(find.byType(TextField)).at(1), memo);
}

/// 旅行詳細画面のメニューから「編集」を選んで、編集ダイアログを開く
Future<void> openEditDialog(WidgetTester tester) async {
  await tester.tap(find.byIcon(Icons.more_vert));
  await letFramesRun(tester);
  await tester.tap(find.text('編集'));
  await letFramesRun(tester);
}

/// 旅行詳細画面のメニューから「削除」を選んで、削除の確認ダイアログを開く
Future<void> openDeleteDialog(WidgetTester tester) async {
  await tester.tap(find.byIcon(Icons.more_vert));
  await letFramesRun(tester);
  await tester.tap(find.text('削除'));
  await letFramesRun(tester);
}

/// 撮影日時 [label]（例 `2026年10月5日 12:30`）を読み上げ用ラベルに持つサムネイル。
/// 画像そのものはテスト環境で読み込めないので、どの写真かはこのラベルで見分ける（`tester.ensureSemantics()` が要る）。
/// ラベルに他の文言（画像の読み込み失敗の表示など）が続いていても一致するよう、部分一致で探す
Finder photoThumbnail(String label) => find.bySemanticsLabel(RegExp(RegExp.escape(label)));

/// multipart/form-data の1パート。ファイルのパートは [filename] を持つ
class _MultipartPart {
  _MultipartPart(this.filename, this.bytes);

  final String? filename;
  final List<int> bytes;

  /// テキストのパートの値
  String get text => utf8.decode(bytes);
}

/// 端末に API キーを保存した状態でアプリ全体を開き、旅行タブに切り替える。
/// 偽のサーバは API キーを照合するので、保存するキーは [backend] の `functionKey`（既定の 'saved-key'）。
/// 図鑑タブの GET /api/plants は 404 になるが、図鑑タブは隠れていて、旅行タブの表示に影響しない
Future<void> openTripsTab(WidgetTester tester, FakeTripBackend backend) async {
  useSecureStorage(TestFlutterSecureStoragePlatform({'api_key': backend.functionKey}));
  SharedPreferences.setMockInitialValues({});
  await saveTestEndpoint(tester);
  await openApp(tester, app: SnapPlantApp(httpClient: backend.client));
  await tester.tap(find.text('旅行'));
  await letFramesRun(tester);
}
