import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:http_parser/http_parser.dart';
import '../models/plant.dart';
import '../models/api_response.dart';

/// Azure Functions API との通信を担当するサービスクラス
/// Function Key認証を使用してAPIにアクセス
class ApiService {
  static const String _defaultBaseUrl = 'https://func-snaplant-mk0w7s38.azurewebsites.net';
  
  final String baseUrl;
  final String? functionKey;
  final http.Client _client;
  
  ApiService({
    String? baseUrl,
    this.functionKey,
    http.Client? client,
  })  : baseUrl = baseUrl ?? _defaultBaseUrl,
        _client = client ?? http.Client();
  
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
      throw ApiException(
        statusCode: response.statusCode,
        message: 'API request failed',
        body: response.body,
      );
    }
  }
  
  /// エラーハンドリング
  ApiException _handleError(dynamic error) {
    // デバッグ用ログ出力
    if (kDebugMode) {
      print('ApiService Error: ${error.runtimeType} - $error');
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
  Future<Map<String, dynamic>> uploadAndIdentifyImage(dynamic imageFile) async {
    try {
      if (kDebugMode) {
        print('ApiService: uploadAndIdentifyImage開始');
        print('ApiService: imageFile type: ${imageFile.runtimeType}');
      }
      
      final url = _buildUrl('/api/images/upload');
      final request = http.MultipartRequest('POST', Uri.parse(url));
      
      // Web環境とモバイル環境で異なる処理
      if (kIsWeb) {
        // Web環境の場合、Uint8Listを期待
        if (imageFile is Uint8List) {
          if (kDebugMode) {
            print('ApiService: Web環境 - 画像サイズ: ${imageFile.length} bytes');
          }
          request.files.add(
            http.MultipartFile.fromBytes(
              'image',
              imageFile,
              filename: 'plant_image.jpg',
              contentType: MediaType('image', 'jpeg'),
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
            print('ApiService: モバイル環境 - ファイルパス: ${imageFile.path}');
            print('ApiService: モバイル環境 - 画像サイズ: $fileSize bytes');
          }
          
          // ファイル拡張子からMIMEタイプを判定
          String mimeType = 'image/jpeg';
          final extension = imageFile.path.toLowerCase();
          if (extension.endsWith('.png')) {
            mimeType = 'image/png';
          } else if (extension.endsWith('.gif')) {
            mimeType = 'image/gif';
          } else if (extension.endsWith('.webp')) {
            mimeType = 'image/webp';
          }
          
          if (kDebugMode) {
            print('ApiService: 検出MIMEタイプ: $mimeType');
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
      
      if (kDebugMode) {
        print('ApiService: HTTP リクエスト送信開始');
      }
      
      final streamedResponse = await _client.send(request);
      final response = await http.Response.fromStream(streamedResponse);
      
      if (kDebugMode) {
        print('ApiService: HTTPレスポンス受信 - ステータス: ${response.statusCode}');
        print('ApiService: レスポンスボディ長: ${response.body.length}');
        if (response.statusCode != 200) {
          print('ApiService: エラーレスポンス: ${response.body}');
        }
      }
      
      return _parseResponse(
        response,
        (json) {
          if (kDebugMode) {
            print('ApiService: レスポンス解析開始');
            print('ApiService: json keys: ${json.keys}');
          }
          final data = json['data'] as Map<String, dynamic>;
          if (kDebugMode) {
            print('ApiService: data keys: ${data.keys}');
          }
          return {
            'uploadResult': UploadResult(
              imagePath: data['imagePath'] as String,
              imageUrl: data['imagePath'] as String,
            ),
            'identificationResult': IdentificationResult.fromJson(data['identificationResult']),
          };
        },
      );
    } catch (error) {
      if (kDebugMode) {
        print('ApiService: uploadAndIdentifyImage エラー: $error');
      }
      throw _handleError(error);
    }
  }

  /// 画像アップロード（従来版・互換性のため残存）
  /// POST /api/upload
  Future<UploadResult> uploadImage(dynamic imageFile) async {
    try {
      final url = _buildUrl('/api/images/upload');
      final request = http.MultipartRequest('POST', Uri.parse(url));
      
      // Web環境とモバイル環境で異なる処理
      if (kIsWeb) {
        // Web環境の場合、Uint8Listを期待
        if (imageFile is Uint8List) {
          request.files.add(
            http.MultipartFile.fromBytes(
              'image',
              imageFile,
              filename: 'plant_image.jpg',
            ),
          );
        } else {
          throw ArgumentError('Web環境では画像データはUint8Listである必要があります');
        }
      } else {
        // モバイル環境の場合、Fileを期待
        if (imageFile is File) {
          request.files.add(
            await http.MultipartFile.fromPath(
              'image',
              imageFile.path,
              filename: 'plant_image.jpg',
            ),
          );
        } else {
          throw ArgumentError('モバイル環境では画像データはFileである必要があります');
        }
      }
      
      final streamedResponse = await _client.send(request);
      final response = await http.Response.fromStream(streamedResponse);
      
      return _parseResponse(
        response,
        (json) => UploadResult.fromJson(json),
      );
    } catch (error) {
      throw _handleError(error);
    }
  }
  
  /// 植物識別
  /// POST /api/identify
  Future<IdentificationResult> identifyPlant(String imagePath) async {
    try {
      final url = _buildUrl('/api/identify');
      final response = await _client.post(
        Uri.parse(url),
        headers: _headers,
        body: json.encode({'imagePath': imagePath}),
      );
      
      return _parseResponse(
        response,
        (json) => IdentificationResult.fromJson(json),
      );
    } catch (error) {
      throw _handleError(error);
    }
  }
  
  /// 重複チェック
  /// GET /api/plants/check-duplicate（docsワークフローに準拠）
  Future<DuplicateCheckResult> checkDuplicate(String plantName) async {
    try {
      final url = _buildUrl('/api/plants/check-duplicate?name=${Uri.encodeComponent(plantName)}');
      final response = await _client.get(
        Uri.parse(url),
        headers: _headers,
      );
      
      return _parseResponse(
        response,
        (json) {
          if (kDebugMode) {
            print('ApiService: 重複チェックレスポンス: $json');
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
            print('ApiService: 重複チェックdata: $data');
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
            print('ApiService: レスポンス内容: $json');
          }
          final data = json['data'] as Map<String, dynamic>?;
          if (data == null) {
            if (kDebugMode) {
              print('ApiService: dataがnullのため空リストを返す');
            }
            return <PlantSummary>[];
          }
          final plants = data['plants'] as List<dynamic>?;
          if (plants == null) {
            if (kDebugMode) {
              print('ApiService: plantsがnullのため空リストを返す');
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
            print('ApiService: 植物詳細レスポンス: $json');
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
  Future<Plant> updatePlant(String id, String imagePath, double confidence) async {
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
        throw ApiException(
          statusCode: response.statusCode,
          message: '植物の削除に失敗しました',
          body: response.body,
        );
      }
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
    _client.close();
  }
}

/// API例外クラス
class ApiException implements Exception {
  final int statusCode;
  final String message;
  final String? body;
  
  const ApiException({
    required this.statusCode,
    required this.message,
    this.body,
  });
  
  bool get isNetworkError => statusCode == 0;
  bool get isAuthError => statusCode == 401;
  bool get isNotFound => statusCode == 404;
  bool get isServerError => statusCode >= 500;
  
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
      case 429:
        return 'リクエスト数が制限を超えました。しばらく待ってから再試行してください。';
      case 500:
      case 502:
      case 503:
        return 'サーバーで問題が発生しています。しばらく待ってから再試行してください。';
      default:
        return message;
    }
  }
}