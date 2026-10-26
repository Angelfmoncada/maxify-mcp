import { testTargetCandidates } from '../adapters/index.js';
import type { Provenance, RefKind } from '../core/types.js';
import type { IndexStore } from '../store/index-store.js';
import type { FileRow, ImportRow, SymbolRow } from '../store/rows.js';

export interface SymbolNode {
  file: FileRow;
  symbol: SymbolRow;
}

export type RelationKind = RefKind | 'imports' | 'tests';

export interface Relation {
  kind: RelationKind;
  provenance: Provenance;
  /** The other end of the relation (null when it is a whole module or could not be linked). */
  node: SymbolNode | null;
  /** File of the other end. */
  path: string;
  line: number;
  count: number;
  note?: string;
}

export interface Uncertainty {
  path: string;
  line: number;
  kind: string;
  detail: string;
}

interface ExportHit {
  node: SymbolNode | null;
  /** Module-level target (namespace import or a module without a matching export symbol). */
  path: string;
  via: string[];
}

const MAX_DEPTH = 8;
const USE_KINDS = new Set(['import', 'import-type', 'require', 'dynamic-import']);

/** Read-only relation queries over the index. Caches per instance; create one per request. */
export class Graph {
  private readonly store: IndexStore;
  private readonly files = new Map<string, FileRow | null>();
  private readonly symbolCache = new Map<number, SymbolRow[]>();
  private readonly importCache = new Map<number, ImportRow[]>();
  private testIndex: Map<string, string[]> | null = null;

  constructor(store: IndexStore) {
    this.store = store;
  }

  file(path: string): FileRow | null {
    if (!this.files.has(path)) this.files.set(path, this.store.fileByPath(path));
    return this.files.get(path) ?? null;
  }

  symbols(fileId: number): SymbolRow[] {
    let list = this.symbolCache.get(fileId);
    if (!list) {
      list = this.store.symbolsOfFile(fileId);
      this.symbolCache.set(fileId, list);
    }
    return list;
  }

  imports(fileId: number): ImportRow[] {
    let list = this.importCache.get(fileId);
    if (!list) {
      list = this.store.importsOfFile(fileId);
      this.importCache.set(fileId, list);
    }
    return list;
  }

  node(file: FileRow, ordinal: number): SymbolNode | null {
    const symbol = this.symbols(file.id)[ordinal];
    return symbol ? { file, symbol } : null;
  }

  parentOf(node: SymbolNode): SymbolNode | null {
    return node.symbol.parentOrdinal === null ? null : this.node(node.file, node.symbol.parentOrdinal);
  }

  /** Follow export names through re-exports (`export {x} from`, `export * from`) to the declaring symbol. */
  resolveExport(path: string, name: string, depth = 0, seen = new Set<string>()): ExportHit | null {
    const key = `${path}#${name}`;
    if (depth > MAX_DEPTH || seen.has(key)) return null;
    seen.add(key);
    const file = this.file(path);
    if (!file || file.status !== 'indexed') return null;
    if (name === '*') return { node: null, path, via: [] };
    const declared = this.symbols(file.id).find((s) => s.exported && s.exportNames.includes(name));
    if (declared) return { node: { file, symbol: declared }, path, via: [] };
    for (const imp of this.imports(file.id)) {
      if (imp.resolution !== 'resolved' || imp.resolvedPath === null) continue;
      if (imp.kind === 'reexport') {
        const binding = imp.bindings.find((b) => b.local === name);
        if (!binding) continue;
        const hit = this.resolveExport(imp.resolvedPath, binding.imported, depth + 1, seen);
        if (hit) return { ...hit, via: [path, ...hit.via] };
      }
    }
    if (name === 'default') return null;
    for (const imp of this.imports(file.id)) {
      if (imp.kind !== 'reexport-all' || imp.resolution !== 'resolved' || imp.resolvedPath === null) continue;
      const hit = this.resolveExport(imp.resolvedPath, name, depth + 1, seen);
      if (hit) return { ...hit, via: [path, ...hit.via] };
    }
    return null;
  }

