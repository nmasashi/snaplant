import 'package:flutter/material.dart';
import '../models/photo.dart';
import '../models/timeline.dart';
import '../services/api_service.dart';
import '../services/upload_queue.dart';
import '../theme/app_colors.dart';
import '../theme/app_text_styles.dart';
import '../utils/timeline_format.dart';
import '../widgets/timeline_confirm_dialog.dart';
import '../widgets/timeline_edit_sheet.dart';
import '../widgets/timeline_thumbnail.dart';
import 'photo_viewer_screen.dart';

/// 場面の写真の一覧（docs/03_screen_design.md §8.8）
///
/// 旅行詳細が読んだ完成版の場面をそのまま出す（開くときには読まない）。写真ビューアを閉じたら完成版を読み直し、
/// 同じ場面（最初の写真の id が同じもの）で描き直す。場面が無くなっていたら旅行詳細に戻る
class TimelineSceneScreen extends StatefulWidget {
  const TimelineSceneScreen(
      {super.key,
      required this.apiService,
      required this.uploadQueue,
      required this.tripId,
      required this.date,
      required this.scene});

  final ApiService apiService;

  /// 写真の送信の列（写真ビューアに渡す）
  final UploadQueue uploadQueue;
  final String tripId;

  /// 場面の日の日付（`YYYY-MM-DD`）。場面は最初の写真の id で探し直すので、日は変わらない（区切りの直しは日をまたがない）
  final String date;
  final TimelineScene scene;

  @override
  State<TimelineSceneScreen> createState() => _TimelineSceneScreenState();
}

class _TimelineSceneScreenState extends State<TimelineSceneScreen> {
  late TimelineScene _scene = widget.scene;

  // 写真を読んでいる間と読み直している間は、写真のタップを受け付けない（写真ビューアを重ねて開かない。
  // 読み直しの応答で、後から直した表示を古い状態に戻さない。§8.8）
  bool _busy = false;

  /// この画面が一番上に出ているか。戻る途中（閉じていく間）に届いた応答で、下の旅行詳細まで閉じたり、
  /// 閉じていく画面の上に写真ビューアを開いたりしない
  bool get _isShown => ModalRoute.of(context)?.isCurrent ?? false;

