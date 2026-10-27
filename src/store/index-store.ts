import type { StatementSync } from 'node:sqlite';
import type { ParsedFile } from '../core/types.js';
import type { Resolution } from '../indexer/resolve.js';
import type { Db, Row, SqlValue } from './db.js';
import {
  toFileRow,
  toImportRow,
  toRefRow,
  toSymbolRow,
  toUnresolvedRow,
  type FileRow,
  type FileStatus,
  type ImportRow,
  type RefRow,
  type SymbolRow,
  type UnresolvedRow,
} from './rows.js';

export interface FileUpsert {
  path: string;
  hash: string;
  size: number;
  mtimeMs: number;
  language: string;
  status: FileStatus;
  isTest: boolean;
  lineCount: number;
  adapter: string;
  generation: number;
  error: string | null;
}

/** Search text stored per symbol in FTS (bodies come from the file text, never paraphrased). */
export interface FtsDoc {
  path: string;
  name: string;
  terms: string;
  signature: string;
  doc: string;
  body: string;
}

export interface FtsHit extends FtsDoc {
  rowid: number;
  fileId: number;
  symbolOrdinal: number | null;
  bm25: number;
}

/** BM25 column weights: path, name, terms, signature, doc, body, file_id, symbol_ordinal. */
const BM25_WEIGHTS = '2.0, 8.0, 5.0, 3.0, 2.0, 1.0, 0.0, 0.0';

export class IndexStore {
  private readonly db: Db;
  private readonly statements = new Map<string, StatementSync>();

  constructor(db: Db) {
    this.db = db;
  }