  /** (path, exportName) pairs under which a symbol is reachable, including barrel re-exports. */
  aliasesOf(node: SymbolNode): Array<{ path: string; name: string }> {
    const out: Array<{ path: string; name: string }> = [];
    const seen = new Set<string>();
    const queue = node.symbol.exportNames.map((name) => ({ path: node.file.path, name, depth: 0 }));
    while (queue.length > 0) {
      const item = queue.shift() as { path: string; name: string; depth: number };
      const key = `${item.path}#${item.name}`;
      if (seen.has(key) || item.depth > MAX_DEPTH) continue;
      seen.add(key);
      out.push({ path: item.path, name: item.name });
      for (const imp of this.store.importersOf(item.path)) {
        if (imp.kind === 'reexport') {
          for (const b of imp.bindings) if (b.imported === item.name) queue.push({ path: imp.path, name: b.local, depth: item.depth + 1 });
        } else if (imp.kind === 'reexport-all' && item.name !== 'default') {
          queue.push({ path: imp.path, name: item.name, depth: item.depth + 1 });
        }
      }
    }
    return out;
  }

  /** What a symbol uses: same-file symbols (extracted) and imported symbols (resolved through re-exports). */
  calleesOf(node: SymbolNode): { relations: Relation[]; uncertain: Uncertainty[] } {
    const relations: Relation[] = [];
    const uncertain: Uncertainty[] = [];
    const imports = this.imports(node.file.id);
    for (const ref of this.store.refsFrom(node.file.id, node.symbol.ordinal)) {
      if (ref.targetType === 'local') {
        const target = this.node(node.file, ref.targetOrdinal);
        if (target && target.symbol.ordinal !== node.symbol.ordinal) {
          relations.push({ kind: ref.kind, provenance: 'extracted', node: target, path: node.file.path, line: ref.line, count: ref.count });
        }
        continue;
      }
      const imp = imports[ref.targetOrdinal];
      if (!imp) continue;
      const name = ref.targetName ?? '*';
      if (imp.resolution === 'external' || imp.resolution === 'excluded') continue;
      if (imp.resolution !== 'resolved' || imp.resolvedPath === null) {
        uncertain.push({ path: node.file.path, line: imp.line, kind: 'unresolved-import', detail: `import "${imp.spec}" could not be resolved` });
        continue;
      }
      const hit = this.resolveExport(imp.resolvedPath, name);
      if (!hit) {
        uncertain.push({
          path: node.file.path,
          line: ref.line,
          kind: 'missing-export',
          detail: `"${name}" not found among exports of ${imp.resolvedPath}`,
        });
        continue;
      }
      relations.push({
        kind: ref.kind,
        provenance: 'resolved',
        node: hit.node,
        path: hit.node?.file.path ?? hit.path,
        line: ref.line,
        count: ref.count,
        note: hit.via.length > 0 ? `via ${hit.via.join(' > ')}` : undefined,
      });
    }
    return { relations: dedupeRelations(relations), uncertain };
  }

  /** Who uses a symbol: same-file refs (extracted) and importers through every alias (resolved). */
  callersOf(node: SymbolNode, limit = 60): Relation[] {
    const relations: Relation[] = [];
    for (const ref of this.store.refsToLocal(node.file.id, node.symbol.ordinal)) {
      if (ref.fromOrdinal === node.symbol.ordinal) continue;
      const from = ref.fromOrdinal === null ? null : this.node(node.file, ref.fromOrdinal);
      relations.push({ kind: ref.kind, provenance: 'extracted', node: from, path: node.file.path, line: ref.line, count: ref.count });
    }
    for (const alias of this.aliasesOf(node)) {
      for (const imp of this.store.importersOf(alias.path)) {
        if (!USE_KINDS.has(imp.kind)) continue;
        const binding = imp.bindings.find((b) => b.imported === alias.name || b.imported === '*');
        if (!binding && imp.bindings.length > 0) continue;
        const importer = this.file(imp.path);
        if (!importer) continue;
        const refs = this.store.refsToImport(importer.id, imp.ordinal).filter((r) => r.targetName === alias.name);
        if (refs.length === 0 && binding?.imported === alias.name) {
          relations.push({ kind: 'imports', provenance: 'resolved', node: null, path: importer.path, line: imp.line, count: 1 });
        }
        for (const ref of refs) {
          const from = ref.fromOrdinal === null ? null : this.node(importer, ref.fromOrdinal);
          relations.push({ kind: ref.kind, provenance: 'resolved', node: from, path: importer.path, line: ref.line, count: ref.count });
        }
        if (relations.length >= limit) return dedupeRelations(relations);
      }
    }
    return dedupeRelations(relations);
  }

