import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// アプリ設定を管理するサービスクラス
/// APIキーなどの機密情報はFlutterSecureStorageに保存
/// その他の設定はSharedPreferencesに保存
class SettingsService {
  static const String _apiKeyKey = 'api_key';
  static const String _apiEndpointKey = 'api_endpoint';

  static const _secureStorage = FlutterSecureStorage(
    aOptions: AndroidOptions(
      encryptedSharedPreferences: true,
    ),
  );

  static SettingsService? _instance;
  SharedPreferences? _prefs;

  SettingsService._();

  static Future<SettingsService> getInstance() async {
    if (kDebugMode) {
      debugPrint('SettingsService: getInstance開始');
    }
    _instance ??= SettingsService._();
    if (_instance!._prefs == null) {
      if (kDebugMode) {
        debugPrint('SettingsService: SharedPreferences初期化開始');
      }
      _instance!._prefs = await SharedPreferences.getInstance();
      if (kDebugMode) {
        debugPrint('SettingsService: SharedPreferences初期化完了');
      }
    }
    if (kDebugMode) {
      debugPrint('SettingsService: getInstance完了');
    }
    return _instance!;
  }

  /// APIキーを保存（セキュアストレージ）
  Future<void> saveApiKey(String apiKey) async {
    try {
      if (kDebugMode) {
        debugPrint('SettingsService: APIキー保存開始');
      }
      await _secureStorage.write(key: _apiKeyKey, value: apiKey);
      if (kDebugMode) {
        debugPrint('SettingsService: APIキー保存完了');
      }
    } catch (e) {
      if (kDebugMode) {
        debugPrint('SettingsService: APIキー保存エラー: $e');
      }
      // Web環境でSecureStorageが動作しない場合のフォールバック
      if (kIsWeb) {
        if (kDebugMode) {
          debugPrint('SettingsService: Web環境でのフォールバック保存');
        }
        await _prefs!.setString(_apiKeyKey, apiKey);
      } else {
        rethrow;
      }
    }
  }

  /// APIキーを取得（セキュアストレージ）
  Future<String?> getApiKey() async {
    try {
      if (kDebugMode) {
        debugPrint('SettingsService: APIキー取得開始');
      }
      final apiKey = await _secureStorage.read(key: _apiKeyKey);
      if (kDebugMode) {
        debugPrint(
            'SettingsService: APIキー取得完了: ${apiKey != null ? "あり" : "なし"}');
      }
      return apiKey;
    } catch (e) {
      if (kDebugMode) {
        debugPrint('SettingsService: APIキー取得エラー: $e');
      }
      // Web環境でSecureStorageが動作しない場合のフォールバック
      if (kIsWeb) {
        if (kDebugMode) {
          debugPrint('SettingsService: Web環境でのフォールバック処理');
        }
        return _prefs!.getString(_apiKeyKey);
      }
      rethrow;
    }
  }

  /// APIキーを削除（セキュアストレージ）
  Future<void> deleteApiKey() async {
    await _secureStorage.delete(key: _apiKeyKey);
  }

  /// APIエンドポイントを保存
  Future<void> saveApiEndpoint(String endpoint) async {
    await _prefs!.setString(_apiEndpointKey, endpoint);
  }

  /// APIエンドポイントを取得。未保存なら null
  ///
  /// 既定値は持たない（本番の URL をアプリに組み込まない）。API キーと同じく利用者が設定画面で入力する
  String? getApiEndpoint() {
    return _prefs!.getString(_apiEndpointKey);
  }

  /// APIエンドポイントをリセット
  Future<void> resetApiEndpoint() async {
    await _prefs!.remove(_apiEndpointKey);
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
