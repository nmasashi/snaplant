import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// アプリ設定を管理するサービスクラス
/// APIキーなどの機密情報はFlutterSecureStorageに保存
/// その他の設定はSharedPreferencesに保存
class SettingsService {
  static const String _apiKeyKey = 'api_key';
  static const String _apiEndpointKey = 'api_endpoint';
  static const String _defaultEndpoint = 'https://func-snaplant-mk0w7s38.azurewebsites.net';
  
  static const _secureStorage = FlutterSecureStorage(
    aOptions: AndroidOptions(
      encryptedSharedPreferences: true,
    ),
  );
  
  static SettingsService? _instance;
  SharedPreferences? _prefs;
  
  SettingsService._();
  
  static Future<SettingsService> getInstance() async {
    _instance ??= SettingsService._();
    _instance!._prefs ??= await SharedPreferences.getInstance();
    return _instance!;
  }
  
  /// APIキーを保存（セキュアストレージ）
  Future<void> saveApiKey(String apiKey) async {
    await _secureStorage.write(key: _apiKeyKey, value: apiKey);
  }
  
  /// APIキーを取得（セキュアストレージ）
  Future<String?> getApiKey() async {
    return await _secureStorage.read(key: _apiKeyKey);
  }
  
  /// APIキーを削除（セキュアストレージ）
  Future<void> deleteApiKey() async {
    await _secureStorage.delete(key: _apiKeyKey);
  }
  
  /// APIエンドポイントを保存
  Future<void> saveApiEndpoint(String endpoint) async {
    await _prefs!.setString(_apiEndpointKey, endpoint);
  }
  
  /// APIエンドポイントを取得
  String getApiEndpoint() {
    return _prefs!.getString(_apiEndpointKey) ?? _defaultEndpoint;
  }
  
  /// APIエンドポイントをリセット
  Future<void> resetApiEndpoint() async {
    await _prefs!.remove(_apiEndpointKey);
  }
  
  /// API設定が完了しているかチェック
  Future<bool> isApiConfigured() async {
    final apiKey = await getApiKey();
    final endpoint = getApiEndpoint();
    return apiKey != null && apiKey.isNotEmpty && endpoint.isNotEmpty;
  }
  
  /// 初回起動時の設定チェック
  Future<bool> isFirstLaunch() async {
    const key = 'first_launch';
    final isFirst = _prefs!.getBool(key) ?? true;
    if (isFirst) {
      await _prefs!.setBool(key, false);
    }
    return isFirst;
  }
  
  /// アプリ設定をリセット
  Future<void> resetAllSettings() async {
    await _secureStorage.deleteAll();
    await _prefs!.clear();
  }
  
  /// デバッグ用: 現在の設定を取得
  Future<Map<String, dynamic>> getDebugInfo() async {
    final hasApiKey = await getApiKey() != null;
    return {
      'hasApiKey': hasApiKey,
      'apiEndpoint': getApiEndpoint(),
      'isFirstLaunch': await isFirstLaunch(),
    };
  }
}