/** Scores the native simulations against a task's ground truth. Pure: no engine, no disk. */
import { applyEditToFiles } from './fixture.js';
import { simulateGrepReadFiles, simulateGrepReadRanges, type SimOutcome } from './native-sim.js';
import type { OfflineTaskSpec, SimRun } from './offline-types.js';
import { forbiddenHits, resolveRequirement, scoreRecall, type ResolvedRequirement } from './scoring.js';

export function scoreSim(
  outcome: SimOutcome,
  requirements: readonly ResolvedRequirement[],
  forbidden: readonly string[],
): SimRun {
  const recall = scoreRecall(requirements, outcome.evidence);
  return {
    strategy: outcome.strategy,
    keywords: outcome.keywords,
    calls: outcome.calls,
    tokens: outcome.tokens,
    perCall: outcome.perCall,
    reads: outcome.reads,
    recall: recall.recall,
    missed: recall.missed,
    forbiddenRead: forbiddenHits(
      forbidden,
      outcome.evidence.filter((item) => item.level === 'source'),
    ),
  };
}

export interface PreparedTask {
  /** Fixture text after the task's edit (identical to the base files when there is none). */
  files: ReadonlyMap<string, string>;
  requirements: ResolvedRequirement[];
  simA: SimRun;
  simB: SimRun;
}

/** Resolves a task's requirements and runs both native simulations on the (edited) fixture text. */
export function prepareTask(task: OfflineTaskSpec, baseFiles: ReadonlyMap<string, string>): PreparedTask {
  const files = task.edit === undefined ? baseFiles : applyEditToFiles(baseFiles, task.edit);
  const requirements = task.required.map((spec) => resolveRequirement(spec, files));
  return {
    files,
    requirements,
    simA: scoreSim(simulateGrepReadFiles(files, task.prompt), requirements, task.forbidden),
    simB: scoreSim(simulateGrepReadRanges(files, task.prompt), requirements, task.forbidden),
  };
}
