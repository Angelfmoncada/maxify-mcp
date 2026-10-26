import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ParsedFile } from '../../src/core/types.js';
import { buildFtsDocs } from '../../src/indexer/documents.js';
import { AuxStore } from '../../src/store/aux-store.js';
import { hasFts5, openDatabase, transaction } from '../../src/store/db.js';
import { IndexStore } from '../../src/store/index-store.js';

const dir = mkdtempSync(path.join(tmpdir(), 'maxify-store-'));
const db = openDatabase(path.join(dir, 'index.db'));
const store = new IndexStore(db);
const aux = new AuxStore(db);
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const text = 'export class Session {\n  refresh(): void {\n    renewToken();\n  }\n}\n';
const parsed: ParsedFile = {
  language: 'typescript',
  isTest: false,
  symbols: [
    { name: 'Session', qualName: 'Session', kind: 'class', span: { startLine: 1, endLine: 5 }, exported: true, exportNames: ['Session'], signature: 'export class Session\n  refresh(): void', doc: '', parent: null, flags: [] },
    { name: 'refresh', qualName: 'Session.refresh', kind: 'method', span: { startLine: 2, endLine: 4 }, exported: false, exportNames: [], signature: 'refresh(): void', doc: 'Renews the session token.', parent: 0, flags: [] },
  ],
  imports: [{ spec: './token.js', kind: 'import', bindings: [{ imported: 'renewToken', local: 'renewToken', typeOnly: false }], line: 1 }],
  refs: [{ from: 1, target: { type: 'import', importIndex: 0, name: 'renewToken' }, kind: 'calls', line: 3, count: 1 }],
  unresolved: [{ line: 3, kind: 'computed-call', detail: 'obj[key]()' }],
};

function upsert(p: string, hash: string): number {
  return store.upsertFile({ path: p, hash, size: text.length, mtimeMs: 1, language: 'typescript', status: 'indexed', isTest: false, lineCount: 5, adapter: 'typescript@1', generation: 1, error: null });
}

describe('IndexStore', () => {
  it('has FTS5 and a migrated schema', () => {
    expect(hasFts5(db)).toBe(true);
  });

  it('stores parsed rows and finds them through FTS with camelCase terms', () => {
    const id = transaction(db, () => {
      const fileId = upsert('src/session.ts', 'h1');
      const { docs, fileDoc } = buildFtsDocs('src/session.ts', text, parsed);
      store.replaceParsed(fileId, parsed, docs, fileDoc);
      return fileId;
    });
    expect(store.symbolsOfFile(id).map((s) => s.qualName)).toEqual(['Session', 'Session.refresh']);
    const hits = store.ftsSearch('"renew"* OR "refresh"', 10);
    expect(hits.some((h) => h.name === 'refresh')).toBe(true);
    const classDoc = hits.find((h) => h.name === 'Session');
    if (classDoc) expect(classDoc.body).not.toContain('renewToken');
    expect(store.unresolvedOfFile(id)[0]?.kind).toBe('computed-call');
    expect(store.refsFrom(id, 1)[0]?.targetName).toBe('renewToken');
  });

  it('tracks import resolution and reverse lookups', () => {
    const id = upsert('src/token.ts', 'h2');
    expect(id).toBeGreaterThan(0);
    const pending = store.importsToResolve(true);
    expect(pending).toHaveLength(1);
    store.setResolution(pending[0]?.id as number, 'resolved', 'src/token.ts');
    expect(store.importersOf('src/token.ts').map((i) => i.path)).toEqual(['src/session.ts']);
    expect(store.countImportsByResolution()).toEqual({ resolved: 1 });
  });

  it('deletes all derived rows with the file', () => {
    const file = store.fileByPath('src/session.ts');
    store.deleteFile(file?.id as number);
    expect(store.symbolsByName('refresh')).toHaveLength(0);
    expect(store.ftsSearch('"refresh"', 10)).toHaveLength(0);
  });

  it('bumps generations monotonically', () => {
    const before = store.generation();
    expect(store.bumpGeneration()).toBe(before + 1);
  });
});

describe('AuxStore', () => {
  it('stores blobs gzip-compressed and returns the exact original until expiry', () => {
    const original = 'line 1\nline 2 ünïcode\r\nline 3\n';
    aux.putBlob({ hash: 'abcdef0123456789', kind: 'log', text: original, size: original.length, lines: 3, source: 'text', expiresAt: 2000, now: 1000 });
    const blob = aux.getBlob('abcdef01', 1500);
    expect(blob !== null && typeof blob === 'object' ? blob.text : null).toBe(original);
    expect(aux.getBlob('abcdef01', 2500)).toBe('expired');
    expect(aux.getBlob('ffffffff', 1500)).toBeNull();
    expect(aux.evictBlobs(2500, 1_000_000)).toBe(1);
  });

  it('keeps notes searchable and deletable', () => {
    aux.putNote({ id: 'n1234567', text: 'token expiry uses seconds', kind: 'fact', origin: 'agent', refs: [], createdAt: 1, updatedAt: 1 });
    expect(aux.searchNotes('"expiry"', 5).map((n) => n.id)).toEqual(['n1234567']);
    expect(aux.deleteNote('n1234567')).toBe(true);
    expect(aux.countNotes()).toBe(0);
  });

  it('caches per generation and prunes old entries', () => {
    aux.cachePut('k', 'v', 3, 1);
    expect(aux.cacheGet('k', 3)).toBe('v');
    expect(aux.cacheGet('k', 4)).toBeNull();
    aux.cachePrune(5);
    expect(aux.cacheGetAny('k')).toBeNull();
  });

  it('aggregates local metrics per tool', () => {
    aux.recordMetric({ session: 's', tool: 'maxify_compress', estTokens: 100, durationMs: 5, complete: true, cacheHit: false, isError: false, extra: { mode: 'compress', estOriginalTokens: 900 } });
    expect(aux.aggregate('s')[0]?.calls).toBe(1);
    expect(aux.compressionTotals('s')).toEqual({ calls: 1, originalTokens: 900, outputTokens: 100 });
  });
});
