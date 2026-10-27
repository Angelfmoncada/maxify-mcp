#!/usr/bin/env node
// Agent benchmark runner. DRY RUN BY DEFAULT: it prints the plan and the number of Claude Code runs.
// Runs only start with --confirm-spend, because every run spends the user's Claude usage.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { UsageError, parseArgs } from './lib/args.mjs';
import { BUILTIN_TOOLS, buildClaudeArgs, claudeCommand, claudeVersion, killTree } from './lib/claude.mjs';
import { ALL_CONDITIONS, CONDITION_FEATURES, describeCondition, detectFeatures } from './lib/conditions.mjs';
import { executeRun } from './lib/execute.mjs';
import { DEFAULT_MAX_BUDGET_USD, DEFAULT_MAX_TOTAL_USD, buildPlan, renderPlan } from './lib/plan.mjs';
import { appendRecord } from './lib/results.mjs';
import { loadAgentTasks } from './lib/tasks.mjs';
import { AGENT_TASKS_DIR, RESULTS_DIR, errorMessage, formatUsd, makeTempRoot, shortId } from './lib/util.mjs';
import { createWorkspace, removeTree, resetWorkspace } from './lib/workspace.mjs';

const SCHEMA = {
  tasks: { type: 'list' },
  conditions: { type: 'list' },
  reps: { type: 'number', default: 1 },
  warmth: { type: 'string', default: 'cold' },
  model: { type: 'string', default: 'sonnet' },
  effort: { type: 'string' },
  'max-budget-usd': { type: 'number', default: DEFAULT_MAX_BUDGET_USD },
  'max-total-usd': { type: 'number', default: DEFAULT_MAX_TOTAL_USD },
  'skip-unavailable': { type: 'boolean' },
  out: { type: 'string' },
  'keep-workspaces': { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  'confirm-spend': { type: 'boolean' },
  help: { type: 'boolean' },
};

const USAGE = `Usage: node bench/agent/run.mjs [options]

Default is a DRY RUN: prints the plan, the run count and the spend limits. Nothing is executed.
Add --confirm-spend to start real Claude Code runs (they spend your Claude usage).

  --tasks a,b            task ids under bench/tasks/agent (default: all)
  --conditions a,b       ${ALL_CONDITIONS.join(', ')}, or "all"
                         default: every available condition
  --reps N               repetitions per task and condition (default 1; use 3+ before concluding anything)
  --warmth cold|both     "both" repeats each job warm right after the cold run (default cold)
  --model NAME           model alias or id passed to claude --model (default sonnet)
  --effort LEVEL         low|medium|high|max, passed through when given
  --max-budget-usd X     per-run cap passed to claude --max-budget-usd (default ${DEFAULT_MAX_BUDGET_USD})
  --max-total-usd X      stop starting new runs once reported cost reaches X (default ${DEFAULT_MAX_TOTAL_USD})
  --skip-unavailable     drop requested conditions that are unavailable instead of aborting
  --out FILE             results JSONL (default bench/results/agent-<runId>.jsonl)
  --keep-workspaces      keep the temporary workspaces for inspection
  --dry-run              explicit dry run (wins over --confirm-spend)
  --confirm-spend        actually run
`;

function fail(message) {
  process.stderr.write(`${message}\n`);
  return 2;
}

function resolveConditions(requested, infos, skipUnavailable) {
  const byName = new Map(infos.map((info) => [info.name, info]));
  let names;
  if (requested === undefined || requested.length === 0 || (requested.length === 1 && requested[0] === 'all')) {
    names = infos.filter((info) => info.available).map((info) => info.name);
  } else {
    const unknown = requested.filter((name) => !byName.has(name));
    if (unknown.length > 0) return { error: `Unknown condition(s): ${unknown.join(', ')}. Known: ${ALL_CONDITIONS.join(', ')}` };
    const unavailable = requested.filter((name) => !byName.get(name).available);
    if (unavailable.length > 0 && !skipUnavailable) {
      return { error: `Unavailable condition(s): ${unavailable.map((name) => `${name} (${byName.get(name).reason})`).join('; ')}. Use --skip-unavailable to drop them.` };
    }
    names = requested.filter((name) => byName.get(name).available);
  }
  if (names.length === 0) return { error: 'No runnable conditions selected.' };
  return { names };
}

function authNote() {
  const present = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'].filter((name) => process.env[name]);
  return present.length > 0
    ? `Billing: ${present.join(', ')} set in this environment, so runs may bill that account instead of the logged-in plan. Unset it to use the plan.`
    : 'Billing: no API-key variables in the environment; Claude Code uses its own login. Each result records apiKeySource from the init event.';
}

function collectVersions(conditionNames, features, claude) {
  const used = new Set(conditionNames.flatMap((name) => CONDITION_FEATURES[name]));
  const versions = { claudeCode: claude, node: process.version, harness: 1 };
  if (used.has('maxify')) versions.maxify = features.maxify.version;
  return versions;
}

function describeResult(record, index, total) {
  const state = record.valid ? (record.checks.solved ? 'SOLVED' : 'unsolved') : `INVALID (${record.invalidReasons[0] ?? 'unknown'})`;
  const cost = record.totalCostUsd === null ? 'cost n/a' : formatUsd(record.totalCostUsd);
  return `[${index}/${total}] ${record.task} / ${record.condition} / rep ${record.rep} / ${record.warmth}: ${state}, ${record.usage.totalTokens.toLocaleString('en-US')} tokens, ${cost}, ${record.numTurns} turns, status ${record.status}`;
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv, SCHEMA);
  } catch (error) {
    if (error instanceof UsageError) return fail(`${error.message}\n\n${USAGE}`);
    throw error;
  }
  const o = parsed.values;
  if (o.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!['cold', 'both'].includes(o.warmth)) return fail('--warmth must be cold or both');
  if (!Number.isInteger(o.reps) || o.reps < 1) return fail('--reps must be a positive integer');
  if (o.effort !== undefined && !['low', 'medium', 'high', 'max'].includes(o.effort)) return fail('--effort must be low, medium, high or max');
  if (!(o['max-budget-usd'] > 0) || !(o['max-total-usd'] > 0)) return fail('--max-budget-usd and --max-total-usd must be positive');

  let tasks;
  try {
    tasks = loadAgentTasks(AGENT_TASKS_DIR, o.tasks);
  } catch (error) {
    return fail(errorMessage(error));
  }
  const features = detectFeatures();
  const infos = ALL_CONDITIONS.map((name) => describeCondition(name, features));
  const selection = resolveConditions(o.conditions, infos, o['skip-unavailable'] === true);
  if (selection.error !== undefined) return fail(selection.error);

  const plan = buildPlan({
    tasks,
    conditions: selection.names,
    reps: o.reps,
    warmth: o.warmth,
    maxBudgetUsd: o['max-budget-usd'],
    maxTotalUsd: o['max-total-usd'],
  });
  let overridden;
  try {
    overridden = claudeCommand().overridden;
  } catch (error) {
    return fail(errorMessage(error));
  }
  if (overridden) process.stderr.write('WARNING: MAXIFY_BENCH_CLAUDE is set. A stand-in is used instead of the real Claude Code (test hook).\n');
  const claude = claudeVersion();
  const firstJob = plan.jobs[0];
  const exampleArgs = firstJob === undefined ? undefined : buildClaudeArgs({
    prompt: firstJob.task.prompt,
    model: o.model,
    maxTurns: firstJob.task.maxTurns,
    mcpConfigPath: '<workspace>/.mcp.json',
    allowedTools: firstJob.task.allowedTools,
    maxBudgetUsd: o['max-budget-usd'],
    effort: o.effort,
  });
  process.stdout.write(`${renderPlan(plan, { conditionInfos: infos, model: o.model, effort: o.effort, claudeVersion: claude, authNote: authNote(), exampleArgs })}\n`);
  process.stdout.write(
    `Built-in tools for every run: ${BUILTIN_TOOLS.join(', ')}; permission mode acceptEdits; --setting-sources project excludes user-level settings.\n` +
      'Check the first results (init.slashCommands, firstTurnContextTokens of native) to confirm nothing from ~/.claude leaks into the runs.\n\n',
  );

  if (o['dry-run'] === true || o['confirm-spend'] !== true) {
    process.stdout.write(`DRY RUN: nothing was executed. ${plan.runs} Claude Code run(s) would start.\nTo execute, repeat the command with --confirm-spend.\n`);
    return 0;
  }
  if (claude === null) return fail('claude was not found on PATH; cannot execute.');
  return execute(plan, o, features, selection.names, claude);
}

