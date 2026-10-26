import { P_DETAIL, hasFocus } from '../classify.js';
import { isPathLike } from '../detect.js';
import { prepare } from '../lines.js';
import { compactRefs, count, lref, toRanges, whereText } from '../markers.js';
import type { Critical } from '../plan.js';
import { criticalOnly, tokens, type KindContext, type KindOutput } from '../output.js';
import { largestFitting, progressive } from '../progressive.js';

interface Dir {
  name: string;
  idx: number[];
  exts: Map<string, number>;
}

interface Setting {
  entries: number;
  shown: boolean;
}

interface View {
  lines: readonly string[];
  crit: Uint8Array;
  marker: string;
  top: readonly string[];
  /** Grouping depth (0 = exact directory, N = first N path segments). */
  depth: number;
}

/** Finest grouping first; 0 = exact directory. */
const DEPTHS = [0, 3, 2, 1] as const;

const ROUNDS: ReadonlyArray<(s: Setting) => Setting> = [
  (s) => ({ ...s, entries: Math.max(s.entries, 2) }),
  (s) => ({ ...s, entries: Math.max(s.entries, 4) }),
  (s) => ({ ...s, entries: Math.max(s.entries, 8) }),
];

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function dirOf(path: string): string {
  const p = normalize(path).replace(/\/+$/, '');
  const cut = p.lastIndexOf('/');
  return cut < 0 ? '.' : p.slice(0, cut) || '/';
}

