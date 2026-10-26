import {
  F_BLANK,
  F_DETAIL,
  F_DIFF,
  F_EXIT,
  F_FAILURE,
  F_FRAME,
  F_LIBFRAME,
  F_SUMMARY,
  P_FRAME,
  hasFocus,
  lineFlags,
  markCritical,
} from '../classify.js';
import { templateGroups } from '../groups.js';
import { BASE_LABELS, NEVER, R_BLANK, R_CRITICAL, R_LIBFRAME, type LinePlan, type ReasonLabel } from '../plan.js';
import { detectFramework, matchesAny, type Framework } from './frameworks.js';
import { layoutLog, warningSummary } from './log.js';
import { attributePending, newTally, passSummary, statusLine, tallyPass, type PassTally } from './test-summary.js';

const K_OTHER = 0;
const K_PASS = 1;
const K_SKIP = 2;
const K_NOISE = 3;
const K_PASS_DETAIL = 4;
const K_BLOCK = 5;
const K_HEADER = 6;
const K_SEPARATOR = 7;
const K_SUITE = 8;

const R_PASS = BASE_LABELS.length;
const R_SKIP = R_PASS + 1;
const R_NOISE = R_PASS + 2;
const R_PASS_DETAIL = R_PASS + 3;
const R_SEPARATOR = R_PASS + 4;
const R_SUITE = R_PASS + 5;

const TEST_LABELS: readonly ReasonLabel[] = [
  ...BASE_LABELS,
  { one: 'passing test', many: 'passing tests' },
  { one: 'skipped test', many: 'skipped tests' },
  { one: 'test runner progress line', many: 'test runner progress lines' },
  { one: 'passing-test detail line', many: 'passing-test detail lines' },
  { one: 'separator line', many: 'separator lines' },
  { one: 'suite header of passing tests', many: 'suite headers of passing tests' },
];

const PASSING_CHILD = new Set([K_PASS, K_SKIP, K_NOISE, K_PASS_DETAIL, K_SUITE]);

const SEPARATOR = /^\s*[⎯─━═=_\-*~·]{6,}(?:\[\d+\/\d+\][⎯─━═=_\-*~·]*)?\s*$/;
const CODE_POINTER = /^\s*\|\s*\^+\s*$/;
const CODE_LINE_MARK = /^\s*>\s*\d+\s*\|/;
const NOT_FAILURE = ~(F_FAILURE | F_DETAIL | F_EXIT | F_DIFF);
const SAMPLE_LINES = 2000;

function indentOf(line: string): number {
  const m = /^[ \t]*/.exec(line);
  return m === null ? 0 : m[0].length;
}

/** Failure blocks: header (K_HEADER) and body (K_BLOCK) lines. */
function markBlocks(lines: readonly string[], fw: Framework, kind: Uint8Array): void {
  let region = fw.regionStart === undefined;
  let open = false;
  let headerIndent = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!region) {
      region = fw.regionStart?.test(line) === true;
      continue;
    }
    if (matchesAny(line, fw.blockStart)) {
      open = true;
      headerIndent = indentOf(line);
      kind[i] = K_HEADER;
      continue;
    }
    if (!open) continue;
    const blank = line.trim().length === 0;
    if (matchesAny(line, fw.blockEnd) || (fw.indentBlock === true && !blank && indentOf(line) <= headerIndent)) {
      open = false;
      continue;
    }
    kind[i] = K_BLOCK;
  }
}

/** go test -v prints a failing test's messages BEFORE its "--- FAIL" line; attribute them. */
function markGoTests(lines: readonly string[], kind: Uint8Array): void {
  const runAt = new Map<string, number>();
  lines.forEach((line, i) => {
    const run = /^=== RUN\s+(\S+)/.exec(line);
    if (run !== null) {
      runAt.set(run[1] ?? '', i);
      return;
    }
    const end = /^\s*--- (FAIL|PASS|SKIP): (\S+)/.exec(line);
    if (end === null) return;
    const start = runAt.get(end[2] ?? '');
    if (start === undefined) return;
    const target = end[1] === 'FAIL' ? K_BLOCK : K_PASS_DETAIL;
    for (let k = start + 1; k < i; k++) {
      if (kind[k] === K_OTHER && /^\s{4,}\S/.test(lines[k] ?? '')) kind[k] = target;
    }
  });
}

