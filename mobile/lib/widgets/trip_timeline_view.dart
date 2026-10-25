import 'dart:async';

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
  /// 下書きを作っている間に、下書きを読み直す間隔（§8.1）
  static const _pollInterval = Duration(seconds: 5);

  TimelineOverview? _overview;
  // 読み込みに失敗したときの文言。null なら失敗していない
  String? _errorMessage;
  // 下書きの次の読み直し。作っている途中の下書きを出している間だけ動かす（「写真」に戻す・画面を閉じると dispose で止まる）
  Timer? _pollTimer;
  // 操作（作る・もう一度・やめる）を送っている間は、操作のボタンを押せなくする（二重に送らない。§8.1）
  bool _sending = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _pollTimer?.cancel();
    super.dispose();
  }

  /// タイムラインを読む。[showLoading] が false なら、読み終えるまで今の表示のままにする（読み直しのとき）
  Future<void> _load({bool showLoading = true}) async {
    _pollTimer?.cancel();
    if (showLoading) {
      setState(() {
        _overview = null;
        _errorMessage = null;
      });
    }
    try {
      final overview = await widget.apiService.getTimeline(widget.tripId);
      if (!mounted) return;
      setState(() => _errorMessage = null);
      _show(overview);
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

  /// [overview] を出し、作っている途中の下書きなら読み直しを予約する
  void _show(TimelineOverview overview) {
    _pollTimer?.cancel();
    setState(() => _overview = overview);
    if (overview.timeline?.draft?.isWorking ?? false) {
      _pollTimer = Timer(_pollInterval, _poll);
    }
  }

  /// 下書きを読み直す。無くなった（完成版に入れ替わった）・段が変わった・作り終えた（失敗した）ら、タイムラインを読み直す（§8.1）
  Future<void> _poll() async {
    final shown = _overview;
    final shownDraft = shown?.timeline?.draft;
    if (shown == null || shownDraft == null) return;
    TimelineDraftStatus? draft;
    try {
      draft = await widget.apiService.getTimelineDraft(widget.tripId);
    } catch (e) {
      debugPrint('TripTimelineView: 下書きの読み直しのエラー: $e');
      if (!mounted || !identical(_overview, shown)) return;
      if (e is ApiException && e.isTripNotFound) {
        widget.onTripNotFound();
        return;
      }
      // 読み直しの失敗は出さず、次の回にもう一度読む
      _show(shown);
      return;
    }
    // 待っている間に操作で表示が替わっていたら、古い表示を元にした読み直しの結果は使わない
    if (!mounted || !identical(_overview, shown)) return;
    if (draft == null || draft.phase != shownDraft.phase || !draft.isWorking) {
      await _load(showLoading: false);
      return;
    }
    _show(shown.withDraft(draft));
  }

  /// タイムラインを作る（失敗した区切りの案の「もう一度」も同じ）
  Future<void> _create() => _accept(widget.apiService.createTimeline);

  /// 見出しと一言を書かせる（失敗した文の「もう一度」）
  Future<void> _write() => _accept(widget.apiService.writeTimeline);

  /// 受け付けた下書きの状態（作る・書かせるの応答）で、読み直さずに表示を進める
  Future<void> _accept(Future<TimelineDraftStatus> Function(String) send) =>
      _send(() async {
        final draft = await send(widget.tripId);
        if (!mounted) return;
        _show(_overview!.withDraft(draft));
      });

  /// 確かめてから下書きをやめ、タイムラインを読み直す（§8.2）
  Future<void> _discard() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        content: const Text('作りかけのタイムラインを捨てますか？'),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('キャンセル')),
          ElevatedButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('捨てる')),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    await _send(() async {
      await widget.apiService.discardTimelineDraft(widget.tripId);
      if (!mounted) return;
      await _load(showLoading: false);
    });
  }

  /// タイムラインの操作を送る。送っている間は操作のボタンを押せなくし、失敗を §8.1 のとおりに扱う
  Future<void> _send(Future<void> Function() operation) async {
    setState(() => _sending = true);
    try {
      await operation();
    } catch (e) {
      debugPrint('TripTimelineView: タイムラインの操作のエラー: $e');
      if (!mounted) return;
      if (e is ApiException && e.isTripNotFound) {
        widget.onTripNotFound();
        return;
      }
      final messenger = ScaffoldMessenger.of(context);
      if (e is ApiException &&
          (e.isTimelineChanged || e.isTimelineNotCreatable)) {
        // 読んだ後に別の端末が変えた・写真の状態が変わった。今の状態を読み直して出す
        messenger.showSnackBar(SnackBar(
            content: Text(e.isTimelineChanged
                ? 'タイムラインが変わりました。読み直しました'
                : e.userMessage)));
        await _load(showLoading: false);
        return;
      }
      messenger.showSnackBar(SnackBar(
          content:
              Text(e is ApiException ? e.userMessage : 'タイムラインの操作に失敗しました')));
    } finally {
      if (mounted) setState(() => _sending = false);
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
    final timeline = overview.timeline;
    if (timeline == null) return _buildEmpty(overview);
    final draft = timeline.draft;
    if (draft != null) return _buildDraft(draft);
    // 完成版の表示は段階5の 5-4 で入れる。それまでの仮の案内
    return const Center(child: Text('タイムラインができました'));
  }

  /// 完成版も下書きも無い（§8.2 の1・2行目）
  Widget _buildEmpty(TimelineOverview overview) {
    final pending = overview.pendingPhotoCount;
    return _StatusView(
      title: 'タイムラインはまだありません',
      message: '写真を送り終えたら、日ごと・食事ごとにまとめたタイムラインを作れます。',
      actions: [
        ElevatedButton(
          onPressed: pending > 0 || _sending ? null : _create,
          child: const Text('タイムラインを作る'),
        ),
      ],
      note: pending > 0 ? '解析中の写真があと $pending 枚あります。終わると作れます。' : null,
    );
  }

  /// 下書きの状態（§8.2 の3行目から）
  Widget _buildDraft(TimelineDraftStatus draft) {
    final discard = OutlinedButton(
        onPressed: _sending ? null : _discard, child: const Text('やめる'));
    if (draft.phase == 'writing') {
      if (draft.isFailed) {
        return _StatusView(title: '見出しと一言を書けませんでした', actions: [
          ElevatedButton(
              onPressed: _sending ? null : _write, child: const Text('もう一度')),
          discard,
        ]);
      }
      return const _StatusView(
        title: '見出しと一言を書いています',
        message: 'この画面を閉じても続きます。',
        actions: [_WritingSteps()],
      );
    }
    if (draft.phase == 'reviewing') {
      return _StatusView(title: '区切りの案ができました', actions: [discard]);
    }
    if (draft.isFailed) {
      return _StatusView(title: '区切りの案を作れませんでした', actions: [
        ElevatedButton(
            onPressed: _sending ? null : _create, child: const Text('もう一度')),
        discard,
      ]);
    }
    return _StatusView(
      title: '区切りの案を作っています',
      message: 'この画面を閉じても続きます。',
      showsProgress: true,
      actions: [discard],
    );
  }
}

