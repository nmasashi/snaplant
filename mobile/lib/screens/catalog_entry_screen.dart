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
      this.onEntryVanished});

  final ApiService apiService;

  /// 写真の送信の列（グリッドが要る。項目詳細では送信中の写真は並べない）
  final UploadQueue uploadQueue;

  /// 項目の種類（見出しの欄は、この種類の `fields` の順に出す）
  final CatalogKind kind;

  /// 項目の名前
  final String name;

  /// その種類と名前の写真が無い（`entry: null`）と分かったときに呼ぶ。図鑑の一覧は、戻ったときに読み直す
  final VoidCallback? onEntryVanished;

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

  Future<void> _reload() async => setState(() => _gridVersion++);

  /// グリッドが読むページ。1ページ目の応答で見出しを置き換える
  Future<PhotoPage> _loadPage(String? continuationToken) async {
    final detail = await widget.apiService.getCatalogEntry(
        widget.kind.kind, widget.name,
        continuationToken: continuationToken);
    final entry = detail.entry;
    if (entry == null) {
      // 続きのページで無くなっていたら、続きは無いものとして読み終える（出している写真と見出しはそのまま）
      if (continuationToken == null && mounted) {
        setState(() => _vanished = true);
        widget.onEntryVanished?.call();
      }
      return const PhotoPage(photos: []);
    }
    if (continuationToken == null && mounted) {
      setState(() => _entry = entry);
    }
    return detail.photos;
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
          : Column(
              children: [
                if (entry != null)
                  _EntryHeader(entry: entry, kind: widget.kind),
                Expanded(
                  child: PhotoGrid(
                    key: ValueKey(_gridVersion),
                    apiService: widget.apiService,
                    uploadQueue: widget.uploadQueue,
                    tripId: null,
                    loadPage: _loadPage,
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
