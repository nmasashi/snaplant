import 'dart:async';
import 'dart:io';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:geocoding/geocoding.dart' show Geocoding;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:flutter_image_compress/flutter_image_compress.dart'
    show CompressFormat, FlutterImageCompress;
import 'package:image_picker/image_picker.dart';

import '../utils/photo_metadata.dart';
import 'api_service.dart';

/// 送る写真1枚
class UploadItem {
  UploadItem(
      {required this.path,
      required this.photoId,
      this.tripId,
      this.metadata = PhotoMetadata.none,
      this.thumbnail,
      this.placeName});

  /// ギャラリーで選んだ画像のファイル（縮小済み）。バイト列は送るときに読む
  /// （数百枚を選んだときに、全部のバイト列をメモリに持ち続けないように）
  final String path;

  /// 画像のバイト列の SHA-256（16進・小文字）。同じ写真を何度送っても1枚になる
  final String photoId;

  /// 送り先の旅行。null なら旅行に属さない写真
  final String? tripId;

  /// EXIF から読んだ撮影日時と位置
  final PhotoMetadata metadata;

  /// 一覧用のサムネイル（長辺 320px・画質 70 の JPEG）。作れなければ null で、サムネイル無しで送る
  final Uint8List? thumbnail;

  /// 端末の Geocoder で引いた地名（「北海道旭川市」）。位置が無い・引けなければ null
  final String? placeName;
}

/// 緯度・経度から地名（都道府県＋市区町村）を引く（docs/travel-album/06_processing_design.md §4.2）。
/// 引けなければ null（送信は止めない）。端末の機能（プラグイン）を使うので、別の isolate ではなくここで呼ぶ
///
/// 同じ場所の写真が続くので、小数3桁（≒100m）に丸めた座標をキーに、引けた地名を端末に残して使い回す（引けなかったものは残さない）
Future<String?> _lookupPlaceName(double latitude, double longitude) async {
  try {
    final prefs = await SharedPreferences.getInstance();
    final key =
        'placeName:${latitude.toStringAsFixed(3)},${longitude.toStringAsFixed(3)}';
    final cached = prefs.getString(key);
    if (cached != null) return cached;
    // 言語はメソッドに渡す（geocoding 5 の公開のコンストラクタは locale を捨て、端末の言語で引いてしまう）
    final placemarks = await Geocoding()
        .placemarkFromCoordinates(latitude, longitude,
            locale: const ui.Locale('ja', 'JP'))
        .timeout(_placeNameTimeout);
    if (placemarks.isEmpty) return null;
    final place = placemarks.first;
    final name =
        '${place.administrativeArea ?? ''}${place.locality ?? ''}'.trim();
    // 空白だけ・100文字を超える地名はサーバが 400 にし、写真ごと送れなくなる。地名は手がかりなので、無しで送る
    if (name.isEmpty || name.length > _placeNameMaxLength) return null;
    await prefs.setString(key, name);
    return name;
  } catch (e) {
    debugPrint('UploadQueue: 地名の取得エラー: $e');
    return null;
  }
}

/// 地名を引くのを待つ長さ。過ぎたら地名なしで送る（端末の Geocoder は応答しないことがあり、送信を止めない。06 §4.2）
const _placeNameTimeout = Duration(seconds: 5);

/// サーバが受け付ける地名の長さの上限（docs/travel-album/05_api_design.md §5.1 の 17）
const _placeNameMaxLength = 100;

/// サムネイルの長辺と画質（docs/travel-album/03_screen_design.md §4.7「準備」）
const _thumbnailLongSide = 320;
const _thumbnailQuality = 70;