async function execute(plan, o, features, conditionNames, claude) {
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${shortId(3)}`;
  const outFile = path.resolve(o.out ?? path.join(RESULTS_DIR, `agent-${runId}.jsonl`));
  // Per-run artifacts live next to the results file, so --out keeps everything in one place.
  const runDir = path.join(path.dirname(outFile), runId);
  mkdirSync(runDir, { recursive: true });
  const versions = collectVersions(conditionNames, features, claude);
  const options = { model: o.model, effort: o.effort, maxBudgetUsd: o['max-budget-usd'] };

  let stopping = false;
  let activeChild = null;
  process.on('SIGINT', () => {
    stopping = true;
    process.stderr.write('\nInterrupted: finishing up, no new run will start.\n');
    if (activeChild !== null) killTree(activeChild);
  });

  let spent = 0;
  let completed = 0;
  const record = (result) => {
    appendRecord(outFile, result);
    completed += 1;
    if (Number.isFinite(result.totalCostUsd)) spent += result.totalCostUsd;
    process.stdout.write(`${describeResult(result, completed, plan.runs)}\n`);
  };

  for (const job of plan.jobs) {
    if (stopping) break;
    if (spent >= plan.maxTotalUsd) {
      process.stdout.write(`Stop-loss reached: reported cost ${formatUsd(spent)} >= ${formatUsd(plan.maxTotalUsd)}. Remaining jobs skipped.\n`);
      break;
    }
    const tempRoot = makeTempRoot();
    try {
      const dir = createWorkspace({ tempRoot, setupPatch: job.task.setupPatch });
      const ctx = { dir, tempRoot, nonce: shortId(6), runDir, features, options, versions, runId, onChild: (child) => { activeChild = child; } };
      record(await executeRun({ task: job.task, condition: job.condition, rep: job.rep, warmth: 'cold', ctx }));
      if (plan.warmth === 'both' && !stopping && spent < plan.maxTotalUsd) {
        resetWorkspace(dir);
        record(await executeRun({ task: job.task, condition: job.condition, rep: job.rep, warmth: 'warm', ctx }));
      }
    } catch (error) {
      process.stderr.write(`Job ${job.task.id}/${job.condition}/rep${job.rep} aborted by a harness error: ${errorMessage(error)}\n`);
    } finally {
      activeChild = null;
      if (o['keep-workspaces'] === true) process.stdout.write(`kept workspace: ${tempRoot}\n`);
      else removeTree(tempRoot);
    }
  }
  process.stdout.write(`\nResults: ${outFile}\nRaw streams: ${runDir}\nReport: node bench/agent/report.mjs ${path.relative(process.cwd(), outFile) || outFile}\n`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  },
);
