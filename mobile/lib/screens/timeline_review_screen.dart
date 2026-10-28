import 'package:flutter/material.dart';
import '../models/timeline.dart';
import '../services/api_service.dart';
import '../theme/app_colors.dart';
import '../theme/app_text_styles.dart';
import '../utils/timeline_format.dart';
import '../widgets/message_view.dart';
import '../widgets/timeline_confirm_dialog.dart';
import '../widgets/timeline_thumbnail.dart';

/// 案の確認画面（docs/03_screen_design.md §8.4）
///
/// 下書きの区切りを確かめて直す。作る・作り直すときの「タイムラインの案」と、完成版の「タイムラインを編集」（区切りの直し。recut）で同じ画面を使う。閉じると旅行詳細がタイムラインを読み直す（どう閉じても）
class TimelineReviewScreen extends StatefulWidget {
  const TimelineReviewScreen(
      {super.key,
      required this.apiService,
      required this.tripId,
      required this.editing,
      this.current});

  final ApiService apiService;
  final String tripId;

  /// タイムラインの編集（区切りの直し）として開いたか。見出しを読み込む前から出すため、開く側が渡す
  final bool editing;

  /// 旅行詳細が読んだ完成版（タイムラインを編集するとき、つなげると消える見出しと一言を知らせる。§8.7）
  final TimelineCurrent? current;

  @override
  State<TimelineReviewScreen> createState() => _TimelineReviewScreenState();
}

class _TimelineReviewScreenState extends State<TimelineReviewScreen> {
  /// 場面の写真を並べる列の数
  static const _columns = 5;

  TimelineDraftStatus? _draft;
  // 読み込みに失敗したときの文言。null なら失敗していない
  String? _errorMessage;
  // 区切りの保存や操作を送っている間は、ほかの操作を受け付けない（§8.4）
  bool _sending = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  /// 下書きを読む。確かめられる状態でなければ知らせて旅行詳細に戻る
  Future<void> _load() async {
    setState(() {
      _draft = null;
      _errorMessage = null;
    });
    try {
      final draft = await widget.apiService.getTimelineDraft(widget.tripId);
      if (!mounted) return;
      if (draft == null || draft.days == null) {
        _closeBecauseChanged();
        return;
      }
      setState(() => _draft = draft);
    } catch (e) {
      debugPrint('TimelineReviewScreen: 下書きの読み込みエラー: $e');
      if (!mounted) return;
      if (e is ApiException && e.isTripNotFound) {
        // 旅行詳細が読み直して「この旅行は削除されています」にする
        Navigator.pop(context);
        return;
      }
      setState(() =>
          _errorMessage = e is ApiException ? e.userMessage : '読み込みに失敗しました');
    }
  }

  /// 下書きが別の端末で変わった。知らせて旅行詳細に戻る（旅行詳細が読み直す）
  void _closeBecauseChanged() {
    final messenger = ScaffoldMessenger.of(context);
    Navigator.pop(context);
    messenger
        .showSnackBar(const SnackBar(content: Text('タイムラインが変わりました。読み直しました')));
  }

  /// 今の区切り（場面の最初の写真の id。撮影の順）
  List<String> _sceneStarts() => [
        for (final day in _draft!.days!)
          for (final scene in day.scenes) scene.startPhotoId,
      ];

  /// [photo] から新しい場面にする（[photo] を、その場面の区切りの次に足す）
  Future<void> _split(TimelineScene scene, TimelinePhoto photo) => _save([
        for (final start in _sceneStarts()) ...[
          start,
          if (start == scene.startPhotoId) photo.id,
        ],
      ]);

