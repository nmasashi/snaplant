import 'dart:async';

import 'package:flutter/material.dart';
import '../models/trip.dart';
import '../services/api_service.dart';
import '../services/upload_queue.dart';
import '../theme/app_colors.dart';
import '../theme/app_text_styles.dart';
import '../utils/photo_category.dart';
import '../utils/trip_period.dart';
import '../widgets/add_photos_button.dart';
import '../widgets/message_view.dart';
import '../widgets/photo_grid.dart';
import '../widgets/photo_selection.dart';
import '../widgets/photo_selection_scaffold.dart';
import '../widgets/trip_delete_dialog.dart';
import '../widgets/trip_edit_dialog.dart';
import '../widgets/trip_timeline_view.dart';
import '../widgets/upload_banner.dart';

/// 旅行詳細画面（docs/03_screen_design.md §4.4）
///
/// 開くたびに旅行を取り直す（一覧から渡された値は使わない。一覧を読んだ後に写真が増減しうるため）
class TripDetailScreen extends StatefulWidget {
  const TripDetailScreen(
      {super.key,
      required this.apiService,
      required this.uploadQueue,
      required this.tripId});

  final ApiService apiService;

  /// 写真の送信の列（AppRoot が持つ）
  final UploadQueue uploadQueue;
  final String tripId;

  @override
  State<TripDetailScreen> createState() => _TripDetailScreenState();
}

class _TripDetailScreenState extends State<TripDetailScreen> {
  TripSummary? _trip;
  // 旅行が既に無い（一覧を読んだ後に別の端末で消された）
  bool _tripDeleted = false;
  // 旅行の取得を出すたびに進める。取り直しが重なったとき、最後に出した取得の結果だけを使う
  int _tripRequest = 0;
  // 読み込みに失敗したときの文言（旅行が無い場合を除く）。null なら失敗していない
  String? _errorMessage;
  // 写真の複数選択（見出し・下の操作バー・グリッドが見る）
  final _selection = PhotoSelection();
  // 写真の一覧を先頭から読み直すたびに進める（グリッドの key にして作り直す）
  int _gridVersion = 0;
  // 「タイムライン」を出している（グリッドを隠している）間に写真の一覧が変わりうることがあった。「写真」に戻したときに読み直す（§8.1）
  bool _photosStale = false;
  // チップで選んだカテゴリ。「すべて」なら null。画面を開き直すと「すべて」に戻る（§5.3）
  String? _category;
  // 「タイムライン」を出しているか（切り替え。§8.1）。画面を開き直すと「写真」に戻る
  bool _showsTimeline = false;
  // 「タイムライン」が上のバーのメニューに足す項目（§8.3）。タイムラインの表示が描くたびに入れ、メニューを開くときに読む
  TimelineMenu? _timelineMenu;
  StreamSubscription<UploadBatchResult>? _uploadFinished;

  @override
  void dispose() {
    _uploadFinished?.cancel();
    _selection.dispose();
    super.dispose();
  }

  @override
  void initState() {
    super.initState();
    _loadTrip();
    // 送信が一区切りついて、この旅行宛ての写真が送れていたら、一覧と見出しの枚数を読み直す
    _uploadFinished = widget.uploadQueue.finished
        .where((result) => result.tripIds.contains(widget.tripId))
        .listen((_) => _reloadPhotos());
  }

