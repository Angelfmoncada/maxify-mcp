import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { MaxifyConfig } from '../config/config.js';
import { sha256 } from '../core/hash.js';
import type { RepoGuard } from '../core/paths.js';
import type { LanguageAdapter } from '../core/types.js';
import type { IndexOptions, IndexSummary } from '../engine/types.js';
import { transaction, type Db } from '../store/db.js';
import type { FileUpsert, IndexStore } from '../store/index-store.js';
import type { FileRow, FileStatus } from '../store/rows.js';
import { buildFtsDocs, fileOnlyDoc } from './documents.js';
import { containsPrivateKey, type Exclusions } from './exclusions.js';
import { isConfigFile, ModuleResolver } from './resolve.js';
import { walkRepository, type WalkedFile, type WalkResult } from './walk.js';

export interface AdapterRegistry {
  adapterFor(relPath: string): LanguageAdapter | null;
  /** Bumped when adapter output changes; forces a re-parse of affected files. */
  version: string;
}

export interface IndexerContext {
  db: Db;
  store: IndexStore;
  guard: RepoGuard;
  exclusions: Exclusions;
  config: MaxifyConfig;
  configHash: string;
  adapters: AdapterRegistry;
  /** Called for each detected rename (same content hash, new path) so dependents (notes) can follow. */
  onRename?: (oldPath: string, newPath: string) => void;
}

type Outcome = 'added' | 'updated' | 'unchanged';

const BATCH_SIZE = 100;
const BINARY_SNIFF_BYTES = 8192;

function adapterTag(adapter: LanguageAdapter | null, version: string): string {
  return adapter ? `${adapter.id}@${version}` : '';
}

