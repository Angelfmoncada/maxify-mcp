import { estimateTokens } from '../core/tokens.js';
import { failureStrength } from './classify.js';
import { MIN_GROUP_SAVINGS, identicalGroup, identicalGroups } from './groups.js';
import { compactRefs } from './markers.js';
import { NEVER, R_REPEAT, type Critical, type LinePlan, type RepeatGroup } from './plan.js';
import { renderSelection, type RenderView, type Rendered } from './render.js';
import { templateOf } from './template.js';

export interface FitOptions {
  /** Hard budget: critical lines beyond it are listed, never silently dropped. */
  maxTokens: number;
  /** Fill target for optional lines (<= maxTokens). */
  target: number;
  marker: string;
}

export interface FitResult {
  text: string;
  critical: Critical[];
  omittedLines: number;
  /** Critical lines deliberately left out (budget); listed in the text. */
  omittedCritical: number;
  formatOnly: boolean;
  lossy: boolean;
  notes: string[];
}

/** Estimated cost of opening a new run (run marker + split omission marker). */
const RUN_OVERHEAD = 18;
const BRIDGE_TOKENS = 12;
const BRIDGE_LINES = 3;
const MAX_GREEDY_MISSES = 2000;
/** estimateTokens never returns less than ~1 token per 9 chars. */
const MIN_CHARS_PER_TOKEN = 9;

class LineCosts {
  private readonly cache: Int32Array;

  constructor(
    private readonly lines: readonly string[],
    private readonly hugeChars: number,
  ) {
    this.cache = new Int32Array(lines.length).fill(-1);
  }

  get(i: number): number {
    const cached = this.cache[i] ?? -1;
    if (cached >= 0) return cached;
    const line = this.lines[i] ?? '';
    const cost = line.length > this.hugeChars ? Math.ceil(line.length / 3) : estimateTokens(line);
    this.cache[i] = cost;
    return cost;
  }
}

interface Ctx {
  plan: LinePlan;
  view: RenderView;
  opts: FitOptions;
  costs: LineCosts;
  cache: Map<string, string>;
}

interface Attempt {
  rendered: Rendered;
  cost: number;
  sel: Uint8Array;
}

interface Built {
  view: RenderView;
  critical: Critical[];
  firsts: number[];
  /** Identical critical occurrences: first index -> all indices. */
  members: Map<number, number[]>;
}

/**
 * Copies of identical critical lines that are cheaper to show than to replace
 * with a repeat marker (short lines like "- Expected" repeated twice).
 */
function cheapCopies(members: ReadonlyMap<number, number[]>, costs: LineCosts): number[] {
  const out: number[] = [];
  for (const [first, list] of members) {
    if ((list.length - 1) * (costs.get(first) + 1) < MIN_GROUP_SAVINGS) out.push(...list.slice(1));
  }
  return out;
}

function buildView(plan: LinePlan): Built {
  const critIdx: number[] = [];
  for (let i = 0; i < plan.lines.length; i++) if ((plan.crit[i] ?? 0) > 0) critIdx.push(i);
  const { firsts, members } = identicalGroups(plan.lines, critIdx);
  const groupOf = plan.groupOf.slice();
  const reason = plan.reason.slice();
  const groups: RepeatGroup[] = [...plan.groups];
  for (const [first, list] of members) {
    const gid = groups.length;
    groups.push(identicalGroup(list));
    for (const i of list) {
      groupOf[i] = gid;
      if (i !== first) reason[i] = R_REPEAT;
    }
  }
  const critical = firsts.map((i) => ({
    text: plan.lines[i] ?? '',
    line: i + 1,
    priority: (members.get(i) ?? [i]).reduce((p, k) => Math.min(p, plan.crit[k] ?? 1), 9),
  }));
  const view: RenderView = { lines: plan.lines, reason, labels: plan.labels, groupOf, groups, summarize: plan.summarize };
  return { view, critical, firsts, members };
}