  /// 旅行（枚数・撮影期間つき）を読み込む。
  /// [keepOnFailure] なら、取り直しの失敗（旅行が無い場合を除く）で画面をエラーにせず、前の見出しを残す
  Future<void> _loadTrip({bool keepOnFailure = false}) async {
    final request = ++_tripRequest;
    setState(() => _errorMessage = null);
    try {
      final trip = await widget.apiService.getTrip(widget.tripId);
      // 待っている間に、写真の一覧の側で旅行が無いと分かっていたら、遅れて届いた成功で旅行名を戻さない
      if (!mounted || _tripDeleted) return;
      // 後から出した取得がある。先に出したこの取得の結果（古い枚数・期間）では上書きしない
      if (request != _tripRequest) return;
      setState(() => _trip = trip);
    } catch (e) {
      debugPrint('TripDetailScreen: 旅行の読み込みエラー: $e');
      if (!mounted) return;
      if (e is ApiException && e.isTripNotFound) {
        _markTripDeleted();
        return;
      }
      // 後から出した取得がある。先に出したこの取得の失敗で、その結果をエラーの表示に置き換えない
      // （旅行が無い 404 は、どの取得で分かっても事実なので、上で先に扱う）
      if (request != _tripRequest) return;
      if (keepOnFailure && _trip != null) return;
      setState(() =>
          _errorMessage = e is ApiException ? e.userMessage : '旅行の読み込みに失敗しました');
    }
  }

  /// 旅行が既に無いと分かった（旅行の取得でも写真の一覧でも）。
  /// 取り直しで分かった場合も、古い旅行名と編集・削除のメニュー、写真の選択を残さない（選択中は戻るが1回目で止まるため）
  void _markTripDeleted() {
    _selection.clear();
    // 上に写真ビューアなどが開いていれば閉じる（グリッドを外すので、ビューアから頼まれる続きの読み込みや削除の反映を受けられない）
    final route = ModalRoute.of(context);
    if (route != null && !route.isCurrent) {
      Navigator.popUntil(context, (r) => r == route);
    }
    setState(() {
      _tripDeleted = true;
      _trip = null;
    });
  }

