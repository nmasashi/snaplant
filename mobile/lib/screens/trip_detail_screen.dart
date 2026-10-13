import 'package:flutter/material.dart';
import '../models/trip.dart';
import '../services/api_service.dart';
import '../theme/app_text_styles.dart';
import '../utils/trip_period.dart';
import '../widgets/message_view.dart';
import '../widgets/photo_grid.dart';
import '../widgets/photo_selection.dart';
import '../widgets/trip_delete_dialog.dart';
import '../widgets/trip_edit_dialog.dart';

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
      builder: (context, _) => Scaffold(
        appBar:
            _selection.isActive ? _buildSelectionAppBar() : _buildAppBar(trip),
        body: _buildBody(trip),
        bottomNavigationBar:
            _selection.isActive ? _buildSelectionActions() : null,
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
        TextButton(onPressed: () {}, child: const Text('すべて選択')),
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
              onPressed: enabled ? () {} : null,
              icon: const Icon(Icons.drive_file_move_outline),
              label: const Text('旅行に入れる')),
          TextButton.icon(
              onPressed: enabled ? () {} : null,
              icon: const Icon(Icons.remove_circle_outline),
              label: const Text('旅行から外す')),
          TextButton.icon(
              onPressed: enabled ? () {} : null,
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
