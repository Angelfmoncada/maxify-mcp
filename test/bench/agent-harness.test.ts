import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  AGENT_DIR,
  REPO_ROOT,
  loadClaude,
  loadConditions,
  loadPlan,
  loadResults,
  loadTasks,
  loadWorkspace,
  type FeatureInfo,
  type InitInfo,
  type RunRecord,
} from './helpers/agent-modules.js';

const scratch = mkdtempSync(path.join(os.tmpdir(), 'maxify-agent-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const ALL_FEATURES: Record<string, FeatureInfo> = {
  caveman: { available: true, pluginId: 'caveman@caveman', version: '4.0.1', installPath: path.join(scratch, 'plugins', 'caveman'), gitCommitSha: 'abc' },
  'graphify-cli': { available: true, version: 'graphify 0.9.92' },
  'graphify-mcp': { available: true, version: 'graphify 0.9.92' },
  maxify: { available: true, version: '0.1.0' },
};

describe('buildClaudeArgs', () => {
  const options = {
    prompt: 'Fix the bug.\nSecond line with "quotes" and `ticks`.',
    model: 'sonnet',
    maxTurns: 30,
    mcpConfigPath: '/work/ws/.mcp.json',
    allowedTools: ['Read', 'Edit', 'Bash(node --test:*)', 'mcp__maxify'],
    maxBudgetUsd: 2,
  };

  it('puts the prompt right after -p so variadic options cannot swallow it', async () => {
    const { buildClaudeArgs } = await loadClaude();
    const args = buildClaudeArgs(options);
    expect(args.slice(0, 2)).toEqual(['-p', options.prompt]);
    expect(args).toContain('--verbose');
    expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
  });

  it('isolates the run: project settings only, strict MCP config, no persistence, no permission bypass', async () => {
    const { buildClaudeArgs } = await loadClaude();
    const args = buildClaudeArgs(options);
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('project');
    expect(args).toContain('--strict-mcp-config');
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('/work/ws/.mcp.json');
    expect(args).toContain('--no-session-persistence');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    expect(args.join(' ')).not.toMatch(/dangerously|bypassPermissions/);
  });

  it('caps turns and spend and passes every allowed tool as its own argument', async () => {
    const { buildClaudeArgs } = await loadClaude();
    const args = buildClaudeArgs({ ...options, effort: 'low', extraArgs: ['--plugin-dir', '/x'] });
    expect(args[args.indexOf('--max-turns') + 1]).toBe('30');
    expect(args[args.indexOf('--max-budget-usd') + 1]).toBe('2');
    const start = args.indexOf('--allowedTools');
    expect(args.slice(start + 1, start + 5)).toEqual(['Read', 'Edit', 'Bash(node --test:*)', 'mcp__maxify']);
    expect(args[start + 5]).toBe('--permission-mode');
    expect(args[args.indexOf('--effort') + 1]).toBe('low');
    expect(args.slice(-2)).toEqual(['--plugin-dir', '/x']);
  });

  it('restricts the built-in tools to a fixed list', async () => {
    const { buildClaudeArgs, BUILTIN_TOOLS } = await loadClaude();
    const args = buildClaudeArgs(options);
    expect(args[args.indexOf('--tools') + 1]).toBe(BUILTIN_TOOLS.join(','));
    expect(BUILTIN_TOOLS).toEqual(['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash']);
  });
});

describe('conditions', () => {
  const ctx = { workspace: path.join(scratch, 'ws'), maxifyHome: path.join(scratch, 'maxify-home'), cavemanLoad: 'settings' };

  it('defines the five required conditions plus the graphify CLI variants', async () => {
    const { CONDITION_FEATURES, CAVEMAN_CONDITIONS } = await loadConditions();
    for (const name of ['native', 'caveman', 'graphify', 'caveman+graphify', 'maxify']) expect(Object.keys(CONDITION_FEATURES)).toContain(name);
    expect(CONDITION_FEATURES.native).toEqual([]);
    expect(CONDITION_FEATURES['caveman+graphify']).toEqual(['caveman', 'graphify-mcp']);
    expect(CAVEMAN_CONDITIONS.sort()).toEqual(['caveman', 'caveman+graphify', 'caveman+graphify-cli']);
  });

  it('configures maxify as a stdio MCP server rooted at the workspace with isolated state', async () => {
    const { contributionsFor } = await loadConditions();
    const contribution = contributionsFor('maxify', ctx, ALL_FEATURES);
    const server = contribution.mcpServers.maxify;
    expect(server?.type).toBe('stdio');
    expect(server?.command).toBe(process.execPath);
    expect(server?.args).toEqual([path.join(REPO_ROOT, 'dist', 'cli.js'), 'serve', '--root', ctx.workspace]);
    expect(server?.env?.MAXIFY_HOME).toBe(ctx.maxifyHome);
    expect(contribution.allowedTools).toEqual(['mcp__maxify']);
  });

  it('enables caveman only through project settings (or --plugin-dir), never global files', async () => {
    const { contributionsFor } = await loadConditions();
    const viaSettings = contributionsFor('caveman', ctx, ALL_FEATURES);
    expect(viaSettings.settings).toEqual({ enabledPlugins: { 'caveman@caveman': true } });
    expect(viaSettings.extraArgs).toEqual([]);
    const viaDir = contributionsFor('caveman', { ...ctx, cavemanLoad: 'plugin-dir' }, ALL_FEATURES);
    expect(viaDir.extraArgs).toEqual(['--plugin-dir', ALL_FEATURES.caveman?.installPath]);
  });

  it('wires graphify through its MCP server or its CLI, graph inside the workspace', async () => {
    const { contributionsFor } = await loadConditions();
    const mcp = contributionsFor('graphify', ctx, ALL_FEATURES);
    expect(mcp.mcpServers.graphify?.command).toBe('graphify-mcp');
    expect(mcp.mcpServers.graphify?.args).toEqual([path.join(ctx.workspace, 'graphify-out', 'graph.json')]);
    expect(mcp.allowedTools).toEqual(['mcp__graphify']);
    expect(mcp.claudeMdLines.join('\n')).toContain('graphify');
    const cli = contributionsFor('graphify-cli', ctx, ALL_FEATURES);
    expect(cli.mcpServers).toEqual({});
    expect(cli.allowedTools).toEqual(['Bash(graphify:*)']);
  });

  it('combines features and leaves native untouched', async () => {
    const { contributionsFor } = await loadConditions();
    const combo = contributionsFor('caveman+graphify', ctx, ALL_FEATURES);
    expect(Object.keys(combo.mcpServers)).toEqual(['graphify']);
    expect(combo.settings).toHaveProperty('enabledPlugins');
    expect(contributionsFor('native', ctx, ALL_FEATURES)).toEqual({ settings: {}, mcpServers: {}, claudeMdLines: [], allowedTools: [], extraArgs: [], env: {} });
  });

  it('never points a condition at user-level configuration', async () => {
    const { ALL_CONDITIONS, contributionsFor } = await loadConditions();
    const home = os.homedir().toLowerCase();
    for (const name of ALL_CONDITIONS) {
      const contribution = contributionsFor(name, ctx, ALL_FEATURES);
      const strings = JSON.stringify(contribution).toLowerCase().replaceAll('\\\\', '\\');
      // Paths a condition may mention: the workspace, the temp state, the repository, node, and the read-only plugin cache.
      const mentionsHomeConfig = strings.includes(path.join(home, '.claude').toLowerCase()) || strings.includes('.claude.json');
      expect(mentionsHomeConfig, name).toBe(false);
      expect(Object.keys(contribution.settings).every((key) => key === 'enabledPlugins'), name).toBe(true);
    }
  });

  it('verifies from the init event that a condition really loaded', async () => {
    const { verifyConditionLoaded } = await loadConditions();
    const init = (overrides: Partial<InitInfo>): InitInfo => ({
      sessionId: 's',
      model: 'm',
      tools: ['Read'],
      mcpServers: [],
      plugins: [],
      slashCommands: [],
      skills: [],
      agents: [],
      apiKeySource: 'none',
      ...overrides,
    });
    expect(verifyConditionLoaded('native', null)).toEqual({ loaded: true, problems: [] });
    expect(verifyConditionLoaded('maxify', null).loaded).toBe(false);
    expect(verifyConditionLoaded('maxify', init({ mcpServers: [{ name: 'maxify', status: 'connected' }], tools: ['Read', 'mcp__maxify__maxify_context'] })).loaded).toBe(true);
    expect(verifyConditionLoaded('maxify', init({ mcpServers: [{ name: 'maxify', status: 'failed' }], tools: ['mcp__maxify__maxify_context'] })).problems[0]).toMatch(/status is failed/);
    expect(verifyConditionLoaded('maxify', init({ mcpServers: [{ name: 'maxify', status: 'connected' }] })).problems.join()).toMatch(/no mcp__maxify__\* tools/);
    expect(verifyConditionLoaded('graphify', init({ mcpServers: [{ name: 'graphify', status: 'connected' }], tools: ['mcp__graphify__query_graph'] })).loaded).toBe(true);
    expect(verifyConditionLoaded('caveman', init({ plugins: ['caveman'] })).loaded).toBe(true);
    expect(verifyConditionLoaded('caveman', init({ slashCommands: ['caveman:caveman'] })).loaded).toBe(true);
    expect(verifyConditionLoaded('caveman', init({})).loaded).toBe(false);
  });

  it('marks a condition unavailable when any of its features is, and says why', async () => {
    const { describeCondition } = await loadConditions();
    const features: Record<string, FeatureInfo> = {
      ...ALL_FEATURES,
      'graphify-mcp': { available: false, reason: 'mcp package missing', version: 'graphify 0.9.92' },
    };
    expect(describeCondition('graphify', features)).toMatchObject({ available: false });
    expect(describeCondition('graphify', features).reason).toContain('mcp package missing');
    expect(describeCondition('caveman+graphify', features).available).toBe(false);
    expect(describeCondition('graphify-cli', features).available).toBe(true);
    expect(describeCondition('maxify', features).available).toBe(true);
    expect(describeCondition('caveman', features).usesCaveman).toBe(true);
    expect(() => describeCondition('nope', features)).toThrow(/Unknown condition/);
  });
});

describe('buildPlan', () => {
  it('multiplies tasks, conditions, repetitions and warmth, and bounds the worst case', async () => {
    const { buildPlan } = await loadPlan();
    const tasks = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const cold = buildPlan({ tasks, conditions: ['native', 'maxify'], reps: 2, warmth: 'cold', maxBudgetUsd: 2, maxTotalUsd: 100 });
    expect(cold.jobs).toHaveLength(12);
    expect(cold.runs).toBe(12);
    expect(cold.worstCaseUsd).toBe(24);
    const both = buildPlan({ tasks, conditions: ['native', 'maxify'], reps: 2, warmth: 'both', maxBudgetUsd: 2, maxTotalUsd: 10 });
    expect(both.runs).toBe(24);
    expect(both.runsPerJob).toBe(2);
    expect(both.worstCaseUsd).toBe(12); // stop-loss 10 plus one more run at its cap of 2
  });
});

function record(overrides: Partial<RunRecord> & { solved?: boolean; tokens?: number; cost?: number | null }): RunRecord {
  const tokens = overrides.tokens ?? 1000;
  return {
    schema: 1,
    runId: 'r',
    task: 't1',
    category: 'diagnosis',
    condition: 'native',
    rep: 1,
    warmth: 'cold',
    status: 'completed',
    valid: true,
    invalidReasons: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: tokens, totalTokens: tokens },
    totalCostUsd: overrides.cost === undefined ? tokens / 1000 : overrides.cost,
    numTurns: 5,
    durationMs: 60_000,
    firstTurnContextTokens: 800,
    toolCalls: { total: 6, mcp: 0 },
    checks: { solved: overrides.solved ?? true, hiddenPass: overrides.solved ?? true, visiblePass: true },
    ...overrides,
  } as RunRecord;
}

