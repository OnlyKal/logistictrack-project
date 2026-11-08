// Parcours réel du chauffeur contre un serveur en marche, base locale SQLite comprise.
// flutter test integration_test -d macos --dart-define=API_URL=http://localhost:3000
import 'dart:convert';
import 'dart:io';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:integration_test/integration_test.dart';
import 'package:logistic_track_mobile/core/api.dart';
import 'package:logistic_track_mobile/core/app_state.dart';
import 'package:logistic_track_mobile/core/config.dart';

/// Coupe le réseau à la demande, comme un téléphone hors couverture.
class SwitchClient extends http.BaseClient {
  bool offline = false;
  final _inner = http.Client();

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) {
    if (offline) throw const SocketException('hors ligne');
    return _inner.send(request);
  }
}

Future<dynamic> admin(String token, String method, String path, [Map<String, dynamic>? body]) async {
  final uri = Uri.parse('$apiBaseUrl/api/v1$path');
  final headers = {'content-type': 'application/json', 'authorization': 'Bearer $token'};
  final res = method == 'GET' ? await http.get(uri, headers: headers) : await http.post(uri, headers: headers, body: jsonEncode(body ?? {}));
  final json = jsonDecode(res.body);
  if (res.statusCode >= 300) throw Exception('$path: ${res.body}');
  return json['data'];
}

