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
    messenger.showSnackBar(SnackBar(
        content: Text(
            '旅行を削除しました（写真${result.detachedPhotoCount}枚は「旅行に属さない写真」に移しました）')));
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
      body: trip == null
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