function extOf(path: string, dirs: ReadonlySet<string>): string {
  const p = normalize(path);
  if (p.endsWith('/') || dirs.has(p.replace(/\/+$/, ''))) return '(dir)';
  const base = p.slice(p.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '(none)';
}

function histogram(exts: ReadonlyMap<string, number>, cap: number): string {
  const sorted = [...exts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const shown = sorted.slice(0, cap).map(([e, n]) => `${e} ${n}`);
  if (sorted.length > cap) shown.push(`+${sorted.length - cap} more`);
  return shown.join(', ');
}

function groupDirs(lines: readonly string[], entries: readonly number[], depth: number): Dir[] {
  const allDirs = new Set(entries.map((i) => dirOf(lines[i] ?? '')));
  const byName = new Map<string, Dir>();
  const out: Dir[] = [];
  for (const i of entries) {
    const line = lines[i] ?? '';
    let name = dirOf(line);
    if (depth > 0 && name !== '.') name = name.split('/').slice(0, depth).join('/');
    let d = byName.get(name);
    if (d === undefined) {
      d = { name, idx: [], exts: new Map() };
      byName.set(name, d);
      out.push(d);
    }
    d.idx.push(i);
    const ext = extOf(line, allDirs);
    d.exts.set(ext, (d.exts.get(ext) ?? 0) + 1);
  }
  return out;
}

function renderDir(v: View, d: Dir, s: Setting): string[] {
  const where = whereText(toRanges(d.idx.map((i) => i + 1)), 3, false, (d.idx[0] ?? 0) + 1, (d.idx[d.idx.length - 1] ?? 0) + 1);
  const shown = d.idx.filter((i, k) => k < s.entries || (v.crit[i] ?? 0) > 0);
  const nested = v.depth > 0 && d.idx.some((i) => dirOf(v.lines[i] ?? '') !== d.name);
  const label = nested ? `${d.name}/**` : `${d.name}/`;
  const head = `${v.marker} ${label} — ${count(d.idx.length, 'entry', 'entries')} (${histogram(d.exts, 4)}) ${where}`;
  if (shown.length === 0) return [head];
  return [`${head}; shown (${compactRefs(shown.map((i) => i + 1), 64).text}):`, ...shown.map((i) => v.lines[i] ?? '')];
}

function render(v: View, dirs: readonly Dir[], settings: readonly Setting[]): string {
  const out = [...v.top];
  const rest: Dir[] = [];
  dirs.forEach((d, k) => {
    const s = settings[k] ?? { entries: 0, shown: true };
    if (s.shown || d.idx.some((i) => (v.crit[i] ?? 0) > 0)) out.push(...renderDir(v, d, s));
    else rest.push(d);
  });
  if (rest.length > 0) {
    const all = rest.flatMap((d) => d.idx.map((i) => i + 1)).sort((a, b) => a - b);
    const names = rest.slice(0, 5).map((d) => `${d.name}/ ${d.idx.length}`);
    out.push(
      `${v.marker} ${compactRefs(all, 4).text} omitted: ${count(all.length, 'line', 'lines')} (${count(rest.length, 'more directory', 'more directories')}: ${names.join(', ')}${rest.length > 5 ? ', …' : ''})`,
    );
  }
  return out.join('\n');
}

function focusCritical(lines: readonly string[], focus: readonly string[]): { crit: Uint8Array; critical: Critical[] } {
  const crit = new Uint8Array(lines.length);
  const critical: Critical[] = [];
  const seen = new Set<string>();
  lines.forEach((line, i) => {
    if (!hasFocus(line, focus)) return;
    crit[i] = P_DETAIL;
    if (!seen.has(line)) {
      seen.add(line);
      critical.push({ text: line, line: i + 1, priority: P_DETAIL });
    }
  });
  return { crit, critical };
}

function layout(v0: Omit<View, 'depth'>, entries: readonly number[], target: number): string {
  const fits = (t: string): boolean => tokens(t) <= target;
  for (const depth of DEPTHS) {
    const dirs = groupDirs(v0.lines, entries, depth);
    const v: View = { ...v0, depth };
    const compact = dirs.map((): Setting => ({ entries: 0, shown: true }));
    if (fits(render(v, dirs, compact))) return progressive(compact, ROUNDS, (s) => render(v, dirs, s), fits).text;
  }
  const dirs = groupDirs(v0.lines, entries, 1);
  const v: View = { ...v0, depth: 1 };
  const cut = (n: number): Setting[] => dirs.map((_, k) => ({ entries: 0, shown: k < n }));
  return largestFitting(dirs.length, (n) => render(v, dirs, cut(n)), fits).text;
}

/** One-path-per-line listings grouped by directory; null when most lines are not paths. */
export function compressList(text: string, ctx: KindContext): KindOutput | null {
  const { lines } = prepare(text, { trimTrailing: true });
  const entries: number[] = [];
  const others: number[] = [];
  lines.forEach((line, i) => {
    if (line.trim().length === 0) return;
    if (isPathLike(line.trim())) entries.push(i);
    else others.push(i);
  });
  if (entries.length === 0 || others.length > entries.length) return null;
  const marker = ctx.markerFor(lines);
  const { crit, critical } = focusCritical(lines, ctx.focus);
  const exactDirs = groupDirs(lines, entries, 0);
  const allExts = new Map<string, number>();
  for (const d of exactDirs) for (const [e, n] of d.exts) allExts.set(e, (allExts.get(e) ?? 0) + n);
  const summary = `summary: ${count(entries.length, 'path', 'paths')} in ${count(exactDirs.length, 'directory', 'directories')}; extensions: ${histogram(allExts, 8)}`;
  const top = [summary];
  for (const [a, b] of toRanges(others.map((i) => i + 1))) top.push(`${marker} ${lref(a, b)}`, ...lines.slice(a - 1, b));
  const body = layout({ lines, crit, marker, top }, entries, ctx.target);
  if (tokens(body) > ctx.maxTokens) {
    return criticalOnly('list', lines, crit, { one: 'path', many: 'paths' }, [summary], ctx, marker);
  }
  const verbatim = body.split('\n').filter((l) => !l.startsWith(`${marker} `) && !l.startsWith('summary: ')).length;
  return {
    kind: 'list',
    text: body,
    transform: 'summary',
    critical,
    omittedLines: Math.max(0, lines.length - verbatim),
    omittedCritical: [],
    notes: [`${entries.length} paths grouped into ${exactDirs.length} directories`],
  };
}
