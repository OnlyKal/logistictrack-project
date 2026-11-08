/// Vue typée d'une mission reçue de l'API. Le statut peut être surchargé par une opération locale.
class Mission {
  Mission(this.raw, {this.localStatus, this.pendingOps = 0, this.failedOps = 0});

  final Map<String, dynamic> raw;
  final String? localStatus;
  final int pendingOps;
  final int failedOps;

  String get id => raw['id'] as String;
  String get number => raw['number'] as String;
  String get serverStatus => raw['status'] as String;
  String get status => localStatus ?? serverStatus;
  bool get unconfirmed => pendingOps > 0;
  String? get routeId => (raw['route'] as Map?)?['id'] as String?;
  String? get driverResponse => raw['driverResponse'] as String?;
  String? get instructions => raw['instructions'] as String?;
  DateTime? get scheduledAt => DateTime.tryParse(raw['scheduledAt']?.toString() ?? '')?.toLocal();
  Map<String, dynamic> get customer => raw['customer'] as Map<String, dynamic>;
  Map<String, dynamic> get point => raw['deliveryPoint'] as Map<String, dynamic>;
  Map<String, dynamic>? get vehicle => raw['vehicle'] as Map<String, dynamic>?;
  Map<String, dynamic>? get route => raw['route'] as Map<String, dynamic>?;
  List<Map<String, dynamic>> get items => (raw['items'] as List).cast<Map<String, dynamic>>();
  List<Map<String, dynamic>> get packages => (raw['packages'] as List).cast<Map<String, dynamic>>();
  String get destination => [point['address'], point['commune'], point['city']].where((e) => e != null && '$e'.isNotEmpty).join(', ');

  double get totalWeight => packages.fold(0, (sum, p) => sum + ((p['weightKg'] as num?)?.toDouble() ?? 0));
  double get totalVolume => packages.fold(0, (sum, p) => sum + ((p['volumeM3'] as num?)?.toDouble() ?? 0));
}

class ProofRules {
  const ProofRules({this.subscriptionActive = true, this.driversCanRefuse = true, this.signature = false, this.photo = false, this.recipientName = false, this.gps = false, this.qrOnLoad = false});

  factory ProofRules.fromJson(Map<String, dynamic> j) => ProofRules(
        subscriptionActive: j['subscriptionActive'] != false, driversCanRefuse: j['driversCanRefuse'] == true, signature: j['requireSignature'] == true, photo: j['requirePhoto'] == true,
        recipientName: j['requireRecipientName'] == true, gps: j['requireGpsOnProof'] == true, qrOnLoad: j['requireQrOnLoad'] == true,
      );

  final bool subscriptionActive;
  final bool driversCanRefuse;
  final bool signature;
  final bool photo;
  final bool recipientName;
  final bool gps;
  final bool qrOnLoad;
}

const missionStatusLabels = {
  'ASSIGNED': 'À charger', 'LOADED': 'Chargée', 'IN_TRANSIT': 'En route', 'ARRIVED': 'Arrivée', 'DELIVERED': 'Livrée',
  'PARTIALLY_DELIVERED': 'Livrée partiellement', 'FAILED': 'Échec', 'RETURNED': 'Retournée', 'CANCELLED': 'Annulée',
};

const failureReasons = {
  'CUSTOMER_ABSENT': 'Client absent', 'WRONG_ADDRESS': 'Adresse incorrecte', 'NO_ACCESS': 'Accès impossible', 'CUSTOMER_REFUSED': 'Refus du client',
  'DAMAGED': 'Colis endommagé', 'BREAKDOWN': 'Panne', 'INCIDENT': 'Incident', 'OTHER': 'Autre',
};

/// Motif réservé au bureau, affiché dans l'historique mais jamais proposé au chauffeur.
const recalledLabel = "Rappelé par l'entreprise";

/// Une mission encore active exige le suivi GPS du téléphone.
/// Le chauffeur n'est suivi que sur la route : du départ jusqu'à son arrivée.
bool needsTracking(String status) => status == 'IN_TRANSIT';

/// Fréquence d'envoi : 5 à 10 s en mouvement, 30 à 60 s à l'arrêt.
bool shouldRecordPosition({required double? speedMs, required int secondsSinceLast, int movingEvery = 7, int stoppedEvery = 45}) {
  final moving = (speedMs ?? 0) >= 1.0;
  return secondsSinceLast >= (moving ? movingEvery : stoppedEvery);
}

/// Normalise une mesure : une donnée que l'appareil ne fournit pas reste absente, jamais inventée.
Map<String, dynamic> measureFields({required double accuracy, required double speed, required double speedAccuracy, required double heading, required double headingAccuracy, required double altitude, required double altitudeAccuracy}) {
  return {
    'accuracyM': accuracy > 0 ? accuracy : null,
    'speedMs': speed > 0 || (speed == 0 && speedAccuracy > 0) ? speed : null,
    'headingDeg': heading >= 0 && headingAccuracy > 0 ? heading : null,
    'altitudeM': altitudeAccuracy > 0 ? altitude : null,
  };
}
