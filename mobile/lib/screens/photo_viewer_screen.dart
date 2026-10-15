import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import '../models/photo.dart';
import '../theme/app_text_styles.dart';
import '../utils/photo_cache_manager.dart';
import '../utils/taken_at.dart';

/// 写真ビューア（docs/travel-album/03_screen_design.md §4.6）
///
/// 開いた一覧の写真を、一覧と同じ順で左右にスワイプして見る
class PhotoViewerScreen extends StatefulWidget {
  const PhotoViewerScreen(
      {super.key, required this.photos, required this.initialIndex});

  final List<Photo> photos;

  /// 最初に出す写真の位置（[photos] の添え字）
  final int initialIndex;

  @override
  State<PhotoViewerScreen> createState() => _PhotoViewerScreenState();
}

class _PhotoViewerScreenState extends State<PhotoViewerScreen> {
  late final _pageController = PageController(initialPage: widget.initialIndex);

  @override
  void dispose() {
    _pageController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black54,
        foregroundColor: Colors.white,
      ),
      body: PageView.builder(
        controller: _pageController,
        itemCount: widget.photos.length,
        itemBuilder: (context, index) =>
            _PhotoPage(photo: widget.photos[index]),
      ),
    );
  }
}

/// 下の情報の場所の文言。地名が無ければ緯度・経度を小数4桁で、位置情報が無ければ「位置情報なし」
String _placeText(Photo photo) {
  final placeName = photo.placeName;
  if (placeName != null) return placeName;
  final latitude = photo.latitude;
  final longitude = photo.longitude;
  if (latitude == null || longitude == null) return '位置情報なし';
  return '${latitude.toStringAsFixed(4)}, ${longitude.toStringAsFixed(4)}';
}

/// 写真1枚の画面（原寸の画像と、下の情報）
class _PhotoPage extends StatelessWidget {
  const _PhotoPage({required this.photo});

  final Photo photo;

  @override
  Widget build(BuildContext context) {
    return Column(
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
              Text(_placeText(photo),
                  style: AppTextStyles.body1.copyWith(color: Colors.white)),
            ],
          ),
        ),
      ],
    );
  }
}