  /// [scene] を前の場面とつなげる（[scene] の区切りを外す。§8.7）
  ///
  /// タイムラインを編集するときは、後ろの場面の見出しと一言が消えることを確かめる（あれば）。
  /// それ以外は、場面のコメントは前の場面のものを残し、前に無ければ後ろのものを引き継ぐ。両方にあるときだけ、後ろのコメントが消えることを確かめる
  Future<void> _merge(TimelineScene scene) async {
    final starts = [
      for (final start in _sceneStarts())
        if (start != scene.startPhotoId) start
    ];
    if (_draft!.reason == 'recut') {
      if (!await _confirmDroppingTexts(scene) || !mounted) return;
      await _save(starts);
      return;
    }
    final previous = _previousScene(scene);
    final kept = previous.comment;
    final dropped = scene.comment;
    if (kept != null && dropped != null) {
      final confirmed = await confirmMergeScenes(context,
          message: '前の場面のコメントを残します。後ろの場面のコメントは消えます。',
          lost: ['消えるコメント: $dropped']);
      if (!confirmed || !mounted) return;
    }
    final comments = _comments()..remove(scene.startPhotoId);
    if (kept == null && dropped != null) {
      comments[previous.startPhotoId] = dropped;
    }
    await _save(starts, comments: comments);
  }

  /// タイムラインを編集するとき、つなげて消える後ろの場面の見出しと一言（完成版のもの）があれば確かめる。無ければ確かめずに true
  Future<bool> _confirmDroppingTexts(TimelineScene scene) async {
    final texts = widget.current?.days
        .expand((day) => day.scenes)
        .where((current) => current.startPhotoId == scene.startPhotoId)
        .firstOrNull;
    final lost = [
      if (texts?.label != null) '消える見出し: ${texts!.label}',
      if (texts?.note != null) '消える一言: ${texts!.note}',
    ];
    if (lost.isEmpty) return true;
    return confirmMergeScenes(context,
        message: 'つなげると、後ろの場面の見出しと一言は消えます。', lost: lost);
  }

  /// 同じ日の、[scene] の1つ前の場面（「つなげる」は日の2つ目からの場面にだけ出す）
  TimelineScene _previousScene(TimelineScene scene) {
    for (final day in _draft!.days!) {
      final index = day.scenes.indexOf(scene);
      if (index > 0) return day.scenes[index - 1];
    }
    throw StateError('前の場面がありません: ${scene.startPhotoId}');
  }

  /// 今の場面のコメント（場面の最初の写真の id → コメント）
  Map<String, String> _comments() => {
        for (final day in _draft!.days!)
          for (final scene in day.scenes)
            if (scene.comment != null) scene.startPhotoId: scene.comment!,
      };

  /// 場面のコメントを書くシートを開く。「保存」でシートの中から区切りと一緒に送り（空なら消す。§8.7）、保存できたら応答で描き直す。
  /// 下書きが変わった・旅行が無いなら、シートが閉じた後に §8.4 のとおりに扱う
  Future<void> _editComment(TimelineScene scene) async {
    final result = await showModalBottomSheet<Object>(
      context: context,
      isScrollControlled: true,
      // 下に引いて閉じると PopScope を通らず、保存中でも閉じてしまう（編集シートと同じ。§8.5）
      enableDrag: false,
      builder: (context) => _SceneCommentSheet(
        initial: scene.comment,
        onSave: (text) {
          final comments = _comments();
          if (text.trim().isEmpty) {
            comments.remove(scene.startPhotoId);
          } else {
            comments[scene.startPhotoId] = text;
          }
          return widget.apiService.saveTimelineScenes(
              widget.tripId, _sceneStarts(),
              sceneComments: comments);
        },
      ),
    );
    if (!mounted || result == null) return;
    if (result is TimelineDraftStatus) {
      setState(() => _draft = result);
      return;
    }
    _handleOperationError(result, '保存に失敗しました');
  }

