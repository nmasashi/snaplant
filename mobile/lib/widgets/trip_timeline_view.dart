import 'dart:async';

import 'package:flutter/material.dart';
import '../models/timeline.dart';
import '../models/photo.dart';
import '../screens/photo_viewer_screen.dart';
import '../screens/timeline_review_screen.dart';
import '../services/api_service.dart';
import '../services/upload_queue.dart';
import '../theme/app_colors.dart';
import '../theme/app_text_styles.dart';
import 'message_view.dart';
import 'timeline_current_view.dart';
import 'timeline_edit_sheet.dart';
import 'timeline_notices.dart';
import 'timeline_confirm_dialog.dart';

/// 旅行詳細の「タイムライン」（docs/03_screen_design.md §8.1・§8.2）
///
/// 切り替えで「タイムライン」を選ぶたびに作り直され、そのたびに読み直す
class TripTimelineView extends StatefulWidget {
  const TripTimelineView(
      {super.key,
      required this.apiService,
      required this.uploadQueue,
      required this.tripId,
      required this.onTripNotFound});

  final ApiService apiService;

  /// 写真の送信の列（写真ビューアに渡す）
  final UploadQueue uploadQueue;
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
  // 操作（作る・もう一度・やめる・区切りを直す）を送っている間と、写真ビューアで開く写真を読んでいる間は、
  // 操作のボタンとサムネイルのタップを受け付けない（二重に送らない・画面を重ねて開かない。§8.1・§8.3）
  bool _sending = false;
  // 写真が変わった案内を「あとで」で隠したか（読み込み直すと戻す。§8.3）
  bool _changesNoticeHidden = false;
  // 表示の元になる応答の世代。タイムラインの読み込みと操作を始めるたびに進め、始めたときの世代のままの応答だけを使う
  // （前に始めた読み直し・読み込みの応答で、後の表示を上書きしない。§8.1）。下書きの読み直しは進めない（読み直しの間に始めたものを優先する）
  int _generation = 0;

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

  /// タイムラインを読む。[showLoading] が false なら、読み終えるまで今の表示のままにする（読み直しのとき）。
  /// [keepOnFailure] なら、失敗しても表示を変えずに次の下書きの読み直しを予約する（下書きの読み直しから続けて読むとき。§8.1）
  Future<void> _load(
      {bool showLoading = true, bool keepOnFailure = false}) async {
    final generation = ++_generation;
    _pollTimer?.cancel();
    if (showLoading) {
      setState(() {
        _overview = null;
        _errorMessage = null;
      });
    }
    try {
      final overview = await widget.apiService.getTimeline(widget.tripId);
      // 後から始めた読み込み・操作がある。先に始めたこの読み込みの結果（古い状態）では上書きしない
      if (!mounted || generation != _generation) return;
      _changesNoticeHidden = false;
      _show(overview);
    } catch (e) {
      debugPrint('TripTimelineView: タイムラインの読み込みエラー: $e');
      if (!mounted) return;
      if (e is ApiException && e.isTripNotFound) {
        widget.onTripNotFound();
        return;
      }
      if (generation != _generation) return;
      if (keepOnFailure && _overview != null) {
        _schedulePoll();
        return;
      }
      setState(() => _errorMessage =
          e is ApiException ? e.userMessage : 'タイムラインの読み込みに失敗しました');
    }
  }

  /// [overview] を出し、作っている途中の下書きなら読み直しを予約する
  void _show(TimelineOverview overview) {
    // 出すものがあればエラーの表示は外す（build はエラーを先に見るので、残すと出したものが隠れる）
    setState(() {
      _overview = overview;
      _errorMessage = null;
    });
    _schedulePoll();
  }

  /// 出している下書きが作っている途中なら、次の読み直しを予約する。
  /// エラーを出している間は予約しない（読み直しの結果でエラーの表示が黙って消えないように。「再試行」で読み直す）
  void _schedulePoll() {
    _pollTimer?.cancel();
    if (_errorMessage == null &&
        (_overview?.timeline?.draft?.isWorking ?? false)) {
      _pollTimer = Timer(_pollInterval, _poll);
    }
  }

