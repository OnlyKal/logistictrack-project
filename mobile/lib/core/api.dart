import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;
import 'package:http_parser/http_parser.dart';

import 'config.dart';

class ApiException implements Exception {
  ApiException(this.message, {this.status = 0, this.code});
  final String message;
  final int status;
  final String? code;

  /// Coupure réseau ou panne serveur : l'opération doit rester en file d'attente.
  bool get isRetryable => status == 0 || status >= 500 || status == 429;
  bool get isAuth => status == 401;

  @override
  String toString() => message;
}

/// Client REST : jetons conservés dans le stockage sécurisé du téléphone, rafraîchissement automatique.
class Api {
  Api({http.Client? client, FlutterSecureStorage? storage})
      : _client = client ?? http.Client(),
        _storage = storage ?? const FlutterSecureStorage();

  static const _timeout = Duration(seconds: 25);
  final http.Client _client;
  final FlutterSecureStorage _storage;
  String? _access;
  String? _refresh;
  Future<bool>? _refreshing;

  /// Appelé quand la session n'est plus valide.
  void Function()? onSessionExpired;

  Uri _uri(String path) => Uri.parse('$apiBaseUrl/api/v1$path');

  Future<bool> restore() async {
    try {
      _refresh = await _storage.read(key: 'refresh');
    } catch (_) {
      // Stockage sécurisé illisible (clé du téléphone changée, sauvegarde restaurée) :
      // le chauffeur se reconnecte. Les opérations en attente, dans la base locale, sont conservées.
      _refresh = null;
      try {
        await _storage.deleteAll();
      } catch (_) {}
    }
    return _refresh != null;
  }

  bool get hasSession => _refresh != null;

  Future<void> _saveTokens(Map<String, dynamic> data) async {
    _access = data['accessToken'] as String? ?? _access;
    final refresh = data['refreshToken'] as String?;
    if (refresh != null) {
      _refresh = refresh;
      await _storage.write(key: 'refresh', value: refresh);
    }
  }

  Future<void> clear() async {
    _access = null;
    _refresh = null;
    await _storage.delete(key: 'refresh');
  }

  Future<Map<String, dynamic>> login(String identifier, String password) async {
    final data = await post('/auth/login', {'identifier': identifier, 'password': password}, auth: false);
    await _saveTokens(data as Map<String, dynamic>);
    return data;
  }

  /// Un seul rafraîchissement à la fois : les appels simultanés attendent le même résultat.
  Future<bool> _doRefresh() {
    final running = _refreshing;
    if (running != null) return running;
    final future = _refreshNow();
    _refreshing = future;
    // Libéré seulement une fois terminé, et après l'affectation ci-dessus, même si la réponse est immédiate.
    unawaited(future.then((_) {}, onError: (Object _) {}).whenComplete(() {
      if (identical(_refreshing, future)) _refreshing = null;
    }));
    return future;
  }

  Future<bool> _refreshNow() async {
    try {
      final token = _refresh;
      if (token == null) return false;
      final res = await _client
          .post(_uri('/auth/refresh'), headers: {'content-type': 'application/json'}, body: jsonEncode({'refreshToken': token}))
          .timeout(_timeout);
      if (res.statusCode != 200) {
        if (res.statusCode == 401) {
          await clear();
          onSessionExpired?.call();
        }
        return false;
      }
      await _saveTokens((jsonDecode(res.body) as Map<String, dynamic>)['data'] as Map<String, dynamic>);
      return true;
    } on SocketException {
      throw ApiException('Pas de connexion au serveur.');
    } on TimeoutException {
      throw ApiException('Le serveur ne répond pas.');
    } on http.ClientException {
      throw ApiException('Pas de connexion au serveur.');
    }
  }

  Map<String, String> _headers({bool json = true}) => {
        if (json) 'content-type': 'application/json',
        if (_access != null) 'authorization': 'Bearer $_access',
      };

  dynamic _parse(http.Response res) {
    Map<String, dynamic>? body;
    try {
      body = jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
    } catch (_) {
      body = null;
    }
    if (res.statusCode >= 200 && res.statusCode < 300) return body?['data'];
    throw ApiException(body?['message']?.toString() ?? 'Erreur ${res.statusCode}', status: res.statusCode, code: body?['code']?.toString());
  }

  Future<http.Response> _send(Future<http.Response> Function() request, bool auth) async {
    try {
      if (auth && _access == null && _refresh != null) await _doRefresh();
      var res = await request().timeout(_timeout);
      if (res.statusCode == 401 && auth && _refresh != null) {
        if (await _doRefresh()) res = await request().timeout(_timeout);
      }
      return res;
    } on SocketException {
      throw ApiException('Pas de connexion au serveur.');
    } on TimeoutException {
      throw ApiException('Le serveur ne répond pas.');
    } on http.ClientException {
      throw ApiException('Pas de connexion au serveur.');
    }
  }

  Future<dynamic> get(String path) async => _parse(await _send(() => _client.get(_uri(path), headers: _headers(json: false)), true));

  Future<dynamic> post(String path, Map<String, dynamic> body, {bool auth = true}) async =>
      _parse(await _send(() => _client.post(_uri(path), headers: _headers(), body: jsonEncode(body)), auth));

  Future<dynamic> multipart(String path, Map<String, String> fields, {required String filePath, required String mimeType}) async {
    final bytes = await File(filePath).readAsBytes();
    return _parse(await _send(() async {
      final req = http.MultipartRequest('POST', _uri(path))
        ..headers.addAll(_headers(json: false))
        ..fields.addAll(fields)
        ..files.add(http.MultipartFile.fromBytes('file', bytes, filename: filePath.split(Platform.pathSeparator).last, contentType: MediaType.parse(mimeType)));
      return http.Response.fromStream(await _client.send(req));
    }, true));
  }
}
