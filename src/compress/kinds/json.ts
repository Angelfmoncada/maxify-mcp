import { hasFocus } from '../classify.js';
import { JSON_MAX_CHARS } from '../detect.js';
import { minifyJson, scanJson, type JNode } from '../json-scan.js';
import { compactRefs, lref } from '../markers.js';
import { P_DETAIL, P_FAILURE } from '../classify.js';
import type { Critical } from '../plan.js';
import { tokens, type KindContext, type KindOutput } from '../output.js';

const CRITICAL_KEY = /error|errors|message|status|code|fail|warning/i;
const INLINE_CHARS = 160;
const EXAMPLE_CHARS = 400;
const CRITICAL_VALUE_CHARS = 1500;
const STRUCTURE_DEPTH = 3;
const SCHEMA_KEYS = 12;
const IDENT = /^[A-Za-z_$][\w$]*$/;

interface Entry {
  /** Source offset, for document order. */
  at: number;
  tier: number;
  text: string;
  line: number;
}

interface CritAcc {
  at: number;
  depth: number;
  pattern: string;
  text: string;
  lines: number[];
  priority: number;
}

interface Walk {
  src: string;
  focus: readonly string[];
  marker: string;
  entries: Entry[];
  crit: Map<string, CritAcc>;
}

function keyPath(key: string): string {
  return IDENT.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}

function lines(n: JNode): string {
  return lref(n.line, n.endLine);
}

function shortType(n: JNode): string {
  if (n.type === 'array') return `array[${n.children?.length ?? '?'}]`;
  return n.type;
}

function elementSchema(arr: JNode): string {
  const kids = arr.children ?? [];
  const types = new Set(kids.map((k) => k.type));
  if (types.size !== 1 || !types.has('object')) return [...types].join('|') || 'nothing';
  const keyTypes = new Map<string, Set<string>>();
  const presence = new Map<string, number>();
  for (const el of kids) {
    (el.keys ?? []).forEach((k, i) => {
      const child = el.children?.[i];
      if (child === undefined) return;
      if (!keyTypes.has(k)) keyTypes.set(k, new Set());
      keyTypes.get(k)?.add(shortType(child).replace(/\[\d+\]$/, '[]'));
      presence.set(k, (presence.get(k) ?? 0) + 1);
    });
  }
  const parts = [...keyTypes.entries()].slice(0, SCHEMA_KEYS).map(([k, ts]) => {
    const optional = (presence.get(k) ?? 0) < kids.length ? '?' : '';
    return `${k}${optional}: ${[...ts].join('|')}`;
  });
  const more = keyTypes.size > SCHEMA_KEYS ? `, +${keyTypes.size - SCHEMA_KEYS} more keys` : '';
  return `object{${parts.join(', ')}${more}}`;
}

/** Minified source when it is at most `limit` chars, else undefined (scans at most ~limit chars of output). */
function smallValue(src: string, n: JNode, limit: number): string | undefined {
  if (n.type !== 'object' && n.type !== 'array') return n.end - n.start <= limit ? src.slice(n.start, n.end) : undefined;
  // Minifying a prefix never yields more than minifying the whole span, so a long prefix proves "too big".
  const probeEnd = Math.min(n.end, n.start + limit * 8);
  const probe = minifyJson(src, n.start, probeEnd);
  if (probe.length > limit) return undefined;
  if (probeEnd === n.end) return probe;
  const full = minifyJson(src, n.start, n.end);
  return full.length <= limit ? full : undefined;
}

/** True when `describe` shows the value in full (its children need no own lines). */
function shownInFull(w: Walk, n: JNode, limit: number): boolean {
  return n.opaque !== true && smallValue(w.src, n, limit) !== undefined;
}

