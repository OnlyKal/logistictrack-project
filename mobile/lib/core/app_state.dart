import 'dart:async';

import 'package:battery_plus/battery_plus.dart';
import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/foundation.dart';
import 'package:geolocator/geolocator.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:uuid/uuid.dart';

import 'api.dart';
import 'models.dart';
import 'store.dart';

enum GpsState { off, active, denied, disabled }

/// État de l'application : session, missions, synchronisation hors ligne et suivi GPS.
class AppState extends ChangeNotifier {
  AppState({Api? api, Store? store})
      : api = api ?? Api(),
        store = store ?? Store();

  final Api api;
  final Store store;
  static const _uuid = Uuid();

  bool ready = false;
  Map<String, dynamic>? profile;
  ProofRules rules = const ProofRules();
  List<Map<String, dynamic>> _missions = [];
  List<Map<String, dynamic>> _history = [];
  List<PendingOp> ops = [];
  int gpsPending = 0;
  bool online = true;
  bool syncing = false;
  bool _syncAgain = false;
  GpsState gps = GpsState.off;
  String? gpsMessage;
  DateTime? lastSync;

  StreamSubscription<Position>? _positions;
  StreamSubscription<List<ConnectivityResult>>? _connectivity;
  Timer? _flushTimer;
  DateTime? _lastRecorded;
  Future<bool>? _startingTracking;
  Position? lastPosition;
  String? _trackedDelivery;
  final _battery = Battery();

  bool get loggedIn => profile != null;
  List<PendingOp> get failedOps => ops.where((o) => o.failed).toList();
  int get pendingCount => ops.where((o) => !o.failed).length;

  Mission _view(Map<String, dynamic> raw) {
    final mine = ops.where((o) => o.deliveryId == raw['id']).toList();
    final waiting = mine.where((o) => !o.failed).toList();
    String? local;
    for (final o in waiting) {
      if (o.localStatus != null) local = o.localStatus;
    }
    return Mission(raw, localStatus: local, pendingOps: waiting.length, failedOps: mine.length - waiting.length);
  }

  /// Une mission terminée localement passe dans l'historique, avec son état non confirmé.
  List<Mission> get missions => _missions.map(_view).where((m) => !_isDone(m.status)).toList();
  List<Mission> get history => [..._missions.map(_view).where((m) => _isDone(m.status)), ..._history.where((h) => !_missions.any((m) => m['id'] == h['id'])).map(_view)];

  bool _isDone(String s) => const {'DELIVERED', 'PARTIALLY_DELIVERED', 'FAILED', 'RETURNED', 'CANCELLED'}.contains(s);

  Mission? missionById(String id) {
    for (final m in [..._missions, ..._history]) {
      if (m['id'] == id) return _view(m);
    }
    return null;
  }

  Future<void> init() async {
    await store.open();
    api.onSessionExpired = _onExpired;
    ops = await store.ops();
    gpsPending = await store.gpsCount();
    if (await api.restore()) {
      profile = (await store.getJson('profile') as Map?)?.cast<String, dynamic>();
      final cachedRules = await store.getJson('rules');
      if (cachedRules != null) rules = ProofRules.fromJson((cachedRules as Map).cast<String, dynamic>());
      _missions = ((await store.getJson('missions') as List?) ?? []).cast<Map>().map((e) => e.cast<String, dynamic>()).toList();
      _history = ((await store.getJson('history') as List?) ?? []).cast<Map>().map((e) => e.cast<String, dynamic>()).toList();
      if (profile != null) _afterLogin();
    }
    ready = true;
    notifyListeners();
  }

  /// Mission qui empêche de démarrer celle-ci : un seul trajet à la fois, sauf dans une même tournée.
  /// Vérifié aussi sur le téléphone, pour rester clair sans réseau.
  Mission? tripBlocking(Mission mission) {
    for (final other in _missions.map(_view)) {
      if (other.id == mission.id || (other.status != 'IN_TRANSIT' && other.status != 'ARRIVED')) continue;
      if (mission.routeId == null || other.routeId != mission.routeId) return other;
    }
    return null;
  }

  /// Passage périodique. Hors ligne, il revérifie le serveur : la connexion peut revenir sans que le
  /// téléphone change de réseau (panne du serveur, zone sans données). Tout repart alors tout seul.
  /// Toutes les deux passes (30 s), les missions sont relues : une mission arrêtée par le bureau apparaît vite.
  int _ticks = 0;
  Future<void> tick() async {
    if (!online) return refresh();
    await sync();
    if (++_ticks % 2 == 0 && !syncing) await _reloadMissions();
  }

