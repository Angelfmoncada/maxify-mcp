// Success checks after an agent run: hidden tests, visible tests, diff statistics, answer rubric.
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { git, run } from './util.mjs';

/** Parses the summary lines of node's TAP reporter ("# pass 12"). Missing counters are null. */
export function parseTapSummary(output) {
  const counters = {};
  for (const match of String(output).matchAll(/^# (tests|pass|fail|cancelled|skipped|todo) (\d+)\s*$/gm)) {
    counters[match[1]] = Number(match[2]);
  }
  return {
    tests: counters.tests ?? null,
    pass: counters.pass ?? null,
    fail: counters.fail ?? null,
    cancelled: counters.cancelled ?? null,
  };
}

/**
 * Runs `node --test` on explicit files inside a workspace.
 * `passed` needs exit code 0, no failures or cancellations, and at least one passing test.
 */
export function runNodeTests(cwd, files, options = {}) {
  const result = run(process.execPath, ['--test', '--test-reporter=tap', ...files], {
    cwd,
    timeoutMs: options.timeoutMs ?? 180_000,
  });
  const summary = parseTapSummary(result.stdout);
  const passed =
    result.status === 0 && summary.fail === 0 && (summary.cancelled ?? 0) === 0 && (summary.pass ?? 0) > 0;
  return {
    passed,
    exitCode: result.status,
    ...summary,
    crashed: summary.tests === null,
    timedOut: result.timedOut,
    outputTail: `${result.stdout}\n${result.stderr}`.trim().split(/\r?\n/).slice(-40).join('\n'),
  };
}

/** Test files of the workspace that are not the hidden one, as workspace-relative POSIX paths. */
export function listVisibleTests(cwd, hiddenFileName = 'hidden.test.ts') {
  return readdirSync(path.join(cwd, 'test'))
    .filter((name) => name.endsWith('.test.ts') && name !== hiddenFileName)
    .sort()
    .map((name) => `test/${name}`);
}

/**
 * Diff of the agent's work against HEAD (the task setup commit). Stages everything, so call it
 * before the hidden test is copied in.
 */
export function diffStats(cwd) {
  git(cwd, ['add', '-A']);
  const numstat = git(cwd, ['diff', '--cached', '--numstat', '--no-renames', 'HEAD']).stdout;
  const status = git(cwd, ['diff', '--cached', '--name-status', '--no-renames', 'HEAD']).stdout;
  const changed = [];
  let insertions = 0;
  let deletions = 0;
  for (const line of numstat.split(/\r?\n/).filter((entry) => entry.length > 0)) {
    const [added, removed, ...rest] = line.split('\t');
    const filePath = rest.join('\t');
    const addedCount = added === '-' ? 0 : Number(added);
    const removedCount = removed === '-' ? 0 : Number(removed);
    insertions += addedCount;
    deletions += removedCount;
    changed.push({ path: filePath, added: addedCount, removed: removedCount });
  }
  const statusEntries = status
    .split(/\r?\n/)
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const [code, ...rest] = entry.split('\t');
      return { code, path: rest.join('\t') };
    });
  return {
    files: changed.length,
    insertions,
    deletions,
    changed,
    modifiedTests: statusEntries.filter((entry) => /^[MD]$/.test(entry.code) && entry.path.startsWith('test/')).map((entry) => entry.path),
    addedFiles: statusEntries.filter((entry) => entry.code === 'A').map((entry) => entry.path),
  };
}

/**
 * Rubric for question tasks. checks = { mustMatch?: string[], mustMatchAny?: string[][], mustNotMatch?: string[] },
 * all patterns are case-insensitive regular expressions.
 */
export function evaluateAnswer(text, checks) {
  const failures = [];
  for (const pattern of checks.mustMatch ?? []) {
    if (!new RegExp(pattern, 'i').test(text)) failures.push(`missing: ${pattern}`);
  }
  for (const group of checks.mustMatchAny ?? []) {
    if (!group.some((pattern) => new RegExp(pattern, 'i').test(text))) failures.push(`missing any of: ${group.join(' | ')}`);
  }
  for (const pattern of checks.mustNotMatch ?? []) {
    if (new RegExp(pattern, 'i').test(text)) failures.push(`must not mention: ${pattern}`);
  }
  return { passed: failures.length === 0, failures };
}
