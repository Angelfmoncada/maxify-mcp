import { createRequire } from 'node:module';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';

export type Db = DatabaseSync;
export type SqlValue = SQLInputValue;
export type Row = Record<string, unknown>;

const require = createRequire(import.meta.url);

/**
 * Open (or create) the index database. node:sqlite is loaded lazily so the
 * CLI can install its warning filter first.
 */
export function openDatabase(file: string): Db {
  const sqlite = require('node:sqlite') as typeof import('node:sqlite');
  const db = new sqlite.DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  const version = row?.user_version ?? 0;
  if (version === SCHEMA_VERSION) return;
  if (version !== 0) {
    // Index data is derived and rebuildable: drop everything on schema change.
    const tables = db
      .prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table') AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>;
    for (const { name } of tables) {
      if (name.includes('_')) {
        // FTS shadow tables are dropped with their virtual table.
        const isShadow = tables.some((t) => t.name !== name && name.startsWith(`${t.name}_`));
        if (isShadow) continue;
      }
      db.exec(`DROP TABLE IF EXISTS "${name.replace(/"/g, '""')}"`);
    }
  }
  db.exec(SCHEMA_SQL);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

/** Run `fn` inside an IMMEDIATE transaction; rolls back on error. */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error: unknown) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** Verify the SQLite build supports FTS5 (used by doctor and on open). */
export function hasFts5(db: Db): boolean {
  try {
    db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS temp.__fts5_probe USING fts5(x)');
    db.exec('DROP TABLE IF EXISTS temp.__fts5_probe');
    return true;
  } catch {
    return false;
  }
}