function isBinary(buffer: Buffer): boolean {
  const end = Math.min(buffer.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < end; i++) if (buffer[i] === 0) return true;
  return false;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
  return text.endsWith('\n') ? lines - 1 : lines;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

class IndexRun {
  readonly summary: IndexSummary;
  readonly addedByHash = new Map<string, string>();
  changed = false;
  fileSetChanged = false;
  resolveAll = false;

  constructor(
    private readonly ctx: IndexerContext,
    private readonly generation: number,
    scanned: number,
    skipped: number,
  ) {
    this.summary = {
      generation,
      filesScanned: scanned,
      added: 0,
      updated: 0,
      removed: 0,
      renamed: 0,
      unchanged: 0,
      skipped,
      durationMs: 0,
      errors: [],
    };
  }

  private base(walked: WalkedFile, adapter: LanguageAdapter | null): Omit<FileUpsert, 'hash' | 'status' | 'language' | 'isTest' | 'lineCount'> {
    return {
      path: walked.path,
      size: walked.size,
      mtimeMs: walked.mtimeMs,
      adapter: adapterTag(adapter, this.ctx.adapters.version),
      generation: this.generation,
      error: null,
    };
  }

  private listOnly(walked: WalkedFile, adapter: LanguageAdapter | null, status: FileStatus, hash: string, error: string | null = null): number {
    const id = this.ctx.store.upsertFile({
      ...this.base(walked, adapter),
      hash,
      status,
      language: '',
      isTest: false,
      lineCount: 0,
      error,
    });
    if (status === 'secret') this.ctx.store.clearParsed(id);
    else this.ctx.store.replaceFileOnly(id, fileOnlyDoc(walked.path));
    return id;
  }

  indexOne(walked: WalkedFile, row: FileRow | null): Outcome {
    const { store, config, guard, adapters } = this.ctx;
    const adapter = walked.noise ? null : adapters.adapterFor(walked.path);
    const tag = adapterTag(adapter, adapters.version);
    const fresh: Outcome = row ? 'updated' : 'added';
    if (walked.size > config.maxFileBytes) {
      const pseudo = `size:${walked.size}:${walked.mtimeMs}`;
      if (row && row.hash === pseudo && row.adapter === tag) return 'unchanged';
      this.listOnly(walked, adapter, 'too_large', pseudo);
      return fresh;
    }
    let buffer: Buffer;
    try {
      buffer = readFileSync(guard.abs(walked.path));
    } catch (error: unknown) {
      this.listOnly(walked, adapter, 'error', '', errorMessage(error));
      this.summary.errors.push(`${walked.path}: ${errorMessage(error)}`);
      return fresh;
    }
    const hash = sha256(buffer);
    if (row && row.hash === hash && row.adapter === tag) {
      store.touchFile(row.id, walked.size, walked.mtimeMs);
      return 'unchanged';
    }
    if (!row) this.addedByHash.set(hash, walked.path);
    if (isBinary(buffer)) {
      this.listOnly(walked, adapter, 'binary', hash);
      return fresh;
    }
    const text = buffer.toString('utf8');
    if (containsPrivateKey(text)) {
      this.listOnly(walked, adapter, 'secret', '');
      return fresh;
    }
    if (walked.noise || adapter === null) {
      this.listOnly(walked, adapter, walked.noise ? 'noise' : 'unsupported', hash);
      return fresh;
    }
    let parsed;
    try {
      parsed = adapter.parse(walked.path, text);
    } catch (error: unknown) {
      this.listOnly(walked, adapter, 'error', hash, errorMessage(error));
      this.summary.errors.push(`${walked.path}: adapter ${adapter.id} failed: ${errorMessage(error)}`);
      return fresh;
    }
    const id = store.upsertFile({
      ...this.base(walked, adapter),
      hash,
      status: 'indexed',
      language: parsed.language,
      isTest: parsed.isTest,
      lineCount: countLines(text),
    });
    const { docs, fileDoc } = buildFtsDocs(walked.path, text, parsed);
    store.replaceParsed(id, parsed, docs, fileDoc);
    return fresh;
  }

  record(walked: WalkedFile, outcome: Outcome): void {
    if (outcome === 'unchanged') {
      this.summary.unchanged++;
      return;
    }
    this.changed = true;
    if (outcome === 'added') {
      this.summary.added++;
      this.fileSetChanged = true;
    } else {
      this.summary.updated++;
    }
    const base = path.posix.basename(walked.path);
    if (isConfigFile(walked.path) || base === 'package.json') this.resolveAll = true;
  }
}

function needsWork(walked: WalkedFile, row: FileRow | undefined, full: boolean, ctx: IndexerContext): boolean {
  if (full || !row) return true;
  if (row.size !== walked.size || row.mtimeMs !== walked.mtimeMs) return true;
  const adapter = walked.noise ? null : ctx.adapters.adapterFor(walked.path);
  return row.adapter !== adapterTag(adapter, ctx.adapters.version);
}

function removeMissing(ctx: IndexerContext, run: IndexRun, removed: FileRow[]): void {
  if (removed.length === 0) return;
  run.changed = true;
  run.fileSetChanged = true;
  transaction(ctx.db, () => {
    for (const row of removed) {
      const newPath = row.hash ? run.addedByHash.get(row.hash) : undefined;
      if (newPath) {
        run.summary.renamed++;
        run.summary.added--;
        ctx.store.recordRename(row.path, newPath, run.summary.generation);
        ctx.onRename?.(row.path, newPath);
      } else {
        run.summary.removed++;
      }
      ctx.store.deleteFile(row.id);
    }
  });
}

function isRelativeSpec(spec: string): boolean {
  return spec.startsWith('./') || spec.startsWith('../');
}

/** Resolve pending imports (or all non-external imports when the file set or a config changed). */
export function resolveImports(ctx: IndexerContext, walk: WalkResult, all: boolean): boolean {
  const resolver = new ModuleResolver(ctx.guard, walk.files.map((f) => f.path).filter(isConfigFile));
  const known = new Set(ctx.store.allFiles().filter((f) => f.status !== 'secret').map((f) => f.path));
  const isIndexed = (rel: string): boolean => known.has(rel);
  let changed = false;
  transaction(ctx.db, () => {
    for (const imp of ctx.store.importsToResolve(!all)) {
      let result = resolver.resolve(imp.spec, imp.path, imp.kind, imp.language, isIndexed);
      if (result.resolution === 'unresolved' && isRelativeSpec(imp.spec) && imp.language !== 'markdown') {
        const direct = path.posix.normalize(path.posix.join(path.posix.dirname(imp.path), imp.spec));
        if (known.has(direct)) result = { resolution: 'resolved', resolvedPath: direct };
      }
      if (result.resolution !== imp.resolution || result.resolvedPath !== imp.resolvedPath) {
        ctx.store.setResolution(imp.id, result.resolution, result.resolvedPath);
        changed = true;
      }
    }
  });
  return changed;
}

/**
 * Incremental index: stat-compare every walked file, re-hash only files whose
 * size/mtime changed, re-parse only files whose content hash changed, detect
 * renames by content hash, and re-resolve imports affected by the change.
 */
export async function runIndex(ctx: IndexerContext, opts: IndexOptions = {}): Promise<IndexSummary> {
  const started = performance.now();
  const { store } = ctx;
  const full =
    opts.full === true || store.getMeta('config_hash') !== ctx.configHash || store.getMeta('adapter_version') !== ctx.adapters.version;
  ctx.exclusions.reload();
  const walk = walkRepository(ctx.guard, ctx.exclusions);
  const existing = new Map(store.allFiles().map((f) => [f.path, f] as const));
  const walkedPaths = new Set(walk.files.map((f) => f.path));
  const skipped = walk.skipped.ignored + walk.skipped.secret + walk.skipped.symlinkOutside + walk.skipped.unreadable;
  const run = new IndexRun(ctx, store.generation() + 1, walk.files.length, skipped);
  const pending = walk.files.filter((w) => needsWork(w, existing.get(w.path), full, ctx));
  run.summary.unchanged = walk.files.length - pending.length;
  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const batch = pending.slice(i, i + BATCH_SIZE);
    transaction(ctx.db, () => {
      for (const walked of batch) run.record(walked, run.indexOne(walked, existing.get(walked.path) ?? null));
    });
    if (i + BATCH_SIZE < pending.length) await yieldToEventLoop();
  }
  removeMissing(ctx, run, [...existing.values()].filter((row) => !walkedPaths.has(row.path)));
  if (run.changed || full) {
    if (resolveImports(ctx, walk, full || run.fileSetChanged || run.resolveAll)) run.changed = true;
  }
  const generation = run.changed ? store.bumpGeneration() : store.generation();
  run.summary.generation = generation;
  run.summary.durationMs = Math.round(performance.now() - started);
  store.setMeta('config_hash', ctx.configHash);
  store.setMeta('adapter_version', ctx.adapters.version);
  store.setMeta('last_index_at', String(Date.now()));
  store.setMeta('last_index_ms', String(run.summary.durationMs));
  store.setMeta('last_walk_skipped', JSON.stringify(walk.skipped));
  return run.summary;
}
