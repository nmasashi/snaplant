import 'dart:convert';
import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:http_parser/http_parser.dart';
import '../models/api_response.dart';
import '../models/catalog.dart';
import '../models/photo.dart';
import '../models/timeline.dart';
import '../models/trip.dart';
import '../utils/image_mime_type.dart';

/// Azure Functions API との通信を担当するサービスクラス
/// Function Key認証を使用してAPIにアクセス
class ApiService {
  final String baseUrl;
  final String? functionKey;
  final http.Client _client;
  // 自分で作った client だけを閉じる。渡された client は渡した側のもので、閉じると渡した側が使い回せなくなる
  final bool _ownsClient;

  /// [baseUrl] は設定画面で利用者が入れたエンドポイント。本番の URL をアプリに組み込まないので既定値は持たない
  ApiService({
    required this.baseUrl,
    this.functionKey,
    http.Client? client,
  })  : _client = client ?? http.Client(),
        _ownsClient = client == null;

  /// API リクエストのヘッダーを取得
  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ..._keyHeader,
      };

  /// 関数キーのヘッダ。URL のクエリ（?code=）では送らない。URL は例外の文言やログに出やすいため（docs/05_api_design.md §9.1）
  ///
  /// ヘッダに入れられない文字（全角文字・改行など）があるキーは送らずに 401 と同じ例外にする。
  /// そのまま送ると http が FormatException を投げ、その文言にキーがそのまま入る（docs/03_screen_design.md §9.2）
  Map<String, String> get _keyHeader {
    final key = functionKey;
    if (key == null || key.isEmpty) return const {};
    if (key.codeUnits.any((unit) => unit < 0x21 || unit > 0x7E)) {
      throw const ApiException(
        statusCode: 401,
        message: 'APIキーに使えない文字が含まれています',
      );
    }
    return {'x-functions-key': key};
  }

  /// 要求の URL を組み立てる
  String _buildUrl(String endpoint) => Uri.parse('$baseUrl$endpoint').toString();

  /// HTTP レスポンスをパース
  T _parseResponse<T>(
    http.Response response,
    T Function(Map<String, dynamic>) fromJson,
  ) {
    if (response.statusCode >= 200 && response.statusCode < 300) {
      final jsonData = json.decode(response.body) as Map<String, dynamic>;
      return fromJson(jsonData);
    } else {
      throw ApiException.fromResponse(response);
    }
  }

  /// エラーハンドリング
  ///
  /// 例外の文言には宛先の URL が入りうる（http の ClientException は uri を持つ）。関数キーは URL に載せずヘッダで送るので、
  /// 文言をそのまま写しても関数キーは入らない（docs/03_screen_design.md §9.2）
  ApiException _handleError(dynamic error) {
    final text = error.toString();
    // デバッグ用ログ出力
    if (kDebugMode) {
      debugPrint('ApiService Error: ${error.runtimeType} - $text');
    }

    if (error is ApiException) {
      return error;
    } else if (error is SocketException && !kIsWeb) {
      // Web環境ではSocketExceptionを異なって処理
      return ApiException(
        statusCode: 0,
        message: 'ネットワークに接続できません',
        body: error.message,
      );
    } else if (error is FormatException) {
      return ApiException(
        statusCode: 0,
        message: 'レスポンスの形式が無効です',
        body: error.message,
      );
    } else if (text.contains('XMLHttpRequest')) {
      // Web環境でのCORSやネットワークエラー（BrowserClient の ClientException もここで見分ける）
      return ApiException(
        statusCode: 0,
        message: 'API接続エラーが発生しました',
        body: text,
      );
    } else if (text.contains('NetworkException') ||
        text.contains('Failed host lookup') ||
        error is http.ClientException) {
      // 接続できない・途中で切れたときに http の IOClient が包む例外（ClientException）も、通信の失敗として扱う
      return ApiException(
        statusCode: 0,
        message: 'ネットワークに接続できません',
        body: text,
      );
    } else {
      // Web環境では多くのエラーが一般的な例外として扱われる
      if (kIsWeb) {
        return ApiException(
          statusCode: 0,
          message: 'API通信でエラーが発生しました',
          body: text,
        );
      }
      return ApiException(
        statusCode: 0,
        message: 'エラー詳細: ${error.runtimeType} - $text',
        body: text,
      );
    }
  }

  /// 旅行一覧取得（旅行に属さない写真の枚数も同じ応答で返る）
  /// GET /api/trips
  Future<TripList> getTrips() async {
    try {
      final url = _buildUrl('/api/trips');
      final response = await _client.get(Uri.parse(url), headers: _headers);
      return _parseResponse(response, (json) {
        final data = json['data'] as Map<String, dynamic>;
        return TripList(
          trips: (data['trips'] as List<dynamic>)
              .map((e) => TripSummary.fromJson(e as Map<String, dynamic>))
              .toList(),
          unassignedPhotoCount: data['unassignedPhotoCount'] as int,
        );
      });
    } catch (error) {
      throw _handleError(error);
    }
  }

  /// 旅行詳細取得（枚数・撮影期間つき）
  /// GET /api/trips/{tripId}
  Future<TripSummary> getTrip(String tripId) async {
    try {
      final url = _buildUrl('/api/trips/$tripId');
      final response = await _client.get(Uri.parse(url), headers: _headers);
      return _parseResponse(response, (json) {
        final data = json['data'] as Map<String, dynamic>;
        return TripSummary.fromJson(data['trip'] as Map<String, dynamic>);
      });
    } catch (error) {
      throw _handleError(error);
    }
  }

  /// 旅行作成
  /// POST /api/trips
  Future<Trip> createTrip(String name, String? description) async {
    try {
      final url = _buildUrl('/api/trips');
      final response = await _client.post(
        Uri.parse(url),
        headers: _headers,
        body: json.encode({'name': name, 'description': description}),
      );
      return _parseResponse(response, (json) {
        final data = json['data'] as Map<String, dynamic>;
        return Trip.fromJson(data['trip'] as Map<String, dynamic>);
      });
    } catch (error) {
      throw _handleError(error);
    }
  }

  /// 旅行更新（旅行名とメモの全体置き換え。メモを省くと消える）
  /// PUT /api/trips/{tripId}
  Future<Trip> updateTrip(
      String tripId, String name, String? description) async {
    try {
      final url = _buildUrl('/api/trips/$tripId');
      final response = await _client.put(
        Uri.parse(url),
        headers: _headers,
        body: json.encode({'name': name, 'description': description}),
      );
      return _parseResponse(response, (json) {
        final data = json['data'] as Map<String, dynamic>;
        return Trip.fromJson(data['trip'] as Map<String, dynamic>);
      });
    } catch (error) {
      throw _handleError(error);
    }
  }

  /// 旅行削除。中の写真を消すか、旅行に属さない写真に移すかを [deletePhotos] で選ぶ
  /// DELETE /api/trips/{tripId}?deletePhotos=true|false
  ///
  /// サーバは deletePhotos を必須にしている（省略時の既定で写真が消える・残る事故を防ぐため）
  Future<TripDeleteResult> deleteTrip(String tripId,
      {required bool deletePhotos}) async {
    try {
      final url = _buildUrl('/api/trips/$tripId?deletePhotos=$deletePhotos');
      final response = await _client.delete(Uri.parse(url), headers: _headers);
      return _parseResponse(response, (json) {
        final data = json['data'] as Map<String, dynamic>;
        return TripDeleteResult(
          deletedPhotoCount: data['deletedPhotoCount'] as int,
          detachedPhotoCount: data['detachedPhotoCount'] as int,
        );
      });
    } catch (error) {
      throw _handleError(error);
    }
  }

  /// 写真の一覧の1ページ取得（撮影日時順）
  /// GET /api/photos?tripId=<旅行 id か none>&category=<カテゴリ>&continuationToken=<前のページのトークン>
  ///
  /// 続きがあるかは枚数ではなく、返る継続トークンが null かどうかで判断する（最後のページが空のこともある）
  Future<PhotoPage> getPhotos(
      {required String tripId,
      String? category,
      String? continuationToken}) async {
    // アプリが読むのは旅行（旅行に属さない写真は none）の一覧と、その中のカテゴリの絞り込みだけなので、tripId は必須にしている。
    // 旅行をまたいでカテゴリだけで読む画面は消した（docs/03_screen_design.md §5.2。旅行をまたいで見るのは図鑑。
    // API の category だけの絞り込みは、接続テストが自分で URL を組んで使う）
    try {
      // 旅行（tripId。旅行に属さない写真は none）で絞り、カテゴリがあれば AND で絞る
      final query = {
        'tripId': tripId,
        if (category != null) 'category': category,
        if (continuationToken != null) 'continuationToken': continuationToken,
      };
      final url = _buildUrl('/api/photos?${Uri(queryParameters: query).query}');
      final response = await _client.get(Uri.parse(url), headers: _headers);
      return _parseResponse(response, (json) {
        final data = json['data'] as Map<String, dynamic>;
        return PhotoPage(
          photos: (data['photos'] as List<dynamic>)
              .map((e) => Photo.fromJson(e as Map<String, dynamic>))
              .toList(),
          continuationToken: data['continuationToken'] as String?,
        );
      });
    } catch (error) {
      throw _handleError(error);
    }
  }

  /// 図鑑の種類の一覧（定義表の順）
  /// GET /api/catalog/kinds
  Future<List<CatalogKind>> getCatalogKinds() async {
    try {
      final response = await _client.get(Uri.parse(_buildUrl('/api/catalog/kinds')), headers: _headers);
      return _parseResponse(response, (json) {
        final data = json['data'] as Map<String, dynamic>;
        return (data['kinds'] as List<dynamic>)
            .map((e) => CatalogKind.fromJson(e as Map<String, dynamic>))
            .toList();
      });
    } catch (error) {
      throw _handleError(error);
    }
  }

  /// 図鑑の項目の一覧の1ページ（名前順。[offset] 件目から [limit] 件）
  /// GET /api/catalog/entries?kind=<種類>&offset=<何件目から>&limit=<何件まで>
  ///
  /// サーバは数えてから見出しを読むまでに写真が無くなった項目をページから外すので、件数が [limit] より少なくても続きがあることがある。
  /// 次のページは [offset] を [limit] だけ進めて読み、[CatalogEntryPage.total] 以上になったら読み切り（docs/03_screen_design.md §6.1）
  Future<CatalogEntryPage> getCatalogEntries(String kind, {required int offset, required int limit}) async {
    try {
      final query = {'kind': kind, 'offset': '$offset', 'limit': '$limit'};
      final url = _buildUrl('/api/catalog/entries?${Uri(queryParameters: query).query}');
      final response = await _client.get(Uri.parse(url), headers: _headers);
      return _parseResponse(response, (json) {
        final data = json['data'] as Map<String, dynamic>;
        return CatalogEntryPage(
          entries: (data['entries'] as List<dynamic>)
              .map((e) => CatalogEntry.fromJson(e as Map<String, dynamic>))
              .toList(),
          total: data['total'] as int,
        );
      });
    } catch (error) {
      throw _handleError(error);
    }
  }

  /// 図鑑の項目の詳細（見出しと、その項目の写真の1ページ）
  /// GET /api/catalog/entry
  ///
  /// その種類と名前の写真が無ければ `entry` は null（写真も空）。続きのページは [continuationToken] で読む
  Future<CatalogEntryDetail> getCatalogEntry(String kind, String name, {String? continuationToken}) async {
    try {
      // 名前は利用者が付けたものではなく AI が返したもので、記号や空白も入りうる。クエリの値としてエンコードする
      final query = {
        'kind': kind,
        'name': name,
        if (continuationToken != null) 'continuationToken': continuationToken,
      };
      final url = _buildUrl('/api/catalog/entry?${Uri(queryParameters: query).query}');
      final response = await _client.get(Uri.parse(url), headers: _headers);
      return _parseResponse(response, (json) {
        final data = json['data'] as Map<String, dynamic>;
        final entry = data['entry'] as Map<String, dynamic>?;
        return CatalogEntryDetail(
          entry: entry == null ? null : CatalogEntry.fromJson(entry),
          photos: PhotoPage(
            photos: (data['photos'] as List<dynamic>)
                .map((e) => Photo.fromJson(e as Map<String, dynamic>))
                .toList(),
            continuationToken: data['continuationToken'] as String?,
          ),
        );
      });
    } catch (error) {
      throw _handleError(error);
    }
  }

  /// 写真を1枚読む（タイムラインのサムネイルから写真ビューアを開くとき）
  /// GET /api/photos/{photoId}
  Future<Photo> getPhoto(String photoId) async {
    try {
      final url = _buildUrl('/api/photos/$photoId');
      final response = await _client.get(Uri.parse(url), headers: _headers);
      return _parseResponse(response, (json) {
        final data = json['data'] as Map<String, dynamic>;
        return Photo.fromJson(data['photo'] as Map<String, dynamic>);
      });
    } catch (error) {
      throw _handleError(error);
    }
  }

  /// 旅行のタイムライン（完成版と下書きの状態）を読む
  /// GET /api/trips/{tripId}/timeline
  Future<TimelineOverview> getTimeline(String tripId) async {
    try {
      final url = _buildUrl('/api/trips/$tripId/timeline');
      final response = await _client.get(Uri.parse(url), headers: _headers);
      return _parseResponse(response,
          _overviewOf);
    } catch (error) {
      throw _handleError(error);
    }
  }

  /// タイムラインの下書きの状態を読む（作っている間の読み直し）。下書きが無ければ null
  /// GET /api/trips/{tripId}/timeline/draft
  Future<TimelineDraftStatus?> getTimelineDraft(String tripId) async {
    try {
      final url = _buildUrl('/api/trips/$tripId/timeline/draft');
      final response = await _client.get(Uri.parse(url), headers: _headers);
      return _parseResponse(response, (json) => _draftOf(json));
    } catch (error) {
      throw _handleError(error);
    }
  }

  /// タイムラインを作る・作り直す（区切りの案から）。受け付けた下書きの状態を返す
  /// POST /api/trips/{tripId}/timeline
  Future<TimelineDraftStatus> createTimeline(String tripId) =>
      _postForDraft('/api/trips/$tripId/timeline');

  /// 完成版の区切りを直し始める（完成版の区切りを写した確かめ中の下書きを作る）。作った下書き（日と場面つき）を返す
  /// POST /api/trips/{tripId}/timeline/recut
  Future<TimelineDraftStatus> recutTimeline(String tripId) =>
      _postForDraft('/api/trips/$tripId/timeline/recut');

  /// 下書きの区切りを保存する（場面の最初の写真の id を撮影の順に）。保存した後の下書き（日と場面つき）を返す
  /// PUT /api/trips/{tripId}/timeline/draft/scenes
  Future<TimelineDraftStatus> saveTimelineScenes(
      String tripId, List<String> sceneStarts) async {
    try {
      final url = _buildUrl('/api/trips/$tripId/timeline/draft/scenes');
      final response = await _client.put(Uri.parse(url),
          headers: _headers, body: jsonEncode({'sceneStarts': sceneStarts}));
      return _parseResponse(response, (json) => _draftOf(json)!);
    } catch (error) {
      throw _handleError(error);
    }
  }

  /// 下書きの区切りで見出しと一言を書かせる。受け付けた下書きの状態を返す
  /// POST /api/trips/{tripId}/timeline/draft/write
  Future<TimelineDraftStatus> writeTimeline(String tripId) =>
      _postForDraft('/api/trips/$tripId/timeline/draft/write');

  /// タイムラインの下書きをやめる（作っている途中でも）。応答は読まない（画面が続けてタイムラインを読み直す）
  /// DELETE /api/trips/{tripId}/timeline/draft
  Future<void> discardTimelineDraft(String tripId) async {
    try {
      final url = _buildUrl('/api/trips/$tripId/timeline/draft');
      final response = await _client.delete(Uri.parse(url), headers: _headers);
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw ApiException.fromResponse(response);
      }
    } catch (error) {
      throw _handleError(error);
    }
  }

  /// ボディの無い POST を送り、受け付けた下書き（`data.draft`）を返す（作る・区切りを直す・文を書く受付）
  Future<TimelineDraftStatus> _postForDraft(String path) async {
    try {
      final url = _buildUrl(path);
      final response = await _client.post(Uri.parse(url), headers: _headers);
      return _parseResponse(response, (json) => _draftOf(json)!);
    } catch (error) {
      throw _handleError(error);
    }
  }

  /// 完成版の日の文を直す（[changes] は `title`・`summary` のうち変えた欄。null なら AI の文に戻す）。直した後のタイムラインを返す
  /// PATCH /api/trips/{tripId}/timeline/days/{date}
  Future<TimelineOverview> updateTimelineDay(
          String tripId, String date, Map<String, String?> changes) =>
      _patchTimelineText('/api/trips/$tripId/timeline/days/$date', changes);

  /// 完成版の場面の文を直す（[changes] は `label`・`note` のうち変えた欄。null なら AI の文に戻す）。直した後のタイムラインを返す
  /// PATCH /api/trips/{tripId}/timeline/scenes/{photoId}
  Future<TimelineOverview> updateTimelineScene(
          String tripId, String photoId, Map<String, String?> changes) =>
      _patchTimelineText(
          '/api/trips/$tripId/timeline/scenes/$photoId', changes);

  /// 残せなかった文の知らせを閉じる。閉じた後のタイムラインを返す
  /// DELETE /api/trips/{tripId}/timeline/dropped-edits
  Future<TimelineOverview> dismissTimelineDroppedEdits(String tripId) async {
    try {
      final url = _buildUrl('/api/trips/$tripId/timeline/dropped-edits');
      final response = await _client.delete(Uri.parse(url), headers: _headers);
      return _parseResponse(response,
          _overviewOf);
    } catch (error) {
      throw _handleError(error);
    }
  }

  /// 文を直す PATCH を送り、応答（`GET …/timeline` と同じ形）を読む
  Future<TimelineOverview> _patchTimelineText(
      String path, Map<String, String?> changes) async {
    try {
      final url = _buildUrl(path);
      final response = await _client.patch(Uri.parse(url),
          headers: _headers, body: jsonEncode(changes));
      return _parseResponse(response,
          _overviewOf);
    } catch (error) {
      throw _handleError(error);
    }
  }

  /// 応答の封筒からタイムライン（`data`。`GET …/timeline` の形）を読む。文を直す・残せなかった文を閉じる応答も同じ形
  TimelineOverview _overviewOf(Map<String, dynamic> json) =>
      TimelineOverview.fromJson(json['data'] as Map<String, dynamic>);

  /// 応答の封筒から下書き（`data.draft`）を読む
  TimelineDraftStatus? _draftOf(Map<String, dynamic> json) {
    final draft = (json['data'] as Map<String, dynamic>)['draft']
        as Map<String, dynamic>?;
    return draft == null ? null : TimelineDraftStatus.fromJson(draft);
  }

  /// 写真をまとめて旅行に入れる（[tripId] が null なら旅行から外す）
  /// POST /api/photos/move
  ///
  /// 外すときも tripId のキーは省かずに null を送る（サーバは省略を取り違えとして 400 にする）。
  /// サーバは1回に [_maxMovePhotoIds] 件までなので、超える分は分けて順に送り、結果を合わせて返す。
  /// 途中で失敗したら例外を投げる（送れた分は移っている。同じ写真を送り直しても同じ結果になる）
  Future<PhotoMoveResult> movePhotos(
      List<String> photoIds, String? tripId) async {
    final moved = <String>[];
    final notFound = <String>[];
    for (var start = 0; start < photoIds.length; start += _maxMovePhotoIds) {
      final end = (start + _maxMovePhotoIds).clamp(0, photoIds.length);
      final result =
          await _movePhotoChunk(photoIds.sublist(start, end), tripId);
      moved.addAll(result.moved);
      notFound.addAll(result.notFound);
    }
    return PhotoMoveResult(moved: moved, notFound: notFound);
  }

  /// 写真を1枚送る（同じ [photoId] を何度送っても1枚になる）
  /// POST /api/photos（multipart/form-data）
  ///
  /// 任意の値は、無ければパートごと省く（空文字のパートは「指定あり」として検証され 400 になる）
  Future<Photo> uploadPhoto({
    required String photoId,
    required Uint8List bytes,
    String? tripId,
    String? takenAt,
    double? latitude,
    double? longitude,
    Uint8List? thumbnail,
    String? placeName,
  }) async {
    try {
      final url = _buildUrl('/api/photos');
      final request = http.MultipartRequest('POST', Uri.parse(url));
      // Content-Type は multipart の境界付きのものを MultipartRequest が付けるので、関数キーのヘッダだけを足す
      request.headers.addAll(_keyHeader);
      request.fields['photoId'] = photoId;
      if (tripId != null) request.fields['tripId'] = tripId;
      if (takenAt != null) request.fields['takenAt'] = takenAt;
      // 10進で送る（サーバは指数表記を受け付けない）。緯度・経度は両方そろえる（片方だけは 400）
      if (latitude != null && longitude != null) {
        request.fields['latitude'] = latitude.toStringAsFixed(6);
        request.fields['longitude'] = longitude.toStringAsFixed(6);
        // 地名は緯度・経度と一緒にだけ送る（無ければ 400）。無ければパートごと省く
        if (placeName != null) request.fields['placeName'] = placeName;
      }
      request.files.add(http.MultipartFile.fromBytes(
        'image',
        bytes,
        filename: 'photo',
        contentType: MediaType.parse(detectImageMimeType(bytes)),
      ));
      if (thumbnail != null) {
        request.files.add(http.MultipartFile.fromBytes(
          'thumbnail',
          thumbnail,
          filename: 'thumbnail.jpg',
          contentType: MediaType('image', 'jpeg'),
        ));
      }
      final response =
          await http.Response.fromStream(await _client.send(request));
      return _parseResponse(response, (json) {
        final data = json['data'] as Map<String, dynamic>;
        return Photo.fromJson(data['photo'] as Map<String, dynamic>);
      });
    } catch (error) {
      throw _handleError(error);
    }
  }

  /// 写真削除（原寸・サムネイルも消える）
  /// DELETE /api/photos/{photoId}
  Future<void> deletePhoto(String photoId) async {
    try {
      final url = _buildUrl('/api/photos/$photoId');
      final response = await _client.delete(Uri.parse(url), headers: _headers);
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw ApiException.fromResponse(response);
      }
    } catch (error) {
      throw _handleError(error);
    }
  }

  /// 写真の解析のやり直しを頼む（受け付けるだけで、解析はサーバが後で行う）
  /// POST /api/photos/{photoId}/process
  ///
  /// [step] は `classify`（カテゴリから）か `identify`（カテゴリはそのままで名前だけ。図鑑の種類の写真だけ）。
  /// [hint] は利用者からの手がかり。空白だけなら送らない。受け付けた写真（解析の待ち）を返す
  Future<Photo> requestPhotoProcessing(String photoId, {String? hint, String step = 'classify'}) async {
    try {
      final url = _buildUrl('/api/photos/$photoId/process');
      final trimmed = hint?.trim() ?? '';
      final response = await _client.post(
        Uri.parse(url),
        headers: _headers,
        body: json.encode({
          'step': step,
          if (trimmed.isNotEmpty) 'hint': trimmed,
        }),
      );
      return _parseResponse(response, (json) {
        final data = json['data'] as Map<String, dynamic>;
        return Photo.fromJson(data['photo'] as Map<String, dynamic>);
      });
    } catch (error) {
      throw _handleError(error);
    }
  }

  /// 写真のコメントを直す（利用者のコメントになる）
  /// PATCH /api/photos/{photoId}
  ///
  /// 空・空白だけならコメントを消す（サーバが null と同じに扱う）。直した写真を返す
  Future<Photo> updatePhotoComment(String photoId, String comment) async {
    try {
      final url = _buildUrl('/api/photos/$photoId');
      final response = await _client.patch(
        Uri.parse(url),
        headers: _headers,
        body: json.encode({'comment': comment}),
      );
      return _parseResponse(response, (json) {
        final data = json['data'] as Map<String, dynamic>;
        return Photo.fromJson(data['photo'] as Map<String, dynamic>);
      });
    } catch (error) {
      throw _handleError(error);
    }
  }

  /// `POST /api/photos/move` の上限（サーバの `MOVE_MAX_IDS` の既定値）
  static const _maxMovePhotoIds = 200;

  /// [movePhotos] の1回分の要求
  Future<PhotoMoveResult> _movePhotoChunk(
      List<String> photoIds, String? tripId) async {
    try {
      final url = _buildUrl('/api/photos/move');
      final response = await _client.post(
        Uri.parse(url),
        headers: _headers,
        body: json.encode({'photoIds': photoIds, 'tripId': tripId}),
      );
      return _parseResponse(response, (json) {
        final data = json['data'] as Map<String, dynamic>;
        return PhotoMoveResult(
          moved: List<String>.from(data['moved'] as List<dynamic>),
          notFound: List<String>.from(data['notFound'] as List<dynamic>),
        );
      });
    } catch (error) {
      throw _handleError(error);
    }
  }

  /// 接続テスト
  Future<bool> testConnection() async {
    try {
      // エンドポイント・キーに加えて、サーバがデータベースとストレージに届くかまで確かめる。
      // - 図鑑の種類の一覧は定義表を返すだけで、データベースの設定が誤っていても成功する
      // - 1件の読み取り（旅行の詳細など）は、Cosmos の SDK がコンテナ・データベースが無いときの 404 も「見つからない」にまとめるので、設定の誤りが成功に見える
      // - 旅行の一覧は全部の旅行と写真を集計して重い
      // 旅行をまたぐ写真の一覧を1件だけ読む（クエリなので、コンテナが無ければ失敗する。写真があれば URL に署名するのでストレージの設定も通る）
      final url = _buildUrl('/api/photos?${Uri(queryParameters: {'category': 'plant', 'limit': '1'}).query}');
      final response = await _client.get(
        Uri.parse(url),
        headers: _headers,
      );
      return response.statusCode >= 200 && response.statusCode < 300;
    } catch (error) {
      return false;
    }
  }

  /// リソースのクリーンアップ
  void dispose() {
    if (_ownsClient) {
      _client.close();
    }
  }
}