  /// Mission arrêtée par l'entreprise pendant le trajet : message au chauffeur, opérations devenues inutiles retirées.
  String? recallNotice;
  void dismissRecall() {
    recallNotice = null;
    notifyListeners();
  }

  Future<void> _applyMissions(List<Map<String, dynamic>> active, List<Map<String, dynamic>> history) async {
    final before = _missions.map((m) => m['id'] as String).toSet();
    _missions = active;
    _history = history;
    for (final h in history.where((h) => before.contains(h['id']) && h['failureReason'] == 'RECALLED')) {
      final id = h['id'] as String;
      for (final op in ops.where((o) => o.deliveryId == id).toList()) {
        await store.removeOp(op.id);
      }
      final reason = (h['failureComment'] as String?)?.trim();
      recallNotice = 'La livraison ${h['number']} est arrêtée par votre entreprise${reason == null || reason.isEmpty ? '' : ' : $reason'}. Retournez à l\'entrepôt.';
    }
    ops = await store.ops();
  }

  void _afterLogin() {
    _connectivity ??= Connectivity().onConnectivityChanged.listen((result) {
      final nowOnline = result.any((r) => r != ConnectivityResult.none);
      final back = nowOnline && !online;
      online = nowOnline;
      notifyListeners();
      if (back) unawaited(refresh());
    });
    _flushTimer ??= Timer.periodic(const Duration(seconds: 15), (_) => unawaited(tick()));
    unawaited(refresh());
    resumeTrackingIfNeeded();
  }

  Future<void> login(String identifier, String password) async {
    final data = await api.login(identifier, password);
    final user = (data['user'] as Map).cast<String, dynamic>();
    if (user['driverId'] == null) {
      await api.clear();
      throw ApiException('Cette application est réservée aux chauffeurs. Les autres profils utilisent l\'interface Web.');
    }
    profile = user;
    await store.setJson('profile', user);
    _afterLogin();
    notifyListeners();
  }

  void _onExpired() {
    unawaited(_clearLocal());
  }

  /// Déconnexion : des opérations non synchronisées seraient perdues, l'écran le signale avant.
  Future<void> logout() async {
    try {
      await api.post('/auth/logout', {});
    } catch (_) {}
    await _clearLocal();
  }

  Future<void> _clearLocal() async {
    await stopTracking();
    _flushTimer?.cancel();
    _flushTimer = null;
    await _connectivity?.cancel();
    _connectivity = null;
    await api.clear();
    await store.wipe();
    profile = null;
    _missions = [];
    _history = [];
    ops = [];
    gpsPending = 0;
    notifyListeners();
  }

  /// Récupère l'état serveur après avoir envoyé ce qui est en attente.
  Future<void> refresh() async {
    await sync();
    try {
      final me = (await api.get('/drivers/me') as Map).cast<String, dynamic>();
      rules = ProofRules.fromJson((me['rules'] as Map).cast<String, dynamic>());
      await store.setJson('rules', me['rules'] as Object);
      await _applyMissions(
        ((await api.get('/drivers/me/missions?scope=active')) as List).cast<Map>().map((e) => e.cast<String, dynamic>()).toList(),
        ((await api.get('/drivers/me/missions?scope=history')) as List).cast<Map>().map((e) => e.cast<String, dynamic>()).toList(),
      );
      await store.setJson('missions', _missions);
      await store.setJson('history', _history);
      online = true;
      lastSync = DateTime.now();
    } on ApiException catch (e) {
      if (e.isRetryable) online = false;
    }
    notifyListeners();
    resumeTrackingIfNeeded();
  }

  // ---------- Opérations terrain ----------

  /// Enregistre une opération avec son heure locale, puis tente de l'envoyer.
  Future<void> enqueue({required String deliveryId, required String action, required String label, Map<String, dynamic> body = const {}, String? localStatus}) async {
    // Une nouvelle tentative remplace la précédente si le serveur l'avait refusée (preuve manquante, par exemple).
    for (final old in failedOps.where((o) => o.deliveryId == deliveryId && o.path == '/deliveries/$deliveryId/$action')) {
      await store.removeOp(old.id);
    }
    // Un nouveau départ ouvre un nouveau suivi : la session du trajet précédent est fermée.
    if (action == 'start') await store.setJson('session:$deliveryId', '');
    final id = _uuid.v4();
    final at = DateTime.now();
    final position = await _bestPosition();
    final op = PendingOp(
      id: id, deliveryId: deliveryId, path: '/deliveries/$deliveryId/$action', label: label, localStatus: localStatus, createdAt: at,
      body: {
        ...body, 'clientOpId': id, 'occurredAt': at.toUtc().toIso8601String(),
        if (position != null && body['latitude'] == null) 'latitude': position.latitude,
        if (position != null && body['longitude'] == null) 'longitude': position.longitude,
      },
    );
    await store.addOp(op);
    ops = await store.ops();
    notifyListeners();
    // Le suivi suit l'état local : à l'arrivée, la collecte s'arrête tout de suite, même sans réseau.
    resumeTrackingIfNeeded();
    await sync();
  }

