import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import '../models/catalog.dart';
import '../services/api_service.dart';
import '../services/upload_queue.dart';
import '../theme/app_colors.dart';
import '../theme/app_text_styles.dart';
import '../utils/photo_cache_manager.dart';
import '../widgets/confidence_badge.dart';
import '../widgets/message_view.dart';
import 'catalog_entry_screen.dart';

/// 図鑑のタブ（種類のタブ → 項目の一覧。docs/travel-album/03_screen_design.md §6.1）
///
/// 種類のタブは種類の一覧（`GET /api/catalog/kinds`）から作る。下のタブの「図鑑」（起動時のタブ）
class CatalogScreen extends StatefulWidget {
  const CatalogScreen(
      {super.key,
      required this.apiService,
      required this.uploadQueue,
      required this.onOpenSettings});

  final ApiService apiService;

  /// 写真の送信の列（項目詳細の写真のグリッドが要る）
  final UploadQueue uploadQueue;

  /// 設定画面を開く
  final Future<void> Function() onOpenSettings;

  @override
  State<CatalogScreen> createState() => _CatalogScreenState();
}

class _CatalogScreenState extends State<CatalogScreen> {
  List<CatalogKind>? _kinds;
  String? _errorMessage;

  @override
  void initState() {
    super.initState();
    _loadKinds();
  }

  Future<void> _loadKinds() async {
    setState(() {
      _errorMessage = null;
      _kinds = null;
    });
    try {
      final kinds = await widget.apiService.getCatalogKinds();
      if (!mounted) return;
      setState(() => _kinds = kinds);
    } catch (e) {
      if (!mounted) return;
      setState(() => _errorMessage = _catalogErrorMessage(e));
    }
  }

  @override
  Widget build(BuildContext context) {
    final kinds = _kinds;
    final appBarActions = [
      IconButton(
        icon: const Icon(Icons.settings),
        tooltip: '設定',
        onPressed: widget.onOpenSettings,
      ),
    ];
    if (kinds == null) {
      final errorMessage = _errorMessage;
      return Scaffold(
        appBar: AppBar(title: const Text('図鑑'), actions: appBarActions),
        body: errorMessage != null
            ? MessageView(
                isLargeScreen: MediaQuery.of(context).size.width >= 1400,
                icon: Icons.error_outline,
                title: 'エラーが発生しました',
                message: errorMessage,
                buttonIcon: Icons.refresh,
                buttonLabel: '再試行',
                onPressed: _loadKinds,
                isError: true,
              )
            : const _Loading(),
      );
    }
    return DefaultTabController(
      length: kinds.length,
      child: Scaffold(
        appBar: AppBar(
          title: const Text('図鑑'),
          actions: appBarActions,
          bottom:
              TabBar(tabs: [for (final kind in kinds) Tab(text: kind.label)]),
        ),
        // タブを切り替えると、離れたタブの一覧は破棄され、戻ると先頭から読み直す（03 §6.1）
        body: TabBarView(
          children: [
            for (final kind in kinds)
              _CatalogEntryList(
                  apiService: widget.apiService,
                  uploadQueue: widget.uploadQueue,
                  kind: kind),
          ],
        ),
      ),
    );
  }
}

/// 図鑑の読み込みの失敗の文言（`ApiException` ならその言い換え。03 §6.1）
String _catalogErrorMessage(Object error) =>
    error is ApiException ? error.userMessage : '図鑑の読み込みに失敗しました';

/// 読み込み中の表示
class _Loading extends StatelessWidget {
  const _Loading();

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const CircularProgressIndicator(
              valueColor: AlwaysStoppedAnimation(AppColors.primary)),
          const SizedBox(height: 16),
          Text('図鑑を読み込み中...',
              style:
                  AppTextStyles.body1.copyWith(color: AppColors.textSecondary)),
        ],
      ),
    );
  }
}

/// 1つの種類の項目の一覧（名前順。下端に近づいたら続きを読む）
class _CatalogEntryList extends StatefulWidget {
  const _CatalogEntryList(
      {required this.apiService,
      required this.uploadQueue,
      required this.kind});

