import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:logistic_track_mobile/screens/login_screen.dart';
import 'package:logistic_track_mobile/core/models.dart';

void main() {
  group('Fréquence GPS', () {
    test('en mouvement, une position toutes les 5 à 10 secondes', () {
      expect(shouldRecordPosition(speedMs: 10, secondsSinceLast: 3), isFalse);
      expect(shouldRecordPosition(speedMs: 10, secondsSinceLast: 7), isTrue);
    });
    test('à l\'arrêt, une position toutes les 30 à 60 secondes', () {
      expect(shouldRecordPosition(speedMs: 0, secondsSinceLast: 20), isFalse);
      expect(shouldRecordPosition(speedMs: 0, secondsSinceLast: 45), isTrue);
    });
    test('vitesse inconnue traitée comme un arrêt', () {
      expect(shouldRecordPosition(speedMs: null, secondsSinceLast: 10), isFalse);
    });
  });

  group('Mesures du téléphone', () {
    test('une donnée indisponible reste absente', () {
      final m = measureFields(accuracy: 12, speed: -1, speedAccuracy: 0, heading: 0, headingAccuracy: 0, altitude: 0, altitudeAccuracy: 0);
      expect(m['accuracyM'], 12);
      expect(m['speedMs'], isNull);
      expect(m['headingDeg'], isNull);
      expect(m['altitudeM'], isNull);
    });
    test('une donnée mesurée est transmise telle quelle', () {
      final m = measureFields(accuracy: 5, speed: 11.5, speedAccuracy: 1, heading: 270, headingAccuracy: 5, altitude: 300, altitudeAccuracy: 3);
      expect(m, {'accuracyM': 5.0, 'speedMs': 11.5, 'headingDeg': 270.0, 'altitudeM': 300.0});
    });
    test('un véhicule immobile avec mesure fiable garde sa vitesse nulle', () {
      expect(measureFields(accuracy: 5, speed: 0, speedAccuracy: 1, heading: 0, headingAccuracy: 0, altitude: 0, altitudeAccuracy: 0)['speedMs'], 0.0);
    });
  });

  group('Mission', () {
    Map<String, dynamic> raw() => {
          'id': 'x', 'number': 'LVR-1', 'status': 'IN_TRANSIT', 'customer': {'name': 'C'},
          'deliveryPoint': {'address': 'A', 'commune': 'Gombe', 'city': null}, 'items': <dynamic>[],
          'packages': [{'weightKg': 10}, {'weightKg': 2.5, 'volumeM3': 1}],
        };

    test('une opération locale prime sur l\'état serveur et reste non confirmée', () {
      final m = Mission(raw(), localStatus: 'DELIVERED', pendingOps: 2);
      expect(m.status, 'DELIVERED');
      expect(m.serverStatus, 'IN_TRANSIT');
      expect(m.unconfirmed, isTrue);
    });
    test('calcule poids total et destination', () {
      final m = Mission(raw());
      expect(m.totalWeight, 12.5);
      expect(m.destination, 'A, Gombe');
      expect(m.unconfirmed, isFalse);
    });
    test('le suivi ne concerne que les missions en route', () {
      expect(needsTracking('IN_TRANSIT'), isTrue);
      expect(needsTracking('ARRIVED'), isFalse);
      expect(ProofRules.fromJson(const {'subscriptionActive': false}).subscriptionActive, isFalse);
      expect(ProofRules.fromJson(const {}).subscriptionActive, isTrue);
      expect(needsTracking('LOADED'), isFalse);
      expect(needsTracking('DELIVERED'), isFalse);
    });
  });

  group('Écran de connexion', () {
    Future<void> show(WidgetTester tester, {bool still = false, Size size = const Size(390, 844)}) async {
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(MediaQuery(data: MediaQueryData(size: size, disableAnimations: still), child: const MaterialApp(home: LoginScreen())));
      await tester.pump(const Duration(seconds: 2));
    }

    testWidgets('reprend le formulaire du web, scène animée comprise', (tester) async {
      await show(tester);
      for (final text in ['LogisticTrack', 'Connexion', 'E-mail ou téléphone', 'Mot de passe', 'Se connecter']) {
        expect(find.text(text), findsOneWidget, reason: text);
      }
      for (var i = 0; i < 30; i++) {
        await tester.pump(const Duration(milliseconds: 400));
      }
      expect(tester.takeException(), isNull);
    });

    testWidgets('reste utilisable sur un petit écran et sans animation', (tester) async {
      await show(tester, still: true, size: const Size(320, 480));
      expect(tester.takeException(), isNull);
      await tester.scrollUntilVisible(find.text('Se connecter'), 100, scrollable: find.byType(Scrollable).first);
      expect(find.text('Se connecter'), findsOneWidget);
    });
  });
}
