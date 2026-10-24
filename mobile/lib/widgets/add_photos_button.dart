import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

import '../services/upload_queue.dart';
import '../theme/app_colors.dart';

/// 「写真を追加」（docs/03_screen_design.md §4.7「写真を選ぶ」）
///
/// ギャラリーで複数の写真を選ばせ、送信の列に入れる。旅行詳細と旅行に属さない写真の画面の右下に浮かぶ
class AddPhotosButton extends StatelessWidget {
  const AddPhotosButton(
      {super.key, required this.uploadQueue, required this.tripId});

  final UploadQueue uploadQueue;

  /// 送り先の旅行。null なら旅行に属さない写真として送る
  final String? tripId;

  Future<void> _addPhotos(BuildContext context) async {
    // 待っている間に選択モードでボタンが外れても知らせを出せるよう、画面の ScaffoldMessenger を先に取っておく
    final messenger = ScaffoldMessenger.of(context);
    // 写真を選ぶ部品は1枚ずつ縮小してから返すので、300枚では受け取るまで10分ほどかかる。
    // その間は「写真を読み込み中...」にして押せなくする（待ちの状態は送信の列が持つ。ボタンは選択モードで外れるため）
    uploadQueue.setPicking(tripId, true);
    try {
      final List<XFile> files;
      try {
        files = await ImagePicker()
            .pickMultiImage(imageQuality: 85, maxWidth: 1920, maxHeight: 1920);
      } finally {
        uploadQueue.setPicking(tripId, false);
      }
      if (files.isEmpty) return;
      await uploadQueue.addFiles(files, tripId: tripId);
    } catch (e) {
      debugPrint('AddPhotosButton: 画像の読み込みエラー: $e');
      messenger.showSnackBar(const SnackBar(content: Text('画像の読み込みに失敗しました')));
    }
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: uploadQueue,
      builder: (context, _) {
        if (uploadQueue.isPicking(tripId)) {
          // 押せない（二重に選ぶ画面を開かない）
          // 押せないことが見て分かるよう、灰色にする（onPressed が null でも、浮かぶボタンは色が変わらない）
          return const FloatingActionButton.extended(
            onPressed: null,
            backgroundColor: AppColors.surfaceVariant,
            foregroundColor: AppColors.textSecondary,
            icon: SizedBox(
                width: 20,
                height: 20,
                child: CircularProgressIndicator(strokeWidth: 2)),
            label: Text('写真を読み込み中...'),
          );
        }
        return FloatingActionButton.extended(
          onPressed: () => _addPhotos(context),
          icon: const Icon(Icons.add_photo_alternate_outlined),
          label: const Text('写真を追加'),
        );
      },
    );
  }
}
