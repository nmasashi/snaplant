import 'package:flutter/material.dart';
import '../models/photo.dart';
import '../services/api_service.dart';
import '../theme/app_colors.dart';

/// 解析のやり直しダイアログ（docs/travel-album/03_screen_design.md §5.4）
///
/// 手がかりを書いて頼む。受け付けられたら、受け付けた写真を返して閉じる。受け付けられなければ留まって理由を出す
class RetryProcessingDialog extends StatefulWidget {
  const RetryProcessingDialog(
      {super.key, required this.apiService, required this.photo});

  final ApiService apiService;
  final Photo photo;

  @override
  State<RetryProcessingDialog> createState() => _RetryProcessingDialogState();
}

class _RetryProcessingDialogState extends State<RetryProcessingDialog> {
  // 利用者が直したコメントがあればそれを、無ければ前回の手がかりを入れておく
  // （受付でコメントは消えるので、利用者の文を失わないように）
  late final _hint = TextEditingController(
      text: widget.photo.commentSource == 'user'
          ? widget.photo.comment
          : widget.photo.hint);
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _hint.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final photo = await widget.apiService
          .requestPhotoProcessing(widget.photo.id, hint: _hint.text);
      if (mounted) Navigator.pop(context, photo);
    } catch (e) {
      // ApiException 以外でも留まって押し直せるようにする（受け止めないと、押せないまま閉じられなくなる。
      // 削除の確認ダイアログと同じ）
      debugPrint('RetryProcessingDialog: 解析のやり直しの受付エラー: $e');
      if (mounted) {
        setState(() {
          _busy = false;
          _error = e is ApiException ? e.userMessage : '解析のやり直しの受付に失敗しました';
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    // 受け付けを待っている間は閉じない（閉じると、受け付けられたのに表示が古いまま残る。他のダイアログと同じ）
    return PopScope(
      canPop: !_busy,
      child: _buildDialog(),
    );
  }

  Widget _buildDialog() {
    return AlertDialog(
      title: const Text('解析をやり直す'),
      // キーボードが出て高さが足りなくなっても、はみ出さずにスクロールする（旅行の編集ダイアログと同じ）
      content: SingleChildScrollView(
          child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          TextField(
            controller: _hint,
            enabled: !_busy,
            maxLines: 3,
            maxLength: 500,
            decoration: const InputDecoration(
              labelText: '手がかり（任意）',
              hintText: '例：これはサクラではなくウメ',
            ),
          ),
          const Text('今のコメントは AI の結果で置き換わります'),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child:
                  Text(_error!, style: const TextStyle(color: AppColors.error)),
            ),
        ],
      )),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.pop(context),
          child: const Text('キャンセル'),
        ),
        TextButton(
          onPressed: _busy ? null : _submit,
          child: const Text('やり直す'),
        ),
      ],
    );
  }
}
