import { DatabaseSync } from 'node:sqlite';

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  return db;
}

// Cada módulo traz sua lista de migrações. Elas rodam uma vez só, em ordem.
// Nunca altere uma migração já publicada: acrescente uma nova no fim da lista.
export function migrate(db, moduleName, migrations = []) {
  migrations.forEach((sql, index) => {
    const id = `${moduleName}:${index + 1}`;
    if (db.prepare('SELECT 1 FROM _migrations WHERE id = ?').get(id)) return;
    transaction(db, () => {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (id, applied_at) VALUES (?, ?)').run(id, new Date().toISOString());
    });
  });
}

export function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
