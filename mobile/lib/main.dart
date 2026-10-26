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

      // 対応する言語を日本語だけにし、端末の言語によらず日本語で動かす。Material の部品の文言（戻るボタンの説明など）が日本語になり、
      // 文字を描く部品に日本語が渡って、端末では漢字・かなを日本語の字形で描く（英語の設定の端末では中国語の字形になりうる）。
      // Web 版の字形は、Flutter がブラウザの言語の設定で選ぶので、これでは変わらない（docs/03_screen_design.md §9.1）。
      // 対応する言語を足すときは、端末の言語に従わせるのでなければ locale: で日本語を指定する
      // （対応する言語が1つだけの今は、端末の言語によらずそれに決まる）
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