  private stmt(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  private all(sql: string, ...params: SqlValue[]): Row[] {
    return this.stmt(sql).all(...params) as Row[];
  }

  private get(sql: string, ...params: SqlValue[]): Row | undefined {
    return this.stmt(sql).get(...params) as Row | undefined;
  }

  private run(sql: string, ...params: SqlValue[]): void {
    this.stmt(sql).run(...params);
  }

  // ---- meta ---------------------------------------------------------------

  getMeta(key: string): string | null {
    const row = this.get('SELECT value FROM meta WHERE key = ?', key);
    return row ? String(row.value) : null;
  }

  setMeta(key: string, value: string): void {
    this.run('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
  }

  generation(): number {
    return Number(this.getMeta('generation') ?? '0');
  }

  bumpGeneration(): number {
    const next = this.generation() + 1;
    this.setMeta('generation', String(next));
    return next;
  }

  // ---- files --------------------------------------------------------------

  allFiles(): FileRow[] {
    return this.all('SELECT * FROM files ORDER BY path').map(toFileRow);
  }

  fileByPath(path: string): FileRow | null {
    const row = this.get('SELECT * FROM files WHERE path = ?', path);
    return row ? toFileRow(row) : null;
  }

  fileById(id: number): FileRow | null {
    const row = this.get('SELECT * FROM files WHERE id = ?', id);
    return row ? toFileRow(row) : null;
  }

  /** Files whose path ends with `suffix` (used to resolve partial paths mentioned in a task). */
  filesBySuffix(suffix: string, limit = 10): FileRow[] {
    const escaped = suffix.replace(/[\\%_]/g, (c) => `\\${c}`);
    return this.all("SELECT * FROM files WHERE path = ? OR path LIKE ? ESCAPE '\\' ORDER BY length(path), path LIMIT ?", suffix, `%/${escaped}`, limit).map(toFileRow);
  }

  upsertFile(file: FileUpsert): number {
    const row = this.get(
      `INSERT INTO files(path, hash, size, mtime_ms, language, status, is_test, line_count, adapter, generation, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET hash = excluded.hash, size = excluded.size, mtime_ms = excluded.mtime_ms,
         language = excluded.language, status = excluded.status, is_test = excluded.is_test, line_count = excluded.line_count,
         adapter = excluded.adapter, generation = excluded.generation, error = excluded.error
       RETURNING id`,
      file.path,
      file.hash,
      file.size,
      file.mtimeMs,
      file.language,
      file.status,
      file.isTest ? 1 : 0,
      file.lineCount,
      file.adapter,
      file.generation,
      file.error,
    );
    return Number(row?.id);
  }

  touchFile(id: number, size: number, mtimeMs: number): void {
    this.run('UPDATE files SET size = ?, mtime_ms = ? WHERE id = ?', size, mtimeMs, id);
  }

  renameFile(id: number, newPath: string, size: number, mtimeMs: number, generation: number): void {
    this.clearFts(id);
    this.run('UPDATE files SET path = ?, size = ?, mtime_ms = ?, generation = ? WHERE id = ?', newPath, size, mtimeMs, generation, id);
  }

  deleteFile(id: number): void {
    this.clearFts(id);
    this.run('DELETE FROM files WHERE id = ?', id);
  }

  countFilesByStatus(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const row of this.all('SELECT status, count(*) AS n FROM files GROUP BY status')) out[String(row.status)] = Number(row.n);
    return out;
  }

  // ---- parsed data --------------------------------------------------------

  private clearFts(fileId: number): void {
    this.run('DELETE FROM fts WHERE rowid IN (SELECT id FROM symbols WHERE file_id = ?)', fileId);
    this.run('DELETE FROM fts WHERE rowid = ?', -fileId);
  }

  clearParsed(fileId: number): void {
    this.clearFts(fileId);
    this.run('DELETE FROM symbols WHERE file_id = ?', fileId);
    this.run('DELETE FROM imports WHERE file_id = ?', fileId);
    this.run('DELETE FROM refs WHERE file_id = ?', fileId);
    this.run('DELETE FROM unresolved WHERE file_id = ?', fileId);
  }

  /** Replace all derived rows of one file. `docs[i]` is the FTS document for parsed.symbols[i]. */
  replaceParsed(fileId: number, parsed: ParsedFile, docs: FtsDoc[], fileDoc: FtsDoc): void {
    this.clearParsed(fileId);
    parsed.symbols.forEach((s, ordinal) => {
      const row = this.get(
        `INSERT INTO symbols(file_id, ordinal, name, qual_name, kind, start_line, end_line, exported, export_names, signature, doc, parent_ordinal, flags)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        fileId, ordinal, s.name, s.qualName, s.kind, s.span.startLine, s.span.endLine, s.exported ? 1 : 0,
        JSON.stringify(s.exportNames), s.signature, s.doc, s.parent, JSON.stringify(s.flags),
      );
      const doc = docs[ordinal];
      if (doc) this.insertFts(Number(row?.id), fileId, ordinal, doc);
    });
    this.insertFts(-fileId, fileId, null, fileDoc);
    parsed.imports.forEach((imp, ordinal) => {
      this.run(
        'INSERT INTO imports(file_id, ordinal, spec, kind, bindings, line, resolved_path, resolution) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)',
        fileId, ordinal, imp.spec, imp.kind, JSON.stringify(imp.bindings), imp.line, 'pending',
      );
    });
    for (const ref of parsed.refs) {
      const isLocal = ref.target.type === 'local';
      const targetOrdinal = ref.target.type === 'local' ? ref.target.symbol : ref.target.importIndex;
      const targetName = ref.target.type === 'import' ? ref.target.name : null;
      this.run(
        'INSERT INTO refs(file_id, from_ordinal, target_type, target_ordinal, target_name, kind, line, count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        fileId, ref.from, isLocal ? 'local' : 'import', targetOrdinal, targetName, ref.kind, ref.line, ref.count,
      );
    }
    for (const u of parsed.unresolved) {
      this.run('INSERT INTO unresolved(file_id, line, kind, detail) VALUES (?, ?, ?, ?)', fileId, u.line, u.kind, u.detail);
    }
  }

  /** File-level FTS entry for files without parsed symbols (noise/unsupported): path search only. */
  replaceFileOnly(fileId: number, fileDoc: FtsDoc): void {
    this.clearParsed(fileId);
    this.insertFts(-fileId, fileId, null, fileDoc);
  }

  private insertFts(rowid: number, fileId: number, ordinal: number | null, doc: FtsDoc): void {
    this.run(
      'INSERT INTO fts(rowid, path, name, terms, signature, doc, body, file_id, symbol_ordinal) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      rowid, doc.path, doc.name, doc.terms, doc.signature, doc.doc, doc.body, fileId, ordinal,
    );
  }

  // ---- imports / resolution -------------------------------------------------

  importsToResolve(onlyPending: boolean): Array<ImportRow & { path: string; language: string }> {
    const where = onlyPending ? "WHERE i.resolution = 'pending'" : "WHERE i.resolution IN ('pending', 'unresolved', 'resolved', 'excluded')";
    return this.all(`SELECT i.*, f.path AS path, f.language AS language FROM imports i JOIN files f ON f.id = i.file_id ${where}`).map(
      (row) => ({ ...toImportRow(row), path: String(row.path), language: String(row.language) }),
    );
  }

  setResolution(importId: number, resolution: Resolution, resolvedPath: string | null): void {
    this.run('UPDATE imports SET resolution = ?, resolved_path = ? WHERE id = ?', resolution, resolvedPath, importId);
  }

  importsOfFile(fileId: number): ImportRow[] {
    return this.all('SELECT * FROM imports WHERE file_id = ? ORDER BY ordinal', fileId).map(toImportRow);
  }

  importersOf(path: string): Array<ImportRow & { path: string }> {
    return this.all(
      'SELECT i.*, f.path AS path FROM imports i JOIN files f ON f.id = i.file_id WHERE i.resolved_path = ? ORDER BY f.path, i.ordinal',
      path,
    ).map((row) => ({ ...toImportRow(row), path: String(row.path) }));
  }

  /** Every resolved import edge as (importing file, imported file). */
  resolvedEdges(): Array<{ from: string; to: string }> {
    return this.all(
      "SELECT DISTINCT f.path AS src, i.resolved_path AS dst FROM imports i JOIN files f ON f.id = i.file_id WHERE i.resolution = 'resolved' AND i.resolved_path IS NOT NULL",
    ).map((row) => ({ from: String(row.src), to: String(row.dst) }));
  }

  /** Number of distinct importing files per resolved target path. */
  importerCounts(): Map<string, number> {
    const out = new Map<string, number>();
    for (const row of this.all(
      "SELECT resolved_path AS path, count(DISTINCT file_id) AS n FROM imports WHERE resolution = 'resolved' AND resolved_path IS NOT NULL GROUP BY resolved_path",
    )) {
      out.set(String(row.path), Number(row.n));
    }
    return out;
  }

  countImportsByResolution(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const row of this.all('SELECT resolution, count(*) AS n FROM imports GROUP BY resolution')) out[String(row.resolution)] = Number(row.n);
    return out;
  }

  unresolvedImports(limit: number): Array<ImportRow & { path: string }> {
    return this.all(
      "SELECT i.*, f.path AS path FROM imports i JOIN files f ON f.id = i.file_id WHERE i.resolution = 'unresolved' ORDER BY f.path, i.line LIMIT ?",
      limit,
    ).map((row) => ({ ...toImportRow(row), path: String(row.path) }));
  }

  // ---- symbols / refs -------------------------------------------------------

  symbolsOfFile(fileId: number): SymbolRow[] {
    return this.all('SELECT * FROM symbols WHERE file_id = ? ORDER BY ordinal', fileId).map(toSymbolRow);
  }

  symbolByOrdinal(fileId: number, ordinal: number): SymbolRow | null {
    const row = this.get('SELECT * FROM symbols WHERE file_id = ? AND ordinal = ?', fileId, ordinal);
    return row ? toSymbolRow(row) : null;
  }

  symbolsByName(name: string, limit = 25): Array<SymbolRow & { path: string }> {
    return this.all(
      'SELECT s.*, f.path AS path FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.name = ? OR s.qual_name = ? ORDER BY f.path, s.start_line LIMIT ?',
      name, name, limit,
    ).map((row) => ({ ...toSymbolRow(row), path: String(row.path) }));
  }

  symbolsByNameInsensitive(name: string, limit = 25): Array<SymbolRow & { path: string }> {
    return this.all(
      'SELECT s.*, f.path AS path FROM symbols s JOIN files f ON f.id = s.file_id WHERE lower(s.name) = lower(?) ORDER BY f.path, s.start_line LIMIT ?',
      name, limit,
    ).map((row) => ({ ...toSymbolRow(row), path: String(row.path) }));
  }

  refsFrom(fileId: number, fromOrdinal: number): RefRow[] {
    return this.all('SELECT * FROM refs WHERE file_id = ? AND from_ordinal = ? ORDER BY line', fileId, fromOrdinal).map(toRefRow);
  }

  refsOfFile(fileId: number): RefRow[] {
    return this.all('SELECT * FROM refs WHERE file_id = ? ORDER BY line', fileId).map(toRefRow);
  }

  refsToLocal(fileId: number, ordinal: number): RefRow[] {
    return this.all("SELECT * FROM refs WHERE file_id = ? AND target_type = 'local' AND target_ordinal = ? ORDER BY line", fileId, ordinal).map(toRefRow);
  }

  refsToImport(fileId: number, importOrdinal: number): RefRow[] {
    return this.all("SELECT * FROM refs WHERE file_id = ? AND target_type = 'import' AND target_ordinal = ? ORDER BY line", fileId, importOrdinal).map(toRefRow);
  }

  unresolvedOfFile(fileId: number): UnresolvedRow[] {
    return this.all('SELECT * FROM unresolved WHERE file_id = ? ORDER BY line', fileId).map(toUnresolvedRow);
  }

  unresolvedAll(limit: number): Array<UnresolvedRow & { path: string }> {
    return this.all('SELECT u.*, f.path AS path FROM unresolved u JOIN files f ON f.id = u.file_id ORDER BY f.path, u.line LIMIT ?', limit).map(
      (row) => ({ ...toUnresolvedRow(row), path: String(row.path) }),
    );
  }

  countUnresolvedByKind(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const row of this.all('SELECT kind, count(*) AS n FROM unresolved GROUP BY kind')) out[String(row.kind)] = Number(row.n);
    return out;
  }

  countSymbolsByKind(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const row of this.all('SELECT kind, count(*) AS n FROM symbols GROUP BY kind ORDER BY n DESC')) out[String(row.kind)] = Number(row.n);
    return out;
  }

  countRefs(): { local: number; imported: number } {
    const row = this.get("SELECT sum(target_type = 'local') AS local, sum(target_type = 'import') AS imported FROM refs");
    return { local: Number(row?.local ?? 0), imported: Number(row?.imported ?? 0) };
  }

  // ---- full-text search -----------------------------------------------------

  ftsSearch(match: string, limit: number): FtsHit[] {
    return this.all(
      `SELECT rowid, path, name, terms, signature, doc, body, file_id, symbol_ordinal, bm25(fts, ${BM25_WEIGHTS}) AS score
       FROM fts WHERE fts MATCH ? ORDER BY score LIMIT ?`,
      match, limit,
    ).map((row) => ({
      rowid: Number(row.rowid),
      fileId: Number(row.file_id),
      symbolOrdinal: row.symbol_ordinal === null || row.symbol_ordinal === undefined ? null : Number(row.symbol_ordinal),
      bm25: Number(row.score),
      path: String(row.path),
      name: String(row.name),
      terms: String(row.terms),
      signature: String(row.signature),
      doc: String(row.doc),
      body: String(row.body),
    }));
  }

  ftsCount(match: string): number {
    const row = this.get('SELECT count(*) AS n FROM fts WHERE fts MATCH ?', match);
    return Number(row?.n ?? 0);
  }

  ftsTotal(): number {
    const row = this.get('SELECT count(*) AS n FROM fts');
    return Number(row?.n ?? 0);
  }

  // ---- renames ----------------------------------------------------------------

  recordRename(oldPath: string, newPath: string, generation: number): void {
    this.run('INSERT INTO renames(old_path, new_path, generation, ts) VALUES (?, ?, ?, ?)', oldPath, newPath, generation, Date.now());
  }
}
