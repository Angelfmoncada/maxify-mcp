// Building and running `claude -p`. This is the ONLY module that spawns Claude Code (and so spends usage).
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import path from 'node:path';
import { run } from './util.mjs';

/** Built-in tools made available to every condition; MCP tools are added by the condition. */
export const BUILTIN_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'];

/** Environment overrides that keep runs quiet and comparable. They never touch user configuration files. */
export const CLAUDE_ENV_OVERRIDES = {
  DISABLE_AUTOUPDATER: '1',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
};

/**
 * Argument vector for one headless run. The prompt is the first positional argument right after -p,
 * because variadic options such as --allowedTools would otherwise swallow it.
 * Each allowed tool is its own argument (rules such as `Bash(node --test:*)` contain spaces).
 * No --dangerously-skip-permissions: edits are accepted, everything else must be in --allowedTools.
 */
export function buildClaudeArgs({
  prompt,
  model,
  maxTurns,
  mcpConfigPath,
  allowedTools,
  maxBudgetUsd,
  effort,
  extraArgs = [],
}) {
  return [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    model,
    '--max-turns',
    String(maxTurns),
    '--setting-sources',
    'project',
    '--strict-mcp-config',
    '--mcp-config',
    mcpConfigPath,
    '--tools',
    BUILTIN_TOOLS.join(','),
    '--allowedTools',
    ...allowedTools,
    '--permission-mode',
    'acceptEdits',
    '--max-budget-usd',
    String(maxBudgetUsd),
    '--no-session-persistence',
    ...(effort === undefined ? [] : ['--effort', effort]),
    ...extraArgs,
  ];
}

/** Quotes an argument for display only (the process is spawned without a shell). */
export function displayArg(arg) {
  const text = arg.length > 90 ? `${arg.slice(0, 87)}...` : arg;
  return /^[\w@%+=:,./\\-]+$/.test(text) ? text : JSON.stringify(text);
}

/**
 * The command that starts Claude Code: `claude`, unless MAXIFY_BENCH_CLAUDE holds a JSON array
 * (command followed by leading arguments). That override exists only so tests can run the whole harness
 * against a scripted stand-in without spending usage; run.mjs prints a warning whenever it is active.
 */
export function claudeCommand() {
  const override = process.env.MAXIFY_BENCH_CLAUDE;
  if (override === undefined || override === '') return { command: 'claude', prefix: [], overridden: false };
  let parsed;
  try {
    parsed = JSON.parse(override);
  } catch {
    throw new Error('MAXIFY_BENCH_CLAUDE must be a JSON array of strings');
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((item) => typeof item !== 'string' || item === '')) {
    throw new Error('MAXIFY_BENCH_CLAUDE must be a JSON array of non-empty strings');
  }
  return { command: parsed[0], prefix: parsed.slice(1), overridden: true };
}

/** Version string of the installed Claude Code, or null when it cannot be run. */
export function claudeVersion() {
  const { command, prefix } = claudeCommand();
  const result = run(command, [...prefix, '--version'], { timeoutMs: 30_000 });
  return result.ok ? result.stdout.trim() : null;
}

function killTree(child) {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    child.kill('SIGKILL');
  }
}

/**
 * Spawns Claude Code, streams stdout/stderr to log files and resolves when it exits or times out.
 * Never rejects: spawn failures resolve with spawnError.
 */
export function runClaude({ args, cwd, env, timeoutMs, stdoutLog, stderrLog, onChild }) {
  return new Promise((resolve) => {
    mkdirSync(path.dirname(stdoutLog), { recursive: true });
    const out = createWriteStream(stdoutLog);
    const err = createWriteStream(stderrLog);
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let child;
    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      out.end();
      err.end();
      resolve({ stdout, stderr, timedOut, durationMs: Date.now() - started, ...extra });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (child !== undefined) killTree(child);
    }, timeoutMs);
    try {
      const { command, prefix } = claudeCommand();
      child = spawn(command, [...prefix, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      finish({ exitCode: null, signal: null, spawnError: String(error.message ?? error) });
      return;
    }
    if (onChild !== undefined) onChild(child);
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stdout += text;
      out.write(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderr += text;
      err.write(text);
    });
    child.on('error', (error) => finish({ exitCode: null, signal: null, spawnError: String(error.message ?? error) }));
    child.on('close', (code, signal) => finish({ exitCode: code, signal }));
  });
}

/** Stops a child that is still running (used on Ctrl-C). */
export { killTree };
