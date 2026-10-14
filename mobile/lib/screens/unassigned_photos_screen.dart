import 'dart:async';

import 'package:flutter/material.dart';
import '../services/api_service.dart';
import '../services/upload_queue.dart';
import '../theme/app_text_styles.dart';
import '../widgets/add_photos_button.dart';
import '../widgets/photo_grid.dart';
import '../widgets/photo_selection.dart';
import '../widgets/photo_selection_scaffold.dart';
import '../widgets/upload_banner.dart';

/// 旅行に属さない写真の画面（docs/travel-album/03_screen_design.md §4.5）
///
/// 旅行詳細と同じ部品で、旅行ではないので編集・削除のメニューは無く、期間も出さない
class UnassignedPhotosScreen extends StatefulWidget {
  const UnassignedPhotosScreen(
      {super.key,
      required this.apiService,
      required this.uploadQueue,
      required this.photoCount});

  final ApiService apiService;

  /// 写真の送信の列（AppRoot が持つ）
  final UploadQueue uploadQueue;

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
  StreamSubscription<UploadBatchResult>? _uploadFinished;

  @override
  void initState() {
    super.initState();
    // 送信が一区切りついて、旅行を指定せずに送った写真が送れていたら、一覧と枚数を読み直す
    _uploadFinished = widget.uploadQueue.finished
        .where((result) => result.tripIds.contains(null))
        .listen((_) => _reloadPhotos());
  }

  @override
  void dispose() {
    _uploadFinished?.cancel();
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
          // 旅行を指定せずに送った写真だけを数える
          UploadBanner(
              uploadQueue: widget.uploadQueue,
              includes: (item) => item.tripId == null),
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
      floatingActionButton:
          AddPhotosButton(uploadQueue: widget.uploadQueue, tripId: null),
    );
  }
}
