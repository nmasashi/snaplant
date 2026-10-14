import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

import '../services/upload_queue.dart';

/// 「写真を追加」（docs/travel-album/03_screen_design.md §4.7「写真を選ぶ」）
///
/// ギャラリーで複数の写真を選ばせ、送信の列に入れる。旅行詳細と旅行に属さない写真の画面の右下に浮かぶ
class AddPhotosButton extends StatelessWidget {
  const AddPhotosButton(
      {super.key, required this.uploadQueue, required this.tripId});

  final UploadQueue uploadQueue;

  /// 送り先の旅行。null なら旅行に属さない写真として送る
  final String? tripId;

  Future<void> _addPhotos(BuildContext context) async {
    try {
      final files = await ImagePicker()
          .pickMultiImage(imageQuality: 85, maxWidth: 1920, maxHeight: 1920);
      if (files.isEmpty) return;
      await uploadQueue.addFiles(files, tripId: tripId);
    } catch (e) {
      debugPrint('AddPhotosButton: 画像の読み込みエラー: $e');
      if (!context.mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('画像の読み込みに失敗しました')));
    }
  }

  @override
  Widget build(BuildContext context) {
    return FloatingActionButton.extended(
      onPressed: () => _addPhotos(context),
      icon: const Icon(Icons.add_photo_alternate_outlined),
      label: const Text('写真を追加'),
    );
  }
}
