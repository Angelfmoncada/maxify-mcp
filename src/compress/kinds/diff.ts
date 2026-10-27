import { hasFocus } from '../classify.js';
import { prepare } from '../lines.js';
import { compactRefs, count, lref } from '../markers.js';
import { P_DETAIL } from '../classify.js';
import type { Critical } from '../plan.js';
import { criticalOnly, tokens, type KindContext, type KindOutput } from '../output.js';
import { parseDiff, type DiffFile } from './diff-parse.js';

/** A trimmed context gap is only worth two markers when it costs more than this. */
const GAP_TOKENS = 16;
const PREAMBLE_SHARE = 0.3;
const PARTIAL_SHARE = 0.25;

interface Ctx {
  lines: readonly string[];
  crit: Uint8Array;
  marker: string;
}

function isChange(line: string): boolean {
  const c = line[0];
  return c === '+' || c === '-' || c === '\\';
}

function header(c: Ctx, f: DiffFile, tail: string): string {
  const flags = f.flags.length > 0 ? ` (${f.flags.join(', ')})` : '';
  return `${c.marker} file ${f.path} +${f.adds} -${f.dels}${flags} at ${lref(f.start + 1, f.end + 1)}${tail}`;
}

/** Runs and omission markers for lines [a, b] given a keep predicate. */
function renderSpan(c: Ctx, a: number, b: number, keep: (i: number) => boolean, what: (i: number) => string): string[] {
  const out: string[] = [];
  let i = a;
  while (i <= b) {
    let j = i;
    const kept = keep(i);
    while (j + 1 <= b && keep(j + 1) === kept) j++;
    if (kept) out.push(`${c.marker} ${lref(i + 1, j + 1)}`, ...c.lines.slice(i, j + 1));
    else out.push(`${c.marker} ${lref(i + 1, j + 1)} omitted: ${count(j - i + 1, 'line', 'lines')} (${what(i)})`);
    i = j + 1;
  }
  return out;
}

/** Keep mask for a file body: hunk headers, +/- lines, 1 context line around changes, focus lines. */
function keepMask(c: Ctx, f: DiffFile, hunks: number): Uint8Array {
  const first = f.hunks[0]?.start ?? f.end + 1;
  const mask = new Uint8Array(f.end - first + 1);
  const set = (i: number): void => {
    if (i >= first && i <= f.end) mask[i - first] = 1;
  };
  for (const h of f.hunks.slice(0, hunks)) {
    set(h.start);
    for (let k = h.start + 1; k <= h.end; k++) {
      if (!isChange(c.lines[k] ?? '')) continue;
      set(k - 1);
      set(k);
      set(k + 1);
    }
  }
  for (let k = first; k <= f.end; k++) if ((c.crit[k] ?? 0) > 0) set(k);
  // Bridge cheap gaps inside the shown hunks.
  const lastShown = f.hunks[Math.min(hunks, f.hunks.length) - 1]?.end ?? first - 1;
  let k = first;
  while (k <= lastShown) {
    if (mask[k - first] === 1) {
      k++;
      continue;
    }
    let j = k;
    while (j + 1 <= lastShown && mask[j + 1 - first] !== 1) j++;
    const cost = c.lines.slice(k, j + 1).reduce((s, l) => s + tokens(l) + 1, 0);
    if (cost <= GAP_TOKENS) for (let x = k; x <= j; x++) mask[x - first] = 1;
    k = j + 1;
  }
  return mask;
}

function headerTail(f: DiffFile): string {
  const first = f.hunks[0]?.start ?? f.end + 1;
  if (first <= f.start) return '';
  const n = first - f.start;
  return `; git header ${lref(f.start + 1, first)} (${count(n, 'line', 'lines')}) omitted`;
}

function renderFile(c: Ctx, f: DiffFile, hunks: number): string {
  const out = [header(c, f, headerTail(f))];
  const first = f.hunks[0]?.start;
  out.push(...focusLines(c, f.start, (first ?? f.end + 1) - 1));
  if (first === undefined) return out.join('\n');
  const mask = keepMask(c, f, hunks);
  const shownEnd = hunks >= f.hunks.length ? f.end : (f.hunks[hunks - 1]?.end ?? first);
  out.push(
    ...renderSpan(c, first, shownEnd, (i) => mask[i - first] === 1, (i) => (i > (f.hunks[f.hunks.length - 1]?.end ?? f.end) ? 'trailing lines' : 'unchanged context lines')),
  );
  if (hunks < f.hunks.length) {
    const rest = f.hunks.slice(hunks);
    const adds = rest.reduce((s, h) => s + h.adds, 0);
    const dels = rest.reduce((s, h) => s + h.dels, 0);
    out.push(`${c.marker} ${lref(shownEnd + 2, f.end + 1)} omitted: ${count(rest.length, 'more hunk', 'more hunks')} (+${adds} -${dels}; budget)`);
    out.push(...focusLines(c, shownEnd + 1, f.end));
  }
  return out.join('\n');
}

function focusLines(c: Ctx, a: number, b: number): string[] {
  const out: string[] = [];
  for (let i = a; i <= b; i++) if ((c.crit[i] ?? 0) > 0) out.push(`${c.marker} ${lref(i + 1)}`, c.lines[i] ?? '');
  return out;
}

function renderStats(c: Ctx, f: DiffFile, why: string): string {
  return [header(c, f, ` (${why}: contents omitted)`), ...focusLines(c, f.start, f.end)].join('\n');
}

