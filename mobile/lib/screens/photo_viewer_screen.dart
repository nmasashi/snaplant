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
import '../widgets/category_edit_sheet.dart';
import '../widgets/comment_edit_dialog.dart';
import '../widgets/confirm_action_dialog.dart';
import '../widgets/retry_processing_dialog.dart';
import '../widgets/tag_edit_sheet.dart';
import '../widgets/tagged_photo_image.dart';
import 'catalog_entry_screen.dart';

/// 写真ビューア（docs/03_screen_design.md §4.6）
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
      this.loadMoreFailed,
      this.onRetryLoadMore,
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

  /// 一覧の続きのページの読み込みに失敗しているか（一覧と共有する）。失敗していたら、読み込み済みの末尾で知らせて
  /// [onRetryLoadMore] で読み直させる（docs/03_screen_design.md §4.6）。続きの無い一覧（タイムラインの場面）は渡さない
  final ValueListenable<bool>? loadMoreFailed;

  /// 失敗した続きのページを一覧に読み直させる
  final VoidCallback? onRetryLoadMore;

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
  // 項目へのリンクで種類の一覧を読んでいる。読む間の押し直しで、項目詳細を重ねて開かない
  bool _openingEntry = false;
  // 今出している写真の位置（上のバーの「やり直す」を出すかを決める）
  late int _index = widget.initialIndex;
  // タグを付ける間（写真の上のタップでその位置にタグを付ける。03 §5.7）
  bool _addingTag = false;
  // タグを消しているところ（送っている間は、ほかのタグを消す操作と「タグを付ける」を受けない）
  bool _sendingTag = false;

  /// 1枚の写真に付けられるタグの数（サーバの TAG_MAX_COUNT の既定値。05 §5.6）
  static const _maxTags = 20;

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
    // 上のバーの「やり直す」は今の写真のカテゴリで決まるので、写真が変わったら組み直す
    if (mounted) setState(() {});
    // 続きのページが写真の無いページ（続きはある）で返っても、末尾にいれば続けて読ませる（docs/03_screen_design.md §4.6）。
    // 一覧は読み込み中の印を戻す前に写真を知らせるので、次のフレームで頼む（空のページが続く上限で一覧が止める）
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted &&
          _index >= widget.photos.value.length - 1 &&
          widget.hasMore()) {
        widget.onReachEnd();
      }
    });
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
    // タグを付ける間も、次の写真には持ち越さない
    setState(() {
      _zoomed = false;
      _addingTag = false;
    });
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

  /// 続きのページの読み込みに失敗したときに、読み込み済みの末尾の写真（削除で使い切って続きを待っている間も）の下に出す知らせ
  Widget? _loadMoreFailedBar() {
    final failed = widget.loadMoreFailed;
    final retry = widget.onRetryLoadMore;
    if (failed == null || retry == null) return null;
    return ValueListenableBuilder<bool>(
      valueListenable: failed,
      builder: (context, isFailed, _) {
        // 削除で使い切って続きを待っている間は、今の位置が読み込み済みの写真の外にあるので、これで一緒に見る
        final atEnd = _index >= widget.photos.value.length - 1;
        if (!isFailed || !atEnd) return const SizedBox.shrink();
        return SafeArea(
          child: Container(
            color: Colors.black87,
            padding: const EdgeInsets.all(8),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                const Text('続きを読み込めませんでした',
                    style: TextStyle(color: Colors.white)),
                const SizedBox(width: 12),
                TextButton.icon(
                  onPressed: retry,
                  icon: const Icon(Icons.refresh),
                  label: const Text('再試行'),
                ),
              ],
            ),
          ),
        );
      },
    );
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
        .showSnackBar(const SnackBar(content: Text('受け付けました')));
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

  /// [photo] のカテゴリを、シートで選び直す（03 §5.6）
  Future<void> _editCategory(Photo photo) async {
    final updated = await showModalBottomSheet<Photo>(
      context: context,
      // 下へ払って閉じる操作は PopScope を通らず、保存を待っている間でも閉じてしまう（閉じると表示が古いまま残る）。
      // 閉じるのは「キャンセル」・端末の戻る操作・シートの外のタップ（どれも PopScope を通る）
      enableDrag: false,
      builder: (context) =>
          CategoryEditSheet(apiService: widget.apiService, photo: photo),
    );
    if (updated == null || !mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(const SnackBar(content: Text('カテゴリを変えました')));
    widget.onUpdated(updated);
  }

  /// [photo] の画像の中の [position]（割合）に、シートで名前と種類を聞いてタグを付ける。付けたらタグを付ける間を終える
  Future<void> _addTag(Photo photo, Offset position) async {
    final updated = await showModalBottomSheet<Photo>(
      context: context,
      isScrollControlled: true,
      // 下へ払って閉じる操作は PopScope を通らず、保存を待っている間でも閉じてしまう（カテゴリのシートと同じ）
      enableDrag: false,
      builder: (context) => TagEditSheet(
          apiService: widget.apiService,
          photo: photo,
          x: position.dx,
          y: position.dy),
    );
    if (updated == null || !mounted) return;
    setState(() => _addingTag = false);
    widget.onUpdated(updated);
  }

  /// [photo] の [index] 番目のタグを、確かめてから消す（同じ名前のほかのタグは残す）
  Future<void> _deleteTag(Photo photo, int index) async {
    if (_sendingTag) return;
    final name = photo.tags[index].name;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        content: Text('「$name」のタグを消しますか？'),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('キャンセル')),
          TextButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('消す')),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    setState(() => _sendingTag = true);
    try {
      final updated = await widget.apiService
          .updatePhotoTags(photo.id, [...photo.tags]..removeAt(index));
      if (mounted) widget.onUpdated(updated);
    } catch (e) {
      debugPrint('PhotoViewerScreen: タグの削除エラー: $e');
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text(e is ApiException ? e.userMessage : 'タグの削除に失敗しました')));
      }
    } finally {
      if (mounted) setState(() => _sendingTag = false);
    }
  }

  /// 種類 [kindKey]・名前 [name] の図鑑の項目詳細を開く。見出しの欄に種類の一覧の fields が要るので、先に種類の一覧を読む
  Future<void> _openEntry(String kindKey, String name) async {
    if (_openingEntry) return;
    _openingEntry = true;
    final List<CatalogKind> kinds;
    try {
      kinds = await widget.apiService.getCatalogKinds();
    } catch (e) {
      _openingEntry = false;
      debugPrint('PhotoViewerScreen: 図鑑の種類の一覧の読み込みエラー: $e');
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(e is ApiException ? e.userMessage : '図鑑の読み込みに失敗しました')));
      return;
    }
    _openingEntry = false;
    if (!mounted) return;
    // 種類の一覧に無い種類（種類を減らした後の古い識別）は開かない。サーバは項目の詳細の種類を同じ定義表で断るので、
    // 開いてもエラーの表示になる
    final kind = kinds.where((k) => k.kind == kindKey).firstOrNull;
    if (kind == null) {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('図鑑にこの種類がありません')));
      return;
    }
    await Navigator.push(
        context,
        MaterialPageRoute(
            builder: (_) => CatalogEntryScreen(
                apiService: widget.apiService,
                uploadQueue: widget.uploadQueue,
                kind: kind,
                name: name)));
  }

  /// 上のバーの、[photo] の解析を頼むボタン。印と説明は写真のカテゴリで決まる（植物を調べる・コメントを書いてもらう・分類し直す。03 §5.4）
  Widget _analysisButton(Photo photo) {
    final request = analysisRequestOf(photo);
    return IconButton(
      // 印と説明を決めた写真に頼む（ページの位置から引き直すと、送っている途中で別の写真になりうる）
      onPressed: () => _retry(photo),
      color: Colors.white,
      tooltip: request.title,
      icon: Icon(request.icon),
    );
  }

  /// 今出している写真。削除で読み込み済みの写真を使い切り、続きのページを待っている間は null
  Photo? get _shownPhoto {
    final photos = widget.photos.value;
    return _index < photos.length ? photos[_index] : null;
  }

  @override
  Widget build(BuildContext context) {
    // タグを付ける間の端末の戻る操作は、ビューアを閉じずに付ける間を終える（03 §5.7）
    return PopScope(
      canPop: !_addingTag,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) setState(() => _addingTag = false);
      },
      child: Scaffold(
        backgroundColor: Colors.black,
        bottomNavigationBar: _loadMoreFailedBar(),
        appBar: _showChrome
            ? AppBar(
                backgroundColor: Colors.black54,
                foregroundColor: Colors.white,
                actions: [
                  // タグが上限まである写真と、タグを消している間は押せない（03 §5.7）
                  if (_shownPhoto case final photo?)
                    IconButton(
                      onPressed: _sendingTag || photo.tags.length >= _maxTags
                          ? null
                          : () => setState(() => _addingTag = true),
                      color: Colors.white,
                      tooltip: 'タグを付ける',
                      icon: const Icon(Icons.sell_outlined),
                    ),
                  // 頼む写真が無い間（続きを待っている）と、その他の写真（調べるものが無い。03 §5.6）には出さない
                  if (_shownPhoto case final photo?
                      when photo.category != otherCategory)
                    _analysisButton(photo),
                  TextButton(
                    onPressed: _deleteCurrent,
                    style: TextButton.styleFrom(foregroundColor: Colors.white),
                    child: const Text('削除'),
                  ),
                ],
                // タグを付ける間の案内（03 §5.7）
                bottom: _addingTag
                    ? PreferredSize(
                        preferredSize: const Size.fromHeight(48),
                        child: Container(
                          color: Colors.black87,
                          padding: const EdgeInsets.only(left: 16),
                          child: Row(children: [
                            const Expanded(
                              child: Text('タグを付ける場所をタップしてください',
                                  style: TextStyle(color: Colors.white)),
                            ),
                            TextButton(
                              onPressed: () =>
                                  setState(() => _addingTag = false),
                              style: TextButton.styleFrom(
                                  foregroundColor: Colors.white),
                              child: const Text('やめる'),
                            ),
                          ]),
                        ),
                      )
                    : null,
              )
            : null,
        body: GestureDetector(
          // タグを付ける間は、写真のタップで上のバーを出し入れしない（タップはタグを付ける場所に使う）
          onTap: _addingTag
              ? null
              : () => setState(() => _showChrome = !_showChrome),
          child: ValueListenableBuilder<List<Photo>>(
            valueListenable: widget.photos,
            builder: (context, photos, _) => PageView.builder(
              controller: _pageController,
              // 拡大中とタグを付ける間は、前後の写真へ移らない
              physics: _zoomed || _addingTag
                  ? const NeverScrollableScrollPhysics()
                  : null,
              itemCount: photos.length,
              onPageChanged: (index) {
                setState(() => _index = index);
                if (index == photos.length - 1) widget.onReachEnd();
              },
              itemBuilder: (context, index) => _PhotoPage(
                  // 削除で後ろの写真が詰まったときに、前の写真の拡大の状態を引き継がない
                  key: ValueKey(photos[index].id),
                  photo: photos[index],
                  showInfo: _showChrome,
                  onRetry: () => _retry(photos[index]),
                  onEditComment: () => _editComment(photos[index]),
                  onEditCategory: () => _editCategory(photos[index]),
                  // タグを消している間は付けない（消す前のタグで保存して、消したタグを戻さない）
                  onTapImageAt: _addingTag && !_sendingTag
                      ? (position) => _addTag(photos[index], position)
                      : null,
                  onDeleteTag: (tagIndex) =>
                      _deleteTag(photos[index], tagIndex),
                  addingTag: _addingTag,
                  onOpenEntry: _openEntry,
                  onZoomChanged: (zoomed) {
                    if (zoomed != _zoomed) setState(() => _zoomed = zoomed);
                  }),
            ),
          ),
        ),
      ),
    );
  }
}

