import { count, lref } from './markers.js';
import { R_REPEAT, type ReasonLabel, type RepeatGroup } from './plan.js';

/** What the renderer needs from a line plan (with identical-critical groups merged in). */
export interface RenderView {
  lines: readonly string[];
  reason: Uint8Array;
  labels: readonly ReasonLabel[];
  groupOf: Int32Array;
  groups: readonly RepeatGroup[];
  summarize: (selected: Uint8Array) => string[];
}

export interface Rendered {
  text: string;
  shown: number;
  /** Repeat blocks rendered for groups whose members differ (lossy). */
  lossyBlocks: number;
  repeatBlocks: number;
  /** Every line shown, no markers needed. */
  formatOnly: boolean;
}

const MAX_GAP_PARTS = 4;

interface GapPart {
  n: number;
  one: string;
  many: string;
}

function repeatPart(view: RenderView, n: number, gids: readonly number[], distinct: number): GapPart {
  const refs = gids.map((g) => `L${(view.groups[g]?.first ?? 0) + 1}`);
  if (distinct === 1) {
    const ref = refs[0] ?? '';
    return view.groups[gids[0] ?? -1]?.identical === true
      ? { n, one: `copy of ${ref}`, many: `copies of ${ref}` }
      : { n, one: `repeat of ${ref}`, many: `repeats of ${ref}` };
  }
  if (distinct <= 3) return { n, one: `repeat of ${refs.join('/')}`, many: `repeats of ${refs.join('/')}` };
  return { n, one: `repeat of ${distinct} lines`, many: `repeats of ${distinct} lines` };
}

/** "308 lines (300 passing tests, 8 other lines)". */
export function describeGap(view: RenderView, a: number, b: number): string {
  const counts = new Map<number, number>();
  let repeats = 0;
  const gids: number[] = [];
  const allGroups = new Set<number>();
  for (let k = a; k <= b; k++) {
    const r = view.reason[k] ?? 0;
    const g = view.groupOf[k] ?? -1;
    if (r === R_REPEAT && g >= 0) {
      repeats++;
      if (!allGroups.has(g)) {
        allGroups.add(g);
        if (gids.length < 3) gids.push(g);
      }
    } else {
      counts.set(r, (counts.get(r) ?? 0) + 1);
    }
  }
  const parts: GapPart[] = [];
  if (repeats > 0) parts.push(repeatPart(view, repeats, gids, allGroups.size));
  for (const [r, c] of counts) {
    const label = view.labels[r] ?? view.labels[0] ?? { one: 'other line', many: 'other lines' };
    parts.push({ n: c, one: label.one, many: label.many });
  }
  parts.sort((x, y) => y.n - x.n || (x.many < y.many ? -1 : x.many > y.many ? 1 : 0));
  const total = b - a + 1;
  if (parts.length === 1) {
    const only = parts[0];
    return `${count(total, 'line', 'lines')} (${only === undefined ? 'other' : total === 1 ? only.one : only.many})`;
  }
  const shown = parts.slice(0, MAX_GAP_PARTS);
  const rest = parts.slice(MAX_GAP_PARTS).reduce((s, p) => s + p.n, 0);
  const text = shown.map((p) => count(p.n, p.one, p.many));
  if (rest > 0) text.push(count(rest, 'other line', 'other lines'));
  return `${count(total, 'line', 'lines')} (${text.join(', ')})`;
}

function hiddenMembers(view: RenderView, sel: Uint8Array): Uint8Array {
  const hidden = new Uint8Array(view.groups.length);
  for (let i = 0; i < sel.length; i++) {
    const g = view.groupOf[i] ?? -1;
    if (g >= 0 && sel[i] === 0) hidden[g] = 1;
  }
  return hidden;
}

/**
 * Renders the selected lines (1 = shown) with run, omission and repeat markers.
 * `top` lines go right after the summary lines. Gap descriptions are cached.
 */
export function renderSelection(
  view: RenderView,
  sel: Uint8Array,
  marker: string,
  top: readonly string[],
  cache: Map<string, string>,
): Rendered {
  const lines = view.lines;
  const n = lines.length;
  const out: string[] = [...view.summarize(sel), ...top];
  let shown = 0;
  for (let i = 0; i < n; i++) shown += sel[i] === 1 ? 1 : 0;
  if (shown === n) {
    if (out.length === 0) return { text: lines.join('\n'), shown, lossyBlocks: 0, repeatBlocks: 0, formatOnly: true };
    out.push(`${marker} ${lref(1, n)}`);
    return { text: [...out, ...lines].join('\n'), shown, lossyBlocks: 0, repeatBlocks: 0, formatOnly: true };
  }
  const hidden = hiddenMembers(view, sel);
  const isBlock = (i: number): boolean => {
    const g = view.groupOf[i] ?? -1;
    return g >= 0 && view.groups[g]?.first === i && hidden[g] === 1;
  };
  let lossyBlocks = 0;
  let repeatBlocks = 0;
  let i = 0;
  while (i < n) {
    if (sel[i] === 1 && isBlock(i)) {
      const g = view.groups[view.groupOf[i] ?? 0];
      repeatBlocks++;
      if (g !== undefined && !g.identical) lossyBlocks++;
      out.push(`${marker} repeated ×${g?.count ?? 0} ${g?.where ?? ''}, ${g?.how ?? ''}; first occurrence (L${i + 1}):`);
      out.push(lines[i] ?? '');
      i++;
    } else if (sel[i] === 1) {
      let j = i;
      while (j + 1 < n && sel[j + 1] === 1 && !isBlock(j + 1)) j++;
      out.push(`${marker} ${lref(i + 1, j + 1)}`);
      for (let k = i; k <= j; k++) out.push(lines[k] ?? '');
      i = j + 1;
    } else {
      let j = i;
      while (j + 1 < n && sel[j + 1] !== 1) j++;
      const key = `${i}:${j}`;
      let desc = cache.get(key);
      if (desc === undefined) {
        desc = describeGap(view, i, j);
        cache.set(key, desc);
      }
      out.push(`${marker} ${lref(i + 1, j + 1)} omitted: ${desc}`);
      i = j + 1;
    }
  }
  return { text: out.join('\n'), shown, lossyBlocks, repeatBlocks, formatOnly: false };
}
