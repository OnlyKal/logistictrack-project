import 'dart:convert';

import 'package:path/path.dart' as p;
import 'package:sqflite/sqflite.dart';

/// Stockage local : file d'opérations à synchroniser, positions GPS en attente, cache des missions.
class Store {
  late Database _db;

  Future<void> open() async {
    _db = await openDatabase(
      p.join(await getDatabasesPath(), 'logistictrack.db'),
      version: 1,
      onCreate: (db, _) async {
        await db.execute('''CREATE TABLE ops(
          seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, delivery_id TEXT, path TEXT NOT NULL, body TEXT NOT NULL,
          file_path TEXT, mime TEXT, local_status TEXT, label TEXT NOT NULL, created_at TEXT NOT NULL, error TEXT)''');
        await db.execute('''CREATE TABLE gps(
          client_id TEXT PRIMARY KEY, delivery_id TEXT NOT NULL, payload TEXT NOT NULL)''');
        await db.execute('CREATE TABLE kv(k TEXT PRIMARY KEY, v TEXT NOT NULL)');
      },
    );
  }

  Future<void> setJson(String key, Object value) => _db.insert('kv', {'k': key, 'v': jsonEncode(value)}, conflictAlgorithm: ConflictAlgorithm.replace);

  Future<dynamic> getJson(String key) async {
    final rows = await _db.query('kv', where: 'k = ?', whereArgs: [key]);
    return rows.isEmpty ? null : jsonDecode(rows.first['v'] as String);
  }

  Future<void> removeKey(String key) => _db.delete('kv', where: 'k = ?', whereArgs: [key]);

  Future<void> addOp(PendingOp op) => _db.insert('ops', op.toRow());

  Future<List<PendingOp>> ops() async => (await _db.query('ops', orderBy: 'seq ASC')).map(PendingOp.fromRow).toList();

  Future<void> removeOp(String id) => _db.delete('ops', where: 'id = ?', whereArgs: [id]);

  Future<void> failOp(String id, String error) => _db.update('ops', {'error': error}, where: 'id = ?', whereArgs: [id]);

  /// Remet une opération refusée en attente, à sa place d'origine dans la file.
  Future<void> clearError(String id) => _db.update('ops', {'error': null}, where: 'id = ?', whereArgs: [id]);

  Future<void> addGps(String clientId, String deliveryId, Map<String, dynamic> payload) =>
      _db.insert('gps', {'client_id': clientId, 'delivery_id': deliveryId, 'payload': jsonEncode(payload)}, conflictAlgorithm: ConflictAlgorithm.ignore);

  Future<List<Map<String, dynamic>>> gpsBatch(int limit) async {
    final rows = await _db.query('gps', limit: limit, orderBy: 'rowid ASC');
    return rows.map((r) => {'clientId': r['client_id'], 'deliveryId': r['delivery_id'], ...jsonDecode(r['payload'] as String) as Map<String, dynamic>}).toList();
  }

  Future<int> gpsCount() async => Sqflite.firstIntValue(await _db.rawQuery('SELECT COUNT(*) FROM gps')) ?? 0;

  Future<void> removeGps(List<String> clientIds) async {
    if (clientIds.isEmpty) return;
    await _db.delete('gps', where: 'client_id IN (${List.filled(clientIds.length, '?').join(',')})', whereArgs: clientIds);
  }

  /// Efface toutes les données locales à la déconnexion.
  Future<void> wipe() async {
    await _db.delete('ops');
    await _db.delete('gps');
    await _db.delete('kv');
  }
}

/// Opération terrain : son identifiant (clientOpId) la rend sans effet si elle est rejouée.
class PendingOp {
  PendingOp({required this.id, this.deliveryId, required this.path, required this.body, this.filePath, this.mime, this.localStatus, required this.label, required this.createdAt, this.error});

  final String id;
  final String? deliveryId;
  final String path;
  final Map<String, dynamic> body;
  final String? filePath;
  final String? mime;
  final String? localStatus;
  final String label;
  final DateTime createdAt;
  final String? error;

  bool get failed => error != null;

  Map<String, Object?> toRow() => {
        'id': id, 'delivery_id': deliveryId, 'path': path, 'body': jsonEncode(body), 'file_path': filePath, 'mime': mime,
        'local_status': localStatus, 'label': label, 'created_at': createdAt.toIso8601String(), 'error': error,
      };

  static PendingOp fromRow(Map<String, Object?> r) => PendingOp(
        id: r['id'] as String, deliveryId: r['delivery_id'] as String?, path: r['path'] as String, body: jsonDecode(r['body'] as String) as Map<String, dynamic>,
        filePath: r['file_path'] as String?, mime: r['mime'] as String?, localStatus: r['local_status'] as String?, label: r['label'] as String,
        createdAt: DateTime.parse(r['created_at'] as String), error: r['error'] as String?,
      );
}
