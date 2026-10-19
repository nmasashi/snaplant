import 'package:flutter/material.dart';
import '../services/api_service.dart';
import '../services/upload_queue.dart';
import 'catalog_screen.dart';
import 'trip_list_screen.dart';

/// ホーム（下のタブ: 図鑑 / 旅行）
///
/// 起動時は図鑑。IndexedStack で、タブを切り替えても各タブの画面の状態
/// （スクロール位置、読み込んだ一覧）を保つ（docs/travel-album/03_screen_design.md §4.1）
class HomeShell extends StatefulWidget {
  const HomeShell(
      {super.key,
      required this.apiService,
      required this.uploadQueue,
      required this.onOpenSettings});

  /// 設定済みの API クライアント（AppRoot が持つ）
  final ApiService apiService;

  /// 写真の送信の列（AppRoot が持つ）
  final UploadQueue uploadQueue;

  /// 設定画面を開く（各タブの設定ボタンから）
  final Future<void> Function() onOpenSettings;

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _selectedIndex = 0;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: IndexedStack(
        index: _selectedIndex,
        children: [
          CatalogScreen(
              apiService: widget.apiService,
              uploadQueue: widget.uploadQueue,
              onOpenSettings: widget.onOpenSettings),
          TripListScreen(
              apiService: widget.apiService,
              uploadQueue: widget.uploadQueue,
              onOpenSettings: widget.onOpenSettings),
        ],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _selectedIndex,
        onDestinationSelected: (index) =>
            setState(() => _selectedIndex = index),
        destinations: const [
          NavigationDestination(
              icon: Icon(Icons.menu_book_outlined),
              selectedIcon: Icon(Icons.menu_book),
              label: '図鑑'),
          NavigationDestination(
              icon: Icon(Icons.luggage_outlined),
              selectedIcon: Icon(Icons.luggage),
              label: '旅行'),
        ],
      ),
    );
  }
}
