import 'package:flutter/material.dart';
import '../models/photo.dart';
import '../models/trip.dart';
import '../services/api_service.dart';
import '../theme/app_text_styles.dart';
import '../utils/trip_period.dart';
import '../widgets/confirm_action_dialog.dart';
import '../widgets/message_view.dart';
import '../widgets/photo_grid.dart';
import '../widgets/photo_selection.dart';
import '../widgets/trip_delete_dialog.dart';
import '../widgets/trip_edit_dialog.dart';
import '../widgets/trip_picker_dialog.dart';

/// 旅行詳細画面（docs/travel-album/03_screen_design.md §4.4）
///
/// 開くたびに旅行を取り直す（一覧から渡された値は使わない。一覧を読んだ後に写真が増減しうるため）
class TripDetailScreen extends StatefulWidget {
  const TripDetailScreen(
      {super.key, required this.apiService, required this.tripId});

  final ApiService apiService;
  final String tripId;

  @override
  State<TripDetailScreen> createState() => _TripDetailScreenState();
}

class _TripDetailScreenState extends State<TripDetailScreen> {
  TripSummary? _trip;
  // 旅行が既に無い（一覧を読んだ後に別の端末で消された）
  bool _tripDeleted = false;
  // 読み込みに失敗したときの文言（旅行が無い場合を除く）。null なら失敗していない
  String? _errorMessage;
  // 写真の複数選択（見出し・下の操作バー・グリッドが見る）
  final _selection = PhotoSelection();
  // 写真の一覧を先頭から読み直すたびに進める（グリッドの key にして作り直す）
  int _gridVersion = 0;

  @override
  void dispose() {
    _selection.dispose();
    super.dispose();
  }

  @override
  void initState() {
    super.initState();
    _loadTrip();
  }

  /// 旅行（枚数・撮影期間つき）を読み込む
  Future<void> _loadTrip() async {
    setState(() => _errorMessage = null);
    try {
      final trip = await widget.apiService.getTrip(widget.tripId);
      if (!mounted) return;
      setState(() => _trip = trip);
    } catch (e) {
      debugPrint('TripDetailScreen: 旅行の読み込みエラー: $e');
      if (!mounted) return;
      if (e is ApiException && e.isTripNotFound) {
        // 取り直しで分かった場合も、古い旅行名と編集・削除のメニューを残さない
        setState(() {
          _tripDeleted = true;
          _trip = null;
        });
        return;
      }
      setState(() =>
          _errorMessage = e is ApiException ? e.userMessage : '旅行の読み込みに失敗しました');
    }
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
    final result = await showDialog<TripDeleteResult>(
      context: context,
      builder: (context) => TripDeleteDialog(
        tripName: trip.name,
        photoCount: trip.photoCount,
        onDelete: (deletePhotos) =>
            widget.apiService.deleteTrip(trip.id, deletePhotos: deletePhotos),
      ),
    );
    if (result == null || !mounted) return;
    // 画面を閉じた後も残るよう、閉じる前に ScaffoldMessenger を取っておく
    final messenger = ScaffoldMessenger.of(context);
    Navigator.pop(context);
    messenger.showSnackBar(SnackBar(content: Text(_deletedMessage(result))));
  }

  /// 選んだ写真を別の旅行に入れる。入れたら選択を解除し、写真の一覧と見出しの枚数を読み直す
  Future<void> _moveToTrip() async {
    final photoIds = _selection.selectedIds;
    final moved = await showDialog<({String tripName, PhotoMoveResult result})>(
      context: context,
      builder: (context) => TripPickerDialog(
        apiService: widget.apiService,
        excludeTripId: widget.tripId,
        onMove: (tripId) => widget.apiService.movePhotos(photoIds, tripId),
      ),
    );
    if (moved == null || !mounted) return;
    await _finishMove(moved.result,
        '${moved.result.moved.length}枚を「${moved.tripName}」に入れました');
  }

  /// 選んだ写真を旅行から外す（旅行に属さない写真に移す）。確認してから送る
  Future<void> _removeFromTrip() async {
    final photoIds = _selection.selectedIds;
    final result = await showDialog<PhotoMoveResult>(
      context: context,
      builder: (context) => ConfirmActionDialog<PhotoMoveResult>(
        title: '旅行から外す',
        message: '${photoIds.length}枚を旅行から外しますか？\n写真は「旅行に属さない写真」に移ります。',
        confirmLabel: '外す',
        failureMessage: '写真の移動に失敗しました',
        onConfirm: () => widget.apiService.movePhotos(photoIds, null),
      ),
    );
    if (result == null || !mounted) return;
    await _finishMove(result, '${result.moved.length}枚を旅行から外しました');
  }

