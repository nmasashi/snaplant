import 'package:flutter_cache_manager/flutter_cache_manager.dart';

/// 旅行アルバムの写真用のキャッシュ（docs/travel-album/03_screen_design.md §3）
///
/// 既定のキャッシュは 200 件までで、数百枚の旅行を見ると入れ替わり続ける。写真用に上限を上げて分ける。
/// キーは URL ではなく写真の id から作る（[thumbnailCacheKey]・[imageCacheKey]）。SAS 付きの URL は応答のたびに変わるので、
/// URL をキーにするとキャッシュが効かない
///
/// 上限は件数でしか決められない（バイト数では決められない）。サムネイル（数十KB）と原寸（数MB）を同じ上限にすると
/// 原寸で端末の容量を使い切るので、分ける
class PhotoCacheManager {
  /// サムネイルと旅行の表紙。数百枚の旅行をいくつか見ても入れ替わらない件数
  static final CacheManager thumbnails = CacheManager(
    Config(
      'travelAlbumThumbnails',
      stalePeriod: const Duration(days: 30),
      maxNrOfCacheObjects: 2000,
    ),
  );

  /// 原寸（写真ビューアと、サムネイルの無い写真のグリッド）。1枚が大きいので少なくする
  static final CacheManager images = CacheManager(
    Config(
      'travelAlbumImages',
      stalePeriod: const Duration(days: 7),
      maxNrOfCacheObjects: 100,
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
