// Result records (JSONL) and their aggregation. Pure except for file reading/appending.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { formatNumber, formatPercent, formatUsd, mean, sum } from './util.mjs';

export const RESULT_SCHEMA = 1;

/** Fewer runs than this per cell make every comparison indicative only. */
export const MIN_RUNS_FOR_CONFIDENCE = 5;

export function appendRecord(file, record) {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(record)}\n`);
}

/** Expands directories to their *.jsonl files; keeps explicit files. Sorted for determinism. */
export function resultFiles(paths) {
  const files = [];
  for (const entry of paths) {
    if (!existsSync(entry)) throw new Error(`Results path not found: ${entry}`);
    if (statSync(entry).isDirectory()) {
      for (const name of readdirSync(entry).filter((file) => file.endsWith('.jsonl')).sort()) files.push(path.join(entry, name));
    } else {
      files.push(entry);
    }
  }
  return files;
}

export function readRecords(files) {
  const records = [];
  for (const file of files) {
    for (const [index, line] of readFileSync(file, 'utf8').split(/\r?\n/).entries()) {
      if (line.trim() === '') continue;
      try {
        const record = JSON.parse(line);
        if (record !== null && typeof record === 'object' && record.schema === RESULT_SCHEMA) records.push(record);
      } catch {
        throw new Error(`${file}:${index + 1}: invalid JSON line`);
      }
    }
  }
  return records;
}

const tokenTotal = (record) => record.usage.totalTokens;

function summarizeCell(records) {
  const valid = records.filter((record) => record.valid);
  const solved = valid.filter((record) => record.checks.solved);
  const totals = valid.map(tokenTotal);
  // Runs that ended without a result event (timeouts) have no provider-reported cost; they are left out of cost figures.
  const costs = valid.map((record) => record.totalCostUsd).filter((value) => Number.isFinite(value));
  return {
    runs: records.length,
    n: valid.length,
    invalid: records.length - valid.length,
    solved: solved.length,
    successRate: valid.length === 0 ? Number.NaN : solved.length / valid.length,
    meanInputTokens: mean(valid.map((record) => record.usage.inputTokens)),
    meanOutputTokens: mean(valid.map((record) => record.usage.outputTokens)),
    meanCacheCreationTokens: mean(valid.map((record) => record.usage.cacheCreationTokens)),
    meanCacheReadTokens: mean(valid.map((record) => record.usage.cacheReadTokens)),
    meanTotalTokens: mean(totals),
    meanCostUsd: costs.length === 0 ? Number.NaN : mean(costs),
    meanTurns: mean(valid.map((record) => record.numTurns)),
    meanToolCalls: mean(valid.map((record) => record.toolCalls.total)),
    meanMcpCalls: mean(valid.map((record) => record.toolCalls.mcp)),
    meanDurationSec: mean(valid.map((record) => record.durationMs / 1000)),
    meanFirstTurnContext: mean(valid.map((record) => record.firstTurnContextTokens ?? 0)),
    tokensPerSolved: solved.length === 0 ? Number.NaN : sum(totals) / solved.length,
    costPerSolved: solved.length === 0 ? Number.NaN : sum(costs) / solved.length,
    lowSample: valid.length < MIN_RUNS_FOR_CONFIDENCE,
  };
}

function groupBy(records, keyOf) {
  const groups = new Map();
  for (const record of records) {
    const key = keyOf(record);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  return groups;
}

function sortedEntries(map) {
  return [...map].sort(([a], [b]) => String(a).localeCompare(String(b)));
}

/**
 * Regression rule (product rule): a condition that uses fewer tokens, or costs less, than native
 * but solves a smaller share of the runs is a REGRESSION, not a saving.
 */
function compareToNative(cell, native) {
  if (cell.n === 0 || native.n === 0) return null;
  const fewerTokens = cell.meanTotalTokens < native.meanTotalTokens;
  const cheaper = cell.meanCostUsd < native.meanCostUsd;
  const worse = cell.successRate < native.successRate;
  return {
    fewerTokens,
    cheaper,
    worseSuccess: worse,
    regression: (fewerTokens || cheaper) && worse,
    tokenChange: native.meanTotalTokens === 0 ? 0 : (cell.meanTotalTokens - native.meanTotalTokens) / native.meanTotalTokens,
    costChange: native.meanCostUsd === 0 ? 0 : (cell.meanCostUsd - native.meanCostUsd) / native.meanCostUsd,
    successDelta: cell.successRate - native.successRate,
    lowSample: cell.lowSample || native.lowSample,
  };
}

/** Groups records by warmth and condition and applies the regression rule against native. */
export function aggregateRecords(records) {
  const invalid = records.filter((record) => !record.valid);
  const cells = [];
  for (const [warmth, inWarmth] of sortedEntries(groupBy(records, (record) => record.warmth))) {
    const byCondition = groupBy(inWarmth, (record) => record.condition);
    const summaries = new Map([...byCondition].map(([condition, group]) => [condition, summarizeCell(group)]));
    const native = summaries.get('native') ?? null;
    for (const [condition, cell] of [...summaries].sort(([a], [b]) => (a === 'native' ? -1 : b === 'native' ? 1 : a.localeCompare(b)))) {
      cells.push({
        warmth,
        condition,
        ...cell,
        versusNative: condition === 'native' || native === null ? null : compareToNative(cell, native),
      });
    }
  }
  const taskRows = [];
  for (const [warmth, inWarmth] of sortedEntries(groupBy(records, (record) => record.warmth))) {
    for (const [task, inTask] of sortedEntries(groupBy(inWarmth, (record) => record.task))) {
      const cellsByCondition = new Map([...groupBy(inTask, (record) => record.condition)].map(([condition, group]) => [condition, summarizeCell(group)]));
      const native = cellsByCondition.get('native') ?? null;
      for (const [condition, cell] of cellsByCondition) {
        taskRows.push({
          warmth,
          task,
          condition,
          ...cell,
          versusNative: condition === 'native' || native === null ? null : compareToNative(cell, native),
        });
      }
    }
  }
  return {
    cells,
    taskRows,
    invalid: invalid.map((record) => ({ task: record.task, condition: record.condition, rep: record.rep, warmth: record.warmth, reasons: record.invalidReasons })),
    hasRegression: cells.some((cell) => cell.versusNative?.regression === true),
    totalRuns: records.length,
  };
}

function cellLabel(cell) {
  return `${cell.condition}${cell.lowSample ? ' *' : ''}`;
}

function table(header, rows) {
  const line = (cells) => `| ${cells.join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)];
}

