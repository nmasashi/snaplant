import 'dart:math' as math;

import 'package:flutter/material.dart';
import '../models/photo.dart';

/// 吹き出しのしっぽの高さ（しっぽの先がタグの位置）
const _tailHeight = 8.0;

/// 吹き出しのしっぽの幅
const _tailWidth = 12.0;

/// 吹き出しの枠の太さ
const _borderWidth = 1.5;

/// 吹き出しの中の余白
const _labelPadding = EdgeInsets.symmetric(horizontal: 10, vertical: 4);

/// 吹き出しの名前の文字
const _labelStyle =
    TextStyle(color: Colors.black87, fontSize: 13, fontWeight: FontWeight.w600);

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

  /// 吹き出しの箱の高さ（1行の名前と余白と枠）。上の端に入りきるかを、箱を置く前に決めるのに使う
  static double _labelHeight(BuildContext context) {
    final painter = TextPainter(
        text: const TextSpan(text: 'あ', style: _labelStyle),
        textScaler: MediaQuery.textScalerOf(context),
        textDirection: TextDirection.ltr,
        maxLines: 1)
      ..layout();
    final height = painter.height + _labelPadding.vertical + _borderWidth * 2;
    painter.dispose();
    return height;
  }

  /// 位置 [point]（枠の中の座標）のタグの吹き出し（箱としっぽ）。
  /// しっぽの先は位置に置き、箱は位置の上に出す。上の端に入りきらなければ位置の下に出し、左右は枠の中に収まるまでずらす（03 §5.9）
  static List<Widget> _bubble(
      Offset point, String name, double labelHeight, VoidCallback? onTap) {
    final below = point.dy < labelHeight + _tailHeight;
    return [
      Positioned.fill(
        child: CustomSingleChildLayout(
          delegate: _LabelLayout(point: point, below: below),
          child: GestureDetector(onTap: onTap, child: _TagLabel(name: name)),
        ),
      ),
      Positioned(
        left: point.dx - _tailWidth / 2,
        top: below ? point.dy : point.dy - _tailHeight,
        child: GestureDetector(
          onTap: onTap,
          child: CustomPaint(
              size: const Size(_tailWidth, _tailHeight),
              painter: _TailPainter(up: below)),
        ),
      ),
    ];
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
                ..._bubble(
                    Offset(rect.left + rect.width * tag.x,
                        rect.top + rect.height * tag.y),
                    tag.name,
                    _labelHeight(context),
                    onTapTag == null ? null : () => onTapTag(index)),
          ],
        ),
      );
    });
  }
}

/// 吹き出しの箱を、位置 [point] の上（[below] なら下）に、横の中央をそろえて置く。枠の左右からはみ出すなら、収まるまでずらす（03 §5.9）
class _LabelLayout extends SingleChildLayoutDelegate {
  const _LabelLayout({required this.point, required this.below});

  final Offset point;
  final bool below;

  @override
  BoxConstraints getConstraintsForChild(BoxConstraints constraints) =>
      constraints.loosen();

  @override
  Offset getPositionForChild(Size size, Size childSize) {
    final left = (point.dx - childSize.width / 2)
        .clamp(0.0, math.max(0.0, size.width - childSize.width))
        .toDouble();
    final top = below
        ? point.dy + _tailHeight
        : point.dy - _tailHeight - childSize.height;
    return Offset(left, top);
  }

  @override
  bool shouldRelayout(_LabelLayout oldDelegate) =>
      point != oldDelegate.point || below != oldDelegate.below;
}

/// 吹き出しの箱（名前。白地に黒い文字、黒い枠。枠の幅に入りきらなければ末尾を「…」で切る。03 §5.9）
class _TagLabel extends StatelessWidget {
  const _TagLabel({required this.name});

  final String name;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: _labelPadding,
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: Colors.black87, width: _borderWidth),
        boxShadow: const [
          BoxShadow(color: Colors.black38, blurRadius: 3, offset: Offset(0, 1))
        ],
      ),
      child: Text(name,
          maxLines: 1,
          softWrap: false,
          overflow: TextOverflow.ellipsis,
          style: _labelStyle),
    );
  }
}

/// 吹き出しのしっぽ（三角。先がタグの位置。[up] なら上向き）。
/// 枠と同じ色の三角に、地の色の小さな三角を重ねて、しっぽにも枠を付ける。付け根は箱の枠に重ねて、枠の線を消す
class _TailPainter extends CustomPainter {
  const _TailPainter({required this.up});

  final bool up;

  @override
  void paint(Canvas canvas, Size size) {
    if (up) {
      canvas.translate(0, size.height);
      canvas.scale(1, -1);
    }
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
  bool shouldRepaint(_TailPainter oldDelegate) => up != oldDelegate.up;
}
