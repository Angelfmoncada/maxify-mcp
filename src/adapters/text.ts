/**
 * Fallback adapter for text files without a structural parser: consecutive
 * 'chunk' symbols of up to 60 lines, preferring to end a chunk at a blank
 * line found within the last 15 lines of the window.
 */
import type { LanguageAdapter, ParsedFile, ParsedSymbol } from '../core/types.js';
import { emptyParsedFile, extensionOf, splitLines, truncate } from './shared.js';

export const TEXT_EXTENSIONS: readonly string[] = [
  '.css',
  '.scss',
  '.less',
  '.html',
  '.yml',
  '.yaml',
  '.toml',
  '.ini',
  '.sh',
  '.bash',
  '.ps1',
  '.sql',
  '.graphql',
  '.gql',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.rb',
  '.php',
  '.c',
  '.h',
  '.cpp',
  '.cs',
  '.swift',
  '.vue',
  '.svelte',
  '.txt',
  '.xml',
];

const WINDOW_LINES = 60;
const BLANK_LOOKBACK = 15;
const SIGNATURE_LIMIT = 100;

export interface LineChunk {
  readonly startLine: number;
  readonly endLine: number;
}

function isBlank(line: string | undefined): boolean {
  return line === undefined || line.trim() === '';
}

/** Split lines into windows of at most `window` lines (1-based, inclusive), skipping all-blank windows. */
export function chunkLines(lines: readonly string[], window = WINDOW_LINES, lookback = BLANK_LOOKBACK): LineChunk[] {
  const chunks: LineChunk[] = [];
  let start = 1;
  while (start <= lines.length) {
    let end = Math.min(start + window - 1, lines.length);
    if (end < lines.length) {
      for (let line = end; line > Math.max(start, end - lookback); line--) {
        if (isBlank(lines[line - 1])) {
          end = line;
          break;
        }
      }
    }
    if (lines.slice(start - 1, end).some((line) => !isBlank(line))) chunks.push({ startLine: start, endLine: end });
    start = end + 1;
  }
  return chunks;
}

/** 'chunk' symbols for the given lines. */
export function chunkSymbols(lines: readonly string[]): ParsedSymbol[] {
  return chunkLines(lines).map(({ startLine, endLine }) => {
    const firstText = lines.slice(startLine - 1, endLine).find((line) => !isBlank(line)) ?? '';
    const name = `L${startLine}-${endLine}`;
    return {
      name,
      qualName: name,
      kind: 'chunk',
      span: { startLine, endLine },
      exported: false,
      exportNames: [],
      signature: truncate(firstText.trim(), SIGNATURE_LIMIT),
      doc: '',
      parent: null,
      flags: [],
    };
  });
}

function parse(relPath: string, text: string): ParsedFile {
  const language = extensionOf(relPath).replace(/^\./, '');
  return { ...emptyParsedFile(language, false), symbols: chunkSymbols(splitLines(text)) };
}

export const textAdapter: LanguageAdapter = {
  id: 'text',
  extensions: TEXT_EXTENSIONS,
  parse,
};
