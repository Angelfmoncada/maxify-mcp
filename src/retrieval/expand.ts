import type { Graph, Relation, SymbolNode, Uncertainty } from './graph.js';
import { itemKey, maxLevelFor, upsertItem, type Item, type RelationNote, type Role } from './items.js';

export interface ExpandOptions {
  includeTests: boolean;
  testIntent: boolean;
  exclude: ReadonlySet<string>;
  maxPrimaries?: number;
}

export interface Expansion {
  items: Map<string, Item>;
  primaries: Item[];
  uncertain: Uncertainty[];
}

const TYPE_KINDS = new Set(['uses-type', 'extends', 'implements']);

function byScore(a: Item, b: Item): number {
  return b.score - a.score || (a.file.path < b.file.path ? -1 : a.file.path > b.file.path ? 1 : 0) || lineOf(a) - lineOf(b);
}

function lineOf(item: Item): number {
  return item.node?.symbol.startLine ?? 0;
}

function label(node: SymbolNode, line?: number): string {
  return `${node.symbol.qualName} (${node.file.path}:${line ?? node.symbol.startLine})`;
}

function note(dir: 'in' | 'out', text: string, relation: Relation): RelationNote {
  return { dir, label: text, kind: relation.kind, provenance: relation.provenance };
}

function relatedItem(node: SymbolNode, score: number, role: Role, relation: Relation, relations: RelationNote[]): Item {
  return {
    key: itemKey(node.file, node),
    file: node.file,
    node,
    score,
    roles: new Set([role]),
    relations,
    provenance: relation.provenance,
    maxLevel: role === 'parent' ? 'signature' : maxLevelFor(node.file, node),
    level: 'omitted',
  };
}

function withNote(items: Map<string, Item>, item: Item, extra: RelationNote): void {
  upsertItem(items, { ...item, roles: new Set(), score: 0, relations: [extra] });
}

function expandCallees(graph: Graph, items: Map<string, Item>, primary: Item, node: SymbolNode, uncertain: Uncertainty[], opts: ExpandOptions): void {
  const { relations, uncertain: gaps } = graph.calleesOf(node);
  uncertain.push(...gaps);
  for (const rel of relations) {
    if (!rel.node || opts.exclude.has(itemKey(rel.node.file, rel.node))) continue;
    const role: Role = TYPE_KINDS.has(rel.kind) ? 'type' : 'callee';
    const factor = role === 'type' ? 0.6 : 0.5;
    const incoming = note('in', label(node, rel.line), rel);
    upsertItem(items, relatedItem(rel.node, primary.score * factor, role, rel, [incoming]));
    withNote(items, primary, note('out', label(rel.node), rel));
  }
}

function expandCallers(graph: Graph, items: Map<string, Item>, primary: Item, node: SymbolNode, opts: ExpandOptions): void {
  for (const rel of graph.callersOf(node, 30)) {
    if (graph.file(rel.path)?.isTest) continue;
    if (!rel.node) {
      withNote(items, primary, note('in', `${rel.kind === 'imports' ? 'imported by' : 'module code in'} ${rel.path}:${rel.line}`, rel));
      continue;
    }
    if (opts.exclude.has(itemKey(rel.node.file, rel.node))) continue;
    upsertItem(items, relatedItem(rel.node, primary.score * 0.4, 'caller', rel, [note('out', label(node), rel)]));
    withNote(items, primary, note('in', label(rel.node, rel.line), rel));
  }
}

function expandTests(graph: Graph, items: Map<string, Item>, primary: Item, node: SymbolNode | null, opts: ExpandOptions): void {
  const relations = node ? graph.testsOf(node) : graph.testsOfFile(primary.file.path);
  const factor = opts.testIntent ? 0.85 : 0.45;
  for (const rel of relations.slice(0, 12)) {
    const target = node ? node.symbol.qualName : primary.file.path;
    if (rel.node) {
      if (opts.exclude.has(itemKey(rel.node.file, rel.node))) continue;
      upsertItem(items, relatedItem(rel.node, primary.score * factor, 'test', rel, [note('out', `tests ${target}`, rel)]));
      continue;
    }
    const file = graph.file(rel.path);
    if (!file || opts.exclude.has(itemKey(file, null))) continue;
    upsertItem(items, {
      key: itemKey(file, null),
      file,
      node: null,
      score: primary.score * factor * 0.7,
      roles: new Set<Role>(['test']),
      relations: [note('out', `tests ${target}${rel.note ? ` — ${rel.note}` : ''}`, rel)],
      provenance: rel.provenance,
      maxLevel: 'map',
      level: 'omitted',
    });
  }
}