  /** Tests exercising a symbol: resolved references from test files, plus naming-convention guesses (heuristic). */
  testsOf(node: SymbolNode): Relation[] {
    const resolved = this.callersOf(node, 200).filter((r) => this.file(r.path)?.isTest === true);
    const tests: Relation[] = resolved.map((r) => ({ ...r, kind: 'tests' as const }));
    const covered = new Set(tests.map((t) => t.path));
    for (const testPath of this.heuristicTestsFor(node.file.path)) {
      if (covered.has(testPath)) continue;
      tests.push({ kind: 'tests', provenance: 'heuristic', node: null, path: testPath, line: 1, count: 1, note: 'naming convention, no import found' });
    }
    return tests;
  }

  /** Test files that import a module (resolved) or match it by naming convention (heuristic). */
  testsOfFile(path: string): Relation[] {
    const out: Relation[] = [];
    const seen = new Set<string>();
    for (const imp of this.store.importersOf(path)) {
      const importer = this.file(imp.path);
      if (!importer?.isTest || seen.has(importer.path)) continue;
      seen.add(importer.path);
      out.push({ kind: 'tests', provenance: 'resolved', node: null, path: importer.path, line: imp.line, count: 1 });
    }
    for (const testPath of this.heuristicTestsFor(path)) {
      if (seen.has(testPath)) continue;
      out.push({ kind: 'tests', provenance: 'heuristic', node: null, path: testPath, line: 1, count: 1, note: 'naming convention, no import found' });
    }
    return out;
  }

  private heuristicTestsFor(path: string): string[] {
    if (!this.testIndex) {
      this.testIndex = new Map();
      for (const file of this.store.allFiles()) {
        if (!file.isTest) continue;
        for (const candidate of testTargetCandidates(file.path)) {
          const list = this.testIndex.get(candidate) ?? [];
          list.push(file.path);
          this.testIndex.set(candidate, list);
        }
      }
    }
    return this.testIndex.get(path) ?? [];
  }

  /** Static-analysis gaps in a file: dynamic imports, computed calls, unresolved specifiers, parse errors. */
  uncertaintiesOf(file: FileRow): Uncertainty[] {
    const out: Uncertainty[] = this.store
      .unresolvedOfFile(file.id)
      .map((u) => ({ path: file.path, line: u.line, kind: u.kind, detail: u.detail }));
    for (const imp of this.imports(file.id)) {
      if (imp.resolution === 'unresolved') {
        out.push({ path: file.path, line: imp.line, kind: 'unresolved-import', detail: `import "${imp.spec}" could not be resolved` });
      }
    }
    return out;
  }
}

function dedupeRelations(relations: Relation[]): Relation[] {
  const seen = new Map<string, Relation>();
  for (const r of relations) {
    const key = `${r.kind}|${r.path}|${r.node?.symbol.ordinal ?? 'file'}|${r.provenance}`;
    const prev = seen.get(key);
    if (prev) seen.set(key, { ...prev, count: prev.count + r.count, line: Math.min(prev.line, r.line) });
    else seen.set(key, r);
  }
  return [...seen.values()];
}
