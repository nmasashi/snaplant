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
      required this.busyLabel,
      required this.failureMessage,
      required this.onConfirm});

  final String title;
  final String message;
  final String confirmLabel;

  /// 実行している間の、実行のボタンの文言（「削除中...」など）
  final String busyLabel;

  /// [ApiException] 以外で失敗したときの文言
  final String failureMessage;

  final Future<T> Function() onConfirm;

  @override
  State<ConfirmActionDialog<T>> createState() => _ConfirmActionDialogState<T>();
}

class _ConfirmActionDialogState<T> extends State<ConfirmActionDialog<T>> {
  // 実行している間は押せなくし、閉じさせない（二重に送らないように。閉じても要求は送られたままになる）
  bool _isRunning = false;

  Future<void> _confirm() async {
    T result;
    setState(() => _isRunning = true);
    try {
      result = await widget.onConfirm();
    } catch (e) {
      debugPrint('ConfirmActionDialog: ${widget.title}のエラー: $e');
      if (!mounted) return;
      setState(() => _isRunning = false);
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
    return PopScope(
      canPop: !_isRunning,
      child: AlertDialog(
        title: Text(widget.title),
        content: Text(widget.message),
        actions: [
          TextButton(
            onPressed: _isRunning ? null : () => Navigator.pop(context),
            child: const Text('キャンセル'),
          ),
          ElevatedButton(
            onPressed: _isRunning ? null : _confirm,
            child: Text(_isRunning ? widget.busyLabel : widget.confirmLabel),
          ),
        ],
      ),
    );
  }
}
