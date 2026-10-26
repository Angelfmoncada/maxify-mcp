import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { adapterFor, ADAPTER_VERSION } from '../adapters/index.js';
import { loadConfig, type MaxifyConfig } from '../config/config.js';
import { isMaxifyError, MaxifyError } from '../core/errors.js';
import { sha256, stableStringify } from '../core/hash.js';
import { log } from '../core/log.js';
import { assertSafeRoot, RepoGuard } from '../core/paths.js';
import { resolveStateDir } from '../core/state.js';
import { estimateTokens, TOOL_RESULT_OVERHEAD_TOKENS } from '../core/tokens.js';
import { Exclusions } from '../indexer/exclusions.js';
import { runIndex, type IndexerContext } from '../indexer/indexer.js';
import { memoryOp, migrateNoteRefs, notesFor, type MemoryDeps } from '../memory/notes.js';
import { compileContext, type ContextDeps } from '../retrieval/context.js';
import { computeImpact } from '../retrieval/impact.js';
import { parseRef } from '../retrieval/refs.js';
import { readSource } from '../retrieval/source.js';
import { AuxStore } from '../store/aux-store.js';
import { hasFts5, openDatabase, type Db } from '../store/db.js';
import { IndexStore } from '../store/index-store.js';
import { MAXIFY_VERSION } from '../version.js';
import { compressOp } from './compress-ops.js';
import { resolveFocusRef } from './focus.js';
import { renderStats } from './stats.js';
import type {
  CompressRequest,
  ContextRequest,
  DetailLevel,
  EngineOptions,
  EvidenceItem,
  ImpactRequest,
  IndexOptions,
  IndexSummary,
  MaxifyEngine,
  MemoryRequest,
  SourceRequest,
  StatsRequest,
  ToolOutput,
} from './types.js';
import { budgetOf, clampInt, MAX_TASK_CHARS, oneOf, optionalBool, optionalStrings, refString, requireString } from './validate.js';

const REFRESH_DEBOUNCE_MS = 1000;
const DETAILS = ['auto', 'map', 'signature', 'source'] as const;
const KINDS = ['auto', 'log', 'test', 'search', 'json', 'list', 'diff', 'text'] as const;
const OPS = ['add', 'search', 'list', 'get', 'update', 'delete'] as const;

interface Outcome {
  text: string;
  complete: boolean;
  cacheHit?: boolean;
  items?: EvidenceItem[];
  omitted?: string[];
  cursor?: string;
  extra?: Record<string, unknown>;
}

interface CursorState {
  task: string;
  budget: number;
  detail: 'auto' | DetailLevel;
  includeTests: boolean;
  focus: string[];
  page: number;
  delivered: string[];
  generation: number;
}

