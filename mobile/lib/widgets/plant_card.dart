import 'package:flutter/material.dart';
import 'package:cached_network_image/cached_network_image.dart';
import '../models/plant.dart';
import '../theme/app_colors.dart';
import '../theme/app_text_styles.dart';

/// 植物一覧で使用される植物カードウィジェット
/// 1440×2960画面サイズに最適化されたレスポンシブデザイン
class PlantCard extends StatelessWidget {
  final PlantSummary plant;
  final VoidCallback? onTap;
  final VoidCallback? onLongPress;

  const PlantCard({
    super.key,
    required this.plant,
    this.onTap,
    this.onLongPress,
  });

  @override
  Widget build(BuildContext context) {
    final screenWidth = MediaQuery.of(context).size.width;
    final isLargeScreen = screenWidth >= 1400;
    
    // 画面サイズに応じたカードの高さ調整
    final cardHeight = isLargeScreen ? 280.0 : 240.0;
    final imageHeight = isLargeScreen ? 180.0 : 150.0;
    
    return Card(
      margin: EdgeInsets.symmetric(
        horizontal: isLargeScreen ? 24 : 16,
        vertical: isLargeScreen ? 12 : 8,
      ),
      elevation: 6,
      shadowColor: AppColors.shadowColor,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
      ),
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: onTap,
        onLongPress: onLongPress,
        child: SizedBox(
          height: cardHeight,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // 植物画像セクション
              _buildImageSection(context, imageHeight, isLargeScreen),
              
              // 植物情報セクション
              _buildInfoSection(context, isLargeScreen),
            ],
          ),
        ),
      ),
    );
  }

  /// 画像セクションの構築
  Widget _buildImageSection(BuildContext context, double imageHeight, bool isLargeScreen) {
    return Hero(
      tag: 'plant-image-${plant.id}',
      child: ClipRRect(
        borderRadius: const BorderRadius.vertical(top: Radius.circular(16)),
        child: Container(
          height: imageHeight,
          width: double.infinity,
          child: CachedNetworkImage(
            imageUrl: plant.imagePath,
            fit: BoxFit.cover,
            placeholder: (context, url) => Container(
              color: AppColors.surface,
              child: Center(
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    SizedBox(
                      width: isLargeScreen ? 32 : 24,
                      height: isLargeScreen ? 32 : 24,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        valueColor: AlwaysStoppedAnimation(AppColors.primary),
                      ),
                    ),
                    SizedBox(height: isLargeScreen ? 12 : 8),
                    Text(
                      '読み込み中...',
                      style: AppTextStyles.caption.copyWith(
                        fontSize: isLargeScreen ? 14 : 12,
                      ),
                    ),
                  ],
                ),
              ),
            ),
            errorWidget: (context, url, error) => Container(
              color: AppColors.surface,
              child: Center(
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Icon(
                      Icons.broken_image_outlined,
                      size: isLargeScreen ? 48 : 36,
                      color: AppColors.textSecondary,
                    ),
                    SizedBox(height: isLargeScreen ? 12 : 8),
                    Text(
                      '画像を読み込めません',
                      style: AppTextStyles.caption.copyWith(
                        fontSize: isLargeScreen ? 14 : 12,
                        color: AppColors.textSecondary,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  /// 情報セクションの構築
  Widget _buildInfoSection(BuildContext context, bool isLargeScreen) {
    return Expanded(
      child: Padding(
        padding: EdgeInsets.all(isLargeScreen ? 20 : 16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // 植物名と信頼度
            Row(
              children: [
                Expanded(
                  child: Text(
                    plant.name,
                    style: AppTextStyles.plantName.copyWith(
                      fontSize: isLargeScreen ? 24 : 20,
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                SizedBox(width: 12),
                _buildConfidenceBadge(isLargeScreen),
              ],
            ),
            
            SizedBox(height: isLargeScreen ? 12 : 8),
            
            // 特徴説明
            Expanded(
              child: Text(
                plant.characteristics,
                style: AppTextStyles.characteristics.copyWith(
                  fontSize: isLargeScreen ? 18 : 16,
                ),
                maxLines: isLargeScreen ? 3 : 2,
                overflow: TextOverflow.ellipsis,
              ),
            ),
            
            SizedBox(height: isLargeScreen ? 12 : 8),
            
            // 保存日時
            Row(
              children: [
                Icon(
                  Icons.access_time,
                  size: isLargeScreen ? 18 : 16,
                  color: AppColors.textSecondary,
                ),
                SizedBox(width: 6),
                Text(
                  _formatDate(plant.createdAt),
                  style: AppTextStyles.caption.copyWith(
                    fontSize: isLargeScreen ? 14 : 12,
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  /// 信頼度バッジの構築
  Widget _buildConfidenceBadge(bool isLargeScreen) {
    final confidenceColor = AppColors.getConfidenceColor(plant.confidence);
    
    return Container(
      padding: EdgeInsets.symmetric(
        horizontal: isLargeScreen ? 12 : 10,
        vertical: isLargeScreen ? 6 : 4,
      ),
      decoration: BoxDecoration(
        color: confidenceColor.withOpacity(0.1),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(
          color: confidenceColor.withOpacity(0.3),
          width: 1,
        ),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            Icons.psychology,
            size: isLargeScreen ? 16 : 14,
            color: confidenceColor,
          ),
          SizedBox(width: 4),
          Text(
            '${plant.confidence.toInt()}%',
            style: AppTextStyles.confidence.copyWith(
              color: confidenceColor,
              fontSize: isLargeScreen ? 14 : 12,
            ),
          ),
        ],
      ),
    );
  }

  /// 日付のフォーマット
  String _formatDate(DateTime date) {
    final now = DateTime.now();
    final difference = now.difference(date);
    
    if (difference.inDays == 0) {
      return '今日';
    } else if (difference.inDays == 1) {
      return '昨日';
    } else if (difference.inDays < 7) {
      return '${difference.inDays}日前';
    } else if (difference.inDays < 30) {
      final weeks = (difference.inDays / 7).floor();
      return '${weeks}週間前';
    } else if (difference.inDays < 365) {
      final months = (difference.inDays / 30).floor();
      return '${months}ヶ月前';
    } else {
      final years = (difference.inDays / 365).floor();
      return '${years}年前';
    }
  }
}