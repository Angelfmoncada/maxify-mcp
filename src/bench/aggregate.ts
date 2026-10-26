/** Aggregation of offline results: per-budget means, "cost more" cases and regression flags. */
import type { MaxifyTaskRun, OfflineReport, SimRun, TaskResult } from './offline-types.js';

export type BaselineId = 'A' | 'B';
export type Scope = 'first-call' | 'with-follow-ups';

export function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
}

export function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

export interface SimSummary {
  meanTokens: number;
  sumTokens: number;
  meanRecall: number;
  fullTasks: number;
  tasksReadingForbidden: number;
  meanCalls: number;
}

export interface MaxifySummary {
  meanFirstTokens: number;
  sumFirstTokens: number;
  meanTotalTokens: number;
  sumTotalTokens: number;
  meanRecallFirst: number;
  meanRecallFinal: number;
  fullFirst: number;
  fullFinal: number;
  tasksWithForbiddenHits: number;
  /** Tasks where a decoy was shown at signature or source level. */
  tasksWithStrongForbiddenHits: number;
  tasksMentioningForbidden: number;
  overBudget: number;
  incomplete: number;
  errors: number;
  followUpCalls: number;
  meanCalls: number;
  latencyMedianMs: number;
  latencyMaxMs: number;
}

export interface Comparison {
  baseline: BaselineId;
  scope: Scope;
  maxifyTokens: number;
  baselineTokens: number;
  /** (maxify - baseline) / baseline; negative means Maxify used fewer tokens. */
  tokenChange: number;
  maxifyRecall: number;
  baselineRecall: number;
  /** Fewer tokens than the baseline but lower recall. */
  regression: boolean;
}

export interface BudgetSummary {
  budget: number;
  tasks: number;
  maxify: MaxifySummary | null;
  simA: SimSummary;
  simB: SimSummary;
  comparisons: Comparison[];
}

export interface CostMoreCase {
  taskId: string;
  budget: number;
  maxifyFirst: number;
  maxifyTotal: number;
  simA: number;
  simB: number;
  /** Which comparisons are worse for Maxify, e.g. "first-call vs A". */
  worseThan: string[];
}

export interface TaskRegression {
  taskId: string;
  budget: number;
  baseline: BaselineId;
  scope: Scope;
  maxifyTokens: number;
  baselineTokens: number;
  maxifyRecall: number;
  baselineRecall: number;
}

export interface Aggregates {
  budgets: BudgetSummary[];
  costMore: CostMoreCase[];
  taskRegressions: TaskRegression[];
  /** True when any budget shows fewer tokens with lower mean recall against a baseline. */
  hasAggregateRegression: boolean;
}

function summarizeSim(runs: readonly SimRun[]): SimSummary {
  return {
    meanTokens: mean(runs.map((run) => run.tokens)),
    sumTokens: sum(runs.map((run) => run.tokens)),
    meanRecall: mean(runs.map((run) => run.recall)),
    fullTasks: runs.filter((run) => run.recall >= 1).length,
    tasksReadingForbidden: runs.filter((run) => run.forbiddenRead.length > 0).length,
    meanCalls: mean(runs.map((run) => run.calls)),
  };
}

function summarizeMaxify(runs: readonly MaxifyTaskRun[]): MaxifySummary {
  const latencies = runs.map((run) => run.firstCall.latencyMs);
  return {
    meanFirstTokens: mean(runs.map((run) => run.firstCall.tokens)),
    sumFirstTokens: sum(runs.map((run) => run.firstCall.tokens)),
    meanTotalTokens: mean(runs.map((run) => run.totalTokens)),
    sumTotalTokens: sum(runs.map((run) => run.totalTokens)),
    meanRecallFirst: mean(runs.map((run) => run.recallFirst)),
    meanRecallFinal: mean(runs.map((run) => run.recallFinal)),
    fullFirst: runs.filter((run) => run.recallFirst >= 1).length,
    fullFinal: runs.filter((run) => run.recallFinal >= 1).length,
    tasksWithForbiddenHits: runs.filter((run) => run.forbiddenHits.length > 0).length,
    tasksWithStrongForbiddenHits: runs.filter((run) => run.forbiddenHitsStrong.length > 0).length,
    tasksMentioningForbidden: runs.filter((run) => run.forbiddenMentions.length > 0).length,
    overBudget: runs.filter((run) => run.firstCall.overBudget).length,
    incomplete: runs.filter((run) => !run.firstCall.complete).length,
    errors: runs.filter((run) => run.firstCall.error !== undefined).length,
    followUpCalls: sum(runs.map((run) => run.followUps.length)),
    meanCalls: mean(runs.map((run) => run.totalCalls)),
    latencyMedianMs: median(latencies),
    latencyMaxMs: latencies.length === 0 ? 0 : Math.max(...latencies),
  };
}

