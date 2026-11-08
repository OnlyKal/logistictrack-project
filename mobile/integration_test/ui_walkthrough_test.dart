// Parcourt les écrans réels contre un serveur en marche (compte de démonstration).
// flutter test integration_test/ui_walkthrough_test.dart -d <appareil> --dart-define=API_URL=http://localhost:3000
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:integration_test/integration_test.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:logistic_track_mobile/core/app_state.dart';
import 'package:logistic_track_mobile/core/config.dart';
import 'package:logistic_track_mobile/main.dart';

/// Temps laissé à l'écran entre deux étapes, utile pour des captures externes.
const pause = Duration(seconds: int.fromEnvironment('UI_PAUSE', defaultValue: 0));

Future<dynamic> call(String token, String method, String path, [Map<String, dynamic>? body]) async {
  final uri = Uri.parse('$apiBaseUrl/api/v1$path');
  final headers = {'content-type': 'application/json', 'authorization': 'Bearer $token'};
  final res = method == 'GET' ? await http.get(uri, headers: headers) : await http.post(uri, headers: headers, body: jsonEncode(body ?? {}));
  if (res.statusCode >= 300) throw Exception('$path: ${res.body}');
  return jsonDecode(res.body)['data'];
}

/// L'invite système de localisation ne peut pas recevoir de réponse dans un test automatisé.
class _StateWithoutGps extends AppState {
  @override
  Future<bool> startTracking(String deliveryId) async => true;

  @override
  void resumeTrackingIfNeeded() {}
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('connexion, mission et écran de preuve', (tester) async {
    FlutterSecureStorage.setMockInitialValues({});
    await initializeDateFormatting('fr');
    final login = await http.post(Uri.parse('$apiBaseUrl/api/v1/auth/login'), headers: {'content-type': 'application/json'}, body: jsonEncode({'identifier': 'admin@demo-logistique.local', 'password': 'Demo1234!'}));
    final token = jsonDecode(login.body)['data']['accessToken'] as String;
    final warehouses = await call(token, 'GET', '/warehouses') as List;
    final products = await call(token, 'GET', '/products') as List;
    final customers = await call(token, 'GET', '/customers') as List;
    final drivers = await call(token, 'GET', '/drivers') as List;
    final vehicles = await call(token, 'GET', '/vehicles') as List;
    final pack = await call(token, 'POST', '/packages', {'warehouseId': warehouses.first['id'], 'items': [{'productId': products.firstWhere((p) => p['reference'] == 'RIZ-025')['id'], 'quantity': 4}]});
    final d = await call(token, 'POST', '/deliveries', {'packageIds': [pack['id']], 'customerId': customers.first['id'], 'deliveryPointId': customers.first['deliveryPoints'][0]['id'], 'justification': 'Parcours UI', 'scheduledAt': DateTime.now().toUtc().toIso8601String()});
    await call(token, 'POST', '/deliveries/${d['id']}/validate');
    await call(token, 'POST', '/deliveries/${d['id']}/assign', {'driverId': drivers.first['id'], 'vehicleId': vehicles.firstWhere((v) => v['type'] == 'TRUCK')['id']});

    Future<void> settle() async {
      for (var i = 0; i < 20; i++) {
        await tester.pump(const Duration(milliseconds: 200));
      }
      await Future<void>.delayed(pause);
      await tester.pump();
    }

    final state = _StateWithoutGps();
    await state.init();
    await state.store.wipe();
    await tester.pumpWidget(LogisticTrackApp(state: state));
    await settle();

    expect(find.text('Connexion'), findsOneWidget);
    await tester.enterText(find.byType(TextField).at(0), '+243990000001');
    await tester.enterText(find.byType(TextField).at(1), 'Demo1234!');
    await tester.pump();
    await tester.tap(find.text('Se connecter'));
    await tester.runAsync(() => Future<void>.delayed(const Duration(seconds: 5)));
    await settle();
    expect(find.text('Mes missions'), findsOneWidget);

    await tester.tap(find.text(d['number'] as String).first);
    await settle();
    expect(find.text('Accepter la mission'), findsOneWidget);
    await tester.tap(find.text('Accepter la mission'));
    await tester.runAsync(() => Future<void>.delayed(const Duration(seconds: 5)));
    await settle();
    expect(find.text('Confirmer le chargement'), findsOneWidget);
    await tester.tap(find.text('Confirmer le chargement'));
    await tester.runAsync(() => Future<void>.delayed(const Duration(seconds: 5)));
    await settle();

    await tester.tap(find.text('Démarrer le transport'));
    await settle();
    expect(find.text('Suivi de votre position'), findsOneWidget);
    await tester.tap(find.text('Démarrer'));
    await tester.runAsync(() => Future<void>.delayed(const Duration(seconds: 5)));
    await settle();
    await tester.tap(find.text('Je suis arrivé'));
    await tester.runAsync(() => Future<void>.delayed(const Duration(seconds: 5)));
    await settle();

    await tester.tap(find.text('Remettre au destinataire'));
    await settle();
    expect(find.textContaining('Signature'), findsWidgets);
    // Sans signature, la confirmation reste bloquée dès l'écran.
    await tester.drag(find.byType(ListView).first, const Offset(0, -900));
    await settle();
    await tester.tap(find.text('Confirmer la livraison'));
    await settle();
    await tester.drag(find.byType(ListView).first, const Offset(0, 900));
    await settle();
    expect(find.textContaining('nom du réceptionnaire'), findsOneWidget);

    await tester.pageBack();
    await settle();
    await tester.pageBack();
    await settle();
    await tester.tap(find.text('Compte'));
    await settle();
    expect(find.text('Synchronisation'), findsOneWidget);
    await state.stopTracking();
    await call(token, 'POST', '/deliveries/${d['id']}/fail', {'reason': 'OTHER', 'comment': 'Fin du parcours de test'});
    await call(token, 'POST', '/deliveries/${d['id']}/return', {});
    await state.logout();
    await tester.pumpWidget(const SizedBox());
  });
}