  /// 写真を読み、写真ビューアでその1枚を開く。閉じたら読み直す（ビューアで消した・直したことを出す。§8.8）
  Future<void> _openPhoto(TimelinePhoto photo) async {
    if (_busy) return;
    setState(() => _busy = true);
    Photo? loaded;
    try {
      loaded = await widget.apiService.getPhoto(photo.id);
    } catch (e) {
      debugPrint('TimelineSceneScreen: 写真の読み込みエラー: $e');
      if (!mounted) return;
      final messenger = ScaffoldMessenger.of(context);
      if (e is ApiException && e.isPhotoNotFound) {
        messenger.showSnackBar(const SnackBar(content: Text('この写真は削除されています')));
        await _reload();
        return;
      }
      messenger.showSnackBar(SnackBar(
          content: Text(e is ApiException ? e.userMessage : '写真の読み込みに失敗しました')));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
    if (!mounted || loaded == null || !_isShown) return;
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
    await _reload();
  }

  /// 完成版を読み直し、同じ場面で描き直す（[_showSceneOf]）。旅行が無いなら旅行詳細に戻る
  /// （旅行詳細が読み直して今の状態を出す）。それ以外の失敗は表示はそのままでエラーの文言を出す
  Future<void> _reload() async {
    setState(() => _busy = true);
    try {
      final overview = await widget.apiService.getTimeline(widget.tripId);
      if (!mounted) return;
      _showSceneOf(overview);
    } catch (e) {
      debugPrint('TimelineSceneScreen: タイムラインの読み込みエラー: $e');
      if (!mounted) return;
      if (e is ApiException && e.isTripNotFound) {
        if (_isShown) Navigator.pop(context);
        return;
      }
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content:
              Text(e is ApiException ? e.userMessage : 'タイムラインの読み込みに失敗しました')));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// 場面の見出しを直す（§8.5）。保存できたら応答の同じ場面で描き直す。タイムラインが変わった・旅行が無いなら
  /// 旅行詳細に戻る（旅行詳細が読み直して今の状態を出す。§8.8）
  Future<void> _editLabel() async {
    final result = await showTimelineEditSheet(
      context,
      title: '見出しを編集',
      fields: [
        TimelineEditField(
            key: 'label', label: '見出し', maxLength: 30, initial: _scene.label),
      ],
      // 区切りを直して足した場面は AI の見出しが無いので、空にすると見出しなしに戻る（5-5a）
      hint: '空にすると、AI が書いた見出しに戻ります（AI が書いていない場面は見出しなしになります）',
      onSave: (changes) => widget.apiService
          .updateTimelineScene(widget.tripId, _scene.startPhotoId, changes),
    );
    if (!mounted || result == null) return;
    if (result is TimelineOverview) {
      _showSceneOf(result);
      return;
    }
    // シートが閉じて返す失敗は、タイムラインが変わった・旅行が無いときだけ（ほかはシートの中に出す）
    _leaveBecauseChanged(result as ApiException);
  }

  /// 写真の長押しのメニュー（「タイムラインから外す」だけ。§8.8）
  Future<void> _showPhotoMenu(TimelinePhoto photo) async {
    final chosen = await showModalBottomSheet<bool>(
      context: context,
      builder: (context) => SafeArea(
        child: ListTile(
          leading: const Icon(Icons.hide_image_outlined),
          title: const Text('タイムラインから外す'),
          onTap: () => Navigator.pop(context, true),
        ),
      ),
    );
    if (chosen != true || !mounted) return;
    await _exclude(photo);
  }

  /// 確かめてから [photo] を完成版から外し、応答の同じ場面で描き直す（02 §5 #52。外した写真は戻せない）。
  /// タイムラインが変わった・旅行が無いなら旅行詳細に戻り、それ以外の失敗は文言を出して表示はそのまま（§8.8）
  Future<void> _exclude(TimelinePhoto photo) async {
    final confirmed = await confirmTimelineAction(context,
        title: 'タイムラインから外しますか？',
        message: '写真は旅行に残ります。外した写真は、タイムラインを作り直すまで戻せません。',
        confirmLabel: '外す');
    if (!confirmed || !mounted) return;
    setState(() => _busy = true);
    try {
      final overview = await widget.apiService
          .excludeCurrentTimelinePhotos(widget.tripId, [photo.id]);
      if (!mounted) return;
      _showSceneOf(overview);
    } catch (e) {
      debugPrint('TimelineSceneScreen: 写真を外すエラー: $e');
      if (!mounted) return;
      if (e is ApiException && (e.isTimelineChanged || e.isTripNotFound)) {
        _leaveBecauseChanged(e);
        return;
      }
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content:
              Text(e is ApiException ? e.userMessage : 'タイムラインの操作に失敗しました')));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// 見出しの保存・写真を外すときに、タイムラインが変わっていた（[e] の `isTimelineChanged`）・旅行が無かったので、旅行詳細に戻る
  /// （旅行詳細が読み直して今の状態を出す。旅行が無いときは旅行詳細が「この旅行は削除されています」にするので、ここでは知らせない。§8.8）
  void _leaveBecauseChanged(ApiException e) {
    if (!e.isTripNotFound) {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('タイムラインが変わりました。読み直しました')));
    }
    if (_isShown) Navigator.pop(context);
  }

  /// [overview] の完成版の、出している場面と最初の写真の id が同じ場面で描き直す。
  /// 完成版・場面が無ければ（写真を全部消した、作り直しが始まった）旅行詳細に戻る
  void _showSceneOf(TimelineOverview overview) {
    for (final day
        in overview.timeline?.current?.days ?? const <TimelineDay>[]) {
      for (final scene in day.scenes) {
        if (scene.startPhotoId == _scene.startPhotoId) {
          setState(() => _scene = scene);
          return;
        }
      }
    }
    if (_isShown) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    final scene = _scene;
    final details = [
      timelineTimeRange(scene.photos),
      if (scene.placeNames.isNotEmpty) scene.placeNames.join('、'),
      '${scene.photos.length}枚',
    ].join(' · ');
    return Scaffold(
      appBar: AppBar(
        title: Text(scene.label ?? '見出しなし'),
        actions: [
          IconButton(
            icon: const Icon(Icons.edit_outlined, semanticLabel: '見出しを編集'),
            tooltip: '見出しを編集',
            onPressed: _busy ? null : _editLabel,
          ),
        ],
      ),
      body: CustomScrollView(
        slivers: [
          SliverPadding(
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
            sliver: SliverToBoxAdapter(
              child: Text('${timelineDateLabel(widget.date)} $details',
                  style: AppTextStyles.body2
                      .copyWith(color: AppColors.textSecondary)),
            ),
          ),
          SliverPadding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
            sliver: SliverGrid.count(
              crossAxisCount: 3,
              mainAxisSpacing: 2,
              crossAxisSpacing: 2,
              children: [
                for (final photo in scene.photos)
                  TimelineThumbnail(
                      photo: photo,
                      onTap: _busy ? null : () => _openPhoto(photo),
                      onLongPress: _busy ? null : () => _showPhotoMenu(photo)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
