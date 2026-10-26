/**
 * Drives one Maxify engine through the whole offline task list: cold index, an incremental
 * re-index after a one-file edit, then every task at every budget (edit tasks apply and undo
 * their edit around their queries).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { EngineOptions, IndexSummary, MaxifyEngine } from '../engine/types.js';
import type { PreparedTask } from './baselines.js';
import { runMaxifyTask } from './engine-run.js';
import { applyEditOnDisk, revertEdit, writeFileFresh } from './fixture.js';
import type { EngineStatus, IndexTimings, MaxifyTaskRun, OfflineTaskSpec } from './offline-types.js';

/** File touched to measure incremental indexing; the edit is undone afterwards. */
const TOUCH_FILE = 'src/shared/utils.ts';

export interface EngineSessionResult {
  status: EngineStatus;
  index: IndexTimings | null;
  /** Task id -> one run per budget, in budget order. */
  runs: Map<string, MaxifyTaskRun[]>;
}

export type OpenEngine = (options: EngineOptions) => Promise<MaxifyEngine>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function changedFiles(summary: IndexSummary): number {
  return summary.added + summary.updated + summary.renamed;
}

async function timedIndex(engine: MaxifyEngine): Promise<{ summary: IndexSummary; ms: number }> {
  const started = performance.now();
  const summary = await engine.index();
  return { summary, ms: performance.now() - started };
}

async function measureIndexing(engine: MaxifyEngine, repo: string): Promise<IndexTimings> {
  const cold = await timedIndex(engine);
  const file = path.join(repo, ...TOUCH_FILE.split('/'));
  const original = readFileSync(file, 'utf8');
  writeFileFresh(file, `${original}\n// bench: incremental touch\n`);
  const incremental = await timedIndex(engine);
  writeFileFresh(file, original);
  await engine.index();
  return {
    coldMs: cold.ms,
    coldFiles: cold.summary.filesScanned,
    coldErrors: cold.summary.errors.length,
    incrementalMs: incremental.ms,
    incrementalChanged: changedFiles(incremental.summary),
    incrementalUnchanged: incremental.summary.unchanged,
  };
}

async function runTask(
  engine: MaxifyEngine,
  repo: string,
  task: OfflineTaskSpec,
  prepared: PreparedTask,
  budgets: readonly number[],
): Promise<MaxifyTaskRun[]> {
  const applied = task.edit === undefined ? null : applyEditOnDisk(repo, task.edit);
  try {
    let editDetected: boolean | undefined;
    if (applied !== null) {
      const summary = await engine.index();
      editDetected = changedFiles(summary) > 0;
    }
    const runs: MaxifyTaskRun[] = [];
    for (const budget of budgets) {
      runs.push(
        await runMaxifyTask(engine, {
          task,
          requirements: prepared.requirements,
          budget,
          ...(editDetected === undefined ? {} : { editDetected }),
        }),
      );
    }
    return runs;
  } finally {
    if (applied !== null) {
      revertEdit(applied);
      await engine.index();
    }
  }
}

/** Runs the Maxify half of the benchmark. Never throws: an unusable engine yields an "unavailable" status. */
export async function runEngineSession(
  openEngine: OpenEngine,
  repo: string,
  stateDir: string,
  tasks: readonly OfflineTaskSpec[],
  prepared: ReadonlyMap<string, PreparedTask>,
  budgets: readonly number[],
): Promise<EngineSessionResult> {
  const runs = new Map<string, MaxifyTaskRun[]>();
  let engine: MaxifyEngine;
  try {
    engine = await openEngine({ root: repo, stateDir, autoIndex: false });
  } catch (error: unknown) {
    return { status: { available: false, reason: `openEngine failed: ${errorMessage(error)}` }, index: null, runs };
  }
  try {
    const index = await measureIndexing(engine, repo);
    // Plain tasks first so edit tasks (which re-index around their edit) never disturb them.
    const ordered = [...tasks].sort((a, b) => Number(a.edit !== undefined) - Number(b.edit !== undefined) || a.id.localeCompare(b.id));
    for (const task of ordered) {
      const preparedTask = prepared.get(task.id);
      if (preparedTask !== undefined) runs.set(task.id, await runTask(engine, repo, task, preparedTask, budgets));
    }
    return { status: { available: true }, index, runs };
  } catch (error: unknown) {
    return { status: { available: false, reason: `engine run failed: ${errorMessage(error)}` }, index: null, runs: new Map() };
  } finally {
    try {
      engine.close();
    } catch {
      // Closing is best effort; the temp directory is removed right after.
    }
  }
}