/// 見出し・説明・操作を中央に縦に並べた、タイムラインの状態の表示
class _StatusView extends StatelessWidget {
  const _StatusView(
      {required this.title,
      this.message,
      this.showsProgress = false,
      required this.actions,
      this.note});

  final String title;
  final String? message;

  /// 裏の処理が進んでいる印を出すか
  final bool showsProgress;
  final List<Widget> actions;

  /// 操作の下に添える一言
  final String? note;

  @override
  Widget build(BuildContext context) {
    final message = this.message;
    final note = this.note;
    final secondary =
        AppTextStyles.body2.copyWith(color: AppColors.textSecondary);
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (showsProgress) ...[
              const CircularProgressIndicator(
                  valueColor: AlwaysStoppedAnimation(AppColors.primary)),
              const SizedBox(height: 16),
            ],
            Text(title,
                style: AppTextStyles.headline3, textAlign: TextAlign.center),
            if (message != null) ...[
              const SizedBox(height: 8),
              Text(message, style: secondary, textAlign: TextAlign.center),
            ],
            const SizedBox(height: 24),
            Wrap(
              alignment: WrapAlignment.center,
              spacing: 12,
              runSpacing: 12,
              children: actions,
            ),
            if (note != null) ...[
              const SizedBox(height: 12),
              Text(note, style: secondary, textAlign: TextAlign.center),
            ],
          ],
        ),
      ),
    );
  }
}

/// 文を書いている間の3つの段（区切りの案・区切りの確認は済み、見出しと一言を書いている。§8.2）
class _WritingSteps extends StatelessWidget {
  const _WritingSteps();

  @override
  Widget build(BuildContext context) {
    Widget step(Widget mark, String label) => Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              SizedBox(width: 20, height: 20, child: Center(child: mark)),
              const SizedBox(width: 8),
              Text(label, style: AppTextStyles.body1),
            ],
          ),
        );
    const done = Icon(Icons.check_circle, size: 20, color: AppColors.primary);
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        step(done, '区切りの案'),
        step(done, '区切りの確認'),
        step(
            const SizedBox(
                width: 16,
                height: 16,
                child: CircularProgressIndicator(
                    strokeWidth: 2,
                    valueColor: AlwaysStoppedAnimation(AppColors.primary))),
            '見出しと一言'),
      ],
    );
  }
}
