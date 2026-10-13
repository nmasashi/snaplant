import 'package:flutter/material.dart';
import '../services/api_service.dart';

/// 確認してから操作を実行するダイアログ（docs/travel-album/03_screen_design.md §4.8「旅行から外す」）
///
/// 実行できたら結果を返して閉じる。失敗したらダイアログに留まってエラーを出す（そのまま押し直せる）。
/// 実行の処理は呼び出し側が [onConfirm] で渡す
class ConfirmActionDialog<T> extends StatefulWidget {
  const ConfirmActionDialog(
      {super.key,
      required this.title,
      required this.message,
      required this.confirmLabel,
      required this.failureMessage,
      required this.onConfirm});

  final String title;
  final String message;
  final String confirmLabel;

  /// [ApiException] 以外で失敗したときの文言
  final String failureMessage;

  final Future<T> Function() onConfirm;

  @override
  State<ConfirmActionDialog<T>> createState() => _ConfirmActionDialogState<T>();
}

class _ConfirmActionDialogState<T> extends State<ConfirmActionDialog<T>> {
  Future<void> _confirm() async {
    T result;
    try {
      result = await widget.onConfirm();
    } catch (e) {
      debugPrint('ConfirmActionDialog: ${widget.title}のエラー: $e');
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content:
              Text(e is ApiException ? e.userMessage : widget.failureMessage)));
      return;
    }
    if (!mounted) return;
    Navigator.pop(context, result);
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(widget.title),
      content: Text(widget.message),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('キャンセル'),
        ),
        ElevatedButton(
          onPressed: _confirm,
          child: Text(widget.confirmLabel),
        ),
      ],
    );
  }
}
