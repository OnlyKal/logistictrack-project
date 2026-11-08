import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../core/models.dart';
import '../theme.dart';
import 'common.dart';
import 'proof_screen.dart';

/// Déclaration d'un échec : motif, commentaire et photo facultative.
class FailScreen extends StatefulWidget {
  const FailScreen({super.key, required this.mission});

  final Mission mission;

  @override
  State<FailScreen> createState() => _FailScreenState();
}

class _FailScreenState extends State<FailScreen> {
  String? _reason;
  final _comment = TextEditingController();
  String? _photo;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _comment.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_reason == null) {
      setState(() => _error = 'Sélectionnez un motif.');
      return;
    }
    final state = AppScope.of(context);
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await state.enqueue(deliveryId: widget.mission.id, action: 'fail', label: 'Échec de livraison', localStatus: 'FAILED', body: {'reason': _reason, if (_comment.text.trim().isNotEmpty) 'comment': _comment.text.trim()});
      if (_photo != null) {
        await state.enqueueProof(deliveryId: widget.mission.id, type: 'PHOTO_PLACE', filePath: _photo!, mime: 'image/jpeg');
        await state.sync();
      }
      if (!mounted) return;
      Navigator.of(context).popUntil((r) => r.isFirst);
      showMessage(context, 'Échec enregistré. Votre responsable est informé.');
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Livraison impossible')),
      body: ListView(padding: const EdgeInsets.all(14), children: [
        if (_error != null) Padding(padding: const EdgeInsets.only(bottom: 10), child: Text(_error!, style: const TextStyle(color: Palette.red))),
        SectionCard(title: 'Motif', children: [
          RadioGroup<String>(
            groupValue: _reason,
            onChanged: (v) => setState(() => _reason = v),
            child: Column(children: [
              for (final e in failureReasons.entries) RadioListTile<String>(contentPadding: EdgeInsets.zero, dense: true, value: e.key, title: Text(e.value, style: const TextStyle(fontSize: 15))),
            ]),
          ),
        ]),
        const SizedBox(height: 10),
        SectionCard(title: 'Détails', children: [
          TextField(controller: _comment, maxLines: 3, decoration: const InputDecoration(labelText: 'Commentaire')),
          const SizedBox(height: 8),
          OutlinedButton.icon(
            onPressed: () async {
              final shot = await ImagePicker().pickImage(source: ImageSource.camera, imageQuality: 70, maxWidth: 1600);
              if (shot == null) return;
              final path = await keepFile(await shot.readAsBytes(), 'jpg');
              setState(() => _photo = path);
            },
            icon: Icon(_photo == null ? LucideIcons.camera : LucideIcons.circleCheck, size: 18),
            label: Text(_photo == null ? 'Joindre une photo' : 'Photo ajoutée'),
          ),
        ]),
        const SizedBox(height: 16),
        FilledButton(onPressed: _busy ? null : _submit, child: const Text('Enregistrer l\'échec')),
      ]),
    );
  }
}

class IncidentScreen extends StatefulWidget {
  const IncidentScreen({super.key, required this.mission});

  final Mission mission;

  @override
  State<IncidentScreen> createState() => _IncidentScreenState();
}

class _IncidentScreenState extends State<IncidentScreen> {
  static const types = ['Panne', 'Accident', 'Retard', 'Marchandise endommagée', 'Autre'];
  String _type = types.first;
  final _text = TextEditingController();
  bool _busy = false;

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    setState(() => _busy = true);
    final state = AppScope.of(context);
    try {
      await state.enqueue(deliveryId: widget.mission.id, action: 'incidents', label: 'Incident', body: {'type': _type, if (_text.text.trim().isNotEmpty) 'description': _text.text.trim()});
      if (!mounted) return;
      Navigator.of(context).pop();
      showMessage(context, 'Incident signalé.');
    } catch (e) {
      if (mounted) showMessage(context, '$e', error: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Signaler un incident')),
      body: ListView(padding: const EdgeInsets.all(14), children: [
        SectionCard(children: [
          DropdownButtonFormField<String>(initialValue: _type, decoration: const InputDecoration(labelText: 'Type'), items: [for (final t in types) DropdownMenuItem(value: t, child: Text(t))], onChanged: (v) => setState(() => _type = v ?? _type)),
          const SizedBox(height: 10),
          TextField(controller: _text, maxLines: 4, decoration: const InputDecoration(labelText: 'Description')),
        ]),
        const SizedBox(height: 16),
        FilledButton(onPressed: _busy ? null : _submit, child: const Text('Envoyer')),
      ]),
    );
  }
}
