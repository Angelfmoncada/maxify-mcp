import { describe, expect, it } from 'vitest';
import {
  loadArgs,
  loadChecks,
  loadExecute,
  loadStream,
  syntheticStream,
  type ConditionCheck,
  type StreamSummary,
} from './helpers/agent-modules.js';

// Every stream below is SYNTHETIC: built from the documented stream-json event shapes, not recorded from a real run.

describe('parseJsonLines', () => {
  it('skips blank lines and counts lines that are not JSON objects', async () => {
    const { parseJsonLines } = await loadStream();
    const parsed = parseJsonLines('{"type":"a"}\n\n   \nnot json\n42\n{"type":"b"}\r\n');
    expect(parsed.events.map((event) => event.type)).toEqual(['a', 'b']);
    expect(parsed.invalidLines).toBe(2);
  });
});

describe('summarizeStream', () => {
  it('reads the provider usage from the result event and counts each tool call once', async () => {
    const { parseJsonLines, summarizeStream, totalTokens } = await loadStream();
    const summary = summarizeStream(parseJsonLines(syntheticStream({ toolUses: ['Read', 'Edit', 'mcp__maxify__maxify_context'] })).events);
    expect(summary.usageSource).toBe('result');
    expect(summary.usage).toEqual({ inputTokens: 100, outputTokens: 50, cacheCreationTokens: 2000, cacheReadTokens: 4000 });
    expect(totalTokens(summary.usage)).toBe(6150);
    expect(summary.toolCalls.total).toBe(3);
    expect(summary.toolCalls.mcp).toBe(1);
    expect(summary.toolCalls.builtin).toBe(2);
    expect(summary.toolCalls.byName).toEqual({ Read: 1, Edit: 1, mcp__maxify__maxify_context: 1 });
    expect(summary.toolCalls.byServer).toEqual({ maxify: 1 });
    expect(summary.toolResults).toEqual({ count: 3, chars: 300, errors: 0 });
    expect(summary.result).toMatchObject({ subtype: 'success', numTurns: 4, totalCostUsd: 0.25 });
  });

  it('does not double count assistant messages that are streamed block by block', async () => {
    const { parseJsonLines, summarizeStream } = await loadStream();
    const summary = summarizeStream(parseJsonLines(syntheticStream({ withResult: false })).events);
    expect(summary.assistantMessages).toBe(2);
    expect(summary.usageSource).toBe('messages');
    expect(summary.usage).toEqual(summary.messageUsageTotals);
    expect(summary.usage).toEqual({ inputTokens: 21, outputTokens: 10, cacheCreationTokens: 1000, cacheReadTokens: 1000 });
    expect(summary.hasResult).toBe(false);
  });

  it('measures the first-turn context (what the setup costs before any work)', async () => {
    const { parseJsonLines, summarizeStream } = await loadStream();
    const summary = summarizeStream(parseJsonLines(syntheticStream()).events);
    expect(summary.firstTurnContextTokens).toBe(10 + 1000 + 0);
  });

  it('captures the init event: tools, MCP servers, plugins, API key source', async () => {
    const { parseJsonLines, summarizeStream } = await loadStream();
    const stream = syntheticStream({
      tools: ['Read', 'mcp__maxify__maxify_context'],
      mcpServers: [{ name: 'maxify', status: 'connected' }],
      plugins: ['example'],
    });
    const init = summarizeStream(parseJsonLines(stream).events).init;
    expect(init?.tools).toContain('mcp__maxify__maxify_context');
    expect(init?.mcpServers).toEqual([{ name: 'maxify', status: 'connected' }]);
    expect(init?.plugins).toEqual(['example']);
    expect(init?.apiKeySource).toBe('none');
    expect(init?.model).toBe('claude-synthetic');
  });

  it('survives an empty or garbled stream', async () => {
    const { summarizeStream } = await loadStream();
    const summary = summarizeStream([{ type: 'assistant' }, { type: 'user', message: 5 }, { type: 'mystery' }]);
    expect(summary.init).toBeNull();
    expect(summary.result).toBeNull();
    expect(summary.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 });
    expect(summary.toolCalls.total).toBe(0);
  });

  it('extracts the MCP server name from tool names', async () => {
    const { mcpServerOf } = await loadStream();
    expect(mcpServerOf('mcp__maxify__maxify_context')).toBe('maxify');
    expect(mcpServerOf('mcp__claude_ai_Gmail__create_draft')).toBe('claude_ai_Gmail');
    expect(mcpServerOf('Read')).toBeNull();
    expect(mcpServerOf('mcp__broken')).toBeNull();
  });
});

