import { P_DETAIL, P_FAILURE, hasFocus } from '../classify.js';
import { prepare } from '../lines.js';
import { compactRefs, count, lref, toRanges, whereText } from '../markers.js';
import type { Critical } from '../plan.js';
import { criticalOnly, tokens, type KindContext, type KindOutput } from '../output.js';
import { largestFitting, progressive } from '../progressive.js';

const MATCH = /^((?:[A-Za-z]:[\\/])?[^:\n]*?):(\d+):(.*)$/;
const CONTEXT_GENERIC = /^((?:[A-Za-z]:[\\/])?[^:\n]*?[./\\][^:\n]*?)-(\d+)-(.*)$/;
const NO_LINE = /^((?:[A-Za-z]:[\\/])?[^:\s][^:]*\.[A-Za-z0-9]+):(.*)$/;
const DIAGNOSTIC = /:\d+:\d+:?\s+(?:fatal\s+)?(?:error|warning)\b/i;

interface Group {
  path: string;
  /** 0-based input lines of matches. */
  matches: number[];
  /** Source line numbers of matches (null when the tool printed none). */
  srcLines: Array<number | null>;
  texts: string[];
  /** All input lines of the group (matches, context, separators). */
  all: number[];
  context: number;
}

interface Parsed {
  groups: Group[];
  /** Input lines that are not search results. */
  others: number[];
  groupOfLine: Int32Array;
}

/** Per-file layout: verbatim lines shown, source line numbers listed, or folded into the tail. */
interface Setting {
  lines: number;
  nums: number;
  shown: boolean;
}

interface View {
  p: Parsed;
  lines: readonly string[];
  crit: Uint8Array;
  marker: string;
  summary: string;
}

function parse(lines: readonly string[]): Parsed {
  const groups: Group[] = [];
  const byPath = new Map<string, number>();
  const groupOfLine = new Int32Array(lines.length).fill(-1);
  const others: number[] = [];
  let current = -1;
  const groupFor = (path: string): number => {
    let g = byPath.get(path);
    if (g === undefined) {
      g = groups.length;
      byPath.set(path, g);
      groups.push({ path, matches: [], srcLines: [], texts: [], all: [], context: 0 });
    }
    return g;
  };
  lines.forEach((line, i) => {
    const cur = groups[current];
    if (cur !== undefined && (line === '--' || (line.startsWith(`${cur.path}-`) && /^-\d+-/.test(line.slice(cur.path.length))))) {
      cur.context++;
      cur.all.push(i);
      groupOfLine[i] = current;
      return;
    }
    const m = MATCH.exec(line);
    const noLine = m === null ? NO_LINE.exec(line) : null;
    const ctx = m === null && noLine === null ? CONTEXT_GENERIC.exec(line) : null;
    const path = m?.[1] ?? noLine?.[1] ?? ctx?.[1];
    if (path === undefined || path.length === 0) {
      others.push(i);
      return;
    }
    current = groupFor(path);
    const g = groups[current];
    if (g === undefined) return;
    g.all.push(i);
    groupOfLine[i] = current;
    if (ctx !== null) {
      g.context++;
      return;
    }
    g.matches.push(i);
    g.srcLines.push(m === null ? null : Number(m[2]));
    g.texts.push((m?.[3] ?? noLine?.[2] ?? '').trim());
  });
  return { groups, others, groupOfLine };
}

function srcNums(g: Group, cap: number): string {
  if (cap === 0) return '';
  const nums = g.srcLines.filter((n): n is number => n !== null);
  if (nums.length === 0) return '';
  const uniq = [...new Set(nums)].sort((a, b) => a - b);
  const parts = toRanges(uniq).map(([a, b]) => (b > a ? `${a}-${b}` : `${a}`));
  return `; source lines ${parts.slice(0, cap).join(', ')}${parts.length > cap ? ', …' : ''}`;
}

function renderGroup(v: View, g: Group, s: Setting, seen: Set<string>): string[] {
  const shown: number[] = [];
  g.matches.forEach((idx, k) => {
    const text = g.texts[k] ?? '';
    if ((v.crit[idx] ?? 0) > 0 || (shown.length < s.lines && !seen.has(text))) {
      shown.push(idx);
      seen.add(text);
    }
  });
  shown.sort((a, b) => a - b);
  const where = whereText(toRanges(g.all.map((i) => i + 1)), 3, false, (g.all[0] ?? 0) + 1, (g.all[g.all.length - 1] ?? 0) + 1);
  const ctx = g.context > 0 ? ` (+${count(g.context, 'context line', 'context lines')})` : '';
  const head = `${v.marker} ${g.path}: ${count(g.matches.length, 'match', 'matches')}${ctx} ${where}${srcNums(g, s.nums)}`;
  if (shown.length === 0) return [head];
  return [`${head}; shown (${compactRefs(shown.map((i) => i + 1), 64).text}):`, ...shown.map((i) => v.lines[i] ?? '')];
}

