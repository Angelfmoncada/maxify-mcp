/**
 * Best-effort test-runner patterns. Each framework says which lines are
 * passing/skipped tests, runner noise, failure markers, and where failure
 * blocks (header through assertion message, diff, code frame, frames) start
 * and end.
 */

export type FrameworkName = 'vitest' | 'jest' | 'mocha' | 'node:test' | 'tap' | 'pytest' | 'go test' | 'playwright' | 'unknown';

export interface Framework {
  name: FrameworkName;
  /** Distinctive summary/runner lines (3 points each). */
  strong: readonly RegExp[];
  /** Weaker hints (1 point each). */
  markers: readonly RegExp[];
  pass: readonly RegExp[];
  skip: readonly RegExp[];
  noise: readonly RegExp[];
  /** Extra failure markers (critical) for this framework. */
  failure: readonly RegExp[];
  blockStart: readonly RegExp[];
  blockEnd: readonly RegExp[];
  /** Blocks are only recognized after a line matching this (pytest FAILURES, mocha "N failing"). */
  regionStart?: RegExp;
  /** A block also ends at the first non-blank line indented <= its header. */
  indentBlock?: boolean;
  /** Indented lines right after a passing test belong to it (TAP YAML, node:test details). */
  passDetails?: boolean;
  /** Test file (group 1) and optional explicit passing count (group 2). */
  file?: RegExp;
}

const TEST_FILE = String.raw`[\w./\\@-]+\.(?:test|spec)\.[cm]?[jt]sx?`;

const VITEST: Framework = {
  name: 'vitest',
  strong: [/^\s*Test Files\s+\d/, /^\s*Tests\s+\d+\s+(?:passed|failed)/, /^\s*RUN\s+v\d/],
  markers: [/⎯{4,}/, /^\s*Duration\s+\d/, /^\s*[✓❯×]\s+\S+\.(?:test|spec)\.[cm]?[jt]sx?\s+\(\d+ tests?/],
  pass: [/^\s*✓\s/],
  skip: [/^\s*↓\s/],
  noise: [],
  failure: [/^\s*FAIL\s+\S/],
  blockStart: [/^\s*FAIL\s+\S/],
  blockEnd: [/^\s*⎯{3,}/, /^\s*Test Files\s/],
  file: new RegExp(String.raw`^\s*[✓❯×↓]\s+(${TEST_FILE})(?:\s+\((\d+) tests?\)\s)?`),
};

const JEST: Framework = {
  name: 'jest',
  strong: [/^Test Suites:\s/, /^Tests:\s+\d/, /^Ran all test suites/],
  markers: [new RegExp(String.raw`^\s*(?:PASS|FAIL)\s+${TEST_FILE}`), /^\s*●\s/],
  pass: [/^\s*[✓√]\s/, /^\s*PASS\s+\S/],
  skip: [/^\s*[○✎]\s/],
  noise: [],
  failure: [/^\s*●\s+(?!Console\b)\S/, /^\s*FAIL\s+\S/],
  blockStart: [/^\s*●\s+(?!Console\b)\S/],
  blockEnd: [/^\s*(?:PASS|FAIL)\s+\S/, /^Test Suites:/, /^\s*●\s+Console\b/, /^Summary of all failing tests/],
  file: /^\s*(?:PASS|FAIL)\s+(\S+)/,
};

const MOCHA: Framework = {
  name: 'mocha',
  strong: [/^\s*\d+ passing \(\d/],
  markers: [/^\s*\d+ failing\s*$/, /^\s*\d+ pending\s*$/],
  pass: [/^\s*[✓✔√]\s/],
  skip: [/^\s+-\s\S/],
  noise: [],
  failure: [/^\s+\d+\) \S/],
  blockStart: [/^\s+\d+\) \S/],
  blockEnd: [],
  regionStart: /^\s*\d+ failing\s*$/,
};

