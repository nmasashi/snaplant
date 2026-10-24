import 'package:flutter/foundation.dart';

/// 写真のグリッドの複数選択（docs/03_screen_design.md §4.8）
///
/// 選択の状態は、画面の見出し・下の操作バーと、グリッドの印にまたがるので、画面が1つ作って [PhotoGrid] に渡し、両方がこれを見る
class PhotoSelection extends ChangeNotifier {
  final Set<String> _selectedIds = {};
  bool _isActive = false;
  // グリッドが読み込んだ写真の id（「表示中をすべて選択」で選ぶ範囲。ページで読むので、まだ読んでいない続きは入らない）
  List<String> _loadedIds = const [];

  /// 選択モードに入っているか（0枚を選んだ状態でも、抜けるまでは選択モード）
  bool get isActive => _isActive;

  /// 選んだ写真の id（選んだ順）
  List<String> get selectedIds => List.unmodifiable(_selectedIds);

  int get count => _selectedIds.length;

  bool isSelected(String photoId) => _selectedIds.contains(photoId);

  /// 長押しした写真を選んで、選択モードに入る
  void start(String photoId) {
    _isActive = true;
    _selectedIds.add(photoId);
    notifyListeners();
  }

  /// 選択モード中のタップで、選択を切り替える（0枚になっても選択モードのまま）
  void toggle(String photoId) {
    if (!_selectedIds.remove(photoId)) {
      _selectedIds.add(photoId);
    }
    notifyListeners();
  }

  /// グリッドが読み込んだ写真を知らせる（描くたびに呼ばれる。見た目は変わらないので通知しない）
  void updateLoaded(List<String> photoIds) {
    _loadedIds = photoIds;
  }

  /// 読み込んだ写真をすべて選ぶ
  void selectAll() {
    _selectedIds.addAll(_loadedIds);
    notifyListeners();
  }

  /// 選択モードを抜ける（選んだ写真も外す）
  void clear() {
    _isActive = false;
    _selectedIds.clear();
    notifyListeners();
  }
}
