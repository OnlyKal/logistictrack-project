import 'dart:math' as math;
import 'dart:ui' show PathMetric;

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../theme.dart';

/// Scène décorative de la connexion, identique à celle du web : un entrepôt, ses trajets
/// et les arrivées chez les destinataires. Aucune donnée réelle. Dimensions du plan : 800 × 560.
const _hub = Offset(400, 340);
const _planSize = Size(800, 560);

class _Route {
  _Route(this.to, this.duration, this.phase, void Function(Path path) build) {
    final path = Path()..moveTo(_hub.dx, _hub.dy);
    build(path);
    this.path = path;
    metric = path.computeMetrics().first;
  }

  final Offset to;
  final double duration;
  final double phase;
  late final Path path;
  late final PathMetric metric;
}

final _routes = [
  _Route(const Offset(130, 130), 11, 2, (p) => p
    ..lineTo(400, 250)
    ..quadraticBezierTo(400, 225, 375, 225)
    ..lineTo(155, 225)
    ..quadraticBezierTo(130, 225, 130, 200)
    ..lineTo(130, 130)),
  _Route(const Offset(670, 110), 13, 8, (p) => p
    ..lineTo(500, 340)
    ..quadraticBezierTo(525, 340, 525, 315)
    ..lineTo(525, 165)
    ..quadraticBezierTo(525, 140, 550, 140)
    ..lineTo(645, 140)
    ..quadraticBezierTo(670, 140, 670, 115)
    ..lineTo(670, 110)),
  _Route(const Offset(700, 470), 10, 5, (p) => p
    ..lineTo(560, 340)
    ..quadraticBezierTo(585, 340, 585, 365)
    ..lineTo(585, 445)
    ..quadraticBezierTo(585, 470, 610, 470)
    ..lineTo(700, 470)),
  _Route(const Offset(110, 450), 12, 10, (p) => p
    ..lineTo(320, 340)
    ..quadraticBezierTo(295, 340, 295, 365)
    ..lineTo(295, 425)
    ..quadraticBezierTo(295, 450, 270, 450)
    ..lineTo(110, 450)),
  _Route(const Offset(430, 60), 14, 4, (p) => p
    ..lineTo(400, 250)
    ..quadraticBezierTo(400, 225, 425, 225)
    ..lineTo(430, 225)
    ..quadraticBezierTo(445, 225, 445, 200)
    ..lineTo(445, 85)
    ..quadraticBezierTo(445, 60, 430, 60)),
];

class LoginScene extends StatefulWidget {
  const LoginScene({super.key});

  @override
  State<LoginScene> createState() => _LoginSceneState();
}

class _LoginSceneState extends State<LoginScene> with SingleTickerProviderStateMixin {
  late final AnimationController _ticker = AnimationController(vsync: this, duration: const Duration(minutes: 1));
  final _clock = Stopwatch()..start();

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // L'utilisateur qui a demandé moins d'animations voit une carte fixe.
    if (MediaQuery.disableAnimationsOf(context)) {
      _ticker.stop();
    } else if (!_ticker.isAnimating) {
      _ticker.repeat();
    }
  }

  @override
  void dispose() {
    _ticker.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final still = MediaQuery.disableAnimationsOf(context);
    return ColoredBox(
      color: Palette.night,
      child: Stack(fit: StackFit.expand, children: [
        const RepaintBoundary(child: CustomPaint(painter: _BackdropPainter())),
        RepaintBoundary(child: CustomPaint(painter: _ScenePainter(_ticker, _clock, still))),
      ]),
    );
  }
}

/// Place le plan entier dans la zone, sans jamais couper une destination.
double _fit(Canvas canvas, Size size) {
  final scale = math.min(size.width / _planSize.width, size.height / _planSize.height);
  canvas.translate((size.width - _planSize.width * scale) / 2, (size.height - _planSize.height * scale) / 2);
  canvas.scale(scale);
  return scale;
}

class _BackdropPainter extends CustomPainter {
  const _BackdropPainter();

  @override
  void paint(Canvas canvas, Size size) {
    canvas.clipRect(Offset.zero & size);
    final scale = math.min(size.width / _planSize.width, size.height / _planSize.height);
    final step = 28 * scale;
    final dot = Paint()..color = Colors.white.withValues(alpha: 0.1);
    for (var x = step / 2; x < size.width; x += step) {
      for (var y = step / 2; y < size.height; y += step) {
        canvas.drawCircle(Offset(x, y), math.max(0.7, 1.1 * scale), dot);
      }
    }
    _fit(canvas, size);
    final ring = Paint()
      ..style = PaintingStyle.stroke
      ..color = Colors.white.withValues(alpha: 0.07);
    for (final r in const [90.0, 170.0, 260.0]) {
      canvas.drawCircle(_hub, r, ring);
    }
  }

  @override
  bool shouldRepaint(_BackdropPainter oldDelegate) => false;
}

class _ScenePainter extends CustomPainter {
  _ScenePainter(this.ticker, this.clock, this.still) : super(repaint: ticker);