function sameRoot(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

class Engine implements MaxifyEngine {
  readonly root: string;
  readonly stateDir: string;
  private readonly session = randomUUID().slice(0, 8);
  private readonly ctx: IndexerContext;
  private readonly aux: AuxStore;
  private readonly sent = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();
  private lastRefresh = Number.NEGATIVE_INFINITY;
  private closed = false;

  constructor(
    private readonly db: Db,
    private readonly guard: RepoGuard,
    private readonly config: MaxifyConfig,
    configHash: string,
    stateDir: string,
  ) {
    this.root = guard.root;
    this.stateDir = stateDir;
    this.aux = new AuxStore(db);
    const store = new IndexStore(db);
    this.ctx = {
      db,
      store,
      guard,
      exclusions: new Exclusions(guard.root, config),
      config,
      configHash,
      adapters: { adapterFor, version: ADAPTER_VERSION },
      onRename: (oldPath, newPath) => {
        migrateNoteRefs(this.aux, oldPath, newPath, Date.now());
      },
    };
  }

  private get store(): IndexStore {
    return this.ctx.store;
  }

  /** One state dir belongs to one root: a mismatch (copied state, moved repo) wipes derived data. */
  isolate(): void {
    const stored = this.store.getMeta('root');
    if (stored !== null && !sameRoot(stored, this.root)) {
      log.warn(`state dir was created for ${stored}; resetting it for ${this.root}`);
      for (const table of ['files', 'fts', 'notes', 'notes_fts', 'blobs', 'cache', 'renames', 'metrics']) this.db.exec(`DELETE FROM ${table}`);
      this.store.setMeta('generation', '0');
    }
    this.store.setMeta('root', this.root);
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async track(tool: string, fn: () => Promise<Outcome>): Promise<ToolOutput> {
    if (this.closed) throw new MaxifyError('INTERNAL', 'engine is closed');
    const started = performance.now();
    try {
      const r = await fn();
      const durationMs = Math.round(performance.now() - started);
      const estTokens = estimateTokens(r.text) + TOOL_RESULT_OVERHEAD_TOKENS;
      const extra = r.extra ?? {};
      this.aux.recordMetric({ session: this.session, tool, estTokens, durationMs, complete: r.complete, cacheHit: r.cacheHit === true, isError: false, extra });
      return {
        text: r.text,
        meta: { ...extra, estTokens, complete: r.complete, durationMs, cacheHit: r.cacheHit === true, items: r.items, omitted: r.omitted, cursor: r.cursor },
      };
    } catch (error: unknown) {
      const durationMs = Math.round(performance.now() - started);
      const code = isMaxifyError(error) ? error.code : 'INTERNAL';
      this.aux.recordMetric({ session: this.session, tool, estTokens: 0, durationMs, complete: false, cacheHit: false, isError: true, extra: { code } });
      throw error;
    }
  }

  private async refresh(force: boolean): Promise<void> {
    if (!force && performance.now() - this.lastRefresh < REFRESH_DEBOUNCE_MS) return;
    const before = this.store.generation();
    await runIndex(this.ctx, {});
    this.lastRefresh = performance.now();
    if (this.store.generation() !== before) this.aux.cachePrune(this.store.generation());
  }

  index(opts: IndexOptions = {}): Promise<IndexSummary> {
    return this.exclusive(async () => {
      const summary = await runIndex(this.ctx, opts);
      this.lastRefresh = performance.now();
      this.aux.cachePrune(summary.generation);
      this.aux.evictBlobs(Date.now(), this.config.compress.maxStoreMB * 1024 * 1024);
      return summary;
    });
  }

  private memoryDeps(): MemoryDeps {
    return { aux: this.aux, store: this.store, guard: this.guard, now: () => Date.now() };
  }

  private contextDeps(): ContextDeps {
    return {
      store: this.store,
      guard: this.guard,
      resolveFocus: (graph, ref, misses) => resolveFocusRef(this.store, this.guard, graph, ref, misses),
      notesFor: (paths, task, limit) => notesFor(this.memoryDeps(), paths, task, limit),
    };
  }

  private sentRefs(): Set<string> {
    const out = new Set<string>();
    for (const [ref, hash] of this.sent) {
      const file = this.store.fileByPath(ref.split('#')[0] ?? '');
      if (file?.hash.startsWith(hash)) out.add(ref);
    }
    return out;
  }

  private loadCursor(id: string): CursorState {
    if (!/^c[0-9a-f]{12}$/.test(id)) throw new MaxifyError('INVALID_INPUT', 'cursor must look like c + 12 hex chars');
    const entry = this.aux.cacheGetAny(`cursor:${id}`);
    if (!entry) throw new MaxifyError('NOT_FOUND', 'cursor unknown or expired; call maxify_context again with the task.');
    return JSON.parse(entry.value) as CursorState;
  }

  context(req: ContextRequest): Promise<ToolOutput> {
    return this.exclusive(() =>
      this.track('maxify_context', async () => {
        const initial: CursorState = {
          task: requireString(req.task, 'task', MAX_TASK_CHARS),
          budget: budgetOf(req.budget, this.config.context.defaultBudget),
          detail: oneOf(req.detail, 'detail', DETAILS, 'auto'),
          includeTests: optionalBool(req.includeTests, 'includeTests', this.config.context.includeTests),
          focus: optionalStrings(req.focus, 'focus', 20) ?? [],
          page: 1,
          delivered: [],
          generation: 0,
        };
        const delta = optionalBool(req.delta, 'delta', this.config.context.delta);
        await this.refresh(false);
        let state = initial;
        let note = '';
        if (req.cursor !== undefined) {
          const loaded = this.loadCursor(refString(req.cursor, 'cursor'));
          if (loaded.generation !== this.store.generation()) note = 'note: the index changed since the previous page; ranking was recomputed.';
          state = { ...loaded, page: loaded.page + 1 };
        }
        return this.compileWithRetry(state, delta, note);
      }),
    );
  }

  private async compileWithRetry(state: CursorState, delta: boolean, note: string): Promise<Outcome> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const generation = this.store.generation();
      const keyParts = { v: MAXIFY_VERSION, ...state, generation, delta: delta ? [...this.sent.entries()].sort() : false };
      const key = `ctx:${sha256(stableStringify({ ...keyParts, config: this.ctx.configHash }))}`;
      if (!delta) {
        const hit = this.aux.cacheGet(key, generation);
        if (hit) return { ...(JSON.parse(hit) as Outcome), cacheHit: true };
      }
      const nextCursor = `c${sha256(`${key}|next`).slice(0, 12)}`;
      const result = compileContext(
        this.contextDeps(),
        { task: state.task, budget: state.budget, focus: state.focus, detail: state.detail, includeTests: state.includeTests },
        {
          budget: state.budget,
          detail: state.detail,
          includeTests: state.includeTests,
          exclude: new Set(state.delivered),
          sentBefore: delta ? this.sentRefs() : undefined,
          cursor: nextCursor,
          generation,
          page: state.page,
        },
      );
      if (result.stale.length > 0) {
        await this.refresh(true);
        continue;
      }
      const now = Date.now();
      if (result.hasMore) {
        const next: CursorState = { ...state, delivered: [...state.delivered, ...result.delivered], generation };
        this.aux.cachePut(`cursor:${nextCursor}`, JSON.stringify(next), generation, now);
      }
      if (delta) for (const item of result.items) if (item.level === 'source') this.sent.set(item.ref, item.hash);
      const outcome: Outcome = {
        text: note ? `${result.text}\n${note}` : result.text,
        complete: result.complete,
        items: result.items,
        omitted: result.omitted,
        cursor: result.hasMore ? nextCursor : undefined,
        extra: { page: state.page },
      };
      if (!delta) this.aux.cachePut(key, JSON.stringify(outcome), generation, now);
      return outcome;
    }
    throw new MaxifyError('STALE', 'Files kept changing while compiling context; retry in a moment.');
  }

  source(req: SourceRequest): Promise<ToolOutput> {
    return this.exclusive(() =>
      this.track('maxify_source', async () => {
        const ref = parseRef(refString(req.ref));
        const normalized: SourceRequest = {
          ref: req.ref,
          contextLines: clampInt(req.contextLines, 'contextLines', 0, 50, 0),
          maxTokens: req.maxTokens === undefined ? undefined : budgetOf(req.maxTokens, 6000),
        };
        if (ref.type === 'blob') {
          const r = compressOp(this.compressDeps(), { ref: `blob:${ref.hash}`, maxTokens: normalized.maxTokens });
          return { text: r.text, complete: r.complete, extra: r.extra };
        }
        await this.refresh(false);
        const deps = () => ({ store: this.store, guard: this.guard, exclusions: this.ctx.exclusions, generation: this.store.generation() });
        let result = readSource(deps(), ref, normalized);
        const file = result.item ? this.store.fileByPath(result.item.path) : null;
        if (result.item && file?.status === 'indexed' && !file.hash.startsWith(result.item.hash)) {
          await this.refresh(true);
          result = readSource(deps(), ref, normalized);
        }
        return { text: result.text, complete: result.complete, items: result.item ? [result.item] : [] };
      }),
    );
  }

  impact(req: ImpactRequest): Promise<ToolOutput> {
    return this.exclusive(() =>
      this.track('maxify_impact', async () => {
        const targets = optionalStrings(req.targets, 'targets', 20);
        if (!targets || targets.length === 0) throw new MaxifyError('INVALID_INPUT', 'targets must contain at least one path or path#Symbol');
        const budget = budgetOf(req.budget, this.config.context.defaultBudget);
        await this.refresh(false);
        const result = computeImpact(
          { store: this.store, guard: this.guard, generation: this.store.generation() },
          { targets, depth: clampInt(req.depth, 'depth', 1, 5, 2), budget },
          budget,
        );
        return { text: result.text, complete: result.complete };
      }),
    );
  }

  private compressDeps() {
    return { aux: this.aux, guard: this.guard, exclusions: this.ctx.exclusions, config: this.config, now: () => Date.now() };
  }

  compress(req: CompressRequest): Promise<ToolOutput> {
    return this.exclusive(() =>
      this.track('maxify_compress', async () => {
        const normalized: CompressRequest = {
          text: req.text,
          path: req.path === undefined ? undefined : refString(req.path, 'path'),
          ref: req.ref === undefined ? undefined : refString(req.ref, 'ref'),
          lines: req.lines === undefined ? undefined : requireString(req.lines, 'lines', 40),
          kind: oneOf(req.kind, 'kind', KINDS, 'auto'),
          maxTokens: req.maxTokens === undefined ? undefined : budgetOf(req.maxTokens, this.config.compress.defaultMaxTokens),
          focus: optionalStrings(req.focus, 'focus', 20, 200),
        };
        if (normalized.text !== undefined && typeof normalized.text !== 'string') throw new MaxifyError('INVALID_INPUT', 'text must be a string');
        const r = compressOp(this.compressDeps(), normalized);
        return { text: r.text, complete: r.complete, extra: r.extra };
      }),
    );
  }

  memory(req: MemoryRequest): Promise<ToolOutput> {
    return this.exclusive(() =>
      this.track('maxify_memory', async () => {
        const op = oneOf(req.op, 'op', OPS, 'list');
        if (op === 'add' || op === 'update') await this.refresh(false);
        const text = memoryOp(this.memoryDeps(), {
          ...req,
          op,
          refs: optionalStrings(req.refs, 'refs', 10),
          kind: req.kind === undefined ? undefined : oneOf(req.kind, 'kind', ['fact', 'note', 'decision'] as const, 'note'),
          origin: req.origin === undefined ? undefined : oneOf(req.origin, 'origin', ['agent', 'user'] as const, 'agent'),
        });
        return { text, complete: true, extra: { op } };
      }),
    );
  }

  stats(req: StatsRequest = {}): Promise<ToolOutput> {
    return this.exclusive(() =>
      this.track('maxify_stats', async () => {
        const scope = oneOf(req.scope, 'scope', ['index', 'session', 'all'] as const, 'all');
        const text = renderStats(
          { store: this.store, aux: this.aux, guard: this.guard, exclusions: this.ctx.exclusions, stateDir: this.stateDir, session: this.session },
          scope,
        );
        return { text, complete: true, extra: { scope } };
      }),
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } catch (error: unknown) {
      log.warn(`closing index database failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * Open the engine for a repository root: validates the root, loads config,
 * opens (or creates) the per-root state dir and index, and by default runs an
 * incremental index.
 */
export async function openEngine(opts: EngineOptions): Promise<MaxifyEngine> {
  const requested = path.resolve(opts.root);
  assertSafeRoot(requested);
  const guard = new RepoGuard(requested);
  assertSafeRoot(guard.root);
  const loaded = loadConfig(guard.root, opts.configPath);
  const stateDir = resolveStateDir(guard.root, opts.stateDir);
  mkdirSync(stateDir, { recursive: true });
  const db = openDatabase(path.join(stateDir, 'index.db'));
  if (!hasFts5(db)) {
    db.close();
    throw new MaxifyError('INTERNAL', 'This Node.js SQLite build lacks FTS5; Maxify needs Node >= 22.13 with its bundled SQLite.');
  }
  const engine = new Engine(db, guard, loaded.config, loaded.hash, stateDir);
  engine.isolate();
  if (opts.autoIndex !== false) await engine.index();
  return engine;
}
