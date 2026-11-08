import 'dart:io';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:signature/signature.dart';
import 'package:uuid/uuid.dart';

import '../core/models.dart';
import '../theme.dart';
import 'common.dart';

/// Conserve un fichier dans le dossier privé de l'application jusqu'à son envoi.
Future<String> keepFile(List<int> bytes, String extension) async {
  final dir = Directory(p.join((await getApplicationSupportDirectory()).path, 'proofs'));
  await dir.create(recursive: true);
  final file = File(p.join(dir.path, '${const Uuid().v4()}.$extension'));
  await file.writeAsBytes(bytes, flush: true);
  return file.path;
}

class _Line {
  _Line(this.item);
  final Map<String, dynamic> item;
  late final delivered = TextEditingController(text: '${item['quantity']}');
  final refused = TextEditingController(text: '0');
  final missing = TextEditingController(text: '0');
  final reason = TextEditingController();

  double get planned => (item['quantity'] as num).toDouble();
  double _v(TextEditingController c) => double.tryParse(c.text.replaceAll(',', '.')) ?? -1;
  double get d => _v(delivered);
  double get r => _v(refused);
  double get m => _v(missing);
}

/// Remise au destinataire : collecte les preuves exigées par l'entreprise.
class ProofScreen extends StatefulWidget {
  const ProofScreen({super.key, required this.mission, this.partial = false});

  final Mission mission;
  final bool partial;

  @override
  State<ProofScreen> createState() => _ProofScreenState();
}

class _ProofScreenState extends State<ProofScreen> {
  final _name = TextEditingController();
  final _phone = TextEditingController();
  final _signature = SignatureController(penStrokeWidth: 2.5, penColor: Palette.night, exportBackgroundColor: Colors.white);
  final _picker = ImagePicker();
  late final List<_Line> _lines = widget.mission.items.map(_Line.new).toList();
  String? _goods;
  String? _place;
  String? _error;
  bool _busy = false;

  @override
  void dispose() {
    _name.dispose();
    _phone.dispose();
    _signature.dispose();
    super.dispose();
  }

  Future<void> _photo(bool goods) async {
    final shot = await _picker.pickImage(source: ImageSource.camera, imageQuality: 70, maxWidth: 1600);
    if (shot == null) return;
    final path = await keepFile(await shot.readAsBytes(), 'jpg');
    setState(() => goods ? _goods = path : _place = path);
  }

  String? _validate() {
    final rules = AppScope.of(context).rules;
    if (rules.recipientName && _name.text.trim().length < 2) return 'Saisissez le nom du réceptionnaire.';
    if (rules.signature && _signature.isEmpty) return 'La signature du réceptionnaire est obligatoire.';
    if (rules.photo && _goods == null && _place == null) return 'Une photo est obligatoire.';
    if (widget.partial) {
      var short = false;
      var any = false;
      for (final l in _lines) {
        if (l.d < 0 || l.r < 0 || l.m < 0) return 'Vérifiez les quantités saisies.';
        if ((l.d + l.r + l.m - l.planned).abs() > 0.0001) return 'Pour ${(l.item['product'] as Map)['name']}, remis + refusé + manquant doit faire ${formatNum(l.planned)}.';
        if ((l.r > 0 || l.m > 0) && l.reason.text.trim().isEmpty) return 'Indiquez le motif de l\'écart pour ${(l.item['product'] as Map)['name']}.';
        short = short || l.r > 0 || l.m > 0;
        any = any || l.d > 0;
      }
      if (!any) return 'Aucune quantité remise : utilisez « Livraison impossible ».';
      if (!short) return 'Aucun écart : utilisez la remise complète.';
    }
    return null;
  }

