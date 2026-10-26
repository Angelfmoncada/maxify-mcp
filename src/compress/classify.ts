/**
 * Shared line classification: which lines are failures, summaries, details,
 * warnings or stack frames. Stateless per line; kinds add context rules.
 */

export const F_FAILURE = 1;
export const F_SUMMARY = 2;
export const F_DETAIL = 4;
export const F_EXIT = 8;
export const F_WARNING = 16;
export const F_FRAME = 32;
export const F_LIBFRAME = 64;
export const F_DIFF = 128;
export const F_BLANK = 256;

/** Critical priorities (lower = more important); 0 = not critical. */
export const P_NONE = 0;
export const P_FAILURE = 1;
export const P_DETAIL = 2;
export const P_FRAME = 3;

const FAILURE_WORD =
  /\b(?:errors?|fail(?:s|ed|ing|ures?)?|exceptions?|panic(?:ked|s)?|fatal|traceback|assert|segmentation fault|core dumped|killed|aborted|timed out|unhandled|uncaught|out of memory)\b/gi;
const ZERO_BEFORE = /(?:^|[^\w.])(?:0|no|zero|without)\s+$/i;
const ZERO_AFTER = /^\s*[:=]?\s*0(?![\d.])/;
/**
 * Case-sensitive markers: error classes used as error labels ("TypeError:",
 * "AssertionError [ERR_ASSERTION]", "…NullPointerException" at line end, not
 * "use DOMException instead"), errno codes, npm ERR!.
 */