describe('classifyRun', () => {
  const loaded: ConditionCheck = { loaded: true, problems: [] };
  const finished = { timedOut: false, durationMs: 1000 };

  async function classify(stream: string, overrides: { runInfo?: Record<string, unknown>; conditionCheck?: ConditionCheck; prepareProblems?: string[] } = {}) {
    const { parseJsonLines, summarizeStream } = await loadStream();
    const { classifyRun } = await loadExecute();
    const summary: StreamSummary = summarizeStream(parseJsonLines(stream).events);
    return classifyRun({
      summary,
      runInfo: { ...finished, ...(overrides.runInfo ?? {}) },
      conditionCheck: overrides.conditionCheck ?? loaded,
      prepareProblems: overrides.prepareProblems ?? [],
    });
  }

  it('accepts a normal completion', async () => {
    expect(await classify(syntheticStream())).toEqual({ status: 'completed', valid: true, invalidReasons: [] });
  });

  it('keeps running out of turns or budget as valid, unsolved evidence', async () => {
    expect(await classify(syntheticStream({ subtype: 'error_max_turns', isError: true }))).toMatchObject({ status: 'max-turns', valid: true });
    expect(await classify(syntheticStream({ subtype: 'error_max_budget_usd', isError: true }))).toMatchObject({ status: 'budget-cap', valid: true });
  });

  it('keeps a timeout as valid evidence but rejects infrastructure failures', async () => {
    expect(await classify(syntheticStream({ withResult: false }), { runInfo: { timedOut: true } })).toMatchObject({ status: 'timeout', valid: true });
    const crashed = await classify(syntheticStream({ withResult: false }));
    expect(crashed).toMatchObject({ status: 'no-result', valid: false });
    expect(crashed.invalidReasons[0]).toMatch(/without a result event/);
    expect(await classify(syntheticStream({ subtype: 'error_during_execution', isError: true }))).toMatchObject({ status: 'api-error', valid: false });
    expect(await classify(syntheticStream({ isError: true }))).toMatchObject({ status: 'api-error', valid: false });
    expect(await classify('', { runInfo: { spawnError: 'ENOENT' } })).toMatchObject({ status: 'spawn-error', valid: false });
  });

  it('rejects runs whose condition did not load or whose MCP tools were denied', async () => {
    const notLoaded = await classify(syntheticStream(), { conditionCheck: { loaded: false, problems: ['MCP server "maxify" missing from init'] } });
    expect(notLoaded.valid).toBe(false);
    expect(notLoaded.invalidReasons[0]).toMatch(/condition not loaded/);
    const denied = await classify(syntheticStream({ denials: ['mcp__maxify__maxify_context'] }));
    expect(denied.valid).toBe(false);
    expect(denied.invalidReasons.join(' ')).toMatch(/denied by permissions/);
    const builtinDenied = await classify(syntheticStream({ denials: ['Bash'] }));
    expect(builtinDenied.valid).toBe(true);
  });

  it('rejects runs whose preparation failed', async () => {
    const result = await classify(syntheticStream(), { prepareProblems: ['maxify: maxify index failed'] });
    expect(result.valid).toBe(false);
    expect(result.invalidReasons[0]).toMatch(/prepare failed/);
  });
});

