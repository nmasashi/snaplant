import 'dart:convert';
import 'dart:io';
import 'package:http/http.dart' as http;
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
    if (error is ApiException) {
      return error;
    } else if (error is SocketException) {
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
    } else {
      return ApiException(
        statusCode: 0,
        message: '予期しないエラーが発生しました',
        body: error.toString(),
      );
    }
  }
  
  /// 画像アップロード
  /// POST /api/upload
  Future<UploadResult> uploadImage(File imageFile) async {
    try {
      final url = _buildUrl('/api/upload');
      final request = http.MultipartRequest('POST', Uri.parse(url));
      
      // 画像ファイルを追加
      request.files.add(
        await http.MultipartFile.fromPath(
          'image',
          imageFile.path,
          filename: 'plant_image.jpg',
        ),
      );
      
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
  /// POST /api/checkDuplicate
  Future<DuplicateCheckResult> checkDuplicate(String plantName) async {
    try {
      final url = _buildUrl('/api/checkDuplicate');
      final response = await _client.post(
        Uri.parse(url),
        headers: _headers,
        body: json.encode({'name': plantName}),
      );
      
      return _parseResponse(
        response,
        (json) => DuplicateCheckResult.fromJson(json),
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
        (json) => Plant.fromJson(json['plant']),
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
          final plants = json['plants'] as List<dynamic>;
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
        (json) => Plant.fromJson(json['plant']),
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
        (json) => Plant.fromJson(json['plant']),
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