  /// 区切りを保存し、応答で描き直す。失敗したら表示はそのまま（§8.4）。[comments] を渡せば場面のコメントも送る
  Future<void> _save(List<String> sceneStarts,
      {Map<String, String>? comments}) async {
    setState(() => _sending = true);
    try {
      final draft = await widget.apiService.saveTimelineScenes(
          widget.tripId, sceneStarts,
          sceneComments: comments);
      if (!mounted) return;
      setState(() => _draft = draft);
    } catch (e) {
      debugPrint('TimelineReviewScreen: 区切りの保存のエラー: $e');
      if (!mounted) return;
      _handleOperationError(e, '保存に失敗しました');
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  /// 文を書かせて旅行詳細に戻る
  Future<void> _write() =>
      _sendAndClose(() async => widget.apiService.writeTimeline(widget.tripId));

  /// 確かめてから AI に案を出し直してもらい、旅行詳細に戻る（作る・作り直すときだけ。§8.4）
  Future<void> _repropose() async {
    final confirmed = await confirmTimelineAction(context,
        message: 'AI がもう一度案を出します。この画面で直した場面の分け方は消えます。', confirmLabel: '出し直す');
    if (!confirmed || !mounted) {
      return;
    }
    await _sendAndClose(
        () async => widget.apiService.createTimeline(widget.tripId));
  }

  /// 確かめてから編集をやめ、旅行詳細に戻る（タイムラインを編集するときだけ。§8.3 と同じダイアログ）
  Future<void> _discard() async {
    if (!await confirmDiscardEdit(context) || !mounted) {
      return;
    }
    await _sendAndClose(
        () => widget.apiService.discardTimelineDraft(widget.tripId));
  }

  /// 操作を送り、できたら旅行詳細に戻る（旅行詳細が読み直す）。送っている間はほかの操作を受け付けない
  Future<void> _sendAndClose(Future<void> Function() operation) async {
    setState(() => _sending = true);
    try {
      await operation();
      if (!mounted) return;
      Navigator.pop(context);
    } catch (e) {
      debugPrint('TimelineReviewScreen: 操作のエラー: $e');
      if (!mounted) return;
      _handleOperationError(e, 'タイムラインの操作に失敗しました');
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  /// 操作の失敗（§8.4）。下書きが変わった・旅行が無いなら旅行詳細に戻り、それ以外は文言を出す
  void _handleOperationError(Object e, String fallback) {
    if (e is ApiException && e.isTripNotFound) {
      Navigator.pop(context);
      return;
    }
    if (e is ApiException && e.isTimelineChanged) {
      _closeBecauseChanged();
      return;
    }
    ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(e is ApiException ? e.userMessage : fallback)));
  }

  /// 写真の長押しのメニュー（場面の最初の写真では出さない）
  Future<void> _showPhotoMenu(TimelineScene scene, TimelinePhoto photo) async {
    final split = await showModalBottomSheet<bool>(
      context: context,
      builder: (context) => SafeArea(
        child: ListTile(
          leading: const Icon(Icons.content_cut),
          title: const Text('この写真から新しい場面'),
          onTap: () => Navigator.pop(context, true),
        ),
      ),
    );
    if (split != true || !mounted) return;
    await _split(scene, photo);
  }

  @override
  Widget build(BuildContext context) {
    final draft = _draft;
    // 読み込むまでは開く側が渡した値、読めたら下書きの理由（見出し・メニュー・下のボタンを同じ値で決める）
    final editing = draft == null ? widget.editing : draft.reason == 'recut';
    return Scaffold(
      appBar: AppBar(
        leading: IconButton(
          icon: const Icon(Icons.close),
          tooltip: '閉じる',
          onPressed: () => Navigator.pop(context),
        ),
        title: Text(editing ? 'タイムラインを編集' : 'タイムラインの案',
            style: AppTextStyles.appBarTitle),
        actions: [
          if (draft != null)
            PopupMenuButton<Future<void> Function()>(
              icon: const Icon(Icons.more_vert),
              enabled: !_sending,
              onSelected: (action) => action(),
              // 作る・作り直すときは出し直すだけ（作り始めたら最後まで進む）。編集するときはやめるだけ（作り直しは旅行詳細のメニューから）
              itemBuilder: (context) => [
                if (editing)
                  PopupMenuItem(value: _discard, child: const Text('やめる'))
                else
                  PopupMenuItem(
                      value: _repropose, child: const Text('AI に案を出し直してもらう')),
              ],
            ),
        ],
      ),
      body: _buildBody(draft),
      bottomNavigationBar: draft == null ? null : _buildWriteBar(draft),
    );
  }

  Widget _buildBody(TimelineDraftStatus? draft) {
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
    if (draft == null) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const CircularProgressIndicator(
                valueColor: AlwaysStoppedAnimation(AppColors.primary)),
            const SizedBox(height: 16),
            Text(
              '読み込み中...',
              style:
                  AppTextStyles.body1.copyWith(color: AppColors.textSecondary),
            ),
          ],
        ),
      );
    }
    const howTo = '写真を長押しすると『ここで区切る』、場面の境目の『つなげる』で前の場面とまとめられます。';
    final undated = draft.undatedPhotos ?? const [];
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Text(
          draft.reason == 'recut'
              // 区切りの直しは AI を使わずに保存する（06 §8.6）ので、足した場面とつなげた場面の文の扱いを添える
              ? '$howTo新しくできた場面は見出しなしになります。つなげると、後ろの場面の見出しと一言は消えます。'
              : 'AI が写真を場面に区切りました。$howTo',
          style: AppTextStyles.body2.copyWith(color: AppColors.textSecondary),
        ),
        for (final day in draft.days!) ..._buildDay(day),
        if (undated.isNotEmpty) ...[
          const SizedBox(height: 24),
          const Text('日時なし', style: AppTextStyles.headline3),
          const SizedBox(height: 8),
          _buildPhotos(undated),
        ],
      ],
    );
  }

  /// 日の見出しと場面のカード。同じ日の場面の間に「つなげる」を置く
  List<Widget> _buildDay(TimelineDay day) {
    return [
      const SizedBox(height: 24),
      Row(
        crossAxisAlignment: CrossAxisAlignment.baseline,
        textBaseline: TextBaseline.alphabetic,
        children: [
          Text('${day.dayNumber}日目', style: AppTextStyles.headline3),
          const SizedBox(width: 8),
          Text(timelineDateLabel(day.date),
              style:
                  AppTextStyles.body2.copyWith(color: AppColors.textSecondary)),
        ],
      ),
      for (final (index, scene) in day.scenes.indexed) ...[
        if (index > 0)
          Center(
            child: TextButton.icon(
              onPressed: _sending ? null : () => _merge(scene),
              icon: const Icon(Icons.link),
              label: const Text('つなげる'),
            ),
          )
        else
          const SizedBox(height: 8),
        _buildScene(scene),
      ],
    ];
  }

  Widget _buildScene(TimelineScene scene) {
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(_sceneLabel(scene), style: AppTextStyles.body1),
            const SizedBox(height: 8),
            _buildPhotos(scene.photos, scene: scene),
            // AI が見出しと一言を書くときの材料（§8.7）。タイムラインを編集するときは AI を使わないので出さない
            if (_draft!.reason != 'recut') ...[
              const SizedBox(height: 4),
              _buildComment(scene),
            ],
          ],
        ),
      ),
    );
  }

  /// 場面のコメント。無ければ「＋ コメントを書く」、あれば「コメント: {コメント}」（タップで直す）
  Widget _buildComment(TimelineScene scene) {
    final comment = scene.comment;
    if (comment == null) {
      return Align(
        alignment: Alignment.centerLeft,
        child: TextButton.icon(
          onPressed: _sending ? null : () => _editComment(scene),
          icon: const Icon(Icons.add),
          label: const Text('コメントを書く'),
        ),
      );
    }
    return InkWell(
      onTap: _sending ? null : () => _editComment(scene),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Text('コメント: $comment', style: AppTextStyles.body2),
      ),
    );
  }

  /// 写真を5列のサムネイルで全部並べる
  /// [scene] があれば、最初の写真を除いて長押しで「この写真から新しい場面」を出す（日時なしの写真は区切らない）
  Widget _buildPhotos(List<TimelinePhoto> photos, {TimelineScene? scene}) {
    return GridView.count(
      crossAxisCount: _columns,
      mainAxisSpacing: 2,
      crossAxisSpacing: 2,
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      children: [
        for (final (index, photo) in photos.indexed)
          GestureDetector(
            onLongPress: scene == null || index == 0 || _sending
                ? null
                : () => _showPhotoMenu(scene, photo),
            child: TimelineThumbnail(photo: photo),
          ),
      ],
    );
  }

  /// 下の「この案で見出しを付ける」（タイムラインを編集するときは「保存」。AI を使わずその場で保存する）と、日数・場面数
  Widget _buildWriteBar(TimelineDraftStatus draft) {
    final recut = draft.reason == 'recut';
    final days = draft.days!;
    final sceneCount =
        days.fold<int>(0, (count, day) => count + day.scenes.length);
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            ElevatedButton(
              onPressed: _sending ? null : _write,
              child: Text(recut ? '保存' : 'この案で見出しを付ける'),
            ),
            const SizedBox(height: 4),
            Text(
              '${days.length}日で $sceneCount 場面 · ${recut ? '見出しと一言はそのまま残します' : '見出しと一言は AI が書きます'}',
              style: AppTextStyles.caption
                  .copyWith(color: AppColors.textSecondary),
              textAlign: TextAlign.center,
            ),
          ],
        ),
      ),
    );
  }
}