function renderPartial(c: Ctx, f: DiffFile, budget: number): string | undefined {
  let best: string | undefined;
  let lo = 1;
  let hi = f.hunks.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = renderFile(c, f, mid);
    if (tokens(t) <= budget) {
      best = t;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function preamble(c: Ctx, end: number, target: number): string[] {
  if (end <= 0) return [];
  const full = renderSpan(c, 0, end - 1, () => true, () => '');
  if (tokens(full.join('\n')) <= target * PREAMBLE_SHARE || end <= 10) return full;
  return renderSpan(c, 0, end - 1, (i) => i < 10 || (c.crit[i] ?? 0) > 0, () => 'text before the first file');
}

/** Folds the stats lines of files [from, end) into one omission line (plus their focus lines). */
function aggregate(c: Ctx, files: readonly DiffFile[], from: number): string[] {
  const rest = files.slice(from);
  if (rest.length === 0) return [];
  const adds = rest.reduce((s, f) => s + f.adds, 0);
  const dels = rest.reduce((s, f) => s + f.dels, 0);
  const lines: number[] = [];
  for (const f of rest) for (let i = f.start; i <= f.end; i++) lines.push(i + 1);
  const names = rest.slice(0, 5).map((f) => f.path).join(', ');
  return [
    `${c.marker} ${compactRefs(lines, 4).text} omitted: ${count(rest.length, 'more file', 'more files')} (+${adds} -${dels}: ${names}${rest.length > 5 ? ', …' : ''})`,
    ...rest.flatMap((f) => focusLines(c, f.start, f.end)),
  ];
}

/** Remaining files [from, end) as stats lines while they fit, the rest folded into one line. */
function listing(c: Ctx, files: readonly DiffFile[], stats: readonly string[], head: readonly string[], from: number, target: number): string[] {
  const at = (k: number): string[] => [...head, ...stats.slice(from, from + k), ...aggregate(c, files, from + k)];
  const rest = files.length - from;
  if (tokens(at(rest).join('\n')) <= target) return at(rest);
  let best = at(0);
  let lo = 1;
  let hi = rest - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const candidate = at(mid);
    if (tokens(candidate.join('\n')) <= target) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/**
 * Whole files in order (lock/generated files as stats lines) while a folded
 * line for the rest still fits; the first file that does not fit may be shown
 * partially; then the remaining files are listed with stats and original line
 * ranges, folding whatever does not fit into one omission line.
 */
function layout(c: Ctx, files: readonly DiffFile[], top: readonly string[], target: number): string[] {
  const stats = files.map((f) => renderStats(c, f, f.generated ?? 'over budget'));
  const tailCost = tokens(aggregate(c, files, 0).join('\n'));
  const parts: string[] = [];
  let used = tokens(top.join('\n'));
  let j = 0;
  for (; j < files.length; j++) {
    const f = files[j];
    if (f === undefined) break;
    const piece = f.generated !== null ? (stats[j] ?? '') : renderFile(c, f, f.hunks.length);
    const cost = tokens(piece) + 1;
    if (used + cost + tailCost <= target) {
      parts.push(piece);
      used += cost;
      continue;
    }
    const room = target - used - tailCost;
    if (f.generated === null && f.hunks.length > 1 && room >= target * PARTIAL_SHARE) {
      const partial = renderPartial(c, f, room);
      if (partial !== undefined) {
        parts.push(partial);
        j++;
      }
    }
    break;
  }
  let out = listing(c, files, stats, [...top, ...parts], j, target);
  // Token counts are not exactly additive: give back whole files until it fits.
  while (parts.length > 0 && tokens(out.join('\n')) > target) {
    parts.pop();
    j--;
    out = listing(c, files, stats, [...top, ...parts], j, target);
  }
  return out;
}

/** Unified diffs: per-file stats, hunks and changes verbatim, trimmed context. */
export function compressDiff(text: string, ctx: KindContext): KindOutput | null {
  const { lines } = prepare(text, { trimTrailing: false });
  const parsed = parseDiff(lines);
  if (parsed.files.length === 0) return null;
  const marker = ctx.markerFor(lines);
  const crit = new Uint8Array(lines.length);
  const critical: Critical[] = [];
  const seen = new Set<string>();
  lines.forEach((line, i) => {
    if (!hasFocus(line, ctx.focus)) return;
    crit[i] = P_DETAIL;
    if (!seen.has(line)) {
      seen.add(line);
      critical.push({ text: line, line: i + 1, priority: P_DETAIL });
    }
  });
  const c: Ctx = { lines, crit, marker };
  const adds = parsed.files.reduce((s, f) => s + f.adds, 0);
  const dels = parsed.files.reduce((s, f) => s + f.dels, 0);
  const generated = parsed.files.filter((f) => f.generated !== null).length;
  const summary = `summary: ${count(parsed.files.length, 'file', 'files')} changed, +${adds} -${dels}${
    generated > 0 ? `; ${generated} lock/generated ${generated === 1 ? 'file' : 'files'} as stats only` : ''
  }`;
  const top = [summary, ...preamble(c, parsed.preambleEnd, ctx.target)];
  const body = layout(c, parsed.files, top, ctx.target).join('\n');
  if (tokens(body) > ctx.maxTokens) {
    return criticalOnly('diff', lines, crit, { one: 'diff line', many: 'diff lines' }, [summary], ctx, marker);
  }
  const verbatim = body.split('\n').filter((l) => !l.startsWith(`${marker} `) && !l.startsWith('summary: ')).length;
  return {
    kind: 'diff',
    text: body,
    transform: 'selection',
    critical,
    omittedLines: Math.max(0, lines.length - verbatim),
    omittedCritical: [],
    notes: [`${parsed.files.length} files (+${adds} -${dels}); ${generated} shown as stats only (generated)`],
  };
}
