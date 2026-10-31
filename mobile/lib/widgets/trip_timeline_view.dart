import 'dart:async';

import 'package:flutter/material.dart';
import '../models/timeline.dart';
import '../screens/timeline_scene_screen.dart';
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

/// 旅行詳細の上のバーのメニューに足すタイムラインの項目（§8.1・§8.3）。押せないものは null
class TimelineMenu {
  const TimelineMenu(
      {required this.onEdit,
      required this.onRebuild,
      required this.pendingPhotoCount});

  /// 「タイムラインを編集」
  final VoidCallback? onEdit;

  /// 「タイムラインを作り直す」（解析中の写真がある間は押せない）
  final VoidCallback? onRebuild;

  /// 解析が済んでいない写真の枚数（0 でなければ「作り直す」の下に添える）
  final int pendingPhotoCount;
}

/// 旅行詳細の「タイムライン」（docs/03_screen_design.md §8.1・§8.2）
///
/// 切り替えで「タイムライン」を選ぶたびに作り直され、そのたびに読み直す
class TripTimelineView extends StatefulWidget {
  const TripTimelineView(
      {super.key,
      required this.apiService,
      required this.uploadQueue,
      required this.tripId,
      required this.onTripNotFound,
      required this.onMenuChanged});

  final ApiService apiService;

  /// 写真の送信の列（場面の写真の一覧から開く写真ビューアに渡す）
  final UploadQueue uploadQueue;
  final String tripId;

  /// 旅行が既に無いと分かった（旅行詳細が「この旅行は削除されています」にする。写真の一覧と同じ）
  final VoidCallback onTripNotFound;

  /// 旅行詳細のメニューに出すタイムラインの項目を渡す（描くたび）。完成版を出していて下書きが無いときだけで、それ以外は null。
  /// 旅行詳細はメニューを開くときに最後に受け取ったものを読むだけで、受け取っても描き直さない（描いている間に呼んでよい）
  final ValueChanged<TimelineMenu?> onMenuChanged;

  @override
  State<TripTimelineView> createState() => _TripTimelineViewState();
}

/// タイムラインの読み込みに失敗したときの扱い（§8.1）
enum _LoadFailure {
  /// 「エラーが発生しました」を出す（開いたとき・「再試行」・操作の後の読み直し）
  showError,

  /// 出している表示を変えず、次の読み直しを予約する（下書きの読み直しから続けて読むとき）
  keepSilently,

  /// 出している表示を変えず、エラーの文言をスナックバーに出して読み直しの予約を戻す（下に引っ張ったとき）
  keepWithSnackBar,
}

class _TripTimelineViewState extends State<TripTimelineView> {
  /// 下書きを作っている間に、下書きを読み直す間隔（§8.1）
  static const _pollInterval = Duration(seconds: 5);

