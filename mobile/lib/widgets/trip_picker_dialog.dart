import 'package:flutter/material.dart';
import '../models/photo.dart';
import '../models/trip.dart';
import '../services/api_service.dart';

/// 選んだ写真を入れる旅行を選ぶダイアログ（docs/travel-album/03_screen_design.md §4.8「旅行に入れる」）
///
/// 開くたびに旅行の一覧を取り直し、[excludeTripId]（今いる旅行）を除いて並べる。
/// 移せたら旅行名と結果を返して閉じる。移す処理は呼び出し側が [onMove] で渡す
class TripPickerDialog extends StatefulWidget {
  const TripPickerDialog(
      {super.key,
      required this.apiService,
      required this.excludeTripId,
      required this.onMove});

  final ApiService apiService;

  /// 並べない旅行の id（今いる旅行）。旅行に属さない写真の画面なら null
  final String? excludeTripId;

  /// 選んだ旅行に写真を移す
  final Future<PhotoMoveResult> Function(String tripId) onMove;

  @override
  State<TripPickerDialog> createState() => _TripPickerDialogState();
}

class _TripPickerDialogState extends State<TripPickerDialog> {
  List<TripSummary>? _trips;
  TripSummary? _selected;

  @override
  void initState() {
    super.initState();
    _loadTrips();
  }

  Future<void> _loadTrips() async {
    final list = await widget.apiService.getTrips();
    if (!mounted) return;
    setState(() => _trips =
        list.trips.where((trip) => trip.id != widget.excludeTripId).toList());
  }

  Future<void> _move(TripSummary trip) async {
    PhotoMoveResult result;
    try {
      result = await widget.onMove(trip.id);
    } catch (e) {
      debugPrint('TripPickerDialog: 写真の移動エラー: $e');
      if (!mounted) return;
      // ダイアログに留まる（選択も残るので、そのまま押し直せる。送れた分は移っているが、送り直しても同じ結果になる）
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(e is ApiException ? e.userMessage : '写真の移動に失敗しました')));
      return;
    }
    if (!mounted) return;
    Navigator.pop(context, (tripName: trip.name, result: result));
  }

  @override
  Widget build(BuildContext context) {
    final trips = _trips;
    final selected = _selected;
    return AlertDialog(
      title: const Text('旅行を選ぶ'),
      content: trips == null
          ? const SizedBox(
              height: 80, child: Center(child: CircularProgressIndicator()))
          : SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  for (final trip in trips)
                    RadioListTile<String>(
                      value: trip.id,
                      groupValue: selected?.id,
                      onChanged: (_) => setState(() => _selected = trip),
                      title: Text(trip.name),
                      secondary: Text('${trip.photoCount}枚'),
                      contentPadding: EdgeInsets.zero,
                    ),
                ],
              ),
            ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('キャンセル'),
        ),
        ElevatedButton(
          onPressed: selected == null ? null : () => _move(selected),
          child: const Text('入れる'),
        ),
      ],
    );
  }
}
