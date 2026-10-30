import 'package:flutter/material.dart';
import '../models/photo.dart';
import '../services/api_service.dart';
import '../theme/app_colors.dart';
import '../utils/photo_category.dart';

/// 写真のカテゴリを手で決めるシート（docs/03_screen_design.md §5.6。02 §5 #53）
///
/// 今のカテゴリを選んでおき、選び直して保存する。保存できたら直した写真を返して閉じる。保存できなければ留まって理由を出す。
/// AI は通さない（植物に変えたときだけ、サーバが品種を調べ始める）
class CategoryEditSheet extends StatefulWidget {
  const CategoryEditSheet(
      {super.key, required this.apiService, required this.photo});

  final ApiService apiService;
  final Photo photo;

  @override
  State<CategoryEditSheet> createState() => _CategoryEditSheetState();
}

class _CategoryEditSheetState extends State<CategoryEditSheet> {
  late String? _selected = widget.photo.category;
  bool _busy = false;
  String? _error;

  Future<void> _submit() async {
    final selected = _selected;
    // 変えていなければ何も送らずに閉じる（送ると AI のカテゴリが手で決めたものになり、「（変更済み）」が付く。コメントの編集と同じ）
    if (selected == null || selected == widget.photo.category) {
      Navigator.pop(context);
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final photo = await widget.apiService
          .updatePhotoCategory(widget.photo.id, selected);
      if (mounted) Navigator.pop(context, photo);
    } catch (e) {
      // ApiException 以外でも留まって押し直せるようにする（コメントの編集と同じ）
      debugPrint('CategoryEditSheet: カテゴリの保存エラー: $e');
      if (mounted) {
        setState(() {
          _busy = false;
          _error = e is ApiException ? e.userMessage : 'カテゴリの保存に失敗しました';
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    // 保存を待っている間は閉じない（閉じると、保存されたのに表示が古いまま残る。他のダイアログと同じ）
    return PopScope(
      canPop: !_busy,
      child: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 16, 24, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('カテゴリを変える', style: Theme.of(context).textTheme.titleLarge),
              const SizedBox(height: 8),
              for (final category in editableCategories)
                RadioListTile<String>(
                  contentPadding: EdgeInsets.zero,
                  title: Text(categoryLabel(category)),
                  value: category,
                  groupValue: _selected,
                  onChanged: _busy
                      ? null
                      : (value) => setState(() => _selected = value),
                ),
              // 植物に変えるときは、品種を調べ始めることを知らせる
              if (_selected == 'plant' && widget.photo.category != 'plant')
                const Padding(
                  padding: EdgeInsets.only(top: 8),
                  child: Text('植物に変えると、品種を調べます。'),
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
                    onPressed: _busy ? null : _submit,
                    child: const Text('保存'),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
