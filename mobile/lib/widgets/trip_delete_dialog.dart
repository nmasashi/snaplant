import 'package:flutter/material.dart';
import '../models/trip.dart';

/// 旅行の削除の確認ダイアログ（docs/travel-album/03_screen_design.md §4.4「削除」）
///
/// 中の写真を残すか消すかを利用者に選ばせる。既定は「写真は残す」（誤操作で写真が消えないように）。
/// 削除できたら結果を返して閉じる。削除の処理は呼び出し側が [onDelete] で渡す
class TripDeleteDialog extends StatefulWidget {
  const TripDeleteDialog(
      {super.key,
      required this.tripName,
      required this.photoCount,
      required this.onDelete});

  final String tripName;
  final int photoCount;

  /// 旅行を削除する。[deletePhotos] が true なら中の写真も消す
  final Future<TripDeleteResult> Function(bool deletePhotos) onDelete;

  @override
  State<TripDeleteDialog> createState() => _TripDeleteDialogState();
}

class _TripDeleteDialogState extends State<TripDeleteDialog> {
  bool _deletePhotos = false;

  Future<void> _delete() async {
    final result = await widget.onDelete(_deletePhotos);
    if (!mounted) return;
    Navigator.pop(context, result);
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('旅行を削除'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('「${widget.tripName}」を削除します。\n'
                '中の写真${widget.photoCount}枚はどうしますか？'),
            const SizedBox(height: 8),
            RadioListTile<bool>(
              value: false,
              groupValue: _deletePhotos,
              onChanged: (value) => setState(() => _deletePhotos = value!),
              title: const Text('写真は残す'),
              subtitle: const Text('「旅行に属さない写真」に移ります'),
              contentPadding: EdgeInsets.zero,
            ),
            RadioListTile<bool>(
              value: true,
              groupValue: _deletePhotos,
              onChanged: (value) => setState(() => _deletePhotos = value!),
              title: const Text('写真も削除する'),
              subtitle: const Text('この操作は元に戻せません'),
              contentPadding: EdgeInsets.zero,
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('キャンセル'),
        ),
        ElevatedButton(onPressed: _delete, child: const Text('削除')),
      ],
    );
  }
}
