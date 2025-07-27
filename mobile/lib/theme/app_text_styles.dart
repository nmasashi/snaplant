import 'package:flutter/material.dart';
import 'app_colors.dart';

/// SnapPlant アプリのテキストスタイル
/// 1440×2960の画面サイズに最適化された文字サイズ
class AppTextStyles {
  // ヘッダー系
  static const TextStyle headline1 = TextStyle(
    fontSize: 28,
    fontWeight: FontWeight.bold,
    color: AppColors.textPrimary,
    height: 1.2,
    letterSpacing: -0.5,
  );
  
  static const TextStyle headline2 = TextStyle(
    fontSize: 24,
    fontWeight: FontWeight.w600,
    color: AppColors.textPrimary,
    height: 1.3,
    letterSpacing: -0.25,
  );
  
  static const TextStyle headline3 = TextStyle(
    fontSize: 20,
    fontWeight: FontWeight.w600,
    color: AppColors.textPrimary,
    height: 1.4,
  );
  
  // ボディテキスト系
  static const TextStyle body1 = TextStyle(
    fontSize: 18,
    fontWeight: FontWeight.normal,
    color: AppColors.textPrimary,
    height: 1.6,
    letterSpacing: 0.15,
  );
  
  static const TextStyle body2 = TextStyle(
    fontSize: 16,
    fontWeight: FontWeight.normal,
    color: AppColors.textPrimary,
    height: 1.5,
    letterSpacing: 0.25,
  );
  
  static const TextStyle body3 = TextStyle(
    fontSize: 14,
    fontWeight: FontWeight.normal,
    color: AppColors.textSecondary,
    height: 1.4,
    letterSpacing: 0.25,
  );
  
  // ボタン・ラベル系
  static const TextStyle button = TextStyle(
    fontSize: 16,
    fontWeight: FontWeight.w600,
    letterSpacing: 0.5,
    height: 1.2,
  );
  
  static const TextStyle buttonLarge = TextStyle(
    fontSize: 18,
    fontWeight: FontWeight.w600,
    letterSpacing: 0.5,
    height: 1.2,
  );
  
  static const TextStyle label = TextStyle(
    fontSize: 14,
    fontWeight: FontWeight.w500,
    color: AppColors.textSecondary,
    letterSpacing: 0.1,
  );
  
  // キャプション・補助テキスト
  static const TextStyle caption = TextStyle(
    fontSize: 12,
    color: AppColors.textSecondary,
    height: 1.33,
    letterSpacing: 0.4,
  );
  
  static const TextStyle overline = TextStyle(
    fontSize: 10,
    fontWeight: FontWeight.w500,
    color: AppColors.textSecondary,
    letterSpacing: 1.5,
  );
  
  // 特殊用途
  static const TextStyle appBarTitle = TextStyle(
    fontSize: 22,
    fontWeight: FontWeight.w600,
    color: AppColors.textOnPrimary,
    letterSpacing: 0.15,
  );
  
  static const TextStyle plantName = TextStyle(
    fontSize: 20,
    fontWeight: FontWeight.w600,
    color: AppColors.textPrimary,
    height: 1.3,
  );
  
  static const TextStyle scientificName = TextStyle(
    fontSize: 14,
    fontStyle: FontStyle.italic,
    color: AppColors.textSecondary,
    height: 1.4,
  );
  
  static const TextStyle confidence = TextStyle(
    fontSize: 14,
    fontWeight: FontWeight.w600,
    height: 1.2,
  );
  
  static const TextStyle characteristics = TextStyle(
    fontSize: 16,
    color: AppColors.textPrimary,
    height: 1.6,
    letterSpacing: 0.15,
  );
  
  // エラー・警告系
  static const TextStyle error = TextStyle(
    fontSize: 14,
    color: AppColors.error,
    fontWeight: FontWeight.w500,
  );
  
  static const TextStyle warning = TextStyle(
    fontSize: 14,
    color: AppColors.warning,
    fontWeight: FontWeight.w500,
  );
  
  static const TextStyle success = TextStyle(
    fontSize: 14,
    color: AppColors.success,
    fontWeight: FontWeight.w500,
  );
  
  // フォームフィールド
  static const TextStyle inputLabel = TextStyle(
    fontSize: 16,
    fontWeight: FontWeight.w500,
    color: AppColors.textSecondary,
  );
  
  static const TextStyle inputText = TextStyle(
    fontSize: 18,
    color: AppColors.textPrimary,
    height: 1.4,
  );
  
  static const TextStyle inputHint = TextStyle(
    fontSize: 16,
    color: AppColors.textHint,
  );
  
  // 信頼度に基づくスタイル
  static TextStyle confidenceWithColor(double confidence) {
    return AppTextStyles.confidence.copyWith(
      color: AppColors.getConfidenceColor(confidence),
    );
  }
  
  // レスポンシブ対応: 画面幅に基づいてフォントサイズを調整
  static double getResponsiveFontSize(BuildContext context, double baseFontSize) {
    final screenWidth = MediaQuery.of(context).size.width;
    final scaleFactor = screenWidth / 360; // 基準幅360dp
    return baseFontSize * scaleFactor.clamp(0.8, 1.5);
  }
  
  // 1440×2960画面向けのスタイル調整
  static TextStyle getOptimizedStyle(BuildContext context, TextStyle baseStyle) {
    final screenWidth = MediaQuery.of(context).size.width;
    
    // 1440px幅の場合のスケール調整
    if (screenWidth >= 1400) {
      return baseStyle.copyWith(
        fontSize: (baseStyle.fontSize ?? 14) * 1.2,
      );
    }
    
    return baseStyle;
  }
}