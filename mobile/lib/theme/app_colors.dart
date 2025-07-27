import 'package:flutter/material.dart';

/// SnapPlant アプリのカラーパレット
/// Material Design 3.0に準拠した植物テーマの色設計
class AppColors {
  // プライマリカラー（植物の緑）
  static const Color primary = Color(0xFF2E7D32);      // 深緑
  static const Color primaryLight = Color(0xFF60AD5E);  // 明るい緑
  static const Color primaryDark = Color(0xFF005005);   // 濃い緑
  
  // セカンダリカラー（花の色）
  static const Color secondary = Color(0xFFFF6F00);     // オレンジ
  static const Color secondaryLight = Color(0xFFFF9F40); // 明るいオレンジ
  static const Color secondaryDark = Color(0xFFC43E00);  // 濃いオレンジ
  
  // サーフェスカラー
  static const Color surface = Color(0xFFF8F9FA);       // 薄いグレー
  static const Color background = Colors.white;
  static const Color cardBackground = Color(0xFFFFFFFF);
  static const Color surfaceVariant = Color(0xFFF5F5F5);
  
  // テキストカラー
  static const Color textPrimary = Color(0xFF1A1A1A);
  static const Color textSecondary = Color(0xFF757575);
  static const Color textHint = Color(0xFFBDBDBD);
  static const Color textOnPrimary = Colors.white;
  
  // ステータスカラー
  static const Color success = Color(0xFF4CAF50);
  static const Color warning = Color(0xFFFF9800);
  static const Color error = Color(0xFFF44336);
  static const Color info = Color(0xFF2196F3);
  
  // 透明度付きカラー
  static Color primaryWithOpacity(double opacity) => primary.withOpacity(opacity);
  static Color secondaryWithOpacity(double opacity) => secondary.withOpacity(opacity);
  static Color surfaceWithOpacity(double opacity) => surface.withOpacity(opacity);
  
  // Material Color Swatch for Primary
  static const MaterialColor primarySwatch = MaterialColor(
    0xFF2E7D32,
    <int, Color>{
      50: Color(0xFFE8F5E8),
      100: Color(0xFFC8E6C9),
      200: Color(0xFFA5D6A7),
      300: Color(0xFF81C784),
      400: Color(0xFF66BB6A),
      500: Color(0xFF2E7D32), // Primary
      600: Color(0xFF43A047),
      700: Color(0xFF388E3C),
      800: Color(0xFF2E7D32),
      900: Color(0xFF1B5E20),
    },
  );
  
  // カードの影の色
  static const Color shadowColor = Color(0x1A000000);
  static const Color elevationShadow = Color(0x0F000000);
  
  // 境界線の色
  static const Color borderColor = Color(0xFFE0E0E0);
  static const Color dividerColor = Color(0xFFBDBDBD);
  
  // 信頼度表示用グラデーション
  static List<Color> confidenceGradient = [
    const Color(0xFFF44336), // 低い（赤）
    const Color(0xFFFF9800), // 中程度（オレンジ）
    const Color(0xFF4CAF50), // 高い（緑）
  ];
  
  // 信頼度に基づく色を取得
  static Color getConfidenceColor(double confidence) {
    if (confidence >= 90) return success;
    if (confidence >= 70) return Color(0xFF8BC34A); // 薄い緑
    if (confidence >= 50) return warning;
    return error;
  }
  
}
  
/// ダークモード用カラーパレット（将来実装用）
class AppColorsDark {
  static const Color primary = Color(0xFF4CAF50);
  static const Color background = Color(0xFF121212);
  static const Color surface = Color(0xFF1E1E1E);
  static const Color textPrimary = Colors.white;
  static const Color textSecondary = Color(0xFFB0B0B0);
}