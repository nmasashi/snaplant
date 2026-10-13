import 'package:flutter/material.dart';
import '../services/api_service.dart';
import '../theme/app_text_styles.dart';
import '../widgets/photo_grid.dart';

/// 旅行に属さない写真の画面（docs/travel-album/03_screen_design.md §4.5）
///
/// 旅行詳細と同じ部品で、旅行ではないので編集・削除のメニューは無く、期間も出さない
class UnassignedPhotosScreen extends StatelessWidget {
  const UnassignedPhotosScreen(
      {super.key, required this.apiService, required this.photoCount});

  final ApiService apiService;

  /// 旅行一覧（GET /api/trips）の unassignedPhotoCount。この画面では取り直さない
  final int photoCount;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('旅行に属さない写真', style: AppTextStyles.appBarTitle),
      ),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.all(16),
            child: Text('$photoCount枚', style: AppTextStyles.body1),
          ),
          Expanded(
            child: PhotoGrid(
              apiService: apiService,
              tripId: 'none',
              emptyTitle: '旅行に属さない写真はありません',
              emptyMessage: '「写真を追加」で送った写真は、あとから旅行に入れられます',
            ),
          ),
        ],
      ),
    );
  }
}
