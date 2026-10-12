import 'package:flutter/material.dart';

/// 旅行の作成・編集ダイアログ（docs/travel-album/03_screen_design.md §4.3）
///
/// 保存できたら true を返して閉じる。保存の処理は呼び出し側が [onSave] で渡す（作成と編集で API が違う）
class TripEditDialog extends StatefulWidget {
  const TripEditDialog({super.key, required this.onSave});

  /// 前後の空白を除いた旅行名と、メモ（空なら null）を保存する
  final Future<void> Function(String name, String? description) onSave;

  @override
  State<TripEditDialog> createState() => _TripEditDialogState();
}

class _TripEditDialogState extends State<TripEditDialog> {
  final _nameController = TextEditingController();
  final _descriptionController = TextEditingController();
  String? _nameError;

  @override
  void dispose() {
    _nameController.dispose();
    _descriptionController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    // サーバも前後の空白を除いて検証する。空白だけの名前を送って 400 を受けるより、手前で止める
    if (_nameController.text.trim().isEmpty) {
      setState(() => _nameError = '旅行名を入力してください');
      return;
    }
    final description = _descriptionController.text;
    await widget.onSave(
        _nameController.text.trim(), description.isEmpty ? null : description);
    if (!mounted) return;
    Navigator.pop(context, true);
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('旅行を作る'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              controller: _nameController,
              maxLength: 100,
              decoration: InputDecoration(
                labelText: '旅行名',
                hintText: '例：北海道 2026秋',
                errorText: _nameError,
              ),
            ),
            TextField(
              controller: _descriptionController,
              maxLength: 1000,
              maxLines: 3,
              decoration: const InputDecoration(labelText: 'メモ（任意）'),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('キャンセル'),
        ),
        ElevatedButton(onPressed: _submit, child: const Text('作成')),
      ],
    );
  }
}