  /// 写真を移した後の知らせと読み直し。見つからなかった写真があれば知らせに足す
  Future<void> _finishMove(PhotoMoveResult result, String message) async {
    final notFound = result.notFound.length;
    await _finishSelectionAction(
        '$message${notFound > 0 ? '（$notFound枚は見つかりませんでした）' : ''}');
  }

  /// 選んだ写真を消す。確認してから1枚ずつ送る
  Future<void> _deletePhotos() async {
    final photoIds = _selection.selectedIds;
    final deleted = await showDialog<int>(
      context: context,
      builder: (context) => ConfirmActionDialog<int>(
        title: '写真を削除',
        message: '${photoIds.length}枚の写真を削除しますか？\nこの操作は元に戻せません。',
        confirmLabel: '削除',
        failureMessage: '写真の削除に失敗しました',
        onConfirm: () async {
          for (final photoId in photoIds) {
            await widget.apiService.deletePhoto(photoId);
          }
          return photoIds.length;
        },
      ),
    );
    if (deleted == null || !mounted) return;
    await _finishSelectionAction('$deleted枚を削除しました');
  }

  /// 選んだ写真への操作の後の知らせと読み直し。選択を解除し、写真の一覧と見出しの枚数を読み直す
  Future<void> _finishSelectionAction(String message) async {
    // 押し直す前の失敗の知らせが出ていれば閉じる（並んで待たせると、成功の後も古い失敗がしばらく残る）
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message)));
    _selection.clear();
    setState(() => _gridVersion++);
    await _loadTrip();
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
    return ListenableBuilder(
      listenable: _selection,
      // 選択モード中の戻る操作は、画面を閉じずに選択モードを抜ける（§4.8）
      builder: (context, _) => PopScope(
        canPop: !_selection.isActive,
        onPopInvokedWithResult: (didPop, result) {
          if (!didPop) _selection.clear();
        },
        child: Scaffold(
          appBar: _selection.isActive
              ? _buildSelectionAppBar()
              : _buildAppBar(trip),
          body: _buildBody(trip),
          bottomNavigationBar:
              _selection.isActive ? _buildSelectionActions() : null,
        ),
      ),
    );
  }

  /// 選択モードの見出し（閉じる・枚数・すべて選択）
  PreferredSizeWidget _buildSelectionAppBar() {
    return AppBar(
      leading: IconButton(
        icon: const Icon(Icons.close),
        tooltip: '選択をやめる',
        onPressed: _selection.clear,
      ),
      title: Text('${_selection.count}枚を選択中', style: AppTextStyles.appBarTitle),
      actions: [
        TextButton(onPressed: _selection.selectAll, child: const Text('すべて選択')),
      ],
    );
  }

  /// 選択モードの下の操作バー
  Widget _buildSelectionActions() {
    // 1枚も選んでいなければ押せない
    final enabled = _selection.count > 0;
    return SafeArea(
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceEvenly,
        children: [
          TextButton.icon(
              onPressed: enabled ? _moveToTrip : null,
              icon: const Icon(Icons.drive_file_move_outline),
              label: const Text('旅行に入れる')),
          TextButton.icon(
              onPressed: enabled ? _removeFromTrip : null,
              icon: const Icon(Icons.remove_circle_outline),
              label: const Text('旅行から外す')),
          TextButton.icon(
              onPressed: enabled ? _deletePhotos : null,
              icon: const Icon(Icons.delete_outline),
              label: const Text('削除')),
        ],
      ),
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
              PopupMenuItem(
                  onTap: () => _editTrip(trip), child: const Text('編集')),
              PopupMenuItem(
                  onTap: () => _deleteTrip(trip), child: const Text('削除')),
            ],
          ),
      ],
    );
  }

  Widget _buildBody(TripSummary? trip) {
    if (_tripDeleted) {
      return const Center(child: Text('この旅行は削除されています'));
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
        Expanded(
          child: PhotoGrid(
            key: ValueKey(_gridVersion),
            apiService: widget.apiService,
            tripId: trip.id,
            selection: _selection,
            emptyTitle: 'まだ写真がありません',
            emptyMessage: '「写真を追加」からギャラリーの写真を送りましょう',
          ),
        ),
      ],
    );
  }
}
