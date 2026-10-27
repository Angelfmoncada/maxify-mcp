import type { SymbolKind } from '../core/types.js';
import { splitIdentifier } from '../indexer/terms.js';
import type { FtsHit, IndexStore } from '../store/index-store.js';
import type { FileRow } from '../store/rows.js';
import type { Graph, SymbolNode } from './graph.js';
import { liveFiles, livenessFactor } from './liveness.js';
import { itemKey, maxLevelFor, upsertItem, type Item, type Role } from './items.js';
import { ftsOr, ftsTerm, type QueryTerm, type TaskQuery } from './query.js';

const FIELD_WEIGHT = { name: 5, terms: 4, signature: 2.5, path: 2, doc: 1.5, body: 1 } as const;
type Field = keyof typeof FIELD_WEIGHT;

const KIND_WEIGHT: Partial<Record<SymbolKind, number>> = {
  function: 1,
  method: 1,
  class: 1,
  component: 1,
  hook: 1,
  constructor: 0.9,
  accessor: 0.9,
  interface: 0.9,
  type: 0.9,
  enum: 0.85,
  namespace: 0.7,
  variable: 0.75,
  property: 0.7,
  block: 0.6,
  suite: 0.55,
  test: 0.55,
  section: 0.5,
  chunk: 0.45,
  key: 0.5,
};

function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split(/[^\p{L}\p{N}_$]+/u)) {
    if (raw.length === 0) continue;
    out.add(raw.toLowerCase());
    for (const part of splitIdentifier(raw)) out.add(part);
  }
  return out;
}

const INFLECTION = /^(?:e|ed|es|s|ing|ings|ion|ions|ation|ations|er|ers|y|ies|ied|ly|ment|ments|ry)$/;

/**
 * 1 for an exact token or an inflection of the stem (expir* -> expired), 0.6 for any
 * other prefix match (token* -> tokenize is a different word), else 0.
 */
function matches(tokens: Set<string>, term: QueryTerm): number {
  if (tokens.has(term.term)) return 1;
  if (!term.prefix) return 0;
  let best = 0;
  for (const token of tokens) {
    if (!token.startsWith(term.term)) continue;
    if (INFLECTION.test(token.slice(term.term.length))) return 1;
    best = 0.6;
  }
  return best;
}

const CODE_KINDS = new Set(['function', 'class', 'method', 'constructor', 'accessor', 'property', 'interface', 'type', 'enum', 'namespace', 'variable', 'component', 'hook']);

/**
 * Our own BM25-like field scoring: robust on small repos where FTS5 bm25() degenerates.
 * A symbol matched only through its file path (e.g. every symbol of client.ts for "client-side")
 * keeps 30% of its score: the path says where to look, not which symbol matters.
 */
function scoreHit(hit: FtsHit, terms: readonly QueryTerm[], idf: Map<string, number>): number {
  const fields: Record<Field, Set<string>> = {
    name: tokenize(hit.name),
    terms: new Set(hit.terms.split(' ')),
    signature: tokenize(hit.signature),
    path: tokenize(hit.path),
    doc: tokenize(hit.doc),
    body: tokenize(hit.body),
  };
  let score = 0;
  let outsidePath = false;
  for (const term of terms) {
    let best = 0;
    for (const field of Object.keys(fields) as Field[]) {
      const value = FIELD_WEIGHT[field] * matches(fields[field], term);
      if (value > best) best = value;
      if (value > 0 && field !== 'path') outsidePath = true;
    }
    score += best * term.weight * (idf.get(term.term) ?? 1);
  }
  return hit.symbolOrdinal !== null && !outsidePath ? score * 0.3 : score;
}

function computeIdf(store: IndexStore, terms: readonly QueryTerm[]): Map<string, number> {
  const total = Math.max(1, store.ftsTotal());
  const idf = new Map<string, number>();
  for (const term of terms) {
    let df = 0;
    try {
      df = store.ftsCount(ftsTerm(term));
    } catch {
      df = 0;
    }
    idf.set(term.term, Math.log(1 + (total - df + 0.5) / (df + 0.5)));
  }
  return idf;
}