/** Selects cheap gaps (<= 3 lines, <= 12 tokens) so they do not cost two markers. */
function bridge(sel: Uint8Array, costs: LineCosts): Uint8Array {
  const out = sel.slice();
  const n = sel.length;
  let i = 0;
  while (i < n) {
    if (out[i] === 1) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < n && out[j + 1] !== 1 && j - i < BRIDGE_LINES) j++;
    const closed = (j + 1 >= n || out[j + 1] === 1) && j - i + 1 <= BRIDGE_LINES;
    const touches = i > 0 || j + 1 < n;
    if (closed && touches) {
      let cost = 0;
      for (let k = i; k <= j; k++) cost += costs.get(k) + 1;
      if (cost <= BRIDGE_TOKENS) for (let k = i; k <= j; k++) out[k] = 1;
    }
    while (j + 1 < n && out[j + 1] !== 1) j++;
    i = j + 1;
  }
  return out;
}

function attempt(ctx: Ctx, sel: Uint8Array, top: readonly string[]): Attempt {
  const bridged = bridge(sel, ctx.costs);
  const rendered = renderSelection(ctx.view, bridged, ctx.opts.marker, top, ctx.cache);
  return { rendered, cost: estimateTokens(rendered.text), sel: bridged };
}

function sortedCandidates(plan: LinePlan, base: Uint8Array): number[] {
  const n = plan.lines.length;
  const buckets = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const t = plan.tier[i] ?? NEVER;
    if (t >= NEVER || base[i] === 1) continue;
    const list = buckets.get(t);
    if (list === undefined) buckets.set(t, [i]);
    else list.push(i);
  }
  const out: number[] = [];
  for (const t of [...buckets.keys()].sort((a, b) => a - b)) {
    const list = buckets.get(t) ?? [];
    const keys = new Float64Array(list.length);
    list.forEach((i, k) => {
      keys[k] = Math.max(0, Math.floor(plan.order[i] ?? 0)) * (n + 1) + i;
    });
    keys.sort();
    for (const key of keys) out.push(key % (n + 1));
  }
  return out;
}

function greedy(ctx: Ctx, cands: readonly number[], base: Uint8Array, budget: number): number[] {
  const sel = base.slice();
  const accepted: number[] = [];
  let spent = 0;
  let misses = 0;
  for (const i of cands) {
    if (budget - spent < 2 || misses > MAX_GREEDY_MISSES) break;
    const joined = sel[i - 1] === 1 || sel[i + 1] === 1;
    const cost = ctx.costs.get(i) + 1 + (joined ? 0 : RUN_OVERHEAD);
    if (spent + cost > budget) {
      misses++;
      continue;
    }
    sel[i] = 1;
    spent += cost;
    accepted.push(i);
  }
  return accepted;
}

function withPrefix(base: Uint8Array, list: readonly number[], k: number): Uint8Array {
  const sel = base.slice();
  for (let j = 0; j < k; j++) sel[list[j] ?? 0] = 1;
  return sel;
}

