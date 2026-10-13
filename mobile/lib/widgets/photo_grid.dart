import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import '../models/photo.dart';
import '../services/api_service.dart';
import '../theme/app_colors.dart';
import '../theme/app_text_styles.dart';
import '../utils/taken_at.dart';

/// 写真のサムネイルのグリッド（docs/travel-album/03_screen_design.md §3・§4.4）
///
/// 写真の一覧を自分で読む。旅行詳細と旅行に属さない写真の画面で使う
class PhotoGrid extends StatefulWidget {
  const PhotoGrid(
      {super.key,
      required this.apiService,
      required this.tripId,
      required this.emptyTitle,
      required this.emptyMessage});

  final ApiService apiService;

  /// 旅行の id。旅行に属さない写真なら `none`
  final String tripId;

  /// 写真が0枚のときの案内（画面ごとに文言が違う）
  final String emptyTitle;
  final String emptyMessage;

  @override
  State<PhotoGrid> createState() => _PhotoGridState();
}

class _PhotoGridState extends State<PhotoGrid> {
  List<Photo>? _photos;

  @override
  void initState() {
    super.initState();
    _loadFirstPage();
  }

  /// 先頭のページを読む
  Future<void> _loadFirstPage() async {
    try {
      final page = await widget.apiService.getPhotos(widget.tripId);
      if (!mounted) return;
      setState(() => _photos = page.photos);
    } catch (e) {
      debugPrint('PhotoGrid: 写真の一覧の読み込みエラー: $e');
    }
  }

  @override
  Widget build(BuildContext context) {
    final photos = _photos;
    if (photos == null) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const CircularProgressIndicator(
                valueColor: AlwaysStoppedAnimation(AppColors.primary)),
            const SizedBox(height: 16),
            Text('写真を読み込み中...',
                style: AppTextStyles.body1
                    .copyWith(color: AppColors.textSecondary)),
          ],
        ),
      );
    }
    if (photos.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const Icon(Icons.photo_library_outlined,
                  size: 96, color: AppColors.textHint),
              const SizedBox(height: 24),
              Text(widget.emptyTitle,
                  style: AppTextStyles.headline2
                      .copyWith(color: AppColors.textSecondary)),
              const SizedBox(height: 12),
              Text(widget.emptyMessage,
                  style: AppTextStyles.body1
                      .copyWith(color: AppColors.textSecondary),
                  textAlign: TextAlign.center),
            ],
          ),
        ),
      );
    }
    return GridView.builder(
      padding: const EdgeInsets.all(2),
      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
        crossAxisCount: 3,
        mainAxisSpacing: 2,
        crossAxisSpacing: 2,
      ),
      itemCount: photos.length,
      itemBuilder: (context, index) => _PhotoTile(photo: photos[index]),
    );
  }
}

/// サムネイル1枚。撮影日時を読み上げのラベルにする（画像だけでは写真を区別できないため）
class _PhotoTile extends StatelessWidget {
  const _PhotoTile({required this.photo});

  final Photo photo;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: formatTakenAt(photo.takenAt),
      container: true,
      child: CachedNetworkImage(
        imageUrl: photo.thumbnailUrl ?? photo.imageUrl,
        fit: BoxFit.cover,
        placeholder: (context, url) =>
            const ColoredBox(color: AppColors.surfaceVariant),
        errorWidget: (context, url, error) =>
            const ColoredBox(color: AppColors.surfaceVariant),
      ),
    );
  }
}
