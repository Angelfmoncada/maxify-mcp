import { estimateTokens } from '../core/tokens.js';
import { whereText } from './markers.js';
import type { RepeatGroup } from './plan.js';
import { differenceWording, templateOf } from './template.js';

const MAX_TRACKED_RANGES = 4;
/** A repeat marker costs ~15 tokens; grouping must save more than that. */
export const MIN_GROUP_SAVINGS = 20;

interface Acc {
  first: number;
  last: number;
  count: number;
  identical: boolean;
  template: string;
  ranges: Array<[number, number]>;
  overflow: boolean;
}

function track(acc: Acc, i: number): void {
  const n = i + 1;
  const cur = acc.ranges[acc.ranges.length - 1];
  if (cur !== undefined && cur[1] === n - 1) {
    cur[1] = n;
  } else if (acc.ranges.length < MAX_TRACKED_RANGES) {
    acc.ranges.push([n, n]);
  } else {
    acc.overflow = true;
  }
}

function toGroup(acc: Acc): RepeatGroup {
  return {
    first: acc.first,
    last: acc.last,
    count: acc.count,
    identical: acc.identical,
    where: whereText(acc.ranges, MAX_TRACKED_RANGES, acc.overflow, acc.first + 1, acc.last + 1),
    how: differenceWording(acc.identical, acc.template),
  };
}

export interface GroupBuild {
  groupOf: Int32Array;
  groups: RepeatGroup[];
}

/**
 * Groups eligible lines by normalized template (consecutive or not). A group
 * needs >= 3 members and must save at least `minSavings` tokens (first and
 * last occurrences stay visible).
 */
export function templateGroups(
  lines: readonly string[],
  eligible: (i: number) => boolean,
  minSavings = MIN_GROUP_SAVINGS,
): GroupBuild {
  const n = lines.length;
  const accOf = new Int32Array(n).fill(-1);
  const accs: Acc[] = [];
  const byTemplate = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    if (!eligible(i)) continue;
    const line = lines[i] ?? '';
    const template = templateOf(line);
    if (template.length === 0) continue;
    let id = byTemplate.get(template);
    if (id === undefined) {
      id = accs.length;
      byTemplate.set(template, id);
      accs.push({ first: i, last: i, count: 0, identical: true, template, ranges: [], overflow: false });
    }
    const acc = accs[id];
    if (acc === undefined) continue;
    if (acc.count > 0 && acc.identical && line !== lines[acc.first]) acc.identical = false;
    acc.count++;
    acc.last = i;
    track(acc, i);
    accOf[i] = id;
  }
  const accToGroup = new Int32Array(accs.length).fill(-1);
  const groups: RepeatGroup[] = [];
  accs.forEach((acc, id) => {
    if (acc.count < 3) return;
    const cost = estimateTokens(lines[acc.first] ?? '') + 1;
    if (cost * (acc.count - 2) < minSavings) return;
    accToGroup[id] = groups.length;
    groups.push(toGroup(acc));
  });
  const groupOf = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const id = accOf[i] ?? -1;
    if (id >= 0) groupOf[i] = accToGroup[id] ?? -1;
  }
  return { groupOf, groups };
}

/** Groups of identical texts among the given (sorted) line indices. */
export function identicalGroups(
  lines: readonly string[],
  indices: readonly number[],
): { firsts: number[]; members: Map<number, number[]> } {
  const byText = new Map<string, number[]>();
  for (const i of indices) {
    const text = lines[i] ?? '';
    const list = byText.get(text);
    if (list === undefined) byText.set(text, [i]);
    else list.push(i);
  }
  const firsts: number[] = [];
  const members = new Map<number, number[]>();
  for (const list of byText.values()) {
    const first = list[0];
    if (first === undefined) continue;
    firsts.push(first);
    if (list.length > 1) members.set(first, list);
  }
  firsts.sort((a, b) => a - b);
  return { firsts, members };
}

/** RepeatGroup for identical occurrences (sorted 0-based indices). */
export function identicalGroup(indices: readonly number[]): RepeatGroup {
  const acc: Acc = {
    first: indices[0] ?? 0,
    last: indices[indices.length - 1] ?? 0,
    count: indices.length,
    identical: true,
    template: '',
    ranges: [],
    overflow: false,
  };
  for (const i of indices) track(acc, i);
  return toGroup(acc);
}
