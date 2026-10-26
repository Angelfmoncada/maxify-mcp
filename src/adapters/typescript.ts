/**
 * TypeScript / JavaScript adapter (.ts .tsx .mts .cts .js .jsx .mjs .cjs).
 *
 * Syntax only: `ts.createSourceFile` per file, no Program and no type
 * checker. Emits symbols (declarations, members, components, hooks, tests,
 * module-level blocks), imports, same-file references and unresolved
 * constructs. Parsing never throws: syntax errors become a 'parse-error'
 * record and the partial tree is still analyzed.
 */
import ts from 'typescript';
import type { LanguageAdapter, ParsedFile, ParsedUnresolved } from '../core/types.js';
import { emptyParsedFile, extensionOf, truncate } from './shared.js';
import { isTestPath } from './test-paths.js';
import { collectExports } from './ts/exports.js';
import { buildRefIndex, finalizeImports, finalizeSymbols } from './ts/finalize.js';
import { scanImports } from './ts/imports.js';
import { collectRefs } from './ts/refs.js';
import { createTsSource, type TsSource } from './ts/source.js';
import { collectSymbols } from './ts/symbols.js';

interface Flavor {
  readonly kind: ts.ScriptKind;
  readonly language: 'typescript' | 'javascript';
}

const FLAVORS: Readonly<Record<string, Flavor>> = {
  '.ts': { kind: ts.ScriptKind.TS, language: 'typescript' },
  '.mts': { kind: ts.ScriptKind.TS, language: 'typescript' },
  '.cts': { kind: ts.ScriptKind.TS, language: 'typescript' },
  '.tsx': { kind: ts.ScriptKind.TSX, language: 'typescript' },
  '.js': { kind: ts.ScriptKind.JS, language: 'javascript' },
  '.mjs': { kind: ts.ScriptKind.JS, language: 'javascript' },
  '.cjs': { kind: ts.ScriptKind.JS, language: 'javascript' },
  '.jsx': { kind: ts.ScriptKind.JSX, language: 'javascript' },
};
const DEFAULT_FLAVOR: Flavor = { kind: ts.ScriptKind.TS, language: 'typescript' };
const DETAIL_LIMIT = 160;

function flavorOf(relPath: string): Flavor {
  return FLAVORS[extensionOf(relPath)] ?? DEFAULT_FLAVOR;
}

/** The parser's first syntax diagnostic (internal property, read defensively). */
function parseError(src: TsSource): ParsedUnresolved | null {
  const diagnostics: unknown = (src.sf as unknown as { parseDiagnostics?: unknown }).parseDiagnostics;
  if (!Array.isArray(diagnostics) || diagnostics.length === 0) return null;
  const first: unknown = diagnostics[0];
  if (typeof first !== 'object' || first === null) return null;
  const { messageText, start } = first as { messageText?: unknown; start?: unknown };
  const message =
    typeof messageText === 'string' || (typeof messageText === 'object' && messageText !== null)
      ? ts.flattenDiagnosticMessageText(messageText as string | ts.DiagnosticMessageChain, ' ')
      : 'Syntax error';
  const line = typeof start === 'number' ? src.line(start) : 1;
  return { line, kind: 'parse-error', detail: truncate(message, DETAIL_LIMIT) };
}

function analyze(relPath: string, text: string, flavor: Flavor): ParsedFile {
  const src = createTsSource(relPath, text, flavor.kind, flavor.language === 'javascript');
  const scan = scanImports(src);
  const drafts = collectSymbols(src);
  const exports = collectExports(src, drafts, scan.imports);
  const imports = finalizeImports([...scan.imports, ...exports.reexports]);
  const symbols = finalizeSymbols(src, drafts, exports.marks);
  const refs = collectRefs(src, buildRefIndex(symbols, imports));
  const error = parseError(src);
  return {
    language: flavor.language,
    isTest: isTestPath(relPath),
    symbols: symbols.symbols,
    imports: imports.imports,
    refs,
    unresolved: error ? [error, ...scan.unresolved] : [...scan.unresolved],
  };
}

function failure(relPath: string, flavor: Flavor, error: unknown): ParsedFile {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ...emptyParsedFile(flavor.language, isTestPath(relPath)),
    unresolved: [{ line: 1, kind: 'parse-error', detail: truncate(`analysis failed: ${message}`, DETAIL_LIMIT) }],
  };
}

function parse(relPath: string, text: string): ParsedFile {
  const flavor = flavorOf(relPath);
  try {
    return analyze(relPath, text, flavor);
  } catch (error: unknown) {
    // Pathological input (e.g. nesting deep enough to exhaust the parser's stack) must not crash indexing.
    return failure(relPath, flavor, error);
  }
}

export const typescriptAdapter: LanguageAdapter = {
  id: 'typescript',
  extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
  parse,
};
