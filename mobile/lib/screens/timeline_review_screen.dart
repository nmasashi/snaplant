import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import '../models/timeline.dart';
import '../services/api_service.dart';
import '../theme/app_colors.dart';
import '../theme/app_text_styles.dart';
import '../utils/photo_cache_manager.dart';
import '../utils/taken_at.dart';
import '../widgets/message_view.dart';

/// 区切りの確認画面（docs/03_screen_design.md §8.4）
///
/// 下書きの区切りを確かめて直す。閉じると旅行詳細がタイムラインを読み直す（どう閉じても）
class TimelineReviewScreen extends StatefulWidget {
  const TimelineReviewScreen(
      {super.key, required this.apiService, required this.tripId});

  final ApiService apiService;
  final String tripId;

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
  bool _saving = false;

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
      setState(() => _errorMessage =
          e is ApiException ? e.userMessage : '区切りの読み込みに失敗しました');
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

  /// [scene] を前の場面とつなげる（[scene] の区切りを外す）
  Future<void> _merge(TimelineScene scene) => _save([
        for (final start in _sceneStarts())
          if (start != scene.startPhotoId) start
      ]);

  /// 区切りを保存し、応答で描き直す。失敗したら表示はそのまま（§8.4）
  Future<void> _save(List<String> sceneStarts) async {
    setState(() => _saving = true);
    try {
      final draft = await widget.apiService
          .saveTimelineScenes(widget.tripId, sceneStarts);
      if (!mounted) return;
      setState(() => _draft = draft);
    } catch (e) {
      debugPrint('TimelineReviewScreen: 区切りの保存のエラー: $e');
      if (!mounted) return;
      _handleOperationError(e, '区切りの保存に失敗しました');
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  /// 文を書かせて旅行詳細に戻る
  Future<void> _write() =>
      _sendAndClose(() async => widget.apiService.writeTimeline(widget.tripId));

  /// 確かめてから区切り案を出し直し、旅行詳細に戻る
  Future<void> _repropose() async {
    if (!await _confirm('AI がもう一度区切りの案を出します。この画面で直した区切りは消えます。', '出し直す')) {
      return;
    }
    await _sendAndClose(
        () async => widget.apiService.createTimeline(widget.tripId));
  }

  /// 確かめてから下書きをやめ、旅行詳細に戻る（§8.2 と同じダイアログ）
  Future<void> _discard() async {
    if (!await _confirm('作りかけのタイムラインを捨てますか？', '捨てる')) return;
    await _sendAndClose(
        () => widget.apiService.discardTimelineDraft(widget.tripId));
  }

  /// 「キャンセル」と [confirmLabel] のダイアログ。[confirmLabel] を押したら true
  Future<bool> _confirm(String message, String confirmLabel) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        content: Text(message),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('キャンセル')),
          ElevatedButton(
              onPressed: () => Navigator.pop(context, true),
              child: Text(confirmLabel)),
        ],
      ),
    );
    return confirmed == true && mounted;
  }

  /// 操作を送り、できたら旅行詳細に戻る（旅行詳細が読み直す）。送っている間はほかの操作を受け付けない
  Future<void> _sendAndClose(Future<void> Function() operation) async {
    setState(() => _saving = true);
    try {
      await operation();
      if (!mounted) return;
      Navigator.pop(context);
    } catch (e) {
      debugPrint('TimelineReviewScreen: 操作のエラー: $e');
      if (!mounted) return;
      _handleOperationError(e, 'タイムラインの操作に失敗しました');
    } finally {
      if (mounted) setState(() => _saving = false);
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
    return Scaffold(
      appBar: AppBar(
        leading: IconButton(
          icon: const Icon(Icons.close),
          tooltip: '閉じる',
          onPressed: () => Navigator.pop(context),
        ),
        title: const Text('区切りを確認', style: AppTextStyles.appBarTitle),
        actions: [
          if (draft != null)
            PopupMenuButton<Future<void> Function()>(
              icon: const Icon(Icons.more_vert),
              enabled: !_saving,
              onSelected: (action) => action(),
              itemBuilder: (context) => [
                PopupMenuItem(
                    value: _repropose, child: const Text('区切り案を出し直す')),
                PopupMenuItem(value: _discard, child: const Text('やめる')),
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
              '区切りを読み込み中...',
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
          draft.reason == 'recut' ? howTo : 'AI が写真を場面に区切りました。$howTo',
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
          Text(_dateLabel(day.date),
              style:
                  AppTextStyles.body2.copyWith(color: AppColors.textSecondary)),
        ],
      ),
      for (final (index, scene) in day.scenes.indexed) ...[
        if (index > 0)
          Center(
            child: TextButton.icon(
              onPressed: _saving ? null : () => _merge(scene),
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
          ],
        ),
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
            onLongPress: scene == null || index == 0 || _saving
                ? null
                : () => _showPhotoMenu(scene, photo),
            child: _buildThumbnail(photo),
          ),
      ],
    );
  }

  Widget _buildThumbnail(TimelinePhoto photo) {
    return Semantics(
      label: formatTakenAt(photo.takenAt),
      container: true,
      child: CachedNetworkImage(
        imageUrl: photo.thumbnailUrl,
        cacheKey: thumbnailCacheKey(photo.id),
        cacheManager: PhotoCacheManager.thumbnails,
        // サムネイルが無い写真は原寸の URL が来るので、マスの大きさに縮めて読む
        memCacheWidth: 200,
        fit: BoxFit.cover,
        placeholder: (context, url) =>
            const ColoredBox(color: AppColors.surfaceVariant),
        errorWidget: (context, url, error) =>
            const ColoredBox(color: AppColors.surfaceVariant),
      ),
    );
  }

  /// 下の「この区切りで見出しを付ける」と、日数・場面数
  Widget _buildWriteBar(TimelineDraftStatus draft) {
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
              onPressed: _saving ? null : _write,
              child: const Text('この区切りで見出しを付ける'),
            ),
            const SizedBox(height: 4),
            Text(
              '${days.length}日で $sceneCount 場面 · 見出しと一言は AI が書きます',
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

/// 日の日付の表記「10月5日（月）」（日付は文字列の暦の日。端末のタイムゾーンに直さない）
String _dateLabel(String date) {
  final day = DateTime.utc(int.parse(date.substring(0, 4)),
      int.parse(date.substring(5, 7)), int.parse(date.substring(8, 10)));
  const weekdays = ['月', '火', '水', '木', '金', '土', '日'];
  return '${day.month}月${day.day}日（${weekdays[day.weekday - 1]}）';
}

/// 場面のカードの見出し「7:50〜7:58 · 北海道千歳市 · 2枚」（時刻は1枚なら1つ。地名が無ければ省く）
String _sceneLabel(TimelineScene scene) {
  final photos = scene.photos;
  final first = _clock(photos.first.takenAt!);
  final time =
      photos.length == 1 ? first : '$first〜${_clock(photos.last.takenAt!)}';
  return [
    time,
    if (scene.placeNames.isNotEmpty) scene.placeNames.join('、'),
    '${photos.length}枚',
  ].join(' · ');
}

/// 撮影時刻「7:50」（撮影日時の文字列から。タイムゾーンを変換しない）
String _clock(String takenAt) =>
    '${int.parse(takenAt.substring(11, 13))}:${takenAt.substring(14, 16)}';
