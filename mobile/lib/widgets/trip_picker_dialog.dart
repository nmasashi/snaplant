import 'package:flutter/material.dart';
import '../models/photo.dart';
import '../models/trip.dart';
import '../services/api_service.dart';
import 'trip_edit_dialog.dart';

/// 選んだ写真を入れる旅行を選ぶダイアログ（docs/03_screen_design.md §4.8「旅行に入れる」）
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
  // 旅行の一覧の読み込みに失敗したときの文言。null なら失敗していない
  String? _errorMessage;
  // 移している間は押せなくし、閉じさせない（二重に送らないように。閉じても要求は送られたままになる）
  bool _isMoving = false;

  @override
  void initState() {
    super.initState();
    _loadTrips();
  }

  Future<void> _loadTrips() async {
    setState(() => _errorMessage = null);
    try {
      final list = await widget.apiService.getTrips();
      if (!mounted) return;
      setState(() => _trips =
          list.trips.where((trip) => trip.id != widget.excludeTripId).toList());
    } catch (e) {
      debugPrint('TripPickerDialog: 旅行一覧の読み込みエラー: $e');
      if (!mounted) return;
      setState(() => _errorMessage =
          e is ApiException ? e.userMessage : '旅行一覧の読み込みに失敗しました');
    }
  }

  Future<void> _move(TripSummary trip) async {
    PhotoMoveResult result;
    setState(() => _isMoving = true);
    try {
      result = await widget.onMove(trip.id);
    } catch (e) {
      debugPrint('TripPickerDialog: 写真の移動エラー: $e');
      if (!mounted) return;
      setState(() => _isMoving = false);
      // ダイアログに留まる（選択も残るので、そのまま押し直せる。送れた分は移っているが、送り直しても同じ結果になる）
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(e is ApiException ? e.userMessage : '写真の移動に失敗しました')));
      return;
    }
    if (!mounted) return;
    Navigator.pop(context, (tripName: trip.name, result: result));
  }

  /// 旅行の作成ダイアログ（§4.3）を重ねて開き、作った旅行を一覧の先頭に足して選ぶ
  /// （`GET /api/trips` は作成日時の新しい順なので、取り直しても先頭に来る）
  Future<void> _createTrip() async {
    Trip? created;
    final saved = await showDialog<bool>(
      context: context,
      builder: (context) => TripEditDialog(
        onSave: (name, description) async {
          created = await widget.apiService.createTrip(name, description);
        },
      ),
    );
    final trip = created;
    if (saved != true || trip == null || !mounted) return;
    final summary = TripSummary(
        id: trip.id,
        name: trip.name,
        description: trip.description,
        photoCount: 0);
    setState(() {
      _trips = [summary, ...?_trips];
      _selected = summary;
    });
  }

  @override
  Widget build(BuildContext context) {
    final trips = _trips;
    final selected = _selected;
    final errorMessage = _errorMessage;
    return PopScope(
      canPop: !_isMoving,
      child: AlertDialog(
        title: const Text('旅行を選ぶ'),
        content: errorMessage != null
            ? Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(errorMessage),
                  const SizedBox(height: 8),
                  TextButton.icon(
                    onPressed: _loadTrips,
                    icon: const Icon(Icons.refresh),
                    label: const Text('再試行'),
                  ),
                ],
              )
            : trips == null
                ? const SizedBox(
                    height: 80,
                    child: Center(child: CircularProgressIndicator()))
                : SingleChildScrollView(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        for (final trip in trips)
                          RadioListTile<String>(
                            value: trip.id,
                            groupValue: selected?.id,
                            onChanged: _isMoving
                                ? null
                                : (_) => setState(() => _selected = trip),
                            title: Text(trip.name),
                            secondary: Text('${trip.photoCount}枚'),
                            contentPadding: EdgeInsets.zero,
                          ),
                        TextButton.icon(
                          // 移している間に作成ダイアログを重ねると、移し終えて閉じるときに上の作成ダイアログを閉じてしまう
                          onPressed: _isMoving ? null : _createTrip,
                          icon: const Icon(Icons.add),
                          label: const Text('新しい旅行を作る'),
                        ),
                      ],
                    ),
                  ),
        actions: [
          TextButton(
            onPressed: _isMoving ? null : () => Navigator.pop(context),
            child: const Text('キャンセル'),
          ),
          ElevatedButton(
            onPressed:
                selected == null || _isMoving ? null : () => _move(selected),
            child: Text(_isMoving ? '入れています...' : '入れる'),
          ),
        ],
      ),
    );
  }
}
