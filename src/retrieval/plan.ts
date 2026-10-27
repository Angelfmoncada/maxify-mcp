import type { DetailLevel } from '../engine/types.js';
import type { FileRow } from '../store/rows.js';
import { isPrimary, levelRank, priority, type Item } from './items.js';

export type Level = DetailLevel | 'omitted';

export interface PlanOptions {
  budget: number;
  detail: 'auto' | DetailLevel;
  /** Header, legend and section overhead. */
  fixedCost: number;
  /** Estimated tokens of an item's block at a level. */
  cost: (item: Item, level: DetailLevel) => number;
  fileHeaderCost: (file: FileRow) => number;
  maxMapItems?: number;
}

export interface Plan {
  levels: Map<string, Level>;
  /** Items fully contained in another item rendered as source (not rendered separately). */
  covered: Set<string>;
  estimate: number;
}

const LEVELS_DESC: DetailLevel[] = ['source', 'signature', 'map'];

function clamp(level: DetailLevel, ceiling: DetailLevel): DetailLevel {
  return levelRank(level) <= levelRank(ceiling) ? level : ceiling;
}

function spanLines(item: Item): number {
  return item.node ? item.node.symbol.endLine - item.node.symbol.startLine + 1 : 0;
}

function contains(outer: Item, inner: Item): boolean {
  if (!outer.node || !inner.node || outer.file.id !== inner.file.id || outer.key === inner.key) return false;
  const a = outer.node.symbol;
  const b = inner.node.symbol;
  return a.startLine <= b.startLine && a.endLine >= b.endLine && (a.endLine - a.startLine > b.endLine - b.startLine || a.startLine < b.startLine);
}

export function sortByPriority(items: readonly Item[]): Item[] {
  return [...items].sort(
    (a, b) =>
      priority(b) - priority(a) ||
      (a.file.path < b.file.path ? -1 : a.file.path > b.file.path ? 1 : 0) ||
      (a.node?.symbol.startLine ?? 0) - (b.node?.symbol.startLine ?? 0),
  );
}

class PlanState {
  readonly levels = new Map<string, Level>();

  constructor(
    private readonly items: readonly Item[],
    private readonly opts: PlanOptions,
  ) {
    for (const item of items) this.levels.set(item.key, 'omitted');
  }

  level(item: Item): Level {
    return this.levels.get(item.key) ?? 'omitted';
  }

  coverage(): Set<string> {
    const covered = new Set<string>();
    const sources = this.items.filter((i) => this.level(i) === 'source');
    for (const item of this.items) {
      if (this.level(item) === 'omitted') continue;
      if (sources.some((outer) => contains(outer, item))) covered.add(item.key);
    }
    return covered;
  }

  total(): number {
    const covered = this.coverage();
    const files = new Map<number, FileRow>();
    let sum = this.opts.fixedCost;
    for (const item of this.items) {
      const level = this.level(item);
      if (level === 'omitted' || covered.has(item.key)) continue;
      files.set(item.file.id, item.file);
      sum += this.opts.cost(item, level);
    }
    for (const file of files.values()) sum += this.opts.fileHeaderCost(file);
    return sum;
  }

  attempt(item: Item, level: Level): boolean {
    const previous = this.level(item);
    if (previous === level) return true;
    this.levels.set(item.key, level);
    if (this.total() <= this.opts.budget) return true;
    this.levels.set(item.key, previous);
    return false;
  }

  /** Try `desired`, then each lower level down to map; never lowers an already better level. */
  attemptBest(item: Item, desired: DetailLevel): void {
    for (const level of LEVELS_DESC) {
      if (levelRank(level) > levelRank(desired)) continue;
      if (levelRank(level) <= levelRank(this.level(item))) return;
      if (this.attempt(item, level)) return;
    }
  }

  mapCount(): number {
    let n = 0;
    for (const level of this.levels.values()) if (level === 'map') n++;
    return n;
  }
}

function ceilingFor(item: Item, detail: 'auto' | DetailLevel): DetailLevel {
  return detail === 'auto' ? item.maxLevel : clamp(detail, item.maxLevel);
}

function desiredLevel(item: Item, detail: 'auto' | DetailLevel, opts: PlanOptions): DetailLevel {
  const ceiling = ceilingFor(item, detail);
  if (detail !== 'auto') return ceiling;
  let desired: DetailLevel = 'map';
  if (isPrimary(item)) desired = 'source';
  else if (item.roles.has('type')) desired = spanLines(item) <= 60 ? 'source' : 'signature';
  else if (item.roles.has('callee') || item.roles.has('parent')) desired = 'signature';
  if (desired === 'signature' && item.node && opts.cost(item, 'source') <= opts.cost(item, 'signature') * 1.15 + 4) desired = 'source';
  return clamp(desired, ceiling);
}

/**
 * Greedy, priority-ordered allocation of detail levels under the budget:
 * primaries first (exact source when it fits), then contracts and callees,
 * then tests and callers as locations, then upgrades with what is left.
 * Items are never truncated: an item is shown whole at some level or omitted.
 */
export function planLevels(items: readonly Item[], opts: PlanOptions): Plan {
  const state = new PlanState(items, opts);
  const sorted = sortByPriority(items);
  const maxMap = opts.maxMapItems ?? 30;
  for (const item of sorted) if (isPrimary(item)) state.attemptBest(item, desiredLevel(item, opts.detail, opts));
  for (const item of sorted) {
    if (isPrimary(item)) continue;
    if (item.roles.has('type') || item.roles.has('callee') || item.roles.has('parent')) {
      state.attemptBest(item, desiredLevel(item, opts.detail, opts));
    }
  }
  for (const item of sorted) {
    if (state.level(item) !== 'omitted' || state.mapCount() >= maxMap) continue;
    if (item.roles.has('test') || item.roles.has('caller') || item.roles.has('related')) state.attemptBest(item, clamp('map', ceilingFor(item, opts.detail)));
  }
  upgradeWithLeftover(state, sorted, opts);
  return { levels: state.levels, covered: state.coverage(), estimate: state.total() };
}

/** Items below this fraction of the top priority never take budget beyond a map line. */
const FILL_THRESHOLD = 0.2;

/**
 * Spend what is left of the budget on the most relevant evidence first, up to
 * exact source. The budget is a ceiling, not a target: items under the
 * relevance threshold are not upgraded, so unused budget is simply not spent.
 */
function upgradeWithLeftover(state: PlanState, sorted: readonly Item[], opts: PlanOptions): void {
  const top = sorted.length > 0 ? priority(sorted[0] as Item) : 0;
  for (const item of sorted) {
    if (priority(item) < FILL_THRESHOLD * top) break;
    const ceiling = ceilingFor(item, opts.detail);
    const target = item.roles.has('parent') && !isPrimary(item) ? clamp('signature', ceiling) : ceiling;
    state.attemptBest(item, target);
  }
}

/** Demote the lowest-priority visible item one level (used when the rendered text overshoots the estimate). */
export function demoteOne(items: readonly Item[], levels: Map<string, Level>): boolean {
  const visible = sortByPriority(items).reverse().filter((i) => (levels.get(i.key) ?? 'omitted') !== 'omitted');
  const victim = visible.find((i) => !isPrimary(i)) ?? visible[0];
  if (!victim) return false;
  const current = levels.get(victim.key) ?? 'omitted';
  const next: Level = current === 'source' ? 'signature' : current === 'signature' ? 'map' : 'omitted';
  levels.set(victim.key, next);
  return true;
}
