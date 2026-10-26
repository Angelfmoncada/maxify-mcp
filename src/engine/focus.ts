import { isMaxifyError } from '../core/errors.js';
import type { RepoGuard } from '../core/paths.js';
import type { Graph, SymbolNode, Uncertainty } from '../retrieval/graph.js';
import { parseRef } from '../retrieval/refs.js';
import type { IndexStore } from '../store/index-store.js';
import type { FileRow } from '../store/rows.js';

export interface FocusTarget {
  file: FileRow;
  node: SymbolNode | null;
}

/**
 * Resolve a focus ref to index nodes. Unknown refs are reported back as
 * uncertainties instead of failing the whole request.
 */
export function resolveFocusRef(store: IndexStore, guard: RepoGuard, graph: Graph, raw: string, misses: Uncertainty[]): FocusTarget[] {
  const miss = (detail: string): FocusTarget[] => {
    misses.push({ path: raw, line: 0, kind: 'focus-not-found', detail });
    return [];
  };
  let ref;
  try {
    ref = parseRef(raw);
  } catch (error: unknown) {
    return miss(isMaxifyError(error) ? error.message : 'invalid ref');
  }
  if (ref.type === 'blob') return miss('blob refs cannot be focus targets');
  if (ref.type === 'name') {
    const found = store.symbolsByName(ref.name, 5);
    if (found.length === 0) return miss('no indexed symbol with this name');
    return found.flatMap((s) => {
      const file = graph.file(s.path);
      const node = file ? graph.node(file, s.ordinal) : null;
      return file && node ? [{ file, node }] : [];
    });
  }
  let path: string;
  try {
    path = guard.resolve(ref.path);
  } catch (error: unknown) {
    return miss(isMaxifyError(error) ? error.message : 'invalid path');
  }
  const file = graph.file(path) ?? store.filesBySuffix(path, 1)[0] ?? null;
  if (!file) return miss('file is not in the index');
  const symbols = graph.symbols(file.id);
  if (ref.type === 'symbol') {
    const symbol = symbols.find((s) => s.qualName === ref.qual) ?? symbols.find((s) => s.name === ref.qual);
    return symbol ? [{ file, node: { file, symbol } }] : miss(`no symbol "${ref.qual}" in ${file.path}`);
  }
  if (ref.type === 'range') {
    const overlapping = symbols.filter((s) => s.startLine <= ref.end && s.endLine >= ref.start);
    const innermost = overlapping.filter((s) => !overlapping.some((o) => o !== s && o.startLine >= s.startLine && o.endLine <= s.endLine && o.endLine - o.startLine < s.endLine - s.startLine));
    return innermost.length > 0 ? innermost.slice(0, 5).map((symbol) => ({ file, node: { file, symbol } })) : [{ file, node: null }];
  }
  return [{ file, node: null }];
}