function repeat(count: number, build: (index: number) => RunRecord): RunRecord[] {
  return Array.from({ length: count }, (_, index) => build(index + 1));
}

describe('agent result aggregation', () => {
  it('flags a condition that uses fewer tokens but solves fewer runs than native as a REGRESSION', async () => {
    const { aggregateRecords, renderAgentReport } = await loadResults();
    const records = [
      ...repeat(5, (rep) => record({ condition: 'native', rep, tokens: 1000, solved: true })),
      ...repeat(5, (rep) => record({ condition: 'maxify', rep, tokens: 600, solved: rep <= 2 })),
    ];
    const aggregate = aggregateRecords(records);
    const maxify = aggregate.cells.find((cell) => cell.condition === 'maxify');
    expect(maxify).toMatchObject({ n: 5, solved: 2, successRate: 0.4, meanTotalTokens: 600, lowSample: false });
    expect(maxify?.versusNative).toMatchObject({ fewerTokens: true, worseSuccess: true, regression: true });
    expect(aggregate.hasRegression).toBe(true);
    const text = renderAgentReport(aggregate);
    expect(text).toContain('## REGRESSION');
    expect(text).toContain('**maxify**');
  });

  it('flags cheaper-but-worse through cost alone, and clears conditions that solve at least as much', async () => {
    const { aggregateRecords } = await loadResults();
    const records = [
      ...repeat(3, (rep) => record({ condition: 'native', rep, tokens: 1000, cost: 1, solved: true })),
      ...repeat(3, (rep) => record({ condition: 'costly-tokens', rep, tokens: 2000, cost: 0.5, solved: rep === 1 })),
      ...repeat(3, (rep) => record({ condition: 'good', rep, tokens: 500, cost: 0.4, solved: true })),
      ...repeat(3, (rep) => record({ condition: 'worse-and-pricier', rep, tokens: 3000, cost: 3, solved: false })),
    ];
    const byName = new Map(aggregateRecords(records).cells.map((cell) => [cell.condition, cell]));
    expect(byName.get('costly-tokens')?.versusNative).toMatchObject({ fewerTokens: false, cheaper: true, regression: true });
    expect(byName.get('good')?.versusNative?.regression).toBe(false);
    expect(byName.get('worse-and-pricier')?.versusNative).toMatchObject({ worseSuccess: true, regression: false });
  });

  it('keeps cold and warm runs apart', async () => {
    const { aggregateRecords, renderAgentReport } = await loadResults();
    const records = [
      ...repeat(2, (rep) => record({ condition: 'native', rep, warmth: 'cold', tokens: 1000 })),
      ...repeat(2, (rep) => record({ condition: 'native', rep, warmth: 'warm', tokens: 400 })),
      ...repeat(2, (rep) => record({ condition: 'maxify', rep, warmth: 'warm', tokens: 300, solved: true })),
    ];
    const aggregate = aggregateRecords(records);
    const cells = aggregate.cells.map((cell) => `${cell.warmth}/${cell.condition}/${cell.meanTotalTokens}`);
    expect(cells).toEqual(['cold/native/1000', 'warm/native/400', 'warm/maxify/300']);
    const text = renderAgentReport(aggregate);
    expect(text).toContain('## Cold runs');
    expect(text).toContain('## Warm runs');
  });

  it('excludes invalid runs from the figures but lists them with their reasons', async () => {
    const { aggregateRecords, renderAgentReport } = await loadResults();
    const records = [
      record({ condition: 'native', rep: 1, tokens: 1000 }),
      record({ condition: 'maxify', rep: 1, tokens: 700, solved: true }),
      record({ condition: 'maxify', rep: 2, tokens: 90_000, solved: false, valid: false, invalidReasons: ['condition not loaded: MCP server "maxify" missing from init'] }),
    ];
    const aggregate = aggregateRecords(records);
    const maxify = aggregate.cells.find((cell) => cell.condition === 'maxify');
    expect(maxify).toMatchObject({ runs: 2, n: 1, invalid: 1, meanTotalTokens: 700 });
    expect(aggregate.invalid).toHaveLength(1);
    expect(renderAgentReport(aggregate)).toContain('## Excluded runs');
    expect(renderAgentReport(aggregate)).toContain('condition not loaded');
  });

  it('charges failures to successes in tokens per solved task and marks small samples', async () => {
    const { aggregateRecords } = await loadResults();
    const cell = aggregateRecords([
      record({ condition: 'native', rep: 1, tokens: 1000, solved: true }),
      record({ condition: 'native', rep: 2, tokens: 3000, solved: false }),
    ]).cells[0];
    expect(cell?.tokensPerSolved).toBe(4000);
    expect(cell?.lowSample).toBe(true);
    const none = aggregateRecords([record({ condition: 'native', solved: false })]).cells[0];
    expect(Number.isNaN(none?.tokensPerSolved)).toBe(true);
  });

  it('ignores unknown costs (timeouts) when averaging cost', async () => {
    const { aggregateRecords } = await loadResults();
    const cell = aggregateRecords([
      record({ condition: 'native', rep: 1, cost: 1 }),
      record({ condition: 'native', rep: 2, cost: null, status: 'timeout' }),
    ]).cells[0];
    expect(cell?.meanCostUsd).toBe(1);
  });

  it('round-trips records through JSONL files and rejects corrupt lines', async () => {
    const { appendRecord, readRecords, resultFiles } = await loadResults();
    const file = path.join(scratch, 'results', 'one.jsonl');
    appendRecord(file, record({ condition: 'native' }));
    appendRecord(file, record({ condition: 'maxify' }));
    writeFileSync(path.join(scratch, 'results', 'other-schema.jsonl'), `${JSON.stringify({ schema: 99, x: 1 })}\n`);
    const files = resultFiles([path.join(scratch, 'results')]);
    expect(files.map((entry) => path.basename(entry))).toEqual(['one.jsonl', 'other-schema.jsonl']);
    expect(readRecords(files).map((entry) => entry.condition)).toEqual(['native', 'maxify']);
    writeFileSync(file, '{broken\n');
    expect(() => readRecords([file])).toThrow(/one\.jsonl:1: invalid JSON/);
    expect(() => resultFiles([path.join(scratch, 'missing')])).toThrow(/not found/);
  });
});

