import 'package:flutter/material.dart';
import '../models/timeline.dart';
import '../theme/app_text_styles.dart';

/// 完成版の一番上に出す案内の枠（文と操作のボタン。docs/03_screen_design.md §8.3）
class TimelineNoticeCard extends StatelessWidget {
  const TimelineNoticeCard(
      {super.key,
      required this.text,
      required this.actions});

  final String text;
  final List<Widget> actions;

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
            if (actions.isNotEmpty) ...[
              const SizedBox(height: 8),
              Wrap(
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
