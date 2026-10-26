import type { StatementSync } from 'node:sqlite';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { Db, Row, SqlValue } from './db.js';

export interface NoteRef {
  /** Ref as given by the author, normalized: 'path' or 'path#Qual.Name'. */
  ref: string;
  path: string;
  symbol?: string;
  /** File content hash when the note was written or last re-anchored ('' if the file did not exist). */
  hash: string;
}

export interface NoteRow {
  id: string;
  text: string;
  kind: 'fact' | 'note' | 'decision';
  origin: 'agent' | 'user';
  refs: NoteRef[];
  createdAt: number;
  updatedAt: number;
}

export interface BlobRow {
  hash: string;
  kind: string;
  text: string;
  size: number;
  lines: number;
  source: string;
  createdAt: number;
  expiresAt: number;
}

export interface MetricInput {
  session: string;
  tool: string;
  estTokens: number;
  durationMs: number;
  complete: boolean;
  cacheHit: boolean;
  isError: boolean;
  extra: Record<string, unknown>;
}

export interface ToolAggregate {
  tool: string;
  calls: number;
  estTokens: number;
  avgMs: number;
  cacheHits: number;
  incomplete: number;
  errors: number;
}

function toNote(row: Row): NoteRow {
  let refs: NoteRef[] = [];
  try {
    const parsed: unknown = JSON.parse(String(row.refs));
    refs = Array.isArray(parsed) ? (parsed as NoteRef[]) : [];
  } catch {
    refs = [];
  }
  return {
    id: String(row.id),
    text: String(row.text),
    kind: String(row.kind) as NoteRow['kind'],
    origin: String(row.origin) as NoteRow['origin'],
    refs,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/** Notes, recoverable-compression blobs, the result cache and local metrics. */
export class AuxStore {
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

  // ---- notes ------------------------------------------------------------------

  putNote(note: NoteRow): void {
    this.run(
      `INSERT INTO notes(id, text, kind, origin, refs, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET text = excluded.text, kind = excluded.kind, origin = excluded.origin, refs = excluded.refs, updated_at = excluded.updated_at`,
      note.id, note.text, note.kind, note.origin, JSON.stringify(note.refs), note.createdAt, note.updatedAt,
    );
    this.run('DELETE FROM notes_fts WHERE note_id = ?', note.id);
    this.run('INSERT INTO notes_fts(text, note_id) VALUES (?, ?)', note.text, note.id);
  }

  getNote(id: string): NoteRow | null {
    const row = this.get('SELECT * FROM notes WHERE id = ?', id);
    return row ? toNote(row) : null;
  }

  deleteNote(id: string): boolean {
    const existed = this.getNote(id) !== null;
    this.run('DELETE FROM notes WHERE id = ?', id);
    this.run('DELETE FROM notes_fts WHERE note_id = ?', id);
    return existed;
  }

  listNotes(limit: number): NoteRow[] {
    return this.all('SELECT * FROM notes ORDER BY updated_at DESC, id LIMIT ?', limit).map(toNote);
  }

  allNotes(): NoteRow[] {
    return this.all('SELECT * FROM notes ORDER BY updated_at DESC, id').map(toNote);
  }

  searchNotes(match: string, limit: number): NoteRow[] {
    return this.all(
      'SELECT n.* FROM notes_fts f JOIN notes n ON n.id = f.note_id WHERE notes_fts MATCH ? ORDER BY bm25(notes_fts) LIMIT ?',
      match, limit,
    ).map(toNote);
  }

  countNotes(): number {
    return Number(this.get('SELECT count(*) AS n FROM notes')?.n ?? 0);
  }

  // ---- blobs (exact originals of compressed outputs) --------------------------

  putBlob(blob: Omit<BlobRow, 'createdAt'> & { now: number }): void {
    const content = gzipSync(Buffer.from(blob.text, 'utf8'));
    this.run(
      `INSERT INTO blobs(hash, kind, content, size, lines, source, created_at, expires_at, last_access) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(hash) DO UPDATE SET expires_at = excluded.expires_at, last_access = excluded.last_access`,
      blob.hash, blob.kind, content, blob.size, blob.lines, blob.source, blob.now, blob.expiresAt, blob.now,
    );
  }

  /** Blob by full hash or unique prefix (>= 8 hex chars). Null if missing; expired rows are reported as such. */
  getBlob(hashOrPrefix: string, now: number): BlobRow | 'expired' | 'ambiguous' | null {
    const rows = this.all('SELECT * FROM blobs WHERE hash LIKE ? LIMIT 2', `${hashOrPrefix.toLowerCase()}%`);
    if (rows.length === 0) return null;
    if (rows.length > 1) return 'ambiguous';
    const row = rows[0] as Row;
    if (Number(row.expires_at) <= now) return 'expired';
    this.run('UPDATE blobs SET last_access = ? WHERE hash = ?', now, String(row.hash));
    return {
      hash: String(row.hash),
      kind: String(row.kind),
      text: gunzipSync(row.content as Uint8Array).toString('utf8'),
      size: Number(row.size),
      lines: Number(row.lines),
      source: String(row.source),
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
    };
  }

  /** Drop expired blobs, then least-recently-used ones until the store fits `maxBytes`. */
  evictBlobs(now: number, maxBytes: number): number {
    const before = this.blobCount();
    this.run('DELETE FROM blobs WHERE expires_at <= ?', now);
    let total = Number(this.get('SELECT coalesce(sum(length(content)), 0) AS n FROM blobs')?.n ?? 0);
    while (total > maxBytes) {
      const oldest = this.get('SELECT hash, length(content) AS n FROM blobs ORDER BY last_access ASC LIMIT 1');
      if (!oldest) break;
      this.run('DELETE FROM blobs WHERE hash = ?', String(oldest.hash));
      total -= Number(oldest.n);
    }
    return before - this.blobCount();
  }

  blobCount(): number {
    return Number(this.get('SELECT count(*) AS n FROM blobs')?.n ?? 0);
  }

  // ---- result cache -------------------------------------------------------------

  cacheGet(key: string, generation: number): string | null {
    const row = this.get('SELECT value FROM cache WHERE key = ? AND generation = ?', key, generation);
    if (!row) return null;
    this.run('UPDATE cache SET hits = hits + 1 WHERE key = ?', key);
    return String(row.value);
  }

  /** Entry regardless of generation (cursors survive index changes and are recomputed). */
  cacheGetAny(key: string): { value: string; generation: number } | null {
    const row = this.get('SELECT value, generation FROM cache WHERE key = ?', key);
    return row ? { value: String(row.value), generation: Number(row.generation) } : null;
  }

  cachePut(key: string, value: string, generation: number, now: number): void {
    this.run(
      `INSERT INTO cache(key, value, generation, created_at, hits) VALUES (?, ?, ?, ?, 0)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, generation = excluded.generation, created_at = excluded.created_at, hits = 0`,
      key, value, generation, now,
    );
  }

  /** Remove entries from older generations, keeping cursors (prefix 'cursor:') for one extra generation. */
  cachePrune(generation: number): void {
    this.run("DELETE FROM cache WHERE generation < ? AND key NOT LIKE 'cursor:%'", generation);
    this.run("DELETE FROM cache WHERE generation < ? AND key LIKE 'cursor:%'", generation - 1);
  }

  // ---- metrics (local only) -------------------------------------------------------

  recordMetric(m: MetricInput): void {
    this.run(
      'INSERT INTO metrics(ts, session, tool, est_tokens, duration_ms, complete, cache_hit, is_error, extra) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      Date.now(), m.session, m.tool, m.estTokens, m.durationMs, m.complete ? 1 : 0, m.cacheHit ? 1 : 0, m.isError ? 1 : 0, JSON.stringify(m.extra),
    );
  }

  aggregate(session: string | null): ToolAggregate[] {
    const where = session === null ? '' : 'WHERE session = ?';
    const params: SqlValue[] = session === null ? [] : [session];
    return this.all(
      `SELECT tool, count(*) AS calls, sum(est_tokens) AS tokens, avg(duration_ms) AS ms, sum(cache_hit) AS hits,
              sum(complete = 0) AS incomplete, sum(is_error) AS errors
       FROM metrics ${where} GROUP BY tool ORDER BY tool`,
      ...params,
    ).map((row) => ({
      tool: String(row.tool),
      calls: Number(row.calls),
      estTokens: Number(row.tokens ?? 0),
      avgMs: Math.round(Number(row.ms ?? 0)),
      cacheHits: Number(row.hits ?? 0),
      incomplete: Number(row.incomplete ?? 0),
      errors: Number(row.errors ?? 0),
    }));
  }

  compressionTotals(session: string | null): { calls: number; originalTokens: number; outputTokens: number } {
    const where = session === null ? "WHERE tool = 'maxify_compress'" : "WHERE tool = 'maxify_compress' AND session = ?";
    const params: SqlValue[] = session === null ? [] : [session];
    let originalTokens = 0;
    let outputTokens = 0;
    let calls = 0;
    for (const row of this.all(`SELECT est_tokens, extra FROM metrics ${where}`, ...params)) {
      try {
        const extra = JSON.parse(String(row.extra)) as { estOriginalTokens?: number; mode?: string };
        if (extra.mode !== 'compress') continue;
        calls++;
        originalTokens += Number(extra.estOriginalTokens ?? 0);
        outputTokens += Number(row.est_tokens);
      } catch {
        continue;
      }
    }
    return { calls, originalTokens, outputTokens };
  }
}
