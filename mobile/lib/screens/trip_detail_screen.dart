import 'package:flutter/material.dart';
import '../models/trip.dart';
import '../services/api_service.dart';
import '../theme/app_text_styles.dart';
import '../utils/trip_period.dart';

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

  @override
  Widget build(BuildContext context) {
    final trip = _trip;
    return Scaffold(
      appBar: AppBar(
        title: Text(trip?.name ?? '', style: AppTextStyles.appBarTitle),
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
