import 'package:flutter/material.dart';
import '../models/photo.dart';

/// 吹き出しのしっぽの高さ（しっぽの先がタグの位置）
const _tailHeight = 8.0;

/// 吹き出しのしっぽの幅
const _tailWidth = 12.0;

/// 吹き出しの枠の太さ
const _borderWidth = 1.5;

/// 写真の画像と、その上のタグ（docs/03_screen_design.md §5.7・§5.9。C-3・C-4c）
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
                  left: rect.left + rect.width * tag.x,
                  top: rect.top + rect.height * tag.y,
                  // 吹き出しの横の中央と、しっぽの先（下の端）がタグの位置に来るように、自分の幅の半分・高さの分だけずらす
                  child: FractionalTranslation(
                    translation: const Offset(-0.5, -1),
                    child: _TagBubble(
                        name: tag.name,
                        onTap: onTapTag == null ? null : () => onTapTag(index)),
                  ),
                ),
          ],
        ),
      );
    });
  }
}

/// 写真の上のタグ（名前を書いた吹き出し。白地に黒い文字、黒い枠。下のしっぽの先がタグの位置。03 §5.9）
class _TagBubble extends StatelessWidget {
  const _TagBubble({required this.name, this.onTap});

  final String name;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: Colors.black87, width: _borderWidth),
              boxShadow: const [
                BoxShadow(
                    color: Colors.black38, blurRadius: 3, offset: Offset(0, 1))
              ],
            ),
            child: Text(name,
                maxLines: 1,
                style: const TextStyle(
                    color: Colors.black87,
                    fontSize: 13,
                    fontWeight: FontWeight.w600)),
          ),
          // 枠と同じ色の三角に、地の色の小さな三角を重ねて、しっぽにも枠を付ける
          const CustomPaint(
              size: Size(_tailWidth, _tailHeight), painter: _TailPainter()),
        ],
      ),
    );
  }
}

/// 吹き出しのしっぽ（下向きの三角。枠付き）
class _TailPainter extends CustomPainter {
  const _TailPainter();

  @override
  void paint(Canvas canvas, Size size) {
    final outer = Path()
      ..moveTo(0, -_borderWidth)
      ..lineTo(size.width, -_borderWidth)
      ..lineTo(size.width / 2, size.height)
      ..close();
    canvas.drawPath(outer, Paint()..color = Colors.black87);
    const inset = _borderWidth * 2;
    final inner = Path()
      ..moveTo(inset, -_borderWidth)
      ..lineTo(size.width - inset, -_borderWidth)
      ..lineTo(size.width / 2, size.height - inset * 1.5)
      ..close();
    canvas.drawPath(inner, Paint()..color = Colors.white);
  }

  @override
  bool shouldRepaint(_TailPainter oldDelegate) => false;
}
