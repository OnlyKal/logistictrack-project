import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../theme.dart';
import 'common.dart';
import 'login_scene.dart';
import 'logo.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _identifier = TextEditingController();
  final _password = TextEditingController();
  bool _busy = false;
  bool _hidden = true;
  String? _error;

  @override
  void dispose() {
    _identifier.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_identifier.text.trim().isEmpty || _password.text.isEmpty) {
      setState(() => _error = 'Saisissez votre identifiant et votre mot de passe.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await AppScope.of(context).login(_identifier.text.trim(), _password.text);
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final top = MediaQuery.paddingOf(context).top;
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: SystemUiOverlayStyle.light,
      child: Scaffold(
        backgroundColor: Colors.white,
        body: SingleChildScrollView(
          keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            SizedBox(
              height: 250 + top,
              child: Stack(fit: StackFit.expand, children: [
                // La scène démarre sous le logo : aucune destination n'est cachée.
                const ColoredBox(color: Palette.night),
                Padding(padding: EdgeInsets.only(top: top + 44), child: const LoginScene()),
                Positioned(top: top + 12, left: 12, child: const _Brand()),
              ]),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 28, 20, 40),
              child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                const _Reveal(delay: 0, child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text('Connexion', style: TextStyle(fontSize: 24, fontWeight: FontWeight.w700, letterSpacing: -0.4, color: Palette.night)),
                  SizedBox(height: 4),
                  Text('Accédez à vos missions.', style: TextStyle(color: Palette.muted, fontSize: 15)),
                ])),
                const SizedBox(height: 18),
                if (_error != null) ...[
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(color: Palette.redSoft, borderRadius: BorderRadius.circular(10)),
                    child: Text(_error!, style: const TextStyle(color: Palette.red, fontSize: 13)),
                  ),
                  const SizedBox(height: 14),
                ],
                _Reveal(delay: 60, child: _Labeled('E-mail ou téléphone', TextField(controller: _identifier, keyboardType: TextInputType.emailAddress, autocorrect: false, textInputAction: TextInputAction.next))),
                const SizedBox(height: 14),
                _Reveal(delay: 120, child: _Labeled('Mot de passe', TextField(
                  controller: _password,
                  obscureText: _hidden,
                  onSubmitted: (_) => _submit(),
                  decoration: InputDecoration(
                    suffixIcon: IconButton(tooltip: _hidden ? 'Afficher' : 'Masquer', icon: Icon(_hidden ? LucideIcons.eye : LucideIcons.eyeOff, size: 19), onPressed: () => setState(() => _hidden = !_hidden)),
                  ),
                ))),
                const SizedBox(height: 18),
                _Reveal(delay: 180, child: FilledButton(onPressed: _busy ? null : _submit, child: _busy ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white)) : const Text('Se connecter'))),
                const SizedBox(height: 14),
                const _Reveal(delay: 240, child: Text("Mot de passe oublié ? Demandez à votre responsable de le réinitialiser.", style: TextStyle(color: Palette.muted, fontSize: 13))),
              ]),
            ),
          ]),
        ),
      ),
    );
  }
}

class _Brand extends StatelessWidget {
  const _Brand();

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        decoration: BoxDecoration(color: Palette.night, borderRadius: BorderRadius.circular(10)),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          const LogoMark(),
          const SizedBox(width: 10),
          const Text('LogisticTrack', style: TextStyle(color: Colors.white, fontSize: 17, fontWeight: FontWeight.w600, letterSpacing: -0.2)),
        ]),
      );
}

class _Labeled extends StatelessWidget {
  const _Labeled(this.label, this.field);

  final String label;
  final Widget field;

  @override
  Widget build(BuildContext context) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text(label, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w500, color: Palette.night)),
        const SizedBox(height: 6),
        field,
      ]);
}

/// Apparition légère du formulaire, élément après élément, comme sur le web.
class _Reveal extends StatelessWidget {
  const _Reveal({required this.delay, required this.child});

  final int delay;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    if (MediaQuery.disableAnimationsOf(context)) return child;
    final total = 550 + delay;
    return TweenAnimationBuilder<double>(
      tween: Tween(begin: 0, end: 1),
      duration: Duration(milliseconds: total),
      curve: Interval(delay / total, 1, curve: const Cubic(0.2, 0.7, 0.2, 1)),
      child: child,
      builder: (context, value, child) => Opacity(opacity: value, child: Transform.translate(offset: Offset(0, 4 * (1 - value)), child: child)),
    );
  }
}
