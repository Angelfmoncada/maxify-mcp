/**
 * Offline benchmark: Maxify against deterministic native-search simulations on the taskboard fixture.
 * Free to run, no network, no model. See bench/README.md for what the numbers mean and their limits.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { EngineOptions, MaxifyEngine } from '../engine/types.js';
import { MAX_BUDGET, MIN_BUDGET } from '../engine/types.js';
import { aggregate } from './aggregate.js';
import { prepareTask, type PreparedTask } from './baselines.js';
import { PER_CALL_OVERHEAD_TOKENS } from './cost.js';
import { runEngineSession, type OpenEngine } from './engine-session.js';
import { FIXTURE_NAME, copyFixture, fixtureDir, readFixtureFiles, repoRoot, tasksDir, totalLines } from './fixture.js';
import { MAX_KEYWORDS } from './keywords.js';
import { GREP_READ_FILE_COUNT, MAX_WINDOWS, WINDOW_RADIUS } from './native-sim.js';
import type { OfflineReport, OfflineTaskSpec, TaskResult } from './offline-types.js';
import { OFFLINE_NOTICE, renderJson, renderMarkdown } from './report.js';
import { loadSuite, validateTaskAgainstFixture } from './tasks.js';

export interface OfflineBenchOptions {
  /** Task suite id under bench/tasks (default: all offline suites). */
  suite?: string;
  /** Token budgets to evaluate for maxify_context. */
  budgets?: number[];
  /** Write the Markdown report here (and a .json next to it). */
  out?: string;
  json?: boolean;
}

export interface OfflineBenchResult {
  /** Human-readable report (Markdown). */
  text: string;
  exitCode: number;
}

/** Exit codes: 0 ok, 1 regression or defect found, 2 benchmark could not run, 3 engine unavailable (baselines only). */
export const EXIT_OK = 0;
export const EXIT_REGRESSION = 1;
export const EXIT_INVALID = 2;
export const EXIT_NO_ENGINE = 3;

export const DEFAULT_BUDGETS: readonly number[] = [2000, 4000, 8000];

/** Everything the runner needs from its environment; tests inject a fake engine and a temp fixture. */
export interface OfflineBenchDeps {
  openEngine: OpenEngine;
  fixtureRoot: string;
  tasksRoot: string;
  /** Keep the temporary working directory (debugging). */
  keepWorkDir?: boolean;
  now?: () => Date;
}

/** Validated, de-duplicated, ascending budgets. Throws on values the engine would refuse. */
export function normalizeBudgets(budgets: readonly number[] | undefined): number[] {
  const list = budgets === undefined || budgets.length === 0 ? DEFAULT_BUDGETS : budgets;
  for (const value of list) {
    if (!Number.isInteger(value) || value < MIN_BUDGET || value > MAX_BUDGET) {
      throw new Error(`Budget ${String(value)} must be an integer between ${MIN_BUDGET} and ${MAX_BUDGET}`);
    }
  }
  return [...new Set(list)].sort((a, b) => a - b);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function defaultOpenEngine(options: EngineOptions): Promise<MaxifyEngine> {
  // Loaded lazily so the pure parts of the benchmark stay usable while the engine is unavailable.
  const { openEngine } = await import('../engine/engine.js');
  return openEngine(options);
}

function defaultDeps(): OfflineBenchDeps {
  const root = repoRoot();
  return { openEngine: defaultOpenEngine, fixtureRoot: fixtureDir(root), tasksRoot: tasksDir(root) };
}

function writeOutputs(out: string, markdown: string, json: string): void {
  const markdownPath = path.resolve(out);
  const jsonPath = `${markdownPath.replace(/\.[^./\\]+$/, '')}.json`;
  mkdirSync(path.dirname(markdownPath), { recursive: true });
  writeFileSync(markdownPath, markdown);
  writeFileSync(jsonPath, json);
}

function exitCodeFor(report: OfflineReport, regression: boolean): number {
  if (!report.engine.available) return EXIT_NO_ENGINE;
  const defective = report.tasks.some((task) =>
    task.maxify.some((run) => run.firstCall.overBudget || run.firstCall.error !== undefined),
  );
  return regression || defective ? EXIT_REGRESSION : EXIT_OK;
}

/** Runs the offline benchmark with explicit dependencies (used by tests). */
export async function runOfflineBenchWith(deps: OfflineBenchDeps, opts: OfflineBenchOptions): Promise<OfflineBenchResult> {
  let budgets: number[];
  let tasks: OfflineTaskSpec[];
  try {
    budgets = normalizeBudgets(opts.budgets);
    tasks = loadSuite(deps.tasksRoot, opts.suite);
  } catch (error: unknown) {
    return { text: `Offline benchmark cannot start: ${errorMessage(error)}\n`, exitCode: EXIT_INVALID };
  }

  const baseFiles = readFixtureFiles(deps.fixtureRoot);
  const problems = tasks.flatMap((task) => validateTaskAgainstFixture(task, baseFiles));
  if (problems.length > 0) {
    const lines = ['Offline benchmark ground truth does not match the fixture:', ...problems.map((problem) => `- ${problem}`)];
    return { text: `${lines.join('\n')}\n`, exitCode: EXIT_INVALID };
  }

  const prepared = new Map<string, PreparedTask>(tasks.map((task) => [task.id, prepareTask(task, baseFiles)]));
  const workDir = mkdtempSync(path.join(os.tmpdir(), 'maxify-offline-'));
  try {
    const repo = path.join(workDir, 'repo');
    copyFixture(deps.fixtureRoot, repo);
    const session = await runEngineSession(deps.openEngine, repo, path.join(workDir, 'state'), tasks, prepared, budgets);

    const results: TaskResult[] = tasks.map((task) => {
      const entry = prepared.get(task.id) as PreparedTask;
      return {
        id: task.id,
        category: task.category,
        prompt: task.prompt,
        requirementCount: task.required.length,
        requirements: task.required.map((spec) => ({ ref: spec.ref, level: spec.level })),
        simA: entry.simA,
        simB: entry.simB,
        maxify: session.runs.get(task.id) ?? [],
      };
    });
    const report: OfflineReport = {
      generatedAt: (deps.now ?? (() => new Date()))().toISOString(),
      notice: OFFLINE_NOTICE,
      fixture: { name: FIXTURE_NAME, files: baseFiles.size, lines: totalLines(baseFiles) },
      budgets,
      engine: session.status,
      index: session.index,
      tasks: results,
      constants: {
        perCallOverheadTokens: PER_CALL_OVERHEAD_TOKENS,
        maxKeywords: MAX_KEYWORDS,
        readFileCount: GREP_READ_FILE_COUNT,
        windowRadius: WINDOW_RADIUS,
        maxWindows: MAX_WINDOWS,
      },
    };
    const agg = aggregate(report);
    const markdown = renderMarkdown(report, agg);
    const json = renderJson(report, agg);
    if (opts.out !== undefined) writeOutputs(opts.out, markdown, json);
    return { text: opts.json === true ? json : markdown, exitCode: exitCodeFor(report, agg.hasAggregateRegression) };
  } finally {
    if (deps.keepWorkDir !== true) rmSync(workDir, { recursive: true, force: true });
  }
}

/** Entry point used by `maxify bench`. */
export async function runOfflineBench(opts: OfflineBenchOptions): Promise<OfflineBenchResult> {
  return runOfflineBenchWith(defaultDeps(), opts);
}