  /// 旅行名とメモを編集する。保存できたら旅行を取り直してタイトルに反映する
  Future<void> _editTrip(TripSummary trip) async {
    final updated = await showDialog<bool>(
      context: context,
      builder: (context) => TripEditDialog.edit(
        name: trip.name,
        description: trip.description,
        onSave: (name, description) =>
            widget.apiService.updateTrip(trip.id, name, description),
      ),
    );
    if (updated != true || !mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(const SnackBar(content: Text('旅行を更新しました')));
    await _loadTrip();
  }

  /// 旅行を削除する（中の写真をどうするかはダイアログで選ぶ）。削除できたら前の画面に戻る
  Future<void> _deleteTrip(TripSummary trip) async {
    // 送信中の写真があれば、削除のダイアログの前に送信を止めてよいか確かめる
    if (widget.uploadQueue.isActiveFor(trip.id)) {
      final proceed = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          content: const Text('送信中の写真があります。送信を止めて削除しますか？'),
          actions: [
            TextButton(
                onPressed: () => Navigator.pop(context),
                child: const Text('キャンセル')),
            ElevatedButton(
                onPressed: () => Navigator.pop(context, true),
                child: const Text('削除')),
          ],
        ),
      );
      if (proceed != true || !mounted) return;
    }
    final result = await showDialog<TripDeleteResult>(
      context: context,
      builder: (context) => TripDeleteDialog(
        tripName: trip.name,
        photoCount: trip.photoCount,
        onDelete: (deletePhotos) {
          // 削除を確定したら、この旅行宛ての送信を取り消してから消す（消した旅行へ送り続けない）
          widget.uploadQueue.cancelTrip(trip.id);
          // 取り消しは、その時点の写真（準備中・送信待ち・送信中・失敗）だけに効く。削除が失敗しても、この後に追加した写真は送る
          return widget.apiService
              .deleteTrip(trip.id, deletePhotos: deletePhotos);
        },
      ),
    );
    if (result == null || !mounted) return;
    // 画面を閉じた後も残るよう、閉じる前に ScaffoldMessenger を取っておく
    final messenger = ScaffoldMessenger.of(context);
    Navigator.pop(context);
    messenger.showSnackBar(SnackBar(content: Text(_deletedMessage(result))));
  }

  /// 選んだ写真を移した・消した後に、写真の一覧と見出しの枚数を読み直す。
  /// 見出しを取り直せなくても前の値のまま出す（操作は済んで知らせも出ているので、画面をエラーで置き換えない）
  ///
  /// 「タイムライン」を出している間は一覧を読まずに印だけ付け、「写真」に戻したときに読み直す（§8.1）
  Future<void> _reloadPhotos() async {
    if (_showsTimeline) {
      _photosStale = true;
    } else {
      setState(() => _gridVersion++);
    }
    await _loadTrip(keepOnFailure: true);
  }

  /// 削除の知らせ。写真を消したか移したかは応答の枚数で分かる（0枚の旅行ならどちらも 0）
  String _deletedMessage(TripDeleteResult result) {
    if (result.deletedPhotoCount > 0) {
      return '旅行を削除しました（写真${result.deletedPhotoCount}枚を削除）';
    }
    if (result.detachedPhotoCount > 0) {
      return '旅行を削除しました（写真${result.detachedPhotoCount}枚は「旅行に属さない写真」に移しました）';
    }
    return '旅行を削除しました';
  }

  @override
  Widget build(BuildContext context) {
    final trip = _trip;
    return PhotoSelectionScaffold(
      apiService: widget.apiService,
      selection: _selection,
      currentTripId: widget.tripId,
      appBar: _buildAppBar(trip),
      body: _buildBody(trip),
      onPhotosChanged: _reloadPhotos,
      floatingActionButton: trip == null || _showsTimeline
          ? null
          : AddPhotosButton(
              uploadQueue: widget.uploadQueue, tripId: widget.tripId),
    );
  }

  PreferredSizeWidget _buildAppBar(TripSummary? trip) {
    return AppBar(
      title: Text(trip?.name ?? '', style: AppTextStyles.appBarTitle),
      actions: [
        if (trip != null && _errorMessage == null)
          PopupMenuButton<void>(
            icon: const Icon(Icons.more_vert),
            itemBuilder: (context) => [
              // 「タイムライン」を開いていて完成版があるときだけ、タイムラインの項目を上に足す（§8.1・§8.3）
              ..._timelineMenuItems(),
              PopupMenuItem(
                  onTap: () => _editTrip(trip), child: const Text('旅行を編集')),
              PopupMenuItem(
                  onTap: () => _deleteTrip(trip), child: const Text('旅行を削除')),
            ],
          ),
      ],
    );
  }

  /// 上のバーのメニューのタイムラインの項目（「タイムラインを編集」「タイムラインを作り直す」と区切り線）。出さないときは空
  List<PopupMenuEntry<void>> _timelineMenuItems() {
    final menu = _showsTimeline ? _timelineMenu : null;
    if (menu == null) return const [];
    final pending = menu.pendingPhotoCount;
    return [
      PopupMenuItem(
          enabled: menu.onEdit != null,
          onTap: menu.onEdit,
          child: const Text('タイムラインを編集')),
      PopupMenuItem(
        enabled: menu.onRebuild != null,
        onTap: menu.onRebuild,
        child: pending > 0
            ? Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('タイムラインを作り直す'),
                  Text('解析中の写真があと $pending 枚',
                      style: AppTextStyles.caption
                          .copyWith(color: AppColors.textSecondary)),
                ],
              )
            : const Text('タイムラインを作り直す'),
      ),
      const PopupMenuDivider(),
    ];
  }

  /// この旅行宛ての写真だけを数える送信の進み具合バナー
  Widget _uploadBanner() => UploadBanner(
      uploadQueue: widget.uploadQueue,
      includes: (tripId) => tripId == widget.tripId);

  /// 「写真」「タイムライン」の切り替え（§8.1）。
  /// 選択モードの間は出さない（選択モードは「写真」の中だけ。切り替えるとグリッドが隠れ、選んだ写真が見えなくなるため）
  Widget _buildViewSwitch() {
    return ListenableBuilder(
      listenable: _selection,
      builder: (context, _) {
        if (_selection.isActive) return const SizedBox.shrink();
        return Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
          child: SegmentedButton<bool>(
            segments: const [
              ButtonSegment(value: false, label: Text('写真')),
              ButtonSegment(value: true, label: Text('タイムライン')),
            ],
            selected: {_showsTimeline},
            showSelectedIcon: false,
            onSelectionChanged: (selected) => setState(() {
              _showsTimeline = selected.single;
              if (!_showsTimeline && _photosStale) {
                _photosStale = false;
                _gridVersion++;
              }
              // 前に開いていたタイムラインの項目を残さない（開き直したタイムラインが読めたら入れ直す）
              _timelineMenu = null;
            }),
          ),
        );
      },
    );
  }

  /// カテゴリのチップ（すべて・植物・食べ物・風景・その他。§5.3）。1つだけ選べ、選ぶと一覧を先頭から取り直す。
  /// 選択モードの間は出さない（チップを変えると一覧が変わり、選んだ写真が見えなくなるため）
  Widget _buildCategoryChips() {
    return ListenableBuilder(
      listenable: _selection,
      builder: (context, _) {
        if (_selection.isActive) return const SizedBox.shrink();
        return SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: Row(
            children: [
              for (final category in [null, ...photoCategories])
                Padding(
                  padding: const EdgeInsets.only(right: 8),
                  child: ChoiceChip(
                    label: Text(
                        category == null ? 'すべて' : categoryLabel(category)),
                    selected: _category == category,
                    onSelected: (_) {
                      if (_category == category) return;
                      setState(() {
                        _category = category;
                        _gridVersion++;
                      });
                    },
                  ),
                ),
            ],
          ),
        );
      },
    );
  }

  Widget _buildBody(TripSummary? trip) {
    if (_tripDeleted) {
      // この旅行宛ての送信の失敗は「閉じる」で片付けられるように、バナーは出したままにする
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _uploadBanner(),
          const Expanded(child: Center(child: Text('この旅行は削除されています'))),
        ],
      );
    }
    final errorMessage = _errorMessage;
    if (errorMessage != null) {
      return MessageView(
        isLargeScreen: MediaQuery.of(context).size.width >= 1400,
        icon: Icons.error_outline,
        title: 'エラーが発生しました',
        message: errorMessage,
        buttonIcon: Icons.refresh,
        buttonLabel: '再試行',
        onPressed: _loadTrip,
        isError: true,
      );
    }
    if (trip == null) {
      return const Center(child: CircularProgressIndicator());
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.all(16),
          child: Text(
            '${trip.photoCount}枚 · ${formatTripPeriod(trip.firstTakenAt, trip.lastTakenAt)}',
            style: AppTextStyles.body1,
          ),
        ),
        _uploadBanner(),
        _buildViewSwitch(),
        if (!_showsTimeline) _buildCategoryChips(),
        Expanded(
          child: Stack(
            fit: StackFit.expand,
            children: [
              // 「タイムライン」を出している間もグリッドは隠して残す（戻ってもスクロールの位置と読み込んだページのまま。§8.1）
              Offstage(
                offstage: _showsTimeline,
                child: TickerMode(
                  enabled: !_showsTimeline,
                  child: PhotoGrid(
                    key: ValueKey(_gridVersion),
                    apiService: widget.apiService,
                    uploadQueue: widget.uploadQueue,
                    tripId: trip.id,
                    category: _category,
                    dayOneTakenAt: trip.firstTakenAt,
                    // 見出しを取り直せなくても前の値のまま、写真の一覧は読み直す
                    onRefresh: () => _loadTrip(keepOnFailure: true),
                    selection: _selection,
                    emptyTitle: _category == null
                        ? 'まだ写真がありません'
                        : 'この旅行に${categoryLabel(_category!)}の写真はありません',
                    emptyMessage:
                        _category == null ? '「写真を追加」からギャラリーの写真を送りましょう' : null,
                    onTripNotFound: _markTripDeleted,
                    onViewerClosed: _reloadPhotos,
                  ),
                ),
              ),
              if (_showsTimeline)
                TripTimelineView(
                  apiService: widget.apiService,
                  uploadQueue: widget.uploadQueue,
                  tripId: trip.id,
                  onTripNotFound: _markTripDeleted,
                  onMenuChanged: (menu) => _timelineMenu = menu,
                  onSceneClosed: _reloadPhotos,
                ),
            ],
          ),
        ),
      ],
    );
  }
}
