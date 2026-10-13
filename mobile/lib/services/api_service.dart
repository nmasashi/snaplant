import 'dart:convert';
import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:http_parser/http_parser.dart';
import '../models/plant.dart';
import '../models/api_response.dart';
import '../models/photo.dart';
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
      };

  /// Function Key付きのURLを構築
  String _buildUrl(String endpoint) {
    final uri = Uri.parse('$baseUrl$endpoint');
    if (functionKey != null && functionKey!.isNotEmpty) {
      return uri.replace(queryParameters: {
        ...uri.queryParameters,
        'code': functionKey!,
      }).toString();
    }
    return uri.toString();
  }

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
  ApiException _handleError(dynamic error) {
    // デバッグ用ログ出力
    if (kDebugMode) {
      debugPrint('ApiService Error: ${error.runtimeType} - $error');
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
    } else if (error.toString().contains('XMLHttpRequest')) {
      // Web環境でのCORSやネットワークエラー
      return ApiException(
        statusCode: 0,
        message: 'API接続エラーが発生しました',
        body: error.toString(),
      );
    } else if (error.toString().contains('NetworkException') ||
        error.toString().contains('Failed host lookup')) {
      return ApiException(
        statusCode: 0,
        message: 'ネットワークに接続できません',
        body: error.toString(),
      );
    } else {
      // Web環境では多くのエラーが一般的な例外として扱われる
      if (kIsWeb) {
        return ApiException(
          statusCode: 0,
          message: 'API通信でエラーが発生しました',
          body: error.toString(),
        );
      }
      return ApiException(
        statusCode: 0,
        message: 'エラー詳細: ${error.runtimeType} - ${error.toString()}',
        body: error.toString(),
      );
    }
  }

  /// 画像アップロードとAI識別を統合実行
  /// POST /api/images/upload（docsワークフローに準拠）
  Future<Map<String, dynamic>> uploadAndIdentifyImage(dynamic imageFile,
      {String? contextInfo}) async {
    try {
      if (kDebugMode) {
        debugPrint('ApiService: uploadAndIdentifyImage開始');
        debugPrint('ApiService: imageFile type: ${imageFile.runtimeType}');
      }

      final url = _buildUrl('/api/images/upload');
      final request = http.MultipartRequest('POST', Uri.parse(url));

      // Web環境とモバイル環境で異なる処理
      if (kIsWeb) {
        // Web環境の場合、Uint8Listを期待
        if (imageFile is Uint8List) {
          if (kDebugMode) {
            debugPrint('ApiService: Web環境 - 画像サイズ: ${imageFile.length} bytes');
          }
          request.files.add(
            http.MultipartFile.fromBytes(
              'image',
              imageFile,
              filename: 'plant_image.jpg',
              contentType: MediaType.parse(detectImageMimeType(imageFile)),
            ),
          );
        } else {
          throw ArgumentError('Web環境では画像データはUint8Listである必要があります');
        }
      } else {
        // モバイル環境の場合、Fileを期待
        if (imageFile is File) {
          final fileSize = await imageFile.length();
          if (kDebugMode) {
            debugPrint('ApiService: モバイル環境 - ファイルパス: ${imageFile.path}');
            debugPrint('ApiService: モバイル環境 - 画像サイズ: $fileSize bytes');
          }

          // 拡張子ではなく中身のシグネチャで判定する。判定に必要なのは先頭12バイトだけ
          final header = await imageFile
              .openRead(0, 12)
              .fold<List<int>>(<int>[], (bytes, chunk) => bytes..addAll(chunk));
          final mimeType = detectImageMimeType(Uint8List.fromList(header));

          if (kDebugMode) {
            debugPrint('ApiService: 検出MIMEタイプ: $mimeType');
          }

          request.files.add(
            await http.MultipartFile.fromPath(
              'image',
              imageFile.path,
              filename: 'plant_image.jpg',
              contentType: MediaType.parse(mimeType),
            ),
          );
        } else {
          throw ArgumentError('モバイル環境では画像データはFileである必要があります');
        }
      }

      // コンテキスト情報がある場合は追加
      if (contextInfo != null && contextInfo.isNotEmpty) {
        request.fields['contextInfo'] = contextInfo;
        if (kDebugMode) {
          debugPrint('ApiService: コンテキスト情報追加: $contextInfo');
        }
      }

      if (kDebugMode) {
        debugPrint('ApiService: HTTP リクエスト送信開始');
      }

      final streamedResponse = await _client.send(request);
      final response = await http.Response.fromStream(streamedResponse);

      if (kDebugMode) {
        debugPrint('ApiService: HTTPレスポンス受信 - ステータス: ${response.statusCode}');
        debugPrint('ApiService: レスポンスボディ長: ${response.body.length}');
        if (response.statusCode != 200) {
          debugPrint('ApiService: エラーレスポンス: ${response.body}');
        }
      }

      return _parseResponse(
        response,
        (json) {
          if (kDebugMode) {
            debugPrint('ApiService: レスポンス解析開始');
            debugPrint('ApiService: json keys: ${json.keys}');
          }
          final data = json['data'] as Map<String, dynamic>;
          if (kDebugMode) {
            debugPrint('ApiService: data keys: ${data.keys}');
          }
          return {
            'uploadResult': UploadResult(
              imagePath: data['imagePath'] as String,
              imageUrl: data['imagePath'] as String,
            ),
            'identificationResult':
                IdentificationResult.fromJson(data['identificationResult']),
          };
        },
      );
    } catch (error) {
      if (kDebugMode) {
        debugPrint('ApiService: uploadAndIdentifyImage エラー: $error');
      }
      throw _handleError(error);
    }
  }

  /// 重複チェック
  /// GET /api/plants/check-duplicate（docsワークフローに準拠）
  Future<DuplicateCheckResult> checkDuplicate(String plantName) async {
    try {
      final url = _buildUrl(
          '/api/plants/check-duplicate?name=${Uri.encodeComponent(plantName)}');
      final response = await _client.get(
        Uri.parse(url),
        headers: _headers,
      );

      return _parseResponse(
        response,
        (json) {
          if (kDebugMode) {
            debugPrint('ApiService: 重複チェックレスポンス: $json');
          }
          final data = json['data'] as Map<String, dynamic>?;
          if (data == null) {
            throw ApiException(
              statusCode: 0,
              message: 'レスポンスデータが無効です',
              body: json.toString(),
            );
          }
          if (kDebugMode) {
            debugPrint('ApiService: 重複チェックdata: $data');
          }
          return DuplicateCheckResult.fromJson(data);
        },
      );
    } catch (error) {
      throw _handleError(error);
    }
  }

  /// 植物保存
  /// POST /api/plants/save
  Future<Plant> savePlant(PlantCreateRequest request) async {
    try {
      final url = _buildUrl('/api/plants/save');
      final response = await _client.post(
        Uri.parse(url),
        headers: _headers,
        body: json.encode(request.toJson()),
      );

      return _parseResponse(
        response,
        (json) {
          final data = json['data'] as Map<String, dynamic>?;
          if (data == null) {
            throw ApiException(
              statusCode: 0,
              message: 'レスポンスデータが無効です',
              body: json.toString(),
            );
          }
          return Plant.fromJson(data['plant']);
        },
      );
    } catch (error) {
      throw _handleError(error);
    }
  }

  /// 植物一覧取得
  /// GET /api/plants
  Future<List<PlantSummary>> getPlants() async {
    try {
      final url = _buildUrl('/api/plants');
      final response = await _client.get(
        Uri.parse(url),
        headers: _headers,
      );

      return _parseResponse(
        response,
        (json) {
          if (kDebugMode) {
            debugPrint('ApiService: レスポンス内容: $json');
          }
          final data = json['data'] as Map<String, dynamic>?;
          if (data == null) {
            if (kDebugMode) {
              debugPrint('ApiService: dataがnullのため空リストを返す');
            }
            return <PlantSummary>[];
          }
          final plants = data['plants'] as List<dynamic>?;
          if (plants == null) {
            if (kDebugMode) {
              debugPrint('ApiService: plantsがnullのため空リストを返す');
            }
            return <PlantSummary>[];
          }
          return plants
              .map((e) => PlantSummary.fromJson(e as Map<String, dynamic>))
              .toList();
        },
      );
    } catch (error) {
      throw _handleError(error);
    }
  }

  /// 植物詳細取得
  /// GET /api/plants/{id}
  Future<Plant> getPlant(String id) async {
    try {
      final url = _buildUrl('/api/plants/$id');
      final response = await _client.get(
        Uri.parse(url),
        headers: _headers,
      );

      return _parseResponse(
        response,
        (json) {
          if (kDebugMode) {
            debugPrint('ApiService: 植物詳細レスポンス: $json');
          }
          final data = json['data'] as Map<String, dynamic>?;
          if (data == null) {
            throw ApiException(
              statusCode: 0,
              message: 'レスポンスデータが無効です',
              body: json.toString(),
            );
          }
          return Plant.fromJson(data['plant']);
        },
      );
    } catch (error) {
      throw _handleError(error);
    }
  }

  /// 植物更新
  /// PUT /api/plants/{id}
  Future<Plant> updatePlant(
      String id, String imagePath, double confidence) async {
    try {
      final url = _buildUrl('/api/plants/$id');
      final response = await _client.put(
        Uri.parse(url),
        headers: _headers,
        body: json.encode({
          'imagePath': imagePath,
          'confidence': confidence,
        }),
      );

      return _parseResponse(
        response,
        (json) {
          final data = json['data'] as Map<String, dynamic>?;
          if (data == null) {
            throw ApiException(
              statusCode: 0,
              message: 'レスポンスデータが無効です',
              body: json.toString(),
            );
          }
          return Plant.fromJson(data['plant']);
        },
      );
    } catch (error) {
      throw _handleError(error);
    }
  }

  /// 植物削除
  /// DELETE /api/plants/{id}
  Future<void> deletePlant(String id) async {
    try {
      final url = _buildUrl('/api/plants/$id');
      final response = await _client.delete(
        Uri.parse(url),
        headers: _headers,
      );

      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw ApiException.fromResponse(response);
      }
    } catch (error) {
      throw _handleError(error);
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
  /// GET /api/photos?tripId=<旅行 id か none>&continuationToken=<前のページのトークン>
  ///
  /// 続きがあるかは枚数ではなく、返る継続トークンが null かどうかで判断する（最後のページが空のこともある）
  Future<PhotoPage> getPhotos(String tripId,
      {String? continuationToken}) async {
    try {
      final query = {
        'tripId': tripId,
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

  /// 写真をまとめて旅行に入れる（[tripId] が null なら旅行から外す）
  /// POST /api/photos/move
  ///
  /// 外すときも tripId のキーは省かずに null を送る（サーバは省略を取り違えとして 400 にする）
  Future<PhotoMoveResult> movePhotos(
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
      final url = _buildUrl('/api/plants');
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

  /// 同じ画像が既に保存されている（409 `IMAGE_ALREADY_SAVED`）
  ///
  /// 保存は成功したがレスポンスが届かず、その後に別の候補（別の名前）で保存し直した場合に起きる。
  /// 同じ候補で保存し直すと、名前の重複確認が既存の植物を見つけて更新（PUT）に進み、
  /// PUT は自分自身を重複から除外するので 409 にはならない。
  /// 同じ 409 でも `DATABASE_ERROR` は本当の失敗なので、ステータスではなくコードで判定する
  bool get isImageAlreadySaved => code == 'IMAGE_ALREADY_SAVED';

  /// 旅行が無い（404 `TRIP_NOT_FOUND`）。別の端末で消された、送信中に消されたなど
  bool get isTripNotFound => code == 'TRIP_NOT_FOUND';

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
