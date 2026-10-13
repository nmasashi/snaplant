import 'package:flutter/foundation.dart';

/// 写真のグリッドの複数選択（docs/travel-album/03_screen_design.md §4.8）
///
/// 選択の状態は、画面の見出し・下の操作バーと、グリッドの印にまたがるので、画面が1つ作って [PhotoGrid] に渡し、両方がこれを見る
class PhotoSelection extends ChangeNotifier {
  final Set<String> _selectedIds = {};
  bool _isActive = false;

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

  /// 選択モードを抜ける（選んだ写真も外す）
  void clear() {
    _isActive = false;
    _selectedIds.clear();
    notifyListeners();
  }
}