  /// Position ponctuelle et récente pour une remise, sans relancer le suivi.
  /// Le délai est plus long que pour un simple événement : l'entreprise peut l'exiger.
  Future<Position?> proofPosition() => _bestPosition(wait: const Duration(seconds: 15));

  /// [position] : celle déjà obtenue pour la remise, pour que toutes ses preuves portent la même.
  Future<void> enqueueProof({required String deliveryId, required String type, required String filePath, required String mime, Position? position}) async {
    final id = _uuid.v4();
    final at = DateTime.now();
    position ??= await _bestPosition();
    await store.addOp(PendingOp(
      id: id, deliveryId: deliveryId, path: '/deliveries/$deliveryId/proofs', label: 'Preuve à envoyer', filePath: filePath, mime: mime, createdAt: at,
      body: {'type': type, 'clientOpId': id, 'capturedAt': at.toUtc().toIso8601String(), if (position != null) 'latitude': '${position.latitude}', if (position != null) 'longitude': '${position.longitude}'},
    ));
    ops = await store.ops();
    notifyListeners();
  }

  Future<void> enqueueScan({required String deliveryId, required String token, required String action}) async {
    // Un nouveau scan du même colis remplace celui que le serveur avait refusé : il ne bloque plus la mission.
    for (final old in failedOps.where((o) => o.path == '/packages/scan' && o.body['token'] == token && o.body['action'] == action)) {
      await store.removeOp(old.id);
    }
    final id = _uuid.v4();
    await store.addOp(PendingOp(
      id: id, deliveryId: deliveryId, path: '/packages/scan', label: 'Scan de colis', createdAt: DateTime.now(),
      body: {'token': token, 'action': action, 'deliveryId': deliveryId, 'clientOpId': id, 'occurredAt': DateTime.now().toUtc().toIso8601String()},
    ));
    // Le scan est mémorisé localement : l'écran reste juste même sans réseau.
    final scans = ((await store.getJson('scans:$deliveryId:$action') as List?) ?? []).cast<String>()..add(token);
    await store.setJson('scans:$deliveryId:$action', scans);
    ops = await store.ops();
    notifyListeners();
    unawaited(sync());
  }

  /// Scan refusé par le serveur : le colis redevient « à scanner » et le chargement reste verrouillé.
  Future<void> _forgetScan(PendingOp op) async {
    final key = 'scans:${op.deliveryId}:${op.body['action']}';
    final scans = ((await store.getJson(key) as List?) ?? []).cast<String>()..remove(op.body['token']);
    await store.setJson(key, scans);
  }

  Future<Set<String>> scannedTokens(String deliveryId, String action) async => ((await store.getJson('scans:$deliveryId:$action') as List?) ?? []).cast<String>().toSet();

  /// Accepter ou refuser exige le serveur : un refus doit être connu immédiatement.
  Future<void> respond(String deliveryId, bool accept, {String? note}) async {
    await api.post('/deliveries/$deliveryId/respond', {'accept': accept, if (note != null) 'note': note});
    await refresh();
  }

  Future<void> discardFailed(PendingOp op) async {
    await store.removeOp(op.id);
    ops = await store.ops();
    notifyListeners();
  }

  /// Relance une opération refusée après correction du problème.
  Future<void> retryFailed() async {
    // L'opération garde son rang : elle repart avant celles qui attendaient derrière elle.
    for (final op in failedOps) {
      await store.clearError(op.id);
    }
    ops = await store.ops();
    notifyListeners();
    await sync();
  }

  // ---------- Synchronisation ----------

