import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../services/api_service.dart';
import '../services/settings_service.dart';
import '../theme/app_colors.dart';
import '../theme/app_text_styles.dart';

/// 設定画面
/// APIキーとエンドポイントの設定、接続テスト機能を提供
/// 1440×2960画面サイズに最適化されたレスポンシブデザイン
class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  final _formKey = GlobalKey<FormState>();
  final _apiKeyController = TextEditingController();
  final _endpointController = TextEditingController();
  
  bool _isLoading = true;
  bool _isTesting = false;
  bool _isSaving = false;
  bool _obscureApiKey = true;
  String? _connectionStatus;
  
  SettingsService? _settingsService;

  @override
  void initState() {
    super.initState();
    _initializeSettings();
  }

  /// 設定の初期化
  Future<void> _initializeSettings() async {
    try {
      _settingsService = await SettingsService.getInstance();
      
      // 現在の設定を読み込み
      final apiKey = await _settingsService!.getApiKey();
      final endpoint = _settingsService!.getApiEndpoint();
      
      setState(() {
        _apiKeyController.text = apiKey ?? '';
        _endpointController.text = endpoint;
        _isLoading = false;
      });
    } catch (e) {
      setState(() {
        _isLoading = false;
      });
      _showErrorSnackBar('設定の読み込みに失敗しました');
    }
  }

  /// 設定の保存
  Future<void> _saveSettings() async {
    if (!_formKey.currentState!.validate() || _settingsService == null) {
      return;
    }

    setState(() {
      _isSaving = true;
    });

    try {
      // APIキーを保存
      await _settingsService!.saveApiKey(_apiKeyController.text.trim());
      
      // エンドポイントを保存
      await _settingsService!.saveApiEndpoint(_endpointController.text.trim());
      
      setState(() {
        _isSaving = false;
      });

      _showSuccessSnackBar('設定を保存しました');
      
      // 保存成功を親画面に通知
      Navigator.pop(context, true);
      
    } catch (e) {
      setState(() {
        _isSaving = false;
      });
      _showErrorSnackBar('設定の保存に失敗しました');
    }
  }

  /// 接続テスト
  Future<void> _testConnection() async {
    if (_apiKeyController.text.trim().isEmpty || 
        _endpointController.text.trim().isEmpty) {
      _showErrorSnackBar('APIキーとエンドポイントを入力してください');
      return;
    }

    setState(() {
      _isTesting = true;
      _connectionStatus = null;
    });

    try {
      final apiService = ApiService(
        baseUrl: _endpointController.text.trim(),
        functionKey: _apiKeyController.text.trim(),
      );

      final isConnected = await apiService.testConnection();
      
      setState(() {
        _isTesting = false;
        _connectionStatus = isConnected ? 'success' : 'failed';
      });

      if (isConnected) {
        _showSuccessSnackBar('接続に成功しました');
      } else {
        _showErrorSnackBar('接続に失敗しました。設定を確認してください。');
      }

      apiService.dispose();
      
    } catch (e) {
      setState(() {
        _isTesting = false;
        _connectionStatus = 'error';
      });
      
      final errorMessage = e is ApiException 
          ? e.userMessage 
          : '接続テストでエラーが発生しました';
      _showErrorSnackBar(errorMessage);
    }
  }

  /// 設定のリセット
  Future<void> _resetSettings() async {
    final confirmed = await _showResetConfirmDialog();
    if (!confirmed || _settingsService == null) return;

    try {
      await _settingsService!.resetAllSettings();
      
      setState(() {
        _apiKeyController.clear();
        _endpointController.text = 'https://func-snaplant-mk0w7s38.azurewebsites.net';
        _connectionStatus = null;
      });

      _showSuccessSnackBar('設定をリセットしました');
      
    } catch (e) {
      _showErrorSnackBar('設定のリセットに失敗しました');
    }
  }

  /// リセット確認ダイアログ
  Future<bool> _showResetConfirmDialog() async {
    final result = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('設定をリセット'),
        content: const Text('すべての設定がリセットされます。この操作は元に戻せません。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('キャンセル'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            style: TextButton.styleFrom(
              foregroundColor: AppColors.error,
            ),
            child: const Text('リセット'),
          ),
        ],
      ),
    );
    
    return result ?? false;
  }

  /// 成功メッセージの表示
  void _showSuccessSnackBar(String message) {
    if (!mounted) return;
    
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(message),
        backgroundColor: AppColors.success,
        behavior: SnackBarBehavior.floating,
      ),
    );
  }

  /// エラーメッセージの表示
  void _showErrorSnackBar(String message) {
    if (!mounted) return;
    
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(message),
        backgroundColor: AppColors.error,
        behavior: SnackBarBehavior.floating,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final screenWidth = MediaQuery.of(context).size.width;
    final isLargeScreen = screenWidth >= 1400;
    
    return Scaffold(
      appBar: _buildAppBar(isLargeScreen),
      body: _isLoading 
          ? _buildLoadingView(isLargeScreen)
          : _buildSettingsForm(isLargeScreen),
    );
  }

  /// アプリバーの構築
  PreferredSizeWidget _buildAppBar(bool isLargeScreen) {
    return AppBar(
      title: Text(
        '設定',
        style: AppTextStyles.appBarTitle.copyWith(
          fontSize: isLargeScreen ? 26 : 22,
        ),
      ),
      leading: IconButton(
        icon: Icon(
          Icons.arrow_back,
          size: isLargeScreen ? 28 : 24,
        ),
        onPressed: () => Navigator.pop(context),
      ),
    );
  }

  /// ローディング表示
  Widget _buildLoadingView(bool isLargeScreen) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          SizedBox(
            width: isLargeScreen ? 64 : 48,
            height: isLargeScreen ? 64 : 48,
            child: CircularProgressIndicator(
              strokeWidth: 3,
              valueColor: AlwaysStoppedAnimation(AppColors.primary),
            ),
          ),
          SizedBox(height: isLargeScreen ? 24 : 16),
          Text(
            '設定を読み込み中...',
            style: AppTextStyles.body1.copyWith(
              fontSize: isLargeScreen ? 20 : 18,
              color: AppColors.textSecondary,
            ),
          ),
        ],
      ),
    );
  }

  /// 設定フォームの構築
  Widget _buildSettingsForm(bool isLargeScreen) {
    return SingleChildScrollView(
      padding: EdgeInsets.all(isLargeScreen ? 32 : 24),
      child: Form(
        key: _formKey,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // API設定セクション
            _buildApiSettingsSection(isLargeScreen),
            
            SizedBox(height: isLargeScreen ? 40 : 32),
            
            // アクションボタン
            _buildActionButtons(isLargeScreen),
            
            SizedBox(height: isLargeScreen ? 40 : 32),
            
            // アプリ情報セクション
            _buildAppInfoSection(isLargeScreen),
          ],
        ),
      ),
    );
  }

  /// API設定セクションの構築
  Widget _buildApiSettingsSection(bool isLargeScreen) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'API設定',
          style: AppTextStyles.headline2.copyWith(
            fontSize: isLargeScreen ? 28 : 24,
          ),
        ),
        
        SizedBox(height: isLargeScreen ? 24 : 16),
        
        // APIキー入力
        TextFormField(
          controller: _apiKeyController,
          obscureText: _obscureApiKey,
          decoration: InputDecoration(
            labelText: 'APIキー',
            hintText: 'Azure Functions のAPIキーを入力',
            suffixIcon: IconButton(
              icon: Icon(
                _obscureApiKey ? Icons.visibility : Icons.visibility_off,
              ),
              onPressed: () {
                setState(() {
                  _obscureApiKey = !_obscureApiKey;
                });
              },
            ),
            helperText: 'Azure Portal で取得したFunction Keyを入力してください',
            helperMaxLines: 2,
          ),
          validator: (value) {
            if (value == null || value.trim().isEmpty) {
              return 'APIキーを入力してください';
            }
            if (value.trim().length < 10) {
              return 'APIキーが短すぎます';
            }
            return null;
          },
          onChanged: (_) => setState(() => _connectionStatus = null),
        ),
        
        SizedBox(height: isLargeScreen ? 24 : 16),
        
        // エンドポイント入力
        TextFormField(
          controller: _endpointController,
          decoration: const InputDecoration(
            labelText: 'APIエンドポイント',
            hintText: 'https://your-function-app.azurewebsites.net',
            helperText: 'Azure Functions のエンドポイントURLを入力してください',
            helperMaxLines: 2,
          ),
          validator: (value) {
            if (value == null || value.trim().isEmpty) {
              return 'エンドポイントを入力してください';
            }
            
            try {
              final uri = Uri.parse(value.trim());
              if (!uri.hasScheme || (!uri.scheme.startsWith('http'))) {
                return '有効なURLを入力してください（http://またはhttps://）';
              }
            } catch (e) {
              return '有効なURLを入力してください';
            }
            
            return null;
          },
          onChanged: (_) => setState(() => _connectionStatus = null),
        ),
        
        // 接続ステータス表示
        if (_connectionStatus != null) ...[
          SizedBox(height: isLargeScreen ? 16 : 12),
          _buildConnectionStatus(isLargeScreen),
        ],
      ],
    );
  }

  /// 接続ステータスの構築
  Widget _buildConnectionStatus(bool isLargeScreen) {
    Color statusColor;
    IconData statusIcon;
    String statusText;
    
    switch (_connectionStatus) {
      case 'success':
        statusColor = AppColors.success;
        statusIcon = Icons.check_circle;
        statusText = '接続成功';
        break;
      case 'failed':
        statusColor = AppColors.warning;
        statusIcon = Icons.warning;
        statusText = '接続失敗';
        break;
      case 'error':
        statusColor = AppColors.error;
        statusIcon = Icons.error;
        statusText = '接続エラー';
        break;
      default:
        return const SizedBox.shrink();
    }
    
    return Container(
      padding: EdgeInsets.all(isLargeScreen ? 16 : 12),
      decoration: BoxDecoration(
        color: statusColor.withOpacity(0.1),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(
          color: statusColor.withOpacity(0.3),
          width: 1,
        ),
      ),
      child: Row(
        children: [
          Icon(
            statusIcon,
            color: statusColor,
            size: isLargeScreen ? 24 : 20,
          ),
          SizedBox(width: 8),
          Text(
            statusText,
            style: AppTextStyles.body2.copyWith(
              color: statusColor,
              fontSize: isLargeScreen ? 18 : 16,
              fontWeight: FontWeight.w600,
            ),
          ),
        ],
      ),
    );
  }

  /// アクションボタンの構築
  Widget _buildActionButtons(bool isLargeScreen) {
    return Column(
      children: [
        Row(
          children: [
            Expanded(
              child: OutlinedButton.icon(
                onPressed: _isTesting ? null : _testConnection,
                icon: _isTesting 
                    ? SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : Icon(Icons.wifi_find),
                label: Text(_isTesting ? 'テスト中...' : '接続テスト'),
                style: OutlinedButton.styleFrom(
                  padding: EdgeInsets.symmetric(
                    vertical: isLargeScreen ? 20 : 16,
                  ),
                ),
              ),
            ),
            SizedBox(width: isLargeScreen ? 20 : 16),
            Expanded(
              child: ElevatedButton.icon(
                onPressed: _isSaving ? null : _saveSettings,
                icon: _isSaving 
                    ? SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          valueColor: AlwaysStoppedAnimation(Colors.white),
                        ),
                      )
                    : Icon(Icons.save),
                label: Text(_isSaving ? '保存中...' : '保存'),
                style: ElevatedButton.styleFrom(
                  padding: EdgeInsets.symmetric(
                    vertical: isLargeScreen ? 20 : 16,
                  ),
                ),
              ),
            ),
          ],
        ),
        
        SizedBox(height: isLargeScreen ? 20 : 16),
        
        SizedBox(
          width: double.infinity,
          child: TextButton.icon(
            onPressed: _resetSettings,
            icon: Icon(Icons.refresh, color: AppColors.error),
            label: Text('設定をリセット'),
            style: TextButton.styleFrom(
              foregroundColor: AppColors.error,
              padding: EdgeInsets.symmetric(
                vertical: isLargeScreen ? 16 : 12,
              ),
            ),
          ),
        ),
      ],
    );
  }

  /// アプリ情報セクションの構築
  Widget _buildAppInfoSection(bool isLargeScreen) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'アプリ情報',
          style: AppTextStyles.headline2.copyWith(
            fontSize: isLargeScreen ? 28 : 24,
          ),
        ),
        
        SizedBox(height: isLargeScreen ? 24 : 16),
        
        Card(
          child: Padding(
            padding: EdgeInsets.all(isLargeScreen ? 24 : 20),
            child: Column(
              children: [
                _buildInfoRow(
                  'アプリ名',
                  'SnapPlant',
                  isLargeScreen,
                ),
                SizedBox(height: isLargeScreen ? 16 : 12),
                _buildInfoRow(
                  'バージョン',
                  '1.0.0',
                  isLargeScreen,
                ),
                SizedBox(height: isLargeScreen ? 16 : 12),
                _buildInfoRow(
                  '開発者',
                  'SnapPlant Team',
                  isLargeScreen,
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }

  /// 情報行の構築
  Widget _buildInfoRow(String label, String value, bool isLargeScreen) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        Text(
          label,
          style: AppTextStyles.body1.copyWith(
            fontSize: isLargeScreen ? 20 : 18,
            fontWeight: FontWeight.w500,
          ),
        ),
        Text(
          value,
          style: AppTextStyles.body1.copyWith(
            fontSize: isLargeScreen ? 20 : 18,
            color: AppColors.textSecondary,
          ),
        ),
      ],
    );
  }

  @override
  void dispose() {
    _apiKeyController.dispose();
    _endpointController.dispose();
    super.dispose();
  }
}