const NODE_TEST: Framework = {
  name: 'node:test',
  strong: [/^\s*ℹ (?:tests|pass|fail) \d/],
  markers: [/^\s*ℹ (?:suites|duration_ms) \d/, /^\s*▶ \S/, /^\s*✔ .*\(\d+(?:\.\d+)?ms\)$/],
  pass: [/^\s*✔\s/],
  skip: [/^\s*﹣\s/, /# SKIP\b/],
  noise: [/^\s*▶\s/],
  failure: [/^\s*✖\s/],
  blockStart: [/^\s*✖\s(?!failing tests:)/],
  blockEnd: [/^\s*[✔✖▶ℹ]\s/],
  indentBlock: true,
  passDetails: true,
};

const TAP: Framework = {
  name: 'tap',
  strong: [/^TAP version \d+/, /^# (?:tests|pass|fail) \d+/],
  markers: [/^\s*(?:not )?ok \d+ - /, /^\s*1\.\.\d+$/],
  pass: [/^\s*ok \d+\b(?!.*#\s*(?:SKIP|TODO))/i],
  skip: [/^\s*ok \d+.*#\s*(?:SKIP|TODO)/i],
  noise: [/^\s*# Subtest: /],
  failure: [/^\s*not ok \d+/],
  blockStart: [/^\s*not ok \d+/],
  blockEnd: [/^\s*(?:not )?ok \d+/, /^\s*# Subtest:/, /^#\s*(?:tests|pass|fail)\b/, /^\s*1\.\.\d+$/],
  passDetails: true,
};

const PYTEST: Framework = {
  name: 'pytest',
  strong: [/^=+ test session starts =+$/, /^=+ short test summary info =+$/, /^=+ (?:FAILURES|ERRORS) =+$/],
  markers: [/^collected \d+ items?/, /^(?:FAILED|ERROR) \S+::/, /^\S+\.py\s+[.FEsxX]+\s*\[\s*\d+%\]$/],
  pass: [/^\S+\.py\s+[.sxX]*\.[.sxX]*\s*(?:\[\s*\d+%\])?$/, /::\S+ PASSED\b/],
  skip: [/::\S+ SKIPPED\b/],
  noise: [],
  failure: [/^E\s+\S/, /^\S+\.py\s+[.sxX]*[FE][.FEsxX]*\s*(?:\[\s*\d+%\])?$/, /^_{3,} .+ _{3,}$/],
  blockStart: [/^_{3,} .+ _{3,}$/],
  blockEnd: [/^=+ .+ =+$/],
  regionStart: /^=+ (?:FAILURES|ERRORS) =+$/,
  file: /^(\S+\.py)\s+[.FEsxX]+/,
};

const GO: Framework = {
  name: 'go test',
  strong: [/^\s*--- (?:PASS|FAIL|SKIP): Test/, /^(?:ok|FAIL)\s+\S+\s+(?:\d+(?:\.\d+)?s|\(cached\))/],
  markers: [/^=== RUN\s+Test/, /^(?:PASS|FAIL)$/],
  pass: [/^\s*--- PASS: /, /^ok\s+\S+\s/],
  skip: [/^\s*--- SKIP: /],
  noise: [/^=== (?:RUN|PAUSE|CONT|NAME)\s/],
  failure: [/^\s*--- FAIL: /, /^panic: /, /^FAIL\s+\S+/],
  blockStart: [/^\s*--- FAIL: /, /^panic: /],
  blockEnd: [/^\s*--- (?:PASS|FAIL|SKIP): /, /^=== RUN/, /^(?:ok|FAIL)\s+\S+/, /^(?:PASS|FAIL)$/, /^exit status \d+/],
  file: /^(?:ok|FAIL)\s+(\S+)/,
};

const PLAYWRIGHT: Framework = {
  name: 'playwright',
  strong: [/^Running \d+ tests? using \d+ workers?/],
  markers: [/^\s*[✓✘]\s+\d+ \[[\w-]+\] › /, /^\s+\d+\) \[[\w-]+\] › /],
  pass: [/^\s*[✓✔]\s+\d+ /],
  skip: [/^\s*-\s+\d+ \[/],
  noise: [],
  failure: [/^\s+\d+\) \[[^\]]+\] › /, /^\s+\[[^\]]+\] › \S/],
  blockStart: [/^\s+\d+\) \[[^\]]+\] › /],
  blockEnd: [/^\s*\d+ (?:failed|passed|flaky|skipped|did not run|interrupted)\b/],
  file: new RegExp(String.raw`› (${TEST_FILE}):\d+:\d+ ›`),
};

const UNKNOWN: Framework = {
  name: 'unknown',
  strong: [],
  markers: [],
  pass: [/^\s*[✓✔√]\s/, /\bPASS(?:ED)?\b/],
  skip: [],
  noise: [],
  failure: [],
  blockStart: [],
  blockEnd: [],
};

export const FRAMEWORKS: readonly Framework[] = [VITEST, JEST, MOCHA, NODE_TEST, TAP, PYTEST, GO, PLAYWRIGHT];

/** Strong hits count 3, weak hits 1; detectKind needs >= 3 (one strong line or three hints). */
export const TEST_DETECT_SCORE = 3;
/** Stop scoring once this is reached (enough evidence; keeps detection fast). */
const SCORE_CAP = 60;

function score(fw: Framework, sample: readonly string[]): number {
  let total = 0;
  for (const line of sample) {
    if (matchesAny(line, fw.strong)) total += 3;
    else if (matchesAny(line, fw.markers)) total += 1;
    if (total >= SCORE_CAP) break;
  }
  return total;
}

/** Framework with the highest marker score in the sampled lines (ties: table order). */
export function detectFramework(sample: readonly string[]): Framework {
  let best = UNKNOWN;
  let bestScore = 0;
  for (const fw of FRAMEWORKS) {
    const s = score(fw, sample);
    if (s > bestScore) {
      best = fw;
      bestScore = s;
    }
  }
  return best;
}

/** Best framework score (used by detectKind). */
export function testMarkerScore(sample: readonly string[]): number {
  return FRAMEWORKS.reduce((best, fw) => Math.max(best, score(fw, sample)), 0);
}

export function matchesAny(line: string, patterns: readonly RegExp[]): boolean {
  for (const re of patterns) if (re.test(line)) return true;
  return false;
}
