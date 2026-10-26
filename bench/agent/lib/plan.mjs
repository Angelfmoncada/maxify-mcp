// Run plan: which (task, condition, repetition) jobs will run, how many Claude Code runs that means,
// and what the safety limits are. Printing the plan is free; executing it spends the user's usage.
import { displayArg } from './claude.mjs';
import { formatUsd } from './util.mjs';

export const DEFAULT_MAX_BUDGET_USD = 2;
export const DEFAULT_MAX_TOTAL_USD = 25;

/** Expands tasks x conditions x repetitions. Each job runs once cold and, with warmth "both", once warm. */
export function buildPlan({ tasks, conditions, reps, warmth, maxBudgetUsd, maxTotalUsd }) {
  const jobs = [];
  for (const task of tasks) {
    for (const condition of conditions) {
      for (let rep = 1; rep <= reps; rep += 1) jobs.push({ task, condition, rep });
    }
  }
  const runsPerJob = warmth === 'both' ? 2 : 1;
  const runs = jobs.length * runsPerJob;
  return {
    jobs,
    runsPerJob,
    runs,
    reps,
    warmth,
    maxBudgetUsd,
    maxTotalUsd,
    perRunCapTotalUsd: runs * maxBudgetUsd,
    // The stop-loss halts before starting a run once the sum of reported costs reaches maxTotalUsd,
    // so the worst case is the total limit plus one more run at its own cap.
    worstCaseUsd: Math.min(runs * maxBudgetUsd, maxTotalUsd + maxBudgetUsd),
  };
}

function conditionLine(info) {
  const status = info.available ? 'available' : 'UNAVAILABLE';
  const details = info.available
    ? [info.versions.length > 0 ? info.versions.join(', ') : null, info.usesCaveman ? 'opt-in: caveman hooks write state files under ~/.claude' : null]
        .filter(Boolean)
        .join('; ')
    : info.reason;
  return `  ${info.name.padEnd(22)} ${status}${details === '' ? '' : `  ${details}`}`;
}

/** Human-readable plan, including the exact command line of the first run. */
export function renderPlan(plan, { conditionInfos, model, effort, claudeVersion, authNote, exampleArgs }) {
  const lines = ['Agent benchmark plan', ''];
  lines.push(`Claude Code: ${claudeVersion ?? 'NOT FOUND on PATH'}    model: ${model}${effort === undefined ? '' : `    effort: ${effort}`}`);
  if (authNote !== undefined) lines.push(authNote);
  lines.push('', 'Conditions:', ...conditionInfos.map(conditionLine), '');
  lines.push(`Tasks: ${[...new Set(plan.jobs.map((job) => job.task.id))].join(', ') || '(none)'}`);
  lines.push(
    `Jobs: ${plan.jobs.length} (task x condition x repetition, ${plan.reps} repetition(s))`,
    `Warmth: ${plan.warmth === 'both' ? 'cold then warm (each job runs twice)' : 'cold only'}`,
    `CLAUDE CODE RUNS: ${plan.runs}`,
    '',
    'Spend limits (enforced by the harness and by claude --max-budget-usd):',
    `  per run cap          ${formatUsd(plan.maxBudgetUsd)}`,
    `  total stop-loss      ${formatUsd(plan.maxTotalUsd)} of reported cost (no new run starts after it is reached)`,
    `  worst-case bound     ${formatUsd(plan.worstCaseUsd)} (an upper bound, NOT an estimate of the real cost)`,
    '  Real cost is unknown until a run happens: do a pilot first, e.g. --tasks <one tiny task> --conditions native --reps 1,',
    '  read total_cost_usd in the results, then extrapolate.',
    '',
  );
  if (exampleArgs !== undefined) {
    lines.push('First run command (prompt shortened):', `  claude ${exampleArgs.map(displayArg).join(' ')}`, '');
  }
  return lines.join('\n');
}
