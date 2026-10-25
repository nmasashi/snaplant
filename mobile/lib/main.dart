import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:http/http.dart' as http;
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
  const SnapPlantApp({super.key, this.httpClient});

  /// サーバとの通信に使う HTTP クライアント。テストで偽のサーバ（MockClient）を差し込むためのもので、
  /// 通常は null（設定を読むたびに新しいクライアントを作る）
  final http.Client? httpClient;

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

      // 日本語だけで動かす。言語の設定が無いと英語として動き、漢字・かなを中国語の字形で描くことがある
      // （Web 版で「ヰ」が別の字形になった）。Material の部品の文言（戻るボタンの説明など）も日本語になる
      locale: const Locale('ja', 'JP'),
      supportedLocales: const [Locale('ja', 'JP')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,

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
      home: AppRoot(httpClient: httpClient),
    );
  }
}
