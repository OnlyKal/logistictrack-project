/// Adresse du serveur. Par défaut : le serveur en ligne, en HTTPS.
/// En développement, la remplacer au lancement :
/// `flutter run --dart-define=API_URL=http://<adresse-de-l-ordinateur>:3000`.
const productionApiUrl = 'https://www.logisticstraack.com';

String get apiBaseUrl {
  const configured = String.fromEnvironment('API_URL');
  if (configured.isNotEmpty) return configured;
  return productionApiUrl;
}
