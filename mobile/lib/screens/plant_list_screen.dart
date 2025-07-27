import 'package:flutter/material.dart';
import '../models/plant.dart';
import '../services/api_service.dart';
import '../services/settings_service.dart';
import '../widgets/plant_card.dart';
import '../theme/app_colors.dart';
import '../theme/app_text_styles.dart';
import 'camera_screen.dart';
import 'plant_detail_screen.dart';
import 'settings_screen.dart';

/// 植物一覧画面
/// アプリのメイン画面として植物の一覧表示とメニューアクセスを提供
/// 1440×2960画面サイズに最適化されたレスポンシブデザイン
class PlantListScreen extends StatefulWidget {
  const PlantListScreen({super.key});

  @override
  State<PlantListScreen> createState() => _PlantListScreenState();
}

class _PlantListScreenState extends State<PlantListScreen> {
  List<PlantSummary> _plants = [];
  bool _isLoading = true;
  bool _hasError = false;
  String _errorMessage = '';
  ApiService? _apiService;

  @override
  void initState() {
    super.initState();
    _initializeScreen();
  }

  /// 画面初期化
  Future<void> _initializeScreen() async {
    print('PlantListScreen: 初期化開始');
    await _initializeApiService();
    print('PlantListScreen: APIサービス初期化完了');
    await _loadPlants();
    print('PlantListScreen: 植物一覧読み込み完了');
  }

  /// APIサービスの初期化
  Future<void> _initializeApiService() async {
    try {
      print('PlantListScreen: SettingsService取得開始');
      final settingsService = await SettingsService.getInstance();
      print('PlantListScreen: SettingsService取得完了');
      
      print('PlantListScreen: APIキー取得開始');
      final apiKey = await settingsService.getApiKey();
      print('PlantListScreen: APIキー取得完了: ${apiKey?.isNotEmpty == true ? "設定済み" : "未設定"}');
      
      final endpoint = settingsService.getApiEndpoint();
      print('PlantListScreen: エンドポイント: $endpoint');
      
      if (apiKey == null || apiKey.isEmpty) {
        print('PlantListScreen: APIキーが未設定のため設定画面へ遷移');
        // APIキーが設定されていない場合は設定画面へ
        WidgetsBinding.instance.addPostFrameCallback((_) {
          _navigateToSettings();
        });
        return;
      }
      
      print('PlantListScreen: ApiService初期化開始');
      _apiService = ApiService(
        baseUrl: endpoint,
        functionKey: apiKey,
      );
      print('PlantListScreen: ApiService初期化完了');
    } catch (e) {
      print('PlantListScreen: APIサービス初期化エラー: $e');
      setState(() {
        _hasError = true;
        _errorMessage = 'API設定の読み込みに失敗しました';
        _isLoading = false;
      });
    }
  }

  /// 植物一覧の読み込み
  Future<void> _loadPlants() async {
    print('PlantListScreen: _loadPlants開始');
    
    if (_apiService == null) {
      print('PlantListScreen: _apiServiceがnullのため処理をスキップ');
      return;
    }
    
    try {
      print('PlantListScreen: ローディング状態に設定');
      setState(() {
        _isLoading = true;
        _hasError = false;
      });

      print('PlantListScreen: API呼び出し開始');
      final plants = await _apiService!.getPlants();
      print('PlantListScreen: API呼び出し完了: ${plants.length}件の植物を取得');
      
      setState(() {
        _plants = plants;
        _isLoading = false;
      });
      print('PlantListScreen: 状態更新完了');
    } catch (e) {
      print('PlantListScreen: 植物一覧読み込みエラー: $e');
      setState(() {
        _hasError = true;
        _errorMessage = e is ApiException ? e.userMessage : '植物一覧の読み込みに失敗しました';
        _isLoading = false;
      });
      print('PlantListScreen: エラー状態に設定完了');
    }
  }

  /// 植物一覧のリフレッシュ
  Future<void> _refreshPlants() async {
    await _loadPlants();
  }

  /// 設定画面への遷移
  Future<void> _navigateToSettings() async {
    final result = await Navigator.push(
      context,
      MaterialPageRoute(builder: (context) => const SettingsScreen()),
    );
    
    // 設定から戻ってきた場合は再初期化
    if (result == true) {
      await _initializeScreen();
    }
  }

  /// 画像選択画面への遷移
  Future<void> _navigateToImagePicker() async {
    if (_apiService == null) {
      _showErrorSnackBar('API設定が完了していません');
      return;
    }
    
    final result = await Navigator.push(
      context,
      MaterialPageRoute(
        builder: (context) => CameraScreen(apiService: _apiService!),
      ),
    );
    
    // 画像選択から戻ってきて新しい植物が保存された場合はリフレッシュ
    if (result == true) {
      await _refreshPlants();
    }
  }

  /// 植物詳細画面への遷移
  Future<void> _navigateToPlantDetail(PlantSummary plantSummary) async {
    if (_apiService == null) return;
    
    await Navigator.push(
      context,
      MaterialPageRoute(
        builder: (context) => PlantDetailScreen(
          plantId: plantSummary.id,
          apiService: _apiService!,
        ),
      ),
    );
    
    // 詳細画面から戻ってきた場合はリフレッシュ（削除された可能性があるため）
    await _refreshPlants();
  }

