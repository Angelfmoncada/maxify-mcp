/**
 * A scripted stand-in for the Maxify engine, used to test the offline runner end to end.
 * It reads the repository copy from disk at every call, so edit tasks see their edit.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { estimateTokens } from '../../../src/core/tokens.js';
import type {
  CompressRequest,
  ContextRequest,
  EngineOptions,
  EvidenceItem,
  ImpactRequest,
  IndexSummary,
  MaxifyEngine,
  MemoryRequest,
  SourceRequest,
  StatsRequest,
  ToolOutput,
} from '../../../src/engine/types.js';
import { readFixtureFiles } from '../../../src/bench/fixture.js';
import type { OfflineTaskSpec } from '../../../src/bench/offline-types.js';
import { resolveRequirement } from '../../../src/bench/scoring.js';

export interface FakeEngineBehavior {
  /** Requirement refs that context() leaves out (source() still serves them). */
  dropRefs?: ReadonlySet<string>;
  /** When true every requirement is dropped and source() fails. */
  blind?: boolean;
  /** Extra paths added as map-level evidence (decoys). */
  decoyPaths?: readonly string[];
  /** Pads the returned text with this many words. */
  padWords?: number;
  /** Text appended to every context() answer. */
  extraText?: string;
  failContext?: boolean;
}

export interface FakeEngineLog {
  options: EngineOptions[];
  indexCalls: number;
  contextCalls: Array<{ task: string; budget: number; seenFiles: ReadonlyMap<string, string> }>;
  sourceCalls: string[];
  closed: boolean;
}

function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