  final Animation<double> ticker;
  final Stopwatch clock;
  final bool still;

  static double _phase(double t, double duration) => (t % duration) / duration;

  /// Interpolation par paliers, comme les animations de la version web.
  static double _steps(double p, List<double> times, List<double> values) {
    for (var i = 1; i < times.length; i++) {
      if (p <= times[i]) {
        final span = times[i] - times[i - 1];
        return span == 0 ? values[i] : values[i - 1] + (values[i] - values[i - 1]) * ((p - times[i - 1]) / span);
      }
    }
    return values.last;
  }

  void _icon(Canvas canvas, IconData icon, Offset center, double size, Color color) {
    final text = TextPainter(
      text: TextSpan(text: String.fromCharCode(icon.codePoint), style: TextStyle(fontFamily: icon.fontFamily, package: icon.fontPackage, fontSize: size, color: color, height: 1)),
      textDirection: TextDirection.ltr,
    )..layout();
    text.paint(canvas, center - Offset(text.width / 2, text.height / 2));
    text.dispose();
  }

  @override
  void paint(Canvas canvas, Size size) {
    canvas.clipRect(Offset.zero & size);
    final t = clock.elapsedMilliseconds / 1000;
    final moving = !still;
    _fit(canvas, size);

    if (moving) {
      canvas.save();
      canvas.translate(_hub.dx, _hub.dy);
      canvas.rotate(-2 * math.pi * _phase(t, 16));
      final wedge = Path()
        ..moveTo(0, 0)
        ..lineTo(260, 0)
        ..arcTo(Rect.fromCircle(center: Offset.zero, radius: 260), 0, -math.pi / 6, false)
        ..close();
      canvas.drawPath(wedge, Paint()..color = Palette.blue.withValues(alpha: 0.13));
      canvas.drawLine(Offset.zero, const Offset(260, 0), Paint()
        ..color = Palette.blue.withValues(alpha: 0.7)
        ..strokeWidth = 1);
      canvas.restore();
    }

    final road = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.5
      ..color = Colors.white.withValues(alpha: 0.2);
    final flow = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2
      ..strokeCap = StrokeCap.round
      ..color = Palette.blue;
    final node = Paint()..color = Palette.night;
    final nodeLine = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.25
      ..color = Colors.white.withValues(alpha: 0.45);

    for (var i = 0; i < _routes.length; i++) {
      final route = _routes[i];
      final length = route.metric.length;
      final drawn = moving ? ((t - i * 0.12) / 1.4).clamp(0.0, 1.0) : 1.0;
      canvas.drawPath(route.metric.extractPath(0, length * drawn), road);

      // Tirets bleus qui avancent le long de la route.
      final dash = length * 0.015;
      final period = length * 0.065;
      final offset = moving ? (t / 3 * length * 0.13) % period : 0.0;
      for (var start = offset - period; start < length * drawn; start += period) {
        final from = math.max(0.0, start);
        final to = math.min(length * drawn, start + dash);
        if (to > from) canvas.drawPath(route.metric.extractPath(from, to), flow);
      }

      final p = _phase(t + route.phase, route.duration);
      if (moving) {
        final opacity = _steps(p, const [0, 0.86, 0.88, 1], const [0, 0, 0.9, 0]);
        if (opacity > 0) {
          canvas.drawCircle(route.to, _steps(p, const [0, 0.86, 1], const [10, 10, 44]), Paint()
            ..style = PaintingStyle.stroke
            ..strokeWidth = 2
            ..color = Palette.blue.withValues(alpha: opacity));
        }
      }
      canvas.drawCircle(route.to, 17, node);
      canvas.drawCircle(route.to, 17, nodeLine);
      _icon(canvas, LucideIcons.mapPin, route.to, 16, Colors.white);

      if (moving) {
        final opacity = _steps(p, const [0, 0.03, 0.85, 0.87, 1], const [0, 1, 1, 0, 0]);
        if (opacity > 0) {
          final position = route.metric.getTangentForOffset(length * (p / 0.86).clamp(0.0, 1.0))!.position;
          canvas.drawCircle(position, 13, Paint()..color = Palette.blue.withValues(alpha: 0.35 * opacity));
          canvas.drawCircle(position, 5.5, Paint()..color = Colors.white.withValues(alpha: opacity));
          canvas.drawCircle(position, 5.5, Paint()
            ..style = PaintingStyle.stroke
            ..strokeWidth = 2.5
            ..color = Palette.blue.withValues(alpha: opacity));
        }
      }
    }

    if (moving) {
      final p = _phase(t, 3.2);
      canvas.drawCircle(_hub, 28 + 34 * p, Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.5
        ..color = Colors.white.withValues(alpha: 0.5 * (1 - p)));
    }
    canvas.drawCircle(_hub, 28, Paint()..color = Palette.blue);
    _icon(canvas, LucideIcons.warehouse, _hub, 26, Colors.white);
  }

  @override
  bool shouldRepaint(_ScenePainter oldDelegate) => oldDelegate.still != still;
}