function describe(w: Walk, n: JNode, limit: number): string {
  if (n.opaque === true) return `${n.type} (nested too deeply to expand)`;
  const small = smallValue(w.src, n, limit);
  if (small !== undefined) return small;
  if (n.type === 'string') return `string of ${n.end - n.start - 2} chars, starts ${w.src.slice(n.start, n.start + 80)}… (truncated)`;
  if (n.type === 'object') {
    const keys = n.keys ?? [];
    const shown = keys.slice(0, SCHEMA_KEYS).map((k, i) => `${k}: ${shortType(n.children?.[i] ?? n)}`);
    return `object{${shown.join(', ')}${keys.length > SCHEMA_KEYS ? `, +${keys.length - SCHEMA_KEYS} more keys` : ''}}`;
  }
  if (n.type === 'array') return `array[${n.children?.length ?? 0}] of ${elementSchema(n)}`;
  return w.src.slice(n.start, n.end);
}

function addCritical(w: Walk, n: JNode, rawKey: string, pattern: string, depth: number, priority: number): boolean {
  const container = n.type === 'object' || n.type === 'array';
  const value = container ? smallValue(w.src, n, CRITICAL_VALUE_CHARS) : w.src.slice(n.start, n.end);
  if (value === undefined) return false;
  const text = `"${rawKey}":${value}`;
  const id = `${pattern}\u0000${text}`;
  const acc = w.crit.get(id);
  if (acc === undefined) w.crit.set(id, { at: n.start, depth, pattern, text, lines: [n.line], priority });
  else acc.lines.push(n.line);
  return true;
}

function walk(w: Walk, n: JNode, path: string, pattern: string, depth: number, example: boolean): void {
  if (n.opaque === true || n.children === undefined) return;
  const kids = n.children;
  if (n.type === 'object') {
    kids.forEach((child, i) => {
      const key = n.keys?.[i] ?? '';
      const raw = n.rawKeys?.[i] ?? key;
      const childPath = `${path}${keyPath(key)}`;
      const childPattern = `${pattern}${keyPath(key)}`;
      const primitive = child.type !== 'object' && child.type !== 'array';
      const focusHit =
        w.focus.length > 0 && (hasFocus(raw, w.focus) || (primitive && hasFocus(w.src.slice(child.start, child.end), w.focus)));
      const isCrit = CRITICAL_KEY.test(key) || focusHit;
      const kept = isCrit && addCritical(w, child, raw, childPattern, depth + 1, CRITICAL_KEY.test(key) ? P_FAILURE : P_DETAIL);
      // A critical container kept whole already shows everything below it.
      if (kept && !primitive) return;
      const listed = !kept && depth + 1 <= STRUCTURE_DEPTH && !example;
      if (listed) {
        w.entries.push({ at: child.start, tier: depth * 2, line: child.line, text: `${w.marker} ${childPath} (${lines(child)}): ${describe(w, child, INLINE_CHARS)}` });
      }
      walk(w, child, childPath, childPattern, depth + 1, example || (listed && shownInFull(w, child, INLINE_CHARS)));
    });
    return;
  }
  kids.forEach((child, k) => {
    const isExample = k < 2 && !example && depth + 1 <= STRUCTURE_DEPTH;
    if (isExample) {
      w.entries.push({ at: child.start, tier: depth * 2 + 1, line: child.line, text: `${w.marker} ${path}[${k}] (${lines(child)}): ${describe(w, child, EXAMPLE_CHARS)}` });
    }
    walk(w, child, `${path}[${k}]`, `${pattern}[*]`, depth + 1, example || k >= 2 || isExample);
  });
}

function critEntry(w: Walk, c: CritAcc): Entry {
  const times = c.lines.length > 1 ? ` ×${c.lines.length} (first L${c.lines[0]})` : ` (L${c.lines[0]})`;
  return { at: c.at, tier: -1, line: c.lines[0] ?? 1, text: `${w.marker} ${c.pattern}${times}: ${c.text}` };
}

function render(top: readonly string[], entries: readonly Entry[]): string {
  return [...top, ...[...entries].sort((a, b) => a.at - b.at || a.tier - b.tier).map((e) => e.text)].join('\n');
}