function markPasses(lines: readonly string[], fw: Framework, kind: Uint8Array, flags: Uint16Array, focus: readonly string[]): void {
  let passIndent = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const f = flags[i] ?? 0;
    if (kind[i] !== K_OTHER) {
      passIndent = -1;
      continue;
    }
    if (passIndent >= 0) {
      if ((f & F_BLANK) !== 0 || indentOf(line) > passIndent) {
        // Failure words inside a passing test's details stay visible (never hide a failure).
        if ((f & F_FAILURE) === 0) kind[i] = K_PASS_DETAIL;
        continue;
      }
      passIndent = -1;
    }
    if (hasFocus(line, focus)) continue;
    const summary = (f & F_SUMMARY) !== 0 && !(fw.name === 'go test' && /^ok\s/.test(line));
    if (summary) continue;
    if (SEPARATOR.test(line)) kind[i] = K_SEPARATOR;
    else if (matchesAny(line, fw.pass) && (fw.name !== 'unknown' || (f & F_FAILURE) === 0)) {
      kind[i] = K_PASS;
      if (fw.passDetails === true) passIndent = indentOf(line);
    } else if (matchesAny(line, fw.skip)) {
      kind[i] = K_SKIP;
      if (fw.passDetails === true) passIndent = indentOf(line);
    } else if (matchesAny(line, fw.noise)) kind[i] = K_NOISE;
  }
}

/**
 * Suite/describe headers whose indented children are all passing (or skipped)
 * tests carry no failure evidence: they are counted like passing tests.
 * Bottom-up, so nested suites resolve before their parents.
 */
function markPassingSuites(lines: readonly string[], fw: Framework, kind: Uint8Array, flags: Uint16Array): void {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? '';
    const f = flags[i] ?? 0;
    if (kind[i] !== K_OTHER || (f & (F_BLANK | F_SUMMARY)) !== 0 || matchesAny(line, fw.failure)) continue;
    const indent = indentOf(line);
    let children = 0;
    let passing = true;
    for (let j = i + 1; j < lines.length; j++) {
      const child = lines[j] ?? '';
      if (child.trim().length === 0) continue;
      if (indentOf(child) <= indent) break;
      if (!PASSING_CHILD.has(kind[j] ?? K_OTHER)) {
        passing = false;
        break;
      }
      children++;
    }
    if (passing && children > 0) kind[i] = K_SUITE;
  }
}

function adjustFlags(lines: readonly string[], fw: Framework, kind: Uint8Array, flags: Uint16Array): Uint16Array {
  const out = flags.slice();
  for (let i = 0; i < lines.length; i++) {
    const k = kind[i] ?? K_OTHER;
    const line = lines[i] ?? '';
    if (k === K_PASS_DETAIL && ((out[i] ?? 0) & F_FAILURE) !== 0) continue;
    if (PASSING_CHILD.has(k) || k === K_SEPARATOR) {
      out[i] = (out[i] ?? 0) & NOT_FAILURE & ~F_SUMMARY;
      continue;
    }
    if (k === K_HEADER || matchesAny(line, fw.failure)) out[i] = (out[i] ?? 0) | F_FAILURE;
    if (k === K_BLOCK && CODE_LINE_MARK.test(line)) out[i] = (out[i] ?? 0) | F_DETAIL;
    if (k === K_BLOCK && CODE_POINTER.test(line) && i > 0) out[i - 1] = (out[i - 1] ?? 0) | F_DETAIL;
  }
  if (fw.name === 'go test') {
    lines.forEach((line, i) => {
      if (/^ok\s/.test(line)) out[i] = (out[i] ?? 0) & ~F_SUMMARY;
    });
  }
  return out;
}

function tallyPasses(lines: readonly string[], fw: Framework, kind: Uint8Array): PassTally {
  const tally = newTally();
  let current: string | undefined;
  lines.forEach((line, i) => {
    const m = fw.file?.exec(line) ?? null;
    if (fw.name === 'go test') {
      if (m !== null) attributePending(tally, m[1] ?? '');
      if (m !== null && /^ok\s/.test(line)) tallyPass(tally, m[1], undefined, true);
      if (/^\s*--- PASS: /.test(line)) tallyPass(tally, undefined);
      return;
    }
    if (fw.name === 'pytest' && m !== null) {
      const dots = (/^\S+\.py\s+([.FEsxX]+)/.exec(line)?.[1] ?? '').split('').filter((c) => c === '.').length;
      if (dots > 0) tallyPass(tally, m[1], dots);
      return;
    }
    if (m !== null) current = m[1];
    if (kind[i] !== K_PASS) return;
    if (m !== null && m[2] !== undefined) tallyPass(tally, m[1], Number(m[2]));
    else if (fw.name === 'jest' && /^\s*PASS\s/.test(line)) tallyPass(tally, m?.[1], undefined, true);
    else tallyPass(tally, m?.[1] ?? current);
  });
  return tally;
}

