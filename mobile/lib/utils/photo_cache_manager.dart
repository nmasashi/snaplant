import 'package:flutter_cache_manager/flutter_cache_manager.dart';

/// 旅行アルバムの写真用のキャッシュ（docs/travel-album/03_screen_design.md §3）
///
/// 既定のキャッシュは 200 件までで、数百枚の旅行を見ると入れ替わり続ける。写真用に上限を上げて分ける。
/// キーは URL ではなく写真の id から作る（[thumbnailCacheKey]・[imageCacheKey]）。SAS 付きの URL は応答のたびに変わるので、
/// URL をキーにするとキャッシュが効かない
class PhotoCacheManager {
  static const _key = 'travelAlbumPhotos';

  static final CacheManager instance = CacheManager(
    Config(
      _key,
      stalePeriod: const Duration(days: 30),
      maxNrOfCacheObjects: 2000,
    ),
  );
}

/// サムネイルのキャッシュのキー
String thumbnailCacheKey(String photoId) => 'thumb-$photoId';

/// 原寸のキャッシュのキー
String imageCacheKey(String photoId) => 'photo-$photoId';

/// 旅行の表紙のキャッシュのキー。応答に写真の id が無いので、SAS（クエリ）を除いた Blob の URL から作る
String coverCacheKey(String coverThumbnailUrl) {
  final uri = Uri.parse(coverThumbnailUrl);
  return 'cover-${uri.host}${uri.path}';
}
