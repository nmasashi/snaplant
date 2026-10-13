import 'package:flutter/material.dart';
import '../services/api_service.dart';

/// 旅行の作成・編集ダイアログ（docs/travel-album/03_screen_design.md §4.3）
///
/// 保存できたら true を返して閉じる。保存の処理は呼び出し側が [onSave] で渡す（作成と編集で API が違う）
class TripEditDialog extends StatefulWidget {
  /// 作成のダイアログ
  const TripEditDialog({super.key, required this.onSave})
      : initialName = '',
        initialDescription = null,
        isEditing = false;

  /// 編集のダイアログ。今の旅行名とメモを入れて開く
  const TripEditDialog.edit(
      {super.key,
      required this.onSave,
      required String name,
      required String? description})
      : initialName = name,
        initialDescription = description,
        isEditing = true;

  final String initialName;
  final String? initialDescription;
  final bool isEditing;

  /// 前後の空白を除いた旅行名と、メモ（空なら null）を保存する
  final Future<void> Function(String name, String? description) onSave;

  @override
  State<TripEditDialog> createState() => _TripEditDialogState();
}

class _TripEditDialogState extends State<TripEditDialog> {
  late final _nameController = TextEditingController(text: widget.initialName);
  late final _descriptionController =
      TextEditingController(text: widget.initialDescription ?? '');
  String? _nameError;
  // 送信中は押せなくする（同じ旅行を二重に作らないように）
  bool _isSaving = false;

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
    setState(() => _isSaving = true);
    try {
      await widget.onSave(_nameController.text.trim(),
          description.isEmpty ? null : description);
    } catch (e) {
      debugPrint('TripEditDialog: 旅行の保存エラー: $e');
      if (!mounted) return;
      setState(() => _isSaving = false);
      // ダイアログに留まり、入力は残す（直して送り直せるように）
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(e is ApiException ? e.userMessage : '旅行の保存に失敗しました')));
      return;
    }
    if (!mounted) return;
    Navigator.pop(context, true);
  }

  @override
  Widget build(BuildContext context) {
    // 送信中は閉じさせない（キャンセル・外のタップ・戻る）。要求は送られたままなので、閉じると
    // 旅行は作られる（更新される）のに一覧は読み直されず、作り直して同じ旅行が2つできる
    return PopScope(
      canPop: !_isSaving,
      child: AlertDialog(
        title: Text(widget.isEditing ? '旅行を編集' : '旅行を作る'),
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
            onPressed: _isSaving ? null : () => Navigator.pop(context),
            child: const Text('キャンセル'),
          ),
          ElevatedButton(
            onPressed: _isSaving ? null : _submit,
            child: Text(widget.isEditing
                ? (_isSaving ? '保存中...' : '保存')
                : (_isSaving ? '作成中...' : '作成')),
          ),
        ],
      ),
    );
  }
}
