import 'dart:typed_data';

/// 画像の MIME タイプをファイル先頭のシグネチャ（マジックバイト）から判定する
///
/// 拡張子や `XFile.mimeType` は OS・ブラウザが拡張子から推定した申告値で、
/// 中身と一致する保証がない。サーバは送られた Content-Type を検証済みとして信頼し、
/// Blob 名の拡張子もそこから決めるため、中身と食い違うと
/// 「中身が PNG で名前と Content-Type が JPEG」の Blob が保存される。
///
/// サーバが受け付ける4形式だけを判定する。判定できない場合は従来の既定値
/// `image/jpeg` を返す（4形式以外はサーバが 415 で拒否する）。
String detectImageMimeType(Uint8List bytes) {
  if (_startsWith(bytes, const [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) {
    return 'image/png';
  }
  if (_startsWith(bytes, const [0xFF, 0xD8, 0xFF])) {
    return 'image/jpeg';
  }
  if (_startsWith(bytes, 'GIF87a'.codeUnits) || _startsWith(bytes, 'GIF89a'.codeUnits)) {
    return 'image/gif';
  }
  // RIFF コンテナは WAV や AVI でも使われるため、8バイト目からの WEBP まで確認する
  if (_startsWith(bytes, 'RIFF'.codeUnits) && _startsWith(bytes, 'WEBP'.codeUnits, offset: 8)) {
    return 'image/webp';
  }
  return 'image/jpeg';
}

bool _startsWith(Uint8List bytes, List<int> signature, {int offset = 0}) {
  if (bytes.length < offset + signature.length) return false;
  for (var i = 0; i < signature.length; i++) {
    if (bytes[offset + i] != signature[i]) return false;
  }
  return true;
}
