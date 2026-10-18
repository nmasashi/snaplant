import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import '../models/catalog.dart';
import '../models/photo.dart';
import '../services/api_service.dart';
import '../services/upload_queue.dart';
import '../theme/app_text_styles.dart';
import '../utils/photo_cache_manager.dart';
import '../utils/photo_category.dart';
import '../utils/taken_at.dart';
import '../widgets/comment_edit_dialog.dart';
import '../widgets/confirm_action_dialog.dart';
import '../widgets/retry_processing_dialog.dart';
import 'catalog_entry_screen.dart';

/// 写真ビューア（docs/travel-album/03_screen_design.md §4.6）
///
/// 開いた一覧の写真を、一覧と同じ順で左右にスワイプして見る
class PhotoViewerScreen extends StatefulWidget {
  const PhotoViewerScreen(
      {super.key,
      required this.apiService,
      required this.uploadQueue,
      required this.photos,
      required this.initialIndex,
      required this.onReachEnd,
      required this.hasMore,
      required this.onDeleted,
      required this.onUpdated});

  final ApiService apiService;

  /// 写真の送信の列（図鑑の項目詳細を開くときに渡す。項目詳細の写真のグリッドが要る）
  final UploadQueue uploadQueue;

  /// 一覧の読み込み済みの写真（一覧と共有する。一覧が続きのページを読むと伸びる）
  final ValueListenable<List<Photo>> photos;

  /// 最初に出す写真の位置（[photos] の添え字）
  final int initialIndex;

  /// 読み込み済みの末尾の写真まで来たときに呼ぶ（一覧が続きのページを読む）
  final VoidCallback onReachEnd;

  /// 一覧にまだ読んでいない続きのページがあるか
  final bool Function() hasMore;

  /// 写真を削除できたときに呼ぶ（一覧の読み込み済みの写真から除く）
  final void Function(String photoId) onDeleted;

  /// 写真が変わったとき（解析のやり直しを受け付けた・コメントを直した）に呼ぶ
  /// （一覧の読み込み済みの写真を置き換える。ビューアの表示もそれで変わる）
  final void Function(Photo photo) onUpdated;

  @override
  State<PhotoViewerScreen> createState() => _PhotoViewerScreenState();
}

class _PhotoViewerScreenState extends State<PhotoViewerScreen> {
  late final _pageController = PageController(initialPage: widget.initialIndex);
  // 上のバーと下の情報を出しているか（画面のタップで切り替える）
  bool _showChrome = true;
  // 今の写真を拡大している（拡大中はスワイプで前後に移らず、画像を動かす）
  bool _zoomed = false;
  // 削除で読み込み済みの写真を使い切ったときの位置。続きのページが届いたらここへ移る
  int? _pendingIndex;

  @override
  void initState() {
    super.initState();
    widget.photos.addListener(_onPhotosChanged);
  }

  @override
  void dispose() {
    widget.photos.removeListener(_onPhotosChanged);
    _pageController.dispose();
    super.dispose();
  }

