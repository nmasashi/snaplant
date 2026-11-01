import 'package:flutter/material.dart';
import '../models/photo.dart';
import '../models/trip.dart';
import '../services/api_service.dart';
import '../theme/app_colors.dart';

/// 撮影日時を手で付ける・変えるシート（docs/03_screen_design.md §5.8。D-2）
///
/// 撮影日時の無い写真なら「撮影日時を付ける」、手で付けた写真なら「撮影日時を変える」（「日時を消す」も置く）。
/// 日付と時刻を選んで保存すると、直した写真と知らせの文言を返して閉じる。保存できなければ留まって理由を出す（タグのシートと同じ）
class TakenAtSheet extends StatefulWidget {
  const TakenAtSheet(
      {super.key, required this.apiService, required this.photo});

  final ApiService apiService;
  final Photo photo;

  @override
  State<TakenAtSheet> createState() => _TakenAtSheetState();
}

class _TakenAtSheetState extends State<TakenAtSheet> {
  /// 付けるときの時刻の初期値（日付だけでは並べられないので、時刻も選ばせる。02 §5 #59 の (b)）
  static const _defaultTime = TimeOfDay(hour: 12, minute: 0);

  late final bool _changing = widget.photo.takenAt != null;
  late DateTime _date = _initialDate();
  late TimeOfDay _time = _initialTime();
  // 利用者が日付を選んだか（選んだ後は、旅行の期間が届いても初期値に戻さない）
  bool _datePicked = false;
  TripSummary? _trip;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadTrip();
  }

  /// 今の撮影日時か、送った日（端末の時刻）の日付
  DateTime _initialDate() {
    final takenAt = widget.photo.takenAt;
    if (takenAt != null) return DateTime.parse(takenAt.substring(0, 10));
    final uploadedAt = widget.photo.uploadedAt;
    final local = uploadedAt == null
        ? DateTime.now()
        : DateTime.parse(uploadedAt).toLocal();
    return DateTime(local.year, local.month, local.day);
  }

  TimeOfDay _initialTime() {
    final takenAt = widget.photo.takenAt;
    if (takenAt == null) return _defaultTime;
    return TimeOfDay(
        hour: int.parse(takenAt.substring(11, 13)),
        minute: int.parse(takenAt.substring(14, 16)));
  }

  /// 写真の旅行を読み、期間を手がかりに出す。付けるときは期間の初日を日付の初期値にする（読めなければ手がかりを出さない）
  Future<void> _loadTrip() async {
    final tripId = widget.photo.tripId;
    if (tripId == null) return;
    try {
      final trip = await widget.apiService.getTrip(tripId);
      if (!mounted) return;
      setState(() {
        _trip = trip;
        final first = trip.firstTakenAt;
        if (!_changing && !_datePicked && first != null) {
          _date = DateTime.parse(first.substring(0, 10));
        }
      });
    } catch (e) {
      debugPrint('TakenAtSheet: 旅行の読み込みエラー: $e');
    }
  }

  Future<void> _pickDate() async {
    final picked = await showDatePicker(
        context: context,
        initialDate: _date,
        firstDate: DateTime(1900),
        lastDate: DateTime(2100));
    if (picked == null || !mounted) return;
    setState(() {
      _date = picked;
      _datePicked = true;
    });
  }

  Future<void> _pickTime() async {
    final picked = await showTimePicker(context: context, initialTime: _time);
    if (picked == null || !mounted) return;
    setState(() => _time = picked);
  }

  /// [takenAt] を送る（null なら消す）。保存できたら直した写真と知らせの文言を返して閉じる
  Future<void> _send(String? takenAt, String done) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final photo =
          await widget.apiService.updatePhotoTakenAt(widget.photo.id, takenAt);
      if (mounted) Navigator.pop(context, (photo, done));
    } catch (e) {
      debugPrint('TakenAtSheet: 撮影日時の保存エラー: $e');
      if (mounted) {
        setState(() {
          _busy = false;
          _error = e is ApiException ? e.userMessage : '撮影日時の保存に失敗しました';
        });
      }
    }
  }

  String _two(int value) => value.toString().padLeft(2, '0');

  String get _takenAtValue =>
      '${_date.year}-${_two(_date.month)}-${_two(_date.day)}T${_two(_time.hour)}:${_two(_time.minute)}:00';

  /// 手がかりの文（旅行の期間と送った日時）
  List<String> get _hints {
    final hints = <String>[];
    final trip = _trip;
    if (trip != null && trip.firstTakenAt != null && trip.lastTakenAt != null) {
      String monthDay(String value) =>
          '${int.parse(value.substring(5, 7))}月${int.parse(value.substring(8, 10))}日';
      hints.add(
          '「${trip.name}」の期間は ${monthDay(trip.firstTakenAt!)}〜${monthDay(trip.lastTakenAt!)}です。');
    }
    final uploadedAt = widget.photo.uploadedAt;
    if (uploadedAt != null) {
      final local = DateTime.parse(uploadedAt).toLocal();
      hints.add(
          'この写真は ${local.month}月${local.day}日 ${_two(local.hour)}:${_two(local.minute)} に送りました。');
    }
    return hints;
  }

  @override
  Widget build(BuildContext context) {
    final hints = _hints;
    // 保存を待っている間は閉じない（閉じると、保存されたのに表示が古いまま残る。タグのシートと同じ）
    return PopScope(
      canPop: !_busy,
      child: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 16, 24, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(_changing ? '撮影日時を変える' : '撮影日時を付ける',
                  style: Theme.of(context).textTheme.titleLarge),
              const SizedBox(height: 16),
              Text('日付', style: Theme.of(context).textTheme.labelMedium),
              OutlinedButton(
                onPressed: _busy ? null : _pickDate,
                child: Text('${_date.year}年${_date.month}月${_date.day}日'),
              ),
              const SizedBox(height: 8),
              Text('時刻', style: Theme.of(context).textTheme.labelMedium),
              OutlinedButton(
                onPressed: _busy ? null : _pickTime,
                child: Text('${_two(_time.hour)}:${_two(_time.minute)}'),
              ),
              for (final hint in hints)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child:
                      Text(hint, style: Theme.of(context).textTheme.bodySmall),
                ),
              if (_changing)
                TextButton(
                  onPressed: _busy ? null : () => _send(null, '撮影日時を消しました'),
                  child: const Text('日時を消す（撮影日時なしに戻す）'),
                ),
              if (_error != null)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Text(_error!,
                      style: const TextStyle(color: AppColors.error)),
                ),
              const SizedBox(height: 8),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  TextButton(
                    onPressed: _busy ? null : () => Navigator.pop(context),
                    child: const Text('キャンセル'),
                  ),
                  const SizedBox(width: 8),
                  FilledButton(
                    onPressed: _busy
                        ? null
                        : () => _send(_takenAtValue,
                            _changing ? '撮影日時を変えました' : '撮影日時を付けました'),
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