  final ApiService apiService;
  final UploadQueue uploadQueue;
  final CatalogKind kind;

  @override
  State<_CatalogEntryList> createState() => _CatalogEntryListState();
}

class _CatalogEntryListState extends State<_CatalogEntryList> {
  /// 1ページの件数（サーバの既定と同じ）。続きは読んだ件数ではなくこの数だけ offset を進める
  static const _pageSize = 50;

  /// 末尾からこの件数以内の行を組み立てたら、続きを読む
  static const _loadMoreThreshold = 5;

  List<CatalogEntry>? _entries;
  int _total = 0;
  int _nextOffset = 0;
  String? _errorMessage;
  bool _isLoadingMore = false;
  bool _loadMoreFailed = false;

  // 一覧の世代。1ページ目の結果を当てたときに進め、それより前に始めた続きの結果は捨てる。
  // 読み直しを始めた時点で進めると、読み直しが失敗したときに続きの結果まで捨てて「読み込み中...」のまま止まり、
  // 読み直しの間に始めた続きが、読み直した1ページ目の後ろにつながる（写真の一覧の PhotoGrid と同じ進め方）
  int _generation = 0;

  // 1ページ目の要求の番号。読み直しが重なったら、最後に始めたものだけを採る
  int _firstPageRequest = 0;

  @override
  void initState() {
    super.initState();
    _loadFirstPage();
  }

  Future<void> _loadFirstPage() async {
    setState(() {
      _errorMessage = null;
      _entries = null;
      _loadMoreFailed = false;
    });
    await _readFirstPage();
  }

  /// 下に引っ張ったとき。読み直しの間は今の一覧を出したままにする
  Future<void> _refresh() async {
    await _readFirstPage();
  }