function layoutOthers(plan: { tier: Uint8Array; reason: Uint8Array }, kind: Uint8Array, flags: Uint16Array, crit: Uint8Array): void {
  const reasonOf: Record<number, number> = {
    [K_PASS]: R_PASS,
    [K_SKIP]: R_SKIP,
    [K_NOISE]: R_NOISE,
    [K_PASS_DETAIL]: R_PASS_DETAIL,
    [K_SEPARATOR]: R_SEPARATOR,
    [K_SUITE]: R_SUITE,
  };
  for (let i = 0; i < kind.length; i++) {
    const k = kind[i] ?? K_OTHER;
    if (k === K_OTHER) continue;
    const f = flags[i] ?? 0;
    if ((crit[i] ?? 0) > 0) plan.reason[i] = R_CRITICAL;
    else if (k === K_BLOCK || k === K_HEADER) {
      if ((f & F_BLANK) !== 0) plan.reason[i] = R_BLANK;
      else if ((f & F_LIBFRAME) !== 0) plan.reason[i] = R_LIBFRAME;
      else plan.tier[i] = 0;
    } else {
      plan.reason[i] = reasonOf[k] ?? 0;
    }
  }
}

function sample(lines: readonly string[]): readonly string[] {
  if (lines.length <= SAMPLE_LINES * 2) return lines;
  return [...lines.slice(0, SAMPLE_LINES), ...lines.slice(-SAMPLE_LINES)];
}

/** Plan for test-runner output. */
export function planTest(lines: readonly string[], focus: readonly string[]): LinePlan {
  const n = lines.length;
  const fw = detectFramework(sample(lines));
  const rawFlags = new Uint16Array(n);
  for (let i = 0; i < n; i++) rawFlags[i] = lineFlags(lines[i] ?? '');
  const kind = new Uint8Array(n);
  markBlocks(lines, fw, kind);
  if (fw.name === 'go test') markGoTests(lines, kind);
  markPasses(lines, fw, kind, rawFlags, focus);
  markPassingSuites(lines, fw, kind, rawFlags);
  const flags = adjustFlags(lines, fw, kind, rawFlags);
  const crit = markCritical(lines, flags, { focus });
  // Failure blocks are kept verbatim: body lines are critical (lowest priority),
  // except blanks, library frames and project frames beyond the first few.
  for (let i = 0; i < n; i++) {
    const f = flags[i] ?? 0;
    if (kind[i] === K_BLOCK && crit[i] === 0 && (f & (F_BLANK | F_LIBFRAME | F_FRAME)) === 0) crit[i] = P_FRAME;
  }
  const eligible = (i: number): boolean =>
    kind[i] === K_OTHER && (crit[i] ?? 0) === 0 && ((flags[i] ?? 0) & (F_BLANK | F_LIBFRAME)) === 0;
  const { groupOf, groups } = templateGroups(lines, eligible);
  const layout = layoutLog(
    lines,
    flags,
    crit,
    groupOf,
    (g) => groups[g]?.first ?? -1,
    (g) => groups[g]?.last ?? -1,
    (i) => kind[i] !== K_OTHER,
  );
  layoutOthers(layout, kind, flags, crit);
  const status = statusLine(lines, flags, fw);
  const passes = passSummary(tallyPasses(lines, fw, kind));
  const summarize = (sel: Uint8Array): string[] => {
    const out = [status];
    if (passes !== undefined) out.push(passes);
    const warn = warningSummary(flags, sel);
    if (warn !== undefined) out.push(warn);
    return out;
  };
  const passLines = kind.reduce((s, k) => s + (k === K_PASS ? 1 : 0), 0);
  return {
    lines,
    crit,
    tier: layout.tier,
    order: layout.order,
    reason: layout.reason,
    labels: TEST_LABELS,
    groupOf,
    groups,
    summarize,
    lossy: passLines > 0,
    notes: [`test framework: ${fw.name}`, `${passLines} passing-test lines summarized as counts`],
  };
}