function compare(
  maxifyTokens: number,
  maxifyRecall: number,
  baseline: BaselineId,
  scope: Scope,
  sim: { tokens: number; recall: number },
): Comparison {
  return {
    baseline,
    scope,
    maxifyTokens,
    baselineTokens: sim.tokens,
    tokenChange: sim.tokens === 0 ? 0 : (maxifyTokens - sim.tokens) / sim.tokens,
    maxifyRecall,
    baselineRecall: sim.recall,
    regression: maxifyTokens < sim.tokens && maxifyRecall < sim.recall,
  };
}

function runFor(task: TaskResult, budget: number): MaxifyTaskRun | undefined {
  return task.maxify.find((run) => run.budget === budget);
}

function budgetSummary(tasks: readonly TaskResult[], budget: number): BudgetSummary {
  const runs = tasks.map((task) => runFor(task, budget)).filter((run): run is MaxifyTaskRun => run !== undefined);
  const simA = summarizeSim(tasks.map((task) => task.simA));
  const simB = summarizeSim(tasks.map((task) => task.simB));
  const maxify = runs.length === 0 ? null : summarizeMaxify(runs);
  const comparisons: Comparison[] = [];
  if (maxify !== null) {
    const baselines: Array<[BaselineId, SimSummary]> = [['A', simA], ['B', simB]];
    for (const [id, sim] of baselines) {
      const aggregate = { tokens: sim.meanTokens, recall: sim.meanRecall };
      comparisons.push(compare(maxify.meanFirstTokens, maxify.meanRecallFirst, id, 'first-call', aggregate));
      comparisons.push(compare(maxify.meanTotalTokens, maxify.meanRecallFinal, id, 'with-follow-ups', aggregate));
    }
  }
  return { budget, tasks: tasks.length, maxify, simA, simB, comparisons };
}

function perTaskFindings(tasks: readonly TaskResult[], budgets: readonly number[]): Pick<Aggregates, 'costMore' | 'taskRegressions'> {
  const costMore: CostMoreCase[] = [];
  const taskRegressions: TaskRegression[] = [];
  for (const task of tasks) {
    for (const budget of budgets) {
      const run = runFor(task, budget);
      if (run === undefined) continue;
      const sims: Array<[BaselineId, SimRun]> = [['A', task.simA], ['B', task.simB]];
      const worseThan: string[] = [];
      for (const [id, sim] of sims) {
        const scopes: Array<[Scope, number, number]> = [
          ['first-call', run.firstCall.tokens, run.recallFirst],
          ['with-follow-ups', run.totalTokens, run.recallFinal],
        ];
        for (const [scope, tokens, recall] of scopes) {
          if (tokens > sim.tokens) worseThan.push(`${scope} vs ${id}`);
          if (tokens < sim.tokens && recall < sim.recall) {
            taskRegressions.push({
              taskId: task.id,
              budget,
              baseline: id,
              scope,
              maxifyTokens: tokens,
              baselineTokens: sim.tokens,
              maxifyRecall: recall,
              baselineRecall: sim.recall,
            });
          }
        }
      }
      if (worseThan.length > 0) {
        costMore.push({
          taskId: task.id,
          budget,
          maxifyFirst: run.firstCall.tokens,
          maxifyTotal: run.totalTokens,
          simA: task.simA.tokens,
          simB: task.simB.tokens,
          worseThan,
        });
      }
    }
  }
  return { costMore, taskRegressions };
}

/** Computes every aggregate shown in the report from the raw per-task results. */
export function aggregate(report: Pick<OfflineReport, 'tasks' | 'budgets'>): Aggregates {
  const budgets = report.budgets.map((budget) => budgetSummary(report.tasks, budget));
  const findings = perTaskFindings(report.tasks, report.budgets);
  const hasAggregateRegression = budgets.some((summary) => summary.comparisons.some((entry) => entry.regression));
  return { budgets, ...findings, hasAggregateRegression };
}