  /// エラースナックバーの表示
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
      body: _buildBody(isLargeScreen),
      floatingActionButton: _buildFloatingActionButton(isLargeScreen),
    );
  }

  /// アプリバーの構築
  PreferredSizeWidget _buildAppBar(bool isLargeScreen) {
    return AppBar(
      title: Row(
        children: [
          Icon(
            Icons.eco,
            color: AppColors.textOnPrimary,
            size: isLargeScreen ? 28 : 24,
          ),
          SizedBox(width: 8),
          Text(
            'SnapPlant',
            style: AppTextStyles.appBarTitle.copyWith(
              fontSize: isLargeScreen ? 26 : 22,
            ),
          ),
        ],
      ),
      actions: [
        IconButton(
          icon: Icon(
            Icons.settings,
            size: isLargeScreen ? 28 : 24,
          ),
          onPressed: _navigateToSettings,
          tooltip: '設定',
        ),
        SizedBox(width: isLargeScreen ? 16 : 8),
      ],
      elevation: 2,
    );
  }

  /// ボディの構築
  Widget _buildBody(bool isLargeScreen) {
    if (_isLoading) {
      return _buildLoadingView(isLargeScreen);
    }
    
    if (_hasError) {
      return _buildErrorView(isLargeScreen);
    }
    
    if (_plants.isEmpty) {
      return _buildEmptyView(isLargeScreen);
    }
    
    return _buildPlantsList(isLargeScreen);
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
            '植物一覧を読み込み中...',
            style: AppTextStyles.body1.copyWith(
              fontSize: isLargeScreen ? 20 : 18,
              color: AppColors.textSecondary,
            ),
          ),
        ],
      ),
    );
  }

  /// エラー表示
  Widget _buildErrorView(bool isLargeScreen) {
    return Center(
      child: Padding(
        padding: EdgeInsets.all(isLargeScreen ? 32 : 24),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              Icons.error_outline,
              size: isLargeScreen ? 80 : 64,
              color: AppColors.error,
            ),
            SizedBox(height: isLargeScreen ? 24 : 16),
            Text(
              'エラーが発生しました',
              style: AppTextStyles.headline2.copyWith(
                fontSize: isLargeScreen ? 28 : 24,
                color: AppColors.error,
              ),
            ),
            SizedBox(height: isLargeScreen ? 16 : 12),
            Text(
              _errorMessage,
              style: AppTextStyles.body1.copyWith(
                fontSize: isLargeScreen ? 20 : 18,
              ),
              textAlign: TextAlign.center,
            ),
            SizedBox(height: isLargeScreen ? 32 : 24),
            ElevatedButton.icon(
              onPressed: _refreshPlants,
              icon: Icon(Icons.refresh),
              label: Text('再試行'),
              style: ElevatedButton.styleFrom(
                padding: EdgeInsets.symmetric(
                  horizontal: isLargeScreen ? 32 : 24,
                  vertical: isLargeScreen ? 20 : 16,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// 空の状態表示
  Widget _buildEmptyView(bool isLargeScreen) {
    return Center(
      child: Padding(
        padding: EdgeInsets.all(isLargeScreen ? 32 : 24),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              Icons.eco_outlined,
              size: isLargeScreen ? 120 : 96,
              color: AppColors.textHint,
            ),
            SizedBox(height: isLargeScreen ? 32 : 24),
            Text(
              'まだ植物が登録されていません',
              style: AppTextStyles.headline2.copyWith(
                fontSize: isLargeScreen ? 28 : 24,
                color: AppColors.textSecondary,
              ),
            ),
            SizedBox(height: isLargeScreen ? 16 : 12),
            Text(
              '画像選択ボタンをタップして\n最初の植物を登録しましょう',
              style: AppTextStyles.body1.copyWith(
                fontSize: isLargeScreen ? 20 : 18,
                color: AppColors.textSecondary,
              ),
              textAlign: TextAlign.center,
            ),
            SizedBox(height: isLargeScreen ? 40 : 32),
            ElevatedButton.icon(
              onPressed: _navigateToImagePicker,
              icon: Icon(Icons.photo_library),
              label: Text('画像を選択'),
              style: ElevatedButton.styleFrom(
                padding: EdgeInsets.symmetric(
                  horizontal: isLargeScreen ? 32 : 24,
                  vertical: isLargeScreen ? 20 : 16,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// 植物一覧の構築
  Widget _buildPlantsList(bool isLargeScreen) {
    return RefreshIndicator(
      onRefresh: _refreshPlants,
      color: AppColors.primary,
      child: ListView.builder(
        padding: EdgeInsets.only(
          top: isLargeScreen ? 16 : 8,
          bottom: isLargeScreen ? 100 : 80, // FABとの重複を避ける
        ),
        itemCount: _plants.length,
        itemBuilder: (context, index) {
          final plant = _plants[index];
          return PlantCard(
            plant: plant,
            onTap: () => _navigateToPlantDetail(plant),
          );
        },
      ),
    );
  }

  /// フローティングアクションボタンの構築
  Widget _buildFloatingActionButton(bool isLargeScreen) {
    return FloatingActionButton.extended(
      onPressed: _navigateToImagePicker,
      icon: Icon(
        Icons.photo_library,
        size: isLargeScreen ? 28 : 24,
      ),
      label: Text(
        '画像選択',
        style: TextStyle(
          fontSize: isLargeScreen ? 18 : 16,
          fontWeight: FontWeight.w600,
        ),
      ),
      backgroundColor: AppColors.secondary,
      foregroundColor: AppColors.textOnPrimary,
    );
  }

  @override
  void dispose() {
    _apiService?.dispose();
    super.dispose();
  }
}