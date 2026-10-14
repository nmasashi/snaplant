import 'dart:async';
import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:image_picker/image_picker.dart';

import '../utils/photo_metadata.dart';
import 'api_service.dart';

/// 送る写真1枚
class UploadItem {
  UploadItem(
      {required this.photoId,
      required this.bytes,
      this.tripId,
      this.metadata = PhotoMetadata.none});

  /// 画像のバイト列の SHA-256（16進・小文字）。同じ写真を何度送っても1枚になる
  final String photoId;
  final Uint8List bytes;

  /// 送り先の旅行。null なら旅行に属さない写真
  final String? tripId;

  /// EXIF から読んだ撮影日時と位置
  final PhotoMetadata metadata;
}

/// 写真の送信の列（docs/travel-album/03_screen_design.md §4.7）
///
/// 送信は画面を移っても続くので、画面ではなく AppRoot が1つ持ち、各画面に渡す（§1「状態の持ち方」）
class UploadQueue extends ChangeNotifier {
  UploadQueue(this._apiService);

  final ApiService _apiService;

  /// 同時に送る数（docs/travel-album/02_design_overview.md §4.7）
  static const _maxConcurrent = 2;

  final List<UploadItem> _waiting = [];
  int _sending = 0;
  // 列が空になるまでに送れた枚数
  int _completed = 0;

  final _uploaded = StreamController<UploadItem>.broadcast();
  final _finished = StreamController<int>.broadcast();

  /// 1枚送れるたびに流れる（画面は自分宛ての写真なら一覧を読み直す）
  Stream<UploadItem> get uploaded => _uploaded.stream;

  /// 列が空になったときに、送れた枚数が流れる（AppRoot が「N枚を送信しました」と知らせる）
  Stream<int> get finished => _finished.stream;

  /// 選んだ写真を準備して列に入れる
  Future<void> addFiles(List<XFile> files, {String? tripId}) async {
    for (final file in files) {
      final bytes = await file.readAsBytes();
      _waiting.add(UploadItem(
        photoId: sha256.convert(bytes).toString(),
        bytes: bytes,
        tripId: tripId,
        metadata: await readPhotoMetadata(bytes),
      ));
    }
    notifyListeners();
    _pump();
  }

  void _pump() {
    while (_sending < _maxConcurrent && _waiting.isNotEmpty) {
      _sending++;
      _send(_waiting.removeAt(0));
    }
  }

  Future<void> _send(UploadItem item) async {
    try {
      await _apiService.uploadPhoto(
          photoId: item.photoId,
          bytes: item.bytes,
          tripId: item.tripId,
          takenAt: item.metadata.takenAt,
          latitude: item.metadata.latitude,
          longitude: item.metadata.longitude);
      _completed++;
      _uploaded.add(item);
    } catch (e) {
      debugPrint('UploadQueue: 写真の送信エラー: $e');
    } finally {
      _sending--;
      if (_sending == 0 && _waiting.isEmpty) {
        _finished.add(_completed);
        _completed = 0;
      }
      notifyListeners();
      _pump();
    }
  }

  @override
  void dispose() {
    _uploaded.close();
    _finished.close();
    super.dispose();
  }
}
