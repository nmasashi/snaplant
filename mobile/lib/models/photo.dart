/// 旅行アルバムの写真（docs/travel-album/05_api_design.md §3.3）
///
/// 段階2で画面が使う項目だけを読む。URL は SAS 付きで、応答のたびに変わる
class Photo {
  /// 画像のバイト列の SHA-256（16進・小文字 64 文字）
  final String id;
  final String? tripId;
  final String imageUrl;

  /// サムネイルの URL。サムネイルが無ければ null（原寸を出す）
  final String? thumbnailUrl;

  /// 撮影日時（タイムゾーン無しの `YYYY-MM-DDTHH:mm:ss`）。無ければ null
  final String? takenAt;

  const Photo({
    required this.id,
    this.tripId,
    required this.imageUrl,
    this.thumbnailUrl,
    this.takenAt,
  });

  factory Photo.fromJson(Map<String, dynamic> json) {
    return Photo(
      id: json['id'] as String,
      tripId: json['tripId'] as String?,
      imageUrl: json['imageUrl'] as String,
      thumbnailUrl: json['thumbnailUrl'] as String?,
      takenAt: json['takenAt'] as String?,
    );
  }
}

/// 写真の一覧の1ページ（`GET /api/photos`）
class PhotoPage {
  final List<Photo> photos;

  /// 続きを読むためのトークン。null なら最後のページ（最後のページが空のこともある）
  final String? continuationToken;

  const PhotoPage({required this.photos, this.continuationToken});
}

/// 写真の移動の結果（`POST /api/photos/move`）
class PhotoMoveResult {
  /// 移した写真の id（既にその旅行にあった写真も入る）
  final List<String> moved;

  /// 見つからなかった写真の id（別の端末で消されたなど）
  final List<String> notFound;

  const PhotoMoveResult({required this.moved, required this.notFound});
}