describe('agent tasks', () => {
  it('provides at least six tasks covering the required categories with all hidden files', async () => {
    const { loadAgentTasks } = await loadTasks();
    const tasks = loadAgentTasks();
    expect(tasks.length).toBeGreaterThanOrEqual(6);
    const categories = new Set(tasks.map((task) => task.category));
    for (const category of ['diagnosis', 'multi-module', 'contract-update', 'failing-test', 'post-edit', 'tiny']) expect(categories.has(category), category).toBe(true);
    for (const task of tasks.filter((entry) => entry.category !== 'question')) {
      expect(existsSync(task.hiddenTest ?? ''), task.id).toBe(true);
      expect(existsSync(task.solutionPatch ?? ''), task.id).toBe(true);
      expect(task.hiddenTestName).toMatch(/\.test\.ts$/);
      expect(task.allowedTools).toContain('Read');
    }
    expect(tasks.filter((task) => task.setupPatch !== null).map((task) => task.id).sort()).toEqual(['diagnose-token-expiry', 'fix-failing-status-rules']);
    expect(tasks.find((task) => task.id === 'fix-failing-status-rules')?.expect.visibleFailsAfterSetup).toBe(true);
  });

  it('keeps the agent from seeing hidden tests: they live outside the fixture', async () => {
    const fixtureFiles = readdirSync(path.join(REPO_ROOT, 'bench', 'fixtures', 'taskboard', 'test'));
    expect(fixtureFiles).not.toContain('hidden.test.ts');
  });

  it('gives the question task a read-only tool set', async () => {
    const { loadAgentTasks } = await loadTasks();
    const question = loadAgentTasks(undefined, ['explain-plugin-loading'])[0];
    expect(question?.allowedTools).not.toContain('Edit');
    expect(question?.allowedTools).not.toContain('Write');
  });

  it('rejects malformed task.json documents', async () => {
    const { validateTaskJson } = await loadTasks();
    const dir = path.join(scratch, 'no-files');
    mkdirSync(dir, { recursive: true });
    const problems = validateTaskJson({ id: 'other', category: 'nope', prompt: 'short', maxTurns: 0, timeoutMs: 5, title: '' }, 'dir-name', dir);
    expect(problems.join('\n')).toMatch(/must equal the directory name/);
    expect(problems.join('\n')).toMatch(/category must be one of/);
    expect(problems.join('\n')).toMatch(/prompt must be/);
    expect(problems.join('\n')).toMatch(/maxTurns/);
    expect(problems.join('\n')).toMatch(/timeoutMs/);
    expect(problems.join('\n')).toMatch(/hiddenTest is required/);
  });
});

