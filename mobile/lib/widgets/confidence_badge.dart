import 'package:flutter/material.dart';
import '../theme/app_colors.dart';
import '../theme/app_text_styles.dart';

/// 図鑑の項目の信頼度のバッジ（「92%」。四捨五入した整数。色は植物図鑑と同じ4段階。docs/03_screen_design.md §6.1・§6.2）
class ConfidenceBadge extends StatelessWidget {
  const ConfidenceBadge({super.key, required this.confidence});

  /// 0〜100（小数もある）
  final num confidence;

  @override
  Widget build(BuildContext context) {
    final color = AppColors.getConfidenceColor(confidence.toDouble());
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: color.withValues(alpha: 0.3)),
      ),
      child: Text('${confidence.round()}%',
          style: AppTextStyles.body2.copyWith(color: color)),
    );
  }
}
