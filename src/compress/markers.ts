/**
 * Body format shared by every kind.
 *
 * Lines the compressor writes itself start with the marker prefix "» " (the
 * prefix becomes "»» ", "»»» ", … when the input already has lines starting
 * with "» ", so a marker can never be confused with original content).
 * Every other line is an ORIGINAL line, verbatim after format cleaning
 * (ANSI codes stripped, \r redraws collapsed, trailing spaces trimmed).
 *
 *   summary: …                  derived (lossy) statement; only before the first marker
 *   » L5-L12                    the next 8 lines are original lines 5..12
 *   » L13-L320 omitted: 308 lines (300 passing tests, 8 other lines)
 *   » repeated ×312 at L40-L351, differing only in numbers/ids/timestamps; first occurrence (L40):
 *                               the next line is original line 40
 *   » … (L3, L9-L10):           a marker ending in "(Lrefs):" introduces exactly those original lines
 *   » incomplete: …             critical lines that did not fit the budget, with their line numbers
 *   » anything else             derived structural statement (file/group headers, counts)
 *
 * Line numbers are 1-based lines of the ORIGINAL input (split on /\r?\n/), so
 * any omitted range can be fetched exactly from the stored blob.
 */

export const BASE_MARKER = '»';
const MAX_MARKER_DEPTH = 6;

/** Picks a marker prefix that no original line starts with (followed by a space). */
export function chooseMarker(lines: readonly string[]): string {
  let marker = BASE_MARKER;
  for (let depth = 1; depth < MAX_MARKER_DEPTH; depth++) {
    const probe = `${marker} `;
    if (!lines.some((line) => line.startsWith(probe))) return marker;
    marker += BASE_MARKER;
  }
  return marker;
}

/** "L5" or "L5-L12" (1-based numbers). */
export function lref(first: number, last: number = first): string {
  return last > first ? `L${first}-L${last}` : `L${first}`;
}

export interface CompactRefs {
  /** e.g. "L3-L5, L9, L20-L31" */
  text: string;
  /** False when ranges were merged to stay short (they then also cover other lines). */
  exact: boolean;
  ranges: number;
}

/** Groups sorted ascending 1-based numbers into ranges of consecutive numbers. */
export function toRanges(sorted: readonly number[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const n of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && n <= last[1] + 1) {
      if (n > last[1]) last[1] = n;
    } else {
      out.push([n, n]);
    }
  }
  return out;
}

/**
 * Compact line references. When more than `maxRanges` ranges exist, the
 * smallest gaps are merged (deterministically) so the text stays bounded;
 * `exact` is then false and the ranges also contain non-listed lines.
 */
export function compactRefs(sorted: readonly number[], maxRanges = 24): CompactRefs {
  let ranges = toRanges(sorted);
  let exact = true;
  if (ranges.length > maxRanges && maxRanges >= 1) {
    exact = false;
    ranges = mergeSmallestGaps(ranges, maxRanges);
  }
  return { text: ranges.map(([a, b]) => lref(a, b)).join(', '), exact, ranges: ranges.length };
}

function mergeSmallestGaps(ranges: Array<[number, number]>, maxRanges: number): Array<[number, number]> {
  const gaps = ranges.slice(1).map((r, i) => ({ i, gap: r[0] - (ranges[i]?.[1] ?? r[0]) }));
  // Keep the (maxRanges - 1) largest gaps as split points; ties keep the earlier gap.
  gaps.sort((x, y) => y.gap - x.gap || x.i - y.i);
  const splits = new Set(gaps.slice(0, maxRanges - 1).map((g) => g.i));
  const merged: Array<[number, number]> = [];
  let cur: [number, number] = [ranges[0]?.[0] ?? 0, ranges[0]?.[1] ?? 0];
  for (let i = 1; i < ranges.length; i++) {
    const r = ranges[i];
    if (r === undefined) continue;
    if (splits.has(i - 1)) {
      merged.push(cur);
      cur = [r[0], r[1]];
    } else {
      cur[1] = r[1];
    }
  }
  merged.push(cur);
  return merged;
}

/** "1 line" / "3 lines" style wording. */
export function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * "at L3-L5, L9" for up to `cap` ranges, otherwise "between La and Lb (non-consecutive)".
 * `firstLine`/`lastLine` are the true 1-based extremes (ranges may be truncated).
 */
export function whereText(
  ranges: ReadonlyArray<readonly [number, number]>,
  cap: number,
  overflow: boolean,
  firstLine: number,
  lastLine: number,
): string {
  if (ranges.length === 0) return `at ${lref(firstLine, lastLine)}`;
  if (!overflow && ranges.length <= cap) return `at ${ranges.map(([a, b]) => lref(a, b)).join(', ')}`;
  return `between L${firstLine} and L${lastLine} (non-consecutive)`;
}