  /// 下書きを読み直す。無くなった（完成版に入れ替わった）・段が変わった・作り終えた（失敗した）ら、タイムラインを読み直す（§8.1）
  Future<void> _poll() async {
    final shown = _overview;
    final shownDraft = shown?.timeline?.draft;
    if (shown == null || shownDraft == null) return;
    final generation = _generation;
    TimelineDraftStatus? draft;
    try {
      draft = await widget.apiService.getTimelineDraft(widget.tripId);
    } catch (e) {
      debugPrint('TripTimelineView: 下書きの読み直しのエラー: $e');
      if (!mounted) return;
      if (e is ApiException && e.isTripNotFound) {
        widget.onTripNotFound();
        return;
      }
      if (generation != _generation) return;
      // 読み直しの失敗は出さず、次の回にもう一度読む
      _schedulePoll();
      return;
    }
    // 待っている間に読み込みや操作を始めていたら、古い表示を元にした読み直しの結果は使わない
    if (!mounted || generation != _generation) return;
    if (draft == null || draft.phase != shownDraft.phase || !draft.isWorking) {
      await _load(showLoading: false, keepOnFailure: true);
      return;
    }
    _show(shown.withDraft(draft));
  }

  /// タイムラインを作る（失敗した区切りの案の「もう一度」も同じ）
  Future<void> _create() => _accept(widget.apiService.createTimeline);

  /// 見出しと一言を書かせる（失敗した文の「もう一度」）
  Future<void> _write() => _accept(widget.apiService.writeTimeline);

  /// 受け付けた下書きの状態（作る・書かせるの応答）で、読み直さずに表示を進める。
  /// 下書きが無い応答（区切りの直しをその場で完成版に当てた）なら、直した完成版を読み直す
  Future<void> _accept(Future<TimelineDraftStatus?> Function(String) send) =>
      _send(() async {
        final draft = await send(widget.tripId);
        if (!mounted) return;
        if (draft == null) {
          // 区切りの直しをその場で完成版に当てた（下書きが無くなった）。直した完成版を読み直す
          await _load(showLoading: false);
          return;
        }
        _show(_overview!.withDraft(draft));
      });

  /// 確かめてから下書きをやめ、タイムラインを読み直す（§8.2）
  Future<void> _discard() async {
    if (!await confirmDiscardTimeline(context,
            hasCurrent: _overview?.timeline?.current != null) ||
        !mounted) {
      return;
    }
    await _send(() async {
      await widget.apiService.discardTimelineDraft(widget.tripId);
      if (!mounted) return;
      await _load(showLoading: false);
    });
  }

  /// 完成版の区切りを直し始め、受け付けたら区切りの確認画面を開く（§8.3）
  Future<void> _recut() => _send(() async {
        await widget.apiService.recutTimeline(widget.tripId);
        if (!mounted) return;
        await _review();
      });

  /// 確かめてから作り直す（§8.6）。完成版の上に作り直しの案内を出す
  Future<void> _rebuild() async {
    if (!await confirmRebuildTimeline(context) || !mounted) {
      return;
    }
    await _create();
  }

