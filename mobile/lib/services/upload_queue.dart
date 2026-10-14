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

/// 「写真を追加」で選んだ写真の準備の進み具合（準備中は、まだ列の項目になっていない写真もあるので別に数える）
class PreparationProgress {
  PreparationProgress({required this.tripId, required this.total});

  /// 送り先の旅行。null なら旅行に属さない写真
  final String? tripId;

  /// 選んだ枚数
  final int total;

  /// 準備を終えた枚数（読めなかった写真も含む）
  int prepared = 0;
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
  final List<PreparationProgress> _preparations = [];
  // 失敗した項目の理由と、失敗した順番（バナーは最後に失敗したものの理由を出す）
  final Map<UploadItem, ({int order, String? reason})> _failures = {};
  int _failureOrder = 0;
  // 破棄した後に、送信や準備の途中の処理が終わっても、通知も送信もしない
  bool _disposed = false;

  final _finished = StreamController<UploadBatchResult>.broadcast();

  /// 送信中の項目が無くなったときに、その区切りで送れた写真が流れる。
  /// AppRoot は「N枚を送信しました」と知らせ、画面は自分宛てが含まれていれば一覧を読み直す。
  /// 1枚ごとに読み直すと、数百枚の送信で一覧の取得とグリッドの作り直し（スクロール位置が先頭に戻る）が同じ数だけ起きる
  Stream<UploadBatchResult> get finished => _finished.stream;

  /// 列にある項目（進み具合バナーが数える）
  List<UploadItem> get items => List.unmodifiable(_items);

  UploadState stateOf(UploadItem item) => _states[item]!;

  /// 失敗した項目のうち、送り先が [where] に当たるもので最後に失敗したものの理由。理由が無ければ null
  String? lastFailureReason(bool Function(String? tripId) where) {
    ({int order, String? reason})? last;
    for (final entry in _failures.entries) {
      if (_states[entry.key] != UploadState.failed ||
          !where(entry.key.tripId)) {
        continue;
      }
      if (last == null || entry.value.order > last.order) last = entry.value;
    }
    return last?.reason;
  }

  void _fail(UploadItem item, String? reason) {
    _states[item] = UploadState.failed;
    _failures[item] = (order: _failureOrder++, reason: reason);
  }

  /// 準備中の写真の束（進み具合バナーが「写真を準備中... k/n」に使う）
  List<PreparationProgress> get preparations =>
      List.unmodifiable(_preparations);

  /// 選んだ写真を準備して列に入れる
  Future<void> addFiles(List<XFile> files, {String? tripId}) async {
    // 読めない写真があっても残りの準備は続け、最後に失敗を呼び出し側へ伝える（呼び出し側が知らせる）
    Object? failure;
    final progress = PreparationProgress(tripId: tripId, total: files.length);
    _preparations.add(progress);
    notifyListeners();
    for (final file in files) {
      // 準備の途中で設定が変わってこの列が捨てられたら、残りは準備しない（送らないので読むだけ無駄になる）
      if (_disposed) return;
      try {
        final prepared = await compute(_preparePhoto, file.path);
        final item = UploadItem(
          path: file.path,
          photoId: prepared.photoId,
          tripId: tripId,
          metadata: prepared.metadata,
        );
        _items.add(item);
        _states[item] = UploadState.waiting;
      } catch (e) {
        failure ??= e;
      }
      if (_disposed) return;
      // 準備が済んだ写真から送り始める（数百枚を選んでも、全部の準備を待たずに送信が進む）
      progress.prepared++;
      notifyListeners();
      _pump();
    }
    _preparations.remove(progress);
    // 最後の写真の送信が準備より先に終わっていたら、ここで区切りになる
    _finishBatchIfIdle();
    notifyListeners();
    if (failure != null) throw failure;
  }

  int _count(UploadState state) =>
      _states.values.where((s) => s == state).length;

