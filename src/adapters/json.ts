/**
 * JSON adapter (.json, .jsonc; comments and trailing commas tolerated).
 * Top-level keys become 'key' symbols with exact line spans (positions from
 * `ts.parseJsonText`). package.json also gets nested keys for scripts, bin
 * and exports entries; tsconfig/jsconfig files get compilerOptions.paths
 * entries. Non-object roots fall back to text chunks.
 */
import ts from 'typescript';
import type { LanguageAdapter, ParsedFile, ParsedSymbol } from '../core/types.js';
import { baseName, createLineIndex, emptyParsedFile, splitLines, truncate, uniqueNames } from './shared.js';
import { chunkSymbols } from './text.js';
import { normalizeCode } from './ts/normalize.js';

const SIGNATURE_LIMIT = 100;
const SCRIPT_LIMIT = 300;
const DEEP_LINE_LIMIT = 2000;
const PACKAGE_NESTED = new Set(['scripts', 'bin', 'exports']);

interface KeyDraft {
  readonly name: string;
  readonly qual: string;
  readonly node: ts.PropertyAssignment;
  readonly parent: number | null;
  readonly limit: number;
}

function keyName(name: ts.PropertyName): string | null {
  if (ts.isStringLiteral(name) || ts.isIdentifier(name) || ts.isNumericLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) {
    return name.text;
  }
  return null;
}

function properties(obj: ts.ObjectLiteralExpression): ts.PropertyAssignment[] {
  return obj.properties.filter((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && keyName(p.name) !== null);
}

/** `{ a, b, … +N }`: as many key names as fit within `limit` characters. */
function objectSummary(head: string, keys: readonly string[], limit: number): string {
  const all = `${head}{ ${keys.join(', ')} }`;
  if (all.length <= limit) return all;
  const shown: string[] = [];
  let length = head.length + 2;
  for (const key of keys) {
    const tail = ` … +${keys.length - shown.length - 1} }`.length;
    if (length + key.length + 2 + tail > limit) break;
    shown.push(key);
    length += key.length + 2;
  }
  return truncate(`${head}{ ${shown.map((key) => `${key}, `).join('')}… +${keys.length - shown.length} }`, limit);
}

/** `"key": <value>` when short enough, else a summary (key names of objects, size of arrays, cut strings). */
function keySignature(text: string, sf: ts.JsonSourceFile, node: ts.PropertyAssignment, name: string, limit: number): string {
  const head = `${JSON.stringify(name)}: `;
  const value = node.initializer;
  const start = value.getStart(sf);
  const end = Math.min(value.end, start + limit * 3);
  const preview = `${head}${normalizeCode(text.slice(start, end))}`;
  if (end === value.end && preview.length <= limit) return preview;
  if (ts.isObjectLiteralExpression(value)) {
    return objectSummary(head, properties(value).map((p) => keyName(p.name) ?? ''), limit);
  }
  if (ts.isArrayLiteralExpression(value)) return truncate(`${head}[ ${value.elements.length} items ]`, limit);
  return truncate(preview, limit);
}

function childKeys(drafts: KeyDraft[], parentIndex: number, parentQual: string, obj: ts.Expression, limit = SIGNATURE_LIMIT): void {
  if (!ts.isObjectLiteralExpression(obj)) return;
  for (const property of properties(obj)) {
    const name = keyName(property.name) ?? '';
    drafts.push({ name, qual: `${parentQual}.${name}`, node: property, parent: parentIndex, limit });
  }
}

function isTsconfig(file: string): boolean {
  return /^(tsconfig|jsconfig)(\..+)?\.json$/.test(file);
}

function keyDrafts(relPath: string, root: ts.ObjectLiteralExpression, deep: boolean): KeyDraft[] {
  const drafts: KeyDraft[] = [];
  const file = baseName(relPath);
  for (const property of properties(root)) {
    const name = keyName(property.name) ?? '';
    const index = drafts.length;
    drafts.push({ name, qual: name, node: property, parent: null, limit: SIGNATURE_LIMIT });
    if (!deep) continue;
    if (file === 'package.json' && PACKAGE_NESTED.has(name)) {
      childKeys(drafts, index, name, property.initializer, name === 'scripts' ? SCRIPT_LIMIT : SIGNATURE_LIMIT);
    }
    if (isTsconfig(file) && name === 'compilerOptions' && ts.isObjectLiteralExpression(property.initializer)) {
      const paths = properties(property.initializer).find((p) => keyName(p.name) === 'paths');
      if (!paths) continue;
      const pathsIndex = drafts.length;
      drafts.push({ name: 'paths', qual: 'compilerOptions.paths', node: paths, parent: index, limit: SIGNATURE_LIMIT });
      childKeys(drafts, pathsIndex, 'compilerOptions.paths', paths.initializer);
    }
  }
  return drafts;
}

function parseError(sf: ts.JsonSourceFile, line: (pos: number) => number): ParsedFile['unresolved'] {
  const diagnostics: unknown = (sf as unknown as { parseDiagnostics?: unknown }).parseDiagnostics;
  if (!Array.isArray(diagnostics) || diagnostics.length === 0) return [];
  const first = diagnostics[0] as { messageText?: unknown; start?: unknown } | undefined;
  const message = typeof first?.messageText === 'string' ? first.messageText : 'Invalid JSON';
  return [{ line: typeof first?.start === 'number' ? line(first.start) : 1, kind: 'parse-error', detail: truncate(message, 160) }];
}

function parse(relPath: string, text: string): ParsedFile {
  const empty = emptyParsedFile('json', false);
  if (text.trim() === '') return empty;
  const sf = ts.parseJsonText(relPath, text);
  const line = createLineIndex(text);
  const errors = parseError(sf, line);
  if (errors.length > 0) return { ...empty, unresolved: errors };
  const statement = sf.statements[0];
  const root = statement && ts.isExpressionStatement(statement) ? statement.expression : undefined;
  if (!root || !ts.isObjectLiteralExpression(root)) return { ...empty, symbols: chunkSymbols(splitLines(text)) };
  const deep = line(text.length) <= DEEP_LINE_LIMIT;
  const drafts = keyDrafts(relPath, root, deep);
  const quals = uniqueNames(drafts.map((d) => d.qual));
  const symbols = drafts.map((draft, index): ParsedSymbol => {
    const start = draft.node.getStart(sf);
    return {
      name: draft.name,
      qualName: quals[index] ?? draft.qual,
      kind: 'key',
      span: { startLine: line(start), endLine: line(Math.max(start, draft.node.end - 1)) },
      exported: false,
      exportNames: [],
      signature: keySignature(text, sf, draft.node, draft.name, draft.limit),
      doc: '',
      parent: draft.parent,
      flags: [],
    };
  });
  return { ...empty, symbols };
}

export const jsonAdapter: LanguageAdapter = {
  id: 'json',
  extensions: ['.json', '.jsonc'],
  fileNames: ['package.json', 'tsconfig.json', 'jsconfig.json'],
  parse,
};
