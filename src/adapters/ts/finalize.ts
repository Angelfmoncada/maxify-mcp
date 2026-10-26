/**
 * Turns drafts into the final, ordered ParsedSymbol list (document order,
 * parents before children, '~N' de-duplicated qualNames, merged export
 * information) and builds the lookup tables the reference walker needs.
 */
import ts from 'typescript';
import type { ParsedImport, ParsedSymbol, SymbolKind } from '../../core/types.js';
import { uniqueNames } from '../shared.js';
import { orderFlags, type SymbolDraft } from './drafts.js';
import type { ExportMark } from './exports.js';
import type { ImportDraft } from './imports.js';
import type { RefIndex } from './refs.js';
import type { Binding, ImportRef, Scope } from './scopes.js';
import { lastLine, type TsSource } from './source.js';

const TYPE_KINDS = new Set<SymbolKind>(['interface', 'type', 'class', 'enum', 'namespace']);
const VALUE_KINDS = new Set<SymbolKind>(['function', 'class', 'variable', 'enum', 'namespace', 'component', 'hook']);

export interface FinalSymbols {
  readonly symbols: ParsedSymbol[];
  /** Drafts in final order (index i describes symbols[i]). */
  readonly ordered: readonly SymbolDraft[];
  readonly indexOf: ReadonlyMap<SymbolDraft, number>;
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function finalizeSymbols(
  src: TsSource,
  drafts: readonly SymbolDraft[],
  marks: ReadonlyMap<SymbolDraft, ExportMark>,
): FinalSymbols {
  const ordered = [...drafts].sort((a, b) => a.start - b.start || b.end - a.end || a.seq - b.seq);
  const indexOf = new Map(ordered.map((draft, index) => [draft, index] as const));
  const quals = uniqueNames(ordered.map((draft) => draft.qual));
  const symbols = ordered.map((draft, index): ParsedSymbol => {
    const mark = marks.get(draft);
    const exportNames = dedupe([...draft.exportNames, ...(mark?.names ?? [])]);
    const defaultFlag = exportNames.includes('default') ? ['default-export'] : [];
    return {
      name: draft.name,
      qualName: quals[index] ?? draft.qual,
      kind: draft.kind,
      span: { startLine: src.line(draft.start), endLine: lastLine(src, draft.start, draft.end) },
      exported: exportNames.length > 0,
      exportNames,
      signature: draft.signature,
      doc: draft.doc,
      parent: draft.parent ? (indexOf.get(draft.parent) ?? null) : null,
      flags: orderFlags([...draft.flags, ...(mark?.flags ?? []), ...defaultFlag]),
    };
  });
  return { symbols, ordered, indexOf };
}

export interface FinalImports {
  readonly imports: ParsedImport[];
  /** require()/import() calls and import type nodes -> import index. */
  readonly nodeToImport: ReadonlyMap<ts.Node, number>;
  readonly moduleImports: ReadonlyMap<string, ImportRef>;
}

export function finalizeImports(drafts: readonly ImportDraft[]): FinalImports {
  const ordered = drafts
    .map((draft, seq) => ({ draft, seq }))
    .sort((a, b) => a.draft.pos - b.draft.pos || a.seq - b.seq)
    .map(({ draft }) => draft);
  const nodeToImport = new Map<ts.Node, number>();
  const moduleImports = new Map<string, ImportRef>();
  ordered.forEach((draft, importIndex) => {
    if (draft.node) nodeToImport.set(draft.node, importIndex);
    if (!draft.topLevel) return;
    for (const binding of draft.bindings) {
      if (binding.local !== '' && !moduleImports.has(binding.local)) {
        moduleImports.set(binding.local, { importIndex, imported: binding.imported });
      }
    }
  });
  const imports = ordered.map(({ spec, kind, bindings, line }) => ({ spec, kind, bindings: [...bindings], line }));
  return { imports, nodeToImport, moduleImports };
}

function membersBySymbol(final: FinalSymbols): Map<number, Map<string, number>> {
  const members = new Map<number, Map<string, number>>();
  final.symbols.forEach((symbol, index) => {
    if (symbol.parent === null || symbol.kind === 'constructor') return;
    const map = members.get(symbol.parent) ?? new Map<string, number>();
    if (!map.has(symbol.name)) map.set(symbol.name, index);
    members.set(symbol.parent, map);
  });
  return members;
}

function thisContexts(final: FinalSymbols, members: Map<number, Map<string, number>>): Map<ts.Node, ReadonlyMap<string, number>> {
  const thisMaps = new Map<ts.Node, ReadonlyMap<string, number>>();
  final.ordered.forEach((draft, index) => {
    const container = draft.container;
    if (!container || !(ts.isClassLike(container) || ts.isObjectLiteralExpression(container))) return;
    const map = members.get(index) ?? new Map<string, number>();
    thisMaps.set(container, map);
    if (!ts.isObjectLiteralExpression(container)) return;
    for (const property of container.properties) {
      if (ts.isPropertyAssignment(property) && ts.isFunctionExpression(property.initializer)) {
        thisMaps.set(property.initializer, map);
      }
    }
  });
  return thisMaps;
}

function namespaceScopes(final: FinalSymbols, members: Map<number, Map<string, number>>): Map<ts.Node, Scope> {
  const scopes = new Map<ts.Node, Scope>();
  final.ordered.forEach((draft, index) => {
    if (draft.kind !== 'namespace' || !draft.container) return;
    const scope = new Map<string, Binding>();
    for (const [name, symbol] of members.get(index) ?? []) scope.set(name, { kind: 'symbol', symbol });
    scopes.set(draft.container, scope);
  });
  return scopes;
}

function topLevelNames(final: FinalSymbols, kinds: ReadonlySet<SymbolKind>): Map<string, number> {
  const names = new Map<string, number>();
  final.ordered.forEach((draft, index) => {
    if (draft.parent === null && draft.binds && kinds.has(draft.kind) && !names.has(draft.name)) names.set(draft.name, index);
  });
  return names;
}

/** CommonJS export names (not 'default') of top-level symbols, for `exports.x` accesses. */
function commonJsExports(final: FinalSymbols): Map<string, number> {
  const byName = new Map<string, number>();
  final.symbols.forEach((symbol, index) => {
    if (symbol.parent !== null || !symbol.flags.includes('commonjs')) return;
    for (const name of symbol.exportNames) if (name !== 'default' && !byName.has(name)) byName.set(name, index);
  });
  return byName;
}

/** Lookup tables for the reference walker. */
export function buildRefIndex(final: FinalSymbols, imports: FinalImports): RefIndex {
  const nodeToSymbol = new Map<ts.Node, number>();
  final.ordered.forEach((draft, index) => {
    for (const node of draft.nodes) if (!nodeToSymbol.has(node)) nodeToSymbol.set(node, index);
  });
  const members = membersBySymbol(final);
  return {
    imports: imports.imports,
    nodeToImport: imports.nodeToImport,
    moduleImports: imports.moduleImports,
    nodeToSymbol,
    members,
    thisMaps: thisContexts(final, members),
    namespaceScopes: namespaceScopes(final, members),
    valueNames: topLevelNames(final, VALUE_KINDS),
    typeNames: topLevelNames(final, TYPE_KINDS),
    cjsExports: commonJsExports(final),
  };
}
