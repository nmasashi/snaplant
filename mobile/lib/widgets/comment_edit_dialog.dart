import 'package:flutter/material.dart';
import '../models/photo.dart';
import '../services/api_service.dart';
import '../theme/app_colors.dart';

/// 写真のコメントの編集ダイアログ（docs/travel-album/03_screen_design.md §6.3）
///
/// 今のコメントを入れておき、直して保存する。保存できたら直した写真を返して閉じる。保存できなければ留まって理由を出す
class CommentEditDialog extends StatefulWidget {
  const CommentEditDialog(
      {super.key, required this.apiService, required this.photo});

  final ApiService apiService;
  final Photo photo;

  @override
  State<CommentEditDialog> createState() => _CommentEditDialogState();
}

class _CommentEditDialogState extends State<CommentEditDialog> {
  late final _comment = TextEditingController(text: widget.photo.comment);
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _comment.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final photo = await widget.apiService
          .updatePhotoComment(widget.photo.id, _comment.text);
      if (mounted) Navigator.pop(context, photo);
    } catch (e) {
      // ApiException 以外でも留まって押し直せるようにする（やり直しダイアログと同じ）
      debugPrint('CommentEditDialog: コメントの保存エラー: $e');
      if (mounted) {
        setState(() {
          _busy = false;
          _error = e is ApiException ? e.userMessage : 'コメントの保存に失敗しました';
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    // 保存を待っている間は閉じない（閉じると、保存されたのに表示が古いまま残る。他のダイアログと同じ）
    return PopScope(
      canPop: !_busy,
      child: AlertDialog(
        title: const Text('コメントを編集'),
        // キーボードが出て高さが足りなくなっても、はみ出さずにスクロールする
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              TextField(
                controller: _comment,
                enabled: !_busy,
                maxLines: 3,
                maxLength: 500,
              ),
              if (_error != null)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Text(_error!,
                      style: const TextStyle(color: AppColors.error)),
                ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: _busy ? null : () => Navigator.pop(context),
            child: const Text('キャンセル'),
          ),
          TextButton(
            onPressed: _busy ? null : _submit,
            child: const Text('保存'),
          ),
        ],
      ),
    );
  }
}
