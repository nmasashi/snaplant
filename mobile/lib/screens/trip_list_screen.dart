import 'package:flutter/material.dart';
import '../services/api_service.dart';
import '../theme/app_text_styles.dart';

/// 旅行一覧画面（旅行タブ）
///
/// 段階2の PR 6 で旅行の一覧・作成・削除を足す。今は上部と設定ボタンだけの仮の画面
class TripListScreen extends StatelessWidget {
  const TripListScreen(
      {super.key, required this.apiService, required this.onOpenSettings});

  /// 設定済みの API クライアント（AppRoot が持つ）
  final ApiService apiService;

  /// 設定画面を開く
  final Future<void> Function() onOpenSettings;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('旅行', style: AppTextStyles.appBarTitle),
        actions: [
          IconButton(
              icon: const Icon(Icons.settings),
              onPressed: onOpenSettings,
              tooltip: '設定'),
        ],
      ),
      body: const Center(child: Text('旅行の一覧は準備中です')),
    );
  }
}