/// API例外クラス
class ApiException implements Exception {
  final int statusCode;

  /// サーバが封筒の `error.code` で返したエラーコード。封筒を読めなかった場合は null
  final String? code;
  final String message;
  final String? body;

  const ApiException({
    required this.statusCode,
    this.code,
    required this.message,
    this.body,
  });

  /// 非 2xx のレスポンスから例外を作る
  ///
  /// サーバのエラーは `{ success: false, error: { code, message } }` の封筒で返る。
  /// ただし 401 は Azure Functions ランタイムが返すため封筒にならないなど、
  /// 読めないボディもありうるので、その場合はステータスだけを持たせる。
  factory ApiException.fromResponse(http.Response response) {
    ApiError? error;
    try {
      final envelope = ApiResponse<void>.fromJson(
        json.decode(response.body) as Map<String, dynamic>,
        (_) {},
      );
      error = envelope.error;
    } catch (_) {
      error = null;
    }
    return ApiException(
      statusCode: response.statusCode,
      code: error?.code,
      message:
          error?.message ?? 'サーバーでエラーが発生しました（ステータス: ${response.statusCode}）',
      body: response.body,
    );
  }

  bool get isNetworkError => statusCode == 0;
  bool get isAuthError => statusCode == 401;
  bool get isNotFound => statusCode == 404;