  /// Envoie d'abord les positions, puis les opérations dans l'ordre chronologique.
  /// Une erreur réseau interrompt sans rien perdre ; un refus métier bloque seulement cette livraison.
  Future<void> sync() async {
    if (!api.hasSession) return;
    if (syncing) {
      _syncAgain = true;
      return;
    }
    _syncAgain = false;
    syncing = true;
    notifyListeners();
    var changed = false;
    try {
      await _flushGps();
      final blocked = <String>{};
      for (final op in await store.ops()) {
        if (op.failed) {
          if (op.deliveryId != null) blocked.add(op.deliveryId!);
          continue;
        }
        if (op.deliveryId != null && blocked.contains(op.deliveryId)) continue;
        try {
          if (op.filePath != null) {
            await api.multipart(op.path, op.body.map((k, v) => MapEntry(k, '$v')), filePath: op.filePath!, mimeType: op.mime ?? 'image/png');
          } else {
            await api.post(op.path, op.body);
          }
          await store.removeOp(op.id);
          changed = true;
          online = true;
        } on ApiException catch (e) {
          if (e.isRetryable || e.isAuth) {
            if (e.isRetryable) online = false;
            break;
          }
          await store.failOp(op.id, e.message);
          if (op.path == '/packages/scan') await _forgetScan(op);
          if (op.deliveryId != null) blocked.add(op.deliveryId!);
          changed = true;
        }
      }
    } on ApiException catch (e) {
      if (e.isRetryable) online = false;
    } finally {
      syncing = false;
      ops = await store.ops();
      gpsPending = await store.gpsCount();
      notifyListeners();
    }
    if (_syncAgain) {
      await sync();
    } else if (changed) {
      await _reloadMissions();
    }
  }

  Future<void> _reloadMissions() async {
    try {
      await _applyMissions(
        ((await api.get('/drivers/me/missions?scope=active')) as List).cast<Map>().map((e) => e.cast<String, dynamic>()).toList(),
        ((await api.get('/drivers/me/missions?scope=history')) as List).cast<Map>().map((e) => e.cast<String, dynamic>()).toList(),
      );
      await store.setJson('missions', _missions);
      await store.setJson('history', _history);
      lastSync = DateTime.now();
      notifyListeners();
      resumeTrackingIfNeeded();
    } on ApiException catch (_) {}
  }

  Future<void> _flushGps() async {
    for (var round = 0; round < 20; round++) {
      final batch = await store.gpsBatch(200);
      if (batch.isEmpty) return;
      final deliveryId = batch.first['deliveryId'] as String;
      final same = batch.where((b) => b['deliveryId'] == deliveryId).toList();
      final sessionKey = 'session:$deliveryId';
      var sessionId = await store.getJson(sessionKey) as String?;
      if (sessionId == null || sessionId.isEmpty) {
        final first = same.first['recordedAt'] as String;
        try {
          final session = (await api.post('/tracking/sessions/start', {'deliveryId': deliveryId, 'startedAt': first}) as Map);
          sessionId = session['id'] as String;
          await store.setJson(sessionKey, sessionId);
        } on ApiException catch (e) {
          if (e.isRetryable || e.isAuth) rethrow;
          // Mission retirée ou déjà close côté serveur : ces positions ne peuvent plus être rattachées.
          await store.removeGps(same.map((b) => b['clientId'] as String).toList());
          continue;
        }
      }
      final positions = same.map((b) => Map<String, dynamic>.from(b)..remove('deliveryId')).toList();
      try {
        await api.post('/tracking/positions', {'sessionId': sessionId, 'positions': positions});
        online = true;
      } on ApiException catch (e) {
        if (e.isRetryable || e.isAuth) rethrow;
        // Session inconnue du serveur : les positions restent en local et une nouvelle session est ouverte.
        if (e.status == 404) {
          await store.setJson(sessionKey, '');
          continue;
        }
      }
      await store.removeGps(same.map((b) => b['clientId'] as String).toList());
    }
  }

  // ---------- Suivi GPS : le téléphone est le traceur ----------

  void resumeTrackingIfNeeded() {
    final active = _missions.map(_view).where((m) => needsTracking(m.status)).toList();
    if (active.isEmpty) {
      if (_positions != null) unawaited(stopTracking());
      return;
    }
    if (_positions == null) unawaited(startTracking(active.first.id));
    _trackedDelivery = active.first.id;
  }

  /// Vérifie les autorisations puis démarre la collecte. Renvoie faux si elle est impossible.
  Future<bool> startTracking(String deliveryId) async {
    _trackedDelivery = deliveryId;
    if (_positions != null) return true;
    // Une seule demande d'autorisation à la fois : le système refuse les demandes simultanées.
    return _startingTracking ??= _openTracking().catchError((Object e) {
      gps = GpsState.disabled;
      gpsMessage = 'Localisation indisponible sur ce téléphone.';
      notifyListeners();
      return false;
    }).whenComplete(() => _startingTracking = null);
  }

