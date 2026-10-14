import 'package:flutter/material.dart';
import '../models/photo.dart';
import '../services/api_service.dart';
import '../theme/app_colors.dart';
import '../theme/app_text_styles.dart';
import 'confirm_action_dialog.dart';
import 'photo_selection.dart';
import 'trip_picker_dialog.dart';

/// 写真のグリッドを持つ画面の骨組み。複数選択のモード（docs/travel-album/03_screen_design.md §4.8）を受け持つ
///
/// 選択モード中は、見出しを選んだ枚数に、下に操作バー（旅行に入れる・旅行から外す・削除）を出し、
/// 端末の戻る操作では画面を閉じずに選択モードを抜ける。旅行詳細と旅行に属さない写真の画面が使う
class PhotoSelectionScaffold extends StatelessWidget {
  const PhotoSelectionScaffold(
      {super.key,
      required this.apiService,
      required this.selection,
      required this.currentTripId,
      required this.appBar,
      required this.body,
      required this.onPhotosChanged,
      this.floatingActionButton});

  final ApiService apiService;
  final PhotoSelection selection;

  /// 今いる旅行の id。旅行に属さない写真の画面なら null（「旅行から外す」を出さず、入れる先にすべての旅行を出す）
  final String? currentTripId;

  /// 選択モードでないときの見出し
  final PreferredSizeWidget appBar;

  final Widget body;

  /// 選択モードでないときに右下に浮かぶボタン（「写真を追加」）
  final Widget? floatingActionButton;

