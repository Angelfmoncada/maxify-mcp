import path from 'node:path';
import type { ParsedFile, ParsedSymbol } from '../core/types.js';
import type { FtsDoc } from '../store/index-store.js';
import { identifierTerms, pathTerms } from './terms.js';

const MAX_BODY_CHARS = 16_000;

/**
 * Text a symbol owns: its span minus the spans of its direct children, so a
 * class or a Markdown section is not indexed twice through its members.
 */
function ownText(lines: readonly string[], symbol: ParsedSymbol, children: readonly ParsedSymbol[]): string {
  const excluded = new Set<number>();
  for (const child of children) {
    for (let line = child.span.startLine; line <= child.span.endLine; line++) excluded.add(line);
  }
  const out: string[] = [];
  let size = 0;
  for (let line = symbol.span.startLine; line <= symbol.span.endLine && size < MAX_BODY_CHARS; line++) {
    if (excluded.has(line)) continue;
    const text = lines[line - 1] ?? '';
    out.push(text);
    size += text.length + 1;
  }
  return out.join('\n').slice(0, MAX_BODY_CHARS);
}

/** Build one FTS document per parsed symbol plus a file-level document. */
export function buildFtsDocs(relPath: string, text: string, parsed: ParsedFile): { docs: FtsDoc[]; fileDoc: FtsDoc } {
  const lines = text.split(/\r?\n/);
  const childrenOf = new Map<number, ParsedSymbol[]>();
  parsed.symbols.forEach((s) => {
    if (s.parent === null) return;
    const list = childrenOf.get(s.parent) ?? [];
    list.push(s);
    childrenOf.set(s.parent, list);
  });
  const pathText = `${relPath} ${pathTerms(relPath)}`;
  const docs = parsed.symbols.map((symbol, index): FtsDoc => ({
    path: pathText,
    name: symbol.name,
    terms: identifierTerms([symbol.name, symbol.qualName, ...symbol.exportNames]),
    signature: symbol.signature,
    doc: symbol.doc,
    body: ownText(lines, symbol, childrenOf.get(index) ?? []),
  }));
  return { docs, fileDoc: fileOnlyDoc(relPath) };
}

export function fileOnlyDoc(relPath: string): FtsDoc {
  return {
    path: `${relPath} ${pathTerms(relPath)}`,
    name: path.posix.basename(relPath),
    terms: pathTerms(path.posix.basename(relPath)),
    signature: '',
    doc: '',
    body: '',
  };
}
