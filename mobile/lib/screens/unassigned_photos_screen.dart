import 'package:flutter/material.dart';
import '../services/api_service.dart';
import '../theme/app_text_styles.dart';
import '../widgets/photo_grid.dart';
import '../widgets/photo_selection.dart';
import '../widgets/photo_selection_scaffold.dart';

/// 旅行に属さない写真の画面（docs/travel-album/03_screen_design.md §4.5）
///
/// 旅行詳細と同じ部品で、旅行ではないので編集・削除のメニューは無く、期間も出さない
class UnassignedPhotosScreen extends StatefulWidget {
  const UnassignedPhotosScreen(
      {super.key, required this.apiService, required this.photoCount});

  final ApiService apiService;

  /// 旅行一覧（GET /api/trips）の unassignedPhotoCount。開いたときはこれを出す
  final int photoCount;

  @override
  State<UnassignedPhotosScreen> createState() => _UnassignedPhotosScreenState();
}

class _UnassignedPhotosScreenState extends State<UnassignedPhotosScreen> {
  late int _photoCount = widget.photoCount;
  // 写真の複数選択（見出し・下の操作バー・グリッドが見る）
  final _selection = PhotoSelection();
  // 写真の一覧を先頭から読み直すたびに進める（グリッドの key にして作り直す）
  int _gridVersion = 0;

  @override
  void dispose() {
    _selection.dispose();
    super.dispose();
  }

  /// 選んだ写真を移した・消した後に、写真の一覧と枚数を読み直す。
  /// 枚数を返す API は旅行一覧だけなので、それを取り直す。
  /// 取り直せなければ枚数は前の値のまま（操作の知らせは出ているので、失敗の知らせは足さない）
  Future<void> _reloadPhotos() async {
    setState(() => _gridVersion++);
    try {
      final list = await widget.apiService.getTrips();
      if (!mounted) return;
      setState(() => _photoCount = list.unassignedPhotoCount);
    } catch (e) {
      debugPrint('UnassignedPhotosScreen: 枚数の取り直しエラー: $e');
    }
  }

  @override
  Widget build(BuildContext context) {
    return PhotoSelectionScaffold(
      apiService: widget.apiService,
      selection: _selection,
      currentTripId: null,
      appBar: AppBar(
        title: const Text('旅行に属さない写真', style: AppTextStyles.appBarTitle),
      ),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.all(16),
            child: Text('$_photoCount枚', style: AppTextStyles.body1),
          ),
          Expanded(
            child: PhotoGrid(
              key: ValueKey(_gridVersion),
              apiService: widget.apiService,
              tripId: 'none',
              selection: _selection,
              emptyTitle: '旅行に属さない写真はありません',
              emptyMessage: '「写真を追加」で送った写真は、あとから旅行に入れられます',
            ),
          ),
        ],
      ),
      onPhotosChanged: _reloadPhotos,
    );
  }
}
