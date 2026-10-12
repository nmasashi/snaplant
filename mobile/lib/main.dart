import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'app_root.dart';
import 'theme/app_theme.dart';
import 'theme/app_colors.dart';

void main() {
  // 確認用のログ（debugPrint）は、補足情報やサーバのエラー本文も出す。
  // 利用者の端末のログに残さないよう、リリース版では何も出さない
  if (kReleaseMode) {
    debugPrint = (String? message, {int? wrapWidth}) {};
  }
  runApp(const SnapPlantApp());
}

/// SnapPlant アプリケーションのメインクラス
/// Material Design 3.0と植物テーマを採用
class SnapPlantApp extends StatelessWidget {
  const SnapPlantApp({super.key});

  @override
  Widget build(BuildContext context) {
    // システムUIのスタイル設定
    SystemChrome.setSystemUIOverlayStyle(
      const SystemUiOverlayStyle(
        statusBarColor: Colors.transparent,
        statusBarIconBrightness: Brightness.light,
        systemNavigationBarColor: AppColors.background,
        systemNavigationBarIconBrightness: Brightness.dark,
      ),
    );

    return MaterialApp(
      title: 'SnapPlant',
      debugShowCheckedModeBanner: false,
      
      // テーマ設定
      theme: AppTheme.lightTheme,
      
      // 1440×2960画面向けのレスポンシブ対応
      builder: (context, child) {
        return MediaQuery(
          data: MediaQuery.of(context).copyWith(
            textScaler: const TextScaler.linear(1.0), // フォントスケールを固定
          ),
          child: child!,
        );
      },
      
      // 初期画面
      home: const AppRoot(),
    );
  }
}