import {
  F_BLANK,
  F_FAILURE,
  F_LIBFRAME,
  F_SUMMARY,
  F_WARNING,
  P_DETAIL,
  P_FAILURE,
  lineFlags,
  markCritical,
  markSectionHeaders,
} from '../classify.js';
import { templateGroups } from '../groups.js';
import {
  BASE_LABELS,
  NEVER,
  R_BLANK,
  R_CRITICAL,
  R_LIBFRAME,
  R_OTHER,
  R_REPEAT,
  R_WARNING,
  distanceTo,
  type LinePlan,
} from '../plan.js';

export const HEAD_LINES = 10;
export const TAIL_LINES = 20;
export const WARNING_CAP = 20;

/** Tier-1 ordering: tail first, then head, group firsts, warnings. */
const ORDER_TAIL = 0;
const ORDER_HEAD = 1;
const ORDER_GROUP = 2;
const ORDER_WARNING = 3;

export interface LogLayout {
  tier: Uint8Array;
  order: Float64Array;
  reason: Uint8Array;
}

/**
 * Tiers for log-like lines: context around failures first, then head/tail,
 * repeat-group firsts and capped warnings, then the rest by distance to the
 * nearest critical line. `skip(i)` marks lines a caller already placed.
 */
export function layoutLog(
  lines: readonly string[],
  flags: Uint16Array,
  crit: Uint8Array,
  groupOf: Int32Array,
  firstOf: (g: number) => number,
  lastOf: (g: number) => number,
  skip: (i: number) => boolean = () => false,
): LogLayout {
  const n = lines.length;
  const tier = new Uint8Array(n).fill(NEVER);
  const order = new Float64Array(n);
  const reason = new Uint8Array(n);
  const dist = distanceTo((i) => (crit[i] ?? 0) > 0, n);
  const nearFailure = distanceTo((i) => (crit[i] ?? 0) === P_FAILURE || (crit[i] ?? 0) === P_DETAIL, n);
  let warnings = 0;
  for (let i = 0; i < n; i++) {
    if (skip(i)) continue;
    const f = flags[i] ?? 0;
    const g = groupOf[i] ?? -1;
    if ((crit[i] ?? 0) > 0) reason[i] = R_CRITICAL;
    else if ((f & F_BLANK) !== 0) reason[i] = R_BLANK;
    else if ((f & F_LIBFRAME) !== 0) reason[i] = R_LIBFRAME;
    else if (g >= 0) {
      reason[i] = R_REPEAT;
      if (firstOf(g) === i) [tier[i], order[i]] = [1, ORDER_GROUP];
      else if (lastOf(g) === i) [tier[i], order[i]] = [2, 0];
    } else if ((f & F_WARNING) !== 0 && warnings++ >= WARNING_CAP) {
      reason[i] = R_WARNING;
    } else {
      reason[i] = R_OTHER;
      if ((f & F_WARNING) !== 0) [tier[i], order[i]] = [1, ORDER_WARNING];
      else if ((nearFailure[i] ?? n) <= 2) [tier[i], order[i]] = [0, nearFailure[i] ?? 0];
      else if (i >= n - TAIL_LINES) [tier[i], order[i]] = [1, ORDER_TAIL];
      else if (i < HEAD_LINES) [tier[i], order[i]] = [1, ORDER_HEAD];
      else [tier[i], order[i]] = [3, dist[i] ?? n];
    }
  }
  return { tier, order, reason };
}

export interface FailureCounts {
  lines: number;
  distinct: number;
  first: number;
}

export function countFailures(lines: readonly string[], flags: Uint16Array, include: (i: number) => boolean): FailureCounts {
  let count = 0;
  let first = -1;
  const distinct = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const f = flags[i] ?? 0;
    if ((f & F_FAILURE) === 0 || (f & F_SUMMARY) !== 0 || !include(i)) continue;
    count++;
    if (first < 0) first = i;
    distinct.add(lines[i] ?? '');
  }
  return { lines: count, distinct: distinct.size, first };
}

export function warningSummary(flags: Uint16Array, sel: Uint8Array): string | undefined {
  let total = 0;
  let shown = 0;
  for (let i = 0; i < flags.length; i++) {
    if (((flags[i] ?? 0) & F_WARNING) === 0) continue;
    total++;
    if (sel[i] === 1) shown++;
  }
  if (total === 0 || shown === total) return undefined;
  return `summary: ${total} warning lines; ${shown} shown verbatim, ${total - shown} omitted`;
}

/** Plan for generic logs and plain text. */
export function planLog(lines: readonly string[], focus: readonly string[]): LinePlan {
  const n = lines.length;
  const flags = new Uint16Array(n);
  for (let i = 0; i < n; i++) flags[i] = lineFlags(lines[i] ?? '');
  const crit = markCritical(lines, flags, { focus });
  markSectionHeaders(lines, crit);
  const eligible = (i: number): boolean => (crit[i] ?? 0) === 0 && ((flags[i] ?? 0) & (F_BLANK | F_LIBFRAME)) === 0;
  const { groupOf, groups } = templateGroups(lines, eligible);
  const layout = layoutLog(
    lines,
    flags,
    crit,
    groupOf,
    (g) => groups[g]?.first ?? -1,
    (g) => groups[g]?.last ?? -1,
  );
  const failures = countFailures(lines, flags, () => true);
  const summarize = (sel: Uint8Array): string[] => {
    const out: string[] = [];
    if (failures.lines > 0) {
      out.push(
        `summary: failure markers found: ${failures.lines} lines (${failures.distinct} distinct), first at L${failures.first + 1}`,
      );
    }
    const warn = warningSummary(flags, sel);
    if (warn !== undefined) out.push(warn);
    return out;
  };
  const grouped = groups.reduce((s, g) => s + g.count, 0);
  const notes = groups.length > 0 ? [`${grouped} lines matched ${groups.length} repeated templates`] : [];
  return {
    lines,
    crit,
    tier: layout.tier,
    order: layout.order,
    reason: layout.reason,
    labels: BASE_LABELS,
    groupOf,
    groups,
    summarize,
    lossy: false,
    notes,
  };
}