  /// 写真を読み、写真ビューアでその1枚を開く。閉じたらタイムラインを読み直す（ビューアで消した・直したことを出す。§8.3）
  Future<void> _openPhoto(TimelinePhoto photo) async {
    if (_sending) return;
    // 写真を読む間も操作と同じに扱う（前に始めた読み直しの応答を使わず、ほかのタップと操作を受け付けない。§8.1・§8.3）
    final generation = ++_generation;
    _pollTimer?.cancel();
    setState(() => _sending = true);
    Photo? loaded;
    try {
      loaded = await widget.apiService.getPhoto(photo.id);
    } catch (e) {
      debugPrint('TripTimelineView: 写真の読み込みエラー: $e');
      if (!mounted) return;
      final messenger = ScaffoldMessenger.of(context);
      if (e is ApiException && e.isPhotoNotFound) {
        messenger.showSnackBar(const SnackBar(content: Text('この写真は削除されています')));
        await _load(showLoading: false);
        return;
      }
      messenger.showSnackBar(SnackBar(
          content: Text(e is ApiException ? e.userMessage : '写真の読み込みに失敗しました')));
    } finally {
      if (mounted) setState(() => _sending = false);
    }
    if (!mounted) return;
    if (loaded == null) {
      // 表示はそのまま。作っている途中の下書きなら読み直しを続ける
      if (generation == _generation) _schedulePoll();
      return;
    }
    final photos = ValueNotifier<List<Photo>>([loaded]);
    await Navigator.push(
      context,
      MaterialPageRoute(
        builder: (context) => PhotoViewerScreen(
          apiService: widget.apiService,
          uploadQueue: widget.uploadQueue,
          photos: photos,
          initialIndex: 0,
          onReachEnd: () {},
          hasMore: () => false,
          onDeleted: (_) => photos.value = const [],
          onUpdated: (updated) => photos.value = [updated],
        ),
      ),
    );
    photos.dispose();
    if (!mounted) return;
    await _load(showLoading: false);
  }

  /// 日の文を直す（§8.5）
  Future<void> _editDay(TimelineDay day) => _edit(
        title: '${day.dayNumber}日目を編集',
        fields: [
          TimelineEditField(
              key: 'title', label: 'タイトル', maxLength: 40, initial: day.title),
          TimelineEditField(
              key: 'summary',
              label: 'まとめ',
              maxLength: 400,
              initial: day.summary),
        ],
        hint: '空にすると、AI が書いた文に戻ります',
        save: (changes) => widget.apiService
            .updateTimelineDay(widget.tripId, day.date, changes),
      );

  /// 場面の文を直す（§8.5）。場面は最初の写真の id で指す
  Future<void> _editScene(TimelineScene scene) => _edit(
        title: '場面を編集',
        fields: [
          TimelineEditField(
              key: 'label', label: '見出し', maxLength: 30, initial: scene.label),
          TimelineEditField(
              key: 'note', label: '一言', maxLength: 200, initial: scene.note),
        ],
        // 区切りを直して足した場面は AI の文が無いので、空にすると空に戻る（5-5a）
        hint: '空にすると、AI が書いた文に戻ります（AI が書いていない場面は空になります）',
        save: (changes) => widget.apiService
            .updateTimelineScene(widget.tripId, scene.startPhotoId, changes),
      );

  /// 編集シートを開き、保存できたら応答で描き直す。タイムラインが変わった・旅行が無いなら §8.1 のとおりに扱う
  Future<void> _edit({
    required String title,
    required List<TimelineEditField> fields,
    required String hint,
    required Future<TimelineOverview> Function(Map<String, String?>) save,
  }) async {
    final result = await showModalBottomSheet<Object>(
      context: context,
      isScrollControlled: true,
      // 下に引いて閉じると PopScope を通らず、保存中でも閉じてしまう（§8.5）。閉じるのは「キャンセル」とシートの外のタップ
      enableDrag: false,
      builder: (context) =>
          TimelineEditSheet(
              title: title, fields: fields, hint: hint, onSave: save),
    );
    if (!mounted || result == null) return;
    if (result is TimelineOverview) {
      // 直した後の完成版で描き直す。前に始めた読み直しの応答は使わない（§8.1）
      ++_generation;
      _show(result);
      return;
    }
    if (result is ApiException && result.isTripNotFound) {
      widget.onTripNotFound();
      return;
    }
    ScaffoldMessenger.of(context)
        .showSnackBar(const SnackBar(content: Text('タイムラインが変わりました。読み直しました')));
    await _load(showLoading: false);
  }

  /// 区切りの確認画面を開き、閉じたら（どう閉じても）タイムラインを読み直す（§8.4）
  Future<void> _review() async {
    await Navigator.push(
      context,
      MaterialPageRoute(
        builder: (context) => TimelineReviewScreen(
            apiService: widget.apiService, tripId: widget.tripId),
      ),
    );
    if (!mounted) return;
    await _load(showLoading: false);
  }

