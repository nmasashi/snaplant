import 'package:flutter/material.dart';
import '../models/catalog.dart';
import '../models/photo.dart';
import '../services/api_service.dart';
import '../services/upload_queue.dart';
import '../theme/app_colors.dart';
import '../theme/app_text_styles.dart';
import '../widgets/confidence_badge.dart';
import '../widgets/message_view.dart';
import '../widgets/photo_grid.dart';
import '../widgets/photo_selection.dart';
import '../widgets/photo_selection_scaffold.dart';

/// 図鑑の項目詳細（見出しと、その項目の写真。docs/travel-album/03_screen_design.md §6.2）
///
/// 図鑑の一覧の項目の行から開く。見出しは1ページ目の応答の `entry` で出し、続きのページの応答では書き換えない
class CatalogEntryScreen extends StatefulWidget {
  const CatalogEntryScreen(
      {super.key,
      required this.apiService,
      required this.uploadQueue,
      required this.kind,
      required this.name,
      this.onEntryLoaded});

  final ApiService apiService;

  /// 写真の送信の列（グリッドが要る。項目詳細では送信中の写真は並べない）
  final UploadQueue uploadQueue;

  /// 項目の種類（見出しの欄は、この種類の `fields` の順に出す）
  final CatalogKind kind;

  /// 項目の名前
  final String name;

  /// 見出しを読んだたびに、その見出しで呼ぶ（その種類と名前の写真が無い `entry: null` なら null）。
  /// 写真を消した・ビューアから戻ったときの読み直しを始めたら、読み終わるまでは見出しが分からないので null で呼ぶ（失敗・途中で戻っても一覧が読み直す）。
  /// 図鑑の一覧は、戻ったときに最後の見出しを自分の行と比べ、変わっていれば（null も含む）読み直す
  final ValueChanged<CatalogEntry?>? onEntryLoaded;

  @override
  State<CatalogEntryScreen> createState() => _CatalogEntryScreenState();
}

class _CatalogEntryScreenState extends State<CatalogEntryScreen> {
  final _selection = PhotoSelection();
  CatalogEntry? _entry;
  bool _vanished = false;
  // 見出しと写真を1ページ目から読み直すたびに進める（グリッドの key にして作り直す）
  int _gridVersion = 0;

  @override
  void dispose() {
    _selection.dispose();
    super.dispose();
  }

  Future<void> _reload() async {
    widget.onEntryLoaded?.call(null);
    setState(() => _gridVersion++);
  }

  /// グリッドが読むページ。見出しはページに持たせ、グリッドが1ページ目として当てたときに出す（[_onFirstPageApplied]）。
  /// 読み込みが重なったとき（引っ張った読み直しと「再試行」、読み直しの間のグリッドの作り直し）に、どの応答を採るかをグリッドの決まりにそろえ、
  /// 写真と見出しが別の応答から出ないようにする
  Future<PhotoPage> _loadPage(String? continuationToken) async {
    final detail = await widget.apiService.getCatalogEntry(
        widget.kind.kind, widget.name,
        continuationToken: continuationToken);
    return _EntryPhotoPage.of(detail);
  }

  /// グリッドが1ページ目を当てたとき。そのページの応答の見出しを出し、項目が無い応答なら項目が無い表示にする
  void _onFirstPageApplied(PhotoPage page) {
    // グリッドは loadPage が返したページをそのまま渡す。違う形のページなら、今の表示を変えない（デバッグ版では止めて気づけるようにする）
    assert(page is _EntryPhotoPage, 'PhotoGrid は loadPage が返したページをそのまま渡す');
    if (page is! _EntryPhotoPage) return;
    final entry = page.entry;
    if (entry == null) {
      setState(() => _vanished = true);
      widget.onEntryLoaded?.call(null);
      return;
    }
    setState(() => _entry = entry);
    widget.onEntryLoaded?.call(entry);
  }

