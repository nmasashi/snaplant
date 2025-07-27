import 'package:flutter/material.dart';
import 'package:cached_network_image/cached_network_image.dart';
import '../models/plant.dart';
import '../services/api_service.dart';
import '../theme/app_colors.dart';
import '../theme/app_text_styles.dart';

/// 植物詳細画面
/// 保存済み植物の詳細情報表示と削除機能を提供
/// 1440×2960画面サイズに最適化されたレスポンシブデザイン
class PlantDetailScreen extends StatefulWidget {
  final String plantId;
  final ApiService apiService;

  const PlantDetailScreen({
    super.key,
    required this.plantId,
    required this.apiService,
  });

  @override
  State<PlantDetailScreen> createState() => _PlantDetailScreenState();
}

class _PlantDetailScreenState extends State<PlantDetailScreen> {
  Plant? _plant;
  bool _isLoading = true;
  bool _hasError = false;
  String _errorMessage = '';
  bool _isDeleting = false;

  @override
  void initState() {
    super.initState();
    _loadPlantDetail();
  }

  /// 植物詳細の読み込み
  Future<void> _loadPlantDetail() async {
    try {
      setState(() {
        _isLoading = true;
        _hasError = false;
      });

      final plant = await widget.apiService.getPlant(widget.plantId);
      
      setState(() {
        _plant = plant;
        _isLoading = false;
      });
    } catch (e) {
      setState(() {
        _hasError = true;
        _errorMessage = e is ApiException ? e.userMessage : '植物詳細の読み込みに失敗しました';
        _isLoading = false;
      });
    }
  }

  /// 植物の削除
  Future<void> _deletePlant() async {
    final confirmed = await _showDeleteConfirmDialog();
    if (!confirmed || _plant == null) return;

    try {
      setState(() {
        _isDeleting = true;
      });

      await widget.apiService.deletePlant(_plant!.id);

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('植物を削除しました'),
            backgroundColor: AppColors.success,
            behavior: SnackBarBehavior.floating,
          ),
        );

