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

/// 「やめる」の確認。旅行詳細と区切りの確認画面で同じものを出す。
/// 完成版がある（[hasCurrent]。作り直し・区切りの直しの下書き）なら完成版に戻るか（§8.3）、無ければ作りかけを捨てるか（§8.2）
Future<bool> confirmDiscardTimeline(BuildContext context,
        {required bool hasCurrent}) =>
    hasCurrent
        ? confirmTimelineAction(context,
            message: '編集をやめて、今のタイムラインのままにしますか？', confirmLabel: 'やめる')
        : confirmTimelineAction(context,
            message: '作りかけのタイムラインを捨てますか？', confirmLabel: '捨てる');

/// 「作り直す」の確認（§8.6）。旅行詳細の「作り直す」と、完成版がある下書きの「区切り案を出し直す」（§8.4）で同じものを出す。
/// 作り直しは手で直した文と区切りも捨てて一から作るので、そのことを知らせる
Future<bool> confirmRebuildTimeline(BuildContext context) =>
    confirmTimelineAction(context,
        title: 'タイムラインを作り直しますか？',
        message: '今のタイムラインを消して、今の写真で AI が最初から作り直します。手で直した文と場面の分け方も消え、元には戻せません。',
        confirmLabel: '作り直す');
