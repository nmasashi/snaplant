import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

import '../services/upload_queue.dart';

/// 「写真を追加」（docs/travel-album/03_screen_design.md §4.7「写真を選ぶ」）
///
/// ギャラリーで複数の写真を選ばせ、送信の列に入れる。旅行詳細と旅行に属さない写真の画面の右下に浮かぶ
class AddPhotosButton extends StatefulWidget {
  const AddPhotosButton(
      {super.key, required this.uploadQueue, required this.tripId});

  final UploadQueue uploadQueue;

  /// 送り先の旅行。null なら旅行に属さない写真として送る
  final String? tripId;

  @override
  State<AddPhotosButton> createState() => _AddPhotosButtonState();
}

class _AddPhotosButtonState extends State<AddPhotosButton> {
  // 選ぶ画面を開いてから写真を受け取るまで。写真を選ぶ部品は1枚ずつ縮小してから返すので、
  // 数百枚では受け取るまで数分かかる。その間に何も出ないと止まったように見える
  bool _picking = false;

  Future<void> _addPhotos() async {
    setState(() => _picking = true);
    try {
      final List<XFile> files;
      try {
        files = await ImagePicker()
            .pickMultiImage(imageQuality: 85, maxWidth: 1920, maxHeight: 1920);
      } finally {
        if (mounted) setState(() => _picking = false);
      }
      if (files.isEmpty) return;
      await widget.uploadQueue.addFiles(files, tripId: widget.tripId);
    } catch (e) {
      debugPrint('AddPhotosButton: 画像の読み込みエラー: $e');
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('画像の読み込みに失敗しました')));
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_picking) {
      // 押せない（二重に選ぶ画面を開かない）
      return const FloatingActionButton.extended(
        onPressed: null,
        icon: SizedBox(
            width: 20,
            height: 20,
            child: CircularProgressIndicator(strokeWidth: 2)),
        label: Text('写真を読み込み中...'),
      );
    }
    return FloatingActionButton.extended(
      onPressed: _addPhotos,
      icon: const Icon(Icons.add_photo_alternate_outlined),
      label: const Text('写真を追加'),
    );
  }
}