  Future<void> _submit() async {
    final problem = _validate();
    if (problem != null) {
      setState(() => _error = problem);
      return;
    }
    final state = AppScope.of(context);
    setState(() {
      _busy = true;
      _error = state.rules.gps ? 'Recherche de votre position GPS…' : null;
    });
    // Une seule position, obtenue maintenant, pour la confirmation et toutes ses preuves.
    // Le suivi s'arrête à l'arrivée : la dernière position connue peut être trop ancienne.
    final position = await state.proofPosition();
    if (!mounted) return;
    if (state.rules.gps && position == null) {
      setState(() {
        _busy = false;
        _error = 'Votre entreprise exige une position GPS et le téléphone n\'en obtient pas. Vérifiez que la localisation est activée, placez-vous à découvert, puis réessayez.';
      });
      return;
    }
    setState(() => _error = null);
    final m = widget.mission;
    try {
      if (_signature.isNotEmpty) {
        final png = await _signature.toPngBytes();
        if (png != null) await state.enqueueProof(deliveryId: m.id, type: 'SIGNATURE', filePath: await keepFile(png, 'png'), mime: 'image/png', position: position);
      }
      if (_goods != null) await state.enqueueProof(deliveryId: m.id, type: 'PHOTO_GOODS', filePath: _goods!, mime: 'image/jpeg', position: position);
      if (_place != null) await state.enqueueProof(deliveryId: m.id, type: 'PHOTO_PLACE', filePath: _place!, mime: 'image/jpeg', position: position);
      final body = <String, dynamic>{
        if (_name.text.trim().isNotEmpty) 'recipientName': _name.text.trim(),
        if (_phone.text.trim().isNotEmpty) 'recipientPhone': _phone.text.trim(),
        if (position != null) 'latitude': position.latitude,
        if (position != null) 'longitude': position.longitude,
      };
      if (widget.partial) {
        await state.enqueue(deliveryId: m.id, action: 'partial-confirm', label: 'Livraison partielle', localStatus: 'PARTIALLY_DELIVERED', body: {
          ...body,
          'items': [for (final l in _lines) {'deliveryItemId': l.item['id'], 'delivered': l.d, 'refused': l.r, 'missing': l.m, if (l.reason.text.trim().isNotEmpty) 'reason': l.reason.text.trim()}],
        });
      } else {
        await state.enqueue(deliveryId: m.id, action: 'confirm', label: 'Confirmation de livraison', localStatus: 'DELIVERED', body: body);
      }
      if (!mounted) return;
      Navigator.of(context).popUntil((route) => route.isFirst);
      final refused = state.failedOps.where((o) => o.deliveryId == m.id).toList();
      if (refused.isNotEmpty) {
        showMessage(context, 'Refus du serveur : ${refused.first.error}', error: true);
      } else if (state.ops.any((o) => o.deliveryId == m.id)) {
        showMessage(context, 'Enregistré. La confirmation sera définitive après l\'envoi au serveur.');
      } else {
        showMessage(context, 'Livraison confirmée par le serveur.');
      }
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Widget _photoTile(String label, String? path, VoidCallback onTap) => OutlinedButton.icon(
        onPressed: onTap,
        icon: Icon(path == null ? LucideIcons.camera : LucideIcons.circleCheck, size: 18, color: path == null ? null : Palette.green),
        label: Text(path == null ? label : '$label : ajoutée'),
      );

  @override
  Widget build(BuildContext context) {
    final rules = AppScope.of(context).rules;
    return Scaffold(
      appBar: AppBar(title: Text(widget.partial ? 'Livraison partielle' : 'Remise au destinataire')),
      body: ListView(padding: const EdgeInsets.all(14), children: [
        if (_error != null) ...[
          Container(padding: const EdgeInsets.all(12), decoration: BoxDecoration(color: Palette.redSoft, borderRadius: BorderRadius.circular(10)), child: Text(_error!, style: const TextStyle(color: Palette.red, fontSize: 13))),
          const SizedBox(height: 10),
        ],
        if (widget.partial) ...[
          for (final l in _lines) ...[
            SectionCard(title: '${(l.item['product'] as Map)['name']} (prévu : ${formatNum(l.planned)} ${(l.item['product'] as Map)['baseUnit']})', children: [
              Row(children: [
                Expanded(child: TextField(controller: l.delivered, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Remis'))),
                const SizedBox(width: 8),
                Expanded(child: TextField(controller: l.refused, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Refusé'))),
                const SizedBox(width: 8),
                Expanded(child: TextField(controller: l.missing, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Manquant'))),
              ]),
              const SizedBox(height: 8),
              TextField(controller: l.reason, decoration: const InputDecoration(labelText: 'Motif de l\'écart')),
            ]),
            const SizedBox(height: 10),
          ],
        ],
        SectionCard(title: 'Réceptionnaire', children: [
          TextField(controller: _name, textCapitalization: TextCapitalization.words, decoration: InputDecoration(labelText: rules.recipientName ? 'Nom complet *' : 'Nom complet')),
          const SizedBox(height: 8),
          TextField(controller: _phone, keyboardType: TextInputType.phone, decoration: const InputDecoration(labelText: 'Téléphone')),
        ]),
        const SizedBox(height: 10),
        SectionCard(title: rules.signature ? 'Signature *' : 'Signature', children: [
          ClipRRect(
            borderRadius: BorderRadius.circular(10),
            child: Container(decoration: BoxDecoration(border: Border.all(color: Palette.line), borderRadius: BorderRadius.circular(10)), child: Signature(controller: _signature, height: 170, backgroundColor: Colors.white)),
          ),
          Align(alignment: Alignment.centerRight, child: TextButton.icon(onPressed: _signature.clear, icon: const Icon(LucideIcons.eraser, size: 16), label: const Text('Effacer'))),
          const Text('Preuve opérationnelle, non constitutive d\'une signature électronique qualifiée.', style: TextStyle(color: Palette.muted, fontSize: 12)),
        ]),
        const SizedBox(height: 10),
        SectionCard(title: rules.photo ? 'Photos *' : 'Photos', children: [
          _photoTile('Photo de la marchandise', _goods, () => _photo(true)),
          const SizedBox(height: 8),
          _photoTile('Photo du lieu', _place, () => _photo(false)),
        ]),
        const SizedBox(height: 16),
        FilledButton(onPressed: _busy ? null : _submit, child: _busy ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white)) : Text(widget.partial ? 'Enregistrer la livraison partielle' : 'Confirmer la livraison')),
        const SizedBox(height: 16),
      ]),
    );
  }
}