        Navigator.pop(context, true);
      }

    } catch (e) {
      setState(() {
        _isDeleting = false;
      });

      final errorMessage = e is ApiException 
          ? e.userMessage 
          : '植物の削除に失敗しました';

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(errorMessage),
            backgroundColor: AppColors.error,
            behavior: SnackBarBehavior.floating,
          ),
        );
      }
    }
  }

  /// 削除確認ダイアログ
  Future<bool> _showDeleteConfirmDialog() async {
    final result = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('植物を削除'),
        content: Text('「${_plant?.name ?? ''}」を削除しますか？\nこの操作は元に戻せません。'),
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
            child: const Text('削除'),
          ),
        ],
      ),
    );

    return result ?? false;
  }

  /// 日付のフォーマット
  String _formatDateTime(DateTime dateTime) {
    return '${dateTime.year}年${dateTime.month}月${dateTime.day}日 '
           '${dateTime.hour.toString().padLeft(2, '0')}:'
           '${dateTime.minute.toString().padLeft(2, '0')}';
  }

  @override
  Widget build(BuildContext context) {
    final screenWidth = MediaQuery.of(context).size.width;
    final isLargeScreen = screenWidth >= 1400;
    
    return Scaffold(
      body: _isLoading
          ? _buildLoadingView(isLargeScreen)
          : _hasError
              ? _buildErrorView(isLargeScreen)
              : _buildPlantDetail(isLargeScreen),
    );
  }

  /// ローディング表示
  Widget _buildLoadingView(bool isLargeScreen) {
    return Scaffold(
      appBar: AppBar(
        title: Text('植物詳細'),
      ),
      body: Center(
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
              '植物情報を読み込み中...',
              style: AppTextStyles.body1.copyWith(
                fontSize: isLargeScreen ? 20 : 18,
                color: AppColors.textSecondary,
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// エラー表示
  Widget _buildErrorView(bool isLargeScreen) {
    return Scaffold(
      appBar: AppBar(
        title: Text('植物詳細'),
      ),
      body: Center(
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
                onPressed: _loadPlantDetail,
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
      ),
    );
  }

  /// 植物詳細表示
  Widget _buildPlantDetail(bool isLargeScreen) {
    if (_plant == null) return const SizedBox.shrink();

    return CustomScrollView(
      slivers: [
        _buildSliverAppBar(isLargeScreen),
        _buildPlantInfo(isLargeScreen),
      ],
    );
  }

  /// SliverAppBar（画像背景付き）
  Widget _buildSliverAppBar(bool isLargeScreen) {
    return SliverAppBar(
      expandedHeight: isLargeScreen ? 400 : 350,
      pinned: true,
      leading: IconButton(
        icon: Icon(
          Icons.arrow_back,
          color: Colors.white,
          size: isLargeScreen ? 28 : 24,
        ),
        onPressed: () => Navigator.pop(context),
      ),
      actions: [
        IconButton(
          icon: Icon(
            Icons.delete,
            color: Colors.white,
            size: isLargeScreen ? 28 : 24,
          ),
          onPressed: _isDeleting ? null : _deletePlant,
        ),
        SizedBox(width: isLargeScreen ? 16 : 8),
      ],
      flexibleSpace: FlexibleSpaceBar(
        title: Text(
          _plant!.name,
          style: TextStyle(
            color: Colors.white,
            fontSize: isLargeScreen ? 24 : 20,
            fontWeight: FontWeight.bold,
            shadows: [
              Shadow(
                offset: const Offset(1, 1),
                blurRadius: 4,
                color: Colors.black.withOpacity(0.7),
              ),
            ],
          ),
        ),
        background: Stack(
          fit: StackFit.expand,
          children: [
            Hero(
              tag: 'plant-image-${_plant!.id}',
              child: CachedNetworkImage(
                imageUrl: _plant!.imagePath,
                fit: BoxFit.cover,
                placeholder: (context, url) => Container(
                  color: AppColors.surface,
                  child: Center(
                    child: CircularProgressIndicator(
                      valueColor: AlwaysStoppedAnimation(AppColors.primary),
                    ),
                  ),
                ),
                errorWidget: (context, url, error) => Container(
                  color: AppColors.surface,
                  child: Center(
                    child: Icon(
                      Icons.broken_image_outlined,
                      size: isLargeScreen ? 80 : 64,
                      color: AppColors.textSecondary,
                    ),
                  ),
                ),
              ),
            ),
            Container(
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topCenter,
                  end: Alignment.bottomCenter,
                  colors: [
                    Colors.transparent,
                    Colors.black.withOpacity(0.7),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// 植物情報表示
  Widget _buildPlantInfo(bool isLargeScreen) {
    return SliverPadding(
      padding: EdgeInsets.all(isLargeScreen ? 32 : 24),
      sliver: SliverList(
        delegate: SliverChildListDelegate([
          // 基本情報カード
          _buildBasicInfoCard(isLargeScreen),
          
          SizedBox(height: isLargeScreen ? 24 : 16),
          
          // 特徴カード
          _buildCharacteristicsCard(isLargeScreen),
          
          if (_plant!.description != null && _plant!.description!.isNotEmpty) ...[
            SizedBox(height: isLargeScreen ? 24 : 16),
            _buildDescriptionCard(isLargeScreen),
          ],
          
          SizedBox(height: isLargeScreen ? 24 : 16),
          
          // メタ情報カード
          _buildMetaInfoCard(isLargeScreen),
          
          SizedBox(height: isLargeScreen ? 40 : 32),
          
          // 削除ボタン
          _buildDeleteButton(isLargeScreen),
        ]),
      ),
    );
  }

  /// 基本情報カード
  Widget _buildBasicInfoCard(bool isLargeScreen) {
    return Card(
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
      ),
      child: Padding(
        padding: EdgeInsets.all(isLargeScreen ? 24 : 20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(
                  Icons.eco,
                  color: AppColors.primary,
                  size: isLargeScreen ? 28 : 24,
                ),
                SizedBox(width: 8),
                Text(
                  '基本情報',
                  style: AppTextStyles.headline3.copyWith(
                    fontSize: isLargeScreen ? 24 : 20,
                  ),
                ),
              ],
            ),
            
            SizedBox(height: isLargeScreen ? 20 : 16),
            
            _buildInfoRow('植物名', _plant!.name, isLargeScreen),
            
            if (_plant!.scientificName != null && _plant!.scientificName!.isNotEmpty)
              _buildInfoRow('学名', _plant!.scientificName!, isLargeScreen),
            
            if (_plant!.familyName != null && _plant!.familyName!.isNotEmpty)
              _buildInfoRow('科名', '${_plant!.familyName}科', isLargeScreen),
            
            _buildInfoRow(
              '信頼度', 
              '${_plant!.confidence.toInt()}%',
              isLargeScreen,
              valueWidget: _buildConfidenceBadge(_plant!.confidence, isLargeScreen),
            ),
          ],
        ),
      ),
    );
  }

  /// 特徴カード
  Widget _buildCharacteristicsCard(bool isLargeScreen) {
    return Card(
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
      ),
      child: Padding(
        padding: EdgeInsets.all(isLargeScreen ? 24 : 20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(
                  Icons.nature,
                  color: AppColors.primary,
                  size: isLargeScreen ? 28 : 24,
                ),
                SizedBox(width: 8),
                Text(
                  '特徴',
                  style: AppTextStyles.headline3.copyWith(
                    fontSize: isLargeScreen ? 24 : 20,
                  ),
                ),
              ],
            ),
            
            SizedBox(height: isLargeScreen ? 16 : 12),
            
            Text(
              _plant!.characteristics,
              style: AppTextStyles.characteristics.copyWith(
                fontSize: isLargeScreen ? 20 : 18,
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// 詳細説明カード
  Widget _buildDescriptionCard(bool isLargeScreen) {
    return Card(
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
      ),
      child: Padding(
        padding: EdgeInsets.all(isLargeScreen ? 24 : 20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(
                  Icons.description,
                  color: AppColors.primary,
                  size: isLargeScreen ? 28 : 24,
                ),
                SizedBox(width: 8),
                Text(
                  '詳細説明',
                  style: AppTextStyles.headline3.copyWith(
                    fontSize: isLargeScreen ? 24 : 20,
                  ),
                ),
              ],
            ),
            
            SizedBox(height: isLargeScreen ? 16 : 12),
            
            Text(
              _plant!.description!,
              style: AppTextStyles.body1.copyWith(
                fontSize: isLargeScreen ? 20 : 18,
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// メタ情報カード
  Widget _buildMetaInfoCard(bool isLargeScreen) {
    return Card(
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
      ),
      child: Padding(
        padding: EdgeInsets.all(isLargeScreen ? 24 : 20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(
                  Icons.info_outline,
                  color: AppColors.primary,
                  size: isLargeScreen ? 28 : 24,
                ),
                SizedBox(width: 8),
                Text(
                  '保存情報',
                  style: AppTextStyles.headline3.copyWith(
                    fontSize: isLargeScreen ? 24 : 20,
                  ),
                ),
              ],
            ),
            
            SizedBox(height: isLargeScreen ? 20 : 16),
            
            _buildInfoRow('保存日時', _formatDateTime(_plant!.createdAt), isLargeScreen),
            
            if (_plant!.updatedAt != _plant!.createdAt)
              _buildInfoRow('更新日時', _formatDateTime(_plant!.updatedAt), isLargeScreen),
            
            _buildInfoRow('植物ID', _plant!.id, isLargeScreen),
          ],
        ),
      ),
    );
  }

  /// 情報行の構築
  Widget _buildInfoRow(
    String label, 
    String value, 
    bool isLargeScreen, {
    Widget? valueWidget,
  }) {
    return Padding(
      padding: EdgeInsets.only(bottom: isLargeScreen ? 16 : 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: isLargeScreen ? 120 : 100,
            child: Text(
              '$label:',
              style: AppTextStyles.label.copyWith(
                fontSize: isLargeScreen ? 18 : 16,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
          Expanded(
            child: valueWidget ?? Text(
              value,
              style: AppTextStyles.body1.copyWith(
                fontSize: isLargeScreen ? 20 : 18,
              ),
            ),
          ),
        ],
      ),
    );
  }

  /// 信頼度バッジ
  Widget _buildConfidenceBadge(double confidence, bool isLargeScreen) {
    final color = AppColors.getConfidenceColor(confidence);
    
    return Container(
      padding: EdgeInsets.symmetric(
        horizontal: isLargeScreen ? 16 : 12,
        vertical: isLargeScreen ? 8 : 6,
      ),
      decoration: BoxDecoration(
        color: color.withOpacity(0.1),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(
          color: color.withOpacity(0.3),
          width: 1,
        ),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            Icons.psychology,
            size: isLargeScreen ? 20 : 18,
            color: color,
          ),
          SizedBox(width: 6),
          Text(
            '${confidence.toInt()}%',
            style: AppTextStyles.confidence.copyWith(
              color: color,
              fontSize: isLargeScreen ? 18 : 16,
              fontWeight: FontWeight.w600,
            ),
          ),
        ],
      ),
    );
  }

  /// 削除ボタン
  Widget _buildDeleteButton(bool isLargeScreen) {
    return SizedBox(
      width: double.infinity,
      child: ElevatedButton.icon(
        onPressed: _isDeleting ? null : _deletePlant,
        icon: _isDeleting
            ? SizedBox(
                width: 16,
                height: 16,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  valueColor: AlwaysStoppedAnimation(Colors.white),
                ),
              )
            : Icon(Icons.delete),
        label: Text(_isDeleting ? '削除中...' : '植物を削除'),
        style: ElevatedButton.styleFrom(
          backgroundColor: AppColors.error,
          foregroundColor: Colors.white,
          padding: EdgeInsets.symmetric(
            vertical: isLargeScreen ? 24 : 20,
          ),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(12),
          ),
        ),
      ),
    );
  }
}