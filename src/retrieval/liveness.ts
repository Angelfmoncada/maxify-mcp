import type { IndexStore } from '../store/index-store.js';
import type { FileRow } from '../store/rows.js';

const ENTRY_NAME = /(^|\/)(index|main|app|server|cli|config|setup|bootstrap)\.[cm]?[jt]sx?$|(^|\/)[^/]+\.(config|setup)\.[cm]?[jt]sx?$/;
const ENTRY_DIR = /(^|\/)(bin|scripts)\//;
const CODE = /\.[cm]?[jt]sx?$/;

const cache = new WeakMap<IndexStore, { generation: number; live: Set<string> }>();

function isRoot(file: FileRow): boolean {
  return file.isTest || ENTRY_NAME.test(file.path) || ENTRY_DIR.test(file.path);
}

/**
 * Code files reachable through resolved imports from tests and entry points
 * (index/main/app/server/cli/config files, bin/ and scripts/). Used only to
 * rank: unreached files are often dead or legacy code, but they stay searchable
 * and are never hidden. Cached per index generation.
 */
export function liveFiles(store: IndexStore): Set<string> {
  const generation = store.generation();
  const hit = cache.get(store);
  if (hit && hit.generation === generation) return hit.live;
  const edges = new Map<string, string[]>();
  for (const { from, to } of store.resolvedEdges()) edges.set(from, [...(edges.get(from) ?? []), to]);
  const live = new Set<string>();
  const queue = store.allFiles().filter(isRoot).map((f) => f.path);
  while (queue.length > 0) {
    const path = queue.pop() as string;
    if (live.has(path)) continue;
    live.add(path);
    for (const next of edges.get(path) ?? []) if (!live.has(next)) queue.push(next);
  }
  cache.set(store, { generation, live });
  return live;
}

/** True for code files that no test or entry point reaches through resolved imports. */
export function isUnreached(file: FileRow, live: ReadonlySet<string>): boolean {
  return CODE.test(file.path) && !file.isTest && !live.has(file.path);
}

/** Ranking factor: 0.5 for unreached code files, else 1. */
export function livenessFactor(file: FileRow, live: ReadonlySet<string>): number {
  return isUnreached(file, live) ? 0.5 : 1;
}
