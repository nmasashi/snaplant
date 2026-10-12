import 'package:flutter/material.dart';
import '../models/trip.dart';
import '../services/api_service.dart';
import '../theme/app_colors.dart';
import '../theme/app_text_styles.dart';
import '../utils/trip_period.dart';
import 'trip_detail_screen.dart';
import '../widgets/message_view.dart';
import '../widgets/trip_edit_dialog.dart';

/// 旅行一覧画面（旅行タブ。docs/travel-album/03_screen_design.md §4.2）
///
/// 先頭に「旅行に属さない写真」の行を固定で置き、その下に旅行をサーバが返す順（作成日時の降順）で並べる
class TripListScreen extends StatefulWidget {
  const TripListScreen(
      {super.key, required this.apiService, required this.onOpenSettings});

  /// 設定済みの API クライアント（AppRoot が持つ）
  final ApiService apiService;

  /// 設定画面を開く
  final Future<void> Function() onOpenSettings;

  @override
  State<TripListScreen> createState() => _TripListScreenState();
}

class _TripListScreenState extends State<TripListScreen> {
  TripList? _tripList;
  // 読み込みに失敗したときの文言。null なら失敗していない
  String? _errorMessage;

  @override
  void initState() {
    super.initState();
    _loadTrips();
  }

  /// 旅行一覧（と旅行に属さない写真の枚数）を読み込む
  Future<void> _loadTrips() async {
    // 読み直しの間は今の一覧を出したままにする（詳細から戻るたびにスピナーに戻すと、スクロール位置も失う）
    setState(() => _errorMessage = null);
    try {
      final tripList = await widget.apiService.getTrips();
      if (!mounted) return;
      setState(() => _tripList = tripList);
    } catch (e) {
      debugPrint('TripListScreen: 旅行一覧読み込みエラー: $e');
      if (!mounted) return;
      setState(() => _errorMessage =
          e is ApiException ? e.userMessage : '旅行一覧の読み込みに失敗しました');
    }
  }

  /// 旅行詳細画面を開く
  Future<void> _openTrip(TripSummary trip) async {
    await Navigator.push(
      context,
      MaterialPageRoute(
        builder: (context) =>
            TripDetailScreen(apiService: widget.apiService, tripId: trip.id),
      ),
    );
    // 詳細で編集・削除しうるので、戻ったら読み直す
    if (!mounted) return;
    await _loadTrips();
  }

  /// 旅行の作成ダイアログを開く
  Future<void> _openCreateDialog() async {
    final created = await showDialog<bool>(
      context: context,
      builder: (context) => TripEditDialog(
        onSave: (name, description) =>
            widget.apiService.createTrip(name, description),
      ),
    );
    if (created != true || !mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(const SnackBar(content: Text('旅行を作成しました')));
    await _loadTrips();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('旅行', style: AppTextStyles.appBarTitle),
        actions: [
          IconButton(
              icon: const Icon(Icons.settings),
              onPressed: widget.onOpenSettings,
              tooltip: '設定'),
        ],
      ),
      body: _buildBody(),
      floatingActionButton: FloatingActionButton.extended(
        // 図鑑タブの FAB と同時に存在する（IndexedStack）。既定のタグのままだと画面遷移の Hero が重複する
        heroTag: 'createTrip',
        onPressed: _openCreateDialog,
        icon: const Icon(Icons.add),
        label: const Text('旅行を作る'),
        backgroundColor: AppColors.secondary,
        foregroundColor: AppColors.textOnPrimary,
      ),
    );
  }

  Widget _buildBody() {
    final errorMessage = _errorMessage;
    if (errorMessage != null) {
      return MessageView(
        isLargeScreen: MediaQuery.of(context).size.width >= 1400,
        icon: Icons.error_outline,
        title: 'エラーが発生しました',
        message: errorMessage,
        buttonIcon: Icons.refresh,
        buttonLabel: '再試行',
        onPressed: _loadTrips,
        isError: true,
      );
    }
    final tripList = _tripList;
    if (tripList == null) {
      return const Center(child: CircularProgressIndicator());
    }
    return ListView(
      padding: const EdgeInsets.symmetric(vertical: 8),
      children: [
        _TripRow(
          icon: Icons.photo_library_outlined,
          title: '旅行に属さない写真',
          subtitle: '${tripList.unassignedPhotoCount}枚',
        ),
        if (tripList.trips.isEmpty) const _NoTripsMessage(),
        for (final trip in tripList.trips)
          _TripRow(
            icon: Icons.luggage_outlined,
            title: trip.name,
            subtitle:
                '${trip.photoCount}枚 · ${formatTripPeriod(trip.firstTakenAt, trip.lastTakenAt)}',
            onTap: () => _openTrip(trip),
          ),
      ],
    );
  }
}

/// 旅行が0件のときの案内（先頭の行の下に出す）
class _NoTripsMessage extends StatelessWidget {
  const _NoTripsMessage();

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 48),
      child: Column(
        children: [
          const Icon(Icons.luggage_outlined,
              size: 96, color: AppColors.textHint),
          const SizedBox(height: 24),
          Text(
            'まだ旅行がありません',
            style: AppTextStyles.headline2
                .copyWith(color: AppColors.textSecondary),
          ),
          const SizedBox(height: 12),
          Text(
            '「旅行を作る」から最初の旅行を作りましょう',
            style: AppTextStyles.body1.copyWith(color: AppColors.textSecondary),
            textAlign: TextAlign.center,
          ),
        ],
      ),
    );
  }
}

/// 旅行一覧の1行（先頭の「旅行に属さない写真」と各旅行で共通）
class _TripRow extends StatelessWidget {
  const _TripRow(
      {required this.icon,
      required this.title,
      required this.subtitle,
      this.onTap});

  final IconData icon;
  final String title;
  final String subtitle;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      child: ListTile(
        leading: Icon(icon, size: 40, color: AppColors.primary),
        title: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis),
        subtitle: Text(subtitle),
        trailing: const Icon(Icons.chevron_right),
        onTap: onTap,
      ),
    );
  }
}