  /// 選んだ写真を移した・消した後に呼ぶ。画面は写真の一覧と見出しの枚数を読み直す
  final Future<void> Function() onPhotosChanged;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: selection,
      // 選択モード中の戻る操作は、画面を閉じずに選択モードを抜ける（§4.8）
      builder: (context, _) => PopScope(
        canPop: !selection.isActive,
        onPopInvokedWithResult: (didPop, result) {
          if (!didPop) selection.clear();
        },
        child: Scaffold(
          appBar: selection.isActive ? _buildSelectionAppBar() : appBar,
          body: body,
          floatingActionButton:
              selection.isActive ? null : floatingActionButton,
          bottomNavigationBar:
              selection.isActive ? _buildSelectionActions(context) : null,
        ),
      ),
    );
  }

  /// 選択モードの見出し（閉じる・枚数・すべて選択）
  PreferredSizeWidget _buildSelectionAppBar() {
    return AppBar(
      leading: IconButton(
        icon: const Icon(Icons.close),
        tooltip: '選択をやめる',
        onPressed: selection.clear,
      ),
      title: Text('${selection.count}枚を選択中', style: AppTextStyles.appBarTitle),
      actions: [
        // テーマの文字ボタンは主色の文字で、見出しの背景（主色）と同じになり読めないので、見出しの前景色にする
        TextButton(
            onPressed: selection.selectAll,
            style:
                TextButton.styleFrom(foregroundColor: AppColors.textOnPrimary),
            child: const Text('すべて選択')),
      ],
    );
  }

  /// 選択モードの下の操作バー
  Widget _buildSelectionActions(BuildContext context) {
    // 1枚も選んでいなければ押せない
    final enabled = selection.count > 0;
    return SafeArea(
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceEvenly,
        children: [
          TextButton.icon(
              onPressed: enabled ? () => _moveToTrip(context) : null,
              icon: const Icon(Icons.drive_file_move_outline),
              label: const Text('旅行に入れる')),
          if (currentTripId != null)
            TextButton.icon(
                onPressed: enabled ? () => _removeFromTrip(context) : null,
                icon: const Icon(Icons.remove_circle_outline),
                label: const Text('旅行から外す')),
          TextButton.icon(
              onPressed: enabled ? () => _deletePhotos(context) : null,
              icon: const Icon(Icons.delete_outline),
              label: const Text('削除')),
        ],
      ),
    );
  }

  /// 選んだ写真を別の旅行に入れる
  Future<void> _moveToTrip(BuildContext context) async {
    final photoIds = selection.selectedIds;
    final moved = await showDialog<({String tripName, PhotoMoveResult result})>(
      context: context,
      builder: (context) => TripPickerDialog(
        apiService: apiService,
        excludeTripId: currentTripId,
        onMove: (tripId) => apiService.movePhotos(photoIds, tripId),
      ),
    );
    if (moved == null || !context.mounted) return;
    await _finishMove(context, moved.result,
        '${moved.result.moved.length}枚を「${moved.tripName}」に入れました');
  }

  /// 選んだ写真を旅行から外す（旅行に属さない写真に移す）。確認してから送る
  Future<void> _removeFromTrip(BuildContext context) async {
    final photoIds = selection.selectedIds;
    final result = await showDialog<PhotoMoveResult>(
      context: context,
      builder: (context) => ConfirmActionDialog<PhotoMoveResult>(
        title: '旅行から外す',
        message: '${photoIds.length}枚を旅行から外しますか？\n写真は「旅行に属さない写真」に移ります。',
        confirmLabel: '外す',
        busyLabel: '外しています...',
        failureMessage: '写真の移動に失敗しました',
        onConfirm: () => apiService.movePhotos(photoIds, null),
      ),
    );
    if (result == null || !context.mounted) return;
    await _finishMove(context, result, '${result.moved.length}枚を旅行から外しました');
  }

  /// 写真を移した後の知らせと読み直し。見つからなかった写真があれば知らせに足す
  Future<void> _finishMove(
      BuildContext context, PhotoMoveResult result, String message) async {
    final notFound = result.notFound.length;
    await _finishSelectionAction(
        context, '$message${notFound > 0 ? '（$notFound枚は見つかりませんでした）' : ''}');
  }

  /// 選んだ写真を消す。確認してから1枚ずつ送る
  Future<void> _deletePhotos(BuildContext context) async {
    final photoIds = selection.selectedIds;
    final failed = await showDialog<int>(
      context: context,
      builder: (context) => ConfirmActionDialog<int>(
        title: '写真を削除',
        message: '${photoIds.length}枚の写真を削除しますか？\nこの操作は元に戻せません。',
        confirmLabel: '削除',
        busyLabel: '削除中...',
        // _deleteEach は失敗を投げずに数えて返すので、この文言は出ない（全部が失敗しても「0枚を削除しました（N枚は…）」で閉じる）
        failureMessage: '写真の削除に失敗しました',
        onConfirm: () => _deleteEach(photoIds),
      ),
    );
    if (failed == null || !context.mounted) return;
    final deleted = photoIds.length - failed;
    await _finishSelectionAction(
        context,
        failed > 0
            ? '$deleted枚を削除しました（$failed枚は削除できませんでした）'
            : '$deleted枚を削除しました');
  }

  /// 写真を1枚ずつ消し、消せなかった枚数を返す。1枚が失敗しても残りは続ける。
  /// 既に無い写真（別の端末で消されたなど）は、消したいという目的が果たせているので消せたと数える
  Future<int> _deleteEach(List<String> photoIds) async {
    var failed = 0;
    for (final photoId in photoIds) {
      try {
        await apiService.deletePhoto(photoId);
      } catch (e) {
        if (e is ApiException && e.isPhotoNotFound) continue;
        debugPrint('PhotoSelectionScaffold: 写真の削除エラー: $e');
        failed++;
      }
    }
    return failed;
  }

  /// 選んだ写真への操作の後の知らせと読み直し。選択を解除し、画面に読み直させる
  Future<void> _finishSelectionAction(
      BuildContext context, String message) async {
    // 押し直す前の失敗の知らせが出ていれば閉じる（並んで待たせると、成功の後も古い失敗がしばらく残る）
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message)));
    selection.clear();
    await onPhotosChanged();
  }
}
