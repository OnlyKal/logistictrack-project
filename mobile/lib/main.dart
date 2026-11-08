import 'package:flutter/material.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'core/app_state.dart';
import 'screens/home_screen.dart';
import 'screens/login_screen.dart';
import 'screens/common.dart';
import 'theme.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await initializeDateFormatting('fr');
  runApp(const _Startup());
}

/// Ouvre la base locale et la session. Une panne au démarrage s'affiche au lieu d'un écran blanc.
class _Startup extends StatefulWidget {
  const _Startup();

  @override
  State<_Startup> createState() => _StartupState();
}

class _StartupState extends State<_Startup> {
  AppState? _state;
  Object? _error;

  @override
  void initState() {
    super.initState();
    _open();
  }

  Future<void> _open() async {
    setState(() => _error = null);
    try {
      final state = AppState();
      await state.init();
      if (mounted) setState(() => _state = state);
    } catch (e, stack) {
      FlutterError.reportError(FlutterErrorDetails(exception: e, stack: stack, library: 'démarrage'));
      if (mounted) setState(() => _error = e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = _state;
    if (state != null) return LogisticTrackApp(state: state);
    return MaterialApp(
      title: 'LogisticTrack',
      debugShowCheckedModeBanner: false,
      theme: buildTheme(),
      home: Scaffold(
        body: SafeArea(
          child: Center(
            child: _error == null
                ? const CircularProgressIndicator()
                : Padding(
                    padding: const EdgeInsets.all(28),
                    child: Column(mainAxisSize: MainAxisSize.min, children: [
                      const Icon(LucideIcons.circleAlert, size: 32, color: Palette.red),
                      const SizedBox(height: 12),
                      const Text('L\'application n\'a pas pu démarrer', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
                      const SizedBox(height: 6),
                      const Text(
                        'Le stockage du téléphone est inaccessible. Vos données enregistrées ne sont pas effacées. Réessayez, ou redémarrez le téléphone si le problème continue.',
                        textAlign: TextAlign.center,
                        style: TextStyle(color: Palette.muted),
                      ),
                      const SizedBox(height: 18),
                      FilledButton.icon(onPressed: _open, icon: const Icon(LucideIcons.refreshCw, size: 18), label: const Text('Réessayer')),
                    ]),
                  ),
          ),
        ),
      ),
    );
  }
}

class LogisticTrackApp extends StatelessWidget {
  const LogisticTrackApp({super.key, required this.state});

  final AppState state;

  @override
  Widget build(BuildContext context) {
    // Au-dessus du Navigator : toutes les pages ouvertes accèdent à l'état de l'application.
    return AppScope(
      state: state,
      child: MaterialApp(
        title: 'LogisticTrack',
        debugShowCheckedModeBanner: false,
        theme: buildTheme(),
        home: ListenableBuilder(
          listenable: state,
          builder: (context, _) => state.loggedIn ? const HomeScreen() : const LoginScreen(),
        ),
      ),
    );
  }
}
