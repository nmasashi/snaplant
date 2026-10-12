import 'package:flutter/material.dart';
import '../models/plant.dart';
import '../services/api_service.dart';
import '../widgets/plant_card.dart';
import '../theme/app_colors.dart';
import '../theme/app_text_styles.dart';
import 'camera_screen.dart';
import 'plant_detail_screen.dart';

/// 植物一覧画面（図鑑タブ）
///
/// 設定の読み込みと [ApiService] の作成はアプリの根（AppRoot）が行い、ここには設定済みの [apiService] が渡る。
/// 設定が変わると AppRoot がこの画面を作り直す。
/// 1440×2960画面サイズに最適化されたレスポンシブデザイン
class PlantListScreen extends StatefulWidget {
  const PlantListScreen({super.key, required this.apiService, required this.onOpenSettings});

  /// 設定済みの API クライアント（AppRoot が持ち、閉じるのも AppRoot）
  final ApiService apiService;

  /// 設定画面を開く（戻った後の読み直しは AppRoot が行う）
  final Future<void> Function() onOpenSettings;

  @override
  State<PlantListScreen> createState() => _PlantListScreenState();
}

class _PlantListScreenState extends State<PlantListScreen> {
  List<PlantSummary> _plants = [];
  bool _isLoading = true;
  bool _hasError = false;
  String _errorMessage = '';

  @override
  void initState() {
    super.initState();
    _loadPlants();
  }

  /// 植物一覧の読み込み
  Future<void> _loadPlants() async {
    try {
      setState(() {
        _isLoading = true;
        _hasError = false;
      });
      final plants = await widget.apiService.getPlants();
      if (!mounted) return;
      setState(() {
        _plants = plants;
        _isLoading = false;
      });
    } catch (e) {
      debugPrint('PlantListScreen: 植物一覧読み込みエラー: $e');
      if (!mounted) return;
      setState(() {
        _hasError = true;
        _errorMessage = e is ApiException ? e.userMessage : '植物一覧の読み込みに失敗しました';
        _isLoading = false;
      });
    }
  }

  /// 植物一覧のリフレッシュ
  Future<void> _refreshPlants() async {
    await _loadPlants();
  }

  /// 画像選択画面への遷移
  Future<void> _navigateToImagePicker() async {
    final result = await Navigator.push(
      context,
      MaterialPageRoute(
        builder: (context) => CameraScreen(apiService: widget.apiService),
      ),
    );

    // 画像選択から戻ってきて新しい植物が保存された場合はリフレッシュ
    if (result == true) {
      await _refreshPlants();
    }
  }

  /// 植物詳細画面への遷移
  Future<void> _navigateToPlantDetail(PlantSummary plantSummary) async {
    await Navigator.push(
      context,
      MaterialPageRoute(
        builder: (context) => PlantDetailScreen(
          plantId: plantSummary.id,
          apiService: widget.apiService,
        ),
      ),
    );
    
    // 詳細画面から戻ってきた場合はリフレッシュ（削除された可能性があるため）
    await _refreshPlants();
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
          const SizedBox(width: 8),
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
          onPressed: widget.onOpenSettings,
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
            child: const CircularProgressIndicator(
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
              onPressed: _loadPlants,
              icon: const Icon(Icons.refresh),
              label: const Text('再試行'),
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
              icon: const Icon(Icons.photo_library),
              label: const Text('画像を選択'),
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
}