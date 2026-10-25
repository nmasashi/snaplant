import 'package:flutter/material.dart';

/// タイムラインの操作の確認のダイアログ（「キャンセル」と [confirmLabel]。docs/03_screen_design.md §8.2・§8.4）
///
/// [confirmLabel] を押したら true。キャンセル・ダイアログの外で閉じたら false。[title] は見出し（無ければ出さない）
Future<bool> confirmTimelineAction(BuildContext context,
    {String? title,
    required String message,
    required String confirmLabel}) async {
  final confirmed = await showDialog<bool>(
    context: context,
    builder: (context) => AlertDialog(
      title: title == null ? null : Text(title),
      content: Text(message),
      actions: [
        TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('キャンセル')),
        ElevatedButton(
            onPressed: () => Navigator.pop(context, true),
            child: Text(confirmLabel)),
      ],
    ),
  );
  return confirmed == true;
}

/// 「やめる」の確認（作りかけのタイムラインを捨てるか）。旅行詳細と区切りの確認画面で同じものを出す
Future<bool> confirmDiscardTimeline(BuildContext context) =>
    confirmTimelineAction(context,
        message: '作りかけのタイムラインを捨てますか？', confirmLabel: '捨てる');
