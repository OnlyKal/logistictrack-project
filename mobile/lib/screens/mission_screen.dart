import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:url_launcher/url_launcher.dart';

import '../core/app_state.dart';
import '../core/models.dart';
import '../theme.dart';
import 'common.dart';
import 'proof_screen.dart';
import 'report_screens.dart';
import 'scan_screen.dart';

class MissionScreen extends StatefulWidget {
  const MissionScreen({super.key, required this.missionId});

  final String missionId;

  @override
  State<MissionScreen> createState() => _MissionScreenState();
}

class _MissionScreenState extends State<MissionScreen> {
  bool _busy = false;
  Set<String> _scanned = {};

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _loadScans();
  }

  Future<void> _loadScans() async {
    final tokens = await AppScope.of(context).scannedTokens(widget.missionId, 'LOAD');
    if (mounted) setState(() => _scanned = tokens);
  }

  Future<void> _run(Future<void> Function() action, {String? message}) async {
    setState(() => _busy = true);
    try {
      await action();
      if (mounted && message != null) showMessage(context, message);
    } catch (e) {
      if (mounted) showMessage(context, '$e', error: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// Un scan refusé par le serveur ne compte pas, même s'il est mémorisé sur le téléphone.
  bool _isScanned(Map<String, dynamic> p) {
    if (p['loadScannedAt'] != null) return true;
    final token = p['qrToken'];
    if (!_scanned.contains(token)) return false;
    return !AppScope.of(context).failedOps.any((o) => o.path == '/packages/scan' && o.body['token'] == token);
  }

  Future<void> _scanPackages(AppState state, Mission m) async {
    final tokens = {for (final p in m.packages) p['qrToken'] as String: p['trackingNumber'] as String};
    await Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => ScanScreen(
        title: 'Scanner les colis',
        expected: tokens,
        alreadyScanned: {for (final p in m.packages) if (_isScanned(p)) p['qrToken'] as String},
        onScanned: (token) => state.enqueueScan(deliveryId: m.id, token: token, action: 'LOAD'),
      ),
    ));
    await _loadScans();
  }

  /// Information claire du chauffeur avant toute collecte de sa position.
  Future<bool> _trackingConsent() async {
    return await showDialog<bool>(
          context: context,
          barrierDismissible: false,
          builder: (c) => AlertDialog(
            icon: const Icon(LucideIcons.mapPin, color: Palette.blue),
            title: const Text('Suivi de votre position'),
            content: const Text('Pendant le trajet, le GPS de votre téléphone transmet votre position, votre vitesse et le niveau de batterie à votre entreprise, même écran verrouillé.\n\nLe suivi s\'arrête dès que vous indiquez votre arrivée.'),
            actions: [TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Annuler')), FilledButton(style: FilledButton.styleFrom(minimumSize: const Size(100, 42)), onPressed: () => Navigator.pop(c, true), child: const Text('Démarrer'))],
          ),
        ) ??
        false;
  }

  Future<void> _start(AppState state, Mission m) async {
    if (!await _trackingConsent()) return;
    await _run(() async {
      await state.enqueue(deliveryId: m.id, action: 'start', label: 'Départ', localStatus: 'IN_TRANSIT');
      final started = await state.startTracking(m.id);
      if (!started && mounted) showMessage(context, 'Mission démarrée sans suivi GPS : ${state.gpsMessage}', error: true);
    });
  }

  Future<void> _navigate(Mission m) async {
    final lat = m.point['latitude'];
    final lng = m.point['longitude'];
    final uri = lat != null && lng != null
        ? Uri.parse('https://www.google.com/maps/dir/?api=1&destination=$lat,$lng')
        : Uri.parse('https://www.google.com/maps/search/?api=1&query=${Uri.encodeComponent(m.destination)}');
    if (!await launchUrl(uri, mode: LaunchMode.externalApplication) && mounted) showMessage(context, 'Aucune application de navigation disponible.', error: true);
  }

  Future<void> _call(String? phone) async {
    if (phone == null) return;
    await launchUrl(Uri(scheme: 'tel', path: phone));
  }

  Future<void> _refuse(AppState state, Mission m) async {
    // null : annulé ; chaîne vide : refus sans motif.
    final note = await showDialog<String>(context: context, builder: (_) => const _RefuseDialog());
    if (note == null || !mounted) return;
    await _run(() async {
      await state.respond(m.id, false, note: note.isEmpty ? null : note);
      if (mounted) Navigator.of(context).pop();
    }, message: 'Mission refusée.');
  }

  List<Widget> _actions(AppState state, Mission m) {
    final rules = state.rules;
    final loading = _busy;
    FilledButton primary(String label, IconData icon, VoidCallback onTap) => FilledButton.icon(onPressed: loading ? null : onTap, icon: Icon(icon, size: 19), label: Text(label));
    OutlinedButton secondary(String label, IconData icon, VoidCallback onTap) => OutlinedButton.icon(onPressed: loading ? null : onTap, icon: Icon(icon, size: 18), label: Text(label));
    const gap = SizedBox(height: 8);
    switch (m.status) {
      // Abonnement expiré : le serveur refuse d'accepter, de scanner ou de charger une nouvelle mission.
      // Une mission déjà chargée peut, elle, aller jusqu'au bout.
      case 'ASSIGNED' when !rules.subscriptionActive:
        return const [
          Text(
            'Abonnement de votre entreprise expiré : cette mission ne peut pas être chargée. Contactez votre responsable.',
            textAlign: TextAlign.center,
            style: TextStyle(color: Palette.orange, fontSize: 13),
          ),
        ];
      case 'ASSIGNED':
        final accepted = m.driverResponse == 'ACCEPTED' || !rules.driversCanRefuse;
        if (!accepted) {
          return [
            primary('Accepter la mission', LucideIcons.check, () => _run(() => state.respond(m.id, true), message: 'Mission acceptée.')),
            gap,
            secondary('Refuser', LucideIcons.x, () => _refuse(state, m)),
          ];
        }
        final missing = rules.qrOnLoad ? m.packages.where((p) => !_isScanned(p)).length : 0;
        return [
          secondary(missing > 0 ? 'Scanner les colis ($missing restants)' : 'Scanner les colis', LucideIcons.scanLine, () => _scanPackages(state, m)),
          gap,
          FilledButton.icon(
            onPressed: loading || missing > 0 ? null : () => _run(() => state.enqueue(deliveryId: m.id, action: 'load', label: 'Chargement', localStatus: 'LOADED'), message: 'Chargement enregistré.'),
            icon: const Icon(LucideIcons.packageCheck, size: 19),
            label: const Text('Confirmer le chargement'),
          ),
        ];
      case 'LOADED':
        final blocking = state.tripBlocking(m);
        if (blocking != null) {
          return [
            FilledButton.icon(onPressed: null, icon: const Icon(LucideIcons.play, size: 19), label: const Text('Démarrer le transport')),
            const SizedBox(height: 8),
            Text('Terminez d\'abord la livraison ${blocking.number} : un seul trajet à la fois.', textAlign: TextAlign.center, style: const TextStyle(color: Palette.orange, fontSize: 13)),
          ];
        }
        return [primary('Démarrer le transport', LucideIcons.play, () => _start(state, m))];
      case 'IN_TRANSIT':
        return [
          secondary('Signaler un incident', LucideIcons.triangleAlert, () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => IncidentScreen(mission: m)))),
          gap,
          secondary('Livraison impossible', LucideIcons.circleX, () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => FailScreen(mission: m)))),
          gap,
          primary('Je suis arrivé', LucideIcons.mapPinCheck, () => _run(() => state.enqueue(deliveryId: m.id, action: 'arrive', label: 'Arrivée', localStatus: 'ARRIVED'))),
        ];
      case 'ARRIVED' when m.isPickup:
        return [
          const Text(
            "Retrait en entrepôt : déposez les colis à l'entrepôt. Il confirme leur réception et les remet lui-même au client.",
            textAlign: TextAlign.center,
            style: TextStyle(color: Palette.muted, fontSize: 13),
          ),
          gap,
          secondary('Livraison impossible', LucideIcons.circleX, () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => FailScreen(mission: m)))),
        ];
      case 'ARRIVED':
        return [
          secondary('Livraison impossible', LucideIcons.circleX, () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => FailScreen(mission: m)))),
          gap,
          secondary('Livraison partielle', LucideIcons.packageMinus, () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => ProofScreen(mission: m, partial: true)))),
          gap,
          primary('Remettre au destinataire', LucideIcons.packageCheck, () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => ProofScreen(mission: m)))),
        ];
      default:
        return const [];
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    return ListenableBuilder(
      listenable: state,
      builder: (context, _) {
        final m = state.missionById(widget.missionId);
        if (m == null) {
          return Scaffold(appBar: AppBar(title: const Text('Mission')), body: const EmptyState(icon: LucideIcons.packageX, title: 'Mission introuvable', text: 'Elle vous a peut-être été retirée.'));
        }
        final actions = _actions(state, m);
        final pointPhone = m.point['phone'] as String? ?? m.customer['phone'] as String?;
        return Scaffold(
          appBar: AppBar(title: Text(m.number)),
          body: Column(children: [
            SyncBanner(state: state),
            Expanded(
              child: ListView(padding: const EdgeInsets.all(14), children: [
                Row(children: [StatusChip(m.status), const Spacer(), if (state.gps == GpsState.active) const Row(children: [Icon(LucideIcons.locateFixed, size: 14, color: Palette.green), SizedBox(width: 4), Text('Position suivie', style: TextStyle(color: Palette.green, fontSize: 12.5))])]),
                if (m.unconfirmed)
                  const Padding(padding: EdgeInsets.only(top: 8), child: Text('Enregistré sur le téléphone, en attente de confirmation du serveur.', style: TextStyle(color: Palette.orange, fontSize: 13))),
                const SizedBox(height: 12),
                SectionCard(title: 'Destination', children: [
                  Text(m.customer['name'] as String, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
                  const SizedBox(height: 2),
                  Text(m.point['name'] as String, style: const TextStyle(fontWeight: FontWeight.w500)),
                  const SizedBox(height: 2),
                  Text(m.destination, style: const TextStyle(color: Palette.muted)),
                  const SizedBox(height: 10),
                  InfoRow('Contact', m.point['contactName'] as String?),
                  InfoRow('Horaires', m.point['openingHours'] as String?),
                  InfoRow('Prévue', formatDate(m.scheduledAt)),
                  InfoRow('Instructions', [m.instructions, m.point['instructions'], m.point['restrictions']].whereType<String>().join('\n')),
                  const SizedBox(height: 4),
                  Row(children: [
                    Expanded(child: OutlinedButton.icon(onPressed: () => _navigate(m), icon: const Icon(LucideIcons.navigation, size: 17), label: const Text('Itinéraire'))),
                    if (pointPhone != null) ...[const SizedBox(width: 8), Expanded(child: OutlinedButton.icon(onPressed: () => _call(pointPhone), icon: const Icon(LucideIcons.phone, size: 17), label: const Text('Appeler')))],
                  ]),
                ]),
                const SizedBox(height: 10),
                SectionCard(title: 'Chargement', children: [
                  InfoRow('Véhicule', m.vehicle?['registration'] as String?),
                  InfoRow('Poids total', m.totalWeight > 0 ? '${formatNum(m.totalWeight)} kg' : null),
                  InfoRow('Volume total', m.totalVolume > 0 ? '${formatNum(m.totalVolume)} m³' : null),
                  for (final item in m.items) Padding(
                    padding: const EdgeInsets.symmetric(vertical: 5),
                    child: Row(children: [
                      Expanded(child: Text((item['product'] as Map)['name'] as String)),
                      Text('${formatNum(item['quantity'] as num)} ${(item['product'] as Map)['baseUnit']}', style: const TextStyle(fontWeight: FontWeight.w600)),
                    ]),
                  ),
                ]),
                const SizedBox(height: 10),
                SectionCard(title: 'Colis', children: [
                  for (final p in m.packages) Padding(
                    padding: const EdgeInsets.symmetric(vertical: 5),
                    child: Row(children: [
                      Icon(_isScanned(p) ? LucideIcons.circleCheck : LucideIcons.package, size: 17, color: _isScanned(p) ? Palette.green : Palette.muted),
                      const SizedBox(width: 8),
                      Expanded(child: Text(p['trackingNumber'] as String, style: const TextStyle(fontFamily: 'monospace', fontSize: 13))),
                      if (p['weightKg'] != null) Text('${formatNum(p['weightKg'] as num)} kg', style: const TextStyle(color: Palette.muted, fontSize: 13)),
                    ]),
                  ),
                ]),
              ]),
            ),
            if (actions.isNotEmpty)
              Container(
                decoration: const BoxDecoration(color: Colors.white, border: Border(top: BorderSide(color: Palette.line))),
                padding: const EdgeInsets.all(14),
                child: SafeArea(top: false, child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: actions)),
              ),
          ]),
        );
      },
    );
  }
}

/// Motif de refus. Le champ est libéré avec le dialogue, pas avant la fin de son animation de fermeture.
class _RefuseDialog extends StatefulWidget {
  const _RefuseDialog();

  @override
  State<_RefuseDialog> createState() => _RefuseDialogState();
}

class _RefuseDialogState extends State<_RefuseDialog> {
  final _note = TextEditingController();

  @override
  void dispose() {
    _note.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
        title: const Text('Refuser la mission'),
        content: TextField(controller: _note, maxLines: 2, decoration: const InputDecoration(labelText: 'Motif (facultatif)')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Annuler')),
          TextButton(onPressed: () => Navigator.pop(context, _note.text.trim()), child: const Text('Refuser')),
        ],
      );
}
