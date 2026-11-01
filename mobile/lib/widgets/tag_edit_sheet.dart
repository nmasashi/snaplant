import 'package:flutter/material.dart';
import '../models/photo.dart';
import '../services/api_service.dart';
import '../theme/app_colors.dart';
import '../utils/photo_category.dart';

/// 写真の中の場所（[x]・[y]。画像の中の割合）にタグを付けるシート（docs/03_screen_design.md §5.7。C-3）
///
/// 名前と種類（既定は写真のカテゴリ。無ければその他）を書いて保存すると、今のタグの後ろに足した配列を送る。
/// 保存できたら直した写真を返して閉じる。保存できなければ留まって理由を出す（カテゴリのシートと同じ）
class TagEditSheet extends StatefulWidget {
  const TagEditSheet(
      {super.key,
      required this.apiService,
      required this.photo,
      required this.x,
      required this.y});

  final ApiService apiService;
  final Photo photo;
  final double x;
  final double y;

  @override
  State<TagEditSheet> createState() => _TagEditSheetState();
}

class _TagEditSheetState extends State<TagEditSheet> {
  /// 名前の上限（サーバの TAG_MAX_LENGTH の既定値。05 §5.6）
  static const _maxNameLength = 30;

  final _name = TextEditingController();
  late String _kind = editableCategories.contains(widget.photo.category)
      ? widget.photo.category!
      : otherCategory;
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
    final tag = PhotoTag(
        name: _name.text.trim(), kind: _kind, x: widget.x, y: widget.y);
    try {
      final photo = await widget.apiService
          .updatePhotoTags(widget.photo.id, [...widget.photo.tags, tag]);
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
    final canSave = !_busy && _name.text.trim().isNotEmpty;
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
                Text('タグを付ける', style: Theme.of(context).textTheme.titleLarge),
                const SizedBox(height: 8),
                TextField(
                  controller: _name,
                  enabled: !_busy,
                  autofocus: true,
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
