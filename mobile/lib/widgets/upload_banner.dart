import 'package:flutter/material.dart';

import '../services/upload_queue.dart';
import '../theme/app_colors.dart';
import '../theme/app_text_styles.dart';

/// 送信の進み具合バナー（docs/travel-album/03_screen_design.md §4.7「進み具合バナー」）
///
/// 列に数える項目があるときだけ出す。[includes] で数える項目を選ぶ（旅行詳細はその旅行宛てだけ）
class UploadBanner extends StatelessWidget {
  const UploadBanner(
      {super.key, required this.uploadQueue, required this.includes});

  final UploadQueue uploadQueue;
  final bool Function(UploadItem item) includes;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: uploadQueue,
      builder: (context, _) {
        final items = uploadQueue.items.where(includes).toList();
        if (items.isEmpty) return const SizedBox.shrink();
        final done = items
            .where((item) => uploadQueue.stateOf(item) == UploadState.done)
            .length;
        return Container(
          width: double.infinity,
          color: AppColors.primary.withValues(alpha: 0.1),
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
          child: Text('送信中 $done/${items.length}', style: AppTextStyles.body1),
        );
      },
    );
  }
}
