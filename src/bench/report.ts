/** Markdown and JSON rendering of the offline benchmark report. */
import type { Aggregates, BudgetSummary, Comparison } from './aggregate.js';
import type { MaxifyTaskRun, OfflineReport, SimRun, TaskResult } from './offline-types.js';

export const OFFLINE_NOTICE =
  'offline simulation; token counts are local estimates, not Claude tokenizer counts; not agent results';

const NA = 'n/a';

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function row(cells: readonly string[]): string {
  return `| ${cells.map(cell).join(' | ')} |`;
}

function table(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  return [row(header), row(header.map(() => '---')), ...rows.map(row)];
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function tok(value: number): string {
  return String(Math.round(value));
}

function signedPct(value: number): string {
  const rounded = Math.round(value * 100);
  return `${rounded > 0 ? '+' : ''}${rounded}%`;
}

function describeComparison(entry: Comparison): string {
  const verdict = entry.regression ? 'REGRESSION: fewer tokens, lower recall' : 'ok';
  return `${signedPct(entry.tokenChange)} tokens, recall ${pct(entry.maxifyRecall)} vs ${pct(entry.baselineRecall)} (${verdict})`;
}

function summaryRows(budgets: readonly BudgetSummary[]): string[][] {
  return budgets.map((entry) => {
    const m = entry.maxify;
    return [
      String(entry.budget),
      m === null ? NA : tok(m.meanFirstTokens),
      m === null ? NA : tok(m.meanTotalTokens),
      tok(entry.simA.meanTokens),
      tok(entry.simB.meanTokens),
      m === null ? NA : pct(m.meanRecallFirst),
      m === null ? NA : pct(m.meanRecallFinal),
      pct(entry.simA.meanRecall),
      pct(entry.simB.meanRecall),
      m === null ? NA : `${m.tasksWithForbiddenHits}/${entry.tasks} (${m.tasksWithStrongForbiddenHits} at sig/src)`,
      `${entry.simA.tasksReadingForbidden}/${entry.tasks}`,
      `${entry.simB.tasksReadingForbidden}/${entry.tasks}`,
    ];
  });
}

function budgetDetails(entry: BudgetSummary): string[] {
  const m = entry.maxify;
  if (m === null) return [];
  const lines = [`### Budget ${entry.budget}`, ''];
  lines.push(
    `- Maxify: mean ${tok(m.meanFirstTokens)} tokens in the first call, ${tok(m.meanTotalTokens)} including ${m.followUpCalls} follow-up call(s); ` +
      `full recall on ${m.fullFirst}/${entry.tasks} tasks after the first call and ${m.fullFinal}/${entry.tasks} after follow-ups.`,
  );
  lines.push(`- Maxify latency of the first call: median ${m.latencyMedianMs.toFixed(0)} ms, max ${m.latencyMaxMs.toFixed(0)} ms.`);
  lines.push(
    `- Maxify results over budget: ${m.overBudget}, incomplete: ${m.incomplete}, call errors: ${m.errors}; ` +
      `tasks with a decoy in the evidence: ${m.tasksWithForbiddenHits} (shown as signature or source code in ${m.tasksWithStrongForbiddenHits}); ` +
      `tasks whose text merely mentions a forbidden path: ${m.tasksMentioningForbidden}.`,
  );
  lines.push(`- Native A (grep + read 3 files): full recall on ${entry.simA.fullTasks}/${entry.tasks} tasks, ${entry.simA.meanCalls.toFixed(1)} calls on average.`);
  lines.push(`- Native B (grep + 8 line windows): full recall on ${entry.simB.fullTasks}/${entry.tasks} tasks, ${entry.simB.meanCalls.toFixed(1)} calls on average.`);
  for (const comparison of entry.comparisons) {
    lines.push(`- ${comparison.scope} vs native ${comparison.baseline}: ${describeComparison(comparison)}.`);
  }
  return [...lines, ''];
}

function taskRows(tasks: readonly TaskResult[], budget: number): string[][] {
  return tasks.map((task) => {
    const run = task.maxify.find((entry) => entry.budget === budget);
    const forbidden = `${run === undefined ? NA : run.forbiddenHits.length}/${task.simA.forbiddenRead.length}/${task.simB.forbiddenRead.length}`;
    const calls = `${run === undefined ? NA : run.totalCalls}/${task.simA.calls}/${task.simB.calls}`;
    return [
      task.id,
      task.category,
      run === undefined ? NA : tok(run.firstCall.tokens),
      run === undefined ? NA : tok(run.totalTokens),
      tok(task.simA.tokens),
      tok(task.simB.tokens),
      run === undefined ? NA : pct(run.recallFirst),
      run === undefined ? NA : pct(run.recallFinal),
      pct(task.simA.recall),
      pct(task.simB.recall),
      forbidden,
      calls,
      run === undefined ? NA : run.firstCall.latencyMs.toFixed(0),
      run === undefined ? NA : run.firstCall.complete ? 'yes' : 'no',
    ];
  });
}

function missedLines(tasks: readonly TaskResult[], budget: number): string[] {
  const lines: string[] = [];
  for (const task of tasks) {
    const run: MaxifyTaskRun | undefined = task.maxify.find((entry) => entry.budget === budget);
    if (run === undefined || (run.missedFirst.length === 0 && run.missedFinal.length === 0)) continue;
    lines.push(`- ${task.id}: missed after first call: ${run.missedFirst.join(', ') || 'none'}; missed after follow-ups: ${run.missedFinal.join(', ') || 'none'}`);
  }
  return lines.length === 0 ? ['- none'] : lines;
}

function checkLines(tasks: readonly TaskResult[]): string[] {
  const lines: string[] = [];
  for (const task of tasks) {
    for (const run of task.maxify) {
      const notes: string[] = [];
      if (run.editDetected === false) notes.push('re-index did not report the edited file as changed');
      if (run.forbiddenTextHits.length > 0) notes.push(`stale text still returned: ${run.forbiddenTextHits.join(' | ')}`);
      if (run.requireTextOk === false) notes.push('required wording (uncertainty notice) missing from the text');
      if (run.firstCall.overBudget) notes.push('estimated size exceeds the budget');
      if (run.firstCall.error !== undefined) notes.push(`error: ${run.firstCall.error}`);
      if (notes.length > 0) lines.push(`- ${task.id} @${run.budget}: ${notes.join('; ')}`);
    }
  }
  return lines.length === 0 ? ['- none'] : lines;
}

function simReadLines(label: string, runs: readonly { id: string; sim: SimRun }[]): string[] {
  return [`- ${label}: ` + runs.map((entry) => `${entry.id} [${entry.sim.keywords.join(', ')}]`).join('; ')];
}

function methodology(report: OfflineReport): string[] {
  const c = report.constants;
  return [
    '## Methodology and limitations',
    '',
    '- Everything here is an offline simulation on one small fixture repository. It measures how much of the evidence a task needs reaches the model and what that costs in estimated tokens. It does not measure whether an agent answers correctly.',
    `- Token counts use the local estimator (\`estimateTokens\`), never a Claude tokenizer. Each call costs the estimated tokens of its arguments, of its output and a fixed ${c.perCallOverheadTokens} tokens of client wrapper. Maxify and the baselines use the same ruler.`,
    '- Maxify: one `maxify_context({task, budget})` call per task and budget. Recall@first call uses only that result. The "diligent follow-up" simulation then makes one call for every requirement still missing and recomputes recall: `maxify_source({ref})` for signature and source gaps, a focused map-detail `maxify_context` call when only the location was required. It knows exactly which refs are missing, which is optimistic for Maxify; a real agent would have to notice the gap.',
    `- Native A (grep-read-files): keywords are taken from the prompt (quoted strings, identifiers, camelCase/snake_case parts, words of 4+ characters minus stopwords, light stemming, at most ${c.maxKeywords}); one case-insensitive grep lists matching files with hit counts; the top ${c.readFileCount} files by distinct keywords then hit lines are read fully with \`cat -n\` line numbers. The ranking uses counts that plain grep -l does not print, so it favors the baseline.`,
    `- Native B (grep-read-ranges): same keywords; matching lines are grouped into windows of +/-${c.windowRadius} lines (overlaps merged per file) and the best ${c.maxWindows} windows are read. Windows are chosen with knowledge of all hits, which also favors the baseline.`,
    '- Neither simulation reflects real agent behavior: real agents grep with smarter patterns, stop early, or read more. They bound what a naive keyword workflow costs and finds.',
    '- A requirement is satisfied when evidence covers the symbol or range at the required level or higher (source > signature > map). Source level needs every line of the symbol inside source-level evidence. Symbol ranges come from an independent TypeScript-API oracle, not from the engine.',
    '- Forbidden hits count decoys that appear in the selected evidence at any level (Maxify; "at sig/src" counts those shown as signature or source code) or in files actually read (baselines). A decoy merely mentioned in Maxify text is reported separately.',
    '- A REGRESSION is flagged whenever Maxify uses fewer tokens than a baseline and has lower recall in the same scope (aggregate per budget, or per task). Fewer tokens with worse resolution is not a saving.',
    '- Ground truth was written by the benchmark author against this fixture; a different author could choose different requirements. A fixture of about 3.7k lines says little about large repositories.',
    '',
  ];
}

/** Human-readable report. */
export function renderMarkdown(report: OfflineReport, agg: Aggregates): string {
  const lines: string[] = ['# Maxify offline benchmark', '', `> ${OFFLINE_NOTICE}`, ''];
  lines.push(
    `- Generated: ${report.generatedAt}`,
    `- Fixture: ${report.fixture.name} (${report.fixture.files} text files, ${report.fixture.lines} lines)`,
    `- Tasks: ${report.tasks.length}; budgets: ${report.budgets.join(', ')}`,
    `- Maxify engine: ${report.engine.available ? 'available' : `UNAVAILABLE (${report.engine.reason ?? 'unknown reason'}); Maxify columns show ${NA}, baselines only`}`,
  );
  if (report.index !== null) {
    const index = report.index;
    lines.push(
      `- Cold index: ${index.coldMs.toFixed(0)} ms for ${index.coldFiles} files (${index.coldErrors} error(s)); ` +
        `incremental re-index after a one-file edit: ${index.incrementalMs.toFixed(0)} ms (${index.incrementalChanged} changed, ${index.incrementalUnchanged} unchanged)`,
    );
  }
  lines.push('');

  if (agg.hasAggregateRegression || agg.taskRegressions.length > 0) {
    lines.push('## REGRESSION flags', '');
    for (const entry of agg.budgets) {
      for (const comparison of entry.comparisons.filter((item) => item.regression)) {
        lines.push(`- **REGRESSION** budget ${entry.budget}, ${comparison.scope} vs native ${comparison.baseline}: ${describeComparison(comparison)}`);
      }
    }
    for (const item of agg.taskRegressions) {
      lines.push(
        `- task ${item.taskId} @${item.budget}, ${item.scope} vs native ${item.baseline}: ${tok(item.maxifyTokens)} vs ${tok(item.baselineTokens)} tokens, recall ${pct(item.maxifyRecall)} vs ${pct(item.baselineRecall)}`,
      );
    }
    lines.push('');
  } else if (report.engine.available) {
    lines.push('## REGRESSION flags', '', '- none: no budget used fewer tokens than a baseline while resolving less.', '');
  }

  lines.push('## Summary by budget', '');
  lines.push(
    ...table(
      ['Budget', 'Maxify 1st call', 'Maxify + follow-ups', 'Native A', 'Native B', 'Recall 1st', 'Recall final', 'Recall A', 'Recall B', 'Forbidden M', 'Forbidden A', 'Forbidden B'],
      summaryRows(agg.budgets),
    ),
    '',
    'Tokens are means per task (estimated). Recall is the mean fraction of required evidence reached. Forbidden columns count tasks that hit at least one decoy.',
    '',
  );
  for (const entry of agg.budgets) lines.push(...budgetDetails(entry));

  lines.push('## Tasks where Maxify cost more than a baseline', '');
  if (agg.costMore.length === 0) {
    lines.push(report.engine.available ? '- none' : `- not evaluated (engine unavailable)`, '');
  } else {
    lines.push(
      ...table(
        ['Task', 'Budget', 'Maxify 1st', 'Maxify total', 'Native A', 'Native B', 'Worse than'],
        agg.costMore.map((item) => [item.taskId, String(item.budget), tok(item.maxifyFirst), tok(item.maxifyTotal), tok(item.simA), tok(item.simB), item.worseThan.join(', ')]),
      ),
      '',
    );
  }

  for (const budget of report.budgets) {
    lines.push(`## Per-task results, budget ${budget}`, '');
    lines.push(
      ...table(
        ['Task', 'Category', 'Maxify 1st', 'Maxify + f/u', 'Native A', 'Native B', 'Recall 1st', 'Recall final', 'Recall A', 'Recall B', 'Forbidden M/A/B', 'Calls M/A/B', 'Latency ms', 'Complete'],
        taskRows(report.tasks, budget),
      ),
      '',
      '<details><summary>Requirements still missing</summary>',
      '',
      ...missedLines(report.tasks, budget),
      '',
      '</details>',
      '',
    );
  }

  lines.push('## Checks and anomalies', '', ...checkLines(report.tasks), '');
  lines.push('## Keywords used by the native simulations', '');
  lines.push(...simReadLines('keywords', report.tasks.map((task) => ({ id: task.id, sim: task.simA }))), '');
  lines.push(...methodology(report));
  return `${lines.join('\n')}\n`;
}

/** Machine-readable report: the raw results plus the aggregates. */
export function renderJson(report: OfflineReport, agg: Aggregates): string {
  return `${JSON.stringify({ ...report, aggregates: agg }, null, 2)}\n`;
}
