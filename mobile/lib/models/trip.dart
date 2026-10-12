/// 旅行（作成・更新の応答。集計は付かない。docs/travel-album/05_api_design.md §3.1）
class Trip {
  final String id;
  final String name;
  final String? description;

  const Trip({required this.id, required this.name, this.description});

  factory Trip.fromJson(Map<String, dynamic> json) {
    return Trip(
      id: json['id'] as String,
      name: json['name'] as String,
      description: json['description'] as String?,
    );
  }
}

/// 写真から導いた集計を足した旅行（一覧・詳細の応答。docs/travel-album/05_api_design.md §3.2）
///
/// 枚数・撮影期間・表紙はサーバが写真から導いて返す（旅行のドキュメントには保存されない）
class TripSummary {
  final String id;
  final String name;
  final String? description;
  final int photoCount;

  /// 撮影日時のある写真の最初と最後（タイムゾーン無しの `YYYY-MM-DDTHH:mm:ss`）。無ければ null
  final String? firstTakenAt;
  final String? lastTakenAt;

  /// 先頭の写真のサムネイルの SAS 付き URL。写真が無ければ null
  final String? coverThumbnailUrl;

  const TripSummary({
    required this.id,
    required this.name,
    this.description,
    required this.photoCount,
    this.firstTakenAt,
    this.lastTakenAt,
    this.coverThumbnailUrl,
  });

  factory TripSummary.fromJson(Map<String, dynamic> json) {
    return TripSummary(
      id: json['id'] as String,
      name: json['name'] as String,
      description: json['description'] as String?,
      photoCount: json['photoCount'] as int,
      firstTakenAt: json['firstTakenAt'] as String?,
      lastTakenAt: json['lastTakenAt'] as String?,
      coverThumbnailUrl: json['coverThumbnailUrl'] as String?,
    );
  }
}

/// 旅行一覧（`GET /api/trips`）。旅行に属さない写真の枚数も同じ応答で返る
class TripList {
  final List<TripSummary> trips;
  final int unassignedPhotoCount;

  const TripList({required this.trips, required this.unassignedPhotoCount});
}
