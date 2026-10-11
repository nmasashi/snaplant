import 'dart:io';

import 'package:exif/exif.dart';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:photo_manager/photo_manager.dart';

/// 【試作・main にマージしない】写真の撮影日時と位置情報を、取り込み方ごとに読めるか確かめる画面
///
/// 旅行アルバムの段階1（実機での確認）用。image_picker（Android）は選ばれた写真を
/// ContentResolver#openInputStream で読むだけで、ACCESS_MEDIA_LOCATION も
/// MediaStore.setRequireOriginal も使わない。Android 10 以降は、この読み方だと
/// 位置情報が伏せられる可能性がある。アプリが実際に受け取ったファイルの EXIF を、
/// 3つの取り込み方で並べて比べる。
class PhotoMetadataCheckScreen extends StatefulWidget {
  const PhotoMetadataCheckScreen({super.key});

  @override
  State<PhotoMetadataCheckScreen> createState() => _PhotoMetadataCheckScreenState();
}

class _PhotoMetadataCheckScreenState extends State<PhotoMetadataCheckScreen> {
  final List<_CheckResult> _results = [];
  bool _busy = false;

  /// 処理中の表示と例外の表示をまとめて扱う
  Future<void> _run(Future<void> Function() action) async {
    setState(() => _busy = true);
    try {
      await action();
    } catch (e) {
      _add(_CheckResult.error('$e'));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _add(_CheckResult result) {
    if (!mounted) return;
    setState(() => _results.insert(0, result));
  }

  /// image_picker で1枚選ぶ。resize が true なら今のアプリと同じ設定（画質85%・最大1920px）
  Future<void> _pickWithImagePicker({required bool resize}) async {
    final picker = ImagePicker();
    final XFile? picked = resize
        ? await picker.pickImage(
            source: ImageSource.gallery,
            imageQuality: 85,
            maxWidth: 1920,
            maxHeight: 1920,
          )
        : await picker.pickImage(source: ImageSource.gallery);
    if (picked == null) return;

    final bytes = await picked.readAsBytes();
    _add(_CheckResult(
      method: resize ? 'A: image_picker（今の設定・縮小あり）' : 'B: image_picker（縮小なし）',
      fileName: picked.name,
      byteLength: bytes.length,
      exif: await readExifFromBytes(bytes),
    ));
  }

  /// photo_manager で端末の写真の一覧から新しい順に5枚を読む。位置情報の権限も求める
  Future<void> _readWithPhotoManager() async {
    final state = await PhotoManager.requestPermissionExtend(
      requestOption: const PermissionRequestOption(
        androidPermission: AndroidPermission(type: RequestType.image, mediaLocation: true),
      ),
    );
    if (!state.hasAccess) {
      _add(_CheckResult.error('写真へのアクセスが許可されませんでした（$state）'));
      return;
    }

    final assets = await PhotoManager.getAssetListPaged(page: 0, pageCount: 5, type: RequestType.image);
    for (final asset in assets) {
      final latLng = await asset.latlngAsync();
      final origin = await asset.originFile;
      final bytes = origin == null ? null : await origin.readAsBytes();
      _add(_CheckResult(
        method: 'C: photo_manager（一覧から直接・権限 $state）',
        fileName: asset.title ?? '(名前なし)',
        byteLength: bytes?.length,
        exif: bytes == null ? const {} : await readExifFromBytes(bytes),
        mediaStoreDate: asset.createDateTime,
        mediaStoreLatLng: latLng == null ? null : '${latLng.latitude}, ${latLng.longitude}',
      ));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('写真の情報を確認（開発用）')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text('端末: ${Platform.operatingSystem} ${Platform.operatingSystemVersion}'),
          const SizedBox(height: 8),
          const Text('位置情報をオンにして撮った写真を選んでください。結果は端末の中だけで表示し、どこにも送りません。'),
          const SizedBox(height: 16),
          ElevatedButton(
            onPressed: _busy ? null : () => _run(() => _pickWithImagePicker(resize: true)),
            child: const Text('A: 今の設定で1枚選ぶ（縮小あり）'),
          ),
          ElevatedButton(
            onPressed: _busy ? null : () => _run(() => _pickWithImagePicker(resize: false)),
            child: const Text('B: 縮小なしで1枚選ぶ'),
          ),
          ElevatedButton(
            onPressed: _busy ? null : () => _run(_readWithPhotoManager),
            child: const Text('C: 端末の写真一覧から新しい5枚を読む'),
          ),
          if (_busy) const Padding(padding: EdgeInsets.all(16), child: Center(child: CircularProgressIndicator())),
          const Divider(height: 32),
          for (final result in _results) result.build(),
        ],
      ),
    );
  }
}

/// 1枚分の確認結果
class _CheckResult {
  _CheckResult({
    required this.method,
    required this.fileName,
    required this.byteLength,
    required this.exif,
    this.mediaStoreDate,
    this.mediaStoreLatLng,
  }) : error = null;

  _CheckResult.error(String message)
      : method = 'エラー',
        fileName = '',
        byteLength = null,
        exif = const {},
        mediaStoreDate = null,
        mediaStoreLatLng = null,
        error = message;

  final String method;
  final String fileName;
  final int? byteLength;
  final Map<String, IfdTag> exif;
  final DateTime? mediaStoreDate;
  final String? mediaStoreLatLng;
  final String? error;

  /// EXIF の GPS の度・分・秒を10進の度に直す。無ければ null
  String? get _exifLatLng {
    final lat = _toDegrees(exif['GPS GPSLatitude'], exif['GPS GPSLatitudeRef']?.printable);
    final lng = _toDegrees(exif['GPS GPSLongitude'], exif['GPS GPSLongitudeRef']?.printable);
    if (lat == null || lng == null) return null;
    return '${lat.toStringAsFixed(5)}, ${lng.toStringAsFixed(5)}';
  }

  static double? _toDegrees(IfdTag? tag, String? ref) {
    if (tag == null) return null;
    final parts = tag.values.toList().whereType<Ratio>().map((r) => r.toDouble()).toList();
    if (parts.length != 3) return null;
    final degrees = parts[0] + parts[1] / 60 + parts[2] / 3600;
    return (ref == 'S' || ref == 'W') ? -degrees : degrees;
  }

  Widget build() {
    if (error != null) {
      return Card(child: ListTile(title: Text(method), subtitle: Text(error!)));
    }
    final rows = <String>[
      'ファイル: $fileName（${byteLength ?? '?'} バイト）',
      'EXIF 撮影日時: ${exif['EXIF DateTimeOriginal']?.printable ?? 'なし'}',
      'EXIF タイムゾーン: ${exif['EXIF OffsetTimeOriginal']?.printable ?? 'なし'}',
      'EXIF 位置: ${_exifLatLng ?? 'なし'}',
      'EXIF 機種: ${exif['Image Model']?.printable ?? 'なし'}',
      'EXIF の項目数: ${exif.length}',
      if (mediaStoreDate != null) '端末の記録の作成日時: $mediaStoreDate',
      if (method.startsWith('C:')) '端末の記録の位置: ${mediaStoreLatLng ?? 'なし'}',
    ];
    return Card(
      child: ListTile(
        title: Text(method),
        subtitle: Text(rows.join('\n')),
      ),
    );
  }
}
