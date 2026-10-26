/**
 * Shared model for line-based kinds (log, text, test): each original line gets
 * a critical priority, a candidate tier, an omission reason and an optional
 * repeat group. `fitLines` (fit.ts) turns a plan into a budgeted body.
 */

/** Tier value for lines that are never shown verbatim on their own (summarized/counted). */
export const NEVER = 255;

export interface ReasonLabel {
  one: string;
  many: string;
}

/** Shared reason codes; kinds append their own labels after BASE_LABELS. */
export const R_OTHER = 0;
export const R_REPEAT = 1;
export const R_BLANK = 2;
export const R_CRITICAL = 3;
export const R_LIBFRAME = 4;
export const R_WARNING = 5;

export const BASE_LABELS: readonly ReasonLabel[] = [
  { one: 'other line', many: 'other lines' },
  { one: 'repeated line', many: 'repeated lines' },
  { one: 'blank line', many: 'blank lines' },
  { one: 'critical line (see incomplete note)', many: 'critical lines (see incomplete note)' },
  { one: 'library/runtime stack frame', many: 'library/runtime stack frames' },
  { one: 'warning line beyond the cap', many: 'warning lines beyond the cap' },
];

export interface RepeatGroup {
  /** 0-based index of the first occurrence (shown with the repeat marker). */
  first: number;
  last: number;
  count: number;
  identical: boolean;
  /** Member locations, e.g. "L40-L351" or "between L40 and L900 (non-consecutive)". */
  where: string;
  /** "identical" or "differing only in numbers/ids/timestamps". */
  how: string;
}

/** A text that must appear verbatim in the output. */
export interface Critical {
  text: string;
  /** 1-based original line of the first occurrence. */
  line: number;
  /** 1 = failure headers/messages and summaries, 2 = details/focus, 3 = stack frames. */
  priority: number;
  /** Matched as a substring (JSON values) instead of a whole output line. */
  inline?: boolean;
}

export interface LinePlan {
  lines: readonly string[];
  /** Critical priority per line, 0 = not critical. */
  crit: Uint8Array;
  /** Candidate tier per line (lower = earlier); NEVER = only counted. */
  tier: Uint8Array;
  /** Tie-break inside a tier (lower first). */
  order: Float64Array;
  reason: Uint8Array;
  labels: readonly ReasonLabel[];
  /** Repeat group per line, -1 = none. */
  groupOf: Int32Array;
  groups: readonly RepeatGroup[];
  /** Derived `summary:` lines for the final selection (1 = shown). */
  summarize: (selected: Uint8Array) => string[];
  /** Whether the plan aggregates lossily (template groups, per-file counts). */
  lossy: boolean;
  notes: string[];
}

/** Distance of each line to the nearest line flagged in `near` (n when none). */
export function distanceTo(near: (i: number) => boolean, n: number): Float64Array {
  const dist = new Float64Array(n).fill(n);
  let last = -1;
  for (let i = 0; i < n; i++) {
    if (near(i)) last = i;
    if (last >= 0) dist[i] = i - last;
  }
  last = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (near(i)) last = i;
    if (last >= 0) dist[i] = Math.min(dist[i] ?? n, last - i);
  }
  return dist;
}