/// 一覧用のサムネイルを作る。作れなければ null（送信は止めない）。
/// 端末の機能（プラグイン）を使うので、別の isolate ではなくここで呼ぶ
Future<Uint8List?> _makeThumbnail(String path) async {
  try {
    // 画像は Dart に読み込まずに、ファイルのままエンジン（縦横を読む）とプラグイン（縮める）に渡す
    // （数百枚の準備で、写真ごとに原寸のバイト列を Dart に読んでチャネル越しに渡し直さないように）
    final buffer = await ui.ImmutableBuffer.fromFilePath(path);
    final descriptor = await ui.ImageDescriptor.encoded(buffer);
    final long = math.max(descriptor.width, descriptor.height);
    final short = math.min(descriptor.width, descriptor.height);
    descriptor.dispose();
    buffer.dispose();
    // プラグインは「縦・横とも指定の長さを下回らない最大の縮小」をする（短辺が指定に届くまで）。
    // 縦横に同じ長さ（短辺を長辺 320 に合わせた長さ）を指定すると、向きの補正（EXIF の回転で縦横を入れ替える）の前後どちらで
    // 縦横を読んでも、長辺が 320 になる。縦横で別の値を指定すると、向きを取り違えたときに長辺が 320 を超える
    final side = (_thumbnailLongSide * short / long).round();
    return await FlutterImageCompress.compressWithFile(
      path,
      minWidth: side,
      minHeight: side,
      quality: _thumbnailQuality,
      format: CompressFormat.jpeg,
    );
  } catch (e) {
    debugPrint('UploadQueue: サムネイルの作成エラー: $e');
    return null;
  }
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
  const UploadBatchResult(
      {required this.count, required this.tripIds, this.alreadyElsewhere = 0});

  /// 送れた枚数（送信済みだった写真も含む）
  final int count;

  /// 送れた写真のうち、既に別の旅行か旅行に属さない写真にあったもの（サーバは 200 で既存を返し、宛先は変えない）
  final int alreadyElsewhere;

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
  final Map<UploadItem, ({int order, String reason})> _failures = {};
  int _failureOrder = 0;
  // 送れた項目のうち、既に別の場所にあったもの
  final Set<UploadItem> _alreadyElsewhere = {};
  // 404 TRIP_NOT_FOUND を受けた送り先。後から準備が済んだ同じ宛先の写真は、送っても同じ結果なので送らずに失敗にする
  // （旅行の id は作り直されないので、消えた宛先を覚え続けても困らない。「送り直す」では利用者が試すので忘れる）
  final Set<String?> _missingTrips = {};

  // 送信を取り消した宛先（旅行を削除した）。準備が済んでも列に入れず、送信中だった写真の結果も知らせない
  final Set<String?> _canceledTrips = {};
  static const _tripNotFoundReason = '旅行が見つかりません';
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

  /// 失敗した項目のうち、送り先が [where] に当たるもので最後に失敗したものの理由。失敗した項目が無ければ null
  String? lastFailureReason(bool Function(String? tripId) where) {
    ({int order, String reason})? last;
    for (final entry in _failures.entries) {
      if (_states[entry.key] != UploadState.failed ||
          !where(entry.key.tripId)) {
        continue;
      }
      if (last == null || entry.value.order > last.order) last = entry.value;
    }
    return last?.reason;
  }

  void _fail(UploadItem item, String reason) {
    _states[item] = UploadState.failed;
    _failures[item] = (order: _failureOrder++, reason: reason);
  }

  /// 準備中の写真の束（進み具合バナーが「写真を準備中... k/n」に使う）
  List<PreparationProgress> get preparations =>
      List.unmodifiable(_preparations);

  /// 選んだ写真を準備して列に入れる
  Future<void> addFiles(List<XFile> files, {String? tripId}) async {
    // ギャラリーを開いている間に設定が変わって、この列が捨てられていた（送らないし、破棄後に通知もしない）
    if (_disposed) return;
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
        final latitude = prepared.metadata.latitude;
        final longitude = prepared.metadata.longitude;
        // サムネイルと地名は互いに関係しないので、同時に待つ（地名は最長5秒待つことがある）
        final (thumbnail, placeName) = await (
          _makeThumbnail(file.path),
          latitude != null && longitude != null
              ? _lookupPlaceName(latitude, longitude)
              : Future<String?>.value(null),
        ).wait;
        final item = UploadItem(
          path: file.path,
          photoId: prepared.photoId,
          tripId: tripId,
          metadata: prepared.metadata,
          thumbnail: thumbnail,
          placeName: placeName,
        );
        if (_canceledTrips.contains(tripId)) {
          // 準備の間に宛先の送信が取り消された（旅行を削除した）。送らずに捨てる
        } else if (_missingTrips.contains(tripId)) {
          _items.add(item);
          _fail(item, _tripNotFoundReason);
        } else {
          _items.add(item);
          _states[item] = UploadState.waiting;
        }
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

  /// [tripId] 宛ての送信が進行中か（準備中・送信待ち・送信中・送り直し待ちの写真がある）。失敗した写真は数えない
  bool isActiveFor(String? tripId) =>
      _preparations.any((p) => p.tripId == tripId) ||
      _items.any((i) =>
          i.tripId == tripId &&
          (_states[i] == UploadState.waiting ||
              _states[i] == UploadState.sending));

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
  /// 1回の送信の応答を待つ長さ。過ぎたら通信の失敗として送り直す（§4.7 の表）。
  /// 時間切れが無いと、通信が固まったときに送信中のまま枠がふさがり、送り直しも区切りも来ない
  static const _requestTimeout = Duration(seconds: 60);

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
        final photo = await _apiService
            .uploadPhoto(
                photoId: item.photoId,
                bytes: await File(item.path).readAsBytes(),
                tripId: item.tripId,
                takenAt: item.metadata.takenAt,
                latitude: item.metadata.latitude,
                longitude: item.metadata.longitude,
                thumbnail: item.thumbnail,
                placeName: item.placeName)
            .timeout(_requestTimeout,
                onTimeout: () => throw const ApiException(
                    statusCode: 0, message: '応答がありませんでした'));
        _states[item] = UploadState.done;
        // 送信は「入れる」ではないので、既にある写真の宛先は変わらない（docs/travel-album/05_api_design.md §5.1）
        if (photo.tripId != item.tripId) _alreadyElsewhere.add(item);
        break;
      } catch (e) {
        debugPrint('UploadQueue: 写真の送信エラー: $e');
        if (_isTransient(e) && attempt < _retryDelays.length && !_disposed) {
          // 待つ間も送信中のまま（バナーは失敗の行にしない。同時に送る枠もふさいだまま）
          await Future.delayed(_retryDelays[attempt]);
          if (_disposed) return;
          // 待っている間に宛先の送信が取り消された（旅行を削除した）。送らない
          if (_canceledTrips.contains(item.tripId)) break;
          // 待っている間に、同じ宛先の別の写真で送り先が消えたと分かった。送っても同じ結果なので送らない
          if (_missingTrips.contains(item.tripId)) {
            _fail(item, _tripNotFoundReason);
            break;
          }
          continue;
        }
        if (e is ApiException && e.isTripNotFound) {
          // 送り先の旅行が消えている。同じ宛先のまだ送っていない写真も、送っても同じ結果なので失敗にする
          _missingTrips.add(item.tripId);
          _fail(item, _tripNotFoundReason);
          for (final other in _items) {
            if (other.tripId == item.tripId &&
                _states[other] == UploadState.waiting) {
              _fail(other, _tripNotFoundReason);
            }
          }
        } else {
          _fail(item, e is ApiException ? e.userMessage : '写真の送信に失敗しました');
        }
        break;
      }
    }
    // 送っている間に設定が変わって、この列が捨てられた（前の設定の送信の結果は知らせない）
    if (_disposed) return;
    // 送っている間に宛先の送信が取り消された。結果は知らせない（送れたかどうかも、失敗も数えない）
    if (_canceledTrips.contains(item.tripId)) _forget(item);
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
      count: done.length,
      // 既に別の場所にあった写真は、宛先の一覧を変えないので読み直しに数えない
      tripIds: done
          .where((i) => !_alreadyElsewhere.contains(i))
          .map((i) => i.tripId)
          .toSet(),
      alreadyElsewhere: done.where(_alreadyElsewhere.contains).length,
    ));
    _items.removeWhere((i) => _states[i] == UploadState.done);
    _states.removeWhere((_, state) => state == UploadState.done);
    _alreadyElsewhere.clear();
    // 送り直して送れた写真の、前の失敗の記録も捨てる（残すと列を使うほど溜まり続ける）
    for (final item in done) {
      _failures.remove(item);
    }
  }

  /// 失敗した項目のうち、送り先が [where] に当たるものを送り直す。準備はやり直さない
  void retryFailed(bool Function(String? tripId) where) {
    _missingTrips.removeWhere(where);
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

  /// [tripId] 宛ての送信を取り消す（旅行を削除するとき。docs/travel-album/03_screen_design.md §4.4）。
  /// 送信待ち・失敗・送れた写真は列から消し、準備中の写真は準備が済んでも入れない。
  /// 送信中の要求は止められないので、終わったときに結果を知らせずに消す
  void cancelTrip(String tripId) {
    _canceledTrips.add(tripId);
    final canceled = [
      for (final item in _items)
        if (item.tripId == tripId && _states[item] != UploadState.sending) item
    ];
    canceled.forEach(_forget);
    _finishBatchIfIdle();
    notifyListeners();
  }

  /// [cancelTrip] を解く（旅行の削除が失敗した）。取り消して消した写真は戻らない（選び直せば送れる）
  void resumeTrip(String tripId) {
    _canceledTrips.remove(tripId);
  }

  /// 列から写真を跡形なく消す（失敗にも完了にも数えない）
  void _forget(UploadItem item) {
    _items.remove(item);
    _states.remove(item);
    _failures.remove(item);
    _alreadyElsewhere.remove(item);
  }

  @override
  void dispose() {
    _disposed = true;
    _finished.close();
    super.dispose();
  }
}
