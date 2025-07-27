import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'screens/plant_list_screen.dart';
import 'theme/app_theme.dart';
import 'theme/app_colors.dart';

void main() {
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
            textScaleFactor: 1.0, // フォントスケールを固定
          ),
          child: child!,
        );
      },
      
      // 初期画面
      home: const PlantListScreen(),
      
      // 画面遷移アニメーション
      onGenerateRoute: (settings) {
        return PageRouteBuilder(
          settings: settings,
          pageBuilder: (context, animation, secondaryAnimation) {
            switch (settings.name) {
              default:
                return const PlantListScreen();
            }
          },
          transitionsBuilder: (context, animation, secondaryAnimation, child) {
            const begin = Offset(1.0, 0.0);
            const end = Offset.zero;
            const curve = Curves.easeInOutCubic;
            
            var tween = Tween(begin: begin, end: end).chain(
              CurveTween(curve: curve),
            );
            
            return SlideTransition(
              position: animation.drive(tween),
              child: child,
            );
          },
        );
      },
    );
  }
}