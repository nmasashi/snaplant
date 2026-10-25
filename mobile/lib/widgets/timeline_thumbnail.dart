import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import '../models/timeline.dart';
import '../theme/app_colors.dart';
import '../utils/photo_cache_manager.dart';
import '../utils/taken_at.dart';

/// タイムラインの写真のサムネイル（区切りの確認画面と完成版。読み上げのラベルは撮影日時。docs/03_screen_design.md §8.3・§8.4）
class TimelineThumbnail extends StatelessWidget {
  const TimelineThumbnail({super.key, required this.photo, this.onTap});

  final TimelinePhoto photo;

  /// タップしたとき（完成版のサムネイルは写真ビューアを開く）。null ならタップを受けない
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final image = Semantics(
      label: formatTakenAt(photo.takenAt),
      container: true,
      child: CachedNetworkImage(
        imageUrl: photo.thumbnailUrl,
        cacheKey: thumbnailCacheKey(photo.id),
        cacheManager: PhotoCacheManager.thumbnails,
        // サムネイルが無い写真は原寸の URL が来るので、マスの大きさに縮めて読む
        memCacheWidth: 200,
        fit: BoxFit.cover,
        placeholder: (context, url) =>
            const ColoredBox(color: AppColors.surfaceVariant),
        errorWidget: (context, url, error) =>
            const ColoredBox(color: AppColors.surfaceVariant),
      ),
    );
    final onTap = this.onTap;
    return onTap == null ? image : GestureDetector(onTap: onTap, child: image);
  }
}