  Future<bool> _openTracking() async {
    if (!await Geolocator.isLocationServiceEnabled()) {
      gps = GpsState.disabled;
      gpsMessage = 'La localisation du téléphone est désactivée.';
      notifyListeners();
      return false;
    }
    var permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) permission = await Geolocator.requestPermission();
    if (permission == LocationPermission.denied || permission == LocationPermission.deniedForever) {
      gps = GpsState.denied;
      gpsMessage = 'Autorisez la localisation pour le suivi de vos missions.';
      notifyListeners();
      return false;
    }
    // Android 13 et plus : sans cette autorisation, la notification « mission en cours » est masquée.
    // Le suivi fonctionne quand même : un refus ne bloque pas le départ.
    if (defaultTargetPlatform == TargetPlatform.android) {
      try {
        if (await Permission.notification.isDenied) await Permission.notification.request();
      } catch (_) {}
    }
    final LocationSettings settings = switch (defaultTargetPlatform) {
      TargetPlatform.android => AndroidSettings(
          accuracy: LocationAccuracy.high,
          intervalDuration: const Duration(seconds: 5),
          foregroundNotificationConfig: const ForegroundNotificationConfig(
            notificationTitle: 'LogisticTrack : mission en cours',
            notificationText: 'Votre position est suivie jusqu\'à votre arrivée.',
            enableWakeLock: true,
            setOngoing: true,
          ),
        ),
      TargetPlatform.iOS => AppleSettings(
          accuracy: LocationAccuracy.best,
          activityType: ActivityType.automotiveNavigation,
          pauseLocationUpdatesAutomatically: false,
          allowBackgroundLocationUpdates: true,
          showBackgroundLocationIndicator: true,
        ),
      _ => const LocationSettings(accuracy: LocationAccuracy.high),
    };
    _positions = Geolocator.getPositionStream(locationSettings: settings).listen(_onPosition, onError: (Object e) {
      gps = GpsState.disabled;
      gpsMessage = 'Signal GPS indisponible.';
      notifyListeners();
    });
    gps = GpsState.active;
    gpsMessage = null;
    notifyListeners();
    return true;
  }

  Future<void> stopTracking() async {
    await _positions?.cancel();
    _positions = null;
    _trackedDelivery = null;
    _lastRecorded = null;
    gps = GpsState.off;
    gpsMessage = null;
    notifyListeners();
  }

  Future<void> _onPosition(Position p) async {
    lastPosition = p;
    gps = GpsState.active;
    gpsMessage = null;
    final delivery = _trackedDelivery;
    if (delivery == null) return;
    final fields = measureFields(accuracy: p.accuracy, speed: p.speed, speedAccuracy: p.speedAccuracy, heading: p.heading, headingAccuracy: p.headingAccuracy, altitude: p.altitude, altitudeAccuracy: p.altitudeAccuracy);
    final since = _lastRecorded == null ? 1 << 30 : p.timestamp.difference(_lastRecorded!).inSeconds;
    if (!shouldRecordPosition(speedMs: fields['speedMs'] as double?, secondsSinceLast: since)) return;
    _lastRecorded = p.timestamp;
    int? battery;
    try {
      battery = await _battery.batteryLevel;
    } catch (_) {
      battery = null;
    }
    final id = _uuid.v4();
    await store.addGps(id, delivery, {
      'latitude': p.latitude, 'longitude': p.longitude, ...fields, 'batteryLevel': battery != null && battery >= 0 && battery <= 100 ? battery : null,
      'isOnline': online, 'recordedAt': p.timestamp.toUtc().toIso8601String(),
    });
    gpsPending = await store.gpsCount();
    notifyListeners();
    unawaited(sync());
  }

  /// Position pour une preuve ou un événement. Ne bloque jamais le chauffeur : au pire, elle reste absente.
  Future<Position?> _bestPosition({Duration wait = const Duration(seconds: 3)}) async {
    if (lastPosition != null && DateTime.now().difference(lastPosition!.timestamp).inSeconds < 120) return lastPosition;
    try {
      final permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied || permission == LocationPermission.deniedForever) return null;
      final known = await Geolocator.getLastKnownPosition();
      if (known != null && DateTime.now().difference(known.timestamp).inSeconds < 120) return known;
      return await Geolocator.getCurrentPosition(locationSettings: LocationSettings(accuracy: LocationAccuracy.high, timeLimit: wait));
    } catch (_) {
      return null;
    }
  }

  @override
  void dispose() {
    _flushTimer?.cancel();
    _positions?.cancel();
    _connectivity?.cancel();
    super.dispose();
  }
}
