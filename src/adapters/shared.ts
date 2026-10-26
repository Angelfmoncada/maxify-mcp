/**
 * Small pure helpers shared by every adapter.
 *
 * Line numbers are always 1-based and computed on '\n' boundaries ('\r\n'
 * counts once), which matches splitting the original text on /\r?\n/.
 */
import type { ParsedFile } from '../core/types.js';

/** Split text into lines; a trailing newline does not create an extra empty line. */
export function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Map a character offset to its 1-based line number (binary search over line starts). */
export function createLineIndex(text: string): (pos: number) => number {
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return (pos: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] ?? 0) <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** Cut `value` to at most `max` characters, marking the cut with an ellipsis. */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Give repeated names '~2', '~3' suffixes in order, never colliding with an existing name. */
export function uniqueNames(names: readonly string[]): string[] {
  const used = new Set<string>();
  const counters = new Map<string, number>();
  return names.map((name) => {
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
    let n = (counters.get(name) ?? 1) + 1;
    while (used.has(`${name}~${n}`)) n++;
    counters.set(name, n);
    const unique = `${name}~${n}`;
    used.add(unique);
    return unique;
  });
}

/** Lowercase file name of a POSIX (or Windows) relative path. */
export function baseName(relPath: string): string {
  const normalized = relPath.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase();
}

/** Lowercase extension including the dot ('' when there is none or for dotfiles). */
export function extensionOf(relPath: string): string {
  const base = baseName(relPath);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot);
}

export function emptyParsedFile(language: string, isTest: boolean): ParsedFile {
  return { language, isTest, symbols: [], imports: [], refs: [], unresolved: [] };
}
