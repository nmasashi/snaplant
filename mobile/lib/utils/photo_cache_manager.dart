import 'package:flutter/foundation.dart';
import 'package:flutter_cache_manager/flutter_cache_manager.dart';

/// 旅行アルバムの写真用のキャッシュ（docs/03_screen_design.md §3）
///
/// 既定のキャッシュは 200 件までで、数百枚の旅行を見ると入れ替わり続ける。写真用に上限を上げて分ける。
/// キーは URL ではなく写真の id から作る（[thumbnailCacheKey]・[imageCacheKey]）。SAS 付きの URL は応答のたびに変わるので、
/// URL をキーにするとキャッシュが効かない
///
/// 上限は件数でしか決められない（バイト数では決められない）。サムネイル（数十KB）と原寸（数MB）を同じ上限にすると
/// 原寸で端末の容量を使い切るので、分ける
class PhotoCacheManager {
  static final CacheManager _defaultThumbnails = CacheManager(
    Config(
      'travelAlbumThumbnails',
      stalePeriod: const Duration(days: 30),
      maxNrOfCacheObjects: 2000,
    ),
  );

  static final CacheManager _defaultImages = CacheManager(
    Config(
      'travelAlbumImages',
      stalePeriod: const Duration(days: 7),
      maxNrOfCacheObjects: 100,
    ),
  );

  /// サムネイルと旅行の表紙。数百枚の旅行をいくつか見ても入れ替わらない件数
  static CacheManager get thumbnails => _testOverride ?? _defaultThumbnails;

  /// 原寸（写真ビューアと、サムネイルの無い写真のグリッド）。1枚が大きいので少なくする
  static CacheManager get images => _testOverride ?? _defaultImages;

  static CacheManager? _testOverride;

  /// サムネイルと原寸のキャッシュを [manager] に差し替える（null で戻す）。テストだけが使う。
  /// テストの環境では画像の HTTP がいつも失敗し、写真の上のタグ（03 §5.7）が画像の大きさを知れないので、
  /// 画像を読み込ませるテストは、取りに行く先を偽のサーバにし、置き場を端末のディレクトリでないものにしたキャッシュに替える
  @visibleForTesting
  static set testOverride(CacheManager? manager) => _testOverride = manager;
}

/// サムネイルのキャッシュのキー
String thumbnailCacheKey(String photoId) => 'thumb-$photoId';

/// 原寸のキャッシュのキー
String imageCacheKey(String photoId) => 'photo-$photoId';

/// 旅行と図鑑の項目の表紙のキャッシュのキー。応答に写真の id が無いので、SAS（クエリ）を除いた Blob の URL から作る。
/// 図鑑の一覧は、項目詳細から戻ったときに表紙が同じ写真かをこのキーで比べる（署名は読むたびに変わる）。形を変えるときは署名を含めないこと
String coverCacheKey(String coverThumbnailUrl) {
  final uri = Uri.parse(coverThumbnailUrl);
  return 'cover-${uri.host}${uri.path}';
}
