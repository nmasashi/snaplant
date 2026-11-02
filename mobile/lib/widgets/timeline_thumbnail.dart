import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import '../models/timeline.dart';
import '../theme/app_colors.dart';
import '../utils/photo_cache_manager.dart';
import '../utils/taken_at.dart';

/// タイムラインの写真のサムネイル（区切りの確認画面・完成版・場面の写真の一覧。読み上げのラベルは撮影日時。docs/03_screen_design.md §8.3・§8.4・§8.8）
class TimelineThumbnail extends StatelessWidget {
  const TimelineThumbnail(
      {super.key,
      required this.photo,
      this.onTap,
      this.onLongPress,
      this.showsFavorite = false});

  final TimelinePhoto photo;

  /// お気に入りの印（右上のハート）と読み上げの「、お気に入り」を出すか（完成版と場面の写真の一覧。案の確認画面は出さない。03 §5.10.3）
  final bool showsFavorite;

  /// タップしたとき（場面の写真の一覧の写真は写真ビューアを開く）。null ならタップを受けない
  final VoidCallback? onTap;

  /// 長押ししたとき（写真のメニュー。案の確認画面は「この写真から新しい場面」「タイムラインから外す」、場面の写真の一覧は「タイムラインから外す」）。null なら長押しを受けない
  final VoidCallback? onLongPress;

  @override
  Widget build(BuildContext context) {
    // タップと長押しは読み上げのラベルの付いた節に載せる（外で包むと、読み上げで写真を選んでも操作できない）。
    // 受けないときも GestureDetector で包む（包み方が変わると、下の画像の部品を組み立て直して読み込み直すため）
    final marked = showsFavorite && photo.favorite;
    return Semantics(
      label: formatTakenAt(photo.takenAt) + (marked ? '、お気に入り' : ''),
      container: true,
      child: GestureDetector(
        onTap: onTap,
        onLongPress: onLongPress,
        child: Stack(fit: StackFit.expand, children: [
          _image(),
          // 読み上げはラベルの「、お気に入り」で伝える（写真の一覧の印と同じ。03 §5.10.3）
          if (marked)
            const Positioned(
              right: 4,
              top: 4,
              child: ExcludeSemantics(
                child: Icon(Icons.favorite, size: 16, color: Colors.white),
              ),
            ),
        ]),
      ),
    );
  }

  /// サムネイルの画像
  Widget _image() {
    return CachedNetworkImage(
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
    );
  }
}
