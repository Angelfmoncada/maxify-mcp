/**
 * Markdown / MDX adapter: one 'section' per heading (ATX or setext, never
 * inside fenced code), nested by level, plus relative link targets as
 * imports (and ESM imports in MDX). No references.
 */
import type { LanguageAdapter, ParsedFile, ParsedImport, ParsedSymbol } from '../core/types.js';
import { linkTargets, firstParagraph, relativeTarget, scanMarkdown, type Heading, type MarkdownStructure } from './markdown-scan.js';
import { emptyParsedFile, extensionOf, splitLines, truncate, uniqueNames } from './shared.js';

const DOC_LIMIT = 300;
const MDX_IMPORT = /^\s*(?:import|export)\b[^'"]*?(?:\bfrom\s*)?['"]([^'"]+)['"]/;

interface SectionDraft {
  readonly heading: Heading;
  readonly path: readonly string[];
  readonly parent: number | null;
  readonly endLine: number;
}

/** Nest headings by level: a section ends before the next heading of the same or a higher level. */
function sectionDrafts(headings: readonly Heading[], lineCount: number): SectionDraft[] {
  const ends = headings.map(() => lineCount);
  const parents: Array<number | null> = [];
  const open: number[] = [];
  headings.forEach((heading, index) => {
    for (let top = open.at(-1); top !== undefined && (headings[top]?.level ?? 0) >= heading.level; top = open.at(-1)) {
      ends[top] = heading.line - 1;
      open.pop();
    }
    parents.push(open.at(-1) ?? null);
    open.push(index);
  });
  const paths: string[][] = [];
  headings.forEach((heading, index) => {
    const parent = parents[index] ?? null;
    paths.push([...(parent === null ? [] : (paths[parent] ?? [])), heading.text]);
  });
  return headings.map((heading, index) => ({
    heading,
    path: paths[index] ?? [heading.text],
    parent: parents[index] ?? null,
    endLine: ends[index] ?? lineCount,
  }));
}

function sections(lines: readonly string[], structure: MarkdownStructure): ParsedSymbol[] {
  const drafts = sectionDrafts(structure.headings, lines.length);
  const quals = uniqueNames(drafts.map((d) => d.path.join(' > ')));
  return drafts.map((draft, index): ParsedSymbol => {
    const startLine = draft.heading.line;
    const endLine = Math.max(startLine, draft.endLine);
    const doc = firstParagraph(lines, structure, draft.heading.bodyLine, endLine);
    return {
      name: draft.heading.text,
      qualName: quals[index] ?? draft.path.join(' > '),
      kind: 'section',
      span: { startLine, endLine },
      exported: false,
      exportNames: [],
      signature: draft.path.join(' > '),
      doc: truncate(doc, DOC_LIMIT),
      parent: draft.parent,
      flags: [`h${draft.heading.level}`],
    };
  });
}

function linkImports(lines: readonly string[], structure: MarkdownStructure, isMdx: boolean): ParsedImport[] {
  const seen = new Set<string>();
  const imports: ParsedImport[] = [];
  const add = (spec: string, line: number): void => {
    if (seen.has(spec)) return;
    seen.add(spec);
    imports.push({ spec, kind: 'import', bindings: [], line });
  };
  lines.forEach((text, index) => {
    if (structure.codeLines[index]) return;
    const mdx = isMdx ? MDX_IMPORT.exec(text)?.[1] : undefined;
    if (mdx) add(mdx, index + 1);
    for (const raw of linkTargets(text)) {
      const spec = relativeTarget(raw);
      if (spec !== null) add(spec, index + 1);
    }
  });
  return imports;
}

function parse(relPath: string, text: string): ParsedFile {
  const isMdx = extensionOf(relPath) === '.mdx';
  const lines = splitLines(text);
  const structure = scanMarkdown(lines);
  return {
    ...emptyParsedFile(isMdx ? 'mdx' : 'markdown', false),
    symbols: sections(lines, structure),
    imports: linkImports(lines, structure, isMdx),
  };
}

export const markdownAdapter: LanguageAdapter = {
  id: 'markdown',
  extensions: ['.md', '.mdx', '.markdown'],
  parse,
};