  TimelineOverview? _overview;
  // 読み込みに失敗したときの文言。null なら失敗していない
  String? _errorMessage;
  // 下書きの次の読み直し。作っている途中の下書きを出している間だけ動かす（「写真」に戻す・画面を閉じると dispose で止まる）
  Timer? _pollTimer;
  // 操作（作る・もう一度・やめる・区切りを直す）を送っている間は、
  // 操作のボタンと場面のタップと、下に引っ張る読み直しを受け付けない（二重に送らない・画面を重ねて開かない・
  // 読み直しの応答が操作の後や開いた画面の上に届いて、古い状態を当てたりエラーを出したりしない。§8.1・§8.3）
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
  /// 失敗したときの扱いは [onFailure]（表示を出していないときは、どれでも「エラーが発生しました」）
  Future<void> _load(
      {bool showLoading = true,
      _LoadFailure onFailure = _LoadFailure.showError}) async {
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
      final message = e is ApiException ? e.userMessage : 'タイムラインの読み込みに失敗しました';
      if (onFailure != _LoadFailure.showError && _overview != null) {
        if (onFailure == _LoadFailure.keepWithSnackBar) {
          ScaffoldMessenger.of(context)
              .showSnackBar(SnackBar(content: Text(message)));
        }
        _schedulePoll();
        return;
      }
      setState(() => _errorMessage = message);
    }
  }

  /// 下に引っ張ったときの読み直し。読み終えるまで今の表示のままにし、失敗したら表示はそのままでエラーの文言をスナックバーに出す
  /// （写真の一覧と同じ。§8.1）
  Future<void> _refresh() async {
    await _load(showLoading: false, onFailure: _LoadFailure.keepWithSnackBar);
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
      await _load(showLoading: false, onFailure: _LoadFailure.keepSilently);
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

  /// 確かめてからタイムラインの編集（区切りの直し）をやめ、タイムラインを読み直す（§8.3）
  Future<void> _discard() async {
    if (!await confirmDiscardEdit(context) || !mounted) {
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
        await _review(editing: true);
      });

  /// 確かめてから作り直す（§8.6）。受け付けたら作っている間の表示にする（§8.2）
  Future<void> _rebuild() async {
    if (!await confirmRebuildTimeline(context) || !mounted) {
      return;
    }
    await _create();
  }

  /// 場面の写真の一覧を開き、閉じたら（どう閉じても）タイムラインを読み直す（一覧で直した見出しや、写真ビューアで消した・直したことを出す。§8.3）
  Future<void> _openScene(TimelineDay day, TimelineScene scene) async {
    if (_sending) return;
    // 開く前に始めた読み直しの応答は使わない（失敗を一覧の上に出さない。§8.1）。閉じたら読み直す
    ++_generation;
    _pollTimer?.cancel();
    await Navigator.push(
      context,
      MaterialPageRoute(
        builder: (context) => TimelineSceneScreen(
            apiService: widget.apiService,
            uploadQueue: widget.uploadQueue,
            tripId: widget.tripId,
            date: day.date,
            scene: scene),
      ),
    );
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

  /// 編集シートを開き、保存できたら応答で描き直す。タイムラインが変わった・旅行が無いなら §8.1 のとおりに扱う
  Future<void> _edit({
    required String title,
    required List<TimelineEditField> fields,
    required String hint,
    required Future<TimelineOverview> Function(Map<String, String?>) save,
  }) async {
    final result = await showTimelineEditSheet(context,
        title: title, fields: fields, hint: hint, onSave: save);
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

  /// 案の確認画面を開き、閉じたら（どう閉じても）タイムラインを読み直す（§8.4）。[editing] ならタイムラインの編集（区切りの直し）
  Future<void> _review({required bool editing}) async {
    await Navigator.push(
      context,
      MaterialPageRoute(
        builder: (context) => TimelineReviewScreen(
            apiService: widget.apiService,
            tripId: widget.tripId,
            editing: editing,
            current: _overview?.timeline?.current),
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
    widget.onMenuChanged(_menu());
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
    return RefreshIndicator(
      onRefresh: _refresh,
      // 操作を送っている間は引っ張れない（[_sending]）
      notificationPredicate: (notification) =>
          !_sending && defaultScrollNotificationPredicate(notification),
      color: AppColors.primary,
      child: _buildLoaded(overview),
    );
  }

  /// 読み込めたタイムラインの表示（下に引っ張ると読み直す。§8.1）
  Widget _buildLoaded(TimelineOverview overview) {
    final timeline = overview.timeline;
    if (timeline == null) return _buildEmpty(overview);
    final draft = timeline.draft;
    final current = timeline.current;
    // 完成版の上に出すのはタイムラインの編集（recut）の下書きだけ。作る下書き（5-6 より前に始めた作り直しも）は作っている間の表示（§8.2）
    if (current == null || (draft != null && draft.reason != 'recut')) {
      return _buildDraft(draft!);
    }
    return TimelineCurrentView(
      current: current,
      onOpenScene: _sending ? null : _openScene,
      onEditDay: _sending ? null : _editDay,
      banner: draft == null ? null : _buildEditBanner(draft),
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

  /// 旅行詳細のメニューのタイムラインの項目（§8.3）。出すのは完成版を出していて下書きが無いときだけ
  TimelineMenu? _menu() {
    final overview = _overview;
    final timeline = overview?.timeline;
    return overview != null &&
            _errorMessage == null &&
            timeline?.current != null &&
            timeline?.draft == null
        ? TimelineMenu(
            onEdit: _sending ? null : _recut,
            onRebuild:
                _sending || overview.pendingPhotoCount > 0 ? null : _rebuild,
            pendingPhotoCount: overview.pendingPhotoCount,
          )
        : null;
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

  /// 完成版の上の、タイムラインを編集している（区切りの直し。recut）下書きの案内（§8.3）
  Widget _buildEditBanner(TimelineDraftStatus draft) {
    final discard = OutlinedButton(
        onPressed: _sending ? null : _discard, child: const Text('やめる'));
    Widget review(String label) => OutlinedButton(
        onPressed: _sending ? null : () => _review(editing: true),
        child: Text(label));
    Widget retry(Future<void> Function() send) => ElevatedButton(
        onPressed: _sending ? null : send, child: const Text('もう一度'));
    final (String title, List<Widget> actions) = switch (draft.phase) {
      'writing' when draft.isFailed => (
          '見出しと一言を書き直せませんでした',
          [retry(_write), review('案を確認する'), discard]
        ),
      // 5-5a より前に文を書く待ちに積んだ区切りの直し（ワーカーが AI を使わずに当てる）
      'writing' => ('見出しと一言を書き直しています', const <Widget>[]),
      _ => ('タイムラインを編集している途中です', [review('続ける'), discard]),
    };
    return TimelineNoticeCard(text: title, actions: actions);
  }

  /// 下書きの状態（§8.2 の3行目から）。作り始めたら最後まで進むので「やめる」は出さない
  Widget _buildDraft(TimelineDraftStatus draft) {
    // 案の確認画面（§8.4）を開く。確かめ待ちと、文を書くのに失敗した下書き
    Widget review({required bool primary}) {
      final onPressed =
          _sending ? null : () => _review(editing: draft.reason == 'recut');
      const label = Text('案を確認する');
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
        ]);
      }
      return const _StatusView(
        title: '見出しと一言を書いています',
        message: 'ふつうは1分ほどで終わります。この画面を閉じても続きます。',
        actions: [_WritingSteps()],
      );
    }
    if (draft.phase == 'reviewing') {
      return _StatusView(
          title: 'タイムラインの案ができました',
          message: '場面の分け方を確かめてから、AI が見出しと一言を書きます。',
          actions: [review(primary: true)]);
    }
    if (draft.isFailed) {
      return _StatusView(title: 'タイムラインの案を作れませんでした', actions: [retry(_create)]);
    }
    // AI がすぐ終わると思わせない（実行環境の入れ替えで止まると、再投入のタイマーが拾うまで 10 分ほどかかる。§8.2）
    return const _StatusView(
      title: 'タイムラインの案を作っています',
      message: 'ふつうは1分ほどで終わります。混んでいると10分ほどかかることがあります。この画面を閉じても続きます。',
      showsProgress: true,
      actions: [],
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
    // 中身が画面より短くても下に引っ張れるよう、高さいっぱいの領域の中央に置く（写真の一覧の案内と同じ）
    return LayoutBuilder(
      builder: (context, constraints) => SingleChildScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        child: ConstrainedBox(
          constraints: BoxConstraints(minHeight: constraints.maxHeight),
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (showsProgress) ...[
                    const CircularProgressIndicator(
                        valueColor: AlwaysStoppedAnimation(AppColors.primary)),
                    const SizedBox(height: 16),
                  ],
                  Text(title,
                      style: AppTextStyles.headline3,
                      textAlign: TextAlign.center),
                  if (message != null) ...[
                    const SizedBox(height: 8),
                    Text(message,
                        style: secondary, textAlign: TextAlign.center),
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
          ),
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
        step(done, 'タイムラインの案'),
        step(done, '案の確認'),
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
