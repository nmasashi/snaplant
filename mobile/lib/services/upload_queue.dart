import 'dart:async';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:image_picker/image_picker.dart';

import '../utils/photo_metadata.dart';
import 'api_service.dart';

/// 送る写真1枚
class UploadItem {
  UploadItem(
      {required this.path,
      required this.photoId,
      this.tripId,
      this.metadata = PhotoMetadata.none});

  /// ギャラリーで選んだ画像のファイル（縮小済み）。バイト列は送るときに読む
  /// （数百枚を選んだときに、全部のバイト列をメモリに持ち続けないように）
  final String path;

  /// 画像のバイト列の SHA-256（16進・小文字）。同じ写真を何度送っても1枚になる
  final String photoId;

  /// 送り先の旅行。null なら旅行に属さない写真
  final String? tripId;

  /// EXIF から読んだ撮影日時と位置
  final PhotoMetadata metadata;
}

/// 準備の結果（別の isolate から返す）
class _PreparedPhoto {
  const _PreparedPhoto(this.photoId, this.metadata);
  final String photoId;
  final PhotoMetadata metadata;
}

/// 画像のファイルを読み、SHA-256 と EXIF の撮影日時・位置を求める。
/// 数百枚を選ぶと画面が固まるので、別の isolate（compute）で行う（docs/travel-album/03_screen_design.md §4.7「準備」）
Future<_PreparedPhoto> _preparePhoto(String path) async {
  final bytes = await File(path).readAsBytes();
  return _PreparedPhoto(
      sha256.convert(bytes).toString(), await readPhotoMetadata(bytes));
}

/// 送信の一区切り（送信中の項目が無くなったとき）の結果
class UploadBatchResult {
  const UploadBatchResult({required this.count, required this.tripIds});

  /// 送れた枚数
  final int count;

  /// 送れた写真の送り先（旅行に属さない写真は null）。画面は自分宛てが含まれていれば一覧を読み直す
  final Set<String?> tripIds;
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

  final _finished = StreamController<UploadBatchResult>.broadcast();

  /// 送信中の項目が無くなったときに、その区切りで送れた写真が流れる。
  /// AppRoot は「N枚を送信しました」と知らせ、画面は自分宛てが含まれていれば一覧を読み直す。
  /// 1枚ごとに読み直すと、数百枚の送信で一覧の取得とグリッドの作り直し（スクロール位置が先頭に戻る）が同じ数だけ起きる
  Stream<UploadBatchResult> get finished => _finished.stream;

  /// 列にある項目（進み具合バナーが数える）
  List<UploadItem> get items => List.unmodifiable(_items);

  UploadState stateOf(UploadItem item) => _states[item]!;

  /// 選んだ写真を準備して列に入れる
  Future<void> addFiles(List<XFile> files, {String? tripId}) async {
    try {
      for (final file in files) {
        final prepared = await compute(_preparePhoto, file.path);
        final item = UploadItem(
          path: file.path,
          photoId: prepared.photoId,
          tripId: tripId,
          metadata: prepared.metadata,
        );
        _items.add(item);
        _states[item] = UploadState.waiting;
      }
    } finally {
      if (!_disposed) {
        // 途中の1枚が読めなくても、それまでに準備できた写真は送り始める（失敗は呼び出し側が知らせる）
        notifyListeners();
        _pump();
      }
    }
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
          bytes: await File(item.path).readAsBytes(),
          tripId: item.tripId,
          takenAt: item.metadata.takenAt,
          latitude: item.metadata.latitude,
          longitude: item.metadata.longitude);
      _states[item] = UploadState.done;
    } catch (e) {
      debugPrint('UploadQueue: 写真の送信エラー: $e');
      _states[item] = UploadState.failed;
    }
    // 送っている間に設定が変わって、この列が捨てられた（前の設定の送信の結果は知らせない）
    if (_disposed) return;
    if (_count(UploadState.waiting) == 0 && _count(UploadState.sending) == 0) {
      final done = _items.where((i) => _states[i] == UploadState.done).toList();
      _finished.add(UploadBatchResult(
          count: done.length, tripIds: done.map((i) => i.tripId).toSet()));
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

  // 破棄した後に、送信や準備の途中の処理が終わっても、通知も送信もしない
  bool _disposed = false;

  @override
  void dispose() {
    _disposed = true;
    _finished.close();
    super.dispose();
  }
}