/// カテゴリのボタンの文言。手で決めたカテゴリには「（変更済み）」を付ける（AI がもう書き換えない。03 §5.6）。
/// カテゴリが無ければ「カテゴリを選ぶ」
String _categoryButtonLabel(Photo photo) {
  final category = photo.category;
  if (category == null) return 'カテゴリを選ぶ';
  final label = categoryLabel(category);
  return photo.categorySource == 'user' ? '$label（変更済み）' : label;
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
      required this.onEditCategory,
      required this.onTapImageAt,
      required this.onDeleteTag,
      required this.addingTag,
      required this.onOpenEntry,
      required this.onZoomChanged});

  final Photo photo;

  /// 下の情報を出すか
  final bool showInfo;

  /// 下の情報の「やり直す」（解析に失敗したときに出す）
  final VoidCallback onRetry;

  /// 「コメントを編集」
  final VoidCallback onEditComment;

  /// カテゴリのボタン（カテゴリを選ぶシートを開く）
  final VoidCallback onEditCategory;

  /// タグを付ける間に、画像の中をタップした（画像の中の割合）。タグを付ける間でないときと、タグを消している間は null
  final ValueChanged<Offset>? onTapImageAt;

  /// タグ（写真の上の名前・下の情報の札の「✕」）を消す（タグの番号）
  final ValueChanged<int> onDeleteTag;

  /// タグを付ける間か（写真の上の名前のタップで消さない）
  final bool addingTag;

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

  /// 下の情報の、文言と「やり直す」の行（解析に失敗した写真）。文言が長ければ折り返す
  Widget _withRetry(String message) {
    return Row(children: [
      Expanded(
        child: Text(message,
            style: AppTextStyles.body1.copyWith(color: Colors.white70)),
      ),
      TextButton(
        onPressed: widget.onRetry,
        style: _infoButtonStyle,
        child: const Text('やり直す'),
      ),
    ]);
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
    // 識別の種類と名前（図鑑に載る種類なら項目へのリンク、載らない種類なら文字で出す。
    // 分類と合わない写真は名前が null なので、どちらも出さない）
    final entry = switch (identification) {
      PhotoIdentification(
        matchesKind: true,
        :final kind,
        name: final String name
      ) =>
        (kind: kind, name: name),
      _ => null,
    };
    final comment = photo.comment;
    // 下の情報の高さの上限は、この写真の画面が使える高さ（上のバーの下）から決める
    return LayoutBuilder(
      builder: (context, constraints) => Column(
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
                // 画像の上にタグを出す（画像を読み込めた後だけ。03 §5.7）
                imageBuilder: (context, image) => TaggedPhotoImage(
                  image: image,
                  tags: photo.tags,
                  showTags: widget.showInfo,
                  onTapAt: widget.onTapImageAt,
                  onTapTag: widget.addingTag ? null : widget.onDeleteTag,
                ),
                // 原寸を読むまでの間は、グリッドで読んだサムネイルを出す。
                // 読み込んだ後もサムネイルは透明になって原寸の上に重なったまま残るので、タップを受けない（写真の上のタグに届かせる。§5.7）
                placeholder: (context, url) => thumbnailUrl == null
                    ? const SizedBox.shrink()
                    : IgnorePointer(
                        child: CachedNetworkImage(
                          imageUrl: thumbnailUrl,
                          cacheKey: thumbnailCacheKey(photo.id),
                          cacheManager: PhotoCacheManager.thumbnails,
                          fit: BoxFit.contain,
                        ),
                      ),
                // SAS の期限切れ（403）などで読めないときは、グリッドと同じ文言を出す。戻って一覧を読み直せば新しい URL になる
                errorWidget: (context, url, error) => const Center(
                  child: Text('画像を読み込めません',
                      style: TextStyle(color: Colors.white70)),
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
              constraints:
                  BoxConstraints(maxHeight: constraints.maxHeight * 0.5),
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
                          // カテゴリは押して手で直せる（03 §5.6）。分類を待っている・しているカテゴリの無い写真には出さない
                          if (photo.category != null ||
                              !isProcessingInProgress(photo.processingState))
                            Padding(
                              padding: const EdgeInsets.symmetric(vertical: 4),
                              child: OutlinedButton(
                                onPressed: widget.onEditCategory,
                                style: OutlinedButton.styleFrom(
                                    foregroundColor: Colors.white,
                                    side: const BorderSide(
                                        color: Colors.white70)),
                                // 文字の後ろに、選べることを示す印を置く
                                child: Row(
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                    Text(_categoryButtonLabel(photo)),
                                    const SizedBox(width: 4),
                                    const Icon(Icons.expand_more, size: 18),
                                  ],
                                ),
                              ),
                            ),
                          // タグの一覧。写真の上の点は読み上げで探せないので、ここでも知らせ、消せるようにする（03 §5.7）
                          if (photo.tags.isNotEmpty)
                            Padding(
                              padding: const EdgeInsets.symmetric(vertical: 4),
                              child: Wrap(
                                spacing: 4,
                                runSpacing: 4,
                                crossAxisAlignment: WrapCrossAlignment.center,
                                children: [
                                  Text('タグ:',
                                      style: AppTextStyles.body1
                                          .copyWith(color: Colors.white)),
                                  for (final (index, tag) in photo.tags.indexed)
                                    Chip(
                                      label: Text(tag.name),
                                      visualDensity: VisualDensity.compact,
                                      onDeleted: () =>
                                          widget.onDeleteTag(index),
                                      deleteButtonTooltipMessage:
                                          '${tag.name}のタグを消す',
                                    ),
                                ],
                              ),
                            ),
                          if (isProcessingInProgress(photo.processingState))
                            Text(identifying ? '識別中...' : '分類中...',
                                style: AppTextStyles.body1
                                    .copyWith(color: Colors.white70)),
                          if (isProcessingFailed(photo.processingState))
                            _withRetry(identifying ? '識別に失敗しました' : '分類に失敗しました'),
                          // 図鑑に載る種類は項目へのリンク、載せない種類（食べ物・風景）は文字で出す
                          if (entry != null)
                            if (isListedInCatalog(entry.kind))
                              TextButton(
                                onPressed: () =>
                                    widget.onOpenEntry(entry.kind, entry.name),
                                style: _infoLinkStyle,
                                child: Text('${entry.name} >'),
                              )
                            else
                              Text(entry.name,
                                  style: AppTextStyles.body1.copyWith(
                                      color: Colors.white,
                                      fontWeight: FontWeight.w500)),
                          // カテゴリは上のボタンで手で直すので、案内の横に「やり直す」は置かない（03 §5.6）
                          if (identification != null &&
                              !identification.matchesKind)
                            Text(
                                '${categoryLabel(identification.kind)}が写っていないようです。カテゴリを確かめてください',
                                style: AppTextStyles.body1
                                    .copyWith(color: Colors.white70)),
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
      ),
    );
  }
}
