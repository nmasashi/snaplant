import 'package:flutter/material.dart';
import '../models/timeline.dart';
import '../theme/app_colors.dart';
import '../theme/app_text_styles.dart';
import '../utils/timeline_format.dart';
import 'timeline_thumbnail.dart';

/// 完成したタイムライン（docs/03_screen_design.md §8.3）
///
/// 日ごとの見出し・タイトル・まとめと場面のカード、一番下に作成日時（撮影日時の無い写真は出さない。02 §5 #54）。
/// タイムラインの編集・作り直しは旅行詳細の上のバーのメニューから（§8.1）
class TimelineCurrentView extends StatelessWidget {
  const TimelineCurrentView({
    super.key,
    required this.current,
    required this.onOpenScene,
    required this.onEditDay,
    this.banner,
    this.notices = const [],
  });

  final TimelineCurrent current;

  /// 場面をタップした（場面の写真の一覧を開く。§8.3・§8.8）。null ならタップを受けない（操作を送っている間）
  final void Function(TimelineDay day, TimelineScene scene)? onOpenScene;

  /// 日の編集のボタン（§8.5）。null なら押せない（操作を送っている間）。場面の見出しは場面の写真の一覧から直す（§8.8）
  final void Function(TimelineDay day)? onEditDay;

  /// 完成版の上に出す、タイムラインを編集している途中の案内（§8.3）
  final Widget? banner;

  /// 一番上に出す案内（写真が変わった案内。§8.3）
  final List<Widget> notices;

  /// 場面のカードに並べるサムネイルの枚数（それより多ければ「+N枚」）
  static const _thumbnailCount = 4;

  @override
  Widget build(BuildContext context) {
    final secondary =
        AppTextStyles.body2.copyWith(color: AppColors.textSecondary);
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        for (final notice in notices) ...[notice, const SizedBox(height: 16)],
        if (banner != null) ...[banner!, const SizedBox(height: 16)],
        for (final day in current.days) ..._buildDay(day, secondary),
        const SizedBox(height: 24),
        Text('${_writtenAtLabel(current.writtenAt)} に作成',
            style:
                AppTextStyles.caption.copyWith(color: AppColors.textSecondary),
            textAlign: TextAlign.center),
      ],
    );
  }

  /// 日の見出し（何日目・日付・印）、タイトル、まとめ、場面のカード
  List<Widget> _buildDay(TimelineDay day, TextStyle secondary) {
    final mark = _dayMark(day);
    return [
      const SizedBox(height: 24),
      // 見出しの文字は基準線で揃え、編集のボタンは行の中央に置く（ボタンまで基準線に揃えると行が崩れる）
      Row(
        children: [
          Expanded(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.baseline,
              textBaseline: TextBaseline.alphabetic,
              children: [
                Text('${day.dayNumber}日目', style: AppTextStyles.headline3),
                const SizedBox(width: 8),
                // 狭い画面や大きな文字でも編集のボタンにはみ出さないよう、日付と印は縮めて省く
                Flexible(
                  child: Text(timelineDateLabel(day.date),
                      style: secondary, overflow: TextOverflow.ellipsis),
                ),
                if (mark != null) ...[
                  const SizedBox(width: 8),
                  Flexible(
                    child: Text(mark,
                        style: AppTextStyles.caption,
                        overflow: TextOverflow.ellipsis),
                  ),
                ],
              ],
            ),
          ),
          IconButton(
            icon: const Icon(Icons.edit_outlined, semanticLabel: 'この日を編集'),
            tooltip: 'この日を編集',
            onPressed: onEditDay == null ? null : () => onEditDay!(day),
          ),
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
        _buildScene(day, scene, secondary),
      ],
    ];
  }

  Widget _buildScene(
      TimelineDay day, TimelineScene scene, TextStyle secondary) {
    final details = [
      timelineTimeRange(scene.photos),
      if (scene.placeNames.isNotEmpty) scene.placeNames.join('、'),
      if (scene.names.isNotEmpty) scene.names.join('、'),
    ].join(' · ');
    final shown = scene.photos.take(_thumbnailCount).toList();
    final rest = scene.photos.length - shown.length;
    final open = onOpenScene;
    return Card(
      margin: EdgeInsets.zero,
      clipBehavior: Clip.antiAlias,
      // 場面のどこをタップしても、場面の写真の一覧を開く（§8.3）
      child: InkWell(
        onTap: open == null ? null : () => open(day, scene),
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  // 見出しの印と見出し。食べ物の場面は橙、それ以外は青（色だけに頼らず、見出しの文字で分かる。§8.3）。
                  // 見出しが無い（区切りを直して足した場面）なら、印を出さずに薄い字で「見出しなし」（場面の写真の一覧で書ける）
                  if (scene.label != null) ...[
                    Icon(Icons.circle,
                        size: 10,
                        color: scene.hasFood
                            ? AppColors.secondary
                            : AppColors.info),
                    const SizedBox(width: 6),
                    Expanded(
                        child: Text(scene.label!,
                            style: AppTextStyles.body1
                                .copyWith(fontWeight: FontWeight.bold))),
                  ] else
                    Expanded(child: Text('見出しなし', style: secondary)),
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
                            // 写真のタップも場面を開く（読み上げで写真を選んだときも開けるように）
                            ? TimelineThumbnail(
                                photo: shown[i],
                                onTap: open == null
                                    ? null
                                    : () => open(day, scene))
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
