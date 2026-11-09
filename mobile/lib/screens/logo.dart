import 'package:flutter/material.dart';

import '../theme.dart';

/// Logo de l'application LogisticTrack : carré bleu, « LT » blanc.
/// Même dessin que le favicon du site et que l'icône de l'application.
class LogoMark extends StatelessWidget {
  const LogoMark({super.key, this.size = 26});

  final double size;

  @override
  Widget build(BuildContext context) => Semantics(
        label: 'LogisticTrack',
        child: CustomPaint(size: Size.square(size), painter: const _LogoPainter()),
      );
}

class _LogoPainter extends CustomPainter {
  const _LogoPainter();

  @override
  void paint(Canvas canvas, Size size) {
    // Grille de 32, comme favicon.svg.
    canvas.scale(size.width / 32);
    canvas.drawRRect(RRect.fromRectAndRadius(const Rect.fromLTWH(0, 0, 32, 32), const Radius.circular(8)), Paint()..color = Palette.blue);
    final stroke = Paint()
      ..color = Colors.white
      ..style = PaintingStyle.stroke
      ..strokeWidth = 3
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;
    canvas.drawPath(Path()
      ..moveTo(10, 8)
      ..lineTo(10, 22)
      ..lineTo(22, 22), stroke);
    canvas.drawPath(Path()
      ..moveTo(15, 8)
      ..lineTo(24, 8)
      ..moveTo(19.5, 8)
      ..lineTo(19.5, 17), stroke);
  }

  @override
  bool shouldRepaint(_LogoPainter oldDelegate) => false;
}
