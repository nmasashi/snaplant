import 'package:flutter/material.dart';
import '../services/api_service.dart';
import '../services/upload_queue.dart';
import '../theme/app_text_styles.dart';
import '../utils/photo_category.dart';
import '../widgets/photo_grid.dart';
import '../widgets/photo_selection.dart';
import '../widgets/photo_selection_scaffold.dart';

/// カテゴリの一覧の画面（docs/travel-album/03_screen_design.md §5.2）
///
/// 旅行一覧の「カテゴリ」から開く。カテゴリを選ぶと、旅行をまたいでそのカテゴリの写真を出す
class CategoryListScreen extends StatelessWidget {
  const CategoryListScreen(
      {super.key, required this.apiService, required this.uploadQueue});

  final ApiService apiService;
  final UploadQueue uploadQueue;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar:
          AppBar(title: const Text('カテゴリ', style: AppTextStyles.appBarTitle)),
      body: ListView(
        children: [
          for (final category in photoCategories)
            ListTile(
              title: Text(categoryLabel(category)),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => Navigator.push(
                context,
                MaterialPageRoute(
                  builder: (context) => CategoryPhotosScreen(
                      apiService: apiService,
                      uploadQueue: uploadQueue,
                      category: category),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// カテゴリの写真の画面（docs/travel-album/03_screen_design.md §5.2）
///
/// 旅行をまたいで、そのカテゴリの写真を並べる。どの旅行に送るかが決まらないので「写真を追加」は置かず、
/// 複数選択の操作は「削除」だけ
class CategoryPhotosScreen extends StatefulWidget {
  const CategoryPhotosScreen(
      {super.key,
      required this.apiService,
      required this.uploadQueue,
      required this.category});

  final ApiService apiService;

  /// 写真の送信の列（グリッドが要る。カテゴリの画面では送信中の写真は並べない）
  final UploadQueue uploadQueue;

  /// カテゴリのキー（`plant` / `food` / `landscape` / `other`）
  final String category;

  @override
  State<CategoryPhotosScreen> createState() => _CategoryPhotosScreenState();
}

class _CategoryPhotosScreenState extends State<CategoryPhotosScreen> {
  final _selection = PhotoSelection();
  // 写真の一覧を先頭から読み直すたびに進める（グリッドの key にして作り直す）
  int _gridVersion = 0;

  @override
  void dispose() {
    _selection.dispose();
    super.dispose();
  }

  Future<void> _reloadPhotos() async => setState(() => _gridVersion++);

  @override
  Widget build(BuildContext context) {
    final label = categoryLabel(widget.category);
    return PhotoSelectionScaffold(
      apiService: widget.apiService,
      selection: _selection,
      currentTripId: null,
      allowMove: false,
      appBar: AppBar(title: Text(label, style: AppTextStyles.appBarTitle)),
      body: PhotoGrid(
        key: ValueKey(_gridVersion),
        apiService: widget.apiService,
        uploadQueue: widget.uploadQueue,
        tripId: null,
        category: widget.category,
        selection: _selection,
        emptyTitle: '$labelの写真はありません',
        emptyMessage: '分類が済んだ写真が、ここに並びます',
        onViewerClosed: _reloadPhotos,
      ),
      onPhotosChanged: _reloadPhotos,
    );
  }
}
