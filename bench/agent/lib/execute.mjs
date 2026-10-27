// Executes ONE Claude Code run in a prepared workspace and turns it into a result record.
// classifyRun and buildRecord are pure and unit-tested with synthetic streams; executeRun spends usage.
import { copyFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { diffStats, evaluateAnswer, listVisibleTests, runNodeTests } from './checks.mjs';
import { BUILTIN_TOOLS, CLAUDE_ENV_OVERRIDES, buildClaudeArgs, runClaude } from './claude.mjs';
import { contributionsFor, prepareCondition, verifyConditionLoaded } from './conditions.mjs';
import { parseJsonLines, summarizeStream, totalTokens } from './stream.mjs';
import { RESULT_SCHEMA } from './results.mjs';
import { sha256 } from './util.mjs';
import { removeConditionFiles, writeBaseClaudeMd, writeConditionFiles } from './workspace.mjs';

const RESULT_TEXT_LIMIT = 4000;

/** Decides the run status and whether the run is valid evidence for its condition. */
export function classifyRun({ summary, runInfo, conditionCheck, prepareProblems }) {
  const reasons = prepareProblems.map((problem) => `prepare failed: ${problem}`);
  if (runInfo.spawnError !== undefined) reasons.push(`could not start claude: ${runInfo.spawnError}`);
  for (const problem of conditionCheck.problems) reasons.push(`condition not loaded: ${problem}`);

  let status;
  if (runInfo.spawnError !== undefined) status = 'spawn-error';
  else if (runInfo.timedOut) status = 'timeout';
  else if (!summary.hasResult) {
    status = 'no-result';
    reasons.push('claude ended without a result event');
  } else if (summary.result.subtype === 'success') status = 'completed';
  else if (summary.result.subtype === 'error_max_turns') status = 'max-turns';
  else if (summary.result.subtype === 'error_max_budget_usd') status = 'budget-cap';
  else {
    status = 'api-error';
    reasons.push(`run ended with ${summary.result.subtype}`);
  }
  if (status === 'completed' && summary.result.isError) {
    status = 'api-error';
    reasons.push('result event is flagged is_error');
  }
  const denied = (summary.result?.permissionDenials ?? []).filter((denial) => denial.toolName.startsWith('mcp__'));
  if (denied.length > 0) reasons.push(`MCP tool calls denied by permissions: ${[...new Set(denied.map((denial) => denial.toolName))].join(', ')}`);
  return { status, valid: reasons.length === 0, invalidReasons: reasons };
}

/** Assembles the JSONL record. Pure. */
export function buildRecord({ meta, summary, runInfo, classification, conditionCheck, prepare, checks, diff, config, logs }) {
  const usage = summary.usage;
  return {
    schema: RESULT_SCHEMA,
    runId: meta.runId,
    startedAt: meta.startedAt,
    task: meta.task,
    category: meta.category,
    condition: meta.condition,
    rep: meta.rep,
    warmth: meta.warmth,
    model: meta.model,
    modelReported: summary.init?.model ?? null,
    versions: meta.versions,
    status: classification.status,
    valid: classification.valid,
    invalidReasons: classification.invalidReasons,
    conditionLoaded: conditionCheck.loaded,
    conditionProblems: conditionCheck.problems,
    prepare,
    usage: { ...usage, totalTokens: totalTokens(usage) },
    usageSource: summary.usageSource,
    firstTurnContextTokens: summary.firstTurnContextTokens,
    totalCostUsd: summary.result === null ? null : summary.result.totalCostUsd,
    numTurns: summary.result === null ? summary.assistantMessages : summary.result.numTurns,
    durationMs: summary.result === null || summary.result.durationMs === 0 ? runInfo.durationMs : summary.result.durationMs,
    durationApiMs: summary.result === null ? null : summary.result.durationApiMs,
    wallMs: runInfo.durationMs,
    toolCalls: summary.toolCalls,
    toolResults: summary.toolResults,
    permissionDenials: summary.result?.permissionDenials ?? [],
    checks,
    diff,
    resultText: (summary.result?.text ?? '').slice(0, RESULT_TEXT_LIMIT),
    init:
      summary.init === null
        ? null
        : {
            tools: summary.init.tools.length,
            mcpServers: summary.init.mcpServers,
            plugins: summary.init.plugins,
            slashCommands: summary.init.slashCommands.length,
            apiKeySource: summary.init.apiKeySource,
            permissionMode: summary.init.permissionMode,
          },
    config,
    logs,
  };
}

/** Success checks for a finished workspace. Code tasks: hidden + visible tests. Question tasks: answer rubric. */
export function runChecks(task, dir, resultText) {
  const diff = diffStats(dir);
  if (task.category === 'question') {
    const answer = evaluateAnswer(resultText, task.answerChecks);
    const untouched = diff.files === 0;
    return {
      diff,
      checks: {
        hiddenPass: null,
        visiblePass: null,
        answerPass: answer.passed,
        answerFailures: answer.failures,
        solved: answer.passed && untouched,
        note: untouched ? undefined : 'files were changed in a read-only task',
      },
    };
  }
  copyFileSync(task.hiddenTest, path.join(dir, 'test', task.hiddenTestName));
  const hidden = runNodeTests(dir, [`test/${task.hiddenTestName}`]);
  const visible = runNodeTests(dir, listVisibleTests(dir, task.hiddenTestName));
  return {
    diff,
    checks: {
      hiddenPass: hidden.passed,
      visiblePass: visible.passed,
      answerPass: null,
      solved: hidden.passed && visible.passed,
      hidden: { pass: hidden.pass, fail: hidden.fail, crashed: hidden.crashed },
      visible: { pass: visible.pass, fail: visible.fail, crashed: visible.crashed },
    },
  };
}

function unique(list) {
  return [...new Set(list)];
}

/**
 * Prepares the condition inside `dir`, runs Claude Code and records the outcome.
 * `ctx`: { dir, tempRoot, nonce, runDir, features, options, versions, runId, onChild? }.
 */
export async function executeRun({ task, condition, rep, warmth, ctx }) {
  const { dir, tempRoot, nonce, runDir, features, options } = ctx;
  const startedAt = new Date().toISOString();
  const maxifyHome = path.join(tempRoot, 'maxify-home');

  removeConditionFiles(dir);
  writeBaseClaudeMd(dir, nonce);
  const prepareCtx = { workspace: dir, tempRoot, maxifyHome, warmth };
  const prepare = prepareCondition(condition, prepareCtx);
  const contribution = contributionsFor(condition, prepareCtx, features);
  const mcpConfigPath = writeConditionFiles(dir, contribution);
  const claudeMd = readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');

  const allowedTools = unique([...task.allowedTools, ...contribution.allowedTools]);
  const args = buildClaudeArgs({
    prompt: task.prompt,
    model: options.model,
    maxTurns: task.maxTurns,
    mcpConfigPath,
    allowedTools,
    maxBudgetUsd: options.maxBudgetUsd,
    effort: options.effort,
    extraArgs: contribution.extraArgs,
  });
  const label = `${task.id}__${condition}__rep${rep}__${warmth}`;
  const logs = { stream: path.join(runDir, `${label}.stream.jsonl`), stderr: path.join(runDir, `${label}.stderr.log`) };
  const prepareProblems = prepare.filter((step) => !step.ok).map((step) => `${step.feature}: ${step.detail}`);

  let runInfo;
  if (prepareProblems.length > 0) {
    runInfo = { stdout: '', stderr: '', timedOut: false, durationMs: 0, exitCode: null, signal: null };
  } else {
    runInfo = await runClaude({
      args,
      cwd: dir,
      env: { ...process.env, ...CLAUDE_ENV_OVERRIDES, ...contribution.env },
      timeoutMs: task.timeoutMs,
      stdoutLog: logs.stream,
      stderrLog: logs.stderr,
      onChild: ctx.onChild,
    });
  }

  const { events, invalidLines } = parseJsonLines(runInfo.stdout);
  const summary = summarizeStream(events);
  const conditionCheck = prepareProblems.length > 0 ? { loaded: false, problems: ['preparation failed'] } : verifyConditionLoaded(condition, summary.init);
  const classification = classifyRun({ summary, runInfo, conditionCheck, prepareProblems });
  const { diff, checks } = runChecks(task, dir, summary.result?.text ?? '');

  return buildRecord({
    meta: { runId: ctx.runId, startedAt, task: task.id, category: task.category, condition, rep, warmth, model: options.model, versions: ctx.versions },
    summary,
    runInfo,
    classification,
    conditionCheck,
    prepare,
    checks,
    diff,
    config: {
      builtinTools: BUILTIN_TOOLS,
      allowedTools,
      claudeMdSha256: sha256(claudeMd),
      claudeMdLines: claudeMd.split('\n').length,
      mcpServers: Object.keys(contribution.mcpServers),
      settingsKeys: Object.keys(contribution.settings),
      maxTurns: task.maxTurns,
      maxBudgetUsd: options.maxBudgetUsd,
      effort: options.effort ?? null,
      nonce,
      invalidStreamLines: invalidLines,
    },
    logs,
  });
}
