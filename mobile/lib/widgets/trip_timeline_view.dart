import 'package:flutter/material.dart';
import '../models/timeline.dart';
import '../services/api_service.dart';
import '../theme/app_colors.dart';
import '../theme/app_text_styles.dart';
import 'message_view.dart';

/// 旅行詳細の「タイムライン」（docs/03_screen_design.md §8.1・§8.2）
///
/// 切り替えで「タイムライン」を選ぶたびに作り直され、そのたびに読み直す
class TripTimelineView extends StatefulWidget {
  const TripTimelineView(
      {super.key,
      required this.apiService,
      required this.tripId,
      required this.onTripNotFound});

  final ApiService apiService;
  final String tripId;

  /// 旅行が既に無いと分かった（旅行詳細が「この旅行は削除されています」にする。写真の一覧と同じ）
  final VoidCallback onTripNotFound;

  @override
  State<TripTimelineView> createState() => _TripTimelineViewState();
}

class _TripTimelineViewState extends State<TripTimelineView> {
  TimelineOverview? _overview;
  // 読み込みに失敗したときの文言。null なら失敗していない
  String? _errorMessage;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _overview = null;
      _errorMessage = null;
    });
    try {
      final overview = await widget.apiService.getTimeline(widget.tripId);
      if (!mounted) return;
      setState(() => _overview = overview);
    } catch (e) {
      debugPrint('TripTimelineView: タイムラインの読み込みエラー: $e');
      if (!mounted) return;
      if (e is ApiException && e.isTripNotFound) {
        widget.onTripNotFound();
        return;
      }
      setState(() => _errorMessage =
          e is ApiException ? e.userMessage : 'タイムラインの読み込みに失敗しました');
    }
  }

  @override
  Widget build(BuildContext context) {
    final errorMessage = _errorMessage;
    if (errorMessage != null) {
      return MessageView(
        isLargeScreen: MediaQuery.of(context).size.width >= 1400,
        icon: Icons.error_outline,
        title: 'エラーが発生しました',
        message: errorMessage,
        buttonIcon: Icons.refresh,
        buttonLabel: '再試行',
        onPressed: _load,
        isError: true,
      );
    }
    final overview = _overview;
    if (overview == null) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const CircularProgressIndicator(
                valueColor: AlwaysStoppedAnimation(AppColors.primary)),
            const SizedBox(height: 16),
            Text(
              'タイムラインを読み込み中...',
              style:
                  AppTextStyles.body1.copyWith(color: AppColors.textSecondary),
            ),
          ],
        ),
      );
    }
    if (overview.timeline == null) return _buildEmpty(overview);
    return const SizedBox.shrink();
  }

  /// 完成版も下書きも無い（§8.2 の1・2行目）
  Widget _buildEmpty(TimelineOverview overview) {
    final pending = overview.pendingPhotoCount;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Text('タイムラインはまだありません',
                style: AppTextStyles.headline3, textAlign: TextAlign.center),
            const SizedBox(height: 8),
            Text('写真を送り終えたら、日ごと・食事ごとにまとめたタイムラインを作れます。',
                style: AppTextStyles.body2
                    .copyWith(color: AppColors.textSecondary),
                textAlign: TextAlign.center),
            const SizedBox(height: 24),
            ElevatedButton(
              onPressed: pending > 0 ? null : () {},
              child: const Text('タイムラインを作る'),
            ),
            if (pending > 0) ...[
              const SizedBox(height: 12),
              Text('解析中の写真があと $pending 枚あります。終わると作れます。',
                  style: AppTextStyles.body2
                      .copyWith(color: AppColors.textSecondary),
                  textAlign: TextAlign.center),
            ],
          ],
        ),
      ),
    );
  }
}
