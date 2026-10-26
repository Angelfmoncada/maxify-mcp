/**
 * Runs one offline task against a Maxify engine: the first maxify_context call, then the
 * "diligent follow-up" simulation (one maxify_source call per still-missing requirement).
 */
import { performance } from 'node:perf_hooks';
import { estimateTokens } from '../core/tokens.js';
import { MIN_BUDGET } from '../engine/types.js';
import type { EvidenceItem, MaxifyEngine, ToolOutput } from '../engine/types.js';
import { callCost } from './cost.js';
import type { FollowUpRecord, MaxifyTaskRun, OfflineTaskSpec } from './offline-types.js';
import {
  forbiddenHits,
  forbiddenMentions,
  scoreRecall,
  type Evidence,
  type ResolvedRequirement,
} from './scoring.js';

export function toEvidence(items: readonly EvidenceItem[] | undefined): Evidence[] {
  const evidence: Evidence[] = [];
  for (const item of items ?? []) {
    if (!Number.isFinite(item.startLine) || !Number.isFinite(item.endLine) || item.startLine < 1) continue;
    evidence.push({
      path: item.path,
      startLine: item.startLine,
      endLine: Math.max(item.endLine, item.startLine),
      level: item.level,
      ...(item.symbol === undefined ? {} : { symbol: item.symbol }),
    });
  }
  return evidence;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface Timed {
  output: ToolOutput | null;
  latencyMs: number;
  error?: string;
}

async function timed(call: () => Promise<ToolOutput>): Promise<Timed> {
  const started = performance.now();
  try {
    const output = await call();
    return { output, latencyMs: performance.now() - started };
  } catch (error: unknown) {
    return { output: null, latencyMs: performance.now() - started, error: errorMessage(error) };
  }
}

function textChecks(task: OfflineTaskSpec, text: string): { forbiddenTextHits: string[]; requireTextOk?: boolean } {
  const forbiddenTextHits = (task.forbiddenText ?? []).filter((needle) => text.includes(needle));
  if (task.requireText === undefined) return { forbiddenTextHits };
  return {
    forbiddenTextHits,
    requireTextOk: task.requireText.some((pattern) => new RegExp(pattern, 'i').test(text)),
  };
}

/**
 * One follow-up call for a missing requirement. Source and signature gaps are filled with maxify_source
 * (the exact code of that symbol or range). A "map" gap only needs the location, so the cheapest honest call is
 * a focused maxify_context at map detail with the minimum budget; fetching a whole file would overcharge Maxify.
 */
async function followUp(engine: MaxifyEngine, requirement: ResolvedRequirement): Promise<{ record: FollowUpRecord; evidence: Evidence[] }> {
  const mapOnly = requirement.level === 'map';
  const request = { task: `Locate ${requirement.ref}`, budget: MIN_BUDGET, focus: [requirement.ref], detail: 'map' as const };
  const call = await timed(() => (mapOnly ? engine.context(request) : engine.source({ ref: requirement.ref })));
  const text = call.output?.text ?? '';
  const tool = mapOnly ? 'maxify_context' : 'maxify_source';
  const cost = callCost(tool, JSON.stringify(mapOnly ? request : { ref: requirement.ref }), text);
  const failed = call.output === null || call.output.isError === true;
  const error = call.error ?? (call.output?.isError === true ? text.slice(0, 200) : undefined);
  return {
    record: { ref: requirement.ref, tool, ok: !failed, tokens: cost.tokens, ...(error === undefined ? {} : { error }) },
    evidence: failed ? [] : toEvidence(call.output?.meta.items),
  };
}

export interface MaxifyTaskInput {
  task: OfflineTaskSpec;
  requirements: readonly ResolvedRequirement[];
  budget: number;
  /** Post-edit tasks: whether the re-index reported a changed file. */
  editDetected?: boolean;
}

/** Executes one task at one budget and scores it. Engine failures are recorded, never thrown. */
export async function runMaxifyTask(engine: MaxifyEngine, input: MaxifyTaskInput): Promise<MaxifyTaskRun> {
  const { task, requirements, budget } = input;
  const first = await timed(() => engine.context({ task: task.prompt, budget }));
  const text = first.output?.text ?? '';
  const firstFailed = first.output === null || first.output.isError === true;
  const firstEvidence = firstFailed ? [] : toEvidence(first.output?.meta.items);
  const firstCost = callCost('maxify_context', JSON.stringify({ task: task.prompt, budget }), text);
  const recallFirst = scoreRecall(requirements, firstEvidence);

  const followUps: FollowUpRecord[] = [];
  let finalEvidence = firstEvidence;
  for (const requirement of requirements.filter((req) => recallFirst.missed.includes(req.ref))) {
    const result = await followUp(engine, requirement);
    followUps.push(result.record);
    finalEvidence = [...finalEvidence, ...result.evidence];
  }
  const recallFinal = scoreRecall(requirements, finalEvidence);
  const followUpTokens = followUps.reduce((total, record) => total + record.tokens, 0);
  const hits = forbiddenHits(task.forbidden, firstEvidence);
  const strongHits = forbiddenHits(
    task.forbidden,
    firstEvidence.filter((item) => item.level !== 'map'),
  );
  const firstError = first.error ?? (first.output?.isError === true ? text.slice(0, 200) : undefined);

  return {
    budget,
    firstCall: {
      ...firstCost,
      engineEstTokens: first.output?.meta.estTokens ?? null,
      latencyMs: first.latencyMs,
      complete: first.output?.meta.complete ?? false,
      overBudget: estimateTokens(text) > budget,
      itemCount: first.output?.meta.items?.length ?? 0,
      omittedCount: first.output?.meta.omitted?.length ?? 0,
      ...(firstError === undefined ? {} : { error: firstError }),
    },
    recallFirst: recallFirst.recall,
    missedFirst: recallFirst.missed,
    followUps,
    followUpTokens,
    totalTokens: firstCost.tokens + followUpTokens,
    totalCalls: 1 + followUps.length,
    recallFinal: recallFinal.recall,
    missedFinal: recallFinal.missed,
    forbiddenHits: hits,
    forbiddenHitsStrong: strongHits,
    forbiddenMentions: forbiddenMentions(task.forbidden, text).filter((ref) => !hits.includes(ref)),
    ...textChecks(task, text),
    ...(input.editDetected === undefined ? {} : { editDetected: input.editDetected }),
  };
}
