/** Bump when the schema changes; the index is rebuilt (it is derived data). Notes survive only within a version. */
export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  hash TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  language TEXT NOT NULL,
  status TEXT NOT NULL,
  is_test INTEGER NOT NULL DEFAULT 0,
  line_count INTEGER NOT NULL DEFAULT 0,
  adapter TEXT NOT NULL DEFAULT '',
  generation INTEGER NOT NULL,
  error TEXT
);

CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  name TEXT NOT NULL,
  qual_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  exported INTEGER NOT NULL,
  export_names TEXT NOT NULL,
  signature TEXT NOT NULL,
  doc TEXT NOT NULL,
  parent_ordinal INTEGER,
  flags TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS symbols_file ON symbols(file_id, ordinal);
CREATE INDEX IF NOT EXISTS symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS symbols_qual ON symbols(file_id, qual_name);

CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  spec TEXT NOT NULL,
  kind TEXT NOT NULL,
  bindings TEXT NOT NULL,
  line INTEGER NOT NULL,
  resolved_path TEXT,
  resolution TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS imports_file ON imports(file_id, ordinal);
CREATE INDEX IF NOT EXISTS imports_resolved ON imports(resolved_path);

CREATE TABLE IF NOT EXISTS refs (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  from_ordinal INTEGER,
  target_type TEXT NOT NULL,
  target_ordinal INTEGER NOT NULL,
  target_name TEXT,
  kind TEXT NOT NULL,
  line INTEGER NOT NULL,
  count INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS refs_file_from ON refs(file_id, from_ordinal);
CREATE INDEX IF NOT EXISTS refs_file_target ON refs(file_id, target_type, target_ordinal);

CREATE TABLE IF NOT EXISTS unresolved (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  line INTEGER NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS unresolved_file ON unresolved(file_id);

CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
  path, name, terms, signature, doc, body,
  file_id UNINDEXED, symbol_ordinal UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS renames (
  id INTEGER PRIMARY KEY,
  old_path TEXT NOT NULL,
  new_path TEXT NOT NULL,
  generation INTEGER NOT NULL,
  ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  kind TEXT NOT NULL,
  origin TEXT NOT NULL,
  refs TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  text, note_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS blobs (
  hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  content BLOB NOT NULL,
  size INTEGER NOT NULL,
  lines INTEGER NOT NULL,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_access INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  generation INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS metrics (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  session TEXT NOT NULL,
  tool TEXT NOT NULL,
  est_tokens INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  complete INTEGER NOT NULL,
  cache_hit INTEGER NOT NULL,
  is_error INTEGER NOT NULL,
  extra TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS metrics_session ON metrics(session, tool);
`;