/// 場面のカードの見出し「7:50〜7:58 · 北海道千歳市 · 2枚」（時刻は1枚なら1つ。地名が無ければ省く）
String _sceneLabel(TimelineScene scene) {
  return [
    timelineTimeRange(scene.photos),
    if (scene.placeNames.isNotEmpty) scene.placeNames.join('、'),
    '${scene.photos.length}枚',
  ].join(' · ');
}

/// 場面のコメントを書く、下から出るシート（§8.7）
///
/// 「保存」でシートの中から送る（失敗してもシートと書いた文を残す）。閉じるときの結果: 保存できたら応答の下書き、
/// 下書きが変わった・旅行が無いなら [ApiException]（呼ぶ側が知らせる）、キャンセル・何も変えずに保存したら null
class _SceneCommentSheet extends StatefulWidget {
  const _SceneCommentSheet({required this.initial, required this.onSave});

  /// 今のコメント（無ければ null）
  final String? initial;

  /// 書いた文（空もある）を送る
  final Future<TimelineDraftStatus> Function(String text) onSave;

  @override
  State<_SceneCommentSheet> createState() => _SceneCommentSheetState();
}

class _SceneCommentSheetState extends State<_SceneCommentSheet> {
  late final TextEditingController _controller =
      TextEditingController(text: widget.initial ?? '');
  // 保存している間は閉じられず、ボタンも押せない（編集シートと同じ）
  bool _saving = false;
  // 保存に失敗したときの文言（シートの中に出す）
  String? _errorMessage;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    // 押せなくする描き直しが届く前に続けて押されても、送るのは1回
    if (_saving) return;
    final text = _controller.text;
    if (text.trim() == (widget.initial ?? '').trim()) {
      Navigator.pop(context);
      return;
    }
    setState(() {
      _saving = true;
      _errorMessage = null;
    });
    try {
      final draft = await widget.onSave(text);
      if (!mounted) return;
      Navigator.pop(context, draft);
    } catch (e) {
      debugPrint('_SceneCommentSheet: 保存のエラー: $e');
      if (!mounted) return;
      if (e is ApiException && (e.isTimelineChanged || e.isTripNotFound)) {
        // 呼ぶ側が知らせて閉じる
        Navigator.pop(context, e);
        return;
      }
      setState(() {
        _saving = false;
        _errorMessage = e is ApiException ? e.userMessage : '保存に失敗しました';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final errorMessage = _errorMessage;
    return PopScope(
      canPop: !_saving,
      child: Padding(
        // キーボードの分だけ上げる
        padding:
            EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text('場面のコメント', style: AppTextStyles.headline3),
              const SizedBox(height: 12),
              TextField(
                controller: _controller,
                autofocus: true,
                enabled: !_saving,
                maxLength: 100,
                maxLines: null,
              ),
              if (errorMessage != null) ...[
                const SizedBox(height: 8),
                Text(errorMessage, style: AppTextStyles.error),
              ],
              const SizedBox(height: 16),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  TextButton(
                    onPressed: _saving ? null : () => Navigator.pop(context),
                    child: const Text('キャンセル'),
                  ),
                  const SizedBox(width: 8),
                  ElevatedButton(
                    onPressed: _saving ? null : _save,
                    child: const Text('保存'),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
