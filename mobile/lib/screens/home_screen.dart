import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../core/app_state.dart';
import '../core/models.dart';
import '../theme.dart';
import 'common.dart';
import 'mission_screen.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  int _tab = 0;

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    return ListenableBuilder(
      listenable: state,
      builder: (context, _) {
        final body = switch (_tab) {
          0 => _MissionList(missions: state.missions, emptyTitle: 'Aucune mission en cours', emptyText: 'Les missions affectées apparaîtront ici.', dashboard: true),
          1 => _MissionList(missions: state.history, emptyTitle: 'Aucun historique', emptyText: 'Vos livraisons terminées apparaîtront ici.'),
          _ => const _Account(),
        };
        return Scaffold(
          appBar: AppBar(title: Text(['Mes missions', 'Historique', 'Compte'][_tab])),
          body: Column(children: [SyncBanner(state: state), Expanded(child: body)]),
          bottomNavigationBar: NavigationBar(
            selectedIndex: _tab,
            onDestinationSelected: (i) => setState(() => _tab = i),
            destinations: const [
              NavigationDestination(icon: Icon(LucideIcons.truck), label: 'Missions'),
              NavigationDestination(icon: Icon(LucideIcons.history), label: 'Historique'),
              NavigationDestination(icon: Icon(LucideIcons.user), label: 'Compte'),
            ],
          ),
        );
      },
    );
  }
}

class _MissionList extends StatelessWidget {
  const _MissionList({required this.missions, required this.emptyTitle, required this.emptyText, this.dashboard = false});

  final List<Mission> missions;
  final String emptyTitle;
  final String emptyText;
  final bool dashboard;

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    final today = DateTime.now();
    bool isToday(Object? value) {
      final d = DateTime.tryParse(value?.toString() ?? '')?.toLocal();
      return d != null && d.year == today.year && d.month == today.month && d.day == today.day;
    }
    // Terminée aujourd'hui : sur le téléphone (pas encore confirmée par le serveur) ou selon la date du serveur.
    // Pas de date d'échec côté serveur : sa dernière mise à jour en tient lieu.
    bool doneToday(Mission m, String serverDate) => m.localStatus != null || isToday(m.raw[serverDate]);
    final done = state.history.where((m) => (m.status == 'DELIVERED' || m.status == 'PARTIALLY_DELIVERED') && doneToday(m, 'deliveredAt')).length;
    final failed = state.history.where((m) => m.status == 'FAILED' && doneToday(m, 'updatedAt')).length;
    return RefreshIndicator(
      onRefresh: state.refresh,
      child: ListView(
        padding: const EdgeInsets.all(14),
        children: [
          if (dashboard) ...[
            Row(children: [
              _Counter('À faire', '${missions.length}', LucideIcons.clipboardList),
              const SizedBox(width: 8),
              _Counter('Livrées ce jour', '$done', LucideIcons.circleCheck),
              const SizedBox(width: 8),
              _Counter('Échecs ce jour', '$failed', LucideIcons.circleX),
            ]),
            const SizedBox(height: 14),
          ],
          if (missions.isEmpty) EmptyState(icon: LucideIcons.truck, title: emptyTitle, text: emptyText),
          for (final m in missions) ...[_MissionCard(mission: m), const SizedBox(height: 10)],
        ],
      ),
    );
  }
}

class _Counter extends StatelessWidget {
  const _Counter(this.label, this.value, this.icon);

  final String label;
  final String value;
  final IconData icon;

  @override
  Widget build(BuildContext context) => Expanded(
        child: Card(
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Icon(icon, size: 17, color: Palette.muted),
              const SizedBox(height: 6),
              Text(value, style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w700)),
              Text(label, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: Palette.muted, fontSize: 12)),
            ]),
          ),
        ),
      );
}

class _MissionCard extends StatelessWidget {
  const _MissionCard({required this.mission});

  final Mission mission;

