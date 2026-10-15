import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import '../models/photo.dart';
import '../theme/app_text_styles.dart';
import '../utils/photo_cache_manager.dart';
import '../utils/taken_at.dart';

/// 写真ビューア（docs/travel-album/03_screen_design.md §4.6）
class PhotoViewerScreen extends StatelessWidget {
  const PhotoViewerScreen({super.key, required this.photo});

  final Photo photo;

  @override
  Widget build(BuildContext context) {
    final placeName = photo.placeName;
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black54,
        foregroundColor: Colors.white,
      ),
      body: Column(
        children: [
          Expanded(
            child: CachedNetworkImage(
              imageUrl: photo.imageUrl,
              cacheKey: imageCacheKey(photo.id),
              cacheManager: PhotoCacheManager.images,
              fit: BoxFit.contain,
            ),
          ),
          Container(
            width: double.infinity,
            color: Colors.black54,
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(formatTakenAt(photo.takenAt),
                    style: AppTextStyles.body1.copyWith(color: Colors.white)),
                if (placeName != null)
                  Text(placeName,
                      style: AppTextStyles.body1.copyWith(color: Colors.white)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