  void _pump() {
    // 送信中の数はループの前に1回だけ数える（項目ごとに全体を数え直すと、数百枚で送るたびに重くなる）
    var sending = _count(UploadState.sending);
    for (final item in _items) {
      if (sending >= _maxConcurrent) break;
      if (_states[item] == UploadState.waiting) {
        _states[item] = UploadState.sending;
        sending++;
        _send(item);
      }
    }
  }

  /// 一時的な失敗のときに送り直すまでの間隔（docs/travel-album/03_screen_design.md §4.7 の表）。回数の上限もこの長さ
  static const _retryDelays = [
    Duration(seconds: 2),
    Duration(seconds: 4),
    Duration(seconds: 8),
  ];

  /// 送り直せば通りうる失敗か（通信できない・混んでいる・一時的に使えない）
  static bool _isTransient(Object error) =>
      error is ApiException &&
      (error.statusCode == 0 ||
          error.statusCode == 429 ||
          error.statusCode == 503);

  Future<void> _send(UploadItem item) async {
    for (var attempt = 0;; attempt++) {
      try {
        await _apiService.uploadPhoto(
            photoId: item.photoId,
            bytes: await File(item.path).readAsBytes(),
            tripId: item.tripId,
            takenAt: item.metadata.takenAt,
            latitude: item.metadata.latitude,
            longitude: item.metadata.longitude);
        _states[item] = UploadState.done;
        break;
      } catch (e) {
        debugPrint('UploadQueue: 写真の送信エラー: $e');
        if (_isTransient(e) && attempt < _retryDelays.length && !_disposed) {
          // 待つ間も送信中のまま（バナーは失敗の行にしない。同時に送る枠もふさいだまま）
          await Future.delayed(_retryDelays[attempt]);
          if (_disposed) return;
          continue;
        }
        if (e is ApiException && e.isTripNotFound) {
          // 送り先の旅行が消えている。同じ宛先のまだ送っていない写真も、送っても同じ結果なので失敗にする
          const reason = '旅行が見つかりません';
          _fail(item, reason);
          for (final other in _items) {
            if (other.tripId == item.tripId &&
                _states[other] == UploadState.waiting) {
              _fail(other, reason);
            }
          }
        } else {
          _fail(item, null);
        }
        break;
      }
    }
    // 送っている間に設定が変わって、この列が捨てられた（前の設定の送信の結果は知らせない）
    if (_disposed) return;
    _finishBatchIfIdle();
    notifyListeners();
    _pump();
  }

  /// 準備中の写真も、待ち・送信中の項目も無くなったら、送信の一区切りとして送れた写真を流し、列から除く。
  /// 準備中の写真が残っている間に区切ると、選んだ写真の途中で「N枚を送信しました」が出て、残りの分でもう一度出る
  void _finishBatchIfIdle() {
    if (_preparations.isNotEmpty ||
        _count(UploadState.waiting) > 0 ||
        _count(UploadState.sending) > 0) {
      return;
    }
    final done = _items.where((i) => _states[i] == UploadState.done).toList();
    _finished.add(UploadBatchResult(
        count: done.length, tripIds: done.map((i) => i.tripId).toSet()));
    _items.removeWhere((i) => _states[i] == UploadState.done);
    _states.removeWhere((_, state) => state == UploadState.done);
  }

  /// 失敗した項目のうち、送り先が [where] に当たるものを送り直す。準備はやり直さない
  void retryFailed(bool Function(String? tripId) where) {
    for (final item in _items.where((item) => where(item.tripId))) {
      if (_states[item] == UploadState.failed) {
        _states[item] = UploadState.waiting;
      }
    }
    notifyListeners();
    _pump();
  }

  /// 失敗した項目のうち、送り先が [where] に当たるものを列から消す（端末の写真は消えない。選び直せば送れる）
  void dismissFailed(bool Function(String? tripId) where) {
    final dismissed = _items
        .where(
            (item) => where(item.tripId) && _states[item] == UploadState.failed)
        .toList();
    for (final item in dismissed) {
      _items.remove(item);
      _states.remove(item);
      _failures.remove(item);
    }
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _finished.close();
    super.dispose();
  }
}