  @override
  Widget build(BuildContext context) {
    final entry = _entry;
    return PhotoSelectionScaffold(
      apiService: widget.apiService,
      selection: _selection,
      currentTripId: null,
      allowMove: false,
      appBar:
          AppBar(title: Text(widget.name, style: AppTextStyles.appBarTitle)),
      body: _vanished
          ? MessageView(
              isLargeScreen: MediaQuery.of(context).size.width >= 1400,
              icon: Icons.menu_book_outlined,
              title: 'この項目には写真がありません',
              message: '写真が削除されたか、解析のやり直しで名前が変わりました',
              buttonIcon: Icons.arrow_back,
              buttonLabel: '戻る',
              onPressed: () => Navigator.pop(context),
            )
          : LayoutBuilder(
              builder: (context, constraints) => Column(
                children: [
                  if (entry != null)
                    // 説明の長さは AI が返す文で決まる。見出しは画面の高さの4割までにし、超える分は見出しの中でスクロールする
                    // （固定の高さのまま置くと、小さな端末で写真のグリッドの高さが無くなる）
                    ConstrainedBox(
                      constraints: BoxConstraints(
                          maxHeight: constraints.maxHeight * 0.4),
                      child: SingleChildScrollView(
                          // グリッドの一覧を画面の主なスクロールにする（ステータスバーのタップで先頭へ戻る先が2つにならないように）
                          primary: false,
                          child: _EntryHeader(entry: entry, kind: widget.kind)),
                    ),
                  Expanded(
                    child: PhotoGrid(
                      key: ValueKey(_gridVersion),
                      apiService: widget.apiService,
                      uploadQueue: widget.uploadQueue,
                      tripId: null,
                      loadPage: _loadPage,
                      onFirstPageApplied: _onFirstPageApplied,
                      loadingMessage: '項目を読み込み中...',
                      errorFallbackMessage: '項目の読み込みに失敗しました',
                      selection: _selection,
                      emptyTitle: 'この項目には写真がありません',
                      onViewerClosed: _reload,
                      hasFloatingButton: false,
                    ),
                  ),
                ],
              ),
            ),
      onPhotosChanged: _reload,
    );
  }
}

/// 項目の見出し（信頼度・枚数・説明・特徴・種類の欄）
class _EntryHeader extends StatelessWidget {
  const _EntryHeader({required this.entry, required this.kind});

  final CatalogEntry entry;
  final CatalogKind kind;

  /// 値が無い（null・空）ときは「—」。配列は「、」でつなぐ
  static String _display(Object? value) {
    if (value is List) {
      final items = [
        for (final item in value)
          if (item is String && item.isNotEmpty) item
      ];
      return items.isEmpty ? '—' : items.join('、');
    }
    if (value is String && value.isNotEmpty) return value;
    return '—';
  }

  Widget _row(String label, String value) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 112,
            child: Text(label,
                style: AppTextStyles.body2
                    .copyWith(color: AppColors.textSecondary)),
          ),
          Expanded(child: Text(value, style: AppTextStyles.body2)),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              ConfidenceBadge(confidence: entry.confidence),
              const SizedBox(width: 12),
              Text('${entry.photoCount}枚', style: AppTextStyles.body2),
            ],
          ),
          const SizedBox(height: 8),
          _row('説明', _display(entry.description)),
          _row('特徴', _display(entry.characteristics)),
          for (final field in kind.fields)
            _row(field.label, _display(entry.attributes[field.key])),
        ],
      ),
    );
  }
}

/// 項目の詳細の1ページ（写真のページと、同じ応答の見出し）。見出しが null なら、その種類と名前の写真が無い（写真も空で続きも無い）
class _EntryPhotoPage extends PhotoPage {
  const _EntryPhotoPage._(
      this.entry, List<Photo> photos, String? continuationToken)
      : super(photos: photos, continuationToken: continuationToken);

  /// 項目の詳細の応答から作る。項目が無くなっていたら写真が空で続きの無いページにする:
  /// 続きのページなら読み終え（出している写真と見出しはそのまま）、1ページ目なら、グリッドが当てたときに項目が無い表示にする
  factory _EntryPhotoPage.of(CatalogEntryDetail detail) {
    final entry = detail.entry;
    if (entry == null) return const _EntryPhotoPage._(null, [], null);
    return _EntryPhotoPage._(
        entry, detail.photos.photos, detail.photos.continuationToken);
  }

  final CatalogEntry? entry;
}