function describeVersus(versus) {
  if (versus === null) return 'baseline';
  const bits = [`tokens ${versus.tokenChange >= 0 ? '+' : ''}${Math.round(versus.tokenChange * 100)}%`, `cost ${versus.costChange >= 0 ? '+' : ''}${Math.round(versus.costChange * 100)}%`, `success ${versus.successDelta >= 0 ? '+' : ''}${Math.round(versus.successDelta * 100)} pts`];
  return `${bits.join(', ')}${versus.regression ? ' **REGRESSION**' : ''}`;
}

/** Markdown report. */
export function renderAgentReport(aggregate, meta = {}) {
  const lines = ['# Maxify agent benchmark report', ''];
  lines.push(
    '> Real Claude Code runs: tokens and cost are provider-reported (stream-json `result` event), not local estimates.',
    '> Results depend on model sampling; with few repetitions they are anecdotal. Cells marked * have fewer than ' + MIN_RUNS_FOR_CONFIDENCE + ' valid runs.',
    '',
  );
  if (meta.sources !== undefined) lines.push(`Sources: ${meta.sources.join(', ')}`, '');
  lines.push(`Runs: ${aggregate.totalRuns} (${aggregate.invalid.length} excluded as invalid)`, '');
  if (aggregate.hasRegression) {
    lines.push('## REGRESSION', '');
    for (const cell of aggregate.cells.filter((entry) => entry.versusNative?.regression)) {
      lines.push(`- **${cell.condition}** (${cell.warmth}): ${describeVersus(cell.versusNative)} (success ${formatPercent(cell.successRate)} vs native, ${cell.solved}/${cell.n} solved)${cell.versusNative.lowSample ? ' [low sample]' : ''}`);
    }
    lines.push('');
  }
  for (const warmth of [...new Set(aggregate.cells.map((cell) => cell.warmth))]) {
    lines.push(`## ${warmth === 'cold' ? 'Cold runs' : 'Warm runs'}`, '');
    const rows = aggregate.cells.filter((cell) => cell.warmth === warmth).map((cell) => [
      cellLabel(cell),
      `${cell.solved}/${cell.n}`,
      formatPercent(cell.successRate),
      formatNumber(cell.meanInputTokens),
      formatNumber(cell.meanOutputTokens),
      formatNumber(cell.meanCacheCreationTokens),
      formatNumber(cell.meanCacheReadTokens),
      formatNumber(cell.meanTotalTokens),
      formatUsd(cell.meanCostUsd),
      formatNumber(cell.tokensPerSolved),
      formatUsd(cell.costPerSolved),
      formatNumber(cell.meanTurns, 1),
      `${formatNumber(cell.meanToolCalls, 1)} (${formatNumber(cell.meanMcpCalls, 1)} MCP)`,
      formatNumber(cell.meanFirstTurnContext),
      formatNumber(cell.meanDurationSec, 0),
      describeVersus(cell.versusNative),
    ]);
    lines.push(
      ...table(
        ['Condition', 'Solved', 'Success', 'Input', 'Output', 'Cache write', 'Cache read', 'Total tokens', 'Cost', 'Tokens/solved', 'Cost/solved', 'Turns', 'Tool calls', 'First-turn context', 'Seconds', 'Versus native'],
        rows,
      ),
      '',
    );
    const perTask = aggregate.taskRows.filter((row) => row.warmth === warmth);
    const tasks = [...new Set(perTask.map((row) => row.task))];
    const conditions = [...new Set(perTask.map((row) => row.condition))];
    lines.push(
      ...table(
        ['Task', ...conditions],
        tasks.map((task) => [
          task,
          ...conditions.map((condition) => {
            const row = perTask.find((entry) => entry.task === task && entry.condition === condition);
            if (row === undefined) return '-';
            return `${row.solved}/${row.n} (${formatNumber(row.meanTotalTokens)} tok)${row.versusNative?.regression ? ' **REGRESSION**' : ''}`;
          }),
        ]),
      ),
      '',
    );
  }
  if (aggregate.invalid.length > 0) {
    lines.push('## Excluded runs', '');
    for (const entry of aggregate.invalid) lines.push(`- ${entry.task} / ${entry.condition} / rep ${entry.rep} (${entry.warmth}): ${entry.reasons.join('; ')}`);
    lines.push('');
  }
  lines.push(
    '## Definitions',
    '',
    '- Solved: hidden test passes AND the visible suite passes (question tasks: answer rubric passes and no file was changed).',
    '- Tokens: input (uncached), output, cache write (cache_creation_input_tokens), cache read; Total tokens is their sum. Cache reads are cheap per token but grow with every turn.',
    '- Tokens/solved: total tokens of all valid runs divided by the number solved, so failed attempts are charged to the successes.',
    '- First-turn context: input plus cache tokens of the first model call, i.e. what the setup (system prompt, tool schemas, CLAUDE.md) costs before any work.',
    '- REGRESSION: a condition has lower mean tokens or lower mean cost than native in the same warm/cold group but a lower success rate.',
    '- Cold: unique run nonce in CLAUDE.md, Maxify not pre-indexed. Warm: the same run repeated right after a cold run in the same path with the same nonce, Maxify pre-indexed. Prompt-cache hits are not controllable; compare cache write/read columns.',
    '',
  );
  return `${lines.join('\n')}\n`;
}
