import 'package:flutter/material.dart';

/// サムネイルの読み上げのラベルに足す、お気に入りの印の言葉（docs/03_screen_design.md §5.10.3）
const favoriteMarkLabel = '、お気に入り';

/// サムネイルの右上に置く、お気に入りの印（塗ったハート。§5.10.3）
///
/// サムネイルの `Stack` に置く。読み上げはサムネイルのラベルの [favoriteMarkLabel] で伝えるので、印そのものは読ませない。
/// 旅行詳細の写真の一覧（`PhotoGrid`）とタイムラインのサムネイル（`TimelineThumbnail`）で同じ印にする
class FavoriteMark extends StatelessWidget {
  const FavoriteMark({super.key});

  @override
  Widget build(BuildContext context) {
    return const Positioned(
      right: 4,
      top: 4,
      child: ExcludeSemantics(
        child: Icon(Icons.favorite, size: 16, color: Colors.white),
      ),
    );
  }
}
