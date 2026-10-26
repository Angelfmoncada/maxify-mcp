// Small shared helpers for the agent benchmark harness. Plain ESM, no dependencies.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repository root (this file is bench/agent/lib/util.mjs). */
export const REPO_ROOT = path.resolve(here, '..', '..', '..');
export const BENCH_DIR = path.join(REPO_ROOT, 'bench');
export const FIXTURE_DIR = path.join(BENCH_DIR, 'fixtures', 'taskboard');
export const AGENT_TASKS_DIR = path.join(BENCH_DIR, 'tasks', 'agent');
export const RESULTS_DIR = path.join(BENCH_DIR, 'results');

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** Short random id; temp paths stay short because some Windows tools break above MAX_PATH. */
export function shortId(bytes = 4) {
  return randomBytes(bytes).toString('hex');
}

/** A fresh directory directly under the OS temp dir, e.g. C:\Users\me\AppData\Local\Temp\mxb-1a2b3c4d. */
export function makeTempRoot(prefix = 'mxb') {
  const dir = path.join(os.tmpdir(), `${prefix}-${shortId()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function readTextIfExists(file) {
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

/**
 * Runs a command synchronously and never throws: failures come back as
 * { ok: false, status, stdout, stderr, error }.
 */
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeoutMs ?? 120_000,
    cwd: options.cwd,
    env: options.env ?? process.env,
    input: options.input,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    ok: result.status === 0 && result.error === undefined,
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error === undefined ? undefined : String(result.error.message ?? result.error),
    timedOut: result.error !== undefined && /ETIMEDOUT/.test(String(result.error.code ?? '')),
  };
}

/** Git with a fixed identity and no global config influence on line endings or signing. */
export function git(cwd, args, options = {}) {
  return run(
    'git',
    ['-c', 'user.name=bench', '-c', 'user.email=bench@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args],
    { cwd, ...options },
  );
}

/** Mean of a list of numbers; 0 for an empty list. */
export function mean(values) {
  return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
}

export function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

export function formatNumber(value, digits = 0) {
  if (!Number.isFinite(value)) return 'n/a';
  return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function formatUsd(value) {
  return Number.isFinite(value) ? `$${value.toFixed(value < 1 ? 3 : 2)}` : 'n/a';
}

export function formatPercent(value) {
  return Number.isFinite(value) ? `${Math.round(value * 100)}%` : 'n/a';
}

export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