const ERROR_CLASS = /\b[A-Z][A-Za-z]*(?:Error|Exception)(?=:|\s*\[|\s*$)/;
const FAILURE_CS = /\bE(?:NOENT|ACCES|ADDRINUSE|CONNREFUSED|CONNRESET|PERM|TIMEDOUT|EXIST|NOTFOUND|PIPE)\b|\bERR!/;
/** Prefix-only markers ("npm ERR!") are weaker evidence than failure words. */
const PREFIX_ONLY = /\bERR!/g;
const FAILURE_CI =
  /^\s*not ok\b|^\s*[✗✕×✖✘](?:\s|$)|command not found|cannot find module|can'?t resolve|could not resolve|permission denied|no such file or directory/i;
const FAILURE_QUICK =
  /err|fail|excep|panic|fatal|trace|assert|fault|dump|kill|abort|timed|unhandl|uncaught|memory|not ok|[✗✕×✖✘]|not found|resolve|denied|no such/i;

const SUMMARY_PATTERNS: readonly RegExp[] = [
  /^\s*(?:Tests?|Test Files|Test Suites|Suites|Snapshots):?\s+\d+\s+(?:passed|failed|total|skipped|todo|pending|obsolete|written|updated)\b/,
  /^\s*[#ℹ]\s*(?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\s+\d/,
  /^\s*\d+\s+(?:passing|failing|pending)\b/,
  /^=+ .*\b\d+ (?:passed|failed|errors?|skipped|xfailed|xpassed|deselected|warnings?)\b.*=+$/,
  /^\s*\d+ (?:passed|failed|skipped|flaky|did not run|interrupted)\b/,
  /^(?:ok|FAIL)\s+\S+\s+(?:\d+(?:\.\d+)?s|\(cached\)|\[)/,
  /^(?:PASS|FAIL)$/,
  /\b\d+ (?:problems?|errors?|warnings?)\b.*(?:\(|found|in \d+ files?|$)/i,
  /^\s*Found \d+ errors?\b/,
];
const SUMMARY_QUICK = /\d/;

const DETAIL =
  /^\s*[-+]?\s*(?:Expected|Received|Actual|Snapshot|Difference)\b|^\s*[-+] expected\b|^\s*[-+] actual\b|^\s*(?:expected|actual|operator):\s|\bexpected\b.*\b(?:to|but|got|received)\b|^\s*expect\(.*\)\.(?:not\.|resolves\.|rejects\.)?\w+\(/i;
const EXIT =
  /\bexit(?:ed)?\s+(?:with\s+)?(?:code|status)\b|\bexit code\b|\breturn(?:ed)? code\b|\bexit status \d+|\bELIFECYCLE\b|^\s*(?:Process finished|Command failed|Build failed|BUILD (?:FAILED|SUCCESSFUL))/i;
const WARNING = /\bwarn(?:ing|ings|ed)?\b/gi;
const FRAME =
  /^\s*at\s+\S.*(?::\d+(?::\d+)?\)?|\(native\)|\(<anonymous>\)|\(index \d+\))\s*$|^\s*File "[^"]+", line \d+|^\s+\S+\.go:\d+(?:\s+\+0x[0-9a-f]+)?\s*$|^\s*❯\s+\S+:\d+:\d+/;
const LIBFRAME =
  /node_modules|node:internal|\(internal\/|\bnode:[a-z_]+|<frozen |site-packages|dist-packages|\/usr\/lib\/python|\/usr\/local\/go\/src\/|\/go\/pkg\/mod\/|^\s+(?:runtime|testing)\/|java\.base\/|jdk\.internal|sun\.reflect|\(native\)|\(<anonymous>\)|\(index \d+\)/;
const DIFF_LINE = /^\s*[-+](?![-+])/;

/** True when the line carries a failure word that is not a zero count ("0 errors", "no failures"). */
export function hasFailureWord(line: string): boolean {
  if (FAILURE_CS.test(line) || ERROR_CLASS.test(line)) return true;
  if (!FAILURE_QUICK.test(line)) return false;
  if (FAILURE_CI.test(line)) return true;
  FAILURE_WORD.lastIndex = 0;
  for (let m = FAILURE_WORD.exec(line); m !== null; m = FAILURE_WORD.exec(line)) {
    const before = line.slice(Math.max(0, m.index - 12), m.index);
    const after = line.slice(m.index + m[0].length, m.index + m[0].length + 8);
    if (!ZERO_BEFORE.test(before) && !ZERO_AFTER.test(after)) return true;
  }
  return false;
}

/**
 * 0 when the line carries real failure wording (failure word, error class,
 * errno, "not ok", ✗, exit code, count summary); 1 when its only marker is a
 * prefix such as "npm ERR!" or it is critical for another reason.
 */
export function failureStrength(line: string): number {
  if (isSummaryLine(line) || EXIT.test(line)) return 0;
  return hasFailureWord(line.replace(PREFIX_ONLY, '')) ? 0 : 1;
}

function hasWarningWord(line: string): boolean {
  WARNING.lastIndex = 0;
  for (let m = WARNING.exec(line); m !== null; m = WARNING.exec(line)) {
    const before = line.slice(Math.max(0, m.index - 12), m.index);
    const after = line.slice(m.index + m[0].length, m.index + m[0].length + 8);
    if (!ZERO_BEFORE.test(before) && !ZERO_AFTER.test(after)) return true;
  }
  return false;
}

export function isSummaryLine(line: string): boolean {
  if (!SUMMARY_QUICK.test(line) && !/^(?:PASS|FAIL)$/.test(line)) return false;
  return SUMMARY_PATTERNS.some((re) => re.test(line));
}

/** Stateless flags of one cleaned line. */
export function lineFlags(line: string): number {
  if (line.trim().length === 0) return F_BLANK;
  let flags = 0;
  if (isSummaryLine(line)) flags |= F_SUMMARY;
  if (hasFailureWord(line)) flags |= F_FAILURE;
  if (DETAIL.test(line)) flags |= F_DETAIL;
  if (EXIT.test(line)) flags |= F_EXIT;
  if (FRAME.test(line)) {
    flags |= F_FRAME;
    if (LIBFRAME.test(line)) flags |= F_LIBFRAME;
  }
  if (DIFF_LINE.test(line)) flags |= F_DIFF;
  if ((flags & (F_FAILURE | F_SUMMARY)) === 0 && /warn/i.test(line) && hasWarningWord(line)) flags |= F_WARNING;
  return flags;
}

/** Lowercased, trimmed, deduplicated focus terms (at most 50, each at most 200 chars). */
export function normalizeFocus(focus: unknown): string[] {
  if (!Array.isArray(focus)) return [];
  const out: string[] = [];
  for (const term of focus) {
    if (typeof term !== 'string') continue;
    const t = term.trim().toLowerCase().slice(0, 200);
    if (t.length > 0 && !out.includes(t)) out.push(t);
    if (out.length >= 50) break;
  }
  return out;
}

export function hasFocus(line: string, focus: readonly string[]): boolean {
  if (focus.length === 0) return false;
  const lower = line.toLowerCase();
  return focus.some((term) => lower.includes(term));
}

function indentOf(line: string): number {
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  return i;
}

/**
 * Section headers: the nearest non-indented line above an indented failure or
 * detail line (eslint's file path above "12:5  error …") becomes critical too,
 * so a kept error never loses the file it belongs to. Stops at blank lines.
 */
export function markSectionHeaders(lines: readonly string[], crit: Uint8Array, maxBack = 200): void {
  for (let i = 0; i < lines.length; i++) {
    const p = crit[i] ?? 0;
    if ((p !== P_FAILURE && p !== P_DETAIL) || indentOf(lines[i] ?? '') === 0) continue;
    for (let j = i - 1; j >= 0 && j >= i - maxBack; j--) {
      const line = lines[j] ?? '';
      if (line.trim().length === 0) break;
      if (indentOf(line) === 0) {
        if ((crit[j] ?? 0) === 0) crit[j] = P_DETAIL;
        break;
      }
    }
  }
}

export interface CriticalMarkOptions {
  focus: readonly string[];
  /** Project frames kept after each failure line. */
  framesPerFailure?: number;
  /** Lines after a failure/detail line in which +/- lines count as assertion diff lines. */
  diffWindow?: number;
}

/**
 * Critical priority per line from flags plus context rules: +/- lines shortly
 * after an assertion detail, and the first project stack frames after a failure.
 */
export function markCritical(
  lines: readonly string[],
  flags: Uint16Array,
  opts: CriticalMarkOptions,
): Uint8Array {
  const crit = new Uint8Array(lines.length);
  const framesPerFailure = opts.framesPerFailure ?? 3;
  const diffWindow = opts.diffWindow ?? 40;
  let framesLeft = 0;
  let windowLeft = 0;
  for (let i = 0; i < lines.length; i++) {
    const f = flags[i] ?? 0;
    const line = lines[i] ?? '';
    let p = P_NONE;
    if ((f & (F_FAILURE | F_SUMMARY)) !== 0) p = P_FAILURE;
    else if ((f & (F_DETAIL | F_EXIT)) !== 0) p = P_DETAIL;
    else if (windowLeft > 0 && (f & F_DIFF) !== 0) p = P_DETAIL;
    if ((f & F_FRAME) !== 0 && p === P_NONE) {
      if ((f & F_LIBFRAME) === 0 && framesLeft > 0) {
        p = P_FRAME;
        framesLeft--;
      }
    }
    if (p === P_NONE && hasFocus(line, opts.focus)) p = P_DETAIL;
    if ((f & F_FAILURE) !== 0) framesLeft = framesPerFailure;
    if ((f & (F_FAILURE | F_DETAIL)) !== 0) windowLeft = diffWindow;
    else if (windowLeft > 0) windowLeft--;
    crit[i] = p;
  }
  return crit;
}