  Future<void> _readFirstPage() async {
    final request = ++_firstPageRequest;
    try {
      final page = await widget.apiService
          .getCatalogEntries(widget.kind.kind, offset: 0, limit: _pageSize);
      if (!mounted || request != _firstPageRequest) return;
      setState(() {
        _generation++;
        _entries = page.entries;
        _total = page.total;
        _nextOffset = _pageSize;
        _errorMessage = null;
        _loadMoreFailed = false;
        _isLoadingMore = false;
      });
    } catch (e) {
      if (!mounted || request != _firstPageRequest) return;
      if (_entries == null) {
        setState(() => _errorMessage = _catalogErrorMessage(e));
      } else {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(_catalogErrorMessage(e))));
      }
    }
  }

  Future<void> _loadMore() async {
    if (_isLoadingMore || _loadMoreFailed || _nextOffset >= _total) return;
    final generation = _generation;
    setState(() => _isLoadingMore = true);
    try {
      final page = await widget.apiService.getCatalogEntries(widget.kind.kind,
          offset: _nextOffset, limit: _pageSize);
      if (!mounted || generation != _generation) return;
      setState(() {
        _entries = [...?_entries, ...page.entries];
        _total = page.total;
        _nextOffset += _pageSize;
        _isLoadingMore = false;
      });
    } catch (_) {
      if (!mounted || generation != _generation) return;
      setState(() {
        _isLoadingMore = false;
        _loadMoreFailed = true;
      });
    }
  }

  /// 項目詳細を開く。項目が無くなっていた（写真が0枚）なら、戻ったときに一覧を読み直す（03 §6.2）
  Future<void> _openEntry(CatalogEntry entry) async {
    var vanished = false;
    CatalogEntry? loaded;
    await Navigator.push(
        context,
        MaterialPageRoute(
            builder: (_) => CatalogEntryScreen(
                apiService: widget.apiService,
                uploadQueue: widget.uploadQueue,
                kind: widget.kind,
                name: entry.name,
                onEntryVanished: () => vanished = true,
                onEntryLoaded: (e) => loaded = e)));
    final changed = loaded != null &&
        (loaded!.photoCount != entry.photoCount ||
            loaded!.confidence != entry.confidence ||
            coverCacheKey(loaded!.coverThumbnailUrl) !=
                coverCacheKey(entry.coverThumbnailUrl));
    if ((vanished || changed) && mounted) await _refresh();
  }

  void _retryLoadMore() {
    setState(() => _loadMoreFailed = false);
    _loadMore();
  }

  /// 0件・エラーのときも、下に引っ張って読み直せるようにする
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
      return _pullToRefresh(MessageView(
        isLargeScreen: MediaQuery.of(context).size.width >= 1400,
        icon: Icons.error_outline,
        title: 'エラーが発生しました',
        message: errorMessage,
        buttonIcon: Icons.refresh,
        buttonLabel: '再試行',
        onPressed: _loadFirstPage,
        isError: true,
      ));
    }
    final entries = _entries;
    if (entries == null) {
      return const _Loading();
    }
    if (entries.isEmpty && _nextOffset >= _total) {
      return _pullToRefresh(Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.menu_book_outlined,
                size: 96, color: AppColors.textHint),
            const SizedBox(height: 24),
            Text('${widget.kind.label}の項目はまだありません',
                style: AppTextStyles.headline2
                    .copyWith(color: AppColors.textSecondary)),
            const SizedBox(height: 12),
            Text('識別が済んだ写真が、ここにまとまります',
                style: AppTextStyles.body1
                    .copyWith(color: AppColors.textSecondary),
                textAlign: TextAlign.center),
          ],
        ),
      ));
    }
    if (entries.isEmpty) {
      // 1ページ目の項目がすべて外れていても、続きがある。行が無いので下端に近づくきっかけが来ない。ここで続きを読む
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _loadMore();
      });
    }
    return Column(
      children: [
        Expanded(
          child: RefreshIndicator(
            onRefresh: _refresh,
            color: AppColors.primary,
            child: ListView.builder(
              physics: const AlwaysScrollableScrollPhysics(),
              itemCount: entries.length,
              itemBuilder: (context, index) {
                if (index >= entries.length - _loadMoreThreshold &&
                    _nextOffset < _total &&
                    !_isLoadingMore &&
                    !_loadMoreFailed) {
                  WidgetsBinding.instance.addPostFrameCallback((_) {
                    if (mounted) _loadMore();
                  });
                }
                final entry = entries[index];
                return _CatalogEntryTile(
                    entry: entry, onTap: () => _openEntry(entry));
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
                    label: const Text('再試行')),
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

/// 項目の行（表紙・名前・枚数・信頼度）
class _CatalogEntryTile extends StatelessWidget {
  const _CatalogEntryTile({required this.entry, required this.onTap});

  final CatalogEntry entry;

  /// タップで項目詳細を開く
  final VoidCallback onTap;

  Widget _cover() {
    const fallback = Icon(Icons.menu_book, size: 40, color: AppColors.primary);
    return SizedBox(
      width: 48,
      height: 48,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(4),
        child: CachedNetworkImage(
          imageUrl: entry.coverThumbnailUrl,
          // 署名は読み込むたびに変わるので、署名を除いた Blob の場所で持つ
          cacheKey: coverCacheKey(entry.coverThumbnailUrl),
          cacheManager: PhotoCacheManager.thumbnails,
          fit: BoxFit.cover,
          // 読めないとき（SAS の期限切れなど）は本のアイコンを出す。失敗は想定のうちなので、未処理のエラーとして報告せずログだけに残す
          errorListener: (error) =>
              debugPrint('CatalogScreen: 表紙の読み込みエラー: $error'),
          errorWidget: (context, url, error) => fallback,
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      child: ListTile(
        leading: _cover(),
        title: Text(entry.name, maxLines: 1, overflow: TextOverflow.ellipsis),
        subtitle: Text('${entry.photoCount}枚'),
        trailing: ConfidenceBadge(confidence: entry.confidence),
        onTap: onTap,
      ),
    );
  }
}