/** JSON: minified when it fits, otherwise a labeled structural summary. Null when not JSON. */
export function compressJson(text: string, ctx: KindContext): KindOutput | null {
  const src = text.replace(/^﻿/, '');
  if (src.length > JSON_MAX_CHARS) return null;
  try {
    JSON.parse(src);
  } catch {
    return null;
  }
  const root = scanJson(src);
  const marker = ctx.markerFor([]);
  const w: Walk = { src, focus: ctx.focus, marker, entries: [], crit: new Map() };
  walk(w, root, '', '', 0, false);
  const crits = [...w.crit.values()];
  const critical: Critical[] = crits.map((c) => ({ text: c.text, line: c.lines[0] ?? 1, priority: c.priority, inline: true }));
  const minified = minifyJson(src);
  const originalLines = src.split('\n').length;
  if (minified.length <= ctx.target * 9 && tokens(minified) <= ctx.target) {
    return { kind: 'json', text: minified, transform: 'format', critical, omittedLines: 0, omittedCritical: [], notes: ['JSON minified (whitespace outside strings removed)'] };
  }
  const keys = root.keys ?? [];
  const keyList = keys.length > 0 ? ` (${keys.slice(0, SCHEMA_KEYS).join(', ')}${keys.length > SCHEMA_KEYS ? ', …' : ''})` : '';
  const kind = root.type === 'array' ? `array of ${root.children?.length ?? 0} elements` : `object with ${keys.length} keys${keyList}`;
  const top = [
    `summary: JSON ${kind}; minified form is ${minified.length} chars, over the budget; structure below is lossy, values of error/message/status/code-like keys are verbatim (minified)`,
  ];
  if (root.type === 'array') {
    top.push(`${marker} . (${lines(root)}): array[${root.children?.length ?? 0}] of ${elementSchema(root)}`);
  }
  const mandatory = crits.map((c) => critEntry(w, c));
  const base = render(top, mandatory);
  if (tokens(base) > ctx.maxTokens) return overflow(w, top, crits, ctx, critical, originalLines);
  const optional = [...w.entries].sort((a, b) => a.tier - b.tier || a.at - b.at);
  const reserve = 30;
  let spent = tokens(base) + reserve;
  const chosen: Entry[] = [...mandatory];
  let skipped = 0;
  for (const e of optional) {
    const cost = tokens(e.text) + 1;
    if (spent + cost > ctx.target) {
      skipped++;
      continue;
    }
    chosen.push(e);
    spent += cost;
  }
  const tail = skipped > 0 ? [`${marker} ${skipped} more keys/elements not described (budget); full JSON at ${lref(1, originalLines)}`] : [];
  return {
    kind: 'json',
    text: [render(top, chosen), ...tail].join('\n'),
    transform: 'summary',
    critical,
    omittedLines: originalLines,
    omittedCritical: [],
    notes: [`JSON summarized: ${chosen.length - mandatory.length} structure lines, ${mandatory.length} verbatim key/values`],
  };
}

function overflow(
  w: Walk,
  top: readonly string[],
  crits: readonly CritAcc[],
  ctx: KindContext,
  critical: Critical[],
  originalLines: number,
): KindOutput {
  const ordered = [...crits].sort((a, b) => a.priority - b.priority || a.depth - b.depth || a.at - b.at);
  const tryP = (p: number): string => {
    const omitted = ordered.slice(p).flatMap((c) => c.lines).sort((a, b) => a - b);
    const refs = compactRefs(omitted, 24);
    const note = `${w.marker} incomplete: ${ordered.length - p} of ${ordered.length} critical key/values not shown (budget ${ctx.maxTokens} tokens), at ${refs.text}${refs.exact ? '' : ' (ranges also contain other lines)'}`;
    return render([...top, note], ordered.slice(0, p).map((c) => critEntry(w, c)));
  };
  let best = tryP(0);
  let bestP = 0;
  let lo = 1;
  let hi = ordered.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = tryP(mid);
    if (tokens(t) <= ctx.maxTokens) {
      best = t;
      bestP = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return {
    kind: 'json',
    text: best,
    transform: 'summary',
    critical,
    omittedLines: originalLines,
    omittedCritical: ordered.slice(bestP).map((c) => c.lines[0] ?? 1),
    notes: [`${ordered.length - bestP} critical key/values did not fit the budget; their lines are listed`],
  };
}