  /// タイムラインの操作を送る。送っている間は操作のボタンを押せなくし、失敗を §8.1 のとおりに扱う
  Future<void> _send(Future<void> Function() operation) async {
    // 操作を始めたら、それより前に始めた読み直し・読み込みの応答は使わない（§8.1）
    final generation = ++_generation;
    _pollTimer?.cancel();
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
      // 表示はそのまま。作っている途中の下書きなら読み直しを続ける
      if (generation == _generation) _schedulePoll();
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
    final current = timeline.current;
    if (current == null) return _buildDraft(draft!);
    return TimelineCurrentView(
      current: current,
      pendingPhotoCount: overview.pendingPhotoCount,
      onRecut: _sending ? null : _recut,
      onRebuild: _sending ? null : _rebuild,
      onOpenPhoto: _sending ? null : _openPhoto,
      onEditDay: _sending ? null : _editDay,
      onEditScene: _sending ? null : _editScene,
      banner: draft == null ? null : _buildRebuildBanner(draft),
      notices: [
        if (draft == null &&
            !_changesNoticeHidden &&
            TimelineChangesNotice.shows(timeline.changes))
          TimelineChangesNotice(
            changes: timeline.changes!,
            onLater: () => setState(() => _changesNoticeHidden = true),
            onRebuild:
                _sending || overview.pendingPhotoCount > 0 ? null : _rebuild,
          ),
      ],
    );
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

  /// 完成版の上の下書きの案内（§8.3 の表。作り直し・区切りの直し）
  Widget _buildRebuildBanner(TimelineDraftStatus draft) {
    final discard = OutlinedButton(
        onPressed: _sending ? null : _discard, child: const Text('やめる'));
    Widget review(String label) => OutlinedButton(
        onPressed: _sending ? null : _review, child: Text(label));
    Widget retry(Future<void> Function() send) => ElevatedButton(
        onPressed: _sending ? null : send, child: const Text('もう一度'));
    final (String title, List<Widget> actions) = switch (draft.phase) {
      'writing' when draft.isFailed => (
          '見出しと一言を書き直せませんでした',
          [retry(_write), review('区切りを確認する'), discard]
        ),
      'writing' => ('見出しと一言を書き直しています', const <Widget>[]),
      'reviewing' when draft.reason == 'recut' => (
          '区切りを直している途中です',
          [review('続ける'), discard]
        ),
      'reviewing' => ('作り直しの区切りの案ができました', [review('区切りを確認する'), discard]),
      _ when draft.isFailed => (
          '作り直しの区切りの案を作れませんでした',
          [retry(_create), discard]
        ),
      _ => ('作り直しの区切りの案を作っています', [discard]),
    };
    return TimelineNoticeCard(text: title, actions: actions);
  }

  /// 下書きの状態（§8.2 の3行目から）
  Widget _buildDraft(TimelineDraftStatus draft) {
    final discard = OutlinedButton(
        onPressed: _sending ? null : _discard, child: const Text('やめる'));
    // 区切りの確認画面（§8.4）を開く。確かめ待ちと、文を書くのに失敗した下書き
    Widget review({required bool primary}) {
      final onPressed = _sending ? null : _review;
      const label = Text('区切りを確認する');
      return primary
          ? ElevatedButton(onPressed: onPressed, child: label)
          : OutlinedButton(onPressed: onPressed, child: label);
    }

    // 失敗した段をやり直す
    Widget retry(Future<void> Function() send) => ElevatedButton(
        onPressed: _sending ? null : send, child: const Text('もう一度'));
    if (draft.phase == 'writing') {
      if (draft.isFailed) {
        return _StatusView(title: '見出しと一言を書けませんでした', actions: [
          retry(_write),
          review(primary: false),
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
      return _StatusView(
          title: '区切りの案ができました', actions: [review(primary: true), discard]);
    }
    if (draft.isFailed) {
      return _StatusView(title: '区切りの案を作れませんでした', actions: [
        retry(_create),
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
