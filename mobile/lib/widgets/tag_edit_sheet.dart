import 'package:flutter/material.dart';
import '../models/photo.dart';
import '../services/api_service.dart';
import '../theme/app_colors.dart';
import '../utils/photo_category.dart';

/// 直すシートで、保存のほかに選べる操作（docs/03_screen_design.md §5.9.3）
enum TagEditAction {
  /// 「位置を動かす」（シートを閉じ、写真の上で新しい位置を選ぶ）
  move,

  /// 「このタグを消す」（シートを閉じ、消す確認を出す）
  delete,
}

/// タグを付ける・直すシート（docs/03_screen_design.md §5.7・§5.9.3。C-3・C-4d）
///
/// 付けるときは、写真の中の場所（[x]・[y]。画像の中の割合）に、名前と種類（既定は写真のカテゴリ。無ければその他）を書いて保存すると、
/// 今のタグの後ろに足した配列を送る。直すときは、[editIndex] 番目のタグの名前と種類を書き換えて、そのタグを置き換えた配列を送る
/// （位置はそのまま。直したタグの出どころは user）。
/// 保存できたら直した写真を返して閉じる。保存できなければ留まって理由を出す（カテゴリのシートと同じ）。
/// 直すときの「位置を動かす」「このタグを消す」は、[TagEditAction] を返して閉じる（動かす・消すのはビューア）
class TagEditSheet extends StatefulWidget {
  const TagEditSheet(
      {super.key,
      required this.apiService,
      required this.photo,
      required double this.x,
      required double this.y})
      : editIndex = null;

  /// [photo] の [index] 番目のタグを直すシート
  const TagEditSheet.edit(
      {super.key,
      required this.apiService,
      required this.photo,
      required int index})
      : editIndex = index,
        x = null,
        y = null;

  final ApiService apiService;
  final Photo photo;

  /// 付けるタグの位置（直すときは null）
  final double? x;
  final double? y;

  /// 直すタグの番号（付けるときは null）
  final int? editIndex;

  @override
  State<TagEditSheet> createState() => _TagEditSheetState();
}

class _TagEditSheetState extends State<TagEditSheet> {
  /// 名前の上限（サーバの TAG_MAX_LENGTH の既定値。05 §5.6）
  static const _maxNameLength = 30;

  /// 直すタグ（付けるときは null）
  late final PhotoTag? _editing = switch (widget.editIndex) {
    final index? => widget.photo.tags[index],
    null => null,
  };
  late final _name = TextEditingController(text: _editing?.name);
  // 直すときは今の種類、付けるときは写真のカテゴリ（選べない値ならその他）
  late String _kind = switch (_editing?.kind ?? widget.photo.category) {
    final kind? when editableCategories.contains(kind) => kind,
    _ => otherCategory,
  };
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    final name = _name.text.trim();
    final tags = switch ((widget.editIndex, _editing)) {
      // 位置はそのまま、出どころは user（PhotoTag の既定）
      (final index?, final editing?) => [...widget.photo.tags]..[index] =
          PhotoTag(name: name, kind: _kind, x: editing.x, y: editing.y),
      _ => [
          ...widget.photo.tags,
          PhotoTag(name: name, kind: _kind, x: widget.x!, y: widget.y!)
        ],
    };
    try {
      final photo =
          await widget.apiService.updatePhotoTags(widget.photo.id, tags);
      if (mounted) Navigator.pop(context, photo);
    } catch (e) {
      debugPrint('TagEditSheet: タグの保存エラー: $e');
      if (mounted) {
        setState(() {
          _busy = false;
          _error = e is ApiException ? e.userMessage : 'タグの保存に失敗しました';
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final name = _name.text.trim();
    final editing = _editing;
    // 直すときは、何も変えずに保存して AI のタグの出どころを user に変えない（03 §5.9.3）
    final changed =
        editing == null || name != editing.name || _kind != editing.kind;
    final canSave = !_busy && name.isNotEmpty && changed;
    // 保存を待っている間は閉じない（閉じると、保存されたのに表示が古いまま残る。カテゴリのシートと同じ）
    return PopScope(
      canPop: !_busy,
      child: Padding(
        // 名前を書く間はキーボードの上に出す
        padding:
            EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
        child: SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(24, 16, 24, 16),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(_editing == null ? 'タグを付ける' : 'タグを直す',
                    style: Theme.of(context).textTheme.titleLarge),
                const SizedBox(height: 8),
                TextField(
                  controller: _name,
                  enabled: !_busy,
                  // 付けるときはすぐ書けるようにする（直すときは、動かす・消すを選ぶこともあるのでキーボードを出さない）
                  autofocus: _editing == null,
                  maxLength: _maxNameLength,
                  decoration: const InputDecoration(labelText: '名前'),
                  onChanged: (_) => setState(() {}),
                ),
                for (final kind in editableCategories)
                  RadioListTile<String>(
                    contentPadding: EdgeInsets.zero,
                    title: Text(categoryLabel(kind)),
                    value: kind,
                    groupValue: _kind,
                    onChanged: _busy
                        ? null
                        : (value) => setState(() => _kind = value!),
                  ),
                if (_editing != null)
                  Wrap(
                    spacing: 8,
                    children: [
                      TextButton.icon(
                        onPressed: _busy
                            ? null
                            : () => Navigator.pop(context, TagEditAction.move),
                        icon: const Icon(Icons.open_with),
                        label: const Text('位置を動かす'),
                      ),
                      TextButton.icon(
                        onPressed: _busy
                            ? null
                            : () =>
                                Navigator.pop(context, TagEditAction.delete),
                        icon: const Icon(Icons.delete_outline),
                        label: const Text('このタグを消す'),
                      ),
                    ],
                  ),
                if (_error != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Text(_error!,
                        style: const TextStyle(color: AppColors.error)),
                  ),
                const SizedBox(height: 8),
                Row(
                  mainAxisAlignment: MainAxisAlignment.end,
                  children: [
                    TextButton(
                      onPressed: _busy ? null : () => Navigator.pop(context),
                      child: const Text('キャンセル'),
                    ),
                    const SizedBox(width: 8),
                    FilledButton(
                      onPressed: canSave ? _submit : null,
                      child: const Text('保存'),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
