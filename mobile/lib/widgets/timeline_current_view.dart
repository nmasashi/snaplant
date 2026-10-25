import 'package:flutter/material.dart';
import '../models/timeline.dart';
import '../theme/app_colors.dart';
import '../theme/app_text_styles.dart';
import '../utils/timeline_format.dart';
import 'timeline_thumbnail.dart';

/// 完成したタイムライン（docs/03_screen_design.md §8.3）
///
/// 上に作成日時と「区切りを直す」「作り直す」、日ごとの見出し・タイトル・まとめと場面のカード、最後に日時なし
class TimelineCurrentView extends StatelessWidget {
  const TimelineCurrentView({
    super.key,
    required this.current,
    required this.pendingPhotoCount,
    required this.onRecut,
    required this.onRebuild,
  });

  final TimelineCurrent current;

  /// 解析が済んでいない写真の枚数（0 でなければ「作り直す」を押せない）
  final int pendingPhotoCount;

  /// 「区切りを直す」。null なら押せない
  final VoidCallback? onRecut;

  /// 「作り直す」。null なら押せない（解析中の写真があるときは、渡されても押せない）
  final VoidCallback? onRebuild;

  /// 場面のカードに並べるサムネイルの枚数（それより多ければ「+N枚」）
  static const _thumbnailCount = 4;

  @override
  Widget build(BuildContext context) {
    final secondary =
        AppTextStyles.body2.copyWith(color: AppColors.textSecondary);
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Text('${_writtenAtLabel(current.writtenAt)} に作成', style: secondary),
        const SizedBox(height: 8),
        Wrap(
          spacing: 12,
          runSpacing: 8,
          children: [
            OutlinedButton(onPressed: onRecut, child: const Text('区切りを直す')),
            OutlinedButton(
              onPressed: pendingPhotoCount > 0 ? null : onRebuild,
              child: const Text('作り直す'),
            ),
          ],
        ),
        if (pendingPhotoCount > 0) ...[
          const SizedBox(height: 4),
          Text('解析中の写真があと $pendingPhotoCount 枚あります', style: secondary),
        ],
        for (final day in current.days) ..._buildDay(day, secondary),
        if (current.undatedPhotos.isNotEmpty) ...[
          const SizedBox(height: 24),
          const Text('日時なし', style: AppTextStyles.headline3),
          const SizedBox(height: 8),
          GridView.count(
            crossAxisCount: _thumbnailCount + 1,
            mainAxisSpacing: 2,
            crossAxisSpacing: 2,
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            children: [
              for (final photo in current.undatedPhotos)
                TimelineThumbnail(photo: photo),
            ],
          ),
        ],
      ],
    );
  }

  /// 日の見出し（何日目・日付・印）、タイトル、まとめ、場面のカード
  List<Widget> _buildDay(TimelineDay day, TextStyle secondary) {
    final mark = _dayMark(day);
    return [
      const SizedBox(height: 24),
      Row(
        crossAxisAlignment: CrossAxisAlignment.baseline,
        textBaseline: TextBaseline.alphabetic,
        children: [
          Text('${day.dayNumber}日目', style: AppTextStyles.headline3),
          const SizedBox(width: 8),
          Text(timelineDateLabel(day.date), style: secondary),
          if (mark != null) ...[
            const SizedBox(width: 8),
            Text(mark, style: AppTextStyles.caption),
          ],
        ],
      ),
      if (day.title != null) ...[
        const SizedBox(height: 4),
        Text(day.title!, style: AppTextStyles.body1),
      ],
      if (day.summary != null) ...[
        const SizedBox(height: 4),
        Text(day.summary!, style: secondary),
      ],
      for (final scene in day.scenes) ...[
        const SizedBox(height: 12),
        _buildScene(scene, secondary),
      ],
    ];
  }

  Widget _buildScene(TimelineScene scene, TextStyle secondary) {
    final details = [
      timelineTimeRange(scene.photos),
      if (scene.placeNames.isNotEmpty) scene.placeNames.join('、'),
      if (scene.names.isNotEmpty) scene.names.join('、'),
    ].join(' · ');
    final shown = scene.photos.take(_thumbnailCount).toList();
    final rest = scene.photos.length - shown.length;
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (scene.label != null)
              Row(
                children: [
                  // 食べ物の場面は橙、それ以外は青（色だけに頼らず、見出しの文字で分かる。§8.3）
                  Icon(Icons.circle,
                      size: 10,
                      color:
                          scene.hasFood ? AppColors.secondary : AppColors.info),
                  const SizedBox(width: 6),
                  Expanded(
                      child: Text(scene.label!,
                          style: AppTextStyles.body1
                              .copyWith(fontWeight: FontWeight.bold))),
                ],
              ),
            const SizedBox(height: 4),
            Text(details, style: secondary),
            if (scene.note != null) ...[
              const SizedBox(height: 4),
              Text(scene.note!, style: AppTextStyles.body2),
            ],
            const SizedBox(height: 8),
            Row(
              children: [
                for (var i = 0; i <= _thumbnailCount; i++) ...[
                  if (i > 0) const SizedBox(width: 2),
                  Expanded(
                    child: AspectRatio(
                      aspectRatio: 1,
                      child: i < shown.length
                          ? TimelineThumbnail(photo: shown[i])
                          : i == _thumbnailCount && rest > 0
                              ? ColoredBox(
                                  color: AppColors.surfaceVariant,
                                  child: Center(
                                      child: Text('+$rest枚',
                                          style: AppTextStyles.body2)),
                                )
                              : const SizedBox.shrink(),
                    ),
                  ),
                ],
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// 日の印（どちらかを利用者が直していれば「編集済み」、文があってどちらも AI なら「AI のまとめ」。§8.3）
String? _dayMark(TimelineDay day) {
  if (day.titleSource == 'user' || day.summarySource == 'user') return '編集済み';
  if (day.title != null || day.summary != null) return 'AI のまとめ';
  return null;
}

/// 作成日時「10月25日 18:10」（端末の時刻で）
String _writtenAtLabel(String writtenAt) {
  final at = DateTime.parse(writtenAt).toLocal();
  return '${at.month}月${at.day}日 ${at.hour}:${at.minute.toString().padLeft(2, '0')}';
}
