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

  /// 場面の写真を大きく並べる枚数
  static const _largeCount = 2;

  /// 場面の写真の小さい列のマスの数（3枚目からがそれより多ければ、最後のマスを「+N枚」にする）
  static const _smallCount = 4;

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
      // 場面の間は空けない（縦の線を次の場面までつなげる）
      const SizedBox(height: 12),
      for (final scene in day.scenes) _buildScene(day, scene, secondary),
    ];
  }

  /// 場面（縦の時間の線の形。§8.3）。左に始まりの時刻と縦の線、右に見出しと枚数・写真・終わりの時刻と地名。
  /// 場面の一言と写真の識別の名前は出さない（02 §5 #55）
  Widget _buildScene(
      TimelineDay day, TimelineScene scene, TextStyle secondary) {
    final photos = scene.photos;
    final end = [
      if (photos.length > 1) '〜${timelineClock(photos.last.takenAt!)}',
      if (scene.placeNames.isNotEmpty) scene.placeNames.join('、'),
    ].join(' · ');
    final open = onOpenScene;
    final onTap = open == null ? null : () => open(day, scene);
    // 場面のどこをタップしても、場面の写真の一覧を開く（§8.3）
    return InkWell(
      onTap: onTap,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 52,
            child: Text(timelineClock(photos.first.takenAt!), style: secondary),
          ),
          Expanded(
            // 縦の線は右の欄の左の縁（下の余白まで引いて、次の場面の線とつなげる）
            child: DecoratedBox(
              decoration: const BoxDecoration(
                border: Border(
                    left: BorderSide(color: AppColors.borderColor, width: 2)),
              ),
              child: Padding(
                padding: const EdgeInsets.only(left: 12, bottom: 20),
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
                        const SizedBox(width: 8),
                        Text('${photos.length}枚', style: secondary),
                      ],
                    ),
                    const SizedBox(height: 8),
                    _buildPhotos(photos, onTap),
                    if (end.isNotEmpty) ...[
                      const SizedBox(height: 6),
                      Text(end, style: secondary),
                    ],
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  /// 場面の写真。最初の2枚を大きく、3枚目からを小さく1行に並べ、収まらなければ小さい列の最後を「+{残り}枚」にする（§8.3）
  Widget _buildPhotos(List<TimelinePhoto> photos, VoidCallback? onTap) {
    // 写真のタップも場面を開く（読み上げで写真を選んだときも開けるように）
    Widget thumbnail(TimelinePhoto photo) =>
        TimelineThumbnail(photo: photo, onTap: onTap);
    final rest = photos.skip(_largeCount).toList();
    final overflows = rest.length > _smallCount;
    final small = overflows ? rest.take(_smallCount - 1).toList() : rest;
    final hidden = rest.length - small.length;
    return Column(
      children: [
        _photoRow(
            [for (final photo in photos.take(_largeCount)) thumbnail(photo)],
            _largeCount),
        if (rest.isNotEmpty) ...[
          const SizedBox(height: 2),
          _photoRow([
            for (final photo in small) thumbnail(photo),
            if (overflows)
              ColoredBox(
                color: AppColors.surfaceVariant,
                child: Center(
                    child: Text('+$hidden枚', style: AppTextStyles.body2)),
              ),
          ], _smallCount),
        ],
      ],
    );
  }

  /// [columns] 列の正方形のマスに [tiles] を左から置く（足りないマスは空ける）
  Widget _photoRow(List<Widget> tiles, int columns) => Row(
        children: [
          for (var i = 0; i < columns; i++) ...[
            if (i > 0) const SizedBox(width: 2),
            Expanded(
              child: AspectRatio(
                aspectRatio: 1,
                child: i < tiles.length ? tiles[i] : const SizedBox.shrink(),
              ),
            ),
          ],
        ],
      );
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
