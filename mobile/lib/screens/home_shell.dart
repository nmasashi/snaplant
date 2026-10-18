import 'package:flutter/material.dart';
import '../services/api_service.dart';
import '../services/upload_queue.dart';
import 'catalog_screen.dart';
import 'plant_list_screen.dart';
import 'trip_list_screen.dart';

/// ホーム（下のタブ: 図鑑 / 旅行 / 図鑑（新））
///
/// 起動時は図鑑（既存の初期画面を変えない）。IndexedStack で、タブを切り替えても各タブの画面の状態
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

  /// 設定画面を開く（両方のタブの設定ボタンから）
  final Future<void> Function() onOpenSettings;

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _selectedIndex = 0;

  /// 図鑑（新）のタブを開いたか。開くまでは画面を作らない（アプリの起動時に図鑑の API を呼ばない。03 §6.1）
  bool _catalogOpened = false;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: IndexedStack(
        index: _selectedIndex,
        children: [
          PlantListScreen(
              apiService: widget.apiService,
              onOpenSettings: widget.onOpenSettings),
          TripListScreen(
              apiService: widget.apiService,
              uploadQueue: widget.uploadQueue,
              onOpenSettings: widget.onOpenSettings),
          if (_catalogOpened)
            CatalogScreen(
                apiService: widget.apiService,
                onOpenSettings: widget.onOpenSettings)
          else
            const SizedBox.shrink(),
        ],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _selectedIndex,
        onDestinationSelected: (index) => setState(() {
          _selectedIndex = index;
          if (index == 2) _catalogOpened = true;
        }),
        destinations: const [
          NavigationDestination(
              icon: Icon(Icons.eco_outlined),
              selectedIcon: Icon(Icons.eco),
              label: '図鑑'),
          NavigationDestination(
              icon: Icon(Icons.luggage_outlined),
              selectedIcon: Icon(Icons.luggage),
              label: '旅行'),
          // 植物図鑑から移す（4-5）までの一時的なタブ（02 §5 #31）
          NavigationDestination(
              icon: Icon(Icons.menu_book_outlined),
              selectedIcon: Icon(Icons.menu_book),
              label: '図鑑（新）'),
        ],
      ),
    );
  }
}
