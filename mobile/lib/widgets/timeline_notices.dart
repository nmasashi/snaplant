import 'package:flutter/material.dart';
import '../models/timeline.dart';
import '../theme/app_text_styles.dart';

/// 完成版の一番上に出す案内の枠（文と操作のボタン。docs/03_screen_design.md §8.3）
class TimelineNoticeCard extends StatelessWidget {
  const TimelineNoticeCard(
      {super.key,
      required this.text,
      this.details = const [],
      required this.actions,
      this.alignActionsEnd = false});

  final String text;

  /// 文の下に並べるもの（残せなかった文など）
  final List<Widget> details;
  final List<Widget> actions;

  /// 操作を右に寄せるか（左から並べるなら false）
  final bool alignActionsEnd;

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(text, style: AppTextStyles.body1),
            if (details.isNotEmpty) ...[const SizedBox(height: 8), ...details],
            if (actions.isNotEmpty) ...[
              const SizedBox(height: 8),
              Wrap(
                alignment:
                    alignActionsEnd ? WrapAlignment.end : WrapAlignment.start,
                spacing: 8,
                runSpacing: 8,
                children: actions,
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// 残せなかった文の案内（§8.3）。文は選んで写せる
class TimelineDroppedEditsNotice extends StatelessWidget {
  const TimelineDroppedEditsNotice(
      {super.key, required this.edits, required this.onDismiss});

  final List<TimelineDroppedEdit> edits;

  /// 「閉じる」。null なら押せない（操作を送っている間）
  final VoidCallback? onDismiss;

  @override
  Widget build(BuildContext context) {
    return TimelineNoticeCard(
      text: '場面や日が無くなったため、手で直した文のうち ${edits.length} 件を残せませんでした',
      details: [
        for (final edit in edits)
          Padding(
            padding: const EdgeInsets.only(bottom: 4),
            child: SelectableText(edit.text, style: AppTextStyles.body2),
          ),
      ],
      alignActionsEnd: true,
      actions: [
        TextButton(onPressed: onDismiss, child: const Text('閉じる')),
      ],
    );
  }
}

/// 作った後に写真が変わった案内（§8.3）と「あとで」「作り直す」
class TimelineChangesNotice extends StatelessWidget {
  const TimelineChangesNotice(
      {super.key,
      required this.changes,
      required this.onLater,
      required this.onRebuild});

  final TimelineChanges changes;
  final VoidCallback onLater;

  /// 「作り直す」。null なら押せない（操作を送っている間・解析中の写真がある間）
  final VoidCallback? onRebuild;

  /// 案内を出すほど写真が変わったか
  static bool shows(TimelineChanges? changes) =>
      changes != null && changes.added + changes.removed > 0;

  @override
  Widget build(BuildContext context) {
    final what = [
      if (changes.added > 0) '${changes.added} 枚増え',
      if (changes.removed > 0) '${changes.removed} 枚消え',
    ].join('、');
    return TimelineNoticeCard(
      text: '作った後に写真が $whatました。今のタイムラインには入っていません。',
      actions: [
        TextButton(onPressed: onLater, child: const Text('あとで')),
        OutlinedButton(onPressed: onRebuild, child: const Text('作り直す')),
      ],
    );
  }
}
