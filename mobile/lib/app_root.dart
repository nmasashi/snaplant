import 'dart:async';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'screens/home_shell.dart';
import 'screens/settings_screen.dart';
import 'services/api_service.dart';
import 'services/settings_service.dart';
import 'services/upload_queue.dart';
import 'widgets/message_view.dart';
import 'theme/app_colors.dart';
import 'theme/app_text_styles.dart';

/// アプリの根
///
/// 設定（API キー・エンドポイント）を読み、画面をまたいで共有する [ApiService] と [UploadQueue] を1つ作って下の画面に渡す
/// （docs/travel-album/03_screen_design.md §1「状態の持ち方」）。図鑑と旅行の2タブが同じ設定で通信するため、
/// 各画面が自分で作らない。API キーかエンドポイントが未設定なら、タブの中身の代わりに設定を促す表示を出す
class AppRoot extends StatefulWidget {
  const AppRoot({super.key, this.httpClient});

  /// サーバとの通信に使う HTTP クライアント。テストで偽のサーバを差し込むためのもので、通常は null
  final http.Client? httpClient;

  @override
  State<AppRoot> createState() => _AppRootState();
}

class _AppRootState extends State<AppRoot> {
  ApiService? _apiService;
  // 写真の送信の列。ApiService と一緒に作り直す（古い設定で送り続けないように）
  UploadQueue? _uploadQueue;
  StreamSubscription<int>? _uploadFinished;
  bool _isLoading = true;
  // 保存済みの設定を読めなかった
  bool _settingsLoadFailed = false;

  @override
  void initState() {
    super.initState();
    _loadSettings(openSettingsIfMissing: true);
  }

  /// 設定を読み、[ApiService] を作り直す
  ///
  /// [openSettingsIfMissing] が true なら、API キーかエンドポイントが未設定のとき設定画面へ自動で移る。
  /// 起動時だけ true にする。再試行などで毎回移ると、設定画面から抜けられなくなるため
  Future<void> _loadSettings({required bool openSettingsIfMissing}) async {
    try {
      final settingsService = await SettingsService.getInstance();
      final apiKey = await settingsService.getApiKey();
      final endpoint = settingsService.getApiEndpoint();
      if (!mounted) return;

      // 設定が変わっていなければ作り直さない。作り直すとホームも作り直され、開いていたタブと各タブの状態を失う
      final current = _apiService;
      if (current != null &&
          current.baseUrl == endpoint &&
          current.functionKey == apiKey) {
        setState(() {
          _settingsLoadFailed = false;
          _isLoading = false;
        });
        return;
      }

      // 設定が変わったので作り直す。前の ApiService（の http.Client）を閉じる。
      // 残すと、リセットで消したキーで通信し続ける
      _disposeServices();

      if (apiKey == null ||
          apiKey.isEmpty ||
          endpoint == null ||
          endpoint.isEmpty) {
        // どちらが欠けても通信できないので、扱いは同じ（エンドポイントには既定値が無い）
        setState(() {
          _settingsLoadFailed = false;
          _isLoading = false;
        });
        if (openSettingsIfMissing) {
          WidgetsBinding.instance.addPostFrameCallback((_) => _openSettings());
        }
        return;
      }

      final apiService = ApiService(
          baseUrl: endpoint, functionKey: apiKey, client: widget.httpClient);
      final uploadQueue = UploadQueue(apiService);
      _uploadFinished = uploadQueue.finished.listen(_showUploadFinished);
      setState(() {
        _apiService = apiService;
        _uploadQueue = uploadQueue;
        _settingsLoadFailed = false;
        _isLoading = false;
      });
    } catch (e) {
      debugPrint('AppRoot: 設定の読み込みエラー: $e');
      if (!mounted) return;
      // 前の設定の ApiService が残っていると、古い設定のまま一覧を読み直してしまう
      _disposeServices();
      setState(() {
        _settingsLoadFailed = true;
        _isLoading = false;
      });
    }
  }

  /// [ApiService] と [UploadQueue] を閉じて手放す
  void _disposeServices() {
    _uploadFinished?.cancel();
    _uploadFinished = null;
    _uploadQueue?.dispose();
    _uploadQueue = null;
    _apiService?.dispose();
    _apiService = null;
  }

  /// 送信の列が空になったら、送れた枚数を知らせる（どの画面にいても出す）
  void _showUploadFinished(int count) {
    if (!mounted || count == 0) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text('$count枚を送信しました')));
  }

  /// 設定画面を開き、戻ったら設定を読み直す
  ///
  /// 保存したかどうかに関わらず読み直す。リセットは保存せずにその場で反映され、戻り値も返さないので、
  /// 結果を見て判断すると消したキーで通信し続ける
  Future<void> _openSettings() async {
    await Navigator.push(
      context,
      MaterialPageRoute(builder: (context) => const SettingsScreen()),
    );
    if (!mounted) return;
    await _loadSettings(openSettingsIfMissing: false);
  }

  @override
  Widget build(BuildContext context) {
    final apiService = _apiService;
    final uploadQueue = _uploadQueue;
    if (apiService != null && uploadQueue != null) {
      // 設定が変わって ApiService を作り直したら、画面も作り直して新しい設定で読み直す
      return HomeShell(
        key: ObjectKey(apiService),
        apiService: apiService,
        uploadQueue: uploadQueue,
        onOpenSettings: _openSettings,
      );
    }
    final isLargeScreen = MediaQuery.of(context).size.width >= 1400;
    return Scaffold(
      appBar: AppBar(
        title: const Text('SnapPlant', style: AppTextStyles.appBarTitle),
        actions: [
          IconButton(
              icon: const Icon(Icons.settings),
              onPressed: _openSettings,
              tooltip: '設定'),
        ],
      ),
      body: _isLoading
          ? const Center(
              child: CircularProgressIndicator(
                  valueColor: AlwaysStoppedAnimation(AppColors.primary)))
          : _settingsLoadFailed
              ? MessageView(
                  isLargeScreen: isLargeScreen,
                  icon: Icons.error_outline,
                  title: 'エラーが発生しました',
                  message: 'API設定の読み込みに失敗しました',
                  buttonIcon: Icons.refresh,
                  buttonLabel: '再試行',
                  onPressed: () => _loadSettings(openSettingsIfMissing: false),
                  isError: true,
                )
              : MessageView(
                  isLargeScreen: isLargeScreen,
                  icon: Icons.settings,
                  title: 'API設定が完了していません',
                  message: '設定画面で API キーとエンドポイントを入力してください',
                  buttonIcon: Icons.settings,
                  buttonLabel: '設定を開く',
                  onPressed: _openSettings,
                ),
    );
  }

  @override
  void dispose() {
    _disposeServices();
    super.dispose();
  }
}
