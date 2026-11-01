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

/// タイムラインの編集（区切りの直し）の「やめる」の確認（§8.3）。旅行詳細と案の確認画面で同じものを出す。
/// 作る・作り直す途中は「やめる」を出さない（作り始めたら最後まで進む。失敗した下書きだけは [confirmDiscardFailedDraft] で確かめて捨てられる。§8.2）
Future<bool> confirmDiscardEdit(BuildContext context) =>
    confirmTimelineAction(context,
        message: '編集をやめて、今のタイムラインのままにしますか？', confirmLabel: 'やめる');

/// 失敗した下書きの「やめる」の確認（§8.2）。作りかけのタイムラインを捨てる
Future<bool> confirmDiscardFailedDraft(BuildContext context) =>
    confirmTimelineAction(context,
        message: '作りかけのタイムラインを捨てますか？', confirmLabel: '捨てる');

/// 「作り直す」の確認（§8.6）。旅行詳細のメニューと、写真が変わった案内の「作り直す」で出す。
/// 作り直しは今のタイムラインを消し、手で直した文と区切りも捨てて一から作るので、そのことを知らせる
Future<bool> confirmRebuildTimeline(BuildContext context) =>
    confirmTimelineAction(context,
        title: 'タイムラインを作り直しますか？',
        message: '今のタイムラインを消して、今の写真で AI が最初から作り直します。手で直した文と場面の分け方も消え、元には戻せません。',
        confirmLabel: '作り直す');

/// 写真を「タイムラインから外す」の確認（§8.4・§8.8）。案の確認画面と場面の写真の一覧で同じものを出す（外した写真は戻せない。02 §5 #52）
Future<bool> confirmExcludePhoto(BuildContext context) =>
    confirmTimelineAction(context,
        title: 'タイムラインから外しますか？',
        message: '写真は旅行に残ります。外した写真は、タイムラインを作り直すまで戻せません。',
        confirmLabel: '外す');

/// 「つなげる」の確認（§8.7）。つなげると消える文（[lost]。「消えるコメント: …」など）を添える
Future<bool> confirmMergeScenes(BuildContext context,
    {required String message, required List<String> lost}) async {
  final confirmed = await showDialog<bool>(
    context: context,
    builder: (context) => AlertDialog(
      title: const Text('場面をつなげますか？'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(message),
          for (final text in lost) ...[
            const SizedBox(height: 8),
            Text(text),
          ],
        ],
      ),
      actions: [
        TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('キャンセル')),
        ElevatedButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('つなげる')),
      ],
    ),
  );
  return confirmed == true;
}
