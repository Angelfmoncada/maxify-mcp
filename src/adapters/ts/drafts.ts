/**
 * Symbol drafts: the adapter-internal form of a symbol before ordering,
 * qualName de-duplication and export merging turn it into a ParsedSymbol.
 */
import type ts from 'typescript';
import type { SymbolKind } from '../../core/types.js';

export interface SymbolDraft {
  readonly name: string;
  /** qualName before '~N' de-duplication. */
  readonly qual: string;
  readonly kind: SymbolKind;
  /** Half-open character range of the full span (JSDoc and decorators included). */
  readonly start: number;
  readonly end: number;
  readonly signature: string;
  readonly doc: string;
  readonly flags: readonly string[];
  /** Export names known at declaration time (`export` modifiers, CommonJS assignments). */
  readonly exportNames: readonly string[];
  readonly parent: SymbolDraft | null;
  /** Syntax nodes whose subtrees belong to this symbol (for ref attribution). */
  readonly nodes: readonly ts.Node[];
  /** Class or object-literal node whose members are this symbol's children (`this.x` context). */
  readonly container: ts.Node | null;
  /** True when `name` is a binding in the scope that declares it (bare identifiers can refer to it). */
  readonly binds: boolean;
  /** Creation order; tie-breaker for symbols starting at the same offset. */
  readonly seq: number;
}

export type DraftInput = Omit<SymbolDraft, 'seq' | 'qual' | 'flags' | 'exportNames' | 'container' | 'binds' | 'doc'> & {
  readonly qual?: string;
  readonly doc?: string;
  readonly flags?: readonly string[];
  readonly exportNames?: readonly string[];
  readonly container?: ts.Node | null;
  readonly binds?: boolean;
};

/** Collects drafts in creation order and stamps them with a sequence number. */
export interface DraftSink {
  readonly drafts: readonly SymbolDraft[];
  add(input: DraftInput): SymbolDraft;
}

export function qualFor(parent: SymbolDraft | null, name: string, separator = '.'): string {
  return parent ? `${parent.qual}${separator}${name}` : name;
}

export function createDraftSink(): DraftSink {
  const drafts: SymbolDraft[] = [];
  return {
    drafts,
    add(input: DraftInput): SymbolDraft {
      const draft: SymbolDraft = {
        ...input,
        qual: input.qual ?? qualFor(input.parent, input.name),
        doc: input.doc ?? '',
        flags: input.flags ?? [],
        exportNames: input.exportNames ?? [],
        container: input.container ?? null,
        binds: input.binds ?? false,
        seq: drafts.length,
      };
      drafts.push(draft);
      return draft;
    },
  };
}

const FLAG_ORDER = [
  'async',
  'generator',
  'abstract',
  'static',
  'private',
  'protected',
  'readonly',
  'declare',
  'get',
  'set',
  'default-export',
  'export-equals',
  'commonjs',
  'jsx',
  'deprecated',
];

/** De-duplicate flags and order them canonically (unknown flags last, alphabetically). */
export function orderFlags(flags: Iterable<string>): string[] {
  const unique = [...new Set(flags)];
  const rank = (flag: string): number => {
    const index = FLAG_ORDER.indexOf(flag);
    return index === -1 ? FLAG_ORDER.length : index;
  };
  return unique.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/** Push `flag` into a flag list when `condition` holds (returns a new array). */
export function withFlag(flags: readonly string[], flag: string, condition: boolean): readonly string[] {
  return condition ? [...flags, flag] : flags;
}
