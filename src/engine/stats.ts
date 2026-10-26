import type { RepoGuard } from '../core/paths.js';
import type { Exclusions } from '../indexer/exclusions.js';
import { walkRepository } from '../indexer/walk.js';
import type { AuxStore, ToolAggregate } from '../store/aux-store.js';
import type { IndexStore } from '../store/index-store.js';

export const LIMITATIONS: readonly string[] = [
  'Token counts are local heuristic estimates, not Claude tokenizer counts; only provider-reported usage (agent benchmarks) is exact.',
  'Maxify only controls its own tool results. It cannot intercept or shrink native Read/Grep/Bash output, the system prompt, or the model reasoning.',
  'Static analysis without a type checker: method calls on typed objects (obj.method()) and DI/reflection are not linked; dynamic imports are reported as uncertain, never guessed.',
  'Structural languages: TS/JS/JSX, Markdown, JSON. Other text files are indexed as line chunks without symbols.',
  'The result cache saves CPU and latency, not tokens: text sent again costs tokens again.',
  'Delta responses are off by default because the client may have compacted earlier results out of context.',
];

export interface StatsDeps {
  store: IndexStore;
  aux: AuxStore;
  guard: RepoGuard;
  exclusions: Exclusions;
  stateDir: string;
  session: string;
}

function fmt(record: Record<string, number>): string {
  const entries = Object.entries(record).sort((a, b) => b[1] - a[1]);
  return entries.length === 0 ? 'none' : entries.map(([k, v]) => `${k} ${v}`).join(', ');
}

/** Files added/changed/removed on disk since the last index (stat comparison, no hashing). */
export function diskDrift(deps: Pick<StatsDeps, 'store' | 'guard' | 'exclusions'>): { changed: number; added: number; removed: number } {
  const walk = walkRepository(deps.guard, deps.exclusions);
  const indexed = new Map(deps.store.allFiles().map((f) => [f.path, f] as const));
  let changed = 0;
  let added = 0;
  for (const w of walk.files) {
    const row = indexed.get(w.path);
    if (!row) added++;
    else if (row.size !== w.size || row.mtimeMs !== w.mtimeMs) changed++;
    indexed.delete(w.path);
  }
  return { changed, added, removed: indexed.size };
}

function indexSection(deps: StatsDeps): string[] {
  const { store } = deps;
  const lastAt = Number(store.getMeta('last_index_at') ?? 0);
  const drift = diskDrift(deps);
  const refs = store.countRefs();
  return [
    '## index',
    `root: ${deps.guard.root}`,
    `state: ${deps.stateDir}`,
    `generation ${store.generation()} · last index ${lastAt > 0 ? new Date(lastAt).toISOString() : 'never'} (${store.getMeta('last_index_ms') ?? '?'} ms)`,
    `files: ${fmt(store.countFilesByStatus())}`,
    `symbols: ${fmt(store.countSymbolsByKind())}`,
    `imports: ${fmt(store.countImportsByResolution())}`,
    `references: same-file ${refs.local} (extracted), via imports ${refs.imported} (linked as resolved when the import resolves)`,
    `uncertain (static analysis gaps): ${fmt(store.countUnresolvedByKind())}`,
    `on disk since last index: ${drift.changed} changed, ${drift.added} added, ${drift.removed} removed (re-indexed automatically on the next query)`,
    `notes: ${deps.aux.countNotes()} · compression blobs: ${deps.aux.blobCount()}`,
  ];
}

function toolLines(aggregates: readonly ToolAggregate[]): string[] {
  if (aggregates.length === 0) return ['- no calls recorded'];
  return aggregates.map(
    (a) =>
      `- ${a.tool}: ${a.calls} calls · est. ${a.estTokens} tokens returned · avg ${a.avgMs} ms · ${a.cacheHits} cache hits · ${a.incomplete} incomplete · ${a.errors} errors`,
  );
}

function usageSection(deps: StatsDeps, session: string | null, title: string): string[] {
  const totals = deps.aux.compressionTotals(session);
  const saved = totals.originalTokens - totals.outputTokens;
  return [
    `## ${title}`,
    ...toolLines(deps.aux.aggregate(session)),
    `- compression: ${totals.calls} calls · est. ${totals.originalTokens} → ${totals.outputTokens} tokens (${saved} fewer in results; a session saving only if the raw output would otherwise have entered the context)`,
  ];
}

export function renderStats(deps: StatsDeps, scope: 'index' | 'session' | 'all'): string {
  const parts: string[] = [`maxify_stats · scope ${scope}`];
  if (scope === 'index' || scope === 'all') parts.push('', ...indexSection(deps));
  if (scope === 'session' || scope === 'all') {
    parts.push('', ...usageSection(deps, deps.session, 'this server session (local estimates)'));
    parts.push('', ...usageSection(deps, null, 'all recorded sessions (local estimates)'));
  }
  parts.push('', '## limitations', ...LIMITATIONS.map((l) => `- ${l}`));
  return parts.join('\n');
}
