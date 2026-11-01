import 'package:flutter/material.dart';
import '../models/photo.dart';

/// 写真の画像と、その上のタグ（docs/03_screen_design.md §5.7。C-3）
///
/// タグの位置は画像の中の割合なので、画像の大きさを読んで、枠の中に縦横の比を保って中央に収めた範囲（[BoxFit.contain]）に置く。
/// 画像の大きさが分かるまでは、タグを出さず、タップも受けない
class TaggedPhotoImage extends StatefulWidget {
  const TaggedPhotoImage(
      {super.key,
      required this.image,
      required this.tags,
      required this.showTags,
      this.onTapAt,
      this.onTapTag});

  final ImageProvider image;
  final List<PhotoTag> tags;

  /// 写真の上にタグを出すか（上のバーと下の情報を出している間）
  final bool showTags;

  /// 画像の範囲の中をタップした（画像の中の割合）。null ならタップを受けず、外側の部品（上のバーの出し入れ）に譲る
  final ValueChanged<Offset>? onTapAt;

  /// タグの名前をタップした（タグの番号）。null なら受けない
  final ValueChanged<int>? onTapTag;

  @override
  State<TaggedPhotoImage> createState() => _TaggedPhotoImageState();
}

class _TaggedPhotoImageState extends State<TaggedPhotoImage> {
  /// 点の直径
  static const _dotSize = 12.0;

  /// タグ（点と名前）の高さ。点の中心がタグの位置に来るよう、この高さの中で縦の中央にそろえる
  static const _markerHeight = 24.0;

  ImageStream? _stream;
  late final _listener = ImageStreamListener((info, _) {
    final size =
        Size(info.image.width.toDouble(), info.image.height.toDouble());
    info.dispose();
    if (mounted && size != _imageSize) setState(() => _imageSize = size);
  });
  Size? _imageSize;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _resolve();
  }

  @override
  void didUpdateWidget(TaggedPhotoImage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.image != widget.image) _resolve();
  }

  @override
  void dispose() {
    _stream?.removeListener(_listener);
    super.dispose();
  }

  /// 画像の大きさを読む（読み込み済みの画像なので、すぐに届く）
  void _resolve() {
    final stream = widget.image.resolve(createLocalImageConfiguration(context));
    if (stream.key == _stream?.key) return;
    _stream?.removeListener(_listener);
    _stream = stream..addListener(_listener);
  }

  /// 大きさ [imageSize] の画像を、大きさ [box] の枠に縦横の比を保って中央に収めた範囲
  static Rect _fittedRect(Size imageSize, Size box) {
    final fitted = applyBoxFit(BoxFit.contain, imageSize, box).destination;
    return Alignment.center.inscribe(fitted, Offset.zero & box);
  }

  @override
  Widget build(BuildContext context) {
    final onTapAt = widget.onTapAt;
    final onTapTag = widget.onTapTag;
    return LayoutBuilder(builder: (context, constraints) {
      final imageSize = _imageSize;
      final rect = imageSize == null
          ? null
          : _fittedRect(imageSize, constraints.biggest);
      return GestureDetector(
        // タグを付ける間は、余白のタップも受けて何もしない（外側の部品に渡さない）
        behavior: onTapAt == null
            ? HitTestBehavior.deferToChild
            : HitTestBehavior.opaque,
        onTapUp: onTapAt == null
            ? null
            : (details) {
                final point = details.localPosition;
                if (rect == null || !rect.contains(point)) return;
                onTapAt(Offset((point.dx - rect.left) / rect.width,
                    (point.dy - rect.top) / rect.height));
              },
        child: Stack(
          fit: StackFit.expand,
          children: [
            Image(image: widget.image, fit: BoxFit.contain),
            if (widget.showTags && rect != null)
              for (final (index, tag) in widget.tags.indexed)
                Positioned(
                  left: rect.left + rect.width * tag.x - _dotSize / 2,
                  top: rect.top + rect.height * tag.y - _markerHeight / 2,
                  child: _TagMarker(
                      name: tag.name,
                      onTap: onTapTag == null ? null : () => onTapTag(index)),
                ),
          ],
        ),
      );
    });
  }
}

/// 写真の上のタグ（白い点と、その右に名前）
class _TagMarker extends StatelessWidget {
  const _TagMarker({required this.name, this.onTap});

  final String name;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: SizedBox(
        height: _TaggedPhotoImageState._markerHeight,
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: _TaggedPhotoImageState._dotSize,
              height: _TaggedPhotoImageState._dotSize,
              decoration: BoxDecoration(
                color: Colors.white,
                shape: BoxShape.circle,
                border: Border.all(color: Colors.black45),
              ),
            ),
            const SizedBox(width: 4),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
              decoration: BoxDecoration(
                color: Colors.black54,
                borderRadius: BorderRadius.circular(4),
              ),
              child: Text(name,
                  maxLines: 1,
                  style: const TextStyle(color: Colors.white, fontSize: 13)),
            ),
          ],
        ),
      ),
    );
  }
}
