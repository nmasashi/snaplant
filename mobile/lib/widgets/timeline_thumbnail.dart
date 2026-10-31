import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import '../models/timeline.dart';
import '../theme/app_colors.dart';
import '../utils/photo_cache_manager.dart';
import '../utils/taken_at.dart';

/// タイムラインの写真のサムネイル（区切りの確認画面・完成版・場面の写真の一覧。読み上げのラベルは撮影日時。docs/03_screen_design.md §8.3・§8.4・§8.8）
class TimelineThumbnail extends StatelessWidget {
  const TimelineThumbnail(
      {super.key, required this.photo, this.onTap, this.onLongPress});

  final TimelinePhoto photo;

  /// タップしたとき（場面の写真の一覧の写真は写真ビューアを開く）。null ならタップを受けない
  final VoidCallback? onTap;

  /// 長押ししたとき（場面の写真の一覧の写真は「タイムラインから外す」のメニュー）。null なら長押しを受けない
  final VoidCallback? onLongPress;

  @override
  Widget build(BuildContext context) {
    // タップと長押しは読み上げのラベルの付いた節に載せる（外で包むと、読み上げで写真を選んでも操作できない）。
    // 受けないときも GestureDetector で包む（包み方が変わると、下の画像の部品を組み立て直して読み込み直すため）
    return Semantics(
      label: formatTakenAt(photo.takenAt),
      container: true,
      child: GestureDetector(
        onTap: onTap,
        onLongPress: onLongPress,
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
      ),
    );
  }
}