/** Current disk content of just the files a task refers to (reading the whole repository per call is slow). */
function readTaskFiles(root: string, spec: OfflineTaskSpec): Map<string, string> {
  const wanted = new Set([...spec.required.map((requirement) => requirement.ref.split(/[#:]/)[0] ?? ''), ...(spec.edit === undefined ? [] : [spec.edit.file])]);
  const files = new Map<string, string>();
  for (const relative of wanted) {
    const file = path.join(root, ...relative.split('/'));
    if (relative !== '' && existsSync(file)) files.set(relative, readFileSync(file, 'utf8'));
  }
  return files;
}

class FakeEngine implements MaxifyEngine {
  readonly root: string;
  readonly stateDir: string;
  private readonly specs: readonly OfflineTaskSpec[];
  private readonly behavior: FakeEngineBehavior;
  private readonly log: FakeEngineLog;
  private known = new Map<string, string>();

  constructor(options: EngineOptions, specs: readonly OfflineTaskSpec[], behavior: FakeEngineBehavior, log: FakeEngineLog) {
    this.root = options.root;
    this.stateDir = options.stateDir ?? '';
    this.specs = specs;
    this.behavior = behavior;
    this.log = log;
  }

  async index(): Promise<IndexSummary> {
    this.log.indexCalls += 1;
    const files = readFixtureFiles(this.root);
    const next = new Map([...files].map(([path, text]): [string, string] => [path, hashOf(text)]));
    let added = 0;
    let updated = 0;
    let unchanged = 0;
    for (const [path, hash] of next) {
      const before = this.known.get(path);
      if (before === undefined) added += 1;
      else if (before !== hash) updated += 1;
      else unchanged += 1;
    }
    const removed = [...this.known.keys()].filter((path) => !next.has(path)).length;
    this.known = next;
    return { generation: this.log.indexCalls, filesScanned: next.size, added, updated, removed, renamed: 0, unchanged, skipped: 0, durationMs: 1, errors: [] };
  }

  private itemsFor(spec: OfflineTaskSpec, only?: string, dropped: ReadonlySet<string> = new Set()): EvidenceItem[] {
    const files = readTaskFiles(this.root, spec);
    const items: EvidenceItem[] = [];
    for (const requirement of spec.required) {
      if (only !== undefined && requirement.ref !== only) continue;
      if (dropped.has(requirement.ref)) continue;
      const resolved = resolveRequirement(requirement, files);
      if (resolved.span === null) continue;
      items.push({
        ref: requirement.ref,
        path: resolved.parsed.path,
        startLine: resolved.span.startLine,
        endLine: resolved.span.endLine,
        ...(resolved.parsed.kind === 'symbol' ? { symbol: resolved.parsed.symbol } : {}),
        level: only !== undefined ? 'source' : requirement.level,
        hash: 'fakehash0000',
      });
    }
    return items;
  }

  async context(req: ContextRequest): Promise<ToolOutput> {
    const budget = req.budget ?? 4000;
    const focus = req.focus?.[0];
    const spec =
      focus === undefined
        ? this.specs.find((candidate) => candidate.prompt === req.task)
        : this.specs.find((candidate) => candidate.required.some((requirement) => requirement.ref === focus));
    this.log.contextCalls.push({ task: req.task, budget, seenFiles: spec === undefined ? new Map() : readTaskFiles(this.root, spec) });
    if (this.behavior.failContext === true) throw new Error('context exploded');
    if (spec === undefined) return { text: 'unknown task', isError: true, meta: { estTokens: 3, complete: false, durationMs: 1 } };
    if (focus !== undefined) {
      // Focused follow-up: answer for that one requirement, at map level, unless the scripted engine is blind.
      if (this.behavior.blind === true) return { text: 'cannot resolve', isError: true, meta: { estTokens: 3, complete: false, durationMs: 1 } };
      const focused = this.itemsFor(spec, focus).map((item) => ({ ...item, level: 'map' as const }));
      const focusText = focused.map((item) => `${item.path}:${item.startLine}-${item.endLine} [map]`).join('\n');
      return { text: focusText, meta: { estTokens: estimateTokens(focusText), complete: true, durationMs: 1, items: focused, omitted: [] } };
    }
    const dropped = this.behavior.blind === true ? new Set(spec.required.map((requirement) => requirement.ref)) : (this.behavior.dropRefs ?? new Set<string>());
    const items = this.itemsFor(spec, undefined, dropped);
    for (const path of this.behavior.decoyPaths ?? []) {
      items.push({ ref: path, path, startLine: 1, endLine: 1, level: 'map', hash: 'fakehash0000' });
    }
    const text = [
      ...items.map((item) => `${item.path}:${item.startLine}-${item.endLine} [${item.level}] ${item.symbol ?? ''}`),
      this.behavior.extraText ?? '',
      'pad '.repeat(this.behavior.padWords ?? 0),
    ].join('\n');
    return { text, meta: { estTokens: estimateTokens(text), complete: true, durationMs: 1, items, omitted: [] } };
  }

  async source(req: SourceRequest): Promise<ToolOutput> {
    this.log.sourceCalls.push(req.ref);
    if (this.behavior.blind === true) return { text: 'cannot resolve', isError: true, meta: { estTokens: 3, complete: false, durationMs: 1 } };
    for (const spec of this.specs) {
      const items = this.itemsFor(spec, req.ref);
      if (items.length > 0) {
        const text = `source of ${req.ref}`;
        return { text, meta: { estTokens: estimateTokens(text), complete: true, durationMs: 1, items } };
      }
    }
    return { text: 'not found', isError: true, meta: { estTokens: 2, complete: false, durationMs: 1 } };
  }

  async impact(_req: ImpactRequest): Promise<ToolOutput> {
    throw new Error('not used');
  }

  async compress(_req: CompressRequest): Promise<ToolOutput> {
    throw new Error('not used');
  }

  async memory(_req: MemoryRequest): Promise<ToolOutput> {
    throw new Error('not used');
  }

  async stats(_req?: StatsRequest): Promise<ToolOutput> {
    throw new Error('not used');
  }

  close(): void {
    this.log.closed = true;
  }
}

export function createFakeEngineFactory(
  specs: readonly OfflineTaskSpec[],
  behavior: FakeEngineBehavior = {},
): { openEngine: (options: EngineOptions) => Promise<MaxifyEngine>; log: FakeEngineLog } {
  const log: FakeEngineLog = { options: [], indexCalls: 0, contextCalls: [], sourceCalls: [], closed: false };
  return {
    log,
    openEngine: async (options) => {
      log.options.push(options);
      return new FakeEngine(options, specs, behavior, log);
    },
  };
}
