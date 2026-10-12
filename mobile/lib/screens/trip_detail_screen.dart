import 'package:flutter/material.dart';
import '../models/trip.dart';
import '../services/api_service.dart';
import '../theme/app_text_styles.dart';
import '../utils/trip_period.dart';
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

  @override
  void initState() {
    super.initState();
    _loadTrip();
  }

  /// 旅行（枚数・撮影期間つき）を読み込む
  Future<void> _loadTrip() async {
    try {
      final trip = await widget.apiService.getTrip(widget.tripId);
      if (!mounted) return;
      setState(() => _trip = trip);
    } catch (e) {
      debugPrint('TripDetailScreen: 旅行の読み込みエラー: $e');
      if (!mounted) return;
      if (e is ApiException && e.isTripNotFound) {
        setState(() => _tripDeleted = true);
      }
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
    return Scaffold(
      appBar: AppBar(
        title: Text(trip?.name ?? '', style: AppTextStyles.appBarTitle),
        actions: [
          if (trip != null)
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
      ),
      body: _tripDeleted
          ? const Center(child: Text('この旅行は削除されています'))
          : trip == null
              ? const Center(child: CircularProgressIndicator())
              : Padding(
                  padding: const EdgeInsets.all(16),
                  child: Text(
                    '${trip.photoCount}枚 · ${formatTripPeriod(trip.firstTakenAt, trip.lastTakenAt)}',
                    style: AppTextStyles.body1,
                  ),
                ),
    );
  }
}
