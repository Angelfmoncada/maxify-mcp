import { MaxifyError } from '../core/errors.js';
import type { RepoGuard } from '../core/paths.js';
import { estimateTokens } from '../core/tokens.js';
import type { ImpactRequest } from '../engine/types.js';
import type { IndexStore } from '../store/index-store.js';
import type { FileRow } from '../store/rows.js';
import { Graph, type Relation, type SymbolNode } from './graph.js';
import { parseRef } from './refs.js';

export interface ImpactDeps {
  store: IndexStore;
  guard: RepoGuard;
  generation: number;
}

export interface ImpactResult {
  text: string;
  complete: boolean;
  estTokens: number;
}

interface Target {
  file: FileRow;
  nodes: SymbolNode[];
  label: string;
}

const USE_KINDS = new Set(['import', 'import-type', 'require', 'dynamic-import', 'reexport', 'reexport-all']);

function resolveTargets(deps: ImpactDeps, graph: Graph, refs: readonly string[]): Target[] {
  const targets: Target[] = [];
  for (const raw of refs) {
    const ref = parseRef(raw);
    if (ref.type === 'blob') throw new MaxifyError('INVALID_INPUT', 'impact targets are paths or symbols, not blobs');
    if (ref.type === 'name') {
      const matches = deps.store.symbolsByName(ref.name, 10);
      if (matches.length === 0) throw new MaxifyError('NOT_FOUND', `No indexed symbol named "${ref.name}"; pass path#Name.`);
      for (const m of matches) {
        const file = graph.file(m.path);
        const node = file ? graph.node(file, m.ordinal) : null;
        if (file && node) targets.push({ file, nodes: [node], label: `${m.path}#${m.qualName}` });
      }
      continue;
    }
    const path = deps.guard.resolve(ref.path);
    const file = graph.file(path);
    if (!file) throw new MaxifyError('NOT_FOUND', `${path} is not in the index.`);
    const symbols = graph.symbols(file.id);
    if (ref.type === 'symbol') {
      const symbol = symbols.find((s) => s.qualName === ref.qual) ?? symbols.find((s) => s.name === ref.qual);
      if (!symbol) throw new MaxifyError('NOT_FOUND', `No symbol "${ref.qual}" in ${path}.`);
      targets.push({ file, nodes: [{ file, symbol }], label: `${path}#${symbol.qualName}` });
    } else {
      const exported = symbols.filter((s) => s.exported && s.parentOrdinal === null).map((symbol) => ({ file, symbol }));
      targets.push({ file, nodes: exported, label: `${path} (${exported.length} exported symbols)` });
    }
  }
  return targets;
}

/** Reverse import graph BFS: files that (transitively) import any target file. */
function transitiveDependents(deps: ImpactDeps, starts: readonly string[], depth: number): Map<string, number> {
  const seen = new Map<string, number>(starts.map((p) => [p, 0] as const));
  let frontier = [...starts];
  for (let level = 1; level <= depth && frontier.length > 0; level++) {
    const next: string[] = [];
    for (const path of frontier) {
      for (const imp of deps.store.importersOf(path)) {
        if (!USE_KINDS.has(imp.kind) || seen.has(imp.path)) continue;
        seen.set(imp.path, level);
        next.push(imp.path);
      }
    }
    frontier = next;
  }
  for (const s of starts) seen.delete(s);
  return seen;
}

function relationLine(r: Relation): string {
  const who = r.node ? `${r.node.symbol.qualName} (L${r.node.symbol.startLine}-${r.node.symbol.endLine})` : 'module scope';
  return `  ${who} ${r.kind} at L${r.line}${r.count > 1 ? ` ×${r.count}` : ''} · ${r.provenance}`;
}

function groupByFile(relations: readonly Relation[]): Map<string, Relation[]> {
  const out = new Map<string, Relation[]>();
  for (const r of relations) {
    const list = out.get(r.path) ?? [];
    list.push(r);
    out.set(r.path, list);
  }
  return out;
}

interface Sections {
  direct: string[];
  transitive: string[];
  tests: string[];
  api: string[];
  uncertain: string[];
  /** True when any list was shortened to fit the limit. */
  capped: boolean;
}

function collect(deps: ImpactDeps, graph: Graph, targets: readonly Target[], depth: number, limit: number): Sections {
  const direct: Relation[] = [];
  const tests: Relation[] = [];
  const api: string[] = [];
  for (const t of targets) {
    for (const node of t.nodes) {
      const callers = graph.callersOf(node, 200);
      direct.push(...callers.filter((r) => !graph.file(r.path)?.isTest && r.path !== node.file.path));
      direct.push(...callers.filter((r) => r.path === node.file.path && r.node !== null));
      tests.push(...graph.testsOf(node));
      if (node.symbol.exported) {
        const aliases = graph.aliasesOf(node).filter((a) => a.path !== node.file.path);
        const via = aliases.length > 0 ? `; re-exported by ${aliases.map((a) => `${a.path} as ${a.name}`).join(', ')} (resolved)` : '';
        api.push(`- ${node.file.path}#${node.symbol.qualName} exported as ${node.symbol.exportNames.join(', ')}${via}`);
      }
    }
    tests.push(...graph.testsOfFile(t.file.path));
  }
  const transitive = transitiveDependents(deps, [...new Set(targets.map((t) => t.file.path))], depth);
  for (const path of transitive.keys()) {
    if (graph.file(path)?.isTest) continue;
    tests.push(...graph.testsOfFile(path).map((r) => ({ ...r, note: `indirect: tests ${path}` })));
  }
  const perDepth = new Map<number, number>();
  for (const d of transitive.values()) perDepth.set(d, (perDepth.get(d) ?? 0) + 1);
  const capped =
    new Set(direct.map((r) => r.path)).size > limit ||
    new Set(tests.map((t) => t.path)).size > limit ||
    [...groupByFile(direct).values()].some((rels) => rels.length > 6) ||
    [...perDepth.values()].some((n) => n > limit);
  return {
    direct: renderDirect(direct, limit),
    transitive: renderTransitive(transitive, limit),
    tests: renderTests(tests, limit),
    api,
    uncertain: renderUncertain(deps, targets),
    capped,
  };
}

