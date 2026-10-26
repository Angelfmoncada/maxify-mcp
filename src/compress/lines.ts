/**
 * Line splitting and lossless format cleaning.
 *
 * Line i of the result is ORIGINAL line i+1 (split on /\r?\n/); a single
 * trailing newline does not create an extra empty line. Cleaning never moves
 * text between lines, so line numbers stay exact.
 */

// OSC (… BEL | ST), CSI, C1 CSI, charset selection, other 2-char escapes, stray ESC.
const ANSI =
  /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-?]*[ -/]*[@-~]|\u009b[0-?]*[ -/]*[@-~]|\u001b[()#][0-9A-Za-z]|\u001b[@-Z\\-_]|\u001b/g;

export interface Prepared {
  /** Cleaned text of each original line. */
  lines: string[];
  ansiLines: number;
  /** \r-overwritten states dropped (progress redraws). */
  redraws: number;
  trimmedLines: number;
  /** True when any line differs from the original. */
  changed: boolean;
}

export interface PrepareOptions {
  /** Strip trailing whitespace (off for diffs, where it is content). */
  trimTrailing: boolean;
  /**
   * Called for each overwritten \r segment; when it returns true the whole
   * line is kept with its \r characters so the segment is not lost.
   */
  keepSegment?: (segment: string) => boolean;
}

export function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const parts = text.split(/\r?\n/);
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

export function stripAnsi(text: string): string {
  return text.indexOf('\u001b') >= 0 || text.indexOf('\u009b') >= 0 ? text.replace(ANSI, '') : text;
}

export function prepare(text: string, opts: PrepareOptions): Prepared {
  const raw = splitLines(text);
  const lines = new Array<string>(raw.length);
  let ansiLines = 0;
  let redraws = 0;
  let trimmedLines = 0;
  let changed = false;
  for (let i = 0; i < raw.length; i++) {
    const original = raw[i] ?? '';
    let line = stripAnsi(original);
    if (line !== original) ansiLines++;
    if (line.indexOf('\r') >= 0) {
      const collapsed = collapseRedraws(line, opts.keepSegment);
      redraws += collapsed.dropped;
      line = collapsed.text;
    }
    if (opts.trimTrailing) {
      const trimmed = line.trimEnd();
      if (trimmed.length !== line.length) trimmedLines++;
      line = trimmed;
    }
    if (line !== original) changed = true;
    lines[i] = line;
  }
  return { lines, ansiLines, redraws, trimmedLines, changed };
}

/** Keeps the last visible state of a \r-redrawn line (terminal semantics for progress bars). */
function collapseRedraws(
  line: string,
  keepSegment: ((segment: string) => boolean) | undefined,
): { text: string; dropped: number } {
  const segments = line.split('\r').filter((s) => s.trim().length > 0);
  if (segments.length === 0) return { text: '', dropped: 0 };
  const last = segments[segments.length - 1] ?? '';
  if (keepSegment !== undefined) {
    for (let i = 0; i < segments.length - 1; i++) {
      if (keepSegment(segments[i] ?? '')) return { text: line, dropped: 0 };
    }
  }
  return { text: last, dropped: segments.length - 1 };
}

/** Text used to verify that critical lines survived: ANSI stripped, \r treated as a line break. */
export function verificationLines(text: string): Set<string> {
  const set = new Set<string>();
  for (const line of stripAnsi(text).split(/\r?\n/)) {
    set.add(line);
    set.add(line.trimEnd());
  }
  return set;
}