describe('buildRecord', () => {
  it('assembles a record from the stream summary without inventing numbers', async () => {
    const { parseJsonLines, summarizeStream } = await loadStream();
    const { buildRecord, classifyRun } = await loadExecute();
    const summary = summarizeStream(parseJsonLines(syntheticStream({ toolUses: ['Read', 'mcp__maxify__maxify_context'], costUsd: 0.42 })).events);
    const conditionCheck = { loaded: true, problems: [] };
    const record = buildRecord({
      meta: { runId: 'r1', startedAt: '2026-01-01T00:00:00.000Z', task: 't', category: 'diagnosis', condition: 'maxify', rep: 1, warmth: 'cold', model: 'sonnet', versions: { claudeCode: '2.1.87' } },
      summary,
      runInfo: { timedOut: false, durationMs: 5000 },
      classification: classifyRun({ summary, runInfo: { timedOut: false, durationMs: 5000 }, conditionCheck, prepareProblems: [] }),
      conditionCheck,
      prepare: [],
      checks: { hiddenPass: true, visiblePass: true, answerPass: null, solved: true },
      diff: { files: 1, insertions: 2, deletions: 1, changed: [], modifiedTests: [], addedFiles: [] },
      config: {},
      logs: {},
    });
    expect(record.schema).toBe(1);
    expect(record.usage).toEqual({ inputTokens: 100, outputTokens: 50, cacheCreationTokens: 2000, cacheReadTokens: 4000, totalTokens: 6150 });
    expect(record.totalCostUsd).toBe(0.42);
    expect(record.toolCalls.mcp).toBe(1);
    expect(record.durationMs).toBe(12_345);
    expect(record.valid).toBe(true);
    expect(record.checks.solved).toBe(true);
  });

  it('records an unknown cost as null when the run produced no result event', async () => {
    const { parseJsonLines, summarizeStream } = await loadStream();
    const { buildRecord, classifyRun } = await loadExecute();
    const summary = summarizeStream(parseJsonLines(syntheticStream({ withResult: false })).events);
    const runInfo = { timedOut: true, durationMs: 9000 };
    const record = buildRecord({
      meta: { runId: 'r1', startedAt: 'x', task: 't', category: 'tiny', condition: 'native', rep: 1, warmth: 'cold', model: 'sonnet', versions: {} },
      summary,
      runInfo,
      classification: classifyRun({ summary, runInfo, conditionCheck: { loaded: true, problems: [] }, prepareProblems: [] }),
      conditionCheck: { loaded: true, problems: [] },
      prepare: [],
      checks: { hiddenPass: false, visiblePass: true, answerPass: null, solved: false },
      diff: { files: 0, insertions: 0, deletions: 0, changed: [], modifiedTests: [], addedFiles: [] },
      config: {},
      logs: {},
    });
    expect(record.totalCostUsd).toBeNull();
    expect(record.status).toBe('timeout');
    expect(record.usageSource).toBe('messages');
    expect(record.durationMs).toBe(9000);
  });
});

describe('checks', () => {
  it('parses the TAP summary of node --test', async () => {
    const { parseTapSummary } = await loadChecks();
    const output = ['1..3', '# tests 117', '# suites 37', '# pass 115', '# fail 2', '# cancelled 0', '# skipped 0', '# todo 0', '# duration_ms 1528.6'].join('\n');
    expect(parseTapSummary(output)).toEqual({ tests: 117, pass: 115, fail: 2, cancelled: 0 });
    expect(parseTapSummary('garbage')).toEqual({ tests: null, pass: null, fail: null, cancelled: null });
  });

  it('grades question answers with must-match, must-match-any and must-not-match rules', async () => {
    const { evaluateAnswer } = await loadChecks();
    const checks = { mustMatch: ['loader\\.ts'], mustMatchAny: [['dynamic import', 'computed']], mustNotMatch: ['stripe\\.ts'] };
    expect(evaluateAnswer('See loader.ts: a Dynamic Import is used', checks)).toEqual({ passed: true, failures: [] });
    expect(evaluateAnswer('See config.ts', checks).failures).toEqual(['missing: loader\\.ts', 'missing any of: dynamic import | computed']);
    expect(evaluateAnswer('loader.ts computed stripe.ts', checks).failures).toEqual(['must not mention: stripe\\.ts']);
  });
});

describe('parseArgs', () => {
  const schema = {
    tasks: { type: 'list' },
    reps: { type: 'number', default: 1 },
    model: { type: 'string', default: 'sonnet' },
    'dry-run': { type: 'boolean' },
  };

  it('parses booleans, numbers, strings and repeated lists', async () => {
    const { parseArgs } = await loadArgs();
    const parsed = parseArgs(['--tasks', 'a,b', '--tasks=c', '--reps', '3', '--dry-run', 'positional'], schema);
    expect(parsed.values).toEqual({ tasks: ['a', 'b', 'c'], reps: 3, model: 'sonnet', 'dry-run': true });
    expect(parsed.positionals).toEqual(['positional']);
  });

  it('rejects unknown options, missing values and bad numbers', async () => {
    const { parseArgs, UsageError } = await loadArgs();
    expect(() => parseArgs(['--nope'], schema)).toThrow(UsageError);
    expect(() => parseArgs(['--model'], schema)).toThrow(/needs a value/);
    expect(() => parseArgs(['--model', '--dry-run'], schema)).toThrow(/needs a value/);
    expect(() => parseArgs(['--reps', 'many'], schema)).toThrow(/number/);
    expect(() => parseArgs(['--dry-run=yes'], schema)).toThrow(/does not take a value/);
  });
});
