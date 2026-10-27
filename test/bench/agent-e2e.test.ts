import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { AGENT_DIR, REPO_ROOT, loadClaude, type RunRecord } from './helpers/agent-modules.js';

/**
 * End-to-end runs of bench/agent/run.mjs against a scripted stand-in for Claude Code
 * (test/bench/helpers/fake-claude.mjs, wired in through MAXIFY_BENCH_CLAUDE).
 * They exercise workspace creation, condition setup, argument passing, stream parsing, success checks,
 * result records, warm repetition and the stop-loss without spending any usage.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(here, 'helpers', 'fake-claude.mjs');
const RUN = path.join(AGENT_DIR, 'run.mjs');
const TASKS = path.join(REPO_ROOT, 'bench', 'tasks', 'agent');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'maxify-e2e-'));
const rawDirs: string[] = [];
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  for (const dir of rawDirs) rmSync(dir, { recursive: true, force: true });
});

interface LogEntry {
  argv: string[];
  cwd: string;
  claudeMd: string | null;
  settings: Record<string, unknown> | null;
  mcpConfig: { mcpServers: Record<string, { args: string[]; env?: Record<string, string> }> } | null;
  hasHiddenTest: boolean;
}

function harness(name: string, args: string[], env: Record<string, string>): { status: number | null; stdout: string; stderr: string; records: RunRecord[]; log: LogEntry[] } {
  const out = path.join(scratch, `${name}.jsonl`);
  const log = path.join(scratch, `${name}.log.jsonl`);
  const result = spawnSync(process.execPath, [RUN, ...args, '--confirm-spend', '--out', out], {
    encoding: 'utf8',
    timeout: 280_000,
    env: { ...process.env, MAXIFY_BENCH_CLAUDE: JSON.stringify([process.execPath, FAKE]), FAKE_CLAUDE_LOG: log, ...env },
  });
  const raw = /Raw streams: (.+)/.exec(result.stdout)?.[1];
  if (raw !== undefined) rawDirs.push(raw.trim());
  const lines = (file: string): string[] => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '') : []);
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    records: lines(out).map((line) => JSON.parse(line) as RunRecord),
    log: lines(log).map((line) => JSON.parse(line) as LogEntry),
  };
}

const maxifyBuilt = existsSync(path.join(REPO_ROOT, 'dist', 'cli.js'));

describe('the Claude command hook', () => {
  it('uses the stand-in only when MAXIFY_BENCH_CLAUDE is set, and validates it', async () => {
    const { claudeCommand } = (await loadClaude()) as unknown as { claudeCommand: () => { command: string; prefix: string[]; overridden: boolean } };
    const saved = process.env.MAXIFY_BENCH_CLAUDE;
    try {
      delete process.env.MAXIFY_BENCH_CLAUDE;
      expect(claudeCommand()).toEqual({ command: 'claude', prefix: [], overridden: false });
      process.env.MAXIFY_BENCH_CLAUDE = JSON.stringify(['node', 'x.mjs']);
      expect(claudeCommand()).toEqual({ command: 'node', prefix: ['x.mjs'], overridden: true });
      process.env.MAXIFY_BENCH_CLAUDE = 'not json';
      expect(() => claudeCommand()).toThrow(/JSON array/);
      process.env.MAXIFY_BENCH_CLAUDE = '[]';
      expect(() => claudeCommand()).toThrow(/non-empty/);
    } finally {
      if (saved === undefined) delete process.env.MAXIFY_BENCH_CLAUDE;
      else process.env.MAXIFY_BENCH_CLAUDE = saved;
    }
  });
});

describe('a full harness run against the scripted stand-in', () => {
  const conditions = maxifyBuilt ? 'native,maxify' : 'native';
  const solution = path.join(TASKS, 'default-page-size', 'solution.patch');
  const run = harness('solve', ['--tasks', 'default-page-size', '--conditions', conditions, '--warmth', 'both'], {
    FAKE_CLAUDE_MODE: 'solve',
    FAKE_CLAUDE_SOLUTION: solution,
  });

  it('runs every job cold then warm, with the stand-in clearly announced', () => {
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.stderr).toContain('MAXIFY_BENCH_CLAUDE is set');
    const expected = maxifyBuilt ? ['native/cold', 'native/warm', 'maxify/cold', 'maxify/warm'] : ['native/cold', 'native/warm'];
    expect(run.records.map((record) => `${record.condition}/${record.warmth}`)).toEqual(expected);
    expect(run.log).toHaveLength(expected.length);
  });

  it('records valid, solved runs with the reported usage and diff statistics', () => {
    for (const record of run.records) {
      expect(record.valid, JSON.stringify(record.invalidReasons)).toBe(true);
      expect(record.status).toBe('completed');
      expect(record.checks).toMatchObject({ solved: true, hiddenPass: true, visiblePass: true });
      expect(record.modelReported).toBe('claude-fake');
      expect(record.totalCostUsd).toBe(0.2);
      expect(record.diff).toMatchObject({ files: 4, modifiedTests: ['test/app.test.ts'] });
    }
    const native = run.records.find((record) => record.condition === 'native' && record.warmth === 'cold');
    expect(native?.usage).toEqual({ inputTokens: 100, outputTokens: 200, cacheCreationTokens: 3000, cacheReadTokens: 3000, totalTokens: 6300 });
    expect(native?.toolCalls).toMatchObject({ total: 2, mcp: 0 });
  });

  it('hands the agent the exact prompt and never shows it the hidden test', () => {
    const prompt = readFileSync(path.join(TASKS, 'default-page-size', 'task.json'), 'utf8');
    const expectedPrompt = (JSON.parse(prompt) as { prompt: string }).prompt;
    for (const entry of run.log) {
      expect(entry.argv.slice(0, 2)).toEqual(['-p', expectedPrompt]);
      expect(entry.hasHiddenTest).toBe(false);
      expect(entry.argv).toContain('--strict-mcp-config');
      expect(entry.argv[entry.argv.indexOf('--setting-sources') + 1]).toBe('project');
    }
  });

  it('shares one nonce between the cold and warm run of a job and uses a fresh one per job', () => {
    const nonce = (entry: LogEntry): string => /<!-- run (\w+) -->/.exec(entry.claudeMd ?? '')?.[1] ?? '';
    expect(nonce(run.log[0] as LogEntry)).not.toBe('');
    expect(nonce(run.log[0] as LogEntry)).toBe(nonce(run.log[1] as LogEntry));
    if (maxifyBuilt) expect(nonce(run.log[2] as LogEntry)).not.toBe(nonce(run.log[0] as LogEntry));
  });

  it('gives native an empty configuration and keeps every condition file inside the workspace', () => {
    const native = run.log[0] as LogEntry;
    expect(native.settings).toEqual({});
    expect(native.mcpConfig).toEqual({ mcpServers: {} });
    for (const entry of run.log) {
      expect(path.basename(path.dirname(entry.cwd))).toMatch(/^mxb-/);
      expect(entry.argv[entry.argv.indexOf('--mcp-config') + 1]).toBe(path.join(entry.cwd, '.mcp.json'));
    }
  });

  it.skipIf(!maxifyBuilt)('wires maxify as an MCP server rooted at the workspace, pre-indexed only for the warm run', () => {
    const [coldRecord, warmRecord] = run.records.filter((record) => record.condition === 'maxify');
    const [cold, warm] = run.log.slice(2);
    const server = cold?.mcpConfig?.mcpServers.maxify;
    expect(server?.args).toEqual([path.join(REPO_ROOT, 'dist', 'cli.js'), 'serve', '--root', cold?.cwd]);
    expect(server?.env?.MAXIFY_HOME).toBe(path.join(path.dirname(cold?.cwd ?? ''), 'maxify-home'));
    expect(cold?.argv).toContain('mcp__maxify');
    expect(coldRecord?.conditionLoaded).toBe(true);
    expect(coldRecord?.toolCalls.mcp).toBe(1);
    expect(warm?.mcpConfig?.mcpServers.maxify?.args).toEqual(server?.args);
    const prepare = (record: RunRecord | undefined): string => String((record?.prepare as Array<{ detail: string }> | undefined)?.[0]?.detail);
    expect(prepare(coldRecord)).toContain('not pre-indexed');
    expect(prepare(warmRecord)).toBe('pre-indexed');
  });
});

describe('failure handling and the spend stop-loss', () => {
  const answer = path.join(TASKS, 'explain-plugin-loading', 'reference-answer.txt');
  const wrong = path.join(TASKS, 'explain-plugin-loading', 'wrong-answer.txt');
  const question = ['--tasks', 'explain-plugin-loading', '--conditions', 'native'];

  it('stops starting new runs once the reported cost reaches --max-total-usd', () => {
    const result = harness('stoploss', [...question, '--reps', '4', '--max-total-usd', '1'], { FAKE_CLAUDE_COST: '0.6', FAKE_CLAUDE_ANSWER: answer });
    expect(result.status, result.stdout).toBe(0);
    expect(result.records).toHaveLength(2);
    expect(result.stdout).toContain('Stop-loss reached');
  });

  it('grades question tasks by the rubric: reference answer solves, a hallucinated one does not', () => {
    const good = harness('answer-good', question, { FAKE_CLAUDE_ANSWER: answer });
    expect(good.records[0]).toMatchObject({ valid: true, checks: { solved: true, answerPass: true } });
    const bad = harness('answer-bad', question, { FAKE_CLAUDE_ANSWER: wrong });
    expect(bad.records[0]).toMatchObject({ valid: true, checks: { solved: false, answerPass: false } });
  });

  it('records a crash without a result event as invalid evidence, not as an unsolved run', () => {
    const crashed = harness('crash', question, { FAKE_CLAUDE_MODE: 'crash' });
    expect(crashed.records[0]).toMatchObject({ status: 'no-result', valid: false });
    expect(crashed.records[0]?.invalidReasons.join(' ')).toMatch(/without a result event/);
  });

  it('keeps running out of turns as valid, unsolved evidence', () => {
    const exhausted = harness('maxturns', question, { FAKE_CLAUDE_MODE: 'maxturns', FAKE_CLAUDE_ANSWER: answer });
    expect(exhausted.records[0]).toMatchObject({ status: 'max-turns', valid: true });
  });

  it.skipIf(!maxifyBuilt)('marks a run invalid when the requested condition did not load', () => {
    // FAKE_CLAUDE_DROP_MCP makes the stand-in report no MCP servers, as if the maxify server failed to start.
    const result = harness('not-loaded', ['--tasks', 'explain-plugin-loading', '--conditions', 'maxify'], { FAKE_CLAUDE_ANSWER: answer, FAKE_CLAUDE_DROP_MCP: '1' });
    expect(result.status).toBe(0);
    expect(result.records[0]).toMatchObject({ conditionLoaded: false, valid: false });
    expect(result.records[0]?.invalidReasons.join(' ')).toMatch(/condition not loaded: MCP server "maxify" missing/);
  });
});