  /// 続きのページが届いて、削除の後に待っていた位置に写真が来たら、そこへ移る
  void _onPhotosChanged() {
    final pending = _pendingIndex;
    if (pending == null || widget.photos.value.length <= pending) return;
    _pendingIndex = null;
    // 件数が増えた PageView が組み直されてから移る
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _pageController.jumpToPage(pending);
    });
  }

  /// 今出している写真を、確かめてから削除する
  Future<void> _deleteCurrent() async {
    final current = _current();
    if (current == null) return;
    final (index, photo) = current;
    final deleted = await showDialog<bool>(
      context: context,
      builder: (context) => ConfirmActionDialog<bool>(
        title: '写真を削除',
        message: 'この写真を削除しますか？\nこの操作は元に戻せません。',
        confirmLabel: '削除',
        busyLabel: '削除中...',
        failureMessage: '写真の削除に失敗しました',
        onConfirm: () async {
          try {
            await widget.apiService.deletePhoto(photo.id);
          } on ApiException catch (e) {
            // 既に無い（別の端末で消された）なら、消せたのと同じ
            if (!e.isPhotoNotFound) rethrow;
          }
          return true;
        },
      ),
    );
    if (deleted != true || !mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(const SnackBar(content: Text('写真を削除しました')));
    widget.onDeleted(photo.id);
    // 消した写真の拡大は次の写真に持ち越さない（ページは写真の id で作り直すので、スワイプの停止だけを解く）
    setState(() => _zoomed = false);
    // 後ろの写真が今の位置に詰まったら、それが次の写真。それが読み込み済みの末尾なら続きを読ませる
    // （ページの位置が変わらないので onPageChanged は呼ばれない）
    final remaining = widget.photos.value.length;
    if (index < remaining) {
      if (index == remaining - 1) widget.onReachEnd();
      return;
    }
    // 読み込み済みの写真を使い切った。続きのページがあれば読ませて、届いたら次の写真へ移る
    if (widget.hasMore()) {
      _pendingIndex = index;
      // 末尾の写真に来た時点で、ふつうは一覧（グリッドかビューア）が続きを読み始めている。
      // 念のため頼んでおく（読んでいる最中や失敗の後なら一覧の側で何もしない）
      widget.onReachEnd();
      return;
    }
    // 次の写真が無い（一覧の末尾の写真だった）なら一覧へ戻る
    Navigator.pop(context);
  }

  /// 今出している写真の解析のやり直しを頼む
  Future<void> _retryCurrent() async {
    final current = _current();
    if (current != null) await _retry(current.$2);
  }

  /// 今出している写真の位置と写真。削除で読み込み済みの写真を使い切り、続きのページを待っている間は null
  /// （そのときの位置は読み込み済みの写真の外にある）。位置と写真を一度に読み、両者がずれないようにする
  (int, Photo)? _current() {
    final photos = widget.photos.value;
    final index = _pageController.page!.round();
    return index < photos.length ? (index, photos[index]) : null;
  }

  /// [photo] の解析のやり直しを、ダイアログで手がかりを聞いてから頼む
  Future<void> _retry(Photo photo) async {
    final accepted = await showDialog<Photo>(
      context: context,
      builder: (context) =>
          RetryProcessingDialog(apiService: widget.apiService, photo: photo),
    );
    if (accepted == null || !mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(const SnackBar(content: Text('やり直しを受け付けました')));
    widget.onUpdated(accepted);
  }

  /// [photo] のコメントを、ダイアログで直す
  Future<void> _editComment(Photo photo) async {
    final updated = await showDialog<Photo>(
      context: context,
      builder: (context) =>
          CommentEditDialog(apiService: widget.apiService, photo: photo),
    );
    if (updated == null || !mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(const SnackBar(content: Text('コメントを保存しました')));
    widget.onUpdated(updated);
  }

  /// 種類 [kindKey]・名前 [name] の図鑑の項目詳細を開く。見出しの欄に種類の一覧の fields が要るので、先に種類の一覧を読む
  Future<void> _openEntry(String kindKey, String name) async {
    final List<CatalogKind> kinds;
    try {
      kinds = await widget.apiService.getCatalogKinds();
    } catch (e) {
      debugPrint('PhotoViewerScreen: 図鑑の種類の一覧の読み込みエラー: $e');
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(e is ApiException ? e.userMessage : '図鑑の読み込みに失敗しました')));
      return;
    }
    if (!mounted) return;
    // 種類の一覧に無い種類（種類を減らした後の古い識別）は、欄の無い見出しで開く
    final kind = kinds.where((k) => k.kind == kindKey).firstOrNull ??
        CatalogKind(kind: kindKey, label: kindKey, fields: const []);
    await Navigator.push(
        context,
        MaterialPageRoute(
            builder: (_) => CatalogEntryScreen(
                apiService: widget.apiService,
                uploadQueue: widget.uploadQueue,
                kind: kind,
                name: name)));
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
                  onPressed: _retryCurrent,
                  style: TextButton.styleFrom(foregroundColor: Colors.white),
                  child: const Text('やり直す'),
                ),
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
            physics: _zoomed ? const NeverScrollableScrollPhysics() : null,
            itemCount: photos.length,
            onPageChanged: (index) {
              if (index == photos.length - 1) widget.onReachEnd();
            },
            itemBuilder: (context, index) => _PhotoPage(
                // 削除で後ろの写真が詰まったときに、前の写真の拡大の状態を引き継がない
                key: ValueKey(photos[index].id),
                photo: photos[index],
                showInfo: _showChrome,
                onRetry: () => _retry(photos[index]),
                onEditComment: () => _editComment(photos[index]),
                onOpenEntry: _openEntry,
                onZoomChanged: (zoomed) {
                  if (zoomed != _zoomed) setState(() => _zoomed = zoomed);
                }),
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

/// 写真1枚の画面（原寸の画像と、下の情報）。ピンチで拡大できる
class _PhotoPage extends StatefulWidget {
  const _PhotoPage(
      {super.key,
      required this.photo,
      required this.showInfo,
      required this.onRetry,
      required this.onEditComment,
      required this.onOpenEntry,
      required this.onZoomChanged});

  final Photo photo;

  /// 下の情報を出すか
  final bool showInfo;

  /// 下の情報の「やり直す」（解析に失敗したとき・分類と合わない写真に出す）
  final VoidCallback onRetry;

  /// 「コメントを編集」
  final VoidCallback onEditComment;

  /// 図鑑の項目へのリンク（種類と名前で開く）
  final void Function(String kind, String name) onOpenEntry;

  /// 拡大したか・等倍に戻ったかを知らせる（拡大中は前後の写真へのスワイプを止める）
  final ValueChanged<bool> onZoomChanged;

  @override
  State<_PhotoPage> createState() => _PhotoPageState();
}

class _PhotoPageState extends State<_PhotoPage> {
  /// 下の情報のボタン。暗い下の情報の上でも読めるよう、上のバーのボタンと同じ白にする
  static final _infoButtonStyle =
      TextButton.styleFrom(foregroundColor: Colors.white);

  /// 下の情報の行として置くボタン（項目へのリンク・「コメントを編集」）。左端を他の行の文字とそろえる
  static final _infoLinkStyle = TextButton.styleFrom(
      foregroundColor: Colors.white, padding: EdgeInsets.zero);

  final _transformation = TransformationController();
  bool _zoomed = false;

  @override
  void dispose() {
    _transformation.dispose();
    super.dispose();
  }

  /// 指を離したときの倍率で、拡大中かを決める
  void _onInteractionEnd(ScaleEndDetails details) {
    final zoomed = _transformation.value.getMaxScaleOnAxis() > 1.01;
    if (zoomed == _zoomed) return;
    setState(() => _zoomed = zoomed);
    widget.onZoomChanged(zoomed);
  }

  @override
  Widget build(BuildContext context) {
    final photo = widget.photo;
    final thumbnailUrl = photo.thumbnailUrl;
    // 識別の段（step が identify）なら、状態を「識別中...」「識別に失敗しました」と出す（03 §5.1）
    final identifying = photo.processingStep == 'identify';
    final identification = photo.identification;
    // 項目へのリンクの名前（分類と合わない写真は名前が null なので、リンクを出さない）
    final entryName = identification != null && identification.matchesKind
        ? identification.name
        : null;
    final comment = photo.comment;
    return Column(
      children: [
        Expanded(
          child: InteractiveViewer(
            transformationController: _transformation,
            maxScale: 4,
            // 等倍の間は1本指の動きを前後の写真へのスワイプに譲る
            panEnabled: _zoomed,
            onInteractionEnd: _onInteractionEnd,
            child: CachedNetworkImage(
              imageUrl: photo.imageUrl,
              cacheKey: imageCacheKey(photo.id),
              cacheManager: PhotoCacheManager.images,
              fit: BoxFit.contain,
              // 原寸を読むまでの間は、グリッドで読んだサムネイルを出す
              placeholder: (context, url) => thumbnailUrl == null
                  ? const SizedBox.shrink()
                  : CachedNetworkImage(
                      imageUrl: thumbnailUrl,
                      cacheKey: thumbnailCacheKey(photo.id),
                      cacheManager: PhotoCacheManager.thumbnails,
                      fit: BoxFit.contain,
                    ),
              // SAS の期限切れ（403）などで読めないときは、グリッドと同じ文言を出す。戻って一覧を読み直せば新しい URL になる
              errorWidget: (context, url, error) => const Center(
                child:
                    Text('画像を読み込めません', style: TextStyle(color: Colors.white70)),
              ),
            ),
          ),
        ),
        if (widget.showInfo)
          Container(
            width: double.infinity,
            // コメントの長さは AI が返す文で決まる。下の情報は画面の高さの半分までにし、超える分は下の情報の中でスクロールする。
            // 「コメントを編集」はスクロールの外に置き、いつも押せるようにする
            // （固定の高さのまま置くと、小さな端末で写真と「コメントを編集」が画面の外に出る）
            constraints: BoxConstraints(
                maxHeight: MediaQuery.sizeOf(context).height * 0.5),
            color: Colors.black54,
            padding: const EdgeInsets.all(16),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Flexible(
                  child: SingleChildScrollView(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(formatTakenAt(photo.takenAt),
                            style: AppTextStyles.body1
                                .copyWith(color: Colors.white)),
                        Text(_placeText(photo),
                            style: AppTextStyles.body1
                                .copyWith(color: Colors.white)),
                        if (photo.category != null &&
                            photo.category != otherCategory)
                          Text(categoryLabel(photo.category!),
                              style: AppTextStyles.body1
                                  .copyWith(color: Colors.white)),
                        if (isProcessingInProgress(photo.processingState))
                          Text(identifying ? '識別中...' : '分類中...',
                              style: AppTextStyles.body1
                                  .copyWith(color: Colors.white70)),
                        if (isProcessingFailed(photo.processingState))
                          Row(children: [
                            Text(identifying ? '識別に失敗しました' : '分類に失敗しました',
                                style: AppTextStyles.body1
                                    .copyWith(color: Colors.white70)),
                            TextButton(
                              onPressed: widget.onRetry,
                              style: _infoButtonStyle,
                              child: const Text('やり直す'),
                            ),
                          ]),
                        if (entryName != null)
                          TextButton(
                            onPressed: () => widget.onOpenEntry(
                                identification!.kind, entryName),
                            style: _infoLinkStyle,
                            child: Text('$entryName >'),
                          ),
                        if (identification != null &&
                            !identification.matchesKind)
                          Row(children: [
                            Expanded(
                              child: Text('分類と合わない写真です。やり直しで手がかりを付けてください',
                                  style: AppTextStyles.body1
                                      .copyWith(color: Colors.white70)),
                            ),
                            TextButton(
                              onPressed: widget.onRetry,
                              style: _infoButtonStyle,
                              child: const Text('やり直す'),
                            ),
                          ]),
                        if (comment != null)
                          Text(
                              photo.commentSource == 'user'
                                  ? '$comment（編集済み）'
                                  : comment,
                              style: AppTextStyles.body1
                                  .copyWith(color: Colors.white)),
                      ],
                    ),
                  ),
                ),
                TextButton(
                  onPressed: widget.onEditComment,
                  style: _infoLinkStyle,
                  child: const Text('コメントを編集'),
                ),
              ],
            ),
          ),
      ],
    );
  }
}