function renderDirect(direct: readonly Relation[], limit: number): string[] {
  const out: string[] = [];
  const grouped = groupByFile(direct);
  for (const [path, rels] of [...grouped.entries()].slice(0, limit)) {
    out.push(path, ...rels.slice(0, 6).map(relationLine));
    if (rels.length > 6) out.push(`  +${rels.length - 6} more references`);
  }
  if (grouped.size > limit) out.push(`+${grouped.size - limit} more files`);
  return out;
}

function renderTransitive(transitive: ReadonlyMap<string, number>, limit: number): string[] {
  const byDepth = new Map<number, string[]>();
  for (const [path, d] of transitive) byDepth.set(d, [...(byDepth.get(d) ?? []), path]);
  return [...byDepth.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([d, paths]) => `- depth ${d}: ${paths.slice(0, limit).join(', ')}${paths.length > limit ? ` +${paths.length - limit} more` : ''}`);
}

function renderTests(tests: readonly Relation[], limit: number): string[] {
  const byFile = new Map<string, Relation[]>();
  for (const t of tests) byFile.set(t.path, [...(byFile.get(t.path) ?? []), t]);
  const rank = (rels: Relation[]): number => (rels.some((r) => r.provenance === 'resolved' && !r.note) ? 0 : rels.some((r) => r.provenance === 'resolved') ? 1 : 2);
  const ordered = [...byFile.entries()].sort((a, b) => rank(a[1]) - rank(b[1]) || (a[0] < b[0] ? -1 : 1));
  return ordered.slice(0, limit).map(([path, rels]) => {
    const names = [...new Set(rels.filter((r) => r.node).map((r) => `"${r.node?.symbol.qualName}" L${r.node?.symbol.startLine}`))].slice(0, 4);
    const why = rels.find((r) => r.note)?.note ?? (rels[0]?.provenance === 'heuristic' ? 'naming convention' : 'references target');
    return `- ${path}${names.length > 0 ? `: ${names.join(', ')}` : ''} (${rels[0]?.provenance ?? 'resolved'}: ${why})`;
  });
}

function renderUncertain(deps: ImpactDeps, targets: readonly Target[]): string[] {
  const out: string[] = [];
  const dynamic = deps.store.unresolvedAll(400).filter((u) => u.kind === 'dynamic-import' || u.kind === 'dynamic-require' || u.kind === 'glob-import');
  const dirs = targets.map((t) => t.file.path.split('/').slice(0, -1).join('/'));
  const near = dynamic.filter((u) => dirs.some((d) => d.length > 0 && (u.detail.includes(d.split('/').pop() ?? '\u0000') || u.path.startsWith(d))));
  for (const u of near.slice(0, 5)) out.push(`- ${u.path}:${u.line} ${u.kind}: ${u.detail} — may load target modules at runtime`);
  const unresolvedImports = deps.store.countImportsByResolution().unresolved ?? 0;
  if (dynamic.length > near.length) out.push(`- ${dynamic.length - near.length} other dynamic imports/requires in the repo cannot be linked statically`);
  if (unresolvedImports > 0) out.push(`- ${unresolvedImports} import specifiers in the repo could not be resolved; dependents through them are not listed`);
  return out;
}

function render(deps: ImpactDeps, targets: readonly Target[], s: Sections, depth: number, budget: number, complete: boolean): string {
  const parts = [
    `maxify_impact · gen ${deps.generation} · depth ${depth} · est. {{EST}}/${budget} tokens · ${complete ? 'complete' : 'INCOMPLETE — lists capped, raise budget'}`,
    `targets: ${targets.map((t) => t.label).join('; ')}`,
    '',
    `## direct dependents (callers/importers)`,
    ...(s.direct.length > 0 ? s.direct : ['- none found by static analysis']),
    '',
    `## transitive dependents (files importing them)`,
    ...(s.transitive.length > 0 ? s.transitive : ['- none']),
    '',
    '## tests likely affected',
    ...(s.tests.length > 0 ? s.tests : ['- no test references or naming matches found']),
  ];
  if (s.api.length > 0) parts.push('', '## exported API surface', ...s.api);
  if (s.uncertain.length > 0) parts.push('', '## uncertain — not linked by static analysis', ...s.uncertain);
  return parts.join('\n');
}

/** Dependents, likely affected tests, exported surface and gaps for the given targets, within budget. */
export function computeImpact(deps: ImpactDeps, req: ImpactRequest, budget: number): ImpactResult {
  const graph = new Graph(deps.store);
  const depth = Math.max(1, Math.min(5, req.depth ?? 2));
  const targets = resolveTargets(deps, graph, req.targets);
  for (let limit = 40; limit >= 2; limit = Math.floor(limit / 2)) {
    const sections = collect(deps, graph, targets, depth, limit);
    const draft = render(deps, targets, sections, depth, budget, !sections.capped);
    const est = estimateTokens(draft);
    if (est <= budget || limit <= 2) {
      const text = draft.replace('{{EST}}', String(est));
      return { text, complete: !sections.capped && est <= budget, estTokens: estimateTokens(text) };
    }
  }
  throw new MaxifyError('INTERNAL', 'impact rendering did not converge');
}
