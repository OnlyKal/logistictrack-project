import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../theme.dart';

/// Scan des QR Codes. Le contrôle se fait d'abord localement, donc aussi sans réseau.
class ScanScreen extends StatefulWidget {
  const ScanScreen({super.key, required this.title, required this.expected, required this.alreadyScanned, required this.onScanned});

  final String title;

  /// jeton du QR Code → numéro de suivi
  final Map<String, String> expected;
  final Set<String> alreadyScanned;
  final Future<void> Function(String token) onScanned;

  @override
  State<ScanScreen> createState() => _ScanScreenState();
}

class _ScanScreenState extends State<ScanScreen> {
  late final Set<String> _done = {...widget.alreadyScanned};
  final MobileScannerController _controller = MobileScannerController(detectionSpeed: DetectionSpeed.noDuplicates);
  String? _message;
  bool _error = false;
  Timer? _clear;

  @override
  void dispose() {
    _clear?.cancel();
    _controller.dispose();
    super.dispose();
  }

  void _show(String message, {bool error = false}) {
    setState(() {
      _message = message;
      _error = error;
    });
    _clear?.cancel();
    _clear = Timer(const Duration(seconds: 3), () {
      if (mounted) setState(() => _message = null);
    });
  }

  Future<void> _onDetect(BarcodeCapture capture) async {
    for (final code in capture.barcodes) {
      final token = code.rawValue;
      if (token == null) continue;
      if (!widget.expected.containsKey(token)) {
        _show('Ce colis ne fait pas partie de cette mission.', error: true);
        continue;
      }
      if (_done.contains(token)) continue;
      setState(() => _done.add(token));
      await widget.onScanned(token);
      if (!mounted) return;
      _show('Colis ${widget.expected[token]} scanné.');
    }
  }

  @override
  Widget build(BuildContext context) {
    final total = widget.expected.length;
    final remaining = widget.expected.entries.where((e) => !_done.contains(e.key)).toList();
    return Scaffold(
      appBar: AppBar(title: Text(widget.title), actions: [IconButton(tooltip: 'Lampe', icon: const Icon(LucideIcons.flashlight), onPressed: _controller.toggleTorch)]),
      body: Column(children: [
        Expanded(
          child: Stack(fit: StackFit.expand, children: [
            MobileScanner(
              controller: _controller,
              onDetect: _onDetect,
              errorBuilder: (context, error) => Container(
                color: Palette.night,
                padding: const EdgeInsets.all(24),
                alignment: Alignment.center,
                child: const Text('Caméra indisponible. Vérifiez l\'autorisation dans les réglages du téléphone.', textAlign: TextAlign.center, style: TextStyle(color: Colors.white)),
              ),
            ),
            if (_message != null)
              Positioned(
                left: 16, right: 16, bottom: 16,
                child: Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(color: _error ? Palette.red : Palette.night, borderRadius: BorderRadius.circular(10)),
                  child: Text(_message!, style: const TextStyle(color: Colors.white)),
                ),
              ),
          ]),
        ),
        Container(
          color: Colors.white,
          padding: const EdgeInsets.all(14),
          child: SafeArea(
            top: false,
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
              Text('${total - remaining.length} sur $total colis scannés', style: const TextStyle(fontWeight: FontWeight.w600)),
              const SizedBox(height: 4),
              if (remaining.isNotEmpty) Text('Restants : ${remaining.take(3).map((e) => e.value).join(', ')}${remaining.length > 3 ? '…' : ''}', style: const TextStyle(color: Palette.muted, fontSize: 13)),
              const SizedBox(height: 10),
              FilledButton(onPressed: () => Navigator.of(context).pop(), child: Text(remaining.isEmpty ? 'Terminé' : 'Fermer')),
            ]),
          ),
        ),
      ]),
    );
  }
}