function expandFileFocus(graph: Graph, items: Map<string, Item>, primary: Item, opts: ExpandOptions): void {
  for (const symbol of graph.symbols(primary.file.id)) {
    if (symbol.parentOrdinal !== null) continue;
    const node: SymbolNode = { file: primary.file, symbol };
    if (opts.exclude.has(itemKey(primary.file, node))) continue;
    const score = primary.score * (symbol.exported ? 0.6 : 0.4);
    upsertItem(items, { ...relatedItem(node, score, 'related', { kind: 'references', provenance: 'extracted', node, path: primary.file.path, line: symbol.startLine, count: 1 }, []) });
  }
}

/**
 * Expand the strongest candidates one hop through the graph: contracts and
 * callees (what the code depends on), callers (who depends on it), tests and
 * enclosing classes. Every added item records the provenance of its link.
 */
export function expandCandidates(graph: Graph, candidates: Map<string, Item>, opts: ExpandOptions): Expansion {
  const items = new Map(candidates);
  const uncertain: Uncertainty[] = [];
  const ranked = [...items.values()].sort(byScore);
  const top = ranked[0]?.score ?? 0;
  const primaries = ranked
    .filter((i) => i.roles.has('focus') || (i.node !== null && i.score >= 0.3 * top))
    .slice(0, opts.maxPrimaries ?? 8)
    .map((i) => upsertItem(items, { ...i, roles: new Set<Role>(['primary']), relations: [] }));
  for (const primary of primaries) {
    const node = primary.node;
    if (!node) {
      expandFileFocus(graph, items, primary, opts);
      if (opts.includeTests) expandTests(graph, items, primary, null, opts);
      uncertain.push(...graph.uncertaintiesOf(primary.file));
      continue;
    }
    expandCallees(graph, items, primary, node, uncertain, opts);
    expandCallers(graph, items, primary, node, opts);
    if (opts.includeTests) expandTests(graph, items, primary, node, opts);
    const parent = graph.parentOf(node);
    if (parent && !opts.exclude.has(itemKey(parent.file, parent))) {
      const rel: Relation = { kind: 'references', provenance: 'extracted', node: parent, path: parent.file.path, line: parent.symbol.startLine, count: 1 };
      upsertItem(items, relatedItem(parent, primary.score * 0.5, 'parent', rel, []));
    }
    const span = node.symbol;
    for (const gap of graph.uncertaintiesOf(node.file)) {
      if (gap.line >= span.startLine && gap.line <= span.endLine) uncertain.push(gap);
    }
  }
  expandSecondHopTypes(graph, items, opts);
  return { items, primaries: primaries.map((p) => items.get(p.key) ?? p), uncertain: dedupeUncertain(uncertain) };
}

/** Contract types used by the strongest callees (e.g. the payload type a called function returns). */
function expandSecondHopTypes(graph: Graph, items: Map<string, Item>, opts: ExpandOptions): void {
  const callees = [...items.values()].filter((i) => i.roles.has('callee') && i.node).sort(byScore).slice(0, 3);
  for (const callee of callees) {
    const node = callee.node as SymbolNode;
    for (const rel of graph.calleesOf(node).relations) {
      if (!rel.node || !TYPE_KINDS.has(rel.kind) || opts.exclude.has(itemKey(rel.node.file, rel.node))) continue;
      upsertItem(items, relatedItem(rel.node, callee.score * 0.5, 'type', rel, [note('in', label(node, rel.line), rel)]));
    }
  }
}

function dedupeUncertain(list: Uncertainty[]): Uncertainty[] {
  const seen = new Set<string>();
  const out: Uncertainty[] = [];
  for (const u of list) {
    const key = `${u.path}:${u.line}:${u.kind}:${u.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u);
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
}
