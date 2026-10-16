import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import '../models/photo.dart';
import '../services/api_service.dart';
import '../theme/app_colors.dart';
import '../theme/app_text_styles.dart';
import '../utils/photo_cache_manager.dart';
import '../utils/taken_at.dart';
import 'message_view.dart';
import 'photo_selection.dart';

/// 写真のサムネイルのグリッド（docs/travel-album/03_screen_design.md §3・§4.4）
///
/// 写真の一覧を自分で読む。旅行詳細と旅行に属さない写真の画面で使う
class PhotoGrid extends StatefulWidget {
  const PhotoGrid(
      {super.key,
      required this.apiService,
      required this.tripId,
      required this.emptyTitle,
      required this.emptyMessage,
      this.selection,
      this.onTripNotFound});

  final ApiService apiService;

  /// 旅行の id。旅行に属さない写真なら `none`
  final String tripId;

  /// 写真が0枚のときの案内（画面ごとに文言が違う）
  final String emptyTitle;
  final String emptyMessage;

  /// 写真の一覧が 404 `TRIP_NOT_FOUND`（別の端末で旅行が消された）と分かったときに呼ぶ。
  /// 画面全体を「この旅行は削除されています」にするのは画面の役目なので、グリッドは失敗として出さずに知らせるだけにする。
  /// 知らせた後は読み込み中の状態も戻さない（画面がグリッドを外す前提。残すと続きのページを二度と取りに行かない）
  final VoidCallback? onTripNotFound;

  /// 複数選択。渡さなければ写真を選べない
  final PhotoSelection? selection;

  @override
  State<PhotoGrid> createState() => _PhotoGridState();
}

/// 末尾から何枚以内を組み立てたら続きを読むか（3列なので2行分）
const _loadMoreThreshold = 6;

/// 空のページがこの回数続いたら、自動で続きを読むのをやめて「再試行」を出す。
/// サーバは空のページを読み直しても空ならトークン付きで返すことがあり、それが続くと要求を送り続けてしまう
const _maxConsecutiveEmptyPages = 3;

/// 画面の右下に浮かぶ「写真を追加」の分だけ、一覧と末尾の表示を上に空ける高さ。
/// 空けないと、最後の行と末尾の「再試行」がボタンの下に隠れて押せない
const _floatingButtonClearance = 72.0;

