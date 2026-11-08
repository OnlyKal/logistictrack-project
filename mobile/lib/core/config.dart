/// Adresse du serveur : `flutter run --dart-define=API_URL=https://api.exemple.com`.
/// `API_URL` peut remplacer cette adresse au lancement.
String get apiBaseUrl {
  const configured = String.fromEnvironment('API_URL');
  if (configured.isNotEmpty) return configured;
  return 'http://172.20.10.12:3000';
}
