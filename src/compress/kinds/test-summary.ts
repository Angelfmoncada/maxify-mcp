import { F_FAILURE, F_SUMMARY } from '../classify.js';
import type { Framework } from './frameworks.js';

export interface Counts {
  passed?: number;
  failed?: number;
  errors?: number;
  skipped?: number;
  flaky?: number;
  cancelled?: number;
  total?: number;
  /** 0-based line the counts come from (last one used). */
  source?: number;
}

type CountKey = Exclude<keyof Counts, 'source'>;

const WORD_KEY: Readonly<Record<string, CountKey>> = {
  passed: 'passed',
  passing: 'passed',
  pass: 'passed',
  failed: 'failed',
  failing: 'failed',
  fail: 'failed',
  error: 'errors',
  errors: 'errors',
  skipped: 'skipped',
  pending: 'skipped',
  todo: 'skipped',
  flaky: 'flaky',
  cancelled: 'cancelled',
  total: 'total',
  tests: 'total',
};

const NUM_WORD = /(\d+)\s+(passed|passing|failed|failing|errors?|skipped|pending|todo|total|flaky|cancelled)\b/gi;
const WORD_NUM = /^\s*[#ℹ]\s*(tests|pass|fail|skipped|todo|cancelled)\s+(\d+)/i;
const TESTS_LINE = /^\s*Tests:?\s+\d/;

function parseLine(line: string): Partial<Record<CountKey, number>> {
  const out: Partial<Record<CountKey, number>> = {};
  const wn = WORD_NUM.exec(line);
  if (wn !== null) {
    const key = WORD_KEY[(wn[1] ?? '').toLowerCase()];
    if (key !== undefined) out[key] = Number(wn[2]);
    return out;
  }
  NUM_WORD.lastIndex = 0;
  for (let m = NUM_WORD.exec(line); m !== null; m = NUM_WORD.exec(line)) {
    const key = WORD_KEY[(m[2] ?? '').toLowerCase()];
    if (key !== undefined) out[key] = (out[key] ?? 0) + Number(m[1]);
  }
  return out;
}

function goCounts(lines: readonly string[]): Counts {
  let failed = 0;
  let passed = 0;
  let skipped = 0;
  let source: number | undefined;
  lines.forEach((line, i) => {
    if (/^\s*--- FAIL: /.test(line)) failed++;
    else if (/^\s*--- PASS: /.test(line)) passed++;
    else if (/^\s*--- SKIP: /.test(line)) skipped++;
    if (/^(?:ok|FAIL)\s+\S+/.test(line)) source = i;
  });
  return { failed, passed, skipped, ...(source === undefined ? {} : { source }) };
}

/** Test counts from summary lines (vitest/jest prefer the "Tests" line). */
export function parseCounts(lines: readonly string[], flags: Uint16Array, fw: Framework): Counts {
  if (fw.name === 'go test') return goCounts(lines);
  const preferTests = fw.name === 'vitest' || fw.name === 'jest';
  let counts: Counts = {};
  let testsLine: Counts | undefined;
  for (let i = 0; i < lines.length; i++) {
    if (((flags[i] ?? 0) & F_SUMMARY) === 0) continue;
    const line = lines[i] ?? '';
    const parsed = parseLine(line);
    if (Object.keys(parsed).length === 0) continue;
    if (preferTests && TESTS_LINE.test(line)) testsLine = { ...parsed, source: i };
    counts = { ...counts, ...parsed, source: i };
  }
  return testsLine ?? counts;
}

function describeCounts(c: Counts): string {
  const parts: string[] = [`${c.failed ?? 0} failed`];
  if (c.errors !== undefined && c.errors > 0) parts.push(`${c.errors} ${c.errors === 1 ? 'error' : 'errors'}`);
  if (c.cancelled !== undefined && c.cancelled > 0) parts.push(`${c.cancelled} cancelled`);
  if (c.passed !== undefined) parts.push(`${c.passed} passed`);
  if (c.flaky !== undefined && c.flaky > 0) parts.push(`${c.flaky} flaky`);
  if (c.skipped !== undefined && c.skipped > 0) parts.push(`${c.skipped} skipped`);
  if (c.total !== undefined) parts.push(`${c.total} total`);
  return parts.join(', ');
}

/**
 * First body line. Never claims success while any failure marker exists.
 */
export function statusLine(lines: readonly string[], flags: Uint16Array, fw: Framework): string {
  const counts = parseCounts(lines, flags, fw);
  let markers = 0;
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (((flags[i] ?? 0) & F_FAILURE) === 0) continue;
    markers++;
    if (first < 0) first = i;
  }
  const failing = (counts.failed ?? 0) + (counts.errors ?? 0) + (counts.cancelled ?? 0);
  const where = counts.source === undefined ? fw.name : `${fw.name}, L${counts.source + 1}`;
  const hasCounts = counts.passed !== undefined || counts.failed !== undefined || counts.total !== undefined;
  if (failing > 0) return `summary: FAILED — ${describeCounts(counts)} (${where})`;
  if (markers > 0) {
    return hasCounts
      ? `summary: FAILURE MARKERS FOUND — ${markers} failure lines (first at L${first + 1}); the test summary reports ${describeCounts(counts)} (${where})`
      : `summary: FAILED — failure markers found: ${markers} lines (first at L${first + 1}); no test summary line (${fw.name})`;
  }
  if ((counts.passed ?? 0) > 0) return `summary: PASSED — ${describeCounts(counts)} (${where})`;
  return `summary: no failure markers and no test counts found (${fw.name})`;
}

interface FileCount {
  tests: number;
  explicit?: number;
  passLine: boolean;
}

export interface PassTally {
  files: Map<string, FileCount>;
  unattributed: number;
}

export function newTally(): PassTally {
  return { files: new Map(), unattributed: 0 };
}

function entry(tally: PassTally, file: string): FileCount {
  let e = tally.files.get(file);
  if (e === undefined) {
    e = { tests: 0, passLine: false };
    tally.files.set(file, e);
  }
  return e;
}

/** Records one passing line; `file` is the attributed test file or package. */
export function tallyPass(tally: PassTally, file: string | undefined, explicit?: number, passLine = false): void {
  if (file === undefined) {
    tally.unattributed++;
    return;
  }
  const e = entry(tally, file);
  if (explicit !== undefined) e.explicit = (e.explicit ?? 0) + explicit;
  else if (passLine) e.passLine = true;
  else e.tests++;
}

/** Moves unattributed passes to `file` (go: passes are attributed at the package line). */
export function attributePending(tally: PassTally, file: string): void {
  if (tally.unattributed === 0) return;
  entry(tally, file).tests += tally.unattributed;
  tally.unattributed = 0;
}

export function passSummary(tally: PassTally, maxFiles = 5): string | undefined {
  const items = [...tally.files.entries()].map(([file, c]) => {
    const n = c.explicit ?? c.tests;
    return { file, n, text: n > 0 ? `${file} ${n}` : `${file} (all passed)` };
  });
  if (items.length === 0 && tally.unattributed === 0) return undefined;
  const total = items.reduce((s, x) => s + x.n, 0) + tally.unattributed;
  const shown = items.slice(0, maxFiles).map((x) => x.text);
  if (items.length > maxFiles) shown.push(`+${items.length - maxFiles} more files`);
  if (tally.unattributed > 0 && items.length > 0) shown.push(`${tally.unattributed} without file`);
  const byFile = shown.length > 0 ? ` by file: ${shown.join(', ')}` : '';
  return `summary: passing tests omitted: ${total}${items.length > 0 ? ` in ${items.length} files` : ''}${byFile}`;
}