/// サムネイルを読むときの横幅（画素）。3列のマスは端末で 400 画素前後
const _tileDecodeWidth = 400;

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
  // 先頭のページで一覧を置き換えるたびに進める。読み込みは始めたときの世代を控え、その間に進んでいたら結果（成功も失敗も）を捨てる。
  // 「再試行」と引っ張る読み直しが重なっても、先に終わった方を採り、後から届いた古い結果で上書きしない
  int _generation = 0;
  // 続けて返った空のページの数。[_maxConsecutiveEmptyPages] に達したら自動で読むのをやめる
  int _consecutiveEmptyPages = 0;

  @override
  void initState() {
    super.initState();
    _loadFirstPage();
  }

  /// 写真の一覧の取得が 404 `TRIP_NOT_FOUND`（別の端末で旅行が消された）なら画面へ知らせて true を返す。
  /// 失敗として出さないのは、画面全体を「この旅行は削除されています」にするのが画面の役目だから（先頭・続き・読み直しのどれでも同じ）
  bool _notifyIfTripNotFound(Object error) {
    final onTripNotFound = widget.onTripNotFound;
    if (onTripNotFound == null ||
        error is! ApiException ||
        !error.isTripNotFound) {
      return false;
    }
    onTripNotFound();
    return true;
  }

  /// 先頭のページを読む
  Future<void> _loadFirstPage() async {
    final generation = _generation;
    setState(() {
      _photos = null;
      _errorMessage = null;
    });
    try {
      final page = await widget.apiService.getPhotos(widget.tripId);
      if (!mounted || generation != _generation) return;
      _applyFirstPage(page);
    } catch (e) {
      debugPrint('PhotoGrid: 写真の一覧の読み込みエラー: $e');
      if (!mounted || generation != _generation) return;
      if (_notifyIfTripNotFound(e)) return;
      setState(() =>
          _errorMessage = e is ApiException ? e.userMessage : '写真の読み込みに失敗しました');
    }
  }

  /// 先頭のページで一覧を置き換え、世代を進める（それより前に始めた読み込みの結果は捨てられる）
  void _applyFirstPage(PhotoPage page) {
    setState(() {
      _generation++;
      _errorMessage = null;
      _photos = page.photos;
      _continuationToken = page.continuationToken;
      _isLoadingMore = false;
      _loadMoreFailed = false;
      _consecutiveEmptyPages = page.photos.isEmpty ? 1 : 0;
    });
  }

  /// 下に引っ張ったとき、先頭のページから読み直す（続きのトークンと2ページ目以降は捨てる）。
  /// 読み直しの間は今のグリッドを出したままにする
  Future<void> _refresh() async {
    final generation = _generation;
    try {
      final page = await widget.apiService.getPhotos(widget.tripId);
      if (!mounted || generation != _generation) return;
      _applyFirstPage(page);
    } catch (e) {
      debugPrint('PhotoGrid: 写真の一覧の読み直しエラー: $e');
      if (!mounted || generation != _generation) return;
      if (_notifyIfTripNotFound(e)) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(e is ApiException ? e.userMessage : '写真の読み込みに失敗しました')));
    }
  }

  /// 続きのページを読んで末尾に足す。読んでいる最中や、最後まで読んだ後は何もしない
  Future<void> _loadMore() async {
    final token = _continuationToken;
    if (_isLoadingMore || _loadMoreFailed || token == null) return;
    final generation = _generation;
    setState(() => _isLoadingMore = true);
    try {
      final page = await widget.apiService
          .getPhotos(widget.tripId, continuationToken: token);
      if (!mounted || generation != _generation) return;
      setState(() {
        _photos = [...?_photos, ...page.photos];
        _continuationToken = page.continuationToken;
        _isLoadingMore = false;
        _consecutiveEmptyPages =
            page.photos.isEmpty ? _consecutiveEmptyPages + 1 : 0;
        // 空のページが続くなら止める（続きがあるかは分からないので、0枚の案内ではなく「再試行」を出す）
        _loadMoreFailed = page.continuationToken != null &&
            _consecutiveEmptyPages >= _maxConsecutiveEmptyPages;
      });
    } catch (e) {
      debugPrint('PhotoGrid: 写真の続きの読み込みエラー: $e');
      if (!mounted || generation != _generation) return;
      if (_notifyIfTripNotFound(e)) return;
      setState(() {
        _isLoadingMore = false;
        _loadMoreFailed = true;
      });
    }
  }

  /// 失敗した続きを「再試行」で取り直す
  void _retryLoadMore() {
    setState(() {
      _loadMoreFailed = false;
      _consecutiveEmptyPages = 0;
    });
    _loadMore();
  }

  /// グリッドの代わりに出す表示（0枚の案内・エラー）を、下に引っ張って読み直せる形にする（§3）。
  /// 画面より短くても引っ張れるよう、高さいっぱいの領域の中央に置く
  Widget _pullToRefresh(Widget child) {
    return RefreshIndicator(
      onRefresh: _refresh,
      color: AppColors.primary,
      child: LayoutBuilder(
        builder: (context, constraints) => SingleChildScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          child: ConstrainedBox(
            constraints: BoxConstraints(minHeight: constraints.maxHeight),
            child: Center(child: child),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final errorMessage = _errorMessage;
    if (errorMessage != null) {
      // 旅行の見出しは画面側に残し、写真の部分だけをエラーにする
      return _pullToRefresh(
        MessageView(
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
    widget.selection
        ?.updateLoaded([for (final p in photos ?? const <Photo>[]) p.id]);
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
    if (photos.isEmpty && _continuationToken != null) {
      // 空のページでもトークンがあれば続きがある（サーバは空のページを読み直しても空なら、トークン付きで返すことがある）。
      // サムネイルが無いので下端に近づくきっかけが来ない。ここで続きを読む
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _loadMore();
      });
    }
    if (photos.isEmpty && _continuationToken == null) {
      return _pullToRefresh(
        Padding(
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
    final hasFooter = _loadMoreFailed || _isLoadingMore;
    return Column(
      children: [
        Expanded(
          child: RefreshIndicator(
            onRefresh: _refresh,
            color: AppColors.primary,
            child: GridView.builder(
              // 写真が少なく画面に収まっていても、下に引っ張って読み直せるように
              physics: const AlwaysScrollableScrollPhysics(),
              padding: EdgeInsets.fromLTRB(
                  2, 2, 2, hasFooter ? 2 : _floatingButtonClearance),
              gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                crossAxisCount: 3,
                mainAxisSpacing: 2,
                crossAxisSpacing: 2,
              ),
              itemCount: photos.length,
              itemBuilder: (context, index) {
                // 末尾の近くを組み立てる（下端に近づいた）ときに続きを読む。1ページ目が画面に収まる場合も、最初から下端にいるので読む
                if (index >= photos.length - _loadMoreThreshold &&
                    _continuationToken != null &&
                    !_isLoadingMore &&
                    !_loadMoreFailed) {
                  WidgetsBinding.instance.addPostFrameCallback((_) {
                    if (mounted) _loadMore();
                  });
                }
                return _PhotoTile(
                    photo: photos[index], selection: widget.selection);
              },
            ),
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
        if (hasFooter) const SizedBox(height: _floatingButtonClearance),
      ],
    );
  }
}

/// サムネイル1枚。撮影日時を読み上げのラベルにする（画像だけでは写真を区別できないため）
class _PhotoTile extends StatelessWidget {
  const _PhotoTile({required this.photo, this.selection});

  final Photo photo;
  final PhotoSelection? selection;

  @override
  Widget build(BuildContext context) {
    final selection = this.selection;
    if (selection == null) {
      return _buildImage(selected: null);
    }
    return ListenableBuilder(
      listenable: selection,
      builder: (context, _) {
        // 選択モードの外では選択の状態そのものを出さない（読み上げが全部のサムネイルを「未選択」と読まないように）
        final selected =
            selection.isActive ? selection.isSelected(photo.id) : null;
        return GestureDetector(
          onLongPress: () => selection.start(photo.id),
          // 選択モードでなければ何もしない（写真ビューアは PR 7）
          onTap: selection.isActive ? () => selection.toggle(photo.id) : null,
          child: _buildImage(selected: selected),
        );
      },
    );
  }

  /// [selected] は選択モードでなければ null
  Widget _buildImage({required bool? selected}) {
    return Semantics(
      label: formatTakenAt(photo.takenAt),
      container: true,
      selected: selected,
      child: Stack(fit: StackFit.expand, children: [
        CachedNetworkImage(
          // サムネイルが無い写真は原寸をサムネイルの大きさで出す
          imageUrl: photo.thumbnailUrl ?? photo.imageUrl,
          cacheKey: photo.thumbnailUrl != null
              ? thumbnailCacheKey(photo.id)
              : imageCacheKey(photo.id),
          cacheManager: photo.thumbnailUrl != null
              ? PhotoCacheManager.thumbnails
              : PhotoCacheManager.images,
          // 原寸を出すときも、マスの大きさに縮めて読む（数千万画素のまま読むとメモリが足りなくなる）
          memCacheWidth: _tileDecodeWidth,
          fit: BoxFit.cover,
          placeholder: (context, url) =>
              const ColoredBox(color: AppColors.surfaceVariant),
          // SAS の期限切れ（403）でも読めなくなる。自動では取り直さず、下に引っ張れば取り直せる（§3）
          errorWidget: (context, url, error) => const ColoredBox(
            color: AppColors.surfaceVariant,
            child: Center(
              child: Padding(
                padding: EdgeInsets.all(4),
                child: Text('画像を読み込めません',
                    textAlign: TextAlign.center,
                    style: TextStyle(
                        fontSize: 11, color: AppColors.textSecondary)),
              ),
            ),
          ),
        ),
        if (selected == true) ...[
          const ColoredBox(color: Color(0x553E7D32)),
          const Positioned(
            top: 4,
            right: 4,
            child: Icon(Icons.check_circle, color: Colors.white),
          ),
        ],
      ]),
    );
  }
}