  /// 旅行が無い（404 `TRIP_NOT_FOUND`）。別の端末で消された、送信中に消されたなど
  bool get isTripNotFound => code == 'TRIP_NOT_FOUND';

  /// タイムラインが読んだ後に変わった（409 `TIMELINE_STATE_CONFLICT`、または下書きが別の端末でやめられた・書き終えた 404 `TIMELINE_NOT_FOUND`）。
  /// 画面は読み直す（docs/03_screen_design.md §8.1）
  bool get isTimelineChanged =>
      code == 'TIMELINE_STATE_CONFLICT' || code == 'TIMELINE_NOT_FOUND';

  /// タイムラインを作れない写真の状態（409 `TIMELINE_PHOTOS_PROCESSING`・`TIMELINE_NO_DATED_PHOTOS`）。画面は文言を出して読み直す
  bool get isTimelineNotCreatable =>
      code == 'TIMELINE_PHOTOS_PROCESSING' ||
      code == 'TIMELINE_NO_DATED_PHOTOS';

  /// 写真が無い（404 `PHOTO_NOT_FOUND`）。別の端末で消されたなど。
  /// ステータスだけで見ると、宛先の誤り（封筒の無い 404）まで「消せた」と数えてしまうので、コードで判定する
  bool get isPhotoNotFound => code == 'PHOTO_NOT_FOUND';

