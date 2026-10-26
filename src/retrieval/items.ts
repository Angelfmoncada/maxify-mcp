import type { Provenance } from '../core/types.js';
import type { DetailLevel } from '../engine/types.js';
import type { FileRow } from '../store/rows.js';
import type { SymbolNode, Uncertainty } from './graph.js';

export type Role = 'focus' | 'primary' | 'related' | 'callee' | 'type' | 'caller' | 'test' | 'parent';

export interface RelationNote {
  dir: 'in' | 'out';
  /** e.g. "requireAuth (src/server/auth/middleware.ts:20)" */
  label: string;
  kind: string;
  provenance: Provenance;
}

/** A candidate piece of evidence: a symbol, or a whole file when node is null. */
export interface Item {
  key: string;
  file: FileRow;
  node: SymbolNode | null;
  score: number;
  roles: Set<Role>;
  relations: RelationNote[];
  /** Provenance of the strongest link that brought this item in ('extracted' for direct search hits). */
  provenance: Provenance;
  maxLevel: DetailLevel;
  level: DetailLevel | 'omitted';
}

export interface CandidateSet {
  items: Map<string, Item>;
  uncertain: Uncertainty[];
}

export const ROLE_WEIGHT: Record<Role, number> = {
  focus: 1.25,
  primary: 1.0,
  type: 0.8,
  callee: 0.7,
  parent: 0.6,
  test: 0.6,
  caller: 0.5,
  related: 0.4,
};

export function itemKey(file: FileRow, node: SymbolNode | null): string {
  return node ? `${file.path}#${node.symbol.ordinal}` : file.path;
}

export function priority(item: Item): number {
  let best = 0;
  for (const role of item.roles) best = Math.max(best, ROLE_WEIGHT[role]);
  return item.score * best;
}

export function isPrimary(item: Item): boolean {
  return item.roles.has('primary') || item.roles.has('focus');
}

/** Ref string the agent can pass to maxify_source. */
export function itemRef(item: Item): string {
  return item.node ? `${item.file.path}#${item.node.symbol.qualName}` : item.file.path;
}

const RANK: Record<DetailLevel | 'omitted', number> = { omitted: 0, map: 1, signature: 2, source: 3 };

export function levelRank(level: DetailLevel | 'omitted'): number {
  return RANK[level];
}

/** Merge a new sighting of an item into the set (max score, union roles and relations). */
export function upsertItem(items: Map<string, Item>, incoming: Item): Item {
  const prev = items.get(incoming.key);
  if (!prev) {
    items.set(incoming.key, incoming);
    return incoming;
  }
  const merged: Item = {
    ...prev,
    score: Math.max(prev.score, incoming.score),
    roles: new Set([...prev.roles, ...incoming.roles]),
    relations: mergeRelations(prev.relations, incoming.relations),
    provenance: strongerProvenance(prev.provenance, incoming.provenance),
    maxLevel: levelRank(incoming.maxLevel) > levelRank(prev.maxLevel) ? incoming.maxLevel : prev.maxLevel,
  };
  items.set(incoming.key, merged);
  return merged;
}

function mergeRelations(a: RelationNote[], b: RelationNote[]): RelationNote[] {
  const seen = new Set(a.map((r) => `${r.dir}|${r.label}`));
  const out = [...a];
  for (const r of b) {
    const key = `${r.dir}|${r.label}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(r);
    }
  }
  return out;
}

const PROVENANCE_RANK: Record<Provenance, number> = { extracted: 3, resolved: 2, heuristic: 1 };

function strongerProvenance(a: Provenance, b: Provenance): Provenance {
  return PROVENANCE_RANK[a] >= PROVENANCE_RANK[b] ? a : b;
}

export function maxLevelFor(file: FileRow, node: SymbolNode | null): DetailLevel {
  if (!node) return 'map';
  if (file.status !== 'indexed') return 'map';
  return 'source';
}