describe('workspace helpers', () => {
  it('merges settings objects deeply and concatenates arrays without duplicates', async () => {
    const { mergeSettings } = await loadWorkspace();
    const merged = mergeSettings(
      { hooks: { PreToolUse: [{ matcher: 'Bash|Grep' }] }, keep: 1 },
      { hooks: { PreToolUse: [{ matcher: 'Bash|Grep' }, { matcher: 'Read' }] }, enabledPlugins: { 'caveman@caveman': true } },
    );
    expect(merged).toEqual({
      hooks: { PreToolUse: [{ matcher: 'Bash|Grep' }, { matcher: 'Read' }] },
      keep: 1,
      enabledPlugins: { 'caveman@caveman': true },
    });
  });

  it('puts a per-run nonce into the shared project memory so cold runs do not share a prompt prefix', async () => {
    const { baseClaudeMd } = await loadWorkspace();
    expect(baseClaudeMd('abc123')).toContain('<!-- run abc123 -->');
    expect(baseClaudeMd('abc123')).not.toBe(baseClaudeMd('def456'));
    expect(baseClaudeMd('abc123')).toContain('npm test');
  });
});

describe('safety of the harness sources', () => {
  const files = [
    ...readdirSync(AGENT_DIR).filter((name) => name.endsWith('.mjs')).map((name) => path.join(AGENT_DIR, name)),
    ...readdirSync(path.join(AGENT_DIR, 'lib')).filter((name) => name.endsWith('.mjs')).map((name) => path.join(AGENT_DIR, 'lib', name)),
  ];

  it('never uses permission bypass flags', () => {
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      // The only mention allowed is in a comment explaining that the flag is not used.
      const code = text.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
      expect(code, path.basename(file)).not.toMatch(/dangerously-skip-permissions|bypassPermissions/);
    }
  });

  it('touches the user home only to read the plugin registry', () => {
    const users = files.filter((file) => /homedir\(\)/.test(readFileSync(file, 'utf8')));
    expect(users.map((file) => path.basename(file))).toEqual(['conditions.mjs']);
    const text = readFileSync(path.join(AGENT_DIR, 'lib', 'conditions.mjs'), 'utf8');
    const lines = text.split('\n').filter((line) => /homedir\(\)/.test(line));
    for (const line of lines) expect(line).not.toMatch(/write|mkdir|rm|append|copy|rename/i);
  });

  it('spawns a long-running child only from lib/claude.mjs, and only execute.mjs and run.mjs drive runs', () => {
    const spawners = files.filter((file) => /\bspawn\(/.test(readFileSync(file, 'utf8')));
    expect(spawners.map((file) => path.basename(file))).toEqual(['claude.mjs']);
    const callers = files.filter((file) => /runClaude\(/.test(readFileSync(file, 'utf8')) && !file.endsWith('claude.mjs'));
    expect(callers.map((file) => path.basename(file))).toEqual(['execute.mjs']);
    const executors = files.filter((file) => /executeRun\(/.test(readFileSync(file, 'utf8')) && !file.endsWith('execute.mjs'));
    expect(executors.map((file) => path.basename(file))).toEqual(['run.mjs']);
  });

  it('gates execution behind --confirm-spend', () => {
    const text = readFileSync(path.join(AGENT_DIR, 'run.mjs'), 'utf8');
    expect(text).toContain("o['confirm-spend'] !== true");
    expect(text.indexOf("o['confirm-spend'] !== true")).toBeLessThan(text.indexOf('return execute('));
  });
});

describe('run.mjs dry run (default)', () => {
  function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [path.join(AGENT_DIR, 'run.mjs'), ...args], { encoding: 'utf8', timeout: 120_000 });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  function resultsListing(): string[] {
    const dir = path.join(REPO_ROOT, 'bench', 'results');
    return existsSync(dir) ? readdirSync(dir).sort() : [];
  }

  it('prints the plan and the run count and executes nothing without --confirm-spend', () => {
    const before = resultsListing();
    const { status, stdout } = runCli(['--tasks', 'default-page-size', '--conditions', 'native', '--reps', '4']);
    expect(status).toBe(0);
    expect(stdout).toContain('Agent benchmark plan');
    expect(stdout).toContain('CLAUDE CODE RUNS: 4');
    expect(stdout).toContain('DRY RUN: nothing was executed');
    expect(stdout).toContain('--confirm-spend');
    expect(stdout).toMatch(/worst-case bound .*NOT an estimate/);
    expect(stdout).not.toMatch(/\[\d+\/\d+\]/);
    expect(resultsListing()).toEqual(before);
  }, 120_000);

  it('doubles the run count for cold + warm and stays a dry run when both flags are given', () => {
    const before = resultsListing();
    const { status, stdout } = runCli(['--tasks', 'default-page-size,diagnose-token-expiry', '--conditions', 'native', '--warmth', 'both', '--confirm-spend', '--dry-run']);
    expect(status).toBe(0);
    expect(stdout).toContain('CLAUDE CODE RUNS: 4');
    expect(stdout).toContain('DRY RUN: nothing was executed');
    expect(resultsListing()).toEqual(before);
  }, 120_000);

  it('shows the exact claude command line without any permission bypass', () => {
    const { stdout } = runCli(['--tasks', 'default-page-size', '--conditions', 'native']);
    expect(stdout).toContain('claude -p ');
    expect(stdout).toContain('--setting-sources project');
    expect(stdout).toContain('--strict-mcp-config');
    expect(stdout).toContain('--permission-mode acceptEdits');
    expect(stdout).not.toMatch(/dangerously/);
  }, 120_000);

  it('lists every condition with its availability and keeps caveman out of the default selection', () => {
    const { stdout } = runCli(['--tasks', 'default-page-size']);
    for (const name of ['native', 'caveman', 'graphify', 'caveman+graphify', 'maxify']) expect(stdout).toContain(name);
    expect(stdout).toMatch(/caveman .*(opt-in|UNAVAILABLE)/);
    const jobs = /Jobs: (\d+)/.exec(stdout);
    // At most native, graphify, graphify-cli and maxify: the caveman conditions are never selected by default.
    expect(Number(jobs?.[1])).toBeLessThanOrEqual(4);
  }, 120_000);

  it('rejects unknown tasks, conditions and bad option values with exit code 2', () => {
    expect(runCli(['--tasks', 'nope']).status).toBe(2);
    expect(runCli(['--conditions', 'nope']).status).toBe(2);
    expect(runCli(['--warmth', 'tepid']).status).toBe(2);
    expect(runCli(['--reps', '0']).status).toBe(2);
    expect(runCli(['--max-budget-usd', '-1']).status).toBe(2);
    expect(runCli(['--bogus']).status).toBe(2);
  }, 120_000);
});

describe('report.mjs', () => {
  const reportScript = path.join(AGENT_DIR, 'report.mjs');

  it('prints a friendly message when there are no results', () => {
    const empty = path.join(scratch, 'empty-results');
    mkdirSync(empty, { recursive: true });
    const result = spawnSync(process.execPath, [reportScript, empty], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No agent results found');
  });

  it('aggregates a results file and fails on request when a REGRESSION exists', () => {
    const file = path.join(scratch, 'regression.jsonl');
    const lines = [
      ...repeat(5, (rep) => record({ condition: 'native', rep, tokens: 1000, solved: true })),
      ...repeat(5, (rep) => record({ condition: 'maxify', rep, tokens: 500, solved: false })),
    ].map((entry) => JSON.stringify(entry));
    writeFileSync(file, `${lines.join('\n')}\n`);
    const plain = spawnSync(process.execPath, [reportScript, file], { encoding: 'utf8' });
    expect(plain.status).toBe(0);
    expect(plain.stdout).toContain('# Maxify agent benchmark report');
    expect(plain.stdout).toContain('REGRESSION');
    const strict = spawnSync(process.execPath, [reportScript, file, '--fail-on-regression'], { encoding: 'utf8' });
    expect(strict.status).toBe(1);
    const json = spawnSync(process.execPath, [reportScript, file, '--json'], { encoding: 'utf8' });
    expect((JSON.parse(json.stdout) as { hasRegression: boolean }).hasRegression).toBe(true);
    rmSync(file);
  });
});