function fill(ctx: Ctx, base: Uint8Array, first: Attempt): Attempt {
  const cands = sortedCandidates(ctx.plan, base);
  const accepted = greedy(ctx, cands, base, Math.max(0, ctx.opts.target - first.cost));
  if (accepted.length === 0) return first;
  const full = attempt(ctx, withPrefix(base, accepted, accepted.length), []);
  if (full.cost <= ctx.opts.target) return full;
  let best = first;
  let lo = 1;
  let hi = accepted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const a = attempt(ctx, withPrefix(base, accepted, mid), []);
    if (a.cost <= ctx.opts.target) {
      best = a;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/** Critical lines at the very end (final status, "Build failed", log location) rank as strong. */
const TAIL_CRITICAL = 5;

/**
 * Critical firsts ordered by priority, then strength (real failure wording
 * before prefix-only markers like "npm ERR!"), then first-of-template
 * (diversity), then position.
 */
function prioritize(plan: LinePlan, firsts: readonly number[], templates: ReadonlyMap<number, string>): number[] {
  const seen = new Set<string>();
  const firstOfTemplate = new Set<number>();
  for (const i of firsts) {
    const t = templates.get(i) ?? '';
    if (!seen.has(t)) {
      seen.add(t);
      firstOfTemplate.add(i);
    }
  }
  const tail = new Set(firsts.slice(-TAIL_CRITICAL));
  const strength = new Map(firsts.map((i) => [i, tail.has(i) ? 0 : failureStrength(plan.lines[i] ?? '')] as const));
  const key = (i: number): number =>
    (plan.crit[i] ?? 3) * 4 + (strength.get(i) ?? 1) * 2 + (firstOfTemplate.has(i) ? 0 : 1);
  return [...firsts].sort((a, b) => key(a) - key(b) || a - b);
}

function incompleteLine(
  ctx: Ctx,
  total: number,
  omitted: readonly number[],
  shown: readonly number[],
  templates: ReadonlyMap<number, string>,
): string {
  const sorted = omitted.map((i) => i + 1).sort((a, b) => a - b);
  const refs = compactRefs(sorted, 24);
  const shownTemplates = new Set(shown.map((i) => templates.get(i)));
  const alike = omitted.filter((i) => shownTemplates.has(templates.get(i))).length;
  const parts = [
    `${ctx.opts.marker} incomplete: ${omitted.length} of ${total} critical lines not shown (budget ${ctx.opts.maxTokens} tokens), at ${refs.text}`,
  ];
  if (!refs.exact) parts.push(' (ranges also contain other lines)');
  if (alike > 0) parts.push(`; ${alike} of them share a template with a shown critical line`);
  return parts.join('');
}

function overflow(ctx: Ctx, firsts: readonly number[]): { result: Attempt; omitted: number } {
  const templates = new Map(firsts.map((i) => [i, templateOf(ctx.view.lines[i] ?? '')] as const));
  const ordered = prioritize(ctx.plan, firsts, templates);
  const limit = ctx.opts.maxTokens * MIN_CHARS_PER_TOKEN;
  const fitting = ordered.filter((i) => (ctx.view.lines[i]?.length ?? 0) <= limit);
  const huge = ordered.filter((i) => (ctx.view.lines[i]?.length ?? 0) > limit);
  const n = ctx.view.lines.length;
  const tryP = (p: number): Attempt => {
    const shown = fitting.slice(0, p);
    const omitted = [...fitting.slice(p), ...huge];
    const sel = new Uint8Array(n);
    for (const i of shown) sel[i] = 1;
    return attempt(ctx, sel, [incompleteLine(ctx, firsts.length, omitted, shown, templates)]);
  };
  let best = tryP(0);
  let bestP = 0;
  let lo = 1;
  let hi = fitting.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const a = tryP(mid);
    if (a.cost <= ctx.opts.maxTokens) {
      best = a;
      bestP = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return { result: best, omitted: firsts.length - bestP };
}

/** Budgeted rendering of a line plan. */
export function fitLines(plan: LinePlan, opts: FitOptions): FitResult {
  const { view, critical, firsts, members } = buildView(plan);
  const ctx: Ctx = {
    plan,
    view,
    opts,
    costs: new LineCosts(plan.lines, opts.maxTokens * MIN_CHARS_PER_TOKEN),
    cache: new Map(),
  };
  const mandatory = [...firsts, ...cheapCopies(members, ctx.costs)];
  const base = new Uint8Array(plan.lines.length);
  for (const i of mandatory) base[i] = 1;
  const lowerBound = mandatory.reduce((s, i) => s + Math.floor((plan.lines[i]?.length ?? 0) / MIN_CHARS_PER_TOKEN), 0);
  let chosen: Attempt | undefined;
  let omittedCritical = 0;
  if (lowerBound <= opts.maxTokens) {
    const first = attempt(ctx, base, []);
    if (first.cost <= opts.maxTokens) chosen = fill(ctx, base, first);
  }
  if (chosen === undefined) {
    const o = overflow(ctx, firsts);
    chosen = o.result;
    omittedCritical = o.omitted;
  }
  const r = chosen.rendered;
  const notes = [...plan.notes];
  if (r.repeatBlocks > 0) notes.push(`${r.repeatBlocks} repeated-line groups collapsed`);
  if (omittedCritical > 0) notes.push(`${omittedCritical} critical lines did not fit the budget; their line numbers are listed`);
  return {
    text: r.text,
    critical,
    omittedLines: plan.lines.length - r.shown,
    omittedCritical,
    formatOnly: r.formatOnly,
    lossy: plan.lossy || r.lossyBlocks > 0,
    notes,
  };
}
