/**
 * Language adapter contract.
 *
 * Adapters are pure functions of (relPath, text). They never touch the
 * filesystem, the database or the network, so they are deterministic and
 * trivially testable. Cross-file linking (module resolution, export matching)
 * happens later in the indexer and is tagged with its own provenance.
 */

/** Where a relation comes from. Every edge Maxify reports carries one. */
export type Provenance =
  /** Directly present in the syntax of a single file (declaration, import statement, same-file call). */
  | 'extracted'
  /** Linked across files by static module resolution plus export-name matching. */
  | 'resolved'
  /** Name- or convention-based guess (e.g. foo.test.ts <-> foo.ts without an import). */
  | 'heuristic';

export type SymbolKind =
  | 'function'
  | 'class'
  | 'method'
  | 'constructor'
  | 'accessor'
  | 'property'
  | 'interface'
  | 'type'
  | 'enum'
  | 'namespace'
  | 'variable'
  | 'component'
  | 'hook'
  | 'suite'
  | 'test'
  /** Module-level statements that are not declarations (route registration, side effects). */
  | 'block'
  /** Markdown heading section. */
  | 'section'
  /** Generic text window for files without a structural adapter. */
  | 'chunk'
  /** JSON key (e.g. package.json scripts). */
  | 'key';

/** 1-based, inclusive line range. */
export interface LineSpan {
  startLine: number;
  endLine: number;
}

export interface ParsedSymbol {
  /** Declared name; for tests the literal title; 'default' for anonymous default exports. */
  name: string;
  /**
   * Unique within the file. Members use '.', e.g. 'Session.refresh'.
   * Tests use ' > ', e.g. 'auth > rejects expired token'.
   * Duplicates get a '~2', '~3' suffix in declaration order.
   */
  qualName: string;
  kind: SymbolKind;
  /** Full extent, including leading JSDoc comment and decorators. */
  span: LineSpan;
  /** True if the module exports it (named, default, `export =`, or CommonJS heuristics). */
  exported: boolean;
  /** Names under which it is exported ('default' for a default export). Empty if not exported. */
  exportNames: string[];
  /**
   * Derived contract view without the implementation body, e.g.
   * `export async function requireAuth(req: Request, next: Next): Promise<void>`.
   * Interfaces/types/enums may use their full declaration text. '' when not meaningful.
   */
  signature: string;
  /** Leading doc comment text without comment markers, trimmed, at most ~400 chars. '' if none. */
  doc: string;
  /** Index of the enclosing symbol in ParsedFile.symbols, or null for top level. */
  parent: number | null;
  /** Free-form markers: 'async', 'generator', 'abstract', 'static', 'private', 'default-export', 'commonjs', 'jsx', ... */
  flags: string[];
}

export type ImportKind =
  | 'import'
  | 'import-type'
  | 'side-effect'
  | 'require'
  | 'dynamic-import'
  | 'reexport'
  | 'reexport-all';

export interface ImportBinding {
  /** Name in the source module: an export name, 'default', or '*' (namespace import / export-all). */
  imported: string;
  /** Local binding name ('' when there is none). For re-exports: the name exported from THIS file. */
  local: string;
  typeOnly: boolean;
}

export interface ParsedImport {
  /** Module specifier literal exactly as written. */
  spec: string;
  kind: ImportKind;
  bindings: ImportBinding[];
  line: number;
}

export type RefKind = 'calls' | 'references' | 'renders' | 'uses-type' | 'extends' | 'implements';

export type RefTarget =
  /** A symbol declared in the same file. */
  | { type: 'local'; symbol: number }
  /**
   * A binding imported by this file. `name` is the export name in the target module
   * ('default' allowed). For namespace member access `ns.foo`, name is 'foo'.
   */
  | { type: 'import'; importIndex: number; name: string };

export interface ParsedRef {
  /** Innermost enclosing symbol index, or null for module scope. */
  from: number | null;
  target: RefTarget;
  kind: RefKind;
  /** First line where the reference occurs. */
  line: number;
  /** Number of occurrences merged into this ref (same from/target/kind). */
  count: number;
}

export type UnresolvedKind =
  | 'dynamic-import'
  | 'dynamic-require'
  | 'computed-call'
  | 'eval'
  | 'glob-import'
  | 'commonjs-dynamic'
  | 'parse-error';

/** Something the adapter saw but cannot statically link. Reported to the agent as an uncertainty. */
export interface ParsedUnresolved {
  line: number;
  kind: UnresolvedKind;
  /** Short verbatim excerpt or explanation, at most ~160 chars. */
  detail: string;
}

export interface ParsedFile {
  language: string;
  isTest: boolean;
  symbols: ParsedSymbol[];
  imports: ParsedImport[];
  refs: ParsedRef[];
  unresolved: ParsedUnresolved[];
}

export interface LanguageAdapter {
  readonly id: string;
  /** Lowercase extensions including the dot, e.g. '.ts'. Matched against the file name. */
  readonly extensions: readonly string[];
  /** Optional exact file names (lowercase) this adapter handles, e.g. 'package.json'. */
  readonly fileNames?: readonly string[];
  parse(relPath: string, text: string): ParsedFile;
}