  @override
  String toString() {
    return 'ApiException(statusCode: $statusCode, message: $message)';
  }

  /// ユーザー向けのエラーメッセージを取得
  String get userMessage {
    switch (statusCode) {
      case 0:
        return 'ネットワークに接続できません。インターネット接続を確認してください。';
      case 401:
        return 'APIキーが無効です。設定を確認してください。';
      case 404:
        return '要求されたデータが見つかりません。';
      // アプリはレート制限を実装していないが、従量課金プランの Functions ランタイムが
      // 過負荷時に封筒なしの 429 "Too Busy" を返す（host.json の dynamicThrottlesEnabled 等の既定値）。
      // 利用者の操作回数の制限ではないので、「制限を超えた」ではなく混雑として伝える
      case 429:
        return 'サーバーが混雑しています。しばらく待ってから再試行してください。';
      case 500:
        return 'サーバーで問題が発生しています。しばらく待ってから再試行してください。';
      // サーバは 502 と 503 の意味を分けている。502 は上流（AI・ストレージ）に到達したが
      // エラー応答だった状態で、すぐ再試行しても同じ結果になりやすい。
      // 503 は上流に到達できなかった状態で、時間を置けば回復しうる
      case 502:
        return '外部サービスでエラーが発生しました。繰り返し発生する場合は、時間を置いてからお試しください。';
      case 503:
        return 'サービスに一時的に接続できません。しばらく待ってから再試行してください。';
      default:
        return message;
    }
  }
}
