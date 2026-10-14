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

/// 送る写真1枚の状態
enum UploadState { waiting, sending, done, failed }

/// 写真の送信の列（docs/travel-album/03_screen_design.md §4.7）
///
/// 送信は画面を移っても続くので、画面ではなく AppRoot が1つ持ち、各画面に渡す（§1「状態の持ち方」）
class UploadQueue extends ChangeNotifier {
  UploadQueue(this._apiService);

  final ApiService _apiService;

  /// 同時に送る数（docs/travel-album/02_design_overview.md §4.7）
  static const _maxConcurrent = 2;

  // 進み具合の全体として数える項目。送信中の項目が無くなったら、送れた項目を除く（失敗した項目は送り直すか閉じるまで残る）
  final List<UploadItem> _items = [];
  final Map<UploadItem, UploadState> _states = {};

  final _uploaded = StreamController<UploadItem>.broadcast();
  final _finished = StreamController<int>.broadcast();

  /// 1枚送れるたびに流れる（画面は自分宛ての写真なら一覧を読み直す）
  Stream<UploadItem> get uploaded => _uploaded.stream;

  /// 送信中の項目が無くなったときに、送れた枚数が流れる（AppRoot が「N枚を送信しました」と知らせる）
  Stream<int> get finished => _finished.stream;

  /// 列にある項目（進み具合バナーが数える）
  List<UploadItem> get items => List.unmodifiable(_items);

  UploadState stateOf(UploadItem item) => _states[item]!;

  /// 選んだ写真を準備して列に入れる
  Future<void> addFiles(List<XFile> files, {String? tripId}) async {
    for (final file in files) {
      final bytes = await file.readAsBytes();
      final item = UploadItem(
        photoId: sha256.convert(bytes).toString(),
        bytes: bytes,
        tripId: tripId,
        metadata: await readPhotoMetadata(bytes),
      );
      _items.add(item);
      _states[item] = UploadState.waiting;
    }
    notifyListeners();
    _pump();
  }

  int _count(UploadState state) =>
      _states.values.where((s) => s == state).length;

  void _pump() {
    for (final item in _items) {
      if (_count(UploadState.sending) >= _maxConcurrent) break;
      if (_states[item] == UploadState.waiting) {
        _states[item] = UploadState.sending;
        _send(item);
      }
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
      _states[item] = UploadState.done;
      _uploaded.add(item);
    } catch (e) {
      debugPrint('UploadQueue: 写真の送信エラー: $e');
      _states[item] = UploadState.failed;
    }
    if (_count(UploadState.waiting) == 0 && _count(UploadState.sending) == 0) {
      _finished.add(_count(UploadState.done));
      _items.removeWhere((i) => _states[i] == UploadState.done);
      _states.removeWhere((_, state) => state == UploadState.done);
    }
    notifyListeners();
    _pump();
  }

  /// 失敗した項目（[where] に当たるもの）を送り直す。準備はやり直さない
  void retryFailed(bool Function(UploadItem item) where) {
    for (final item in _items.where(where)) {
      if (_states[item] == UploadState.failed) {
        _states[item] = UploadState.waiting;
      }
    }
    notifyListeners();
    _pump();
  }

  /// 失敗した項目（[where] に当たるもの）を列から消す（端末の写真は消えない。選び直せば送れる）
  void dismissFailed(bool Function(UploadItem item) where) {
    final dismissed = _items
        .where((item) => where(item) && _states[item] == UploadState.failed)
        .toList();
    for (final item in dismissed) {
      _items.remove(item);
      _states.remove(item);
    }
    notifyListeners();
  }

  @override
  void dispose() {
    _uploaded.close();
    _finished.close();
    super.dispose();
  }
}