/// Prépare une livraison affectée au chauffeur de démonstration, comme le ferait le gestionnaire.
Future<String> assignedDelivery(String token) async {
  final warehouses = await admin(token, 'GET', '/warehouses') as List;
  final products = await admin(token, 'GET', '/products') as List;
  final customers = await admin(token, 'GET', '/customers') as List;
  final drivers = await admin(token, 'GET', '/drivers') as List;
  final vehicles = await admin(token, 'GET', '/vehicles') as List;
  final customer = customers.first;
  final pack = await admin(token, 'POST', '/packages', {'warehouseId': warehouses.first['id'], 'items': [{'productId': products.firstWhere((p) => p['reference'] == 'RIZ-025')['id'], 'quantity': 2}]});
  final d = await admin(token, 'POST', '/deliveries', {'packageIds': [pack['id']], 'customerId': customer['id'], 'deliveryPointId': customer['deliveryPoints'][0]['id'], 'justification': 'Test mobile'});
  await admin(token, 'POST', '/deliveries/${d['id']}/validate');
  await admin(token, 'POST', '/deliveries/${d['id']}/assign', {'driverId': drivers.first['id'], 'vehicleId': vehicles.firstWhere((v) => v['type'] == 'TRUCK')['id']});
  return d['id'] as String;
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('mission complète, coupure réseau et synchronisation sans doublon', (tester) async {
    FlutterSecureStorage.setMockInitialValues({});
    final login = await http.post(Uri.parse('$apiBaseUrl/api/v1/auth/login'), headers: {'content-type': 'application/json'}, body: jsonEncode({'identifier': 'admin@demo-logistique.local', 'password': 'Demo1234!'}));
    final token = jsonDecode(login.body)['data']['accessToken'] as String;
    final deliveryId = await assignedDelivery(token);

    final net = SwitchClient();
    final state = AppState(api: Api(client: net));
    await state.init();
    await state.store.wipe();

    // Un profil non chauffeur est refusé.
    await expectLater(state.login('admin@demo-logistique.local', 'Demo1234!'), throwsA(isA<ApiException>()));

    await state.login('+243990000001', 'Demo1234!');
    await state.refresh();
    expect(state.loggedIn, isTrue);
    final mission = state.missionById(deliveryId)!;
    expect(mission.status, 'ASSIGNED');
    expect(state.rules.signature, isTrue);

    await state.respond(deliveryId, true);
    expect(state.missionById(deliveryId)!.driverResponse, 'ACCEPTED');

    // Coupure : tout continue localement, sans rien présenter comme confirmé.
    net.offline = true;
    await state.enqueue(deliveryId: deliveryId, action: 'load', label: 'Chargement', localStatus: 'LOADED');
    await state.enqueue(deliveryId: deliveryId, action: 'start', label: 'Départ', localStatus: 'IN_TRANSIT');
    expect(state.online, isFalse);
    var local = state.missionById(deliveryId)!;
    expect(local.status, 'IN_TRANSIT');
    expect(local.unconfirmed, isTrue);
    expect(local.serverStatus, 'ASSIGNED');

    // Position mesurée hors ligne, conservée avec son horodatage d'origine.
    final measuredAt = DateTime.now().toUtc();
    await state.store.addGps('gps-${DateTime.now().microsecondsSinceEpoch}', deliveryId, {'latitude': -4.33, 'longitude': 15.31, 'accuracyM': 9.0, 'speedMs': null, 'headingDeg': null, 'altitudeM': null, 'batteryLevel': 64, 'isOnline': false, 'recordedAt': measuredAt.toIso8601String()});
    // Tout un trajet sans réseau : chaque position attend en local, dans l'ordre, avec son heure.
    for (var i = 3; i > 0; i--) {
      await state.store.addGps('gps-$i-${DateTime.now().microsecondsSinceEpoch}', deliveryId, {'latitude': -4.33 - i / 100, 'longitude': 15.31, 'accuracyM': 9.0, 'speedMs': null, 'headingDeg': null, 'altitudeM': null, 'batteryLevel': 64, 'isOnline': false, 'recordedAt': measuredAt.add(Duration(seconds: 4 - i)).toIso8601String()});
    }
    await state.sync();
    expect(await state.store.gpsCount(), 4, reason: 'rien ne se perd pendant la coupure');
    await Future<void>.delayed(const Duration(seconds: 5));
    await state.enqueue(deliveryId: deliveryId, action: 'arrive', label: 'Arrivée', localStatus: 'ARRIVED');

    final dir = await Directory.systemTemp.createTemp('lt');
    final signature = File('${dir.path}/s.png')..writeAsBytesSync(base64Decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='));
    await state.enqueueProof(deliveryId: deliveryId, type: 'SIGNATURE', filePath: signature.path, mime: 'image/png');
    await state.enqueue(deliveryId: deliveryId, action: 'confirm', label: 'Confirmation', localStatus: 'DELIVERED', body: {'recipientName': 'Réception Test'});
    expect(state.pendingCount, 5);
    expect(state.missionById(deliveryId)!.status, 'DELIVERED');
    expect(state.missionById(deliveryId)!.unconfirmed, isTrue);
    expect((await admin(token, 'GET', '/deliveries/$deliveryId'))['status'], 'ASSIGNED', reason: 'le serveur n\'a encore rien reçu');

    // Retour du réseau : envoi dans l'ordre, confirmation par le serveur.
    net.offline = false;
    await state.refresh();
    expect(state.pendingCount, 0, reason: state.failedOps.map((o) => '${o.label}: ${o.error}').join(', '));
    expect(state.failedOps, isEmpty);
    final server = await admin(token, 'GET', '/deliveries/$deliveryId');
    expect(server['status'], 'DELIVERED');
    expect(server['recipientName'], 'Réception Test');
    expect((server['proofs'] as List).any((p) => p['type'] == 'SIGNATURE' && p['sha256'] != null), isTrue);
    expect(state.missionById(deliveryId)!.status, 'DELIVERED');
    expect(state.missionById(deliveryId)!.unconfirmed, isFalse);
    expect((server['events'] as List).where((e) => e['type'] == 'DELIVERED').length, 1);

    // La position hors ligne a été reçue et rattachée à la mission.
    final track = await admin(token, 'GET', '/tracking/deliveries/$deliveryId');
    expect(state.gpsPending, 0);
    final lats = (track['positions'] as List).map((p) => p['latitude']).toList();
    expect(lats, [-4.33, -4.36, -4.35, -4.34], reason: 'toutes les positions, une seule fois, dans leur ordre réel');

    // Connexion revenue sans changement de réseau : le passage périodique reprend tout seul.
    net.offline = true;
    await state.refresh();
    expect(state.online, isFalse);
    net.offline = false;
    await state.tick();
    expect(state.online, isTrue);

    // Un refus du serveur ne bloque pas définitivement : on peut corriger et réessayer.
    await state.logout();
    expect(state.loggedIn, isFalse);
    expect(await state.store.ops(), isEmpty);
  });

  testWidgets('une opération refusée est signalée et une nouvelle tentative la remplace', (tester) async {
    FlutterSecureStorage.setMockInitialValues({});
    final login = await http.post(Uri.parse('$apiBaseUrl/api/v1/auth/login'), headers: {'content-type': 'application/json'}, body: jsonEncode({'identifier': 'admin@demo-logistique.local', 'password': 'Demo1234!'}));
    final token = jsonDecode(login.body)['data']['accessToken'] as String;
    final deliveryId = await assignedDelivery(token);
    final state = AppState();
    await state.init();
    await state.login('+243990000001', 'Demo1234!');
    await state.refresh();
    for (final step in ['load', 'start', 'arrive']) {
      await state.enqueue(deliveryId: deliveryId, action: step, label: step);
    }
    expect(state.failedOps, isEmpty);
    // Sans signature, le serveur refuse : la mission n'apparaît pas comme livrée.
    await state.enqueue(deliveryId: deliveryId, action: 'confirm', label: 'Confirmation', localStatus: 'DELIVERED', body: {'recipientName': 'Sans preuve'});
    expect(state.failedOps.length, 1);
    expect(state.failedOps.first.error, contains('signature'));
    expect(state.missionById(deliveryId)!.status, 'ARRIVED');

    final dir = await Directory.systemTemp.createTemp('lt');
    final signature = File('${dir.path}/s.png')..writeAsBytesSync(base64Decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='));
    await state.discardFailed(state.failedOps.first);
    await state.enqueueProof(deliveryId: deliveryId, type: 'SIGNATURE', filePath: signature.path, mime: 'image/png');
    await state.enqueue(deliveryId: deliveryId, action: 'confirm', label: 'Confirmation', localStatus: 'DELIVERED', body: {'recipientName': 'Avec preuve'});
    expect(state.failedOps, isEmpty);
    expect((await admin(token, 'GET', '/deliveries/$deliveryId'))['status'], 'DELIVERED');
    await state.logout();
  });

  testWidgets('le bureau rappelle le chauffeur en route : message, mission arrêtée, opérations retirées', (tester) async {
    FlutterSecureStorage.setMockInitialValues({});
    final login = await http.post(Uri.parse('$apiBaseUrl/api/v1/auth/login'), headers: {'content-type': 'application/json'}, body: jsonEncode({'identifier': 'admin@demo-logistique.local', 'password': 'Demo1234!'}));
    final token = jsonDecode(login.body)['data']['accessToken'] as String;
    // Un seul trajet à la fois : on libère le chauffeur de démonstration.
    for (final d in await admin(token, 'GET', '/deliveries?status=IN_TRANSIT,ARRIVED&limit=200') as List) {
      await admin(token, 'POST', '/deliveries/${d['id']}/fail', {'reason': 'OTHER', 'comment': 'Fin de test'});
    }
    final deliveryId = await assignedDelivery(token);

    final state = AppState(api: Api(client: SwitchClient()));
    await state.init();
    await state.store.wipe();
    await state.login('+243990000001', 'Demo1234!');
    await state.refresh();
    await state.respond(deliveryId, true);
    await state.enqueue(deliveryId: deliveryId, action: 'load', label: 'Chargement', localStatus: 'LOADED');
    await state.enqueue(deliveryId: deliveryId, action: 'start', label: 'Départ', localStatus: 'IN_TRANSIT');
    expect(state.missionById(deliveryId)!.status, 'IN_TRANSIT');

    await admin(token, 'POST', '/deliveries/$deliveryId/recall', {'reason': 'Le client annule'});
    await state.refresh();
    expect(state.recallNotice, contains('arrêtée par votre entreprise : Le client annule'));
    expect(state.missions.any((m) => m.id == deliveryId), isFalse, reason: 'plus dans les missions en cours');
    expect(state.ops.where((o) => o.deliveryId == deliveryId), isEmpty);
    expect(state.tripBlocking(state.missionById(deliveryId) ?? state.history.first), isNull);
    state.dismissRecall();
    expect(state.recallNotice, isNull);
  });
}
