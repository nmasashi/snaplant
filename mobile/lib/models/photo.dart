/// 旅行アルバムの写真（docs/05_api_design.md §3.3）
///
/// 画面が使う項目だけを読む（段階3で分類の項目を足した）。URL は SAS 付きで、応答のたびに変わる
class Photo {
  /// 画像のバイト列の SHA-256（16進・小文字 64 文字）
  final String id;
  final String? tripId;
  final String imageUrl;

  /// サムネイルの URL。サムネイルが無ければ null（原寸を出す）
  final String? thumbnailUrl;

  /// 撮影日時（タイムゾーン無しの `YYYY-MM-DDTHH:mm:ss`）。無ければ null
  final String? takenAt;

  /// 撮影日時の出どころ（`exif` / `user`（手で付けた。02 §5 #59）/ `none`）。返さない古い API なら null
  final String? takenAtSource;

  /// 送った日時（UTC の ISO 8601）。撮影日時を付けるシートの手がかりに出す（03 §5.8）
  final String? uploadedAt;

  /// 緯度・経度（`location`）。位置情報が無ければどちらも null
  final double? latitude;
  final double? longitude;

  /// 地名（`location.placeName`）。位置情報か地名が無ければ null
  final String? placeName;

  /// AI の分類のカテゴリ（`plant` / `food` / `landscape` / `other`）。分類の前は null
  final String? category;

  /// 利用者がカテゴリを手で決めたら `user`（02 §5 #53）。AI のカテゴリ・分類の前は null
  final String? categorySource;

  /// 解析の進み具合（`processing.state`。`none` / `pending` / `classifying` / `identifying` / `done` / `failed`）
  final String processingState;

  /// 解析のどの段か（`processing.step`。`classify` / `identify`）。段階2・3の写真には無い（null）
  final String? processingStep;

  /// AI の識別の結果（段階4）。識別の前と、図鑑の種類でない写真は null
  final PhotoIdentification? identification;

  /// コメント。無ければ null
  final String? comment;

  /// コメントを書いた主体（`user` / `ai`）。コメントが無ければ null
  final String? commentSource;

  /// 前回の解析のやり直しで利用者が書いた手がかり。無ければ null
  final String? hint;

  /// 利用者が写真の中の場所に付けたタグ（保存順。03 §5.7）
  final List<PhotoTag> tags;

  const Photo({
    required this.id,
    this.tripId,
    required this.imageUrl,
    this.thumbnailUrl,
    this.takenAt,
    this.takenAtSource,
    this.uploadedAt,
    this.latitude,
    this.longitude,
    this.placeName,
    this.category,
    this.categorySource,
    this.processingState = 'none',
    this.processingStep,
    this.identification,
    this.comment,
    this.commentSource,
    this.hint,
    this.tags = const [],
  });

  factory Photo.fromJson(Map<String, dynamic> json) {
    final location = json['location'] as Map<String, dynamic>?;
    final processing = json['processing'] as Map<String, dynamic>?;
    final identification = json['identification'] as Map<String, dynamic>?;
    return Photo(
      id: json['id'] as String,
      tripId: json['tripId'] as String?,
      imageUrl: json['imageUrl'] as String,
      thumbnailUrl: json['thumbnailUrl'] as String?,
      takenAt: json['takenAt'] as String?,
      takenAtSource: json['takenAtSource'] as String?,
      uploadedAt: json['uploadedAt'] as String?,
      latitude: (location?['latitude'] as num?)?.toDouble(),
      longitude: (location?['longitude'] as num?)?.toDouble(),
      placeName: location?['placeName'] as String?,
      category: json['category'] as String?,
      categorySource: json['categorySource'] as String?,
      processingState: processing?['state'] as String? ?? 'none',
      processingStep: processing?['step'] as String?,
      identification: identification == null
          ? null
          : PhotoIdentification.fromJson(identification),
      comment: json['comment'] as String?,
      commentSource: json['commentSource'] as String?,
      hint: json['hint'] as String?,
      tags: [
        for (final tag in json['tags'] as List<dynamic>? ?? const [])
          PhotoTag.fromJson(tag as Map<String, dynamic>),
      ],
    );
  }
}

/// 写真の中の場所に付けたタグ（docs/04_data_design.md §2。C-3）
class PhotoTag {
  /// 名前（同じ名前のタグが写真に何個あってもよい）
  final String name;

  /// 種類（カテゴリと同じ `plant` / `food` / `landscape` / `other`）
  final String kind;

  /// 向きを直した後の画像の中の位置の割合（左上が 0、右下が 1）
  final double x;
  final double y;

  const PhotoTag(
      {required this.name,
      required this.kind,
      required this.x,
      required this.y});

  factory PhotoTag.fromJson(Map<String, dynamic> json) => PhotoTag(
        name: json['name'] as String,
        kind: json['kind'] as String,
        x: (json['x'] as num).toDouble(),
        y: (json['y'] as num).toDouble(),
      );

  /// `PATCH /api/photos/{photoId}` の `tags` の要素
  Map<String, Object> toJson() => {'name': name, 'kind': kind, 'x': x, 'y': y};
}

/// AI の識別の結果（写真の `identification`。docs/04_data_design.md §2.1）のうち、画面が使う項目
class PhotoIdentification {
  /// 図鑑の種類（`plant` など）
  final String kind;

  /// 写真が分類のカテゴリに合っていたか。false なら図鑑の項目には入らない
  final bool matchesKind;

  /// 項目の名前（図鑑の項目を開く鍵）。分類と合わない写真（[matchesKind] が false）では null
  final String? name;

  const PhotoIdentification(
      {required this.kind, required this.matchesKind, required this.name});

  factory PhotoIdentification.fromJson(Map<String, dynamic> json) =>
      PhotoIdentification(
        kind: json['kind'] as String,
        matchesKind: json['matchesKind'] as bool,
        name: json['name'] as String?,
      );
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
