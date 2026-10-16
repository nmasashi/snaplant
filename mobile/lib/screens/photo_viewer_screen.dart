import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import '../models/photo.dart';
import '../services/api_service.dart';
import '../theme/app_text_styles.dart';
import '../utils/photo_cache_manager.dart';
import '../utils/taken_at.dart';
import '../widgets/confirm_action_dialog.dart';

/// 写真ビューア（docs/travel-album/03_screen_design.md §4.6）
///
/// 開いた一覧の写真を、一覧と同じ順で左右にスワイプして見る
class PhotoViewerScreen extends StatefulWidget {
  const PhotoViewerScreen(
      {super.key,
      required this.apiService,
      required this.photos,
      required this.initialIndex,
      required this.onReachEnd,
      required this.onDeleted});

  final ApiService apiService;

  /// 一覧の読み込み済みの写真（一覧と共有する。一覧が続きのページを読むと伸びる）
  final ValueListenable<List<Photo>> photos;

  /// 最初に出す写真の位置（[photos] の添え字）
  final int initialIndex;

  /// 読み込み済みの末尾の写真まで来たときに呼ぶ（一覧が続きのページを読む）
  final VoidCallback onReachEnd;

  /// 写真を削除できたときに呼ぶ（一覧の読み込み済みの写真から除く）
  final void Function(String photoId) onDeleted;

  @override
  State<PhotoViewerScreen> createState() => _PhotoViewerScreenState();
}

class _PhotoViewerScreenState extends State<PhotoViewerScreen> {
  late final _pageController = PageController(initialPage: widget.initialIndex);
  // 上のバーと下の情報を出しているか（画面のタップで切り替える）
  bool _showChrome = true;

  @override
  void dispose() {
    _pageController.dispose();
    super.dispose();
  }

  /// 今出している写真を、確かめてから削除する
  Future<void> _deleteCurrent() async {
    final photos = widget.photos.value;
    final index = _pageController.page!.round();
    final photo = photos[index];
    final deleted = await showDialog<bool>(
      context: context,
      builder: (context) => ConfirmActionDialog<bool>(
        title: '写真を削除',
        message: 'この写真を削除しますか？\nこの操作は元に戻せません。',
        confirmLabel: '削除',
        busyLabel: '削除中...',
        failureMessage: '写真の削除に失敗しました',
        onConfirm: () async {
          await widget.apiService.deletePhoto(photo.id);
          return true;
        },
      ),
    );
    if (deleted != true || !mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(const SnackBar(content: Text('写真を削除しました')));
    widget.onDeleted(photo.id);
    // 次の写真が無ければ（最後の1枚なら）一覧へ戻る
    if (index == photos.length - 1) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: _showChrome
          ? AppBar(
              backgroundColor: Colors.black54,
              foregroundColor: Colors.white,
              actions: [
                TextButton(
                  onPressed: _deleteCurrent,
                  style: TextButton.styleFrom(foregroundColor: Colors.white),
                  child: const Text('削除'),
                ),
              ],
            )
          : null,
      body: GestureDetector(
        onTap: () => setState(() => _showChrome = !_showChrome),
        child: ValueListenableBuilder<List<Photo>>(
          valueListenable: widget.photos,
          builder: (context, photos, _) => PageView.builder(
            controller: _pageController,
            itemCount: photos.length,
            onPageChanged: (index) {
              if (index == photos.length - 1) widget.onReachEnd();
            },
            itemBuilder: (context, index) =>
                _PhotoPage(photo: photos[index], showInfo: _showChrome),
          ),
        ),
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
  const _PhotoPage({required this.photo, required this.showInfo});

  final Photo photo;

  /// 下の情報を出すか
  final bool showInfo;

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
        if (showInfo)
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