function folded(v: View, rest: readonly Group[]): string {
  const all = rest.flatMap((g) => g.all.map((i) => i + 1)).sort((a, b) => a - b);
  const matches = rest.reduce((s, g) => s + g.matches.length, 0);
  const top = rest.slice(0, 5).map((g) => `${g.path} ${g.matches.length}`);
  const more = rest.length > 5 ? `, +${rest.length - 5} more files` : '';
  return `${v.marker} ${compactRefs(all, 4).text} omitted: ${count(all.length, 'line', 'lines')} (${count(rest.length, 'more file', 'more files')} with ${count(matches, 'match', 'matches')}: ${top.join(', ')}${more})`;
}

function render(v: View, settings: readonly Setting[]): string {
  const out: string[] = [v.summary];
  const seen = new Set<string>();
  const rest: Group[] = [];
  type Item = { at: number; group: Group; k: number } | { at: number; run: [number, number] };
  const items: Item[] = [
    ...v.p.groups.map((group, k): Item => ({ at: group.all[0] ?? 0, group, k })),
    ...toRanges(v.p.others.map((i) => i + 1)).map((run): Item => ({ at: run[0] - 1, run })),
  ].sort((a, b) => a.at - b.at);
  for (const item of items) {
    if ('run' in item) {
      const [a, b] = item.run;
      out.push(`${v.marker} ${lref(a, b)}`, ...v.lines.slice(a - 1, b));
      continue;
    }
    const s = settings[item.k] ?? { lines: 0, nums: 0, shown: true };
    if (s.shown || item.group.matches.some((i) => (v.crit[i] ?? 0) > 0)) out.push(...renderGroup(v, item.group, s, seen));
    else rest.push(item.group);
  }
  if (rest.length > 0) out.push(folded(v, rest));
  return out.join('\n');
}

function criticalOf(lines: readonly string[], p: Parsed, focus: readonly string[]): { crit: Uint8Array; items: Critical[] } {
  const crit = new Uint8Array(lines.length);
  const items: Critical[] = [];
  const seen = new Set<string>();
  lines.forEach((line, i) => {
    let prio = 0;
    if (hasFocus(line, focus)) prio = P_DETAIL;
    if ((p.groupOfLine[i] ?? -1) >= 0 && DIAGNOSTIC.test(line)) prio = P_FAILURE;
    if (prio === 0) return;
    crit[i] = prio;
    if (!seen.has(line)) {
      seen.add(line);
      items.push({ text: line, line: i + 1, priority: prio });
    }
  });
  return { crit, items };
}

/** Budget filling order: a few source line numbers for every file, then one verbatim line, then more. */
const ROUNDS: ReadonlyArray<(s: Setting) => Setting> = [
  (s) => ({ ...s, nums: Math.max(s.nums, 3) }),
  (s) => ({ ...s, lines: Math.max(s.lines, 1) }),
  (s) => ({ ...s, nums: Math.max(s.nums, 8) }),
  (s) => ({ ...s, lines: Math.max(s.lines, 2) }),
  (s) => ({ ...s, lines: Math.max(s.lines, 3), nums: Math.max(s.nums, 16) }),
];

/** grep/rg output grouped by file; null when fewer than half the lines are search results. */
export function compressSearch(text: string, ctx: KindContext): KindOutput | null {
  const { lines } = prepare(text, { trimTrailing: true });
  const p = parse(lines);
  const nonEmpty = lines.filter((l) => l.trim().length > 0).length;
  if (nonEmpty === 0 || p.others.length > nonEmpty / 2) return null;
  const marker = ctx.markerFor(lines);
  const { crit, items } = criticalOf(lines, p, ctx.focus);
  const totalMatches = p.groups.reduce((s, g) => s + g.matches.length, 0);
  const totalContext = p.groups.reduce((s, g) => s + g.context, 0);
  const summary = `summary: ${count(totalMatches, 'match', 'matches')} in ${count(p.groups.length, 'file', 'files')}${
    totalContext > 0 ? ` (+${count(totalContext, 'context line', 'context lines')})` : ''
  }; grouped by file in original order`;
  const v: View = { p, lines, crit, marker, summary };
  const fits = (t: string): boolean => tokens(t) <= ctx.target;
  const compact = p.groups.map((): Setting => ({ lines: 0, nums: 0, shown: true }));
  let body = render(v, compact);
  if (fits(body)) {
    body = progressive(compact, ROUNDS, (s) => render(v, s), fits).text;
  } else {
    const cut = (n: number): Setting[] => p.groups.map((_, k) => ({ lines: 0, nums: 0, shown: k < n }));
    body = largestFitting(p.groups.length, (n) => render(v, cut(n)), fits).text;
  }
  if (tokens(body) > ctx.maxTokens) {
    return criticalOnly('search', lines, crit, { one: 'search result line', many: 'search result lines' }, [summary], ctx, marker);
  }
  return {
    kind: 'search',
    text: body,
    transform: 'selection',
    critical: items,
    omittedLines: Math.max(0, lines.length - countVerbatim(body, marker)),
    omittedCritical: [],
    notes: [`${totalMatches} matches in ${p.groups.length} files grouped by file`],
  };
}

function countVerbatim(body: string, marker: string): number {
  let n = 0;
  for (const line of body.split('\n')) if (!line.startsWith(`${marker} `) && !line.startsWith('summary: ')) n++;
  return n;
}
