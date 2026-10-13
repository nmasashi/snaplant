import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import '../models/photo.dart';
import '../services/api_service.dart';
import '../theme/app_colors.dart';
import '../theme/app_text_styles.dart';
import '../utils/taken_at.dart';
import 'message_view.dart';

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

/// 末尾から何枚以内を組み立てたら続きを読むか（3列なので2行分）
const _loadMoreThreshold = 6;

class _PhotoGridState extends State<PhotoGrid> {
  List<Photo>? _photos;
  // 1ページ目の取得に失敗したときの文言。null なら失敗していない
  String? _errorMessage;
  // 続きを読むためのトークン。null なら最後まで読んだ
  String? _continuationToken;
  // 続きのページを読んでいる（重ねて読まない）
  bool _isLoadingMore = false;
  // 続きの取得に失敗した。「再試行」が押されるまで自動では取り直さない（既存と同じく自動の再試行はしない）
  bool _loadMoreFailed = false;

  @override
  void initState() {
    super.initState();
    _loadFirstPage();
  }

  /// 先頭のページを読む
  Future<void> _loadFirstPage() async {
    setState(() {
      _photos = null;
      _errorMessage = null;
    });
    try {
      final page = await widget.apiService.getPhotos(widget.tripId);
      if (!mounted) return;
      setState(() {
        _photos = page.photos;
        _continuationToken = page.continuationToken;
      });
    } catch (e) {
      debugPrint('PhotoGrid: 写真の一覧の読み込みエラー: $e');
      if (!mounted) return;
      setState(() =>
          _errorMessage = e is ApiException ? e.userMessage : '写真の読み込みに失敗しました');
    }
  }

  /// 続きのページを読んで末尾に足す。読んでいる最中や、最後まで読んだ後は何もしない
  Future<void> _loadMore() async {
    final token = _continuationToken;
    if (_isLoadingMore || _loadMoreFailed || token == null) return;
    setState(() => _isLoadingMore = true);
    try {
      final page = await widget.apiService
          .getPhotos(widget.tripId, continuationToken: token);
      if (!mounted) return;
      setState(() {
        _photos = [...?_photos, ...page.photos];
        _continuationToken = page.continuationToken;
        _isLoadingMore = false;
      });
    } catch (e) {
      debugPrint('PhotoGrid: 写真の続きの読み込みエラー: $e');
      if (!mounted) return;
      setState(() {
        _isLoadingMore = false;
        _loadMoreFailed = true;
      });
    }
  }

  /// 失敗した続きを「再試行」で取り直す
  void _retryLoadMore() {
    setState(() => _loadMoreFailed = false);
    _loadMore();
  }

  @override
  Widget build(BuildContext context) {
    final errorMessage = _errorMessage;
    if (errorMessage != null) {
      // 旅行の見出しは画面側に残し、写真の部分だけをエラーにする
      return SingleChildScrollView(
        child: MessageView(
          isLargeScreen: MediaQuery.of(context).size.width >= 1400,
          icon: Icons.error_outline,
          title: 'エラーが発生しました',
          message: errorMessage,
          buttonIcon: Icons.refresh,
          buttonLabel: '再試行',
          onPressed: _loadFirstPage,
          isError: true,
        ),
      );
    }
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
    return Column(
      children: [
        Expanded(
          child: GridView.builder(
            padding: const EdgeInsets.all(2),
            gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
              crossAxisCount: 3,
              mainAxisSpacing: 2,
              crossAxisSpacing: 2,
            ),
            itemCount: photos.length,
            itemBuilder: (context, index) {
              // 末尾の近くを組み立てる（下端に近づいた）ときに続きを読む。1ページ目が画面に収まる場合も、最初から下端にいるので読む
              if (index >= photos.length - _loadMoreThreshold) {
                WidgetsBinding.instance.addPostFrameCallback((_) {
                  if (mounted) _loadMore();
                });
              }
              return _PhotoTile(photo: photos[index]);
            },
          ),
        ),
        if (_loadMoreFailed)
          Padding(
            padding: const EdgeInsets.all(8),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Text('続きを読み込めませんでした',
                    style: AppTextStyles.body1
                        .copyWith(color: AppColors.textSecondary)),
                const SizedBox(width: 12),
                TextButton.icon(
                  onPressed: _retryLoadMore,
                  icon: const Icon(Icons.refresh),
                  label: const Text('再試行'),
                ),
              ],
            ),
          ),
        if (_isLoadingMore)
          Padding(
            padding: const EdgeInsets.all(12),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                const SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2)),
                const SizedBox(width: 12),
                Text('読み込み中...',
                    style: AppTextStyles.body1
                        .copyWith(color: AppColors.textSecondary)),
              ],
            ),
          ),
      ],
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
