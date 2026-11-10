import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../core/app_state.dart';
import '../core/models.dart';
import '../theme.dart';

/// Rend l'état accessible à tous les écrans.
class AppScope extends InheritedWidget {
  const AppScope({super.key, required this.state, required super.child});

  final AppState state;

  static AppState of(BuildContext context) => context.getInheritedWidgetOfExactType<AppScope>()!.state;

  @override
  bool updateShouldNotify(AppScope oldWidget) => false;
}

String formatDate(DateTime? d) => d == null ? 'Non planifiée' : DateFormat('d MMM, HH:mm', 'fr').format(d);
String formatNum(num? v) => v == null ? '—' : NumberFormat('#,##0.###', 'fr').format(v);

/// Message affiché en haut de l'écran : il ne recouvre jamais les boutons d'action, placés sous le pouce.
void showMessage(BuildContext context, String message, {bool error = false}) {
  final media = MediaQuery.of(context);
  // Clavier ouvert, l'écran utile rétrécit : sans ce calcul, le message sortirait par le haut.
  final bottom = (media.size.height - media.padding.top - media.viewInsets.bottom - 170).clamp(0.0, double.infinity);
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(
      content: Text(message),
      backgroundColor: error ? Palette.red : Palette.night,
      behavior: SnackBarBehavior.floating,
      duration: Duration(seconds: error ? 5 : 3),
      margin: EdgeInsets.only(left: 14, right: 14, bottom: bottom),
    ));
}

class StatusChip extends StatelessWidget {
  const StatusChip(this.status, {super.key});

  final String status;

  @override
  Widget build(BuildContext context) {
    final (bg, fg, icon) = switch (status) {
      'ASSIGNED' => (Palette.blueSoft, Palette.blueText, LucideIcons.userCheck),
      'LOADED' => (Palette.tealSoft, Palette.teal, LucideIcons.package),
      'IN_TRANSIT' => (Palette.blue, Colors.white, LucideIcons.truck),
      'ARRIVED' => (Palette.limeSoft, Palette.lime, LucideIcons.mapPinCheck),
      'AWAITING_PICKUP' => (Palette.tealSoft, Palette.teal, LucideIcons.store),
      'DELIVERED' => (Palette.greenSoft, Palette.green, LucideIcons.circleCheck),
      'PARTIALLY_DELIVERED' => (Palette.orangeSoft, Palette.orange, LucideIcons.triangleAlert),
      'FAILED' => (Palette.redSoft, Palette.red, LucideIcons.circleX),
      'RETURNED' => (Palette.roseSoft, Palette.rose, LucideIcons.undo2),
      'CANCELLED' => (Palette.slate, Colors.white, LucideIcons.ban),
      _ => (Palette.line, Palette.slate, LucideIcons.circle),
    };
    return Container(
      padding: const EdgeInsets.fromLTRB(7, 3, 9, 3),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(99)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Icon(icon, size: 13, color: fg),
        const SizedBox(width: 4),
        Text(missionStatusLabels[status] ?? status, style: TextStyle(color: fg, fontSize: 12.5, fontWeight: FontWeight.w500)),
      ]),
    );
  }
}

/// Bandeau discret : réseau, opérations en attente, GPS.
class SyncBanner extends StatelessWidget {
  const SyncBanner({super.key, required this.state});

  final AppState state;

  @override
  Widget build(BuildContext context) {
    final rows = <Widget>[];
    if (state.recallNotice != null) {
      rows.add(GestureDetector(onTap: state.dismissRecall, child: _row(LucideIcons.octagonX, '${state.recallNotice!} (Toucher pour masquer)', Palette.redSoft, Palette.red)));
    }
    if (!state.rules.subscriptionActive) rows.add(_row(LucideIcons.circleAlert, 'Abonnement de votre entreprise expiré, contactez votre responsable. Vous pouvez terminer les missions déjà commencées.', Palette.orangeSoft, Palette.orange));
    if (state.gpsMessage != null) rows.add(_row(LucideIcons.mapPinOff, state.gpsMessage!, Palette.redSoft, Palette.red));
    if (state.failedOps.isNotEmpty) rows.add(_row(LucideIcons.circleAlert, '${state.failedOps.length} opération(s) refusée(s) par le serveur. À vérifier dans Compte.', Palette.redSoft, Palette.red));
    final waiting = state.pendingCount;
    if (state.gpsPending > 0 && !state.online) rows.add(_row(LucideIcons.mapPin, '${state.gpsPending} position(s) enregistrée(s) sur ce téléphone, envoi automatique au retour du réseau.', Palette.blueSoft, Palette.blue));
    if (!state.online || waiting > 0) {
      final text = state.online ? '$waiting opération(s) en cours d\'envoi' : 'Hors ligne. ${waiting > 0 ? '$waiting opération(s) en attente, e' : 'E'}nvoi automatique au retour du réseau.';
      rows.add(_row(LucideIcons.cloudOff, text, Palette.orangeSoft, Palette.orange));
    }
    return Column(mainAxisSize: MainAxisSize.min, children: rows);
  }

  Widget _row(IconData icon, String text, Color bg, Color fg) => Container(
        width: double.infinity,
        color: bg,
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 9),
        child: Row(children: [Icon(icon, size: 16, color: fg), const SizedBox(width: 8), Expanded(child: Text(text, style: TextStyle(color: fg, fontSize: 13)))]),
      );
}

class EmptyState extends StatelessWidget {
  const EmptyState({super.key, required this.icon, required this.title, this.text});

  final IconData icon;
  final String title;
  final String? text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.all(40),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Icon(icon, size: 30, color: Palette.muted),
          const SizedBox(height: 10),
          Text(title, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 15)),
          if (text != null) Padding(padding: const EdgeInsets.only(top: 4), child: Text(text!, textAlign: TextAlign.center, style: const TextStyle(color: Palette.muted))),
        ]),
      );
}

class SectionCard extends StatelessWidget {
  const SectionCard({super.key, this.title, required this.children});

  final String? title;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) => Card(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            if (title != null) Padding(padding: const EdgeInsets.only(bottom: 10), child: Text(title!, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 15))),
            ...children,
          ]),
        ),
      );
}

class InfoRow extends StatelessWidget {
  const InfoRow(this.label, this.value, {super.key});

  final String label;
  final String? value;

  @override
  Widget build(BuildContext context) {
    if (value == null || value!.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(bottom: 7),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        SizedBox(width: 104, child: Text(label, style: const TextStyle(color: Palette.muted, fontSize: 13))),
        Expanded(child: Text(value!)),
      ]),
    );
  }
}