function intentWeight(file: FileRow, node: SymbolNode | null, query: TaskQuery): number {
  let weight = node ? (KIND_WEIGHT[node.symbol.kind] ?? 0.6) : 0.45;
  if (file.isTest) weight *= query.intents.tests ? 1.6 : 0.5;
  if (file.language === 'markdown') weight *= query.intents.docs ? 1.8 : 0.6;
  if (file.language === 'json') weight *= query.intents.config ? 1.8 : 0.6;
  return weight;
}

export interface CandidateContext {
  store: IndexStore;
  graph: Graph;
  query: TaskQuery;
  /** Resolved focus targets (paths or symbol nodes) supplied by the caller or written in the task. */
  focus: Array<{ file: FileRow; node: SymbolNode | null }>;
  /** Item keys already delivered on earlier pages (cursor continuation). */
  exclude: ReadonlySet<string>;
}

function makeItem(file: FileRow, node: SymbolNode | null, score: number, role: Role): Item {
  return {
    key: itemKey(file, node),
    file,
    node,
    score,
    roles: new Set([role]),
    relations: [],
    provenance: 'extracted',
    maxLevel: maxLevelFor(file, node),
    level: 'omitted',
  };
}

/** Rank search hits and exact matches into a deduplicated candidate map with normalized scores (top = 1). */
export function findCandidates(ctx: CandidateContext): Map<string, Item> {
  const { store, graph, query } = ctx;
  const items = new Map<string, Item>();
  const raw: Array<{ file: FileRow; node: SymbolNode | null; score: number }> = [];
  const live = liveFiles(store);
  if (query.terms.length > 0) {
    const idf = computeIdf(store, query.terms);
    let hits: FtsHit[] = [];
    try {
      hits = store.ftsSearch(ftsOr(query.terms), 150);
    } catch {
      hits = [];
    }
    for (const hit of hits) {
      const file = store.fileById(hit.fileId);
      if (!file) continue;
      const node = hit.symbolOrdinal === null ? null : graph.node(file, hit.symbolOrdinal);
      raw.push({ file, node, score: scoreHit(hit, query.terms, idf) * intentWeight(file, node, query) * livenessFactor(file, live) });
    }
  }
  const top = Math.max(1e-9, ...raw.map((r) => r.score));
  for (const r of raw) {
    const item = makeItem(r.file, r.node, r.score / top, 'related');
    if (!ctx.exclude.has(item.key)) upsertItem(items, item);
  }
  boostExactIdentifiers(ctx, items);
  boostPaths(ctx, items);
  for (const f of ctx.focus) {
    const item = makeItem(f.file, f.node, 2, 'focus');
    if (!ctx.exclude.has(item.key)) upsertItem(items, item);
  }
  return items;
}

function boostExactIdentifiers(ctx: CandidateContext, items: Map<string, Item>): void {
  const lookups = [
    ...ctx.query.identifiers.map((identifier) => ({ identifier, insensitive: true })),
    ...ctx.query.names.map((identifier) => ({ identifier, insensitive: false })),
  ];
  for (const { identifier, insensitive } of lookups) {
    const name = identifier.split('.').pop() ?? identifier;
    const exact = ctx.store.symbolsByName(identifier, 20);
    const found = exact.length > 0 ? exact : ctx.store.symbolsByName(name, 20);
    const list = found.length > 0 || !insensitive ? found : ctx.store.symbolsByNameInsensitive(name, 20);
    const bonus = found.length > 0 ? 1.0 : 0.7;
    for (const s of list) {
      if (!insensitive && !CODE_KINDS.has(s.kind)) continue;
      const file = ctx.graph.file(s.path);
      if (!file) continue;
      const node = ctx.graph.node(file, s.ordinal);
      const item = makeItem(file, node, bonus * intentWeight(file, node, ctx.query) + 0.3, 'related');
      if (ctx.exclude.has(item.key)) continue;
      const prev = items.get(item.key);
      upsertItem(items, prev ? { ...item, score: prev.score + item.score } : item);
    }
  }
}

function boostPaths(ctx: CandidateContext, items: Map<string, Item>): void {
  for (const mentioned of ctx.query.paths) {
    for (const file of ctx.store.filesBySuffix(mentioned, 3)) {
      const fileItem = makeItem(file, null, 0.9, 'related');
      if (!ctx.exclude.has(fileItem.key)) upsertItem(items, fileItem);
      for (const [key, item] of items) {
        if (item.file.id === file.id && item.node) items.set(key, { ...item, score: item.score + 0.4 });
      }
    }
  }
}