  @override
  Widget build(BuildContext context) {
    final m = mission;
    return Card(
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => MissionScreen(missionId: m.id))),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [Expanded(child: Text(m.number, style: const TextStyle(fontWeight: FontWeight.w600))), StatusChip(m.status)]),
            const SizedBox(height: 8),
            Text(m.customer['name'] as String, style: const TextStyle(fontSize: 15.5, fontWeight: FontWeight.w600)),
            const SizedBox(height: 2),
            Text('${m.point['name']} · ${m.destination}', style: const TextStyle(color: Palette.muted, fontSize: 13)),
            const SizedBox(height: 8),
            Row(children: [
              const Icon(LucideIcons.clock, size: 14, color: Palette.muted),
              const SizedBox(width: 4),
              Text(formatDate(m.scheduledAt), style: const TextStyle(color: Palette.muted, fontSize: 13)),
              const SizedBox(width: 12),
              const Icon(LucideIcons.package, size: 14, color: Palette.muted),
              const SizedBox(width: 4),
              Text('${m.packages.length} colis', style: const TextStyle(color: Palette.muted, fontSize: 13)),
              if (m.route != null) ...[const Spacer(), Text('Arrêt ${m.route!['position']}', style: const TextStyle(color: Palette.blue, fontSize: 13, fontWeight: FontWeight.w500))],
            ]),
            if (m.unconfirmed) ...[
              const SizedBox(height: 8),
              const Row(children: [Icon(LucideIcons.cloudUpload, size: 14, color: Palette.orange), SizedBox(width: 5), Text('En attente de confirmation du serveur', style: TextStyle(color: Palette.orange, fontSize: 12.5))]),
            ],
          ]),
        ),
      ),
    );
  }
}

class _Account extends StatelessWidget {
  const _Account();

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    final p = state.profile ?? {};
    final company = (p['company'] as Map?)?['tradeName'] as String?;
    return ListView(padding: const EdgeInsets.all(14), children: [
      SectionCard(children: [
        Text(p['fullName'] as String? ?? '', style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
        const SizedBox(height: 2),
        Text(company ?? '', style: const TextStyle(color: Palette.muted)),
        const SizedBox(height: 8),
        InfoRow('Téléphone', p['phone'] as String?),
      ]),
      const SizedBox(height: 10),
      SectionCard(title: 'Suivi de la position', children: [
        Text(
          state.gps == GpsState.active ? 'Votre position est suivie pendant ce trajet. Le suivi s\'arrête dès que vous indiquez votre arrivée.' : 'Aucun suivi en cours. Votre position n\'est collectée que pendant vos trajets.',
          style: const TextStyle(color: Palette.muted),
        ),
        if (state.gpsPending > 0) Padding(padding: const EdgeInsets.only(top: 6), child: Text('${state.gpsPending} position(s) en attente d\'envoi.', style: const TextStyle(fontSize: 13))),
      ]),
      const SizedBox(height: 10),
      SectionCard(title: 'Synchronisation', children: [
        InfoRow('En attente', '${state.pendingCount} opération(s)'),
        InfoRow('Dernier échange', state.lastSync == null ? 'Pas encore' : formatDate(state.lastSync)),
        for (final op in state.failedOps) ...[
          const Divider(),
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 6),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(op.label, style: const TextStyle(fontWeight: FontWeight.w600)),
              Text(op.error ?? '', style: const TextStyle(color: Palette.red, fontSize: 13)),
              Align(
                alignment: Alignment.centerRight,
                child: TextButton(onPressed: () => state.discardFailed(op), child: const Text('Retirer')),
              ),
            ]),
          ),
        ],
        if (state.failedOps.isNotEmpty) OutlinedButton(onPressed: state.retryFailed, child: const Text('Réessayer')),
        const SizedBox(height: 8),
        OutlinedButton.icon(onPressed: state.syncing ? null : state.refresh, icon: const Icon(LucideIcons.refreshCw, size: 17), label: const Text('Synchroniser')),
      ]),
      const SizedBox(height: 10),
      OutlinedButton.icon(
        onPressed: () async {
          final waiting = state.pendingCount + state.gpsPending;
          final ok = await showDialog<bool>(
            context: context,
            builder: (c) => AlertDialog(
              title: const Text('Se déconnecter'),
              content: Text(waiting > 0 ? 'Attention : $waiting donnée(s) non envoyée(s) seront définitivement perdues.' : 'Vous devrez saisir à nouveau vos identifiants.'),
              actions: [TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Annuler')), TextButton(onPressed: () => Navigator.pop(c, true), child: const Text('Se déconnecter'))],
            ),
          );
          if (ok == true) await state.logout();
        },
        icon: const Icon(LucideIcons.logOut, size: 17),
        label: const Text('Se déconnecter'),
      ),
    ]);
  }
